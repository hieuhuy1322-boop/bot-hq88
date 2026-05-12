import TelegramBot from "node-telegram-bot-api";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./lib/logger";
import { db } from "./lib/db";
import { setBotInstance } from "./lib/bot-instance";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────
const ADMIN_IDS = new Set([
  7776471599,
  ...(process.env["ADMIN_IDS"] ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean)
    .map(Number),
]);

const BOT_NAME = "HQ88.FUN VUA TRÒ CHƠI";
const SUPPORT_ADMIN = "@luxvipb";

const QR_IMAGE_PATH = path.join(__dirname, "..", "assets", "qr_nap_tien.png");

const GAME_DURATION_MS = 50_000;
const WARN_40S_MS = 10_000;
const WARN_20S_MS = 30_000;
const MIN_BET = 2_000;
const MAX_BET = 5_000_000;

// ─── Database ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0,
    vip_level INTEGER NOT NULL DEFAULT 0,
    total_bet INTEGER NOT NULL DEFAULT 0,
    today_bet INTEGER NOT NULL DEFAULT 0,
    week_bet INTEGER NOT NULL DEFAULT 0,
    total_deposit INTEGER NOT NULL DEFAULT 0,
    total_withdraw INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0,
    lose_streak INTEGER NOT NULL DEFAULT 0,
    bank_name TEXT,
    bank_account TEXT,
    bank_owner TEXT,
    withdraw_fee_pct REAL NOT NULL DEFAULT 0.5,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_checkin TEXT,
    daily_gift_date TEXT,
    daily_gift_claimed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    note TEXT,
    ref_user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS giftcodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS giftcode_usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    giftcode_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    used_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(giftcode_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    reward INTEGER NOT NULL,
    streak INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS game_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    session_number INTEGER NOT NULL,
    dice1 INTEGER,
    dice2 INTEGER,
    dice3 INTEGER,
    total INTEGER,
    result_tai INTEGER,
    result_chan INTEGER,
    is_triple INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'betting',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
  );

  CREATE TABLE IF NOT EXISTS game_bets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    bet_type TEXT NOT NULL,
    amount INTEGER NOT NULL,
    is_win INTEGER,
    payout INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_game_enabled (
    chat_id INTEGER PRIMARY KEY,
    enabled_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS jackpot_pool (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    amount INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pending_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    group_chat_id INTEGER,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    handled_at TEXT
  );

  CREATE TABLE IF NOT EXISTS pending_withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    fee INTEGER NOT NULL DEFAULT 0,
    net INTEGER NOT NULL DEFAULT 0,
    bank_name TEXT,
    bank_account TEXT,
    bank_owner TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    handled_at TEXT
  );
`);

db.prepare("INSERT OR IGNORE INTO jackpot_pool (id, amount) VALUES (1, 0)").run();

try { db.exec("ALTER TABLE pending_deposits ADD COLUMN group_chat_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN referrer_id INTEGER"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN referral_today INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN referral_today_date TEXT"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN referral_total INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN first_deposit_done INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN wager_required INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN redeemed_points INTEGER NOT NULL DEFAULT 0"); } catch {}
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_cashbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    total_bet INTEGER NOT NULL,
    cashback INTEGER NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0,
    claimed_at TEXT,
    UNIQUE(user_id, date)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const WAGER_MULTIPLIER = 2;
function addWagerRequirement(userId: number, amount: number) {
  if (amount <= 0) return;
  db.prepare("UPDATE users SET wager_required = wager_required + ? WHERE id = ?")
    .run(amount * WAGER_MULTIPLIER, userId);
}
function consumeWagerRequirement(userId: number, betAmount: number) {
  if (betAmount <= 0) return;
  db.prepare("UPDATE users SET wager_required = MAX(0, wager_required - ?) WHERE id = ?")
    .run(betAmount, userId);
}
function getWagerRequired(userId: number): number {
  const row = db.prepare("SELECT wager_required FROM users WHERE id = ?").get(userId) as any;
  return row?.wager_required ?? 0;
}

function addReferralCommission(referrerUserId: number, amount: number, note: string) {
  if (!referrerUserId || amount <= 0) return;
  const ref = getUserById(referrerUserId);
  if (!ref) return;
  const today = new Date().toISOString().slice(0, 10);
  const todayCol = ref.referral_today_date === today ? (ref.referral_today ?? 0) : 0;
  const newToday = todayCol + amount;
  const newTotal = (ref.referral_total ?? 0) + amount;
  const newBal = ref.balance + amount;
  db.prepare(`UPDATE users SET balance=?, referral_today=?, referral_today_date=?, referral_total=? WHERE id=?`)
    .run(newBal, newToday, today, newTotal, referrerUserId);
  recordTransaction({ userId: referrerUserId, type: "referral", amount, fee: 0, balanceBefore: ref.balance, balanceAfter: newBal, note });
}

// ─── History Channel ──────────────────────────────────────────────────────
let historyChannelId: number | null = (() => {
  const row = db.prepare("SELECT value FROM bot_settings WHERE key='history_channel_id'").get() as any;
  return row ? parseInt(row.value) : null;
})();

// ─── Fake Bots (Auto-Bet) ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS fake_bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    telegram_id INTEGER UNIQUE NOT NULL,
    min_bet INTEGER NOT NULL DEFAULT 10000,
    max_bet INTEGER NOT NULL DEFAULT 100000,
    bet_types TEXT NOT NULL DEFAULT 'tai,xiu',
    delay_min INTEGER NOT NULL DEFAULT 5,
    delay_max INTEGER NOT NULL DEFAULT 35,
    balance_refill INTEGER NOT NULL DEFAULT 50000000,
    enabled INTEGER NOT NULL DEFAULT 1
  );
`);
try { db.exec("ALTER TABLE users ADD COLUMN is_fake_bot INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE fake_bots ADD COLUMN vip_icon TEXT DEFAULT ''"); } catch {}
try { db.exec("UPDATE fake_bots SET vip_icon='🏵️' WHERE vip_icon IS NULL OR vip_icon=''"); } catch {}

// Tạo 2 bot ảo mặc định nếu chưa có
(() => {
  const cnt = (db.prepare("SELECT COUNT(*) as c FROM fake_bots").get() as any).c;
  if (cnt > 0) return;
  const defaults = [
    { name: "Minh Tuấn 🎲", telegram_id: -1001, min_bet: 10000, max_bet: 80000, bet_types: "tai,xiu,chan,le" },
    { name: "Thu Hà 🌸",    telegram_id: -1002, min_bet: 5000,  max_bet: 50000, bet_types: "tai,xiu" },
  ];
  for (const b of defaults) {
    db.prepare("INSERT OR IGNORE INTO users (telegram_id, first_name, balance, is_fake_bot) VALUES (?, ?, 50000000, 1)").run(b.telegram_id, b.name);
    db.prepare("INSERT OR IGNORE INTO fake_bots (name, telegram_id, min_bet, max_bet, bet_types) VALUES (?, ?, ?, ?, ?)").run(b.name, b.telegram_id, b.min_bet, b.max_bet, b.bet_types);
  }
})();

// ─── Jackpot ──────────────────────────────────────────────────────────────
let jackpotAmount = (db.prepare("SELECT amount FROM jackpot_pool WHERE id=1").get() as any)?.amount ?? 0;

function addToJackpot(amount: number) {
  jackpotAmount += amount;
  db.prepare("UPDATE jackpot_pool SET amount = ? WHERE id = 1").run(jackpotAmount);
}

// ─── DB Helpers ────────────────────────────────────────────────────────────
const SIGNUP_BONUS = 2_000;
function getOrCreateUser(telegramId: number, firstName?: string, username?: string) {
  const res = db.prepare(`INSERT OR IGNORE INTO users (telegram_id, first_name, username, balance) VALUES (?, ?, ?, ?)`).run(telegramId, firstName ?? null, username ?? null, SIGNUP_BONUS);
  if ((res as any).changes > 0) {
    const u = db.prepare("SELECT id, balance FROM users WHERE telegram_id = ?").get(telegramId) as any;
    recordTransaction({ userId: u.id, type: "gift", amount: SIGNUP_BONUS, fee: 0, balanceBefore: 0, balanceAfter: SIGNUP_BONUS, note: "Tặng 2.000 khi đăng ký" });
  }
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) as any;
}

function getUserByTelegramId(telegramId: number) {
  return (db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId) ?? null) as any;
}

function getUserById(id: number) {
  return (db.prepare("SELECT * FROM users WHERE id = ?").get(id) ?? null) as any;
}

function findUserByAnyId(input: number) {
  return getUserById(input) ?? getUserByTelegramId(input) ?? null;
}

function recordTransaction({ userId, type, amount, fee, balanceBefore, balanceAfter, note, refUserId }: any) {
  db.prepare(`INSERT INTO transactions (user_id, type, amount, fee, balance_before, balance_after, note, ref_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, type, amount, fee ?? 0, balanceBefore, balanceAfter, note ?? null, refUserId ?? null);
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function formatNumber(n: number) { return Number(n).toLocaleString("vi-VN"); }

function vipLabel(level: number) {
  switch (level) {
    case 0: return "0 🥉 (Đồng)";
    case 1: return "1 🥈 (Bạc)";
    case 2: return "2 🥇 (Vàng)";
    case 3: return "3 🎖 (Bạch Kim)";
    case 4: return "4 💎 (Kim Cương)";
    case 5: return "5 🏵️ (Cao Thủ)";
    case 6: return "6 🏆 (Chiến Tướng)";
    case 7: return "7 🏅 (Đại Tướng)";
    case 8: return "8 👑 (Huyền Thoại)";
    case 9: return "9 🌟 (Tối Thượng)";
    default: return String(level);
  }
}

function vipEmoji(level: number) {
  switch (level) {
    case 0: return "🥉";
    case 1: return "🥈";
    case 2: return "🥇";
    case 3: return "🎖";
    case 4: return "💎";
    case 5: return "🏵️";
    case 6: return "🏆";
    case 7: return "🏅";
    case 8: return "👑";
    case 9: return "🌟";
    default: return "🥉";
  }
}

function isSameDay(dateStr1: string, dateStr2: string) {
  if (!dateStr1 || !dateStr2) return false;
  return dateStr1.slice(0, 10) === dateStr2.slice(0, 10);
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function checkinReward(streak: number) {
  if (streak <= 1) return 500;
  if (streak <= 3) return 1000;
  if (streak <= 7) return 2000;
  return 5000;
}

function updateVipLevel(user: any) {
  let newLevel = 0;
  if (user.total_deposit >= 20_000_000) newLevel = 3;
  else if (user.total_deposit >= 5_000_000) newLevel = 2;
  else if (user.total_deposit >= 1_000_000) newLevel = 1;
  if (newLevel !== user.vip_level) {
    db.prepare("UPDATE users SET vip_level = ? WHERE id = ?").run(newLevel, user.id);
  }
  return newLevel;
}

function isAdmin(telegramId: number) { return ADMIN_IDS.has(telegramId); }

function adminMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "👥 Danh sách user", callback_data: "adm_users_1" }, { text: "📊 Thống kê", callback_data: "adm_stats" }],
      [{ text: "🔒 Khóa user", callback_data: "adm_prompt_block" }, { text: "🔓 Mở khóa user", callback_data: "adm_prompt_unblock" }],
      [{ text: "💰 Nạp tiền user", callback_data: "adm_prompt_addbal" }, { text: "💸 Trừ tiền user", callback_data: "adm_prompt_subbal" }],
      [{ text: "🔍 Xem user", callback_data: "adm_prompt_userinfo" }, { text: "📋 Lịch sử user", callback_data: "adm_prompt_usertx" }],
      [{ text: "🎁 Tạo giftcode", callback_data: "adm_prompt_addgift" }, { text: "📜 Danh sách giftcode", callback_data: "adm_listgifts" }],
      [{ text: "❌ Xóa giftcode", callback_data: "adm_prompt_delgift" }, { text: "🎟️ Miễn cược", callback_data: "adm_prompt_clearwager" }],
      [{ text: "🎮 Lịch sử game", callback_data: "adm_gamesessions" }, { text: "📣 Thông báo all", callback_data: "adm_prompt_broadcast" }],
      [{ text: "📂 Lịch sử cược phiên", callback_data: "adm_session_bets" }, { text: "📋 DS cược phiên mới nhất", callback_data: "adm_bets_latest" }],
      [{ text: "🔄 Reset tài khoản user", callback_data: "adm_prompt_reset_user" }],
    ],
  };
}

// ─── Game Helpers ─────────────────────────────────────────────────────────────
function getNextSessionNumber() {
  const row = db.prepare("SELECT MAX(session_number) as max_num FROM game_sessions").get() as any;
  return (row?.max_num ?? 35000) + 1;
}

function getBetTotals(session: any) {
  const totals: any = { tai: 0, xiu: 0, chan: 0, le: 0, tc: 0, tl: 0, xc: 0, xl: 0, sb: 0 };
  for (const [, amt] of session.bets.tai) totals.tai += amt as number;
  for (const [, amt] of session.bets.xiu) totals.xiu += amt as number;
  for (const [, amt] of session.bets.chan) totals.chan += amt as number;
  for (const [, amt] of session.bets.le) totals.le += amt as number;
  for (const [, amt] of session.bets.tc) totals.tc += amt as number;
  for (const [, amt] of session.bets.tl) totals.tl += amt as number;
  for (const [, amt] of session.bets.xc) totals.xc += amt as number;
  for (const [, amt] of session.bets.xl) totals.xl += amt as number;
  for (const [, numMap] of session.sbBets) for (const [, amt] of numMap) totals.sb += amt as number;
  totals.d = 0; totals.d2 = 0;
  for (const [, {amount}] of session.dBets) totals.d += amount;
  for (const [, {amount}] of session.d2Bets) totals.d2 += amount;
  return totals;
}

function formatBetStatus(sessionNumber: number, secondsLeft: number, totals: any) {
  let msg =
    `*⏳ Còn ${secondsLeft} giây phiên #${sessionNumber}*\n` +
    `*🔵 TÀI: ${formatNumber(totals.tai)}*\n` +
    `*🔴 XỈU: ${formatNumber(totals.xiu)}*\n\n` +
    `*⚪️ CHẴN: ${formatNumber(totals.chan)}*\n` +
    `*⚫️ LẺ: ${formatNumber(totals.le)}*`;
  const hasCombo = totals.tc > 0 || totals.tl > 0 || totals.xc > 0 || totals.xl > 0;
  if (hasCombo) {
    msg += `\n\n**`;
    if (totals.tc > 0) msg += `\n*  TC: ${formatNumber(totals.tc)}*`;
    if (totals.tl > 0) msg += `\n*  TL: ${formatNumber(totals.tl)}*`;
    if (totals.xc > 0) msg += `\n*  XC: ${formatNumber(totals.xc)}*`;
    if (totals.xl > 0) msg += `\n*  XL: ${formatNumber(totals.xl)}*`;
  }
  if (totals.sb > 0) msg += `\n*SB: ${formatNumber(totals.sb)}*`;
  if (totals.d > 0)  msg += `\n*D: ${formatNumber(totals.d)}*`;
  if (totals.d2 > 0) msg += `\n*D2: ${formatNumber(totals.d2)}*`;
  return msg;
}

function getRecentSessionHistory(chatId: number) {
  const rows = db.prepare(`
    SELECT result_tai, result_chan, is_triple
    FROM game_sessions
    WHERE chat_id = ? AND status = 'done' AND dice1 IS NOT NULL
    ORDER BY id DESC LIMIT 10
  `).all(chatId) as any[];
  rows.reverse();
  const taiXiuRow = rows.map((s) => s.result_tai ? "🔵" : "🔴").join("");
  const chanLeRow = rows.map((s) => s.result_chan ? "⚪️" : "⚫️").join("");
  return { taiXiuRow, chanLeRow };
}

// ─── Game State ───────────────────────────────────────────────────────────────
const activeSessions = new Map<number, any>();
// lưu message ID, giá trị 3 viên xúc xắc và message ID tin kết quả
const lastDiceData = new Map<number, {
  msgIds: [number, number, number];
  vals: [number, number, number];
  resultMsgId: number;
  sessionNumber: number;
  totalWinPayout: number;
  totalLossBet: number;
  huContrib: number;
  historyHtml: string;
  resultKeyboard: any;
}>();
// đặt trước kết quả cho phiên tiếp theo: [d1, d2, d3] (undefined = ngẫu nhiên)
const pendingForceDice = new Map<number, [number|undefined, number|undefined, number|undefined]>();

// ─── Hi-Lo Dice Game (Trên/Dưới) ─────────────────────────────────────────────
const TD_TIMEOUT_MS = 30_000;
// Tỉ lệ thưởng động theo xác suất (2 xúc xắc, tổng 2-12)
// null = không thể xảy ra → ẩn nút
const TD_MULT: Record<number, { tren: number | null; duoi: number | null }> = {
   2: { tren: 1.05, duoi: null },
   3: { tren: 1.05, duoi: 30   },
   4: { tren: 1.15, duoi: 10   },
   5: { tren: 1.30, duoi: 5    },
   6: { tren: 1.60, duoi: 3    },
   7: { tren: 2.20, duoi: 2.20 },
   8: { tren: 3,    duoi: 1.60 },
   9: { tren: 5,    duoi: 1.30 },
  10: { tren: 10,   duoi: 1.15 },
  11: { tren: 30,   duoi: 1.05 },
  12: { tren: null, duoi: 1.05 },
};
function getTdMult(total: number, choice: "tren" | "duoi"): number | null {
  return TD_MULT[total]?.[choice] ?? null;
}
function fmtMult(m: number | null) {
  if (m === null) return "—";
  return m % 1 === 0 ? `x${m}` : `x${m.toFixed(2)}`;
}
const tdGames = new Map<number, {
  telegramId: number;
  userId: number;
  chatId: number;
  amount: number;
  firstTotal: number;
  d1: number; d2: number;
  msgId: number;
  timer: ReturnType<typeof setTimeout>;
}>();
const TD_DICE_EMOJI: Record<number, string> = { 1:"1️⃣", 2:"2️⃣", 3:"3️⃣", 4:"4️⃣", 5:"5️⃣", 6:"6️⃣" };

// ─── XX Dice Game State ────────────────────────────────────────────────────────
const XX_MIN_BET = 2_000;
const XX_MAX_BET = 500_000;
const XX_MULTIPLIER = 1.92;
const xxModes = new Map<number, "bot" | "player">();
const xxPending = new Map<number, {
  telegramId: number; userId: number; chatId: number;
  betType: string; amount: number; dice: number[]; msgId?: number;
}>();
function getXxMode(tid: number): "bot" | "player" { return xxModes.get(tid) ?? "bot"; }
function checkXxWin(betType: string, total: number): boolean {
  switch (betType) {
    case "xxc": return total % 2 === 0;
    case "xxl": return total % 2 !== 0;
    case "xxx": return total <= 10;
    case "xxt": return total >= 11;
    default: return false;
  }
}
const XX_LABEL: Record<string, string> = { xxc:"Chẵn (XXC)", xxl:"Lẻ (XXL)", xxx:"Xỉu (XXX)", xxt:"Tài (XXT)" };

// ─── Slot Machine State ────────────────────────────────────────────────────────
const SL_MIN_BET = 2_000;
const SL_MAX_BET = 500_000;
// Telegram 🎰: value = reel1 + (reel2-1)*4 + (reel3-1)*16  (symbols 1-4 per reel)
// "3 same" = 1(Bar), 22(Grape), 43(Lemon), 64(777=Jackpot)
function decodeSlot(v: number): { r1: number; r2: number; r3: number } {
  const n = v - 1;
  return { r1: (n % 4) + 1, r2: (Math.floor(n / 4) % 4) + 1, r3: Math.floor(n / 16) + 1 };
}
const SL_SYMBOLS: Record<number, string> = { 1:"🍫 Bar", 2:"🍇 Grape", 3:"🍋 Lemon", 4:"7️⃣ Seven" };

// ─── Basketball Game State ─────────────────────────────────────────────────────
const BR_MIN_BET = 2_000;
const BR_MAX_BET = 500_000;
const BR_MULTIPLIER = 2.0;
// Trong Telegram, 🏀 emoji dice: giá trị 5 = bóng vào rổ (WIN)

const rollingChats = new Set<number>();
const enabledGroups = new Set<number>(
  (db.prepare("SELECT chat_id FROM group_game_enabled").all() as any[]).map((r) => r.chat_id)
);

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function lockChat(chatId: number) {
  try {
    await (bot as any).setChatPermissions(chatId, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false,
    });
  } catch (e: any) { console.error("lockChat error:", e.message); }
}

async function unlockChat(chatId: number) {
  try {
    await (bot as any).setChatPermissions(chatId, {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: true,
      can_pin_messages: false,
    });
  } catch (e: any) { console.error("unlockChat error:", e.message); }
}

function hasBets(session: any) {
  return session.bets.tai.size > 0 || session.bets.xiu.size > 0 || session.bets.chan.size > 0 ||
    session.bets.le.size > 0 || session.bets.tc.size > 0 || session.bets.tl.size > 0 ||
    session.bets.xc.size > 0 || session.bets.xl.size > 0 || session.sbBets.size > 0 ||
    session.dBets.size > 0 || session.d2Bets.size > 0;
}

// ─── Bot instance (set in startBot) ──────────────────────────────────────────
let bot: TelegramBot;
let BOT_USERNAME = "";

// ─── Session Lifecycle ────────────────────────────────────────────────────────
// ─── Auto-Bet Scheduler ───────────────────────────────────────────────────────
function scheduleFakeBots(chatId: number, session: any) {
  const validTypes = new Set(["tai","xiu","chan","le","tc","tl","xc","xl"]);
  const bots = db.prepare("SELECT * FROM fake_bots WHERE enabled = 1").all() as any[];
  for (const fb of bots) {
    const user = db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(fb.telegram_id) as any;
    if (!user) continue;
    const types = (fb.bet_types as string).split(",").map((t: string) => t.trim()).filter((t: string) => validTypes.has(t));
    if (types.length === 0) continue;
    const delayMs = (fb.delay_min + Math.random() * (fb.delay_max - fb.delay_min)) * 1000;
    const t = setTimeout(async () => {
      const activeSession = activeSessions.get(chatId);
      if (!activeSession || activeSession.sessionId !== session.sessionId) return;
      const freshUser = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as any;
      if (!freshUser) return;
      const betType = types[Math.floor(Math.random() * types.length)];
      const rawAmt = fb.min_bet + Math.floor(Math.random() * (fb.max_bet - fb.min_bet + 1));
      const amount = Math.max(MIN_BET, Math.round(rawAmt / 1000) * 1000);
      let bal = freshUser.balance;
      if (bal < amount) {
        bal = fb.balance_refill;
        db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(bal, user.id);
      }
      const newBal = bal - amount;
      db.prepare("UPDATE users SET balance = ?, total_bet = total_bet + ?, today_bet = today_bet + ?, week_bet = week_bet + ? WHERE id = ?")
        .run(newBal, amount, amount, amount, user.id);
      const existing = (activeSession.bets[betType] as Map<number, number>).get(user.id) ?? 0;
      const totalThisType = existing + amount;
      (activeSession.bets[betType] as Map<number, number>).set(user.id, totalThisType);
      // Thông báo ra nhóm như người cược ẩn danh bình thường
      const vipIco = fb.vip_icon || '🏵️';
      try {
        await bot.sendMessage(chatId,
          `*${vipIco} Đặt thành công phiên #${activeSession.sessionNumber}*\n*${betTypeShort[betType]} - ${formatNumber(totalThisType)} {Ẩn Danh}*`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }, delayMs);
    session.timers.push(t);
  }
}

async function startSession(chatId: number, silent = false) {
  if (activeSessions.has(chatId)) return;
  if (!enabledGroups.has(chatId)) return;

  const sessionNumber = getNextSessionNumber();
  const sessionId = Number(
    (db.prepare("INSERT INTO game_sessions (chat_id, session_number) VALUES (?, ?)").run(chatId, sessionNumber) as any).lastInsertRowid
  );

  const session: any = {
    sessionId, sessionNumber, chatId, silent,
    bets: { tai: new Map(), xiu: new Map(), chan: new Map(), le: new Map(), tc: new Map(), tl: new Map(), xc: new Map(), xl: new Map() },
    sbBets: new Map(), // Map<userId, Map<chosenNum, totalAmount>>
    dBets:  new Map(), // Map<userId, {chosenNum, amount}> — 1 lần/phiên
    d2Bets: new Map(), // Map<userId, {pair:[a,b], amount}> — 1 lần/phiên
    timers: [],
  };

  activeSessions.set(chatId, session);

  if (!silent) {
    try {
      await bot.sendMessage(chatId,
        `*🎰 PHIÊN #${sessionNumber} — ĐẶT CƯỢC NGAY*\n` +
        `*Min: ${formatNumber(MIN_BET)} | Max: ${formatNumber(MAX_BET)}*\n\n` +
        `*T/X/C/L [tiền] — Tài/Xỉu/Chẵn/Lẻ*\n` +
        `*TC/TL/XC/XL [tiền] — Kép (x3.5)*\n` +
        `*SB[4-17] [tiền] — Đoán tổng (x5→x40)*\n` +
        `*D[1-6] [tiền] — Đoán 1 viên (x2/x3/x4)*\n` +
        `*D[n1][n2] [tiền] — Đoán 2 viên (x3)*`,
        { parse_mode: "Markdown" }
      );
    } catch (e: any) { console.error("startSession sendMessage error:", e.message); }
  }

  const t1 = setTimeout(async () => {
    const s = activeSessions.get(chatId);
    if (!s || s.sessionId !== sessionId) return;
    if (!hasBets(s)) return;
    try { await bot.sendMessage(chatId, formatBetStatus(sessionNumber, 40, getBetTotals(s)), { parse_mode: "Markdown" }); } catch (e: any) { console.error(e.message); }
  }, WARN_40S_MS);

  const t2 = setTimeout(async () => {
    const s = activeSessions.get(chatId);
    if (!s || s.sessionId !== sessionId) return;
    if (!hasBets(s)) return;
    try { await bot.sendMessage(chatId, formatBetStatus(sessionNumber, 20, getBetTotals(s)), { parse_mode: "Markdown" }); } catch (e: any) { console.error(e.message); }
  }, WARN_20S_MS);

  const t3 = setTimeout(() => endSession(chatId, sessionId), GAME_DURATION_MS);
  session.timers = [t1, t2, t3];
  scheduleFakeBots(chatId, session);
}

async function endSession(chatId: number, sessionId: number, forceDice?: [number|undefined, number|undefined, number|undefined]) {
  const session = activeSessions.get(chatId);
  if (!session || session.sessionId !== sessionId) return;

  // dùng preset nếu có (và chưa truyền forceDice trực tiếp)
  if (!forceDice && pendingForceDice.has(chatId)) {
    forceDice = pendingForceDice.get(chatId)!;
    pendingForceDice.delete(chatId);
  }

  activeSessions.delete(chatId);
  session.timers.forEach(clearTimeout);

  if (!hasBets(session)) {
    db.prepare(`UPDATE game_sessions SET status='done', ended_at=datetime('now') WHERE id=?`).run(sessionId);
    setTimeout(() => startSession(chatId, true), 2_000);
    return;
  }

  rollingChats.add(chatId);
  await lockChat(chatId);

  try {
    const totals = getBetTotals(session);
    let endMsg =
      `*Hết* thời gian đặt cược phiên #${session.sessionNumber}\n` +
      `🔵 TÀI: ${formatNumber(totals.tai)}\n` +
      `🔴 XỈU: ${formatNumber(totals.xiu)}\n\n` +
      `⚪️ CHẴN: ${formatNumber(totals.chan)}\n` +
      `⚫️ LẺ: ${formatNumber(totals.le)}`;
    const comboLines: string[] = [];
    if (totals.tc > 0) comboLines.push(`TC: ${formatNumber(totals.tc)}`);
    if (totals.tl > 0) comboLines.push(`TL: ${formatNumber(totals.tl)}`);
    if (totals.xc > 0) comboLines.push(`XC: ${formatNumber(totals.xc)}`);
    if (totals.xl > 0) comboLines.push(`XL: ${formatNumber(totals.xl)}`);
    if (comboLines.length > 0) endMsg += `\n\n` + comboLines.join("\n");
    if (totals.sb > 0) endMsg += `\nSB: ${formatNumber(totals.sb)}`;
    if (totals.d > 0)  endMsg += `\nD: ${formatNumber(totals.d)}`;
    if (totals.d2 > 0) endMsg += `\nD2: ${formatNumber(totals.d2)}`;
    await bot.sendMessage(chatId, endMsg, { parse_mode: "Markdown" });
  } catch (e: any) { console.error(e.message); }

  await sleep(1_500);
  try { await bot.sendMessage(chatId, `*💥 Bắt đầu tung XÚC XẮC phiên #${session.sessionNumber}*`, { parse_mode: "Markdown" }); } catch (e: any) { console.error(e.message); }
  await sleep(1_000);

  // Nếu target được preset → KHÔNG tung xúc xắc, trả giá trị thẳng (msgId = 0)
  // Nếu target undefined → tung xúc xắc animation bình thường
  const sendDiceTarget = async (target?: number): Promise<{ value: number; msgId: number }> => {
    if (target !== undefined) {
      return { value: target, msgId: 0 };
    }
    const m = await bot.sendDice(chatId, { emoji: "🎲" });
    return { value: (m as any).dice?.value ?? Math.ceil(Math.random() * 6), msgId: (m as any).message_id };
  };

  let d1 = 1, d2 = 1, d3 = 1;
  let msgId1 = 0, msgId2 = 0, msgId3 = 0;
  try {
    ({ value: d1, msgId: msgId1 } = await sendDiceTarget(forceDice?.[0]));
    if (forceDice?.[0] === undefined) await sleep(1_000);
    ({ value: d2, msgId: msgId2 } = await sendDiceTarget(forceDice?.[1]));
    if (forceDice?.[1] === undefined) await sleep(1_000);
    ({ value: d3, msgId: msgId3 } = await sendDiceTarget(forceDice?.[2]));
  } catch (e: any) { console.error(e.message); }

  // Nếu admin đang ép kết quả → sinh bộ 3 xúc xắc HỢP LỆ khớp điều kiện
  // (animation Telegram vẫn chạy bình thường, chỉ thay số hiển thị kết quả)
  if (!forceDice) {
    const _fTx = (db.prepare("SELECT value FROM bot_settings WHERE key='force_taixiu'").get() as any)?.value;
    if (_fTx && _fTx !== 'random') {
      const genDice = (): [number, number, number] => {
        for (let i = 0; i < 2000; i++) {
          const a = Math.ceil(Math.random() * 6);
          const b = Math.ceil(Math.random() * 6);
          const c = Math.ceil(Math.random() * 6);
          const s = a + b + c;
          if (a === b && b === c) continue; // tránh triple → nổ hũ ngoài ý muốn
          if (_fTx === 'tai' && s >= 11) return [a, b, c];
          if (_fTx === 'xiu' && s <= 10 && s >= 3) return [a, b, c];
          if (_fTx === 'chan' && s % 2 === 0) return [a, b, c];
          if (_fTx === 'le'  && s % 2 !== 0) return [a, b, c];
        }
        return [d1, d2, d3]; // fallback
      };
      [d1, d2, d3] = genDice();
    }
  }

  lastDiceData.set(chatId, { msgIds: [msgId1, msgId2, msgId3], vals: [d1, d2, d3] });

  await sleep(3_000);

  const total = d1 + d2 + d3;
  const isTriple = d1 === d2 && d2 === d3;
  const isTai = total >= 11;
  const isChan = total % 2 === 0;

  db.prepare(`UPDATE game_sessions SET dice1=?, dice2=?, dice3=?, total=?, result_tai=?, result_chan=?, is_triple=?, status='done', ended_at=datetime('now') WHERE id=?`)
    .run(d1, d2, d3, total, isTai ? 1 : 0, isChan ? 1 : 0, isTriple ? 1 : 0, sessionId);

  let totalWinPayout = 0;
  let totalLossBet = 0;
  const winnerMessages: any[] = [];
  const loserMessages: any[] = [];

  function processBetMap(betsMap: Map<number, number>, betType: string, isWin: boolean, multiplier = 1.94) {
    for (const [userId, amount] of betsMap) {
      const user = getUserById(userId);
      if (!user) continue;
      const displayName = user.first_name ?? (user.username ? "@" + user.username : `ID ${user.telegram_id}`);
      if (isWin) {
        const payout = Math.floor(amount * multiplier);
        totalWinPayout += payout;
        const newBal = user.balance + payout;
        if (amount >= 10000) {
          db.prepare("UPDATE users SET balance = ?, win_streak = win_streak + 1, lose_streak = 0 WHERE id = ?").run(newBal, user.id);
        } else {
          db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, user.id);
        }
        recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Thắng ${betType.toUpperCase()} phiên #${session.sessionNumber}` });
        winnerMessages.push({ telegramId: user.telegram_id, displayName, betType, amount, payout, newBal });
      } else {
        totalLossBet += amount;
        if (amount >= 10000) {
          db.prepare("UPDATE users SET lose_streak = lose_streak + 1, win_streak = 0 WHERE id = ?").run(user.id);
        }
        loserMessages.push({ telegramId: user.telegram_id, displayName, betType, amount, currentBal: user.balance });
        if (user.referrer_id) {
          const commission = Math.floor(amount * 0.02);
          if (commission > 0) addReferralCommission(user.referrer_id, commission, `Hoa hồng 2% từ ${user.telegram_id}`);
        }
      }
      db.prepare(`INSERT INTO game_bets (session_id, user_id, bet_type, amount, is_win, payout) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(sessionId, user.id, betType, amount, isWin ? 1 : 0, isWin ? Math.floor(amount * multiplier) : 0);
    }
  }

  processBetMap(session.bets.tai, "tai", isTai);
  processBetMap(session.bets.xiu, "xiu", !isTai);
  processBetMap(session.bets.chan, "chan", isChan);
  processBetMap(session.bets.le, "le", !isChan);
  processBetMap(session.bets.tc, "tc", isTai && isChan, 3.5);
  processBetMap(session.bets.tl, "tl", isTai && !isChan, 3.5);
  processBetMap(session.bets.xc, "xc", !isTai && isChan, 3.5);
  processBetMap(session.bets.xl, "xl", !isTai && !isChan, 3.5);

  // ── Xử lý cược Đoán tổng (SB) ──
  for (const [userId, numMap] of session.sbBets) {
    for (const [chosenNum, amount] of numMap) {
      const multiplier = SB_MULTIPLIERS[chosenNum];
      if (!multiplier) continue;
      const isWin = total === chosenNum;
      const user = getUserById(userId);
      if (!user) continue;
      const displayName = user.first_name ?? (user.username ? "@" + user.username : `ID ${user.telegram_id}`);
      if (isWin) {
        const payout = Math.floor(amount * multiplier);
        totalWinPayout += payout;
        const newBal = user.balance + payout;
        if (amount >= 10000) {
          db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(newBal, user.id);
        } else {
          db.prepare("UPDATE users SET balance=? WHERE id=?").run(newBal, user.id);
        }
        recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Thắng SB${chosenNum} x${multiplier} phiên #${session.sessionNumber}` });
        winnerMessages.push({ telegramId: user.telegram_id, displayName, betType: `SB${chosenNum}`, amount, payout, newBal });
      } else {
        totalLossBet += amount;
        if (amount >= 10000) {
          db.prepare("UPDATE users SET lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(user.id);
        }
        loserMessages.push({ telegramId: user.telegram_id, displayName, betType: `SB${chosenNum}`, amount, currentBal: user.balance });
        if (user.referrer_id) {
          const commission = Math.floor(amount * 0.02);
          if (commission > 0) addReferralCommission(user.referrer_id, commission, `Hoa hồng 2% từ ${user.telegram_id}`);
        }
      }
      db.prepare(`INSERT INTO game_bets (session_id, user_id, bet_type, amount, is_win, payout) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(sessionId, user.id, `sb${chosenNum}`, amount, isWin ? 1 : 0, isWin ? Math.floor(amount * multiplier) : 0);
    }
  }

  // ── Xử lý cược Đoán 1 xúc xắc (D) ──
  for (const [userId, {chosenNum, amount}] of session.dBets) {
    const matchCount = [d1, d2, d3].filter((v: number) => v === chosenNum).length;
    const isWin = matchCount > 0;
    const mult = matchCount + 1;
    const user = getUserById(userId);
    if (!user) continue;
    if (isWin) {
      const payout = Math.floor(amount * mult);
      totalWinPayout += payout;
      const newBal = user.balance + payout;
      if (amount >= 10000) db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(newBal, user.id);
      else db.prepare("UPDATE users SET balance=? WHERE id=?").run(newBal, user.id);
      recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Thắng D${chosenNum} x${mult} phiên #${session.sessionNumber}` });
      winnerMessages.push({ telegramId: user.telegram_id, displayName: user.first_name ?? `ID ${user.telegram_id}`, betType: `D${chosenNum}(x${mult})`, amount, payout, newBal });
    } else {
      totalLossBet += amount;
      if (amount >= 10000) db.prepare("UPDATE users SET lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(user.id);
      loserMessages.push({ telegramId: user.telegram_id, displayName: user.first_name ?? `ID ${user.telegram_id}`, betType: `D${chosenNum}`, amount, currentBal: user.balance });
      if (user.referrer_id) { const c = Math.floor(amount * 0.02); if (c > 0) addReferralCommission(user.referrer_id, c, `Hoa hồng 2% từ ${user.telegram_id}`); }
    }
    db.prepare(`INSERT INTO game_bets (session_id, user_id, bet_type, amount, is_win, payout) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, user.id, `d${chosenNum}`, amount, isWin ? 1 : 0, isWin ? Math.floor(amount * mult) : 0);
  }

  // ── Xử lý cược Đoán 2 xúc xắc (D2) ──
  for (const [userId, {pair, amount}] of session.d2Bets) {
    const [a, b] = pair as [number, number];
    const cnt = [0, 0, 0, 0, 0, 0, 0];
    [d1, d2, d3].forEach((v: number) => cnt[v]++);
    const isWin = a === b ? cnt[a] >= 2 : cnt[a] >= 1 && cnt[b] >= 1;
    const mult = 3;
    const user = getUserById(userId);
    if (!user) continue;
    if (isWin) {
      const payout = Math.floor(amount * mult);
      totalWinPayout += payout;
      const newBal = user.balance + payout;
      if (amount >= 10000) db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(newBal, user.id);
      else db.prepare("UPDATE users SET balance=? WHERE id=?").run(newBal, user.id);
      recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Thắng D${a}${b} x3 phiên #${session.sessionNumber}` });
      winnerMessages.push({ telegramId: user.telegram_id, displayName: user.first_name ?? `ID ${user.telegram_id}`, betType: `D${a}${b}(x3)`, amount, payout, newBal });
    } else {
      totalLossBet += amount;
      if (amount >= 10000) db.prepare("UPDATE users SET lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(user.id);
      loserMessages.push({ telegramId: user.telegram_id, displayName: user.first_name ?? `ID ${user.telegram_id}`, betType: `D${a}${b}`, amount, currentBal: user.balance });
      if (user.referrer_id) { const c = Math.floor(amount * 0.02); if (c > 0) addReferralCommission(user.referrer_id, c, `Hoa hồng 2% từ ${user.telegram_id}`); }
    }
    db.prepare(`INSERT INTO game_bets (session_id, user_id, bet_type, amount, is_win, payout) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, user.id, `d${a}${b}`, amount, isWin ? 1 : 0, isWin ? Math.floor(amount * mult) : 0);
  }

  const huContrib = Math.floor(totalLossBet * 0.001);
  addToJackpot(huContrib);

  let jackpotAnnouncement = "";
  const jackpotWinnerDMs: Array<{ telegramId: number; share: number; newBal: number }> = [];
  if (isTriple && (d1 === 6 || d1 === 1)) {
    const isGold = d1 === 6;
    const sideBets = isGold ? session.bets.tai : session.bets.xiu;
    // Chỉ tính nổ hũ cho người cược từ 10k trở lên
    const eligibleSideBets = new Map<number, number>();
    for (const [uid, amt] of sideBets) { if (amt >= 10000) eligibleSideBets.set(uid, amt); }
    const hasSideBets = eligibleSideBets.size > 0;

    if (hasSideBets) {
      const jackpotBefore = jackpotAmount;
      const playerPool = Math.floor(jackpotBefore * 0.5);

      const winnerMap = new Map<number, number>();
      for (const [uid, amt] of eligibleSideBets) winnerMap.set(uid, (winnerMap.get(uid) ?? 0) + amt);

      const totalBetSum = Array.from(winnerMap.values()).reduce((a, b) => a + b, 0);
      const winnersList: Array<{ telegramId: number; betSum: number; share: number; newBal: number }> = [];
      if (totalBetSum > 0) {
        for (const [uid, betSum] of winnerMap) {
          const share = Math.floor(playerPool * betSum / totalBetSum);
          const u = getUserById(uid);
          if (!u) continue;
          const newBal = u.balance + share;
          db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, uid);
          recordTransaction({ userId: uid, type: "win", amount: share, fee: 0, balanceBefore: u.balance, balanceAfter: newBal, note: `Nổ hũ phiên #${session.sessionNumber}` });
          winnersList.push({ telegramId: u.telegram_id, betSum, share, newBal });
          jackpotWinnerDMs.push({ telegramId: u.telegram_id, share, newBal });
        }
      }

      jackpotAmount -= playerPool;
      db.prepare("UPDATE jackpot_pool SET amount = ? WHERE id = 1").run(jackpotAmount);

      const head = isGold
        ? `🥇 Nổ hũ Vàng 6️⃣ 6️⃣ 6️⃣ 🔥`
        : `🥇 Nổ hũ Vàng 1️⃣ 1️⃣ 1️⃣ 🔥`;
      const winnerLines = winnersList
        .sort((a, b) => b.share - a.share)
        .map((w, i) => {
          const tg = String(w.telegramId);
          const masked = `****${tg.slice(-5)}`;
          return `${i + 1}. ${masked} | ${formatNumber(w.betSum)} | ${formatNumber(w.share)}`;
        })
        .join("\n");
      jackpotAnnouncement =
        `${head}\n` +
        `${winnerLines || "Không có người chia hũ"}\n` +
        `Số tiền trong hũ còn lại: ${formatNumber(jackpotAmount)}\n` +
        `tiền chia hũ sẽ là 50%`;
    }
  }

  const { taiXiuRow, chanLeRow } = getRecentSessionHistory(chatId);

  let resultLabel: string;
  let resultColorEmojis: string;
  resultLabel = `${isTai ? "TÀI" : "XỈU"} ${isChan ? "CHẴN" : "LẺ"}`;
  resultColorEmojis = `${isTai ? "🔵" : "🔴"} ${isChan ? "⚪️" : "⚫️"}`;

  const resultMsg =
    `<b>Kết quả phiên #${session.sessionNumber}</b>\n` +
    `┏━━━━━━━━━━━━┓\n` +
    `┃  <b>${d1}  ${d2}  ${d3}</b>  👉 <b>${resultLabel} ${resultColorEmojis}</b>\n┃\n` +
    `┃ Tổng thắng: <b>${formatNumber(totalWinPayout)}</b>\n` +
    `┃ Tổng thua: <b>${formatNumber(totalLossBet)}</b>\n` +
    `┃ Cộng hũ  : <b>+${formatNumber(huContrib)}</b>\n` +
    `┃ Hũ hiện tại: <b>${formatNumber(jackpotAmount)}</b>\n` +
    `┗━━━━━━━━━━━━┛`;

  const historyHtml = taiXiuRow
    ? `\n<blockquote><b>Thống kê kết quả gần đây:</b>\n\n${taiXiuRow}\n${chanLeRow}</blockquote>`
    : "";

  const resultKeyboard = {
    inline_keyboard: [
      ...(BOT_USERNAME ? [[{ text: "🤖 BOT CHÍNH", url: `https://t.me/${BOT_USERNAME}?start=menu` }]] : []),
      [{ text: "📋 NHÓM LỊCH SỬ PHIÊN", url: "https://t.me/lichsuhq88" }],
    ],
  };
  let resultMsgId = 0;
  try {
    const sent = await bot.sendMessage(chatId, resultMsg + historyHtml, {
      parse_mode: "HTML",
      ...(resultKeyboard ? { reply_markup: resultKeyboard } : {}),
    });
    resultMsgId = (sent as any).message_id ?? 0;
  } catch (e: any) { console.error(e.message); }

  // ── Đăng kết quả ngắn lên group lịch sử ──
  if (historyChannelId) {
    const histLabel = `${isTai ? "TÀI" : "XỈU"} ${isChan ? "CHẴN" : "LẺ"}`;
    const histEmoji = `${isTai ? "🔵" : "🔴"} ${isChan ? "⚪️" : "⚫️"}`;
    const histMsg = `*🎲 Kết quả phiên #${session.sessionNumber} 🎲*\n*${d1}  ${d2}  ${d3}  👉  ${histLabel} ${histEmoji}*`;
    try { await bot.sendMessage(historyChannelId, histMsg, { parse_mode: "Markdown" }); } catch {}
  }
  lastDiceData.set(chatId, {
    msgIds: [msgId1, msgId2, msgId3],
    vals: [d1, d2, d3],
    resultMsgId,
    sessionNumber: session.sessionNumber,
    totalWinPayout,
    totalLossBet,
    huContrib,
    historyHtml,
    resultKeyboard,
  });

  if (jackpotAnnouncement) {
    try { await bot.sendMessage(chatId, jackpotAnnouncement); } catch (e: any) { console.error(e.message); }
  }

  const betTypeName: any = { tai: "Tài", xiu: "Xỉu", chan: "Chẵn", le: "Lẻ", tc: "Tài Chẵn", tl: "Tài Lẻ", xc: "Xỉu Chẵn", xl: "Xỉu Lẻ" };

  // Map jackpot shares by telegramId để gộp tin nhắn
  const jackpotShareMap = new Map<number, { share: number; finalBal: number }>();
  for (const w of jackpotWinnerDMs) {
    jackpotShareMap.set(w.telegramId, { share: w.share, finalBal: w.newBal });
  }

  for (const { telegramId, betType, amount, payout, newBal, displayName } of winnerMessages) {
    if (telegramId < 0) continue; // skip fake bots
    const jp = jackpotShareMap.get(telegramId);
    if (jp) {
      // Người vừa thắng cược vừa được nổ hũ → gộp 1 tin
      try { await bot.sendMessage(telegramId,
        `🎉 *NỔ HŨ + THẮNG CƯỢC* phiên #${session.sessionNumber}\n\n` +
        `✅ Thắng cược (${betTypeName[betType] ?? betType}): *+${formatNumber(payout)}*\n` +
        `🏆 Thưởng nổ hũ: *+${formatNumber(jp.share)}*\n` +
        `💎 Tổng nhận: *+${formatNumber(payout + jp.share)}*\n\n` +
        `💰 Số dư hiện tại: *${formatNumber(jp.finalBal)}*`,
        { parse_mode: "Markdown" }
      ); } catch {}
      jackpotShareMap.delete(telegramId); // đã gửi rồi, không gửi lại
    } else {
      try { await bot.sendMessage(telegramId,
        `✅ Thắng phiên #${session.sessionNumber}\nCược ${betTypeName[betType] ?? betType} - ${formatNumber(amount)}\nTiền nhận: +${formatNumber(payout)}\nSố dư mới: ${formatNumber(newBal)}`
      ); } catch {}
    }
  }
  for (const [userId, numMap] of session.sbBets) {
    const user = getUserById(userId);
    if (!user || user.telegram_id < 0) continue;
    for (const [chosenNum, amount] of numMap) {
      if (chosenNum === total) {
        const mult = SB_MULTIPLIERS[chosenNum];
        const payout = Math.floor(amount * mult);
        try {
          await bot.sendMessage(user.telegram_id,
            `✅ Thắng phiên #${session.sessionNumber}\nCược SB${chosenNum} - ${formatNumber(amount)}\nTiền nhận: +${formatNumber(payout)}\nSố dư mới: ${formatNumber(user.balance)}`,
            { reply_to_message_id: msg.message_id },
          );
        } catch {}
      } else {
        try {
          await bot.sendMessage(user.telegram_id,
            `❌ Thua phiên #${session.sessionNumber}\nCược SB${chosenNum} - ${formatNumber(amount)}\nSố dư: ${formatNumber(user.balance)}`,
            { reply_to_message_id: msg.message_id },
          );
        } catch {}
      }
    }
  }
  for (const [userId, { chosenNum, amount }] of session.dBets) {
    const user = getUserById(userId);
    if (!user || user.telegram_id < 0) continue;
    const matchCount = [d1, d2, d3].filter((v: number) => v === chosenNum).length;
    const isWin = matchCount > 0;
    const mult = matchCount + 1;
    try {
      await bot.sendMessage(user.telegram_id,
        isWin
          ? `✅ Thắng phiên #${session.sessionNumber}\nCược D${chosenNum} (x${mult}) - ${formatNumber(amount)}\nTiền nhận: +${formatNumber(Math.floor(amount * mult))}\nSố dư mới: ${formatNumber(user.balance)}`
          : `❌ Thua phiên #${session.sessionNumber}\nCược D${chosenNum} - ${formatNumber(amount)}\nSố dư: ${formatNumber(user.balance)}`,
        { reply_to_message_id: msg.message_id },
      );
    } catch {}
  }
  // Người chỉ được nổ hũ mà không thắng cược thường (trường hợp lẻ)
  for (const [tid, jp] of jackpotShareMap) {
    try { await bot.sendMessage(tid, `🎉 NỔ HŨ! Bạn nhận thêm +${formatNumber(jp.share)} từ hũ.\n💰 Số dư: ${formatNumber(jp.finalBal)}`); } catch {}
  }
  for (const { telegramId, betType, amount, currentBal } of loserMessages) {
    if (telegramId < 0) continue; // skip fake bots
    try { await bot.sendMessage(telegramId, `❌ Bạn THUA −${formatNumber(amount)} (${betTypeName[betType] ?? betType}) phiên #${session.sessionNumber}\n💰 Số dư: ${formatNumber(currentBal)}`); } catch {}
  }

  await unlockChat(chatId);
  setTimeout(() => { rollingChats.delete(chatId); startSession(chatId, false); }, 2_000);
}

// ─── Hi-Lo Handler ────────────────────────────────────────────────────────────
async function handleTdGame(msg: TelegramBot.Message): Promise<boolean> {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const text = (msg.text ?? "").trim();
  const tdMatch = text.match(/^TD\s+(max|\d[\d.,]*)/i);
  if (!tdMatch) return false;

  const user = getUserByTelegramId(telegramId);
  if (!user) {
    try { await bot.sendMessage(chatId, "❗ Bạn chưa đăng ký. Nhắn /start để tạo tài khoản."); } catch {}
    return true;
  }
  if (user.is_blocked) return true;
  if (tdGames.has(user.id)) {
    try { await bot.sendMessage(chatId, "⚠️ Bạn đang có một ván Trên/Dưới chưa xong! Hãy chọn rồi chơi tiếp.", { reply_to_message_id: msg.message_id }); } catch {}
    return true;
  }

  let amount: number;
  const rawAmt = tdMatch[1].toLowerCase();
  const TD_MAX_BET = 500_000;
  if (rawAmt === "max") {
    amount = Math.min(user.balance, TD_MAX_BET);
    if (amount < MIN_BET) {
      try { await bot.sendMessage(chatId, `❌ Số dư không đủ để đặt tối thiểu ${formatNumber(MIN_BET)}!`, { reply_to_message_id: msg.message_id }); } catch {}
      return true;
    }
  } else {
    amount = parseInt(rawAmt.replace(/[.,\s]/g, ""));
    if (isNaN(amount) || amount < MIN_BET) {
      try { await bot.sendMessage(chatId, `❗ Số tiền tối thiểu là ${formatNumber(MIN_BET)}`, { reply_to_message_id: msg.message_id }); } catch {}
      return true;
    }
    if (amount > TD_MAX_BET) {
      try { await bot.sendMessage(chatId, `❗ Số tiền tối đa là ${formatNumber(TD_MAX_BET)}`, { reply_to_message_id: msg.message_id }); } catch {}
      return true;
    }
  }
  if (user.balance < amount) {
    try { await bot.sendMessage(chatId, `❌ Không đủ số dư! Số dư hiện tại: ${formatNumber(user.balance)}đ`, { reply_to_message_id: msg.message_id }); } catch {}
    return true;
  }

  // Trừ tiền
  const newBal = user.balance - amount;
  db.prepare("UPDATE users SET balance=?, total_bet=total_bet+?, today_bet=today_bet+?, week_bet=week_bet+? WHERE id=?")
    .run(newBal, amount, amount, amount, user.id);
  consumeWagerRequirement(user.id, amount);
  recordTransaction({ userId: user.id, type: "bet", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Cược Trên/Dưới ${formatNumber(amount)}đ` });

  try { await bot.sendMessage(chatId, `🎲 Đang tung xúc xắc lần 1...`, { reply_to_message_id: msg.message_id }); } catch {}

  // Tung 2 xúc xắc lần đầu
  let d1 = 1, d2 = 1;
  try {
    const m1 = await bot.sendDice(chatId, { emoji: "🎲" });
    d1 = (m1 as any).dice?.value ?? Math.ceil(Math.random() * 6);
    await sleep(1_200);
    const m2 = await bot.sendDice(chatId, { emoji: "🎲" });
    d2 = (m2 as any).dice?.value ?? Math.ceil(Math.random() * 6);
    await sleep(3_500);
  } catch (e: any) { console.error("TD dice1 error:", e.message); }

  const firstTotal = d1 + d2;
  const de = TD_DICE_EMOJI;

  const multTren = getTdMult(firstTotal, "tren");
  const multDuoi = getTdMult(firstTotal, "duoi");
  const btnRow: TelegramBot.InlineKeyboardButton[] = [];
  if (multTren !== null) btnRow.push({ text: `🔺 TRÊN (>${firstTotal}) ${fmtMult(multTren)}`, callback_data: `td_tren_${user.id}` });
  if (multDuoi !== null) btnRow.push({ text: `🔻 DƯỚI (<${firstTotal}) ${fmtMult(multDuoi)}`, callback_data: `td_duoi_${user.id}` });

  let multInfoLine = "";
  if (multTren !== null && multDuoi !== null) multInfoLine = `🔺 TRÊN: *${fmtMult(multTren)}* | 🔻 DƯỚI: *${fmtMult(multDuoi)}*`;
  else if (multTren !== null) multInfoLine = `🔺 TRÊN: *${fmtMult(multTren)}* (DƯỚI không thể)`;
  else if (multDuoi !== null) multInfoLine = `🔻 DƯỚI: *${fmtMult(multDuoi)}* (TRÊN không thể)`;

  let askMsg: TelegramBot.Message;
  try {
    askMsg = await bot.sendMessage(chatId,
      `🔻 *XÚC XẮC TRÊN DƯỚI* 🔺\n\n` +
      `🎲 Lần 1: ${de[d1]} + ${de[d2]} = *${firstTotal}*\n\n` +
      `${multInfoLine}\n\n` +
      `❓ Lần tiếp theo sẽ *cao hơn* hay *thấp hơn ${firstTotal}*?\n` +
      `⏰ Bạn có *30 giây* để chọn!`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [btnRow] }
      }
    );
  } catch (e: any) {
    console.error("TD askMsg error:", e.message);
    // Hoàn tiền nếu gửi tin thất bại
    db.prepare("UPDATE users SET balance=? WHERE id=?").run(user.balance, user.id);
    return true;
  }

  const timer = setTimeout(async () => {
    if (!tdGames.has(user.id)) return;
    tdGames.delete(user.id);
    const fresh = getUserById(user.id);
    if (fresh) {
      const refundBal = fresh.balance + amount;
      db.prepare("UPDATE users SET balance=? WHERE id=?").run(refundBal, user.id);
      recordTransaction({ userId: user.id, type: "admin_add", amount, fee: 0, balanceBefore: fresh.balance, balanceAfter: refundBal, note: "Hoàn tiền Trên/Dưới (hết giờ)" });
      try {
        await bot.editMessageText(
          `🔻 *XÚC XẮC TRÊN DƯỚI* 🔺\n\n🎲 Lần 1: *${firstTotal}*\n\n⏰ Hết giờ chọn! Đã hoàn lại *${formatNumber(amount)}đ*.`,
          { chat_id: chatId, message_id: askMsg.message_id, parse_mode: "Markdown" }
        );
      } catch {}
    }
  }, TD_TIMEOUT_MS);

  tdGames.set(user.id, { telegramId, userId: user.id, chatId, amount, firstTotal, d1, d2, msgId: askMsg.message_id, timer });
  return true;
}

// ─── Slot Machine Handler ─────────────────────────────────────────────────────
async function handleSlGame(msg: TelegramBot.Message): Promise<boolean> {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const text = (msg.text ?? "").trim();
  const match = text.match(/^SL\s+(max|\d[\d.,]*)/i);
  if (!match) return false;
  const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
  if (!user || user.is_blocked) return true;

  let amount: number;
  const rawAmt = match[1].toLowerCase();
  if (rawAmt === "max") {
    amount = Math.min(user.balance, SL_MAX_BET);
    if (amount < SL_MIN_BET) { try { await bot.sendMessage(chatId, `❌ Số dư không đủ tối thiểu ${formatNumber(SL_MIN_BET)}!`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  } else {
    amount = parseInt(rawAmt.replace(/[.,\s]/g, ""));
    if (isNaN(amount) || amount < SL_MIN_BET) { try { await bot.sendMessage(chatId, `❗ Tối thiểu ${formatNumber(SL_MIN_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
    if (amount > SL_MAX_BET) { try { await bot.sendMessage(chatId, `❗ Tối đa ${formatNumber(SL_MAX_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  }
  if (user.balance < amount) { try { await bot.sendMessage(chatId, `❌ Không đủ số dư! Số dư: ${formatNumber(user.balance)}đ`, { reply_to_message_id: msg.message_id }); } catch {} return true; }

  const newBal = user.balance - amount;
  db.prepare("UPDATE users SET balance=?, total_bet=total_bet+?, today_bet=today_bet+?, week_bet=week_bet+? WHERE id=?")
    .run(newBal, amount, amount, amount, user.id);
  consumeWagerRequirement(user.id, amount);
  recordTransaction({ userId: user.id, type: "bet", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Cược SL ${formatNumber(amount)}đ` });

    try { await bot.sendMessage(chatId, `🎰 Đặt *SL* — ${formatNumber(amount)}đ\nĐang quay...`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
    try { await bot.sendMessage(telegramId, `🎰 Đặt *SL* — ${formatNumber(amount)}đ\nĐang quay...`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}

  let slotValue = 1;
  try {
    const m = await bot.sendDice(chatId, { emoji: "🎰" });
    slotValue = (m as any).dice?.value ?? Math.ceil(Math.random() * 64);
    await sleep(3_500);
  } catch (e: any) { console.error("SL dice:", e.message); }

  const { r1, r2, r3 } = decodeSlot(slotValue);
  const _fSl = (db.prepare("SELECT value FROM bot_settings WHERE key='force_sl'").get() as any)?.value;
  const isJackpot = _fSl === 'jackpot' ? true : (_fSl === 'triple' || _fSl === 'lose') ? false : slotValue === 64;
  const isTriple = _fSl === 'triple' ? true : (_fSl === 'jackpot' || _fSl === 'lose') ? false : (r1 === r2 && r2 === r3);
  const sym1 = SL_SYMBOLS[r1] ?? r1;
  const sym2 = SL_SYMBOLS[r2] ?? r2;
  const sym3 = SL_SYMBOLS[r3] ?? r3;
  const reelStr = `${sym1} | ${sym2} | ${sym3}`;

  let resultText = "";
  if (isJackpot) {
    const payout = Math.floor(amount * 8.0);
    const nb = newBal + payout;
    db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(nb, user.id);
    recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: newBal, balanceAfter: nb, note: "Thắng SL Jackpot 777" });
    resultText = `🎰 *JACKPOT 777!* 7️⃣7️⃣7️⃣\n\n🎉 CHÚC MỪNG! x8.0\n💰 Thắng *+${formatNumber(payout)}đ*\n💎 Số dư: *${formatNumber(nb)}đ*`;
  } else if (isTriple) {
    const payout = Math.floor(amount * 5.0);
    const nb = newBal + payout;
    db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(nb, user.id);
    recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: newBal, balanceAfter: nb, note: `Thắng SL 3 giống x5` });
    resultText = `✨ *3 BIỂU TƯỢNG GIỐNG NHAU!* x5.0\n💰 Thắng *+${formatNumber(payout)}đ*\n💎 Số dư: *${formatNumber(nb)}đ*`;
  } else {
    const refund = Math.floor(amount * 0.1);
    const nb = newBal + refund;
    db.prepare("UPDATE users SET balance=?, lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(nb, user.id);
    recordTransaction({ userId: user.id, type: "win", amount: refund, fee: 0, balanceBefore: newBal, balanceAfter: nb, note: "Hoàn 10% SL không trùng" });
    resultText = `💸 *KHÔNG TRÙNG* — Hoàn 10%\n💰 Hoàn lại *+${formatNumber(refund)}đ*\n💎 Số dư: *${formatNumber(nb)}đ*`;
  }
  try {
    await bot.sendMessage(chatId,
      `🎰 *KẾT QUẢ SLOT MACHINE*\n\n${reelStr}\n\n${resultText}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Quay lại", callback_data: "sl_play_again" }]] } }
    );
  } catch (e: any) { console.error("SL result:", e.message); }
  return true;
}

// ─── Basketball Game Handler ──────────────────────────────────────────────────
async function handleBrGame(msg: TelegramBot.Message): Promise<boolean> {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const text = (msg.text ?? "").trim();
  const match = text.match(/^BR\s+(max|\d[\d.,]*)/i);
  if (!match) return false;
  const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
  if (!user || user.is_blocked) return true;

  let amount: number;
  const rawAmt = match[1].toLowerCase();
  if (rawAmt === "max") {
    amount = Math.min(user.balance, BR_MAX_BET);
    if (amount < BR_MIN_BET) { try { await bot.sendMessage(chatId, `❌ Số dư không đủ tối thiểu ${formatNumber(BR_MIN_BET)}!`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  } else {
    amount = parseInt(rawAmt.replace(/[.,\s]/g, ""));
    if (isNaN(amount) || amount < BR_MIN_BET) { try { await bot.sendMessage(chatId, `❗ Tối thiểu ${formatNumber(BR_MIN_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
    if (amount > BR_MAX_BET) { try { await bot.sendMessage(chatId, `❗ Tối đa ${formatNumber(BR_MAX_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  }
  if (user.balance < amount) { try { await bot.sendMessage(chatId, `❌ Không đủ số dư! Số dư: ${formatNumber(user.balance)}đ`, { reply_to_message_id: msg.message_id }); } catch {} return true; }

  const newBal = user.balance - amount;
  db.prepare("UPDATE users SET balance=?, total_bet=total_bet+?, today_bet=today_bet+?, week_bet=week_bet+? WHERE id=?")
    .run(newBal, amount, amount, amount, user.id);
  consumeWagerRequirement(user.id, amount);
  recordTransaction({ userId: user.id, type: "bet", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Cược BR ${formatNumber(amount)}đ` });

  try { await bot.sendMessage(chatId, `🏀 Đặt *BR* — ${formatNumber(amount)}đ\nĐang ném bóng...`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
  try { await bot.sendMessage(telegramId, `🏀 Đặt *BR* — ${formatNumber(amount)}đ\nĐang ném bóng...`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}

  let diceValue = 1;
  try {
    const m = await bot.sendDice(chatId, { emoji: "🏀" });
    diceValue = (m as any).dice?.value ?? Math.ceil(Math.random() * 5);
    await sleep(3_500);
  } catch (e: any) { console.error("BR dice:", e.message); }

  const _fBr = (db.prepare("SELECT value FROM bot_settings WHERE key='force_br'").get() as any)?.value;
  const won = _fBr === 'win' ? true : _fBr === 'lose' ? false : diceValue === 5;
  let resultText = "";
  if (won) {
    const payout = Math.floor(amount * BR_MULTIPLIER);
    const nb = newBal + payout;
    db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(nb, user.id);
    recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: newBal, balanceAfter: nb, note: "Thắng BR Bóng vào rổ" });
    resultText = `🎉 *BÓNG VÀO RỔ!* ✅\n💰 Thắng *+${formatNumber(payout)}đ*\n💎 Số dư: *${formatNumber(nb)}đ*`;
  } else {
    db.prepare("UPDATE users SET lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(user.id);
    recordTransaction({ userId: user.id, type: "bet", amount: 0, fee: 0, balanceBefore: newBal, balanceAfter: newBal, note: "Thua BR Bóng không vào" });
    resultText = `😔 *BÓNG KHÔNG VÀO!* ❌\n💸 Mất *${formatNumber(amount)}đ*\n💎 Số dư: *${formatNumber(newBal)}đ*`;
  }
  try {
    await bot.sendMessage(chatId,
      `🏀 *KẾT QUẢ BÓNG RỔ*\n\n${resultText}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Chơi lại", callback_data: "br_play_again" }]] } }
    );
  } catch (e: any) { console.error("BR result:", e.message); }
  return true;
}

// ─── SB Game (Đoán tổng 3 xúc xắc) ──────────────────────────────────────────
const SB_MULTIPLIERS: Record<number, number> = {
  4: 40, 17: 40,
  5: 18, 16: 18,
  6: 12, 15: 12,
  7: 8,  14: 8,
  8: 6,  13: 6,
  9: 5,  12: 5,
  10: 5, 11: 5,
};
const SB_MIN_BET = 2_000;
const SB_MAX_BET = 5_000_000;

async function handleSbGame(msg: TelegramBot.Message): Promise<boolean> {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const text = (msg.text ?? "").trim();
  const match = text.match(/^SB(3|4|5|6|7|8|9|1[0-8])(?:\s+|)(max|\d[\d.,]*)$/i);
  if (!match) return false;

  const chosenNum = parseInt(match[1]);
  if (!SB_MULTIPLIERS[chosenNum]) {
    try { await bot.sendMessage(chatId, `❗ Số bạn chọn phải từ *4* đến *17*!\nVD: *SB11 20000*`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
    return true;
  }

  const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
  if (!user || user.is_blocked) return true;

  let amount: number;
  const rawAmt = match[2].toLowerCase();
  const isGroup = msg.chat.type !== "private";
  const maxBet = isGroup ? SB_MAX_BET : 500_000;
  if (rawAmt === "max") {
    amount = Math.min(user.balance, maxBet);
    if (amount < SB_MIN_BET) { try { await bot.sendMessage(chatId, `❌ Số dư không đủ tối thiểu ${formatNumber(SB_MIN_BET)}!`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  } else {
    amount = parseInt(rawAmt.replace(/[.,\s]/g, ""));
    if (isNaN(amount) || amount < SB_MIN_BET) { try { await bot.sendMessage(chatId, `❗ Tối thiểu ${formatNumber(SB_MIN_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
    if (amount > maxBet) { try { await bot.sendMessage(chatId, `❗ Tối đa ${formatNumber(maxBet)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  }
  if (user.balance < amount) { try { await bot.sendMessage(chatId, `❌ Không đủ số dư! Số dư: ${formatNumber(user.balance)}đ`, { reply_to_message_id: msg.message_id }); } catch {} return true; }

  const newBal = user.balance - amount;
  db.prepare("UPDATE users SET balance=?, total_bet=total_bet+?, today_bet=today_bet+?, week_bet=week_bet+? WHERE id=?")
    .run(newBal, amount, amount, amount, user.id);
  consumeWagerRequirement(user.id, amount);
  recordTransaction({ userId: user.id, type: "bet", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Cược SB${chosenNum} ${formatNumber(amount)}đ` });

  const sbReplyText = `*${vipEmoji(user.vip_level)} Đặt thành công phiên #${session?.sessionNumber ?? "?"}*\n*SB${chosenNum} - ${formatNumber(amount)}*`;
  try { await bot.sendMessage(chatId, sbReplyText, { parse_mode: "Markdown", reply_to_message_id: msg.message_id, allow_sending_without_reply: false }); } catch {}

  let d1 = 1, d2 = 1, d3 = 1;
  try {
    const m1 = await bot.sendDice(chatId, { emoji: "🎲" }); d1 = (m1 as any).dice?.value ?? Math.ceil(Math.random() * 6);
    await sleep(700);
    const m2 = await bot.sendDice(chatId, { emoji: "🎲" }); d2 = (m2 as any).dice?.value ?? Math.ceil(Math.random() * 6);
    await sleep(700);
    const m3 = await bot.sendDice(chatId, { emoji: "🎲" }); d3 = (m3 as any).dice?.value ?? Math.ceil(Math.random() * 6);
    await sleep(2_200);
  } catch (e: any) { console.error("SB dice:", e.message); }

  const total = d1 + d2 + d3;
  const de = TD_DICE_EMOJI;
  const diceStr = `${de[d1] ?? d1} + ${de[d2] ?? d2} + ${de[d3] ?? d3}`;
  const multiplier = SB_MULTIPLIERS[chosenNum];
  const won = total === chosenNum;

  let resultText = "";
  if (won) {
    const payout = Math.floor(amount * multiplier);
    const nb = newBal + payout;
    db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(nb, user.id);
    recordTransaction({ userId: user.id, type: "win", amount: payout, fee: 0, balanceBefore: newBal, balanceAfter: nb, note: `Thắng SB${chosenNum} x${multiplier}` });
    resultText = `🎉 *TRÚNG SỐ!* Tổng: *${total}* = *${chosenNum}* ✅\n💰 Thắng *+${formatNumber(payout)}đ* (x${multiplier})\n💎 Số dư: *${formatNumber(nb)}đ*`;
  } else {
    db.prepare("UPDATE users SET lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(user.id);
    recordTransaction({ userId: user.id, type: "bet", amount: 0, fee: 0, balanceBefore: newBal, balanceAfter: newBal, note: `Thua SB${chosenNum} tổng=${total}` });
    resultText = `😔 *KHÔNG TRÚNG!* Tổng: *${total}* ≠ *${chosenNum}* ❌\n💸 Mất *${formatNumber(amount)}đ*\n💎 Số dư: *${formatNumber(newBal)}đ*`;
  }
  try {
    await bot.sendMessage(
      chatId,
      `🎲 *KẾT QUẢ ĐOÁN TỔNG 3 XÚC XẮC*\n\n${diceStr}\n🔢 Tổng: *${total}* | Bạn chọn: *${chosenNum}* (x${multiplier})\n\n${resultText}`,
      { parse_mode: "Markdown", reply_to_message_id: msg.message_id, allow_sending_without_reply: false, reply_markup: { inline_keyboard: [[{ text: "🔄 Chơi lại", callback_data: `sb_again_${chosenNum}_${amount}` }]] } }
    );
  } catch (e: any) { console.error("SB result:", e.message); }
  return true;
}

// ─── XX Game Functions ────────────────────────────────────────────────────────
async function resolveXxGame(chatId: number, userId: number, betType: string, amount: number, total: number, dice: number[], balAfterBet: number) {
  const user = getUserById(userId);
  if (!user) return;
  const de = TD_DICE_EMOJI;
  const diceStr = dice.map(d => de[d] ?? `${d}`).join(" + ");
  const _fXx = (db.prepare("SELECT value FROM bot_settings WHERE key='force_xx'").get() as any)?.value;
  const won = _fXx === 'win' ? true : _fXx === 'lose' ? false : checkXxWin(betType, total);
  let resultText = "";
  if (won) {
    const payout = Math.floor(amount * XX_MULTIPLIER);
    const nb = balAfterBet + payout;
    db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(nb, userId);
    recordTransaction({ userId, type: "win", amount: payout, fee: 0, balanceBefore: balAfterBet, balanceAfter: nb, note: `Thắng XX ${XX_LABEL[betType]}` });
    resultText = `🎉 *THẮNG!* Tổng: *${total}* → *${XX_LABEL[betType]}* ✅\n💰 Thắng *+${formatNumber(payout)}đ*\n💎 Số dư: *${formatNumber(nb)}đ*`;
  } else {
    db.prepare("UPDATE users SET lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(userId);
    recordTransaction({ userId, type: "bet", amount: 0, fee: 0, balanceBefore: balAfterBet, balanceAfter: balAfterBet, note: `Thua XX ${XX_LABEL[betType]}` });
    resultText = `😔 *THUA!* Tổng: *${total}* → không phải *${XX_LABEL[betType]}*\n💸 Mất *${formatNumber(amount)}đ*\n💎 Số dư: *${formatNumber(balAfterBet)}đ*`;
  }
  try {
    await bot.sendMessage(chatId,
      `🎲 *KẾT QUẢ XÚC XẮC TELEGRAM*\n\n${diceStr} = *${total}*\n\n${resultText}`,
      { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔄 Chơi lại", callback_data: "xx_play_again" }]] } }
    );
  } catch (e: any) { console.error("XX result:", e.message); }
}

async function handleXxGame(msg: TelegramBot.Message): Promise<boolean> {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const text = (msg.text ?? "").trim();
  const match = text.match(/^(xxc|xxl|xxx|xxt)\s+(max|\d[\d.,]*)/i);
  if (!match) return false;
  const betType = match[1].toLowerCase();
  const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
  if (!user || user.is_blocked) return true;
  if (xxPending.has(user.id)) {
    try { await bot.sendMessage(chatId, "⚠️ Bạn đang có ván xúc xắc chưa xong! Hãy gửi 🎲 để tung tiếp.", { reply_to_message_id: msg.message_id }); } catch {}
    return true;
  }
  let amount: number;
  const rawAmt = match[2].toLowerCase();
  if (rawAmt === "max") {
    amount = Math.min(user.balance, XX_MAX_BET);
    if (amount < XX_MIN_BET) { try { await bot.sendMessage(chatId, `❌ Số dư không đủ tối thiểu ${formatNumber(XX_MIN_BET)}!`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  } else {
    amount = parseInt(rawAmt.replace(/[.,\s]/g, ""));
    if (isNaN(amount) || amount < XX_MIN_BET) { try { await bot.sendMessage(chatId, `❗ Tối thiểu ${formatNumber(XX_MIN_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
    if (amount > XX_MAX_BET) { try { await bot.sendMessage(chatId, `❗ Tối đa ${formatNumber(XX_MAX_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return true; }
  }
  if (user.balance < amount) { try { await bot.sendMessage(chatId, `❌ Không đủ số dư! Số dư: ${formatNumber(user.balance)}đ`, { reply_to_message_id: msg.message_id }); } catch {} return true; }

  const newBal = user.balance - amount;
  db.prepare("UPDATE users SET balance=?, total_bet=total_bet+?, today_bet=today_bet+?, week_bet=week_bet+? WHERE id=?")
    .run(newBal, amount, amount, amount, user.id);
  consumeWagerRequirement(user.id, amount);
  recordTransaction({ userId: user.id, type: "bet", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Cược XX ${XX_LABEL[betType]} ${formatNumber(amount)}đ` });

  const mode = getXxMode(telegramId);
  if (mode === "bot") {
    try { await bot.sendMessage(chatId, `🎲 *${XX_LABEL[betType]}* — ${formatNumber(amount)}đ\nĐang tung xúc xắc...`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
    try { await bot.sendMessage(telegramId, `🎲 *${XX_LABEL[betType]}* — ${formatNumber(amount)}đ\nĐang tung xúc xắc...`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
    let d1 = 1, d2 = 1, d3 = 1;
    try {
      const m1 = await bot.sendDice(chatId, { emoji: "🎲" }); d1 = (m1 as any).dice?.value ?? Math.ceil(Math.random() * 6);
      await sleep(700);
      const m2 = await bot.sendDice(chatId, { emoji: "🎲" }); d2 = (m2 as any).dice?.value ?? Math.ceil(Math.random() * 6);
      await sleep(700);
      const m3 = await bot.sendDice(chatId, { emoji: "🎲" }); d3 = (m3 as any).dice?.value ?? Math.ceil(Math.random() * 6);
      await sleep(2_200);
    } catch (e: any) { console.error("XX dice:", e.message); }
    await resolveXxGame(chatId, user.id, betType, amount, d1 + d2 + d3, [d1, d2, d3], newBal);
  } else {
    // Player mode — chờ user gửi 3 🎲
    let infoMsgId: number | undefined;
    try {
      const im = await bot.sendMessage(chatId,
        `🎲 *XÚC XẮC TELEGRAM*\n\n` +
        `Đặt *${XX_LABEL[betType]}* — *${formatNumber(amount)}đ*\n\n` +
        `📨 Hãy gửi *3 lần* 🎲 vào đây để tung!\n_(0/3 đã nhận)_`,
        { parse_mode: "Markdown", reply_to_message_id: msg.message_id }
      );
      infoMsgId = im.message_id;
    } catch {}
    xxPending.set(user.id, { telegramId, userId: user.id, chatId, betType, amount, dice: [], msgId: infoMsgId });
  }
  return true;
}

// ─── Bet Handler ──────────────────────────────────────────────────────────────
const BET_REGEX = /^(ttc|tll|xcc|xll|tt|xx|cc|ll|tc|tl|xc|xl|t(?:ai|ài|à)?|x(?:iu|ỉu|ỉ)?|c(?:han|hẵn|hăn)?|l(?:e|ẻ)?)\s+([\d.,]+|max)$/i;
const ANONYMOUS_BET_TYPES = new Set(["tt", "xx", "cc", "ll", "ttc", "tll", "xcc", "xll"]);

function normalizeBetType(raw: string) {
  const s = raw.toLowerCase();
  if (s === "ttc") return "tc"; if (s === "tll") return "tl"; if (s === "xcc") return "xc"; if (s === "xll") return "xl";
  if (s === "tt") return "tai"; if (s === "xx") return "xiu"; if (s === "cc") return "chan"; if (s === "ll") return "le";
  if (s === "tc") return "tc"; if (s === "tl") return "tl"; if (s === "xc") return "xc"; if (s === "xl") return "xl";
  if (s === "t" || s.startsWith("ta") || s.startsWith("tà")) return "tai";
  if (s === "x" || s.startsWith("xi") || s.startsWith("xỉ")) return "xiu";
  if (s === "c" || s.startsWith("ch")) return "chan";
  if (s === "l" || s.startsWith("le") || s.startsWith("lẻ")) return "le";
  return null;
}

const betTypeLabel: any = { tai: "Tài", xiu: "Xỉu", chan: "Chẵn", le: "Lẻ", tc: "Tài Chẵn", tl: "Tài Lẻ", xc: "Xỉu Chẵn", xl: "Xỉu Lẻ" };
const betTypeShort: any = { tai: "T", xiu: "X", chan: "C", le: "L", tc: "TC", tl: "TL", xc: "XC", xl: "XL" };

async function handleGroupBet(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const telegramId = msg.from!.id;
  const text = (msg.text ?? "").trim();

  const match = text.match(BET_REGEX);
  if (!match) return false;

  let session = activeSessions.get(chatId);
  if (!session) {
    if (!enabledGroups.has(chatId)) return false;
    if (rollingChats.has(chatId)) {
      try {
        await bot.sendMessage(chatId, "*⏰ Hết thời gian đặt cược, vui lòng chờ phiên khác.*", { reply_to_message_id: msg.message_id, parse_mode: "Markdown" });
      } catch {}
      return true;
    }
    await startSession(chatId, true);
    session = activeSessions.get(chatId);
    if (!session) return false;
  }

  const rawBetInput = match[1].toLowerCase();
  const betType = normalizeBetType(rawBetInput);
  if (!betType) return false;
  const isAnon = ANONYMOUS_BET_TYPES.has(rawBetInput);

  const user = getUserByTelegramId(telegramId);
  if (!user) {
    try { await bot.sendMessage(chatId, "*❗ Bạn chưa đăng ký. Nhắn /start cho bot để tạo tài khoản.*", { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
    return true;
  }

  if (user.is_blocked) return true;

  let amount: number;
  const rawAmount = match[2].toLowerCase();
  if (rawAmount === "max") {
    amount = Math.min(user.balance, MAX_BET);
    if (amount < MIN_BET) {
      try { await bot.sendMessage(chatId, `*❌ Số dư không đủ để đặt tối thiểu ${formatNumber(MIN_BET)}!*`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
      return true;
    }
  } else {
    amount = parseInt(rawAmount.replace(/[.,\s]/g, ""));
    if (isNaN(amount) || amount < MIN_BET) {
      try { await bot.sendMessage(chatId, `*❗ Số tiền tối thiểu là ${formatNumber(MIN_BET)}*`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
      return true;
    }
    if (amount > MAX_BET) {
      try { await bot.sendMessage(chatId, `*❗ Số tiền tối đa là ${formatNumber(MAX_BET)}*`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
      return true;
    }
  }

  if (user.balance < amount) {
    try { await bot.sendMessage(chatId, `*❌ Không đủ số dư! Số dư: ${formatNumber(user.balance)}*`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
    return true;
  }

  const betSides: Record<string, { tx?: "T" | "X"; cl?: "C" | "L" }> = {
    tai: { tx: "T" }, xiu: { tx: "X" },
    chan: { cl: "C" }, le: { cl: "L" },
    tc: { tx: "T", cl: "C" }, tl: { tx: "T", cl: "L" },
    xc: { tx: "X", cl: "C" }, xl: { tx: "X", cl: "L" },
  };
  const sNew = betSides[betType];
  const allBetTypes = ["tai", "xiu", "chan", "le", "tc", "tl", "xc", "xl"] as const;
  let conflictWith: string | null = null;
  for (const t of allBetTypes) {
    if (t === betType) continue;
    if (!session.bets[t].has(user.id)) continue;
    const sOld = betSides[t];
    if ((sNew.tx && sOld.tx && sNew.tx !== sOld.tx) || (sNew.cl && sOld.cl && sNew.cl !== sOld.cl)) {
      conflictWith = t;
      break;
    }
  }
  if (conflictWith) {
    try { await bot.sendMessage(chatId, `❌ Không được đặt 2 cửa đối nghịch!\nBạn đã đặt *${betTypeLabel[conflictWith].toUpperCase()}*, không thể đặt thêm *${betTypeLabel[betType].toUpperCase()}*`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
    return true;
  }

  const newBal = user.balance - amount;
  db.prepare("UPDATE users SET balance = ?, total_bet = ?, today_bet = ?, week_bet = ? WHERE id = ?")
    .run(newBal, user.total_bet + amount, user.today_bet + amount, user.week_bet + amount, user.id);
  consumeWagerRequirement(user.id, amount);
  recordTransaction({ userId: user.id, type: "bet", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Cược ${betTypeLabel[betType].toUpperCase()} phiên #${session.sessionNumber}` });

  const wasEmpty = !hasBets(session);
  const isFirstBet = !session.bets.tai.has(user.id) && !session.bets.xiu.has(user.id) &&
    !session.bets.chan.has(user.id) && !session.bets.le.has(user.id) &&
    !session.bets.tc.has(user.id) && !session.bets.tl.has(user.id) &&
    !session.bets.xc.has(user.id) && !session.bets.xl.has(user.id);

  const existing = session.bets[betType].get(user.id) ?? 0;
  session.bets[betType].set(user.id, existing + amount);
  const totalThisType = session.bets[betType].get(user.id);

  if (wasEmpty && session.silent) {
    session.silent = false;
    session.timers.forEach(clearTimeout);
    session.timers = [];
    const _sid = session.sessionId;
    const _snum = session.sessionNumber;
    const nt1 = setTimeout(async () => { const s = activeSessions.get(chatId); if (!s || s.sessionId !== _sid || !hasBets(s)) return; try { await bot.sendMessage(chatId, formatBetStatus(_snum, 40, getBetTotals(s)), { parse_mode: "Markdown" }); } catch {} }, WARN_40S_MS);
    const nt2 = setTimeout(async () => { const s = activeSessions.get(chatId); if (!s || s.sessionId !== _sid || !hasBets(s)) return; try { await bot.sendMessage(chatId, formatBetStatus(_snum, 20, getBetTotals(s)), { parse_mode: "Markdown" }); } catch {} }, WARN_20S_MS);
    const nt3 = setTimeout(() => endSession(chatId, _sid), GAME_DURATION_MS);
    session.timers = [nt1, nt2, nt3];
  }

  if (isAnon) {
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    try { await bot.sendMessage(chatId, `*${vipEmoji(user.vip_level)} Đặt thành công phiên #${session.sessionNumber}*\n*${betTypeShort[betType]} - ${formatNumber(totalThisType)} {Ẩn Danh}*`, { parse_mode: "Markdown" }); } catch (e: any) { console.error(e.message); }
    try { await bot.sendMessage(telegramId, `*${vipEmoji(user.vip_level)} Đặt thành công phiên #${session.sessionNumber}*\n*${betTypeShort[betType]} - ${formatNumber(totalThisType)} {Ẩn Danh}*`, { parse_mode: "Markdown", reply_to_message_id: msg.message_id }); } catch (e: any) { console.error(e.message); }
  } else {
    try {
      const replyText = isFirstBet
        ? `*${vipEmoji(user.vip_level)} Đặt thành công phiên #${session.sessionNumber}*\n*${betTypeLabel[betType]} - ${formatNumber(totalThisType)}*`
        : `*${vipEmoji(user.vip_level)} Đặt thành công phiên #${session.sessionNumber}*\n*${betTypeShort[betType]} - ${formatNumber(amount)} (Cược dồn)*`;
      await bot.sendMessage(chatId, replyText, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" });
      await bot.sendMessage(telegramId, replyText, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" });
    } catch (e: any) { console.error(e.message); }
  }
  try { await bot.sendMessage(user.telegram_id, `🥇 Đặt thành công phiên #${session.sessionNumber}\n${betTypeShort[betType]} - ${formatNumber(amount)}\nSố dư sau khi cược: ${formatNumber(newBal)}`); } catch {}
  return true;
}

// ─── Private Chat Bet (ẩn danh lên nhóm) ─────────────────────────────────────
async function handlePrivateBet(msg: TelegramBot.Message, groupChatId: number, session: any): Promise<boolean> {
  const telegramId = msg.from!.id;
  const chatId = msg.chat.id; // private chat
  const text = (msg.text ?? "").trim();

  const match = text.match(BET_REGEX);
  if (!match) return false;

  const rawBetInput = match[1].toLowerCase();
  const betType = normalizeBetType(rawBetInput);
  if (!betType) return false;

  const user = getUserByTelegramId(telegramId);
  if (!user) {
    await bot.sendMessage(chatId, "❗ Bạn chưa đăng ký. Nhắn /start để tạo tài khoản.");
    return true;
  }
  if (user.is_blocked) return true;

  let amount: number;
  const rawAmount = match[2].toLowerCase();
  if (rawAmount === "max") {
    amount = Math.min(user.balance, MAX_BET);
    if (amount < MIN_BET) {
      await bot.sendMessage(chatId, `❌ Số dư không đủ để đặt tối thiểu ${formatNumber(MIN_BET)}!`);
      return true;
    }
  } else {
    amount = parseInt(rawAmount.replace(/[.,\s]/g, ""));
    if (isNaN(amount) || amount < MIN_BET) {
      await bot.sendMessage(chatId, `❗ Số tiền tối thiểu là ${formatNumber(MIN_BET)}`);
      return true;
    }
    if (amount > MAX_BET) {
      await bot.sendMessage(chatId, `❗ Số tiền tối đa là ${formatNumber(MAX_BET)}`);
      return true;
    }
  }

  if (user.balance < amount) {
    await bot.sendMessage(chatId, `❌ Không đủ số dư! Số dư: ${formatNumber(user.balance)}`);
    return true;
  }

  // Kiểm tra cửa đối nghịch
  const betSides: Record<string, { tx?: "T" | "X"; cl?: "C" | "L" }> = {
    tai: { tx: "T" }, xiu: { tx: "X" },
    chan: { cl: "C" }, le: { cl: "L" },
    tc: { tx: "T", cl: "C" }, tl: { tx: "T", cl: "L" },
    xc: { tx: "X", cl: "C" }, xl: { tx: "X", cl: "L" },
  };
  const sNew = betSides[betType];
  const allBetTypes = ["tai", "xiu", "chan", "le", "tc", "tl", "xc", "xl"] as const;
  for (const t of allBetTypes) {
    if (t === betType || !session.bets[t].has(user.id)) continue;
    const sOld = betSides[t];
    if ((sNew.tx && sOld.tx && sNew.tx !== sOld.tx) || (sNew.cl && sOld.cl && sNew.cl !== sOld.cl)) {
      await bot.sendMessage(chatId, `❌ Bạn đã đặt *${betTypeLabel[t].toUpperCase()}*, không thể đặt thêm *${betTypeLabel[betType].toUpperCase()}*`, { parse_mode: "Markdown" });
      return true;
    }
  }

  const newBal = user.balance - amount;
  db.prepare("UPDATE users SET balance = ?, total_bet = ?, today_bet = ?, week_bet = ? WHERE id = ?")
    .run(newBal, user.total_bet + amount, user.today_bet + amount, user.week_bet + amount, user.id);
  consumeWagerRequirement(user.id, amount);
  recordTransaction({ userId: user.id, type: "bet", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Cược ${betTypeLabel[betType].toUpperCase()} phiên #${session.sessionNumber} (ẩn danh)` });

  const wasEmpty = !hasBets(session);
  const existing = session.bets[betType].get(user.id) ?? 0;
  session.bets[betType].set(user.id, existing + amount);
  const totalThisType = session.bets[betType].get(user.id);

  // Nếu phiên đang silent (không ai cược), kích hoạt countdown
  if (wasEmpty && session.silent) {
    session.silent = false;
    session.timers.forEach(clearTimeout);
    const _sid = session.sessionId; const _snum = session.sessionNumber;
    const nt1 = setTimeout(async () => { const s = activeSessions.get(groupChatId); if (!s || s.sessionId !== _sid || !hasBets(s)) return; try { await bot.sendMessage(groupChatId, formatBetStatus(_snum, 40, getBetTotals(s)), { parse_mode: "Markdown" }); } catch {} }, WARN_40S_MS);
    const nt2 = setTimeout(async () => { const s = activeSessions.get(groupChatId); if (!s || s.sessionId !== _sid || !hasBets(s)) return; try { await bot.sendMessage(groupChatId, formatBetStatus(_snum, 20, getBetTotals(s)), { parse_mode: "Markdown" }); } catch {} }, WARN_20S_MS);
    const nt3 = setTimeout(() => endSession(groupChatId, _sid), GAME_DURATION_MS);
    session.timers = [nt1, nt2, nt3];
  }

  // Đăng lên nhóm dạng ẩn danh
  try {
    await bot.sendMessage(groupChatId,
      `*${vipEmoji(user.vip_level)} Đặt thành công phiên #${session.sessionNumber}*\n*${betTypeShort[betType]} - ${formatNumber(totalThisType)} {Ẩn Danh}*`,
      { parse_mode: "Markdown" }
    );
  } catch {}

  // Xác nhận riêng cho người chơi
  await bot.sendMessage(chatId,
    `✅ *Đặt cược thành công (ẩn danh)*\n\n🎰 Phiên #${session.sessionNumber}\n${betTypeLabel[betType]} – ${formatNumber(amount)}\n💰 Số dư còn lại: ${formatNumber(newBal)}`,
    { parse_mode: "Markdown" }
  );
  return true;
}

// ─── State Machine ────────────────────────────────────────────────────────────
const userStates = new Map<number, any>();
function getState(uid: number) { return userStates.get(uid) ?? { step: "idle" }; }
function setState(uid: number, s: any) { userStates.set(uid, s); }
function resetState(uid: number) { userStates.set(uid, { step: "idle" }); }

// ─── Keyboards ──────────────────────────────────────────────────────────────
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "🎮 Danh sách game" }, { text: "🏦 Tài Khoản" }],
        [{ text: "💵 Nạp Tiền" }, { text: "💸 Rút Tiền" }],
        [{ text: "🌺 Giới Thiệu" }, { text: "⭐ Đua top" }],
        [{ text: "👑 VIP" }, { text: "🔍 Lệnh" }],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function accountInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📈 LS nạp", callback_data: "acc_ls_nap" }, { text: "📉 LS rút", callback_data: "acc_ls_rut" }],
      [{ text: "🎮 LS chơi", callback_data: "acc_ls_choi" }, { text: "💸 Chuyển tiền", callback_data: "acc_chuyen" }],
      [{ text: "🎁 Nhập giftcode", callback_data: "acc_nhap_gift" }, { text: "🎉 Mua giftcode", callback_data: "acc_mua_gift" }],
      [{ text: "📞 Hỗ trợ", callback_data: "acc_hotro" }],
    ],
  };
}

// ─── Account / History ────────────────────────────────────────────────────────
async function sendAccountInfo(chatId: number, telegramId: number) {
  const user = getUserByTelegramId(telegramId);
  if (!user) return;
  const today = new Date().toLocaleDateString("vi-VN");
  const msg =
    `👤 ID: ${user.telegram_id}\n💰 Số dư hiện tại: ${formatNumber(user.balance)}\n👑 Cấp Vip hiện tại: ${vipLabel(user.vip_level)}\n\n` +
    `– Cược hôm nay: ${formatNumber(user.today_bet)}\n– Cược tuần này: ${formatNumber(user.week_bet)}\n– Tổng cược: ${formatNumber(user.total_bet)}\n` +
    `– Tổng nạp: ${formatNumber(user.total_deposit)}\n– Tổng rút: ${formatNumber(user.total_withdraw)}\n${"=".repeat(20)}\n${today}:\n` +
    `Chuỗi thắng: ${user.win_streak}\nChuỗi thua: ${user.lose_streak}`;
  await bot.sendMessage(chatId, msg, { reply_markup: accountInlineKeyboard(), noBold: true } as any);
}

function formatVNDateTime(dateStr: string) {
  const d = new Date(dateStr.replace(" ", "T") + "Z");
  const vn = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  const hh = vn.getUTCHours().toString().padStart(2, "0");
  const mm = vn.getUTCMinutes().toString().padStart(2, "0");
  const ss = vn.getUTCSeconds().toString().padStart(2, "0");
  const dd = vn.getUTCDate().toString().padStart(2, "0");
  const mo = (vn.getUTCMonth() + 1).toString().padStart(2, "0");
  const yyyy = vn.getUTCFullYear();
  return `${hh}:${mm}:${ss} ${dd}/${mo}/${yyyy}`;
}

async function sendWithdrawHistory(chatId: number, userId: number) {
  const user = getUserById(userId);
  const stk = user?.bank_account ?? "Chưa liên kết";
  const rows = db.prepare(`SELECT * FROM transactions WHERE user_id = ? AND type = 'withdraw' ORDER BY created_at DESC LIMIT 10`).all(userId) as any[];
  if (rows.length === 0) { await bot.sendMessage(chatId, "📋 Chưa có lịch sử rút tiền.", mainMenuKeyboard()); return; }
  const lines = rows.map((r, i) => `${i + 1}. ${formatVNDateTime(r.created_at)} | ${formatNumber(r.amount)} | ${stk} | Thành công`);
  await bot.sendMessage(chatId, `📋 *Lịch sử rút tiền (10 gần nhất)*\n${lines.join("\n")}`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

async function sendDepositHistory(chatId: number, userId: number) {
  const user = getUserById(userId);
  const stk = user?.bank_account ?? "Chưa liên kết";
  const rows = db.prepare(`SELECT * FROM transactions WHERE user_id = ? AND type = 'deposit' ORDER BY created_at DESC LIMIT 10`).all(userId) as any[];
  if (rows.length === 0) { await bot.sendMessage(chatId, "📋 Chưa có lịch sử nạp tiền.", mainMenuKeyboard()); return; }
  const lines = rows.map((r, i) => `${i + 1}. ${formatVNDateTime(r.created_at)} | ${formatNumber(r.amount)} | ${stk} | Thành công`);
  await bot.sendMessage(chatId, `📋 *Lịch sử nạp tiền (10 gần nhất)*\n${lines.join("\n")}`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

async function sendBetHistory(chatId: number, userId: number) {
  const rows = db.prepare(`SELECT gb.bet_type, gb.amount, gb.is_win, gs.ended_at FROM game_bets gb JOIN game_sessions gs ON gb.session_id = gs.id WHERE gb.user_id = ? ORDER BY gs.ended_at DESC LIMIT 15`).all(userId) as any[];
  if (rows.length === 0) { await bot.sendMessage(chatId, "📋 Chưa có lịch sử chơi.", mainMenuKeyboard()); return; }
  const shortLabel: any = { tai: "T", xiu: "X", chan: "C", le: "L" };
  const lines = rows.map((r, i) => `${i + 1}. ${formatVNDateTime(r.ended_at)} | ${shortLabel[r.bet_type] ?? r.bet_type} | ${formatNumber(r.amount)} | ${r.is_win ? "Thắng ✅" : "Thua ❌"}`);
  await bot.sendMessage(chatId, `📋 *Lịch sử chơi gần nhất (15)*\n\n${lines.join("\n")}`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

// ─── Withdraw / Transfer ──────────────────────────────────────────────────────
async function processWithdraw(chatId: number, telegramId: number, amount: number) {
  const user = getUserByTelegramId(telegramId);
  if (!user) return;
  if (amount <= 0) { await bot.sendMessage(chatId, "❗ Số tiền không hợp lệ."); return; }
  if (amount < 100_000) { await bot.sendMessage(chatId, "❗ Rút tối thiểu 101.000!"); return; }
  if (!isAdmin(telegramId)) {
    if (user.total_deposit < 15_000) {
      await bot.sendMessage(chatId, `❌ Bạn chưa đủ điều kiện để rút tiền!\nCần tổng nạp tối thiểu *15.000* (hiện tại: ${formatNumber(user.total_deposit)}).`, { parse_mode: "Markdown" });
      return;
    }
    const wagerLeft = getWagerRequired(user.id);
    if (wagerLeft > 0) {
      await bot.sendMessage(chatId, `❌ Bạn cần cược thêm *${formatNumber(wagerLeft)}* trước khi có thể rút tiền.\n_(Mỗi lần nạp/nhập code yêu cầu cược x${WAGER_MULTIPLIER} mới được rút/chuyển/mua giftcode)_`, { parse_mode: "Markdown" });
      return;
    }
  }
  const fee = Math.floor(amount * (user.withdraw_fee_pct / 100));
  const net = amount - fee;
  if (user.balance < amount) { await bot.sendMessage(chatId, "❌ Không đủ số dư để rút tiền!"); return; }
  if (!user.bank_account || !user.bank_name || !user.bank_owner) { await bot.sendMessage(chatId, "❗ Bạn chưa liên kết ngân hàng.\nGõ /setbank để cài đặt."); return; }
  const newBalance = user.balance - amount;
  db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBalance, user.id);
  const row = db.prepare(`INSERT INTO pending_withdrawals (user_id, telegram_id, amount, fee, net, bank_name, bank_account, bank_owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(user.id, telegramId, amount, fee, net, user.bank_name, user.bank_account, user.bank_owner) as any;
  const witId = row.lastInsertRowid;
  await bot.sendMessage(chatId,
    `💸 *Yêu cầu rút tiền đã được gửi!*\n\n💵 Số tiền: ${formatNumber(amount)}\n💳 Phí rút (${user.withdraw_fee_pct}%): -${formatNumber(fee)}\n✅ Thực nhận: ${formatNumber(net)}\n\n🏦 ${user.bank_name} – ${user.bank_account} – ${user.bank_owner}\n\n⏳ Đang chờ admin duyệt. Số dư tạm giữ: ${formatNumber(newBalance)}`,
    { parse_mode: "Markdown", ...mainMenuKeyboard() }
  );
  const userName = user.first_name ? `${user.first_name}${user.username ? ` (@${user.username})` : ""}` : (user.username ? `@${user.username}` : `ID ${telegramId}`);
  for (const adminId of ADMIN_IDS) {
    try {
      await bot.sendMessage(adminId,
        `💸 *YÊU CẦU RÚT TIỀN*\n\n👤 User: ${userName}\n🆔 Telegram ID: ${telegramId}\n💵 Số tiền: *${formatNumber(amount)}*\n💳 Phí: ${formatNumber(fee)} | Thực nhận: *${formatNumber(net)}*\n🏦 ${user.bank_name} – ${user.bank_account} – ${user.bank_owner}\n🕐 Lúc: ${new Date().toLocaleString("vi-VN")}`,
        { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "✅ Duyệt", callback_data: `wit_approve_${witId}` }, { text: "❌ Từ chối", callback_data: `wit_reject_${witId}` }]] } }
      );
    } catch {}
  }
  resetState(telegramId);
}

const TRANSFER_FEE_PCT = 0.05;
const TRANSFER_MIN = 1_000;
const TRANSFER_HELP_MSG =
  `💸 Chuyển tiền theo cú pháp:\n\n` +
  `/chuyen [ID nhận tiền] [số tiền]\n\n` +
  `➡️ Vd: /chuyen 6281928101 10000\n\n` +
  `⚠️ Phí chuyển tiền là 5%, người chuyển chịu phí. Tối thiểu 1k`;
async function processTransfer(chatId: number, telegramId: number, targetTelegramId: number, amount: number) {
  const sender = getUserByTelegramId(telegramId);
  if (!sender) return;
  if (sender.telegram_id === targetTelegramId) { await bot.sendMessage(chatId, "❗ Không thể chuyển tiền cho chính mình."); return; }
  const receiver = getUserByTelegramId(targetTelegramId);
  if (!receiver) { await bot.sendMessage(chatId, `❌ Không tìm thấy người dùng Telegram ID: ${targetTelegramId}`); return; }
  if (!Number.isFinite(amount) || amount < TRANSFER_MIN) { await bot.sendMessage(chatId, `❗ Số tiền tối thiểu là ${formatNumber(TRANSFER_MIN)}.`); return; }
  if (!isAdmin(telegramId)) {
    const wagerLeft = getWagerRequired(sender.id);
    if (wagerLeft > 0) {
      await bot.sendMessage(chatId, `❌ Bạn cần cược thêm *${formatNumber(wagerLeft)}* trước khi có thể chuyển tiền.\n_(Mỗi lần nạp/nhập code yêu cầu cược x${WAGER_MULTIPLIER} mới được rút/chuyển/mua giftcode)_`, { parse_mode: "Markdown" });
      return;
    }
  }
  const fee = Math.ceil(amount * TRANSFER_FEE_PCT);
  const totalDebit = amount + fee;
  if (sender.balance < totalDebit) { await bot.sendMessage(chatId, `❌ Không đủ số dư! Cần ${formatNumber(totalDebit)} (gồm phí ${formatNumber(fee)}).`); return; }
  const senderNewBal = sender.balance - totalDebit;
  const receiverNewBal = receiver.balance + amount;
  db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(senderNewBal, sender.id);
  db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(receiverNewBal, receiver.id);
  recordTransaction({ userId: sender.id, type: "transfer_out", amount, fee, balanceBefore: sender.balance, balanceAfter: senderNewBal, note: `Chuyển tiền đến ID ${receiver.telegram_id}`, refUserId: receiver.id });
  recordTransaction({ userId: receiver.id, type: "transfer_in", amount, fee: 0, balanceBefore: receiver.balance, balanceAfter: receiverNewBal, note: `Nhận tiền từ ID ${sender.telegram_id}`, refUserId: sender.id });
  await bot.sendMessage(chatId, `✅ Chuyển tiền thành công!\n💰 Số tiền: ${formatNumber(amount)}\n💸 Phí 5%: ${formatNumber(fee)}\n👤 Đến: ID ${receiver.telegram_id} (${receiver.first_name ?? receiver.username ?? "Ẩn danh"})\n💳 Số dư còn lại: ${formatNumber(senderNewBal)}`, mainMenuKeyboard());
  try { await bot.sendMessage(receiver.telegram_id, `💰 Bạn vừa nhận được ${formatNumber(amount)} từ ID ${sender.telegram_id} (${sender.first_name ?? sender.username ?? "Ẩn danh"}).\nSố dư hiện tại: ${formatNumber(receiverNewBal)}`); } catch {}
  resetState(telegramId);
}

// ─── Giftcode / Checkin / Lixi ────────────────────────────────────────────────
async function redeemGiftcode(chatId: number, telegramId: number, code: string) {
  const user = getUserByTelegramId(telegramId);
  if (!user) return;
  // Yêu cầu nạp tối thiểu 20,000đ trong ngày hôm nay (giờ VN UTC+7)
  const todayDeposit = (db.prepare(
    `SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE user_id=? AND type='deposit' AND date(created_at,'+7 hours')=date('now','+7 hours')`
  ).get(user.id) as any).total;
  if (todayDeposit < 20000) {
    await bot.sendMessage(chatId,
      `❌ Bạn cần nạp tối thiểu *20,000đ* trong hôm nay để có thể nhập Giftcode.`,
      { parse_mode: "Markdown", ...mainMenuKeyboard() }
    );
    return;
  }
  const lastUse = db.prepare(
    "SELECT used_at FROM giftcode_usages WHERE user_id = ? ORDER BY id DESC LIMIT 1"
  ).get(user.id) as any;
  if (lastUse) {
    const lastTime = new Date(lastUse.used_at.replace(" ", "T") + "Z").getTime();
    const diffSec = Math.floor((Date.now() - lastTime) / 1000);
    const cooldown = 180;
    if (diffSec < cooldown) {
      const wait = cooldown - diffSec;
      const m = Math.floor(wait / 60); const s = wait % 60;
      const waitStr = m > 0 ? `${m}p ${s}s` : `${s}s`;
      await bot.sendMessage(chatId, `⏳ Bạn vừa nhập giftcode gần đây. Vui lòng chờ *${waitStr}* nữa rồi nhập tiếp.`, { parse_mode: "Markdown" });
      return;
    }
  }
  const gift = db.prepare("SELECT * FROM giftcodes WHERE code = ?").get(code) as any;
  if (!gift) { await bot.sendMessage(chatId, "❌ Giftcode không tồn tại!", mainMenuKeyboard()); return; }
  if (!gift.is_active) { await bot.sendMessage(chatId, "❌ Giftcode đã bị vô hiệu hóa!", mainMenuKeyboard()); return; }
  if (gift.expires_at && new Date() > new Date(gift.expires_at)) { await bot.sendMessage(chatId, "❌ Giftcode đã hết hạn!", mainMenuKeyboard()); return; }
  if (gift.used_count >= gift.max_uses) { await bot.sendMessage(chatId, "❌ Giftcode đã hết lượt sử dụng!", mainMenuKeyboard()); return; }
  const alreadyUsed = db.prepare("SELECT 1 FROM giftcode_usages WHERE giftcode_id = ? AND user_id = ?").get(gift.id, user.id);
  if (alreadyUsed) { await bot.sendMessage(chatId, "❌ Bạn đã sử dụng giftcode này rồi!", mainMenuKeyboard()); return; }
  const newBal = user.balance + gift.amount;
  db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, user.id);
  db.prepare("UPDATE giftcodes SET used_count = used_count + 1 WHERE id = ?").run(gift.id);
  db.prepare("INSERT INTO giftcode_usages (giftcode_id, user_id) VALUES (?, ?)").run(gift.id, user.id);
  recordTransaction({ userId: user.id, type: "gift", amount: gift.amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Nhập giftcode ${code}` });
  addWagerRequirement(user.id, gift.amount);
  await bot.sendMessage(chatId, `❇️ Nhập giftcode *${code}* thành công\nGiá trị: ${formatNumber(gift.amount)}\nSố dư hiện tại: ${formatNumber(newBal)}\n\n⚠️ Cần cược thêm *${formatNumber(gift.amount * WAGER_MULTIPLIER)}* trước khi rút/chuyển/mua giftcode.`, { parse_mode: "Markdown", ...mainMenuKeyboard() });

  const maskedGiftId = `****${String(telegramId).slice(-5)}`;
  const groupAnnounce =
    `*❇️ Người chơi ${maskedGiftId}*\n` +
    `*Nhận giftcode ${code} thành công! Giá trị: ${formatNumber(gift.amount)}*`;
  for (const gid of enabledGroups) {
    try { await bot.sendMessage(gid, groupAnnounce, { parse_mode: "Markdown" }); } catch {}
  }
}

async function handleCheckin(chatId: number, telegramId: number) {
  const user = getUserByTelegramId(telegramId);
  if (!user) return;
  const today = todayStr();
  if (isSameDay(user.last_checkin, today)) { await bot.sendMessage(chatId, "✅ Bạn đã điểm danh hôm nay rồi. Quay lại vào ngày mai!", mainMenuKeyboard()); return; }
  const lastCheckin = db.prepare("SELECT * FROM checkins WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(user.id) as any;
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  let streak = 1;
  if (lastCheckin && isSameDay(lastCheckin.created_at, yesterdayStr)) streak = lastCheckin.streak + 1;
  const reward = checkinReward(streak);
  const newBal = user.balance + reward;
  db.prepare("UPDATE users SET balance = ?, last_checkin = ? WHERE id = ?").run(newBal, today, user.id);
  db.prepare("INSERT INTO checkins (user_id, reward, streak) VALUES (?, ?, ?)").run(user.id, reward, streak);
  recordTransaction({ userId: user.id, type: "checkin", amount: reward, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Điểm danh ngày ${streak}` });
  await bot.sendMessage(chatId, `✅ *Điểm danh thành công!*\n\n📅 Chuỗi điểm danh: ${streak} ngày\n🎁 Nhận được: +${formatNumber(reward)}\n💰 Số dư hiện tại: ${formatNumber(newBal)}\n\n_Điểm danh mỗi ngày để nhận thưởng cao hơn!_`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

async function handleLixi(chatId: number, telegramId: number) {
  const user = getUserByTelegramId(telegramId);
  if (!user) return;
  const today = todayStr();
  if (user.daily_gift_claimed && isSameDay(user.daily_gift_date, today)) { await bot.sendMessage(chatId, "🧧 Bạn đã nhận lì xì hôm nay rồi. Quay lại vào ngày mai nhé!", mainMenuKeyboard()); return; }
  const amount = Math.floor(Math.random() * 4500) + 500;
  const newBal = user.balance + amount;
  db.prepare("UPDATE users SET balance = ?, daily_gift_claimed = 1, daily_gift_date = ? WHERE id = ?").run(newBal, today, user.id);
  recordTransaction({ userId: user.id, type: "gift", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: "Lì xì ngày" });
  await bot.sendMessage(chatId, `🧧 *Chúc Mừng!*\n\nBạn vừa nhận được lì xì *+${formatNumber(amount)}*!\n💰 Số dư hiện tại: ${formatNumber(newBal)}`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

async function handleAccumulatedDeposit(chatId: number, user: any) {
  const total = user.total_deposit;
  const tiers = [
    { min: 0, max: 1_000_000, bonus: "0%" }, { min: 1_000_000, max: 5_000_000, bonus: "5%" },
    { min: 5_000_000, max: 20_000_000, bonus: "10%" }, { min: 20_000_000, max: 100_000_000, bonus: "15%" },
    { min: 100_000_000, max: Infinity, bonus: "20%" },
  ];
  const current = tiers.find((t) => total >= t.min && total < (t.max === Infinity ? Infinity : t.max)) ?? tiers[tiers.length - 1];
  const next = tiers.find((t) => t.min > total);
  const lines = tiers.map((t) => { const active = total >= t.min && total < (t.max === Infinity ? Infinity : t.max); return `${active ? "▶" : "  "} ${formatNumber(t.min)}+ → Bonus ${t.bonus}`; });
  await bot.sendMessage(chatId, `💎 *Tích Lũy Nạp*\n\nTổng nạp của bạn: *${formatNumber(total)}*\nHạng hiện tại: bonus *${current.bonus}*\n\n${lines.join("\n")}${next ? `\n\nCòn ${formatNumber(next.min - total)} để lên hạng tiếp!` : "\n\n🏆 Bạn đã đạt hạng cao nhất!"}`, { parse_mode: "Markdown", ...mainMenuKeyboard() });
}

function isPrivate(msg: TelegramBot.Message) { return msg.chat.type === "private"; }

// ─── Admin Functions ──────────────────────────────────────────────────────────
async function requireAdmin(msg: TelegramBot.Message) {
  if (!isAdmin(msg.from!.id)) { await bot.sendMessage(msg.chat.id, "❌ Bạn không có quyền sử dụng lệnh này!"); return false; }
  return true;
}

async function sendAdminStats(chatId: number) {
  const totalUsers = (db.prepare("SELECT COUNT(*) as c FROM users").get() as any).c;
  const blockedUsers = (db.prepare("SELECT COUNT(*) as c FROM users WHERE is_blocked = 1").get() as any).c;
  const totalDeposit = (db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type='deposit'").get() as any).s;
  const totalWithdraw = (db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type='withdraw'").get() as any).s;
  const totalBet = (db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type='bet'").get() as any).s;
  const totalWin = (db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM transactions WHERE type='win'").get() as any).s;
  const totalSessions = (db.prepare("SELECT COUNT(*) as c FROM game_sessions WHERE status='done'").get() as any).c;
  const activeGifts = (db.prepare("SELECT COUNT(*) as c FROM giftcodes WHERE is_active=1").get() as any).c;
  const todayTx = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE date(created_at)=date('now')").get() as any).c;
  const totalBalance = (db.prepare("SELECT COALESCE(SUM(balance),0) as s FROM users").get() as any).s;
  await bot.sendMessage(chatId,
    `📊 *THỐNG KÊ HỆ THỐNG*\n\n👥 Tổng user: *${formatNumber(totalUsers)}* (bị khóa: ${blockedUsers})\n💰 Tổng số dư hệ thống: *${formatNumber(totalBalance)}*\n\n📥 Tổng nạp: *${formatNumber(totalDeposit)}*\n📤 Tổng rút: *${formatNumber(totalWithdraw)}*\n🎮 Tổng cược: *${formatNumber(totalBet)}*\n🏆 Tổng trả thưởng: *${formatNumber(totalWin)}*\n📈 Lợi nhuận nhà cái: *${formatNumber(totalBet - totalWin)}*\n\n🎲 Tổng phiên game: *${formatNumber(totalSessions)}*\n🎁 Giftcode đang hoạt động: *${activeGifts}*\n📋 Giao dịch hôm nay: *${todayTx}*`,
    { parse_mode: "Markdown", reply_markup: adminMenuKeyboard() }
  );
}

async function sendAdminUserList(chatId: number, page = 1) {
  const limit = 10;
  const offset = (page - 1) * limit;
  const total = (db.prepare("SELECT COUNT(*) as c FROM users").get() as any).c;
  const users = db.prepare("SELECT * FROM users ORDER BY id DESC LIMIT ? OFFSET ?").all(limit, offset) as any[];
  const totalPages = Math.ceil(total / limit);
  if (users.length === 0) { await bot.sendMessage(chatId, "👥 Chưa có người dùng nào."); return; }
  const lines = users.map((u) => `${u.is_blocked ? "🔒" : "✅"} ID:${u.id} | ${u.first_name ?? "Ẩn danh"}${u.username ? ` (@${u.username})` : ""} | 💰${formatNumber(u.balance)} | VIP${u.vip_level}`);
  const navButtons: any[] = [];
  if (page > 1) navButtons.push({ text: "◀ Trước", callback_data: `adm_users_${page - 1}` });
  if (page < totalPages) navButtons.push({ text: "Sau ▶", callback_data: `adm_users_${page + 1}` });
  const keyboard: any = { inline_keyboard: [] };
  if (navButtons.length > 0) keyboard.inline_keyboard.push(navButtons);
  keyboard.inline_keyboard.push([{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]);
  await bot.sendMessage(chatId, `👥 DANH SÁCH USER (Trang ${page}/${totalPages})\n\n${lines.join("\n")}`, { reply_markup: keyboard });
}

async function sendAdminUserInfo(chatId: number, targetId: number, editMessageId?: number) {
  const user = getUserById(targetId);
  if (!user) { await bot.sendMessage(chatId, `❌ Không tìm thấy user ID: ${targetId}`); return; }
  const txCount = (db.prepare("SELECT COUNT(*) as c FROM transactions WHERE user_id=?").get(user.id) as any).c;
  const betCount = (db.prepare("SELECT COUNT(*) as c FROM game_bets WHERE user_id=?").get(user.id) as any).c;
  const winCount = (db.prepare("SELECT COUNT(*) as c FROM game_bets WHERE user_id=? AND is_win=1").get(user.id) as any).c;
  const text = `🔍 *THÔNG TIN USER*\n\n📌 ID nội bộ: *${user.id}*\n🆔 Telegram ID: *${user.telegram_id}*\n👤 Tên: ${user.first_name ?? "—"}\n📛 Username: ${user.username ? "@" + user.username : "—"}\n${user.is_blocked ? "🔒 *ĐANG BỊ KHÓA*" : "✅ Đang hoạt động"}\n\n💰 Số dư: *${formatNumber(user.balance)}*\n👑 VIP: ${vipLabel(user.vip_level)}\n📥 Tổng nạp: ${formatNumber(user.total_deposit)}\n📤 Tổng rút: ${formatNumber(user.total_withdraw)}\n🎮 Tổng cược: ${formatNumber(user.total_bet)}\n💱 Phí rút: ${user.withdraw_fee_pct}%\n\n🏦 Ngân hàng: ${user.bank_name ?? "—"}\n💳 STK: ${user.bank_account ?? "—"}\n👤 Chủ TK: ${user.bank_owner ?? "—"}\n\n📋 Tổng giao dịch: ${txCount}\n🎲 Tổng lượt cược: ${betCount} (thắng: ${winCount})\n📅 Tham gia: ${user.created_at}\n\n_Cập nhật: ${new Date().toLocaleString("vi-VN")}_`;
  const keyboard = {
    inline_keyboard: [
      [{ text: user.is_blocked ? "🔓 Mở khóa" : "🔒 Khóa", callback_data: user.is_blocked ? `adm_unblock_${user.id}` : `adm_block_${user.id}` }, { text: "💰 Nạp tiền", callback_data: `adm_addbal_ask_${user.id}` }],
      [{ text: "💸 Trừ tiền", callback_data: `adm_subbal_ask_${user.id}` }, { text: "📋 Lịch sử TX", callback_data: `adm_usertx_${user.id}` }],
      [{ text: "🔄 Làm mới", callback_data: `adm_user_refresh_${user.id}` }, { text: "❌ Tắt", callback_data: "adm_close" }],
      [{ text: "🔙 Menu Admin", callback_data: "adm_menu" }],
    ],
  };
  if (editMessageId) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, parse_mode: "Markdown", reply_markup: keyboard });
      return;
    } catch (e: any) {
      if (!String(e?.message ?? "").includes("message is not modified")) {
        console.error(e.message);
      } else {
        return;
      }
    }
  }
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: keyboard });
}

async function sendAdminUserTx(chatId: number, userId: number) {
  const user = getUserById(userId);
  if (!user) { await bot.sendMessage(chatId, `❌ Không tìm thấy user ID: ${userId}`); return; }
  const rows = db.prepare("SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 15").all(user.id) as any[];
  if (rows.length === 0) { await bot.sendMessage(chatId, `📋 User ID ${userId} chưa có giao dịch nào.`); return; }
  const typeLabel: any = { deposit: "💰Nạp", withdraw: "💸Rút", transfer_in: "📥Nhận", transfer_out: "📤Chuyển", bet: "🎮Cược", win: "🏆Thắng", gift: "🎁Gift", checkin: "✅Điểm danh" };
  const inTypes = ["deposit", "transfer_in", "win", "gift", "checkin"];
  const lines = rows.map((r) => { const sign = inTypes.includes(r.type) ? "+" : "-"; const date = r.created_at.slice(0, 16); return `${typeLabel[r.type] ?? r.type} ${sign}${formatNumber(r.amount)} → ${formatNumber(r.balance_after)} [${date}]`; });
  await bot.sendMessage(chatId, `📋 *Lịch sử TX – User ID ${userId}* (${user.first_name ?? "Ẩn danh"})\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
}

async function sendAdminGiftList(chatId: number, editMessageId?: number) {
  const gifts = db.prepare("SELECT * FROM giftcodes ORDER BY id DESC LIMIT 20").all() as any[];
  if (gifts.length === 0) {
    const empty = { text: "🎁 Chưa có giftcode nào.", kb: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } };
    if (editMessageId) { try { await bot.editMessageText(empty.text, { chat_id: chatId, message_id: editMessageId, reply_markup: empty.kb }); return; } catch {} }
    await bot.sendMessage(chatId, empty.text, { reply_markup: empty.kb }); return;
  }
  const lines = gifts.map((g) => { const status = !g.is_active ? "❌Tắt" : g.used_count >= g.max_uses ? "🔴Hết" : "✅Hoạt động"; const exp = g.expires_at ? ` | hết:${g.expires_at.slice(0, 10)}` : ""; return `${status} *${g.code}* | ${formatNumber(g.amount)} | ${g.used_count}/${g.max_uses}${exp}`; });
  const text = `🎁 *DANH SÁCH GIFTCODE* (20 gần nhất)\n\n${lines.join("\n")}`;
  const rows: any[][] = [];
  const activeGifts = gifts.filter((g) => g.is_active);
  for (let i = 0; i < activeGifts.length; i += 2) {
    const row = activeGifts.slice(i, i + 2).map((g) => ({ text: `❌ Tắt ${g.code}`, callback_data: `adm_gift_off_${g.id}` }));
    rows.push(row);
  }
  rows.push([{ text: "🔄 Làm mới", callback_data: "adm_listgifts_refresh" }, { text: "🔙 Menu Admin", callback_data: "adm_menu" }]);
  const kb = { inline_keyboard: rows };
  if (editMessageId) {
    try { await bot.editMessageText(text, { chat_id: chatId, message_id: editMessageId, parse_mode: "Markdown", reply_markup: kb }); return; }
    catch (e: any) { if (String(e?.message ?? "").includes("message is not modified")) return; }
  }
  await bot.sendMessage(chatId, text, { parse_mode: "Markdown", reply_markup: kb });
}

async function sendAdminGameSessions(chatId: number) {
  const sessions = db.prepare("SELECT * FROM game_sessions ORDER BY id DESC LIMIT 10").all() as any[];
  if (sessions.length === 0) { await bot.sendMessage(chatId, "🎲 Chưa có phiên game nào."); return; }
  const lines = sessions.map((s) => {
    if (s.status !== "done" || s.dice1 == null) return `#${s.session_number} | Đang chạy`;
    const result = `${s.dice1}-${s.dice2}-${s.dice3}=${s.total} ${s.result_tai ? "TÀI" : "XỈU"} ${s.result_chan ? "CHẴN" : "LẺ"}`;
    return `#${s.session_number} | ${result} | ${s.ended_at?.slice(0, 16)}`;
  });
  await bot.sendMessage(chatId, `🎲 *10 PHIÊN GAME GẦN NHẤT*\n\n${lines.join("\n")}`, { parse_mode: "Markdown", reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } });
}

// ─── startBot ─────────────────────────────────────────────────────────────────
export function startBot(): TelegramBot | null {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) { logger.warn("TELEGRAM_BOT_TOKEN không được cấu hình, bỏ qua khởi động bot"); return null; }

  bot = new TelegramBot(token, { polling: true });
  setBotInstance(bot);
  logger.info("Bot Telegram QN88.FUN đã khởi động (polling)");

  // ── Tự động in đậm toàn bộ tin nhắn ──
  const _origSend = bot.sendMessage.bind(bot);
  const _origEdit = bot.editMessageText.bind(bot);
  const mdToHtml = (text: string) =>
    text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
      .replace(/_([^_\n]+)_/g, "<i>$1</i>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const boldWrap = (text: string, mode?: string): [string, string] => {
    if (mode === "HTML") return [`<b>${text}</b>`, "HTML"];
    if (mode === "Markdown" || mode === "MarkdownV2") return [`<b>${mdToHtml(text)}</b>`, "HTML"];
    return [`<b>${text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</b>`, "HTML"];
  };
  (bot as any).sendMessage = (chatId: any, text: string, opts?: any) => {
    if (opts?.noBold) { const { noBold: _, ...rest } = opts; return _origSend(chatId, text, rest); }
    const [newText, newMode] = boldWrap(text, opts?.parse_mode);
    return _origSend(chatId, newText, { ...opts, parse_mode: newMode });
  };
  (bot as any).editMessageText = (text: string, opts?: any) => {
    if (opts?.noBold) { const { noBold: _, ...rest } = opts; return _origEdit(text, rest); }
    const [newText, newMode] = boldWrap(text, opts?.parse_mode);
    return _origEdit(newText, { ...opts, parse_mode: newMode });
  };

  bot.getMe().then(me => { BOT_USERNAME = me.username || ""; }).catch(() => {});

  // Tìm phiên đang chạy: nếu nhắn trong nhóm thì lấy chatId nhóm,
  // nếu nhắn chat riêng thì tìm trong toàn bộ activeSessions
  const findActiveSession = (msgChatId: number): { groupChatId: number; session: NonNullable<ReturnType<typeof activeSessions.get>> } | null => {
    const direct = activeSessions.get(msgChatId);
    if (direct) return { groupChatId: msgChatId, session: direct };
    for (const [gid, s] of activeSessions.entries()) {
      return { groupChatId: gid, session: s };
    }
    return null;
  };

  // ── /chinh (admin force dice) ──
  bot.onText(/^\/chinh(?:@\S+)?\s+(\d)\s+(\d)\s+(\d)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from!.id;
    if (!isAdmin(telegramId)) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }
    const d1 = parseInt(match![1]);
    const d2 = parseInt(match![2]);
    const d3 = parseInt(match![3]);
    if ([d1, d2, d3].some(d => d < 1 || d > 6)) {
      try { await bot.sendMessage(chatId, "❌ Mỗi xúc xắc phải từ 1 đến 6!", { reply_to_message_id: msg.message_id }); } catch {}
      return;
    }
    const found = findActiveSession(chatId);
    if (!found) {
      try { await bot.sendMessage(chatId, "❌ Không có phiên nào đang chạy!", { reply_to_message_id: msg.message_id }); } catch {}
      return;
    }
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    await endSession(found.groupChatId, found.session.sessionId, [d1, d2, d3]);
  });

  // ── /chinh3 (admin force chỉ con xúc xắc thứ 3) ──
  bot.onText(/^\/chinh3(?:@\S+)?\s+(\d)$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from!.id;
    if (!isAdmin(telegramId)) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }
    const d3 = parseInt(match![1]);
    if (d3 < 1 || d3 > 6) {
      try { await bot.sendMessage(chatId, "❌ Xúc xắc phải từ 1 đến 6!", { reply_to_message_id: msg.message_id }); } catch {}
      return;
    }
    const found = findActiveSession(chatId);
    if (!found) {
      try { await bot.sendMessage(chatId, "❌ Không có phiên nào đang chạy!", { reply_to_message_id: msg.message_id }); } catch {}
      return;
    }
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    await endSession(found.groupChatId, found.session.sessionId, [undefined, undefined, d3]);
  });

  // ── /doiphientieptheo (đặt trước kết quả cho phiên tiếp theo) ──
  // Dùng chat riêng với bot: /doiphientieptheo 5       → d3=5, d1&d2 ngẫu nhiên
  //                          /doiphientieptheo 1 2 3   → d1=1, d2=2, d3=3
  bot.onText(/^\/doiphientieptheo(?:@\S+)?(?:\s+(\d)(?:\s+(\d)\s+(\d))?)?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from!.id;
    if (!isAdmin(telegramId)) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

    // tìm nhóm đang chạy hoặc sẽ chạy
    let groupChatId: number | null = null;
    const direct = activeSessions.get(chatId);
    if (direct) { groupChatId = chatId; }
    else {
      for (const gid of activeSessions.keys()) { groupChatId = gid; break; }
    }
    // nếu không tìm thấy nhóm active, thử lấy từ enabledGroups
    if (!groupChatId) {
      for (const gid of enabledGroups) { groupChatId = gid; break; }
    }
    if (!groupChatId) {
      try { await bot.sendMessage(chatId, "❌ Không tìm thấy nhóm đang chạy!"); } catch {}
      return;
    }

    let preset: [number|undefined, number|undefined, number|undefined];
    if (match![3]) {
      // 3 số: d1 d2 d3
      const a = parseInt(match![1]), b = parseInt(match![2]), c = parseInt(match![3]);
      if ([a,b,c].some(d => d < 1 || d > 6)) {
        try { await bot.sendMessage(chatId, "❌ Mỗi xúc xắc phải từ 1 đến 6!"); } catch {}
        return;
      }
      preset = [a, b, c];
    } else if (match![1]) {
      // 1 số: chỉ đặt d3
      const c = parseInt(match![1]);
      if (c < 1 || c > 6) {
        try { await bot.sendMessage(chatId, "❌ Xúc xắc phải từ 1 đến 6!"); } catch {}
        return;
      }
      preset = [undefined, undefined, c];
    } else {
      // không có số → xóa preset
      pendingForceDice.delete(groupChatId);
      try { await bot.sendMessage(chatId, "✅ Đã hủy preset phiên tiếp theo."); } catch {}
      return;
    }

    pendingForceDice.set(groupChatId, preset);
    const desc = preset.map((v, i) => v !== undefined ? `Con ${i+1}: ${v}` : `Con ${i+1}: ngẫu nhiên`).join(" | ");
    try { await bot.sendMessage(chatId, `✅ Đã đặt trước cho phiên tiếp theo:\n${desc}`); } catch {}
  });

  // ── /xempreset ──
  bot.onText(/^\/xempreset(?:@\S+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from!.id;
    if (!isAdmin(telegramId)) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    // tìm nhóm
    let groupChatId: number | null = null;
    if (activeSessions.has(chatId)) groupChatId = chatId;
    else { for (const gid of activeSessions.keys()) { groupChatId = gid; break; } }
    if (!groupChatId) { for (const gid of enabledGroups) { groupChatId = gid; break; } }

    if (!groupChatId || !pendingForceDice.has(groupChatId)) {
      try { await bot.sendMessage(chatId, "ℹ️ Không có preset nào đang chờ."); } catch {}
      return;
    }
    const preset = pendingForceDice.get(groupChatId)!;
    const desc = preset.map((v, i) => v !== undefined ? `Con ${i+1}: *${v}*` : `Con ${i+1}: ngẫu nhiên`).join("\n");
    try { await bot.sendMessage(chatId, `🎲 *Preset phiên tiếp theo:*\n${desc}`, { parse_mode: "Markdown" }); } catch {}
  });

  // ── /hoancuoc [YYYY-MM-DD] (admin gửi lại hoàn cược cho người chơi) ──
  bot.onText(/^\/hoancuoc(?:@\S+)?(?:\s+(\d{4}-\d{2}-\d{2}))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from!.id;
    if (!isAdmin(telegramId)) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    const targetDate = match![1] || undefined;
    const dateLabel = targetDate ?? "hôm qua";
    try { await bot.sendMessage(chatId, `⏳ Đang gửi hoàn cược ngày *${dateLabel}*...`, { parse_mode: "Markdown" }); } catch {}
    await sendDailyCashbacks(targetDate);
    try { await bot.sendMessage(chatId, `✅ Đã gửi xong hoàn cược ngày *${dateLabel}*.`, { parse_mode: "Markdown" }); } catch {}
  });

  // ── helper dùng chung cho /doi1, /doi2, /doi3 ──
  const handleDoi = async (msg: any, diceIndex: 0 | 1 | 2, newVal: number) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from!.id;
    if (!isAdmin(telegramId)) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      return;
    }
    if (newVal < 1 || newVal > 6) {
      try { await bot.sendMessage(chatId, "❌ Xúc xắc phải từ 1 đến 6!", { reply_to_message_id: msg.message_id }); } catch {}
      return;
    }

    // Nếu đang có phiên chạy → kết thúc ngay với con preset, không animation
    const activeFound = findActiveSession(chatId);
    if (activeFound) {
      try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
      const force: [number|undefined, number|undefined, number|undefined] = [undefined, undefined, undefined];
      force[diceIndex] = newVal;
      await endSession(activeFound.groupChatId, activeFound.session.sessionId, force);
      return;
    }

    // Không có phiên → edit tin kết quả phiên vừa rồi
    let groupChatId: number | null = null;
    let diceData: { msgIds: [number, number, number]; vals: [number, number, number] } | null = null;
    if (lastDiceData.has(chatId)) {
      groupChatId = chatId; diceData = lastDiceData.get(chatId)!;
    } else {
      for (const [gid, d] of lastDiceData.entries()) { groupChatId = gid; diceData = d; break; }
    }
    if (!groupChatId || !diceData) {
      try { await bot.sendMessage(chatId, "❌ Không tìm thấy dữ liệu phiên gần nhất!", { reply_to_message_id: msg.message_id }); } catch {}
      return;
    }
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
    try { await bot.deleteMessage(groupChatId, diceData.msgIds[diceIndex]); } catch {}
    const vals: [number, number, number] = [...diceData.vals] as [number, number, number];
    vals[diceIndex] = newVal;
    const [d1, d2, d3] = vals;
    const total = d1 + d2 + d3;
    const isTriple = d1 === d2 && d2 === d3;
    const isTai = total >= 11;
    const isChan = total % 2 === 0;
    let resultLabel: string;
    let resultColorEmojis: string;
    if (isTriple) {
      resultLabel = `BA CÁI (${d1}-${d2}-${d3}) = ${total}`;
      resultColorEmojis = `⚡⚡`;
    } else {
      resultLabel = `${isTai ? "TÀI" : "XỈU"} ${isChan ? "CHẴN" : "LẺ"}`;
      resultColorEmojis = `${isTai ? "🔵" : "🔴"} ${isChan ? "⚪️" : "⚫️"}`;
    }
    const newResultMsg =
      `<b>Kết quả phiên #${diceData.sessionNumber}</b>\n` +
      `┏━━━━━━━━━━━━┓\n` +
      `┃  <b>${d1}  ${d2}  ${d3}</b>  👉 <b>${resultLabel} ${resultColorEmojis}</b>\n┃\n` +
      `┃ Tổng thắng: <b>${formatNumber(diceData.totalWinPayout)}</b>\n` +
      `┃ Tổng thua: <b>${formatNumber(diceData.totalLossBet)}</b>\n` +
      `┃ Cộng hũ  : <b>+${formatNumber(diceData.huContrib)}</b>\n` +
      `┃ Hũ hiện tại: <b>${formatNumber(jackpotAmount)}</b>\n` +
      `┗━━━━━━━━━━━━┛`;
    try {
      await bot.editMessageText(newResultMsg + diceData.historyHtml, {
        chat_id: groupChatId,
        message_id: diceData.resultMsgId,
        parse_mode: "HTML",
        ...(diceData.resultKeyboard ? { reply_markup: diceData.resultKeyboard } : {}),
      });
    } catch {}
    lastDiceData.set(groupChatId, { ...diceData, vals });
  };

  // ── /doi1 ──
  bot.onText(/^\/doi1(?:@\S+)?\s+(\d)$/, async (msg, match) => {
    await handleDoi(msg, 0, parseInt(match![1]));
  });

  // ── /doi2 ──
  bot.onText(/^\/doi2(?:@\S+)?\s+(\d)$/, async (msg, match) => {
    await handleDoi(msg, 1, parseInt(match![1]));
  });

  // ── /doi3 ──
  bot.onText(/^\/doi3(?:@\S+)?\s+(\d)$/, async (msg, match) => {
    await handleDoi(msg, 2, parseInt(match![1]));
  });

  // ── /start ──
  bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const telegramId = msg.from!.id;
      const isNew = !getUserByTelegramId(telegramId);
      const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
      const refArg = match?.[1]?.trim();
      if (isNew && refArg && /^\d+$/.test(refArg)) {
        const refTelegramId = parseInt(refArg);
        if (refTelegramId !== telegramId) {
          const refUser = getUserByTelegramId(refTelegramId);
          if (refUser && !user.referrer_id) {
            db.prepare("UPDATE users SET referrer_id=? WHERE id=?").run(refUser.id, user.id);
            // Thông báo cho người giới thiệu
            const newName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || msg.from?.username || "Ẩn danh";
            const refererTgId = refUser.telegram_id;
            try {
              await bot.sendMessage(
                refererTgId,
                `🎉 *Có người tham gia qua link giới thiệu của bạn!*\n\n` +
                `👤 Tên: *${newName}*\n` +
                `🆔 Telegram ID: \`${telegramId}\`\n\n` +
                `💰 Bạn sẽ nhận hoa hồng mỗi khi họ nạp & đặt cược!`,
                { parse_mode: "Markdown" }
              );
            } catch {}
          }
        }
      }
      if (!isPrivate(msg)) return;
      resetState(telegramId);
      if (user.is_blocked) {
        await bot.sendMessage(chatId, `🔒 Tài khoản của bạn đã bị khóa.\nLiên hệ admin ${SUPPORT_ADMIN} để được hỗ trợ.`);
        return;
      }
      const welcomeBonus = isNew ? `\n\n🎁 Bạn vừa nhận được *${formatNumber(SIGNUP_BONUS)}* tiền thưởng đăng ký!` : "";
      await bot.sendMessage(chatId,
        `🎰 Chào mừng đến với ${BOT_NAME}!${welcomeBonus}\n\nNhấn 🏦 Tài Khoản để xem thông tin tài khoản của bạn.\nROOM TÀI XỈU SĂN HŨ https://t.me/hq88room`,
        { parse_mode: "Markdown", ...mainMenuKeyboard() }
      );
    } catch (e) { console.error(e); }
  });

  // ── /taikhoan ──
  bot.onText(/\/taikhoan/, async (msg) => {
    try {
      if (!isPrivate(msg)) return;
      getOrCreateUser(msg.from!.id, msg.from?.first_name, msg.from?.username);
      resetState(msg.from!.id);
      await sendAccountInfo(msg.chat.id, msg.from!.id);
    } catch (e) { console.error(e); }
  });

  // ── /sd ──
  bot.onText(/\/sd/, async (msg) => {
    try {
      const user = getOrCreateUser(msg.from!.id, msg.from?.first_name, msg.from?.username);
      await bot.sendMessage(msg.chat.id, `${vipEmoji(user.vip_level)} Số dư hiện tại: ${formatNumber(user.balance)}`, { reply_to_message_id: msg.message_id });
    } catch (e) { console.error(e); }
  });

  // ── /admin ──
  bot.onText(/\/admin/, async (msg) => {
    try {
      if (!isPrivate(msg)) return;
      if (!await requireAdmin(msg)) return;
      await bot.sendMessage(msg.chat.id, `🛡️ *ADMIN PANEL*\n\nXin chào Admin! Chọn chức năng:`, { parse_mode: "Markdown", reply_markup: adminMenuKeyboard() });
    } catch (e) { console.error(e); }
  });

  // ── /block /unblock ──
  bot.onText(/\/block (\d+)/, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const targetId = parseInt(match![1]);
      const user = getUserById(targetId);
      if (!user) { await bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user ID: ${targetId}`); return; }
      db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").run(targetId);
      await bot.sendMessage(msg.chat.id, `🔒 Đã khóa user ID ${targetId} (${user.first_name ?? user.username ?? "Ẩn danh"}).`);
      try { await bot.sendMessage(user.telegram_id, "🔒 Tài khoản của bạn đã bị khóa. Liên hệ admin để được hỗ trợ."); } catch {}
    } catch (e) { console.error(e); }
  });

  bot.onText(/\/unblock (\d+)/, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const targetId = parseInt(match![1]);
      const user = getUserById(targetId);
      if (!user) { await bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user ID: ${targetId}`); return; }
      db.prepare("UPDATE users SET is_blocked = 0 WHERE id = ?").run(targetId);
      await bot.sendMessage(msg.chat.id, `🔓 Đã mở khóa user ID ${targetId} (${user.first_name ?? user.username ?? "Ẩn danh"}).`);
      try { await bot.sendMessage(user.telegram_id, "✅ Tài khoản của bạn đã được mở khóa. Chúc bạn chơi vui!"); } catch {}
    } catch (e) { console.error(e); }
  });

  // ── /addbalance /subbalance ──
  bot.onText(/\/addbalance (\d+) (\d+)/, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const targetId = parseInt(match![1]); const amount = parseInt(match![2]);
      const user = getUserById(targetId);
      if (!user) { await bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user ID: ${targetId}`); return; }
      const newBal = user.balance + amount;
      db.prepare("UPDATE users SET balance = ?, total_deposit = ? WHERE id = ?").run(newBal, user.total_deposit + amount, user.id);
      recordTransaction({ userId: user.id, type: "deposit", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: "Nạp tiền (admin)" });
      updateVipLevel({ ...user, total_deposit: user.total_deposit + amount });
      await bot.sendMessage(msg.chat.id, `✅ Đã nạp ${formatNumber(amount)} cho user ID ${targetId}. Số dư mới: ${formatNumber(newBal)}`);
      try { await bot.sendMessage(user.telegram_id, `💰 Tài khoản được nạp ${formatNumber(amount)}. Số dư: ${formatNumber(newBal)}`); } catch {}
    } catch (e) { console.error(e); }
  });

  bot.onText(/\/subbalance (\d+) (\d+)/, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const targetId = parseInt(match![1]); const amount = parseInt(match![2]);
      const user = getUserById(targetId);
      if (!user) { await bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user ID: ${targetId}`); return; }
      if (user.balance < amount) { await bot.sendMessage(msg.chat.id, `❌ Số dư user chỉ có ${formatNumber(user.balance)}, không đủ để trừ ${formatNumber(amount)}.`); return; }
      const newBal = user.balance - amount;
      db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, user.id);
      recordTransaction({ userId: user.id, type: "withdraw", amount, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: "Trừ tiền (admin)" });
      await bot.sendMessage(msg.chat.id, `✅ Đã trừ ${formatNumber(amount)} khỏi user ID ${targetId}. Số dư mới: ${formatNumber(newBal)}`);
      try { await bot.sendMessage(user.telegram_id, `⚠️ Tài khoản bị trừ ${formatNumber(amount)}. Số dư: ${formatNumber(newBal)}.`); } catch {}
    } catch (e) { console.error(e); }
  });

  // ── /userinfo /usertx ──
  bot.onText(/\/userinfo (\d+)/, async (msg, match) => {
    try { if (!isPrivate(msg) || !await requireAdmin(msg)) return; await sendAdminUserInfo(msg.chat.id, parseInt(match![1])); } catch (e) { console.error(e); }
  });

  bot.onText(/\/usertx (\d+)/, async (msg, match) => {
    try { if (!isPrivate(msg) || !await requireAdmin(msg)) return; await sendAdminUserTx(msg.chat.id, parseInt(match![1])); } catch (e) { console.error(e); }
  });

  // ── /setfee /delgift /listgifts /stats /broadcast ──
  bot.onText(/\/setfee (\d+) ([\d.]+)/, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const targetId = parseInt(match![1]); const pct = parseFloat(match![2]);
      const user = getUserById(targetId);
      if (!user) { await bot.sendMessage(msg.chat.id, `❌ Không tìm thấy user ID: ${targetId}`); return; }
      db.prepare("UPDATE users SET withdraw_fee_pct = ? WHERE id = ?").run(pct, user.id);
      await bot.sendMessage(msg.chat.id, `✅ Đã đặt phí rút của user ID ${targetId} thành *${pct}%*`, { parse_mode: "Markdown" });
    } catch (e) { console.error(e); }
  });

  bot.onText(/\/delgift (\S+)/, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const code = match![1].toUpperCase();
      const gift = db.prepare("SELECT * FROM giftcodes WHERE code = ?").get(code);
      if (!gift) { await bot.sendMessage(msg.chat.id, `❌ Không tìm thấy giftcode: ${code}`); return; }
      db.prepare("UPDATE giftcodes SET is_active = 0 WHERE code = ?").run(code);
      await bot.sendMessage(msg.chat.id, `✅ Đã vô hiệu hóa giftcode *${code}*.`, { parse_mode: "Markdown" });
    } catch (e) { console.error(e); }
  });

  bot.onText(/\/listgifts/, async (msg) => {
    try { if (!isPrivate(msg) || !await requireAdmin(msg)) return; await sendAdminGiftList(msg.chat.id); } catch (e) { console.error(e); }
  });

  bot.onText(/\/stats/, async (msg) => {
    try { if (!isPrivate(msg) || !await requireAdmin(msg)) return; await sendAdminStats(msg.chat.id); } catch (e) { console.error(e); }
  });

  bot.onText(/\/broadcast (.+)/s, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const text = match![1];
      const users = db.prepare("SELECT telegram_id FROM users WHERE is_blocked = 0").all() as any[];
      let sent = 0, failed = 0;
      await bot.sendMessage(msg.chat.id, `📣 Đang gửi thông báo đến ${users.length} user...`);
      for (const u of users) {
        try { await bot.sendMessage(u.telegram_id, `📣 *THÔNG BÁO TỪ HỆ THỐNG*\n\n${text}`, { parse_mode: "Markdown" }); sent++; } catch { failed++; }
        await sleep(50);
      }
      await bot.sendMessage(msg.chat.id, `✅ Đã gửi: ${sent} | ❌ Thất bại: ${failed}`);
    } catch (e) { console.error(e); }
  });

  // ── /setlichsu – cài group lịch sử phiên ──
  bot.onText(/^\/setlichsu(?:@\S+)?$/, async (msg) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      setState(msg.from!.id, { step: "adm_set_lichsu" });
      await bot.sendMessage(msg.chat.id,
        `📋 *Cài group lịch sử phiên*\n\nChuyển bot vào group lịch sử, dùng lệnh /getid trong đó để lấy ID, rồi gửi ID vào đây:\n\n_(VD: -1001234567890)_`,
        { parse_mode: "Markdown" }
      );
    } catch (e) { console.error(e); }
  });

  bot.onText(/^\/xoalichsu(?:@\S+)?$/, async (msg) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      historyChannelId = null;
      db.prepare("DELETE FROM bot_settings WHERE key='history_channel_id'").run();
      await bot.sendMessage(msg.chat.id, "✅ Đã xóa group lịch sử phiên.");
    } catch (e) { console.error(e); }
  });

  bot.onText(/^\/getid(?:@\S+)?$/, async (msg) => {
    try {
      await bot.sendMessage(msg.chat.id, `🆔 Chat ID: \`${msg.chat.id}\``, { parse_mode: "Markdown" });
    } catch {}
  });

  // ── daythang / daythua trong group ──
  const maskId = (tid: number) => {
    const s = String(tid);
    return "****" + s.slice(-5);
  };

  const sendStreakTop = async (msg: TelegramBot.Message, type: "thang" | "thua") => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    if (isPrivate(msg)) return;
    try { await bot.deleteMessage(chatId, msg.message_id); } catch {}

    const col = type === "thang" ? "win_streak" : "lose_streak";
    const label = type === "thang" ? "THẮNG" : "THUA";
    const icon = type === "thang" ? "✅" : "❌";
    const limit = 3;
    const rows = db.prepare(
      `SELECT telegram_id, ${col} as streak FROM users WHERE ${col} > 0 ORDER BY ${col} DESC LIMIT ${limit}`
    ).all() as any[];

    if (rows.length === 0) {
      await bot.sendMessage(chatId, `${icon} Chưa có ai có dây ${label} hôm nay.`);
      return;
    }

    const myRow = rows.findIndex((r) => r.telegram_id === telegramId);
    const lines = rows.map((r, i) => `Top ${i + 1}: ${maskId(r.telegram_id)}  |  ${r.streak} trận`);
    const myNote = myRow >= 0
      ? `\nThứ hạng của bạn: Top ${myRow + 1} 👏`
      : `\n😭 Bạn không có xếp hạng trong top này`;

    await bot.sendMessage(chatId,
      `${icon} Top dây ${label} hôm nay (tính tới hiện tại)\n\n${lines.join("\n")}${myNote}`,
      { noBold: true } as any
    );
  };

  bot.onText(/^\/daythang(?:@\S+)?$/i, async (msg) => { await sendStreakTop(msg, "thang"); });
  bot.onText(/^\/daythua(?:@\S+)?$/i, async (msg) => { await sendStreakTop(msg, "thua"); });

  bot.onText(/\/addgiftcode (\S+) (\d+)(?: (\d+))?/, async (msg, match) => {
    try {
      if (!isPrivate(msg) || !await requireAdmin(msg)) return;
      const code = match![1].toUpperCase(); const amount = parseInt(match![2]); const maxUses = parseInt(match![3] ?? "1");
      try {
        db.prepare("INSERT INTO giftcodes (code, amount, max_uses) VALUES (?, ?, ?)").run(code, amount, maxUses);
        await bot.sendMessage(msg.chat.id, `✅ Đã tạo giftcode *${code}* – ${formatNumber(amount)} – tối đa ${maxUses} lần.`, { parse_mode: "Markdown" });
      } catch { await bot.sendMessage(msg.chat.id, `❌ Giftcode *${code}* đã tồn tại.`, { parse_mode: "Markdown" }); }
    } catch (e) { console.error(e); }
  });

  // ── /batdau /dunggame ──
  bot.onText(/\/batdau/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      if (msg.chat.type === "private") { await bot.sendMessage(chatId, "❗ Lệnh này chỉ dùng trong nhóm."); return; }
      if (!isAdmin(msg.from!.id)) {
        try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
        return;
      }
      if (enabledGroups.has(chatId)) { await bot.sendMessage(chatId, "✅ Game tài xỉu đang chạy trong nhóm này rồi!"); return; }
      enabledGroups.add(chatId);
      db.prepare("INSERT OR IGNORE INTO group_game_enabled (chat_id) VALUES (?)").run(chatId);
      await bot.sendMessage(chatId, `🎲 *Game Tài Xỉu đã được bật!*\n\nCách đặt cược:\n\`T/Tai 10000\` — Đặt Tài\n\`X/Xiu 10000\` — Đặt Xỉu\n\`C/Chan 10000\` — Đặt Chẵn\n\`L/Le 10000\` — Đặt Lẻ\n\nCược tất tay: \`T max\` / \`X max\` / \`C max\` / \`L max\`\n\nPhiên mới sẽ bắt đầu ngay!`, { parse_mode: "Markdown" });
      await startSession(chatId, true);
    } catch (e) { console.error(e); }
  });

  bot.onText(/\/dunggame/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      if (msg.chat.type === "private") { await bot.sendMessage(chatId, "❗ Lệnh này chỉ dùng trong nhóm."); return; }
      if (!isAdmin(msg.from!.id)) {
        try { await bot.deleteMessage(chatId, msg.message_id); } catch {}
        return;
      }
      enabledGroups.delete(chatId);
      db.prepare("DELETE FROM group_game_enabled WHERE chat_id = ?").run(chatId);
      const session = activeSessions.get(chatId);
      if (session) { session.timers.forEach(clearTimeout); activeSessions.delete(chatId); }
      await bot.sendMessage(chatId, "🛑 Game tài xỉu đã dừng. Gõ /batdau để bật lại.");
    } catch (e) { console.error(e); }
  });

  // ── /doichedo – đổi chế độ XX game ──
  bot.onText(/^\/doichedo(?:@\S+)?$/i, async (msg) => {
    try {
      if (!isPrivate(msg)) return;
      const telegramId = msg.from!.id;
      const cur = getXxMode(telegramId);
      const next = cur === "bot" ? "player" : "bot";
      xxModes.set(telegramId, next);
      await bot.sendMessage(msg.chat.id,
        `🎲 *ĐÃ ĐỔI CHẾ ĐỘ*\n\n` +
        `Bây giờ: *${next === "bot" ? "🤖 BOT tung xúc xắc" : "👤 Bạn tự tung xúc xắc"}*\n\n` +
        (next === "player"
          ? "Sau khi đặt cược, gửi 3 lần 🎲 vào đây để tung!"
          : "Bot sẽ tự tung 3 xúc xắc sau khi bạn đặt cược."),
        { parse_mode: "Markdown" }
      );
    } catch (e) { console.error(e); }
  });

  // ── /nap ──
  bot.onText(/\/nap(?:\s+(\d+))?/, async (msg, match) => {
  try {
    if (!isPrivate(msg)) return;

    const chatId = msg.chat.id;
    const telegramId = msg.from.id;

    const user = getOrCreateUser(telegramId);
    if (user.is_blocked) return;

    const amount = parseInt(match?.[1] || 0);

    if (!amount || amount < 10000) {
      return bot.sendMessage(chatId, "❌ Nạp tối thiểu 10.000");
    }

    // 🔥 TẠO NỘI DUNG RANDOM
    const note = randomString();

    // 🔥 TEMPLATE QR (của bạn)
    const template = "Oj1kFP4";

    // 🔥 LINK QR CHUẨN
const qr = `https://img.vietqr.io/image/970406-214112010-${template}.jpg?amount=${amount}&addInfo=${note}&accountName=BUI%20ANH%20SANG`;

    // gửi QR cho user
    await bot.sendPhoto(chatId, qr, {
      caption: `
💰 Nạp ${amount.toLocaleString()} VND

📝 Nội dung: ${note}
⏳ Chờ admin duyệt
      `
    });

    // gửi về admin
    await bot.sendMessage(adminId, `
💰 YÊU CẦU NẠP TIỀN

👤 User: ${telegramId}
💵 Số tiền: ${amount}
📝 Nội dung: ${note}
    `);

  } catch (e) {
    console.error(e);
  }
});

  // ── /rutbank và /rut ──
  bot.onText(/^\/(?:rut|rutbank)(?:\s+(all|\d[\d.,]*))?$/i, async (msg, match) => {
    try {
      if (!isPrivate(msg)) return;
      const chatId = msg.chat.id; const telegramId = msg.from!.id;
      const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
      resetState(telegramId);
      if (!user.bank_account || !user.bank_name || !user.bank_owner) { await bot.sendMessage(chatId, "❗ Bạn chưa liên kết ngân hàng.\nGõ /setbank để cài đặt."); return; }
      const arg = match?.[1];
      if (!arg) {
        setState(telegramId, { step: "awaiting_rutbank_amount" });
        await bot.sendMessage(chatId, "💳 Nhập số tiền muốn rút:", mainMenuKeyboard());
        return;
      }
      let amount: number;
      if (arg.toLowerCase() === "all") {
        const feePct = user.withdraw_fee_pct ?? 1;
        amount = Math.floor(user.balance / (1 + feePct / 100));
        if (amount <= 0) { await bot.sendMessage(chatId, "❌ Số dư không đủ để rút."); return; }
      } else {
        amount = parseInt(arg.replace(/[.,\s]/g, ""));
      }
      await processWithdraw(chatId, telegramId, amount);
    } catch (e) { console.error(e); }
  });

  // ── /chuyen ──
  bot.onText(/\/chuyen(?:\s+(\d+))?(?:\s+(\d[\d.,]*))?/, async (msg, match) => {
    try {
      if (!isPrivate(msg)) return;
      const chatId = msg.chat.id; const telegramId = msg.from!.id;
      getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
      resetState(telegramId);
      if (!match?.[1] || !match?.[2]) { await bot.sendMessage(chatId, TRANSFER_HELP_MSG); return; }
      const amount = parseInt(match[2].replace(/[.,\s]/g, ""));
      await processTransfer(chatId, telegramId, parseInt(match[1]), amount);
    } catch (e) { console.error(e); }
  });

  // ── /setbank ──
  bot.onText(/\/setbank|\/caidatbank/, async (msg) => {
    try {
      if (!isPrivate(msg)) return;
      getOrCreateUser(msg.from!.id, msg.from?.first_name, msg.from?.username);
      setState(msg.from!.id, { step: "awaiting_bank_name" });
      await bot.sendMessage(msg.chat.id, "🏦 Nhập tên ngân hàng (VD: MB, VCB, TCB, ACB...):");
    } catch (e) { console.error(e); }
  });

  // ── /code ──
  bot.onText(/\/doidiemvip(?:\s+(\d+))?/, async (msg, match) => {
    try {
      if (!isPrivate(msg)) return;
      const telegramId = msg.from!.id; const chatId = msg.chat.id;
      const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
      const pointsInput = parseInt(match![1] ?? "");
      if (!match![1] || isNaN(pointsInput) || pointsInput <= 0) {
        await bot.sendMessage(chatId, `💎 Cách đổi điểm VIP:\n/doidiemvip [số điểm]\n\nVD: /doidiemvip 100`);
        return;
      }
      const totalPoints = Math.floor((user.total_bet ?? 0) / 250_000);
      const redeemed = user.redeemed_points ?? 0;
      const available = totalPoints - redeemed;
      if (available <= 0) { await bot.sendMessage(chatId, `❌ Bạn không có điểm VIP để đổi.\n\nĐiểm hiện có: 0`); return; }
      if (pointsInput > available) { await bot.sendMessage(chatId, `❌ Bạn chỉ có *${formatNumber(available)} điểm* khả dụng, không đủ để đổi ${formatNumber(pointsInput)} điểm.`, { parse_mode: "Markdown" }); return; }
      const rateMap: Record<number, number> = { 0: 0, 1: 100, 2: 200, 3: 300, 4: 400, 5: 500, 6: 600, 7: 700, 8: 800, 9: 1000 };
      const rate = rateMap[user.vip_level] ?? 0;
      if (rate === 0) { await bot.sendMessage(chatId, `❌ Cấp VIP 0 chưa được phép đổi điểm. Hãy nâng VIP để đổi điểm.`); return; }
      const reward = pointsInput * rate;
      const newBal = user.balance + reward;
      db.prepare("UPDATE users SET balance = ?, redeemed_points = redeemed_points + ? WHERE id = ?").run(newBal, pointsInput, user.id);
      recordTransaction({ userId: user.id, type: "win", amount: reward, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Đổi ${pointsInput} điểm VIP` });
      await bot.sendMessage(chatId,
        `✅ *Đã đổi điểm VIP thành công!*\n\n💎 Điểm đã đổi: *${formatNumber(pointsInput)} điểm*\n💰 Số tiền nhận được: *${formatNumber(reward)}*\n\n💳 Số dư sau đổi: *${formatNumber(newBal)}*`,
        { parse_mode: "Markdown", ...mainMenuKeyboard() }
      );
    } catch (e) { console.error(e); }
  });

  bot.onText(/\/code(?:\s+(.+))?/, async (msg, match) => {
    try {
      if (!isPrivate(msg)) return;
      const telegramId = msg.from!.id; const chatId = msg.chat.id;
      getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
      const code = (match![1] ?? "").trim().toUpperCase();
      if (!code) { await bot.sendMessage(chatId, `🎁 Cách nhập giftcode:\n/code [dấu cách] mã giftcode\n\nVD: /code CODE123`); return; }
      await redeemGiftcode(chatId, telegramId, code);
    } catch (e) { console.error(e); }
  });

  // ── /muagift ──
  bot.onText(/\/muagift(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg, match) => {
    try {
      if (!isPrivate(msg)) return;
      const chatId = msg.chat.id; const telegramId = msg.from!.id;
      const qty = parseInt(match![1] ?? ""); const value = parseInt(match![2] ?? "");
      if (!match![1] || !match![2] || isNaN(qty) || isNaN(value) || qty < 1 || value < 1000) {
        await bot.sendMessage(chatId, `🎉 Mua giftcode theo cú pháp:\n/muagift [số lượng] [giá trị mỗi code]\n\nVD: /muagift 5 3000\n\n⚠️ Phí mua Giftcode là 2%`); return;
      }
      if (qty > 50) { await bot.sendMessage(chatId, `❗ Tối đa 50 code mỗi lần mua.`); return; }
      const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);
      if (!isAdmin(telegramId)) {
        const wagerLeft = getWagerRequired(user.id);
        if (wagerLeft > 0) {
          await bot.sendMessage(chatId, `❌ Bạn cần cược thêm *${formatNumber(wagerLeft)}* trước khi có thể mua giftcode.\n_(Mỗi lần nạp/nhập code yêu cầu cược x${WAGER_MULTIPLIER} mới được rút/chuyển/mua giftcode)_`, { parse_mode: "Markdown" });
          return;
        }
      }
      const fee = Math.ceil(qty * value * 0.02); const total = qty * value + fee;
      if (user.balance < total) { await bot.sendMessage(chatId, `❌ Không đủ số dư!\n💰 Cần: ${formatNumber(total)} (gồm phí 2%: ${formatNumber(fee)})\n💰 Số dư: ${formatNumber(user.balance)}`); return; }
      const codes: string[] = [];
      for (let i = 0; i < qty; i++) {
        let code: string;
        do { code = "GFT" + Math.random().toString(36).substring(2, 10).toUpperCase(); } while (db.prepare("SELECT 1 FROM giftcodes WHERE code = ?").get(code));
        codes.push(code);
        db.prepare("INSERT INTO giftcodes (code, amount, max_uses) VALUES (?, ?, ?)").run(code, value, 1);
      }
      const newBal = user.balance - total;
      db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, user.id);
      recordTransaction({ userId: user.id, type: "withdraw", amount: total, fee, balanceBefore: user.balance, balanceAfter: newBal, note: `Mua ${qty} giftcode x${formatNumber(value)}` });
      await bot.sendMessage(chatId, `✅ Mua thành công ${qty} giftcode x${formatNumber(value)}\n💸 Đã trừ: ${formatNumber(total)} (phí 2%: ${formatNumber(fee)})\n💰 Số dư còn: ${formatNumber(newBal)}\n\n🎁 Danh sách code:\n${codes.map((c, i) => `${i + 1}. ${c}`).join("\n")}`);
    } catch (e) { console.error(e); }
  });

  // ── Callback Query ──
  bot.on("callback_query", async (query) => {
    const chatId = query.message!.chat.id;
    const telegramId = query.from.id;
    const data = query.data ?? "";
    await bot.answerCallbackQuery(query.id);

    if (query.message!.chat.type !== "private") return;

    try {
      if (data.startsWith("adm_")) {
        if (!isAdmin(telegramId)) { await bot.sendMessage(chatId, "❌ Bạn không có quyền admin!"); return; }
        if (data === "adm_menu") {
          try {
            await bot.editMessageText(`🛡️ *ADMIN PANEL*\n\nChọn chức năng:`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown", reply_markup: adminMenuKeyboard() });
          } catch {
            await bot.sendMessage(chatId, `🛡️ *ADMIN PANEL*\n\nChọn chức năng:`, { parse_mode: "Markdown", reply_markup: adminMenuKeyboard() });
          }
          return;
        }
        if (data === "adm_close") { try { await bot.deleteMessage(chatId, query.message!.message_id); } catch {} return; }
        const userRefreshMatch = data.match(/^adm_user_refresh_(\d+)$/);
        if (userRefreshMatch) { await sendAdminUserInfo(chatId, parseInt(userRefreshMatch[1]), query.message!.message_id); return; }
        if (data === "adm_stats") { await sendAdminStats(chatId); return; }
        if (data === "adm_listgifts") { await sendAdminGiftList(chatId); return; }
        if (data === "adm_listgifts_refresh") { await sendAdminGiftList(chatId, query.message!.message_id); return; }
        const giftOffMatch = data.match(/^adm_gift_off_(\d+)$/);
        if (giftOffMatch) {
          const gid = parseInt(giftOffMatch[1]);
          const g = db.prepare("SELECT code FROM giftcodes WHERE id = ?").get(gid) as any;
          if (g) {
            db.prepare("UPDATE giftcodes SET is_active = 0 WHERE id = ?").run(gid);
            try { await bot.answerCallbackQuery(query.id, { text: `✅ Đã tắt giftcode ${g.code}` }); } catch {}
          }
          await sendAdminGiftList(chatId, query.message!.message_id);
          return;
        }
        if (data === "adm_gamesessions") { await sendAdminGameSessions(chatId); return; }
        if (data === "adm_session_bets") { setState(telegramId, { step: "adm_session_bets_num" }); await bot.sendMessage(chatId, "📂 Nhập số phiên muốn xem lịch sử cược (VD: 47321):"); return; }
        if (data === "adm_bets_latest" || data.startsWith("adm_bets_")) {
          const session = data === "adm_bets_latest"
            ? db.prepare("SELECT * FROM game_sessions WHERE status='done' ORDER BY id DESC LIMIT 1").get() as any
            : db.prepare("SELECT * FROM game_sessions WHERE id = ?").get(parseInt(data.replace("adm_bets_", ""))) as any;
          if (!session) { await bot.sendMessage(chatId, "❌ Chưa có phiên nào hoàn thành."); return; }
          const bets = db.prepare(`
            SELECT gb.*, u.telegram_id, u.first_name, u.username
            FROM game_bets gb JOIN users u ON u.id = gb.user_id
            WHERE gb.session_id = ? ORDER BY gb.id ASC
          `).all(session.id) as any[];
          if (bets.length === 0) { await bot.sendMessage(chatId, `📋 Phiên #${session.session_number} không có lượt cược nào.`, { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } }); return; }
          const betTypeName: Record<string, string> = { tai: "Tài", xiu: "Xỉu", chan: "Chẵn", le: "Lẻ", tc: "Tài Chẵn", tl: "Tài Lẻ", xc: "Xỉu Chẵn", xl: "Xỉu Lẻ" };
          const diceResult = session.dice1 != null ? `${session.dice1}-${session.dice2}-${session.dice3}=${session.total} ${session.result_tai ? "TÀI" : "XỈU"} ${session.result_chan ? "CHẴN" : "LẺ"}` : "Chưa có kết quả";
          const totalBetAmt = bets.reduce((s: number, b: any) => s + b.amount, 0);
          const totalPayout = bets.reduce((s: number, b: any) => s + (b.payout ?? 0), 0);
          const lines = bets.map((b: any, i: number) => {
            const name = b.first_name ?? b.username ?? `ID ${b.telegram_id}`;
            const type = betTypeName[b.bet_type] ?? b.bet_type;
            const result = b.is_win ? `✅ +${formatNumber(b.payout)}` : `❌ -${formatNumber(b.amount)}`;
            return `${i + 1}. ${name} | ${type} ${formatNumber(b.amount)} | ${result}`;
          });
          const header = `📋 Lịch sử cược phiên #${session.session_number}\n🎲 ${diceResult}\n👥 ${bets.length} lượt | Cược: ${formatNumber(totalBetAmt)} | Trả: ${formatNumber(totalPayout)}\n${"─".repeat(28)}\n`;
          const backKb = { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } };
          const chunks: string[] = [];
          let cur = header;
          for (const l of lines) {
            if ((cur + "\n" + l).length > 4000) { chunks.push(cur); cur = l; }
            else { cur += "\n" + l; }
          }
          chunks.push(cur);
          for (let i = 0; i < chunks.length; i++) {
            await bot.sendMessage(chatId, chunks[i], i === chunks.length - 1 ? backKb : {});
          }
          return;
        }
        const usersMatch = data.match(/^adm_users_(\d+)$/);
        if (usersMatch) { await sendAdminUserList(chatId, parseInt(usersMatch[1])); return; }
        const userTxMatch = data.match(/^adm_usertx_(\d+)$/);
        if (userTxMatch) { await sendAdminUserTx(chatId, parseInt(userTxMatch[1])); return; }
        const blockMatch = data.match(/^adm_block_(\d+)$/);
        if (blockMatch) {
          const uid = parseInt(blockMatch[1]); const u = getUserById(uid);
          if (u) { db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").run(uid); await bot.sendMessage(chatId, `🔒 Đã khóa user ID ${uid}.`); try { await bot.sendMessage(u.telegram_id, "🔒 Tài khoản của bạn đã bị khóa. Liên hệ admin để được hỗ trợ."); } catch {} }
          return;
        }
        const unblockMatch = data.match(/^adm_unblock_(\d+)$/);
        if (unblockMatch) {
          const uid = parseInt(unblockMatch[1]); const u = getUserById(uid);
          if (u) { db.prepare("UPDATE users SET is_blocked = 0 WHERE id = ?").run(uid); await bot.sendMessage(chatId, `🔓 Đã mở khóa user ID ${uid}.`); try { await bot.sendMessage(u.telegram_id, "✅ Tài khoản của bạn đã được mở khóa!"); } catch {} }
          return;
        }
        const addBalAskMatch = data.match(/^adm_addbal_ask_(\d+)$/);
        if (addBalAskMatch) { setState(telegramId, { step: "adm_addbal_amount", targetId: parseInt(addBalAskMatch[1]) }); await bot.sendMessage(chatId, `💰 Nhập số tiền muốn nạp cho user ID ${addBalAskMatch[1]}:`); return; }
        const subBalAskMatch = data.match(/^adm_subbal_ask_(\d+)$/);
        if (subBalAskMatch) { setState(telegramId, { step: "adm_subbal_amount", targetId: parseInt(subBalAskMatch[1]) }); await bot.sendMessage(chatId, `💸 Nhập số tiền muốn trừ khỏi user ID ${subBalAskMatch[1]}:`); return; }
        if (data === "adm_prompt_block") { setState(telegramId, { step: "adm_block_id" }); await bot.sendMessage(chatId, "🔒 Nhập ID user muốn khóa:"); return; }
        if (data === "adm_prompt_unblock") { setState(telegramId, { step: "adm_unblock_id" }); await bot.sendMessage(chatId, "🔓 Nhập ID user muốn mở khóa:"); return; }
        if (data === "adm_prompt_addbal") { setState(telegramId, { step: "adm_addbal_id" }); await bot.sendMessage(chatId, "💰 Nhập ID user muốn nạp tiền:"); return; }
        if (data === "adm_prompt_subbal") { setState(telegramId, { step: "adm_subbal_id" }); await bot.sendMessage(chatId, "💸 Nhập ID user muốn trừ tiền:"); return; }
        if (data === "adm_prompt_userinfo") { setState(telegramId, { step: "adm_userinfo_id" }); await bot.sendMessage(chatId, "🔍 Nhập ID user muốn xem:"); return; }
        if (data === "adm_prompt_usertx") { setState(telegramId, { step: "adm_usertx_id" }); await bot.sendMessage(chatId, "📋 Nhập ID user muốn xem lịch sử:"); return; }
        if (data === "adm_prompt_addgift") { setState(telegramId, { step: "adm_addgift_code" }); await bot.sendMessage(chatId, "🎁 Nhập mã giftcode (VD: WELCOME2025):"); return; }
        if (data === "adm_prompt_delgift") { setState(telegramId, { step: "adm_delgift_code" }); await bot.sendMessage(chatId, "❌ Nhập mã giftcode muốn xóa:"); return; }
        if (data === "adm_prompt_setfee") { setState(telegramId, { step: "adm_setfee_id" }); await bot.sendMessage(chatId, "💱 Nhập ID user muốn đặt phí rút:"); return; }
        if (data === "adm_prompt_clearwager") { setState(telegramId, { step: "adm_clearwager_id" }); await bot.sendMessage(chatId, "🎟️ Nhập ID user muốn miễn vòng cược:"); return; }
        if (data === "adm_prompt_broadcast") { setState(telegramId, { step: "adm_broadcast_text" }); await bot.sendMessage(chatId, "📣 Nhập nội dung thông báo muốn gửi tới tất cả user:"); return; }
        if (data === "adm_prompt_reset_user") { setState(telegramId, { step: "adm_reset_user_id" }); await bot.sendMessage(chatId, "🔄 Nhập Telegram ID hoặc ID nội bộ của user muốn reset:"); return; }
        const admResetConfirm = data.match(/^adm_reset_confirm_(\d+)$/);
        if (admResetConfirm) {
          const uid = parseInt(admResetConfirm[1]);
          const u = getUserById(uid);
          if (!u) { await bot.sendMessage(chatId, "❌ Không tìm thấy user."); return; }
          db.prepare(`UPDATE users SET balance=0, total_bet=0, today_bet=0, week_bet=0, win_streak=0, lose_streak=0, wager_required=0 WHERE id=?`).run(uid);
          resetState(telegramId);
          await bot.sendMessage(chatId, `✅ Đã reset tài khoản của ${u.first_name ?? u.username ?? "user"} (ID: ${u.telegram_id}).\n\n– Số dư: 0\n– Tổng cược: 0\n– Chuỗi thắng/thua: 0\n– Vòng cược: 0`, { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } });
          return;
        }
        const admResetCancel = data.match(/^adm_reset_cancel_(\d+)$/);
        if (admResetCancel) { resetState(telegramId); await bot.sendMessage(chatId, "❌ Đã hủy reset.", { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } }); return; }
        return;
      }

      // ─── Danh sách game callbacks ─────────────────────────────────
      if (data === "game_taixiu_sanhu") {
        const msgText =
          `💥GAME TÀI XỈU SĂN HŨ💥\n` +
          `Nhóm để chơi game: [@hq88room]\n` +
          `Lưu ý các lệnh sau được chơi tại Room, nếu chơi tại Bot sẽ là game khác và cách tính kết quả khác so với Room.\n` +
          `Game T X tại Room\n` +
          `--------------------\n` +
          `GAME TÀI/XỈU/CHẴN/LẺ TẠI ROOM\n` +
          `- T: Tổng 3 viên xúc xắc từ 11 - 18 Tài.\n` +
          `- X: Tổng 3 viên xúc xắc từ 3 - 10 Xỉu.\n\n` +
          `• Tỷ lệ trả thưởng 1.94\n` +
          `• Bạn có cơ hội chia hũ nếu nổ hũ 3 viên xúc xắc giống nhau đều là 1 hoặc 6 ở game TXCL.\n` +
          `Lệnh cược: [T/X/C/L] [tiền chơi]\n` +
          `VD: T 20000\n` +
          `- Cược ẩn danh: TT/XX [tiền chơi] VD: TT 20000\n` +
          `- Cược tất tay: Đổi tiền cược thành MAX VD: T MAX`;
        await bot.sendMessage(chatId, msgText);
        return;
      }
      if (data === "game_xucxac_lonnho") {
        await bot.sendMessage(chatId,
          `🔻 *XÚC XẮC TRÊN DƯỚI* 🔺\n\n` +
          `🎮 Cách chơi:\n` +
          `Gõ *TD [số tiền]* để bắt đầu.\n` +
          `VD: *TD 5000*\n\n` +
          `📌 Bot sẽ tung 2 xúc xắc lần đầu.\n` +
          `Bạn đoán lần sau sẽ *TRÊN* (tổng cao hơn) hay *DƯỚI* (tổng thấp hơn).\n` +
          `Bot tung 2 xúc xắc lần 2 — so sánh kết quả!\n\n` +
          `💰 Thắng nhận *x1.94* | Hòa hoàn tiền | 30 giây để chọn`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (data === "game_xucxac") {
        const mode = getXxMode(telegramId);
        await bot.sendMessage(chatId,
          `🎲 *XÚC XẮC TELEGRAM* 🎲\n\n` +
          `Bạn đang để chế độ *${mode === "bot" ? "🤖 BOT tung xúc xắc" : "👤 Bạn tự tung"}*, dùng lệnh /doichedo để thay đổi\n\n` +
          `Nội dung | Tổng điểm 3 xúc xắc | Tỷ lệ ăn\n` +
          `*XXC* | 4,6,8,10,12,14,16,18 | x1.92\n` +
          `*XXL* | 3,5,7,9,11,13,15,17 | x1.92\n` +
          `*XXX* | 3,4,5,6,7,8,9,10 | x1.92\n` +
          `*XXT* | 11,12,13,14,15,16,17,18 | x1.92\n\n` +
          `👉 Tối thiểu *${formatNumber(XX_MIN_BET)}* — Tối đa *${formatNumber(XX_MAX_BET)}*\n\n` +
          `🔖 Cách chơi: [Lệnh] [tiền cược]\nVD: *XXC 10000* hoặc *XXL 10000*`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (data === "game_slot") {
        await bot.sendMessage(chatId,
          `🎰 *GAME SLOT MACHINE* 🎰\n\n` +
          `🎮 Quay slot và đợi kết quả!\n\n` +
          `🎁 *Tỷ lệ thắng:*\n` +
          `🎰 Jackpot 777 (7️⃣7️⃣7️⃣): *x8.0*\n` +
          `✨ 3 biểu tượng giống nhau: *x5.0*\n` +
          `💸 Không trùng: Hoàn *10%*\n\n` +
          `💰 Tối thiểu *${formatNumber(SL_MIN_BET)}* — Tối đa *${formatNumber(SL_MAX_BET)}*\n\n` +
          `🎮 Lệnh chơi: *SL [số tiền]*\nVD: *SL 10000*`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (data === "game_basketball") {
        await bot.sendMessage(chatId,
          `🏀 *GAME BÓNG RỔ* 🏀\n\n` +
          `🔖 Ném bóng vào rổ sẽ tính là chiến thắng!\n\n` +
          `Nội dung | Kết quả | Tỷ lệ ăn\n` +
          `*BR* | Bóng vào rổ | x${BR_MULTIPLIER.toFixed(1)}\n\n` +
          `👉 Tối thiểu *${formatNumber(BR_MIN_BET)}* — Tối đa *${formatNumber(BR_MAX_BET)}*\n\n` +
          `🎮 Cách chơi:\n[nội dung] [tiền cược]\nVD: *BR 10000*`,
          { parse_mode: "Markdown" }
        );
        return;
      }
      if (data === "game_xucxac_318" || data === "game_timestick" || data === "game_1phan4" || data === "game_bowling") {
        await bot.sendMessage(chatId, "🛠 Game này đang được phát triển, vui lòng quay lại sau!");
        return;
      }

      // ── Trên/Dưới callbacks ──
      if (data.startsWith("td_tren_") || data.startsWith("td_duoi_")) {
        const userId = parseInt(data.startsWith("td_tren_") ? data.slice(8) : data.slice(8));
        const game = tdGames.get(userId);
        if (!game) { await bot.sendMessage(chatId, "⚠️ Ván này đã hết hạn hoặc không còn hiệu lực!"); return; }
        if (game.telegramId !== telegramId) return;
        clearTimeout(game.timer);
        tdGames.delete(userId);
        const choice = data.startsWith("td_tren_") ? "tren" : "duoi";
        const { amount, firstTotal, msgId } = game;
        const de = TD_DICE_EMOJI;

        // Tung 2 xúc xắc lần 2
        let d3 = 1, d4 = 1;
        try {
          await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });
        } catch {}
        try {
          await bot.sendMessage(chatId, `🎲 Đang tung xúc xắc lần 2...`);
          const m3 = await bot.sendDice(chatId, { emoji: "🎲" });
          d3 = (m3 as any).dice?.value ?? Math.ceil(Math.random() * 6);
          await sleep(1_200);
          const m4 = await bot.sendDice(chatId, { emoji: "🎲" });
          d4 = (m4 as any).dice?.value ?? Math.ceil(Math.random() * 6);
          await sleep(3_500);
        } catch (e: any) { console.error("TD dice2 error:", e.message); }

        const secondTotal = d3 + d4;
        const user = getUserById(userId);
        if (!user) return;

        let resultText = "";
        if (secondTotal === firstTotal) {
          // Hòa — hoàn tiền
          const refundBal = user.balance + amount;
          db.prepare("UPDATE users SET balance=? WHERE id=?").run(refundBal, user.id);
          recordTransaction({ userId, type: "admin_add", amount, fee: 0, balanceBefore: user.balance, balanceAfter: refundBal, note: `Hòa Trên/Dưới (${firstTotal}=${secondTotal})` });
          resultText = `🤝 *HÒA!* Tổng bằng nhau: *${secondTotal}*\n💰 Hoàn lại *${formatNumber(amount)}đ*\n💎 Số dư: *${formatNumber(refundBal)}đ*`;
        } else {
          const isHigher = secondTotal > firstTotal;
          const _fTd = (db.prepare("SELECT value FROM bot_settings WHERE key='force_td'").get() as any)?.value;
          const won = _fTd === 'tren' ? choice === "tren" : _fTd === 'duoi' ? choice === "duoi" : (choice === "tren" && isHigher) || (choice === "duoi" && !isHigher);
          const mult = getTdMult(firstTotal, choice) ?? 1.94;
          if (won) {
            const payout = Math.floor(amount * mult);
            const newBal2 = user.balance + payout;
            db.prepare("UPDATE users SET balance=?, win_streak=win_streak+1, lose_streak=0 WHERE id=?").run(newBal2, user.id);
            recordTransaction({ userId, type: "win", amount: payout, fee: 0, balanceBefore: user.balance, balanceAfter: newBal2, note: `Thắng Trên/Dưới (${choice === "tren" ? "TRÊN" : "DƯỚI"}) ${fmtMult(mult)}` });
            resultText = `🎉 *THẮNG!* Bạn chọn *${choice === "tren" ? "TRÊN 🔺" : "DƯỚI 🔻"}* (${fmtMult(mult)})\n💰 Thắng *+${formatNumber(payout)}đ*\n💎 Số dư: *${formatNumber(newBal2)}đ*`;
          } else {
            db.prepare("UPDATE users SET lose_streak=lose_streak+1, win_streak=0 WHERE id=?").run(user.id);
            recordTransaction({ userId, type: "bet", amount: 0, fee: 0, balanceBefore: user.balance, balanceAfter: user.balance, note: `Thua Trên/Dưới (${choice === "tren" ? "TRÊN" : "DƯỚI"})` });
            resultText = `😔 *THUA!* Bạn chọn *${choice === "tren" ? "TRÊN 🔺" : "DƯỚI 🔻"}*\n💸 Mất *${formatNumber(amount)}đ*\n💎 Số dư: *${formatNumber(user.balance)}đ*`;
          }
        }

        const playAgainKb = { reply_markup: { inline_keyboard: [[{ text: "🔄 Chơi lại", callback_data: "td_play_again" }]] } };
        try {
          await bot.sendMessage(chatId,
            `🔻 *XÚC XẮC TRÊN DƯỚI* 🔺\n\n` +
            `🎲 Lần 1: ${de[game.d1]} + ${de[game.d2]} = *${firstTotal}*\n` +
            `🎲 Lần 2: ${de[d3]} + ${de[d4]} = *${secondTotal}*\n\n` +
            resultText,
            { parse_mode: "Markdown", ...playAgainKb }
          );
        } catch (e: any) { console.error("TD result error:", e.message); }
        return;
      }

      if (data === "td_play_again") {
        await bot.sendMessage(chatId,
          `🔻 *XÚC XẮC TRÊN DƯỚI* 🔺\n\nGõ *TD [số tiền]* để chơi tiếp!\nVD: *TD 5000*`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (data === "sl_play_again") {
        await bot.sendMessage(chatId,
          `🎰 *SLOT MACHINE*\n\nGõ *SL [số tiền]* để quay tiếp!\nVD: *SL 10000*`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (data === "br_play_again") {
        await bot.sendMessage(chatId,
          `🏀 *GAME BÓNG RỔ*\n\nGõ *BR [số tiền]* để chơi tiếp!\nVD: *BR 10000*`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (data.startsWith("sb_again_")) {
        const parts = data.split("_");
        const num = parts[2] ?? "11";
        const amt = parts[3] ?? "20000";
        await bot.sendMessage(chatId,
          `🎲 *ĐOÁN TỔNG 3 XÚC XẮC*\n\nGõ lệnh để chơi lại:\n*SB${num} ${amt}*`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      if (data === "xx_play_again") {
        const mode = getXxMode(telegramId);
        await bot.sendMessage(chatId,
          `🎲 *XÚC XẮC TELEGRAM*\n\n` +
          `Chế độ: *${mode === "bot" ? "🤖 BOT tung" : "👤 Tự tung"}*\n\n` +
          `Gõ lệnh để đặt cược:\n` +
          `*XXC* [tiền] → Chẵn  |  *XXL* [tiền] → Lẻ\n` +
          `*XXX* [tiền] → Xỉu   |  *XXT* [tiền] → Tài\n\n` +
          `VD: *XXC 10000*\n\n_/doichedo để đổi chế độ_`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // ── Nhận hoàn cược ngày ──
      if (data.startsWith("claim_cashback_")) {
        const date = data.replace("claim_cashback_", "");
        const user = getUserByTelegramId(telegramId);
        if (!user) return;
        const cb = db.prepare("SELECT * FROM daily_cashbacks WHERE user_id = ? AND date = ?").get(user.id, date) as any;
        if (!cb) { await bot.sendMessage(chatId, "❌ Không tìm thấy thưởng hoàn cược!"); return; }
        if (cb.claimed) { await bot.sendMessage(chatId, "⚠️ Bạn đã nhận thưởng hoàn cược này rồi!"); return; }
        const newBal = user.balance + cb.cashback;
        db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, user.id);
        db.prepare("UPDATE daily_cashbacks SET claimed = 1, claimed_at = datetime('now') WHERE id = ?").run(cb.id);
        recordTransaction({ userId: user.id, type: "cashback", amount: cb.cashback, fee: 0, balanceBefore: user.balance, balanceAfter: newBal, note: `Hoàn cược ngày ${date}` });
        try {
          await bot.editMessageText(
            `✅ *HOÀN CƯỢC NGÀY ${date}*\n\n🎉 Đã nhận thành công!\n\n📅 Hoàn tiền ngày: *${date}*\n💰 Số tiền nhận: *+${formatNumber(cb.cashback)}*\n💎 Số dư hiện tại: *${formatNumber(newBal)}*`,
            { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown" }
          );
        } catch {}
        return;
      }

      // Duyệt/Từ chối rút tiền
      if (data.startsWith("wit_approve_") || data.startsWith("wit_reject_")) {
        if (!isAdmin(telegramId)) { await bot.sendMessage(chatId, "❌ Bạn không có quyền!"); return; }
        const witId = parseInt(data.split("_").pop()!);
        const wit = db.prepare("SELECT * FROM pending_withdrawals WHERE id = ?").get(witId) as any;
        if (!wit) { await bot.sendMessage(chatId, "❌ Không tìm thấy yêu cầu!"); return; }
        if (wit.status !== "pending") { await bot.sendMessage(chatId, "⚠️ Yêu cầu này đã được xử lý rồi!"); return; }
        if (data.startsWith("wit_approve_")) {
          const u = db.prepare("SELECT * FROM users WHERE id = ?").get(wit.user_id) as any;
          db.prepare("UPDATE users SET total_withdraw = ? WHERE id = ?").run(u.total_withdraw + wit.amount, u.id);
          recordTransaction({ userId: u.id, type: "withdraw", amount: wit.amount, fee: wit.fee, balanceBefore: u.balance + wit.amount, balanceAfter: u.balance, note: `Rút tiền về STK ${wit.bank_account} - ${wit.bank_name} - ${wit.bank_owner}` });
          db.prepare("UPDATE pending_withdrawals SET status='approved', handled_at=datetime('now') WHERE id=?").run(witId);
          try { await bot.editMessageText(`✅ ĐÃ DUYỆT rút *${formatNumber(wit.amount)}* cho Telegram ID ${wit.telegram_id}`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown" }); } catch {}
          try { await bot.sendMessage(wit.telegram_id, `✅ Rút tiền thành công!\nSố tiền ${formatNumber(wit.net)} đã được chuyển về STK liên kết của bạn`); } catch {}
          const maskedWitId = `****${String(wit.telegram_id).slice(-5)}`;
          for (const gid of enabledGroups) { try { await bot.sendMessage(gid, `*🎉 Người chơi ${maskedWitId}*\n*✅ Rút tiền thành công ${formatNumber(wit.net)}*`, { parse_mode: "Markdown" }); } catch {} }
        } else {
          const u = db.prepare("SELECT * FROM users WHERE id = ?").get(wit.user_id) as any;
          const restoredBal = u.balance + wit.amount;
          db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(restoredBal, u.id);
          db.prepare("UPDATE pending_withdrawals SET status='rejected', handled_at=datetime('now') WHERE id=?").run(witId);
          try { await bot.editMessageText(`❌ ĐÃ TỪ CHỐI rút *${formatNumber(wit.amount)}* của Telegram ID ${wit.telegram_id}`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown" }); } catch {}
          try { await bot.sendMessage(wit.telegram_id, `❌ Yêu cầu rút *${formatNumber(wit.amount)}* đã bị từ chối.\n💰 Số tiền đã được hoàn lại vào tài khoản: ${formatNumber(restoredBal)}\nLiên hệ admin để biết thêm.`, { parse_mode: "Markdown" }); } catch {}
        }
        return;
      }

      // Duyệt/Từ chối nạp tiền
      if (data.startsWith("dep_approve_") || data.startsWith("dep_reject_")) {
        if (!isAdmin(telegramId)) { await bot.sendMessage(chatId, "❌ Bạn không có quyền!"); return; }
        const depId = parseInt(data.split("_").pop()!);
        const dep = db.prepare("SELECT * FROM pending_deposits WHERE id = ?").get(depId) as any;
        if (!dep) { await bot.sendMessage(chatId, "❌ Không tìm thấy yêu cầu!"); return; }
        if (dep.status !== "pending") { await bot.sendMessage(chatId, "⚠️ Yêu cầu này đã được xử lý rồi!"); return; }
        if (data.startsWith("dep_approve_")) {
          const u = db.prepare("SELECT * FROM users WHERE id = ?").get(dep.user_id) as any;
          const bonus = Math.floor(dep.amount * 0.03);
          const totalCredit = dep.amount + bonus;
          const isFirstDeposit = u.total_deposit === 0;
          const wipedAmount = isFirstDeposit ? u.balance : 0;
          const baseBalance = isFirstDeposit ? 0 : u.balance;
          const newBal = baseBalance + totalCredit;
          if (isFirstDeposit && wipedAmount > 0) {
            recordTransaction({ userId: u.id, type: "adjust", amount: wipedAmount, fee: 0, balanceBefore: u.balance, balanceAfter: 0, note: "Trừ số dư trước nạp lần đầu" });
          }
          db.prepare("UPDATE users SET balance = ?, total_deposit = ? WHERE id = ?").run(newBal, u.total_deposit + dep.amount, u.id);
          addWagerRequirement(u.id, dep.amount);
          recordTransaction({ userId: u.id, type: "deposit", amount: dep.amount, fee: 0, balanceBefore: baseBalance, balanceAfter: baseBalance + dep.amount, note: "Nạp tiền (user yêu cầu)" });
          if (bonus > 0) recordTransaction({ userId: u.id, type: "gift", amount: bonus, fee: 0, balanceBefore: baseBalance + dep.amount, balanceAfter: newBal, note: "Khuyến mãi nạp 3%" });
          if (u.referrer_id && !u.first_deposit_done) {
            const refBonus = Math.floor(dep.amount * 0.03);
            if (refBonus > 0) addReferralCommission(u.referrer_id, refBonus, `Hoa hồng 3% nạp đầu từ ${u.telegram_id}`);
            db.prepare("UPDATE users SET first_deposit_done=1 WHERE id=?").run(u.id);
          }
          updateVipLevel({ ...u, total_deposit: u.total_deposit + dep.amount });
          db.prepare("UPDATE pending_deposits SET status='approved', handled_at=datetime('now') WHERE id=?").run(depId);
          try { await bot.editMessageText(`✅ ĐÃ DUYỆT nạp *${formatNumber(dep.amount)}* cho Telegram ID ${dep.telegram_id}`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown" }); } catch {}
          const wipedNote = (isFirstDeposit && wipedAmount > 0) ? `\n⚠️ Số dư cũ trước khi nạp đã bị trừ: -${formatNumber(wipedAmount)}` : "";
          try { await bot.sendMessage(dep.telegram_id, `✅ Ting Ting\n💰 Nạp tiền thành công ${formatNumber(dep.amount)}\n🎁Khuyến mãi nạp 3%: ${formatNumber(bonus)}${wipedNote}\nSố dư hiện tại: ${formatNumber(newBal)}`); } catch {}
          const maskedId = `****${String(dep.telegram_id).slice(-5)}`;
          for (const gid of enabledGroups) { try { await bot.sendMessage(gid, `*Người chơi ${maskedId}*\n*✅ Nạp tiền thành công ${formatNumber(dep.amount)}*\n*🎁Khuyến mãi nạp 3%: +${formatNumber(bonus)}*`, { parse_mode: "Markdown" }); } catch {} }
        } else {
          db.prepare("UPDATE pending_deposits SET status='rejected', handled_at=datetime('now') WHERE id=?").run(depId);
          try { await bot.editMessageText(`❌ ĐÃ TỪ CHỐI nạp *${formatNumber(dep.amount)}* của Telegram ID ${dep.telegram_id}`, { chat_id: chatId, message_id: query.message!.message_id, parse_mode: "Markdown" }); } catch {}
          try { await bot.sendMessage(dep.telegram_id, `❌ Yêu cầu nạp *${formatNumber(dep.amount)}* đã bị từ chối. Liên hệ admin để biết thêm.`, { parse_mode: "Markdown" }); } catch {}
        }
        return;
      }

      const user = getOrCreateUser(telegramId, query.from.first_name, query.from.username);
      if (user.is_blocked) {
        await bot.sendMessage(chatId, `🔒 Tài khoản của bạn đã bị khóa.\nLiên hệ admin ${SUPPORT_ADMIN} để được hỗ trợ.`);
        return;
      }
      switch (data) {
        case "acc_ls_nap": await sendDepositHistory(chatId, user.id); break;
        case "acc_ls_rut": await sendWithdrawHistory(chatId, user.id); break;
        case "acc_ls_choi": await sendBetHistory(chatId, user.id); break;
        case "acc_chuyen": resetState(telegramId); await bot.sendMessage(chatId, TRANSFER_HELP_MSG); break;
        case "acc_nhap_gift": await bot.sendMessage(chatId, `🎁 Cách nhập giftcode:\n/code [dấu cách] mã giftcode\n\nVD: /code CODE123`); break;
        case "acc_mua_gift": await bot.sendMessage(chatId, `🎉 Mua giftcode theo cú pháp:\n/muagift [số lượng] [giá trị mỗi code]\n\nVD: /muagift 5 3000\n\n⚠️ Phí mua Giftcode là 2%`); break;
        case "acc_lixi": await handleLixi(chatId, telegramId); break;
        case "acc_event": await bot.sendMessage(chatId, "🎪 *SỰ KIỆN*\n\n🔥 Nạp 100k nhận bonus 20%\n🎯 Top cược tuần nhận thưởng\n🏆 Điểm danh 7 ngày nhận 5.000", { parse_mode: "Markdown" }); break;
        case "acc_diemdanh": await handleCheckin(chatId, telegramId); break;
        case "acc_tichluynap": await handleAccumulatedDeposit(chatId, user); break;
        case "acc_hotro": await bot.sendMessage(chatId, `📞 Hỗ Trợ\n🕐 24/7\n📱 Admin: @luxvipb\n💬 Group Tài Xỉu : https://t.me/hq88room`); break;
      }
    } catch (e) { console.error(e); }
  });

  // ── Message Handler ──
  bot.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const telegramId = msg.from!.id;
    const text = msg.text.trim();

    try {
      if (msg.chat.type !== "private") {
        if (text.toLowerCase() === "daythang") { await sendStreakTop(msg, "thang"); return; }
        if (text.toLowerCase() === "daythua") { await sendStreakTop(msg, "thua"); return; }
        // ── Cược Đoán tổng (SB) trong nhóm — tích hợp vào phiên ──
        const sbGrpMatch = text.match(/^SB(3|4|5|6|7|8|9|1[0-8])\s+(max|\d[\d.,]*)/i);
        if (sbGrpMatch) { await handleSbGame(msg); return; }
        // ── Cược Đoán 2 xúc xắc (D2) — D[n1][n2] [tiền] ──
        const d2GrpMatch = text.match(/^D([1-6])([1-6])\s+(max|\d[\d.,]*)/i);
        if (d2GrpMatch) { await handleGroupBet(msg); return; }

        // ── Cược Đoán 1 xúc xắc (D) — D[n] [tiền] ──
        const d1GrpMatch = text.match(/^D([1-6])\s+(max|\d[\d.,]*)/i);
        if (d1GrpMatch) {
          const chosenNum = parseInt(d1GrpMatch[1]);
          let session = activeSessions.get(chatId);
          if (!session) {
            if (!enabledGroups.has(chatId)) return;
            if (rollingChats.has(chatId)) { try { await bot.sendMessage(chatId, "*⏰ Hết thời gian đặt cược, vui lòng chờ phiên khác.*", { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {} return; }
            await startSession(chatId, true); session = activeSessions.get(chatId); if (!session) return;
          }
          const dUser = getUserByTelegramId(telegramId);
          if (!dUser) { try { await bot.sendMessage(chatId, "*❗ Bạn chưa đăng ký. Nhắn /start cho bot.*", { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {} return; }
          if (dUser.is_blocked) return;
          if (session.dBets.has(dUser.id)) {
            try { await bot.sendMessage(chatId, `❗ Bạn đã cược D${chosenNum} phiên này rồi, chỉ được cược *1 lần/phiên*.`, { reply_to_message_id: msg.message_id, parse_mode: "Markdown" }); } catch {}
            return;
          }
          const d1Raw = d1GrpMatch[2].toLowerCase();
          let d1Amount: number;
          if (d1Raw === "max") {
            d1Amount = Math.min(dUser.balance, MAX_BET);
            if (d1Amount < MIN_BET) { try { await bot.sendMessage(chatId, `❌ Số dư không đủ tối thiểu ${formatNumber(MIN_BET)}!`, { reply_to_message_id: msg.message_id }); } catch {} return; }
          } else {
            d1Amount = parseInt(d1Raw.replace(/[.,\s]/g, ""));
            if (isNaN(d1Amount) || d1Amount < MIN_BET) { try { await bot.sendMessage(chatId, `❗ Tối thiểu ${formatNumber(MIN_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return; }
            if (d1Amount > MAX_BET) { try { await bot.sendMessage(chatId, `❗ Tối đa ${formatNumber(MAX_BET)}`, { reply_to_message_id: msg.message_id }); } catch {} return; }
          }
          if (dUser.balance < d1Amount) { try { await bot.sendMessage(chatId, `❌ Không đủ số dư! Số dư: ${formatNumber(dUser.balance)}`, { reply_to_message_id: msg.message_id }); } catch {} return; }
          const d1NewBal = dUser.balance - d1Amount;
          db.prepare("UPDATE users SET balance=?, total_bet=total_bet+?, today_bet=today_bet+?, week_bet=week_bet+? WHERE id=?").run(d1NewBal, d1Amount, d1Amount, d1Amount, dUser.id);
          consumeWagerRequirement(dUser.id, d1Amount);
          recordTransaction({ userId: dUser.id, type: "bet", amount: d1Amount, fee: 0, balanceBefore: dUser.balance, balanceAfter: d1NewBal, note: `Cược D${chosenNum} phiên #${session.sessionNumber}` });
          const d1WasEmpty = !hasBets(session);
          session.dBets.set(dUser.id, { chosenNum, amount: d1Amount });
          if (d1WasEmpty && session.silent) {
            session.silent = false; session.timers.forEach(clearTimeout);
            const _sid = session.sessionId; const _snum = session.sessionNumber;
            const nt1 = setTimeout(async () => { const s = activeSessions.get(chatId); if (!s || s.sessionId !== _sid || !hasBets(s)) return; try { await bot.sendMessage(chatId, formatBetStatus(_snum, 40, getBetTotals(s)), { parse_mode: "Markdown" }); } catch {} }, WARN_40S_MS);
            const nt2 = setTimeout(async () => { const s = activeSessions.get(chatId); if (!s || s.sessionId !== _sid || !hasBets(s)) return; try { await bot.sendMessage(chatId, formatBetStatus(_snum, 20, getBetTotals(s)), { parse_mode: "Markdown" }); } catch {} }, WARN_20S_MS);
            const nt3 = setTimeout(() => endSession(chatId, _sid), GAME_DURATION_MS);
            session.timers = [nt1, nt2, nt3];
          }
          try { await bot.sendMessage(chatId, `*${vipEmoji(dUser.vip_level)} Đặt thành công phiên #${session.sessionNumber}*\n*D${chosenNum} - ${formatNumber(d1Amount)}*`, { parse_mode: "Markdown", reply_to_message_id: msg.message_id, allow_sending_without_reply: false }); } catch {}
          return;
        }

        await handleGroupBet(msg);
        return;
      }

      const state = getState(telegramId);
      const user = getOrCreateUser(telegramId, msg.from?.first_name, msg.from?.username);

      if (user.is_blocked) {
        await bot.sendMessage(chatId, `🔒 Tài khoản của bạn đã bị khóa.\nLiên hệ admin ${SUPPORT_ADMIN} để được hỗ trợ.`);
        return;
      }

      // ── Game Slot Machine từ chat riêng ──
      if (state.step === "idle" && /^SL\s+(max|\d[\d.,]*)/i.test(text)) {
        await handleSlGame(msg);
        return;
      }

      // ── Game Bóng rổ từ chat riêng ──
      if (state.step === "idle" && /^BR\s+(max|\d[\d.,]*)/i.test(text)) {
        await handleBrGame(msg);
        return;
      }

      // ── Game Đoán tổng 3 xúc xắc (SB) từ chat riêng ──
      if (state.step === "idle" && /^SB(3|4|5|6|7|8|9|1[0-8])\s+(max|\d[\d.,]*)/i.test(text)) {
        await handleSbGame(msg);
        return;
      }

      // ── Game Xúc xắc Telegram (XX) từ chat riêng ──
      if (state.step === "idle" && /^(xxc|xxl|xxx|xxt)\s+(max|\d[\d.,]*)/i.test(text)) {
        await handleXxGame(msg);
        return;
      }

      // ── Game Trên/Dưới từ chat riêng ──
      if (state.step === "idle" && /^TD\s+(max|\d[\d.,]*)/i.test(text)) {
        await handleTdGame(msg);
        return;
      }

      // ── Cược ẩn danh từ chat riêng ──
      if (state.step === "idle" && BET_REGEX.test(text)) {
        // Tìm session đang chạy, hoặc tạo mới cho nhóm đầu tiên đang bật game
        let activeFound = findActiveSession(chatId);
        if (!activeFound) {
          // Chưa có session nào — thử khởi động cho nhóm đầu tiên đang enabled
          const firstGroup = [...enabledGroups][0];
          if (!firstGroup) {
            await bot.sendMessage(chatId, "⏳ Hiện chưa có phòng game nào hoạt động!");
            return;
          }
          if (rollingChats.has(firstGroup)) {
            await bot.sendMessage(chatId, "⏰ Đang tung xúc xắc, vui lòng chờ phiên mới!");
            return;
          }
          await startSession(firstGroup, true);
          const newSession = activeSessions.get(firstGroup);
          if (!newSession) {
            await bot.sendMessage(chatId, "⏳ Không thể bắt đầu phiên, vui lòng thử lại!");
            return;
          }
          activeFound = { groupChatId: firstGroup, session: newSession };
        }
        if (rollingChats.has(activeFound.groupChatId)) {
          await bot.sendMessage(chatId, "⏰ Hết thời gian đặt cược, vui lòng chờ phiên khác.");
          return;
        }
        await handlePrivateBet(msg, activeFound.groupChatId, activeFound.session);
        return;
      }

      // Keyboard menu buttons
      if (text === "🏦 Tài Khoản") { resetState(telegramId); await sendAccountInfo(chatId, telegramId); return; }
      if (text === "💵 Nạp Tiền") {
        resetState(telegramId);
        await bot.sendMessage(chatId, `💵 *Nạp Tiền*\n\nGõ /nap [số tiền] để tạo lệnh nạp.\n\nVí dụ: /nap 50000`, { parse_mode: "Markdown", ...mainMenuKeyboard() }); return;
      }
      if (text === "💸 Rút Tiền") {
        resetState(telegramId);
        const bankInfo = (user.bank_name && user.bank_account)
          ? `🏦 ${user.bank_name} – ${user.bank_account}${user.bank_owner ? ` – ${user.bank_owner}` : ""}`
          : `🏦.......`;
        const msgText =
          `STK đã cài đặt của bạn:\n` +
          ` ${bankInfo}\n \n` +
          `Để đổi STK vui lòng liên hệ Admin.\n\n` +
          `Rút tiền về tài khoản trên:\n` +
          `• /rut [số tiền] – VD: /rut 50000\n` +
          `• /rut all – Rút một lần tối đa phần khả dụng (đã trừ phí 1%)\n\n` +
          `⚠️ Phí rút 1%. Rút tối thiểu theo cài đặt bot (thường 50k).`;
        await bot.sendMessage(chatId, msgText, mainMenuKeyboard()); return;
      }
      if (text === "🎮 Danh sách game" || text === "🎮 DS Game" || text === "DS Game") {
        resetState(telegramId);
        await bot.sendMessage(chatId, `CHỌN GAME ĐỂ CHƠI`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔥 Tài Xỉu Săn Hũ 🔥", callback_data: "game_taixiu_sanhu" }],
              [{ text: "🎲 xúc xắc 3-18 🎲", callback_data: "game_xucxac_318" }],
              [
                { text: "🎲 xúc xắc", callback_data: "game_xucxac" },
                { text: "🏀 Bóng rổ", callback_data: "game_basketball" },
              ],
              [{ text: "⬆️ xúc xắc lớn nhỏ ⬇️", callback_data: "game_xucxac_lonnho" }],
              [
                { text: "🎰 Slot Machine", callback_data: "game_slot" },
                { text: "🎳 Bowling", callback_data: "game_bowling" },
              ],
            ],
          },
        });
        return;
      }
      if (text === "🌺 Giới Thiệu") {
        resetState(telegramId);
        const u = getUserByTelegramId(telegramId);
        const refLink = `http://t.me/${BOT_USERNAME || "your_bot"}?start=${telegramId}`;
        const refereeCount = (db.prepare("SELECT COUNT(*) AS c FROM users WHERE referrer_id = ?").get(u.id) as any)?.c ?? 0;
        const today = new Date().toISOString().slice(0, 10);
        const todayComm = u.referral_today_date === today ? (u.referral_today ?? 0) : 0;
        const totalComm = u.referral_total ?? 0;
        const introMsg =
          `👉 Link mời bạn bè của bạn:\n${refLink}\n👈 CLICK VÀO LINK BÊN ĐỂ COPY VÀ GỬI CHO BẠN BÈ\n\n` +
          `🌺 Nhận ngay HOA HỒNG bằng 2% số tiền cược thua từ người chơi bạn giới thiệu.\n\n` +
          `Nhận 5% đơn nạp đầu tiên của đệ tử\n\n` +
          `🤝 Số lượng đệ tử: ${refereeCount} 🤝\n\n` +
          `Hoa hồng nhận được hôm nay: ${formatNumber(todayComm)}\n` +
          `Tổng hoa hồng: ${formatNumber(totalComm)}`;
        await bot.sendMessage(chatId, introMsg, mainMenuKeyboard()); return;
      }
      if (text === "⭐ Đua top") {
        resetState(telegramId);

        const top = db.prepare(
          "SELECT telegram_id, today_bet FROM users WHERE today_bet > 0 ORDER BY today_bet DESC LIMIT 10"
        ).all() as any[];

        const now = new Date();
        const dd = String(now.getDate()).padStart(2, "0");
        const mm = String(now.getMonth() + 1).padStart(2, "0");

        const topLines = top.map((u, i) => {
          const idStr = String(u.telegram_id);
          const masked = "****" + idStr.slice(-5);
          const kAmount = formatNumber(Math.floor((u.today_bet ?? 0) / 1000));
          return ` Top ${i + 1}: ${masked}  |  ${kAmount} k`;
        });

        let myRank = 0;
        const myRow = db.prepare("SELECT today_bet FROM users WHERE telegram_id = ?").get(telegramId) as any;
        if (myRow && (myRow.today_bet ?? 0) > 0) {
          const higher = db.prepare("SELECT COUNT(*) AS c FROM users WHERE today_bet > ?").get(myRow.today_bet) as any;
          myRank = (higher?.c ?? 0) + 1;
        }

        const body = topLines.length > 0 ? topLines.join("\n") : " Chưa có dữ liệu";
        const topMsg =
          `🔥 Top cược ngày hôm nay ${dd}/${mm}! 🔥\n\n` +
          `${body}\n \n` +
          `Thứ hạng của bạn: Top ${myRank}`;

        await bot.sendMessage(chatId, topMsg, mainMenuKeyboard()); return;
      }
      if (text === "👑 VIP") {
        resetState(telegramId);
        const vipPoints = Math.floor((user.total_bet ?? 0) / 250_000);
        const vipText =
          `*ĐIỂM VIP HIỆN TẠI:* ${formatNumber(vipPoints)} điểm (${vipLabel(user.vip_level)})\n\n` +
          `Với mỗi 250K tiền cược, bạn sẽ được tặng thêm 1 điểm cấp VIP. Điểm này sẽ dùng để xét tăng cấp VIP và để đổi thưởng.\n\n` +
          `🏆 *CẤP VIP VÀ BIỂU TƯỢNG*\n` +
          `Vip 0: 🥉 (Đồng)\n` +
          `Vip 1: 🥈 (Bạc)\n` +
          `Vip 2: 🥇 (Vàng)\n` +
          `Vip 3: 🎖 (Bạch Kim)\n` +
          `Vip 4: 💎 (Kim Cương)\n` +
          `Vip 5: 🏵️ (Cao Thủ)\n` +
          `Vip 6: 🏆 (Chiến Tướng)\n` +
          `Vip 7: 🏅 (Đại Tướng)\n` +
          `Vip 8: 👑 (Huyền Thoại)\n` +
          `Vip 9: 🌟 (Tối Thượng)\n\n` +
          `📌 *ĐIỂM YÊU CẦU ĐỂ ĐẠT CẤP VIP*\n` +
          `Vip 1: 10\n` +
          `Vip 2: 50\n` +
          `Vip 3: 100\n` +
          `Vip 4: 500\n` +
          `Vip 5: 1000\n` +
          `Vip 6: 5000\n` +
          `Vip 7: 10000\n` +
          `Vip 8: 50000\n` +
          `Vip 9: 100000\n\n` +
          `💎 *TỈ LỆ QUY ĐỔI ĐIỂM*\n` +
          `Hãy tích điểm và quy đổi chúng thành tiền mặt với tỉ lệ cực kỳ hấp dẫn:\n` +
          `Vip 1: 1điểm = 100đ\n` +
          `Vip 2: 1điểm = 200đ\n` +
          `Vip 3: 1điểm = 300đ\n` +
          `Vip 4: 1điểm = 400đ\n` +
          `Vip 5: 1điểm = 500đ\n` +
          `Vip 6: 1điểm = 600đ\n` +
          `Vip 7: 1điểm = 700đ\n` +
          `Vip 8: 1điểm = 800đ\n` +
          `Vip 9: 1điểm = 1000đ\n\n` +
          `❤️ *CÁCH ĐỔI ĐIỂM VIP*\n` +
          `/doidiemvip [dấu cách] số điểm\n\n` +
          `➡️ Vd: /doidiemvip 100`;
        await bot.sendMessage(chatId, vipText, { parse_mode: "Markdown", ...mainMenuKeyboard() }); return;
      }
      if (text === "🔍 Lệnh") {
        resetState(telegramId);
        await bot.sendMessage(chatId,
          `🔍 *DANH SÁCH LỆNH*\n\n/start – Bắt đầu\n/taikhoan – Thông tin tài khoản\n/sd – Số dư nhanh\n/nap [số] – Nạp tiền\n/rutbank [số] – Rút tiền\n/chuyen [ID] [số] – Chuyển tiền\n/setbank – Liên kết ngân hàng\n/code [mã] – Nhập giftcode\n/muagift [sl] [giá] – Mua giftcode`,
          { parse_mode: "Markdown", ...mainMenuKeyboard() }); return;
      }

      // Admin state machine
      if (state.step.startsWith("adm_")) {
        if (!isAdmin(telegramId)) { resetState(telegramId); return; }
        switch (state.step) {
          case "adm_block_id": { const uid = parseInt(text); if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ. Nhập lại:"); return; } const u = findUserByAnyId(uid); if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; } db.prepare("UPDATE users SET is_blocked = 1 WHERE id = ?").run(u.id); resetState(telegramId); await bot.sendMessage(chatId, `🔒 Đã khóa user ${u.first_name ?? u.username ?? u.id}.`); try { await bot.sendMessage(u.telegram_id, "🔒 Tài khoản của bạn đã bị khóa."); } catch {} return; }
          case "adm_unblock_id": { const uid = parseInt(text); if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ. Nhập lại:"); return; } const u = findUserByAnyId(uid); if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; } db.prepare("UPDATE users SET is_blocked = 0 WHERE id = ?").run(u.id); resetState(telegramId); await bot.sendMessage(chatId, `🔓 Đã mở khóa user ${u.first_name ?? u.username ?? u.id}.`); try { await bot.sendMessage(u.telegram_id, "✅ Tài khoản đã được mở khóa!"); } catch {} return; }
          case "adm_addbal_id": { const uid = parseInt(text); if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ."); resetState(telegramId); return; } const u = findUserByAnyId(uid); if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; } setState(telegramId, { step: "adm_addbal_amount", targetId: u.id }); await bot.sendMessage(chatId, `💰 Nhập số tiền muốn nạp cho ${u.first_name ?? u.username ?? "user"} (ID: ${u.id}):`); return; }
          case "adm_addbal_amount": { const amount = parseInt(text.replace(/[.,\s]/g, "")); if (isNaN(amount) || amount <= 0) { await bot.sendMessage(chatId, "❗ Số tiền không hợp lệ. Nhập lại:"); return; } const u = getUserById(state.targetId); const newBal = u.balance + amount; db.prepare("UPDATE users SET balance = ?, total_deposit = ? WHERE id = ?").run(newBal, u.total_deposit + amount, u.id); addWagerRequirement(u.id, amount); recordTransaction({ userId: u.id, type: "deposit", amount, fee: 0, balanceBefore: u.balance, balanceAfter: newBal, note: "Nạp tiền (admin)" }); updateVipLevel({ ...u, total_deposit: u.total_deposit + amount }); resetState(telegramId); await bot.sendMessage(chatId, `✅ Đã nạp ${formatNumber(amount)} cho ${u.first_name ?? u.username ?? "user"} (ID: ${u.id}). Số dư mới: ${formatNumber(newBal)}`); try { await bot.sendMessage(u.telegram_id, `💰 Tài khoản được nạp ${formatNumber(amount)}. Số dư: ${formatNumber(newBal)}`); } catch {} return; }
          case "adm_subbal_id": { const uid = parseInt(text); if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ."); resetState(telegramId); return; } const u = findUserByAnyId(uid); if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; } setState(telegramId, { step: "adm_subbal_amount", targetId: u.id }); await bot.sendMessage(chatId, `💸 Nhập số tiền muốn trừ khỏi ${u.first_name ?? u.username ?? "user"} (ID: ${u.id}):`); return; }
          case "adm_subbal_amount": { const amount = parseInt(text.replace(/[.,\s]/g, "")); if (isNaN(amount) || amount <= 0) { await bot.sendMessage(chatId, "❗ Số tiền không hợp lệ."); return; } const u = getUserById(state.targetId); if (u.balance < amount) { await bot.sendMessage(chatId, `❌ Số dư user chỉ có ${formatNumber(u.balance)}.`); resetState(telegramId); return; } const newBal = u.balance - amount; db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, u.id); recordTransaction({ userId: u.id, type: "withdraw", amount, fee: 0, balanceBefore: u.balance, balanceAfter: newBal, note: "Trừ tiền (admin)" }); resetState(telegramId); await bot.sendMessage(chatId, `✅ Đã trừ ${formatNumber(amount)} khỏi ${u.first_name ?? u.username ?? "user"} (ID: ${u.id}). Số dư mới: ${formatNumber(newBal)}`); return; }
          case "adm_userinfo_id": { const uid = parseInt(text); if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ."); resetState(telegramId); return; } const u = findUserByAnyId(uid); if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; } resetState(telegramId); await sendAdminUserInfo(chatId, u.id); return; }
          case "adm_usertx_id": { const uid = parseInt(text); if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ."); resetState(telegramId); return; } const u = findUserByAnyId(uid); if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; } resetState(telegramId); await sendAdminUserTx(chatId, u.id); return; }
          case "adm_session_bets_num": {
            const sessionNum = parseInt(text.trim());
            if (isNaN(sessionNum)) { await bot.sendMessage(chatId, "❗ Số phiên không hợp lệ."); return; }
            const session = db.prepare("SELECT * FROM game_sessions WHERE session_number = ?").get(sessionNum) as any;
            if (!session) { await bot.sendMessage(chatId, `❌ Không tìm thấy phiên #${sessionNum}.`); resetState(telegramId); return; }
            const bets = db.prepare(`
              SELECT gb.*, u.telegram_id, u.first_name, u.username
              FROM game_bets gb
              JOIN users u ON u.id = gb.user_id
              WHERE gb.session_id = ?
              ORDER BY gb.id ASC
            `).all(session.id) as any[];
            resetState(telegramId);
            if (bets.length === 0) {
              await bot.sendMessage(chatId, `📂 Phiên #${sessionNum} không có lượt cược nào.`, { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } });
              return;
            }
            const betTypeName: Record<string, string> = { tai: "Tài", xiu: "Xỉu", chan: "Chẵn", le: "Lẻ", tc: "Tài Chẵn", tl: "Tài Lẻ", xc: "Xỉu Chẵn", xl: "Xỉu Lẻ" };
            const diceResult = session.dice1 != null ? `${session.dice1}-${session.dice2}-${session.dice3}=${session.total} ${session.result_tai ? "TÀI" : "XỈU"} ${session.result_chan ? "CHẴN" : "LẺ"}` : "Chưa có kết quả";
            const totalBetAmt = bets.reduce((s: number, b: any) => s + b.amount, 0);
            const totalPayout = bets.reduce((s: number, b: any) => s + (b.payout ?? 0), 0);
            const lines = bets.map((b: any, i: number) => {
              const name = b.first_name ?? b.username ?? `ID ${b.telegram_id}`;
              const type = betTypeName[b.bet_type] ?? b.bet_type;
              const result = b.is_win ? `✅ +${formatNumber(b.payout)}` : `❌ -${formatNumber(b.amount)}`;
              return `${i + 1}. ${name} | ${type} ${formatNumber(b.amount)} | ${result}`;
            });
            const header = `📂 Lịch sử cược phiên #${sessionNum}\n🎲 Kết quả: ${diceResult}\n👥 ${bets.length} lượt | Tổng cược: ${formatNumber(totalBetAmt)} | Tổng trả: ${formatNumber(totalPayout)}\n${"─".repeat(30)}\n`;
            const body = lines.join("\n");
            const fullMsg = header + body;
            const backKb = { reply_markup: { inline_keyboard: [[{ text: "🔙 Menu Admin", callback_data: "adm_menu" }]] } };
            if (fullMsg.length > 4000) {
              const chunks = [];
              let cur = header;
              for (const l of lines) { if ((cur + "\n" + l).length > 4000) { chunks.push(cur); cur = l; } else { cur += "\n" + l; } }
              chunks.push(cur);
              for (let i = 0; i < chunks.length; i++) {
                await bot.sendMessage(chatId, chunks[i], i === chunks.length - 1 ? backKb : {});
              }
            } else {
              await bot.sendMessage(chatId, fullMsg, backKb);
            }
            return;
          }
          case "adm_set_lichsu": {
            const cid = parseInt(text.trim());
            if (isNaN(cid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ. Hãy nhập đúng dạng số (VD: -1001234567890)."); return; }
            historyChannelId = cid;
            db.prepare("INSERT OR REPLACE INTO bot_settings (key, value) VALUES ('history_channel_id', ?)").run(String(cid));
            resetState(telegramId);
            await bot.sendMessage(chatId, `✅ Đã cài group lịch sử phiên: \`${cid}\`\n\nBot sẽ tự đăng kết quả từng phiên vào đó.`, { parse_mode: "Markdown" });
            return;
          }
          case "adm_reset_user_id": {
            const uid = parseInt(text);
            if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ. Nhập lại:"); return; }
            const u = findUserByAnyId(uid);
            if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; }
            const name = u.first_name ?? u.username ?? `ID ${u.telegram_id}`;
            await bot.sendMessage(chatId,
              `⚠️ Xác nhận reset tài khoản?\n\n👤 ${name} (TG: ${u.telegram_id})\n💰 Số dư hiện tại: ${formatNumber(u.balance)}\n\nSẽ đặt về 0:\n– Số dư\n– Tổng cược / hôm nay / tuần\n– Chuỗi thắng / thua\n– Vòng cược yêu cầu`,
              { reply_markup: { inline_keyboard: [[{ text: "✅ Xác nhận Reset", callback_data: `adm_reset_confirm_${u.id}` }, { text: "❌ Hủy", callback_data: `adm_reset_cancel_${u.id}` }]] } }
            );
            resetState(telegramId);
            return;
          }
          case "adm_addgift_code": { setState(telegramId, { step: "adm_addgift_amount", code: text.toUpperCase() }); await bot.sendMessage(chatId, `💰 Nhập số tiền cho giftcode *${text.toUpperCase()}*:`, { parse_mode: "Markdown" }); return; }
          case "adm_addgift_amount": { const amount = parseInt(text.replace(/[.,\s]/g, "")); if (isNaN(amount) || amount <= 0) { await bot.sendMessage(chatId, "❗ Số tiền không hợp lệ."); return; } setState(telegramId, { step: "adm_addgift_maxuses", code: state.code, amount }); await bot.sendMessage(chatId, `🔢 Nhập số lượt sử dụng tối đa (nhập 0 để không giới hạn):`); return; }
          case "adm_addgift_maxuses": { const maxUses = parseInt(text) || 1; try { db.prepare("INSERT INTO giftcodes (code, amount, max_uses) VALUES (?, ?, ?)").run(state.code, state.amount, maxUses); await bot.sendMessage(chatId, `✅ Đã tạo giftcode *${state.code}* – ${formatNumber(state.amount)} – tối đa ${maxUses} lần.`, { parse_mode: "Markdown", reply_markup: adminMenuKeyboard() }); } catch { await bot.sendMessage(chatId, `❌ Giftcode *${state.code}* đã tồn tại.`, { parse_mode: "Markdown" }); } resetState(telegramId); return; }
          case "adm_delgift_code": { const code = text.toUpperCase(); const gift = db.prepare("SELECT * FROM giftcodes WHERE code = ?").get(code); if (!gift) { await bot.sendMessage(chatId, `❌ Không tìm thấy giftcode: ${code}`); } else { db.prepare("UPDATE giftcodes SET is_active = 0 WHERE code = ?").run(code); await bot.sendMessage(chatId, `✅ Đã vô hiệu hóa giftcode *${code}*.`, { parse_mode: "Markdown" }); } resetState(telegramId); return; }
          case "adm_setfee_id": { const uid = parseInt(text); if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ."); resetState(telegramId); return; } const u = findUserByAnyId(uid); if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; } setState(telegramId, { step: "adm_setfee_pct", targetId: u.id }); await bot.sendMessage(chatId, `💱 Nhập phần trăm phí rút cho ${u.first_name ?? u.username ?? "user"} (ID: ${u.id}) (VD: 0.5):`); return; }
          case "adm_setfee_pct": { const pct = parseFloat(text); if (isNaN(pct)) { await bot.sendMessage(chatId, "❗ Phần trăm không hợp lệ."); return; } db.prepare("UPDATE users SET withdraw_fee_pct = ? WHERE id = ?").run(pct, state.targetId); resetState(telegramId); await bot.sendMessage(chatId, `✅ Đã đặt phí rút của user ID ${state.targetId} thành *${pct}%*`, { parse_mode: "Markdown" }); return; }
          case "adm_clearwager_id": {
            const uid = parseInt(text);
            if (isNaN(uid)) { await bot.sendMessage(chatId, "❗ ID không hợp lệ."); resetState(telegramId); return; }
            const u = findUserByAnyId(uid);
            if (!u) { await bot.sendMessage(chatId, `❌ Không tìm thấy user với ID: ${uid}`); resetState(telegramId); return; }
            const oldWager = getWagerRequired(u.id);
            db.prepare("UPDATE users SET wager_required = 0 WHERE id = ?").run(u.id);
            resetState(telegramId);
            await bot.sendMessage(chatId, `✅ Đã miễn vòng cược cho ${u.first_name ?? u.username ?? "user"} (ID: ${u.id}).\nVòng cược trước đó: *${formatNumber(oldWager)}* → *0*`, { parse_mode: "Markdown" });
            return;
          }
          case "adm_broadcast_text": { const users = db.prepare("SELECT telegram_id FROM users WHERE is_blocked = 0").all() as any[]; let sent = 0, failed = 0; await bot.sendMessage(chatId, `📣 Đang gửi đến ${users.length} user...`); for (const u of users) { try { await bot.sendMessage(u.telegram_id, `📣 *THÔNG BÁO TỪ HỆ THỐNG*\n\n${text}`, { parse_mode: "Markdown" }); sent++; } catch { failed++; } await sleep(50); } resetState(telegramId); await bot.sendMessage(chatId, `✅ Đã gửi: ${sent} | ❌ Thất bại: ${failed}`, { reply_markup: adminMenuKeyboard() }); return; }
        }
        return;
      }

      // User state machine
      switch (state.step) {
        case "awaiting_rutbank_amount": { const amount = parseInt(text.replace(/[.,\s]/g, "")); resetState(telegramId); await processWithdraw(chatId, telegramId, amount); return; }
        case "awaiting_transfer_id": { const targetId = parseInt(text); if (isNaN(targetId)) { await bot.sendMessage(chatId, "❗ Telegram ID không hợp lệ."); return; } setState(telegramId, { step: "awaiting_transfer_amount", targetId }); await bot.sendMessage(chatId, "💸 Nhập số tiền muốn chuyển:"); return; }
        case "awaiting_transfer_amount": { const amount = parseInt(text.replace(/[.,\s]/g, "")); resetState(telegramId); await processTransfer(chatId, telegramId, state.targetId, amount); return; }
        case "awaiting_bank_name": { setState(telegramId, { step: "awaiting_bank_account", bankName: text }); await bot.sendMessage(chatId, "💳 Nhập số tài khoản ngân hàng:"); return; }
        case "awaiting_bank_account": { setState(telegramId, { step: "awaiting_bank_owner", bankName: state.bankName, bankAccount: text }); await bot.sendMessage(chatId, "👤 Nhập tên chủ tài khoản (viết HOA, không dấu):"); return; }
        case "awaiting_bank_owner": {
          db.prepare("UPDATE users SET bank_name = ?, bank_account = ?, bank_owner = ? WHERE telegram_id = ?").run(state.bankName, state.bankAccount, text.toUpperCase(), telegramId);
          resetState(telegramId);
          await bot.sendMessage(chatId, `✅ Đã liên kết ngân hàng thành công!\n🏦 ${state.bankName}\n💳 ${state.bankAccount}\n👤 ${text.toUpperCase()}`, mainMenuKeyboard()); return;
        }
      }
    } catch (e) { console.error(e); }
  });

  // ── Handler nhận 🎲 từ user (XX player mode) ──
  bot.on("message", async (msg) => {
    if (!msg.dice || msg.dice.emoji !== "🎲") return;
    if (msg.chat.type !== "private") return;
    const telegramId = msg.from!.id;
    const chatId = msg.chat.id;
    if (getXxMode(telegramId) !== "player") return;
    const user = getUserByTelegramId(telegramId);
    if (!user) return;
    const pending = xxPending.get(user.id);
    if (!pending) return;
    try {
      pending.dice.push(msg.dice.value);
      const count = pending.dice.length;
      if (count < 3) {
        if (pending.msgId) {
          try {
            await bot.editMessageText(
              `🎲 *XÚC XẮC TELEGRAM*\n\nĐặt *${XX_LABEL[pending.betType]}* — *${formatNumber(pending.amount)}đ*\n\n📨 Hãy gửi *3 lần* 🎲 vào đây!\n_(${count}/3 đã nhận)_`,
              { chat_id: chatId, message_id: pending.msgId, parse_mode: "Markdown" }
            );
          } catch {}
        }
      } else {
        xxPending.delete(user.id);
        const total = pending.dice.reduce((a, b) => a + b, 0);
        const freshUser = getUserById(user.id);
        await resolveXxGame(chatId, user.id, pending.betType, pending.amount, total, pending.dice, freshUser?.balance ?? 0);
      }
    } catch (e) { console.error(e); }
  });

  bot.on("polling_error", (error: any) => { logger.error({ error }, "Lỗi polling Telegram bot"); });

  // ── Hoàn cược ngày: chạy lúc 00h00 giờ VN (UTC+7) ──
  async function sendDailyCashbacks(targetDate?: string) {
    // Ngày hôm qua theo giờ VN (hoặc ngày chỉ định)
    let date = targetDate;
    if (!date) {
      const nowVN = new Date(Date.now() + 7 * 3600_000);
      const yesterday = new Date(nowVN);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      date = yesterday.toISOString().slice(0, 10);
    }

    // Tổng cược theo user trong ngày hôm qua (giờ VN = UTC+7, so date filter theo datetime('now','+7 hours'))
    const rows = db.prepare(`
      SELECT gb.user_id, SUM(gb.amount) as total_bet
      FROM game_bets gb
      JOIN game_sessions gs ON gb.session_id = gs.id
      WHERE date(gs.ended_at, '+7 hours') = ?
      GROUP BY gb.user_id
    `).all(date) as any[];

    for (const row of rows) {
      const cashback = Math.floor(row.total_bet * 0.005);
      if (cashback < 1) continue;
      try {
        db.prepare("INSERT OR IGNORE INTO daily_cashbacks (user_id, date, total_bet, cashback) VALUES (?, ?, ?, ?)")
          .run(row.user_id, date, row.total_bet, cashback);
      } catch {}
      const user = getUserById(row.user_id);
      if (!user) continue;
      const msg =
        `✅ *HOÀN CƯỢC NGÀY ${date}*\n\n` +
        `Bạn có thưởng chờ nhận:\n\n` +
        `📅 Hoàn tiền ngày\n` +
        `0.5% cược đã chốt: *${formatNumber(cashback)}*\n\n` +
        `💎 Tổng nhận: *${formatNumber(cashback)}*\n\n` +
        `👉 Bấm nút bên dưới để chuyển vào ví ngay.`;
      try {
        await bot.sendMessage(user.telegram_id, msg, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "🎁 Nhận thưởng ngay", callback_data: `claim_cashback_${date}` }]],
          },
        });
      } catch {}
    }
    logger.info(`Đã gửi hoàn cược ngày ${date} cho ${rows.length} người.`);
  }

  // ── Reset đua top + trao giftcode 5k mỗi 00h00 VN ──
  async function resetDailyTop() {
    // Lấy top 10 ngày vừa kết thúc
    const topUsers = db.prepare(
      "SELECT * FROM users WHERE today_bet >= 100000 AND total_deposit >= 50000 ORDER BY today_bet DESC LIMIT 10"
    ).all() as any[];

    const nowVN = new Date(Date.now() + 7 * 3600_000);
    const yesterday = new Date(nowVN);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const dd = String(yesterday.getUTCDate()).padStart(2, "0");
    const mm = String(yesterday.getUTCMonth() + 1).padStart(2, "0");

    for (let i = 0; i < topUsers.length; i++) {
      const u = topUsers[i];
      // Tạo giftcode duy nhất trị giá 5,000 (1 lần dùng)
      let code: string;
      do {
        code = "TOP" + Math.random().toString(36).substring(2, 10).toUpperCase();
      } while (db.prepare("SELECT 1 FROM giftcodes WHERE code = ?").get(code));
      db.prepare("INSERT INTO giftcodes (code, amount, max_uses) VALUES (?, ?, ?)").run(code, 5000, 1);

      const rank = i + 1;
      const rankEmoji = ["🥇","🥈","🥉","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"][i] ?? `${rank}.`;
      const dmMsg =
        `🏆 *THƯỞNG ĐUA TOP NGÀY ${dd}/${mm}*\n\n` +
        `${rankEmoji} Chúc mừng! Bạn đã đạt *Top ${rank}* cược trong ngày ${dd}/${mm}!\n\n` +
        `🎁 Giftcode phần thưởng:\n` +
        `\`${code}\`\n\n` +
        `💰 Giá trị: *5.000*\n\n` +
        `👉 Dùng lệnh /code ${code} để nhận thưởng vào ví ngay!`;
      try {
        await bot.sendMessage(u.telegram_id, dmMsg, { parse_mode: "Markdown" });
      } catch {}
    }

    // ── Trao thưởng top dây thắng / thua ──
    const STREAK_PRIZE = 10000;
    const rankEmojis = ["🥇", "🥈", "🥉"];

    const topThang = db.prepare(
      "SELECT * FROM users WHERE win_streak > 0 ORDER BY win_streak DESC LIMIT 3"
    ).all() as any[];
    for (let i = 0; i < topThang.length; i++) {
      const u = topThang[i];
      const newBal = u.balance + STREAK_PRIZE;
      db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, u.id);
      recordTransaction({ userId: u.id, type: "win", amount: STREAK_PRIZE, fee: 0, balanceBefore: u.balance, balanceAfter: newBal, note: `Thưởng Top ${i + 1} dây thắng ngày ${dd}/${mm}` });
      try {
        await bot.sendMessage(u.telegram_id,
          `🏆 *THƯỞNG DÂY THẮNG NGÀY ${dd}/${mm}*\n\n${rankEmojis[i]} Bạn đạt *Top ${i + 1}* dây thắng với *${u.win_streak} trận* liên tiếp!\n\n💰 Thưởng: *${formatNumber(STREAK_PRIZE)}* đã cộng vào ví.`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }

    const topThua = db.prepare(
      "SELECT * FROM users WHERE lose_streak > 0 ORDER BY lose_streak DESC LIMIT 3"
    ).all() as any[];
    for (let i = 0; i < topThua.length; i++) {
      const u = topThua[i];
      const newBal = u.balance + STREAK_PRIZE;
      db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(newBal, u.id);
      recordTransaction({ userId: u.id, type: "win", amount: STREAK_PRIZE, fee: 0, balanceBefore: u.balance, balanceAfter: newBal, note: `Thưởng Top ${i + 1} dây thua ngày ${dd}/${mm}` });
      try {
        await bot.sendMessage(u.telegram_id,
          `💔 *THƯỞNG DÂY THUA NGÀY ${dd}/${mm}*\n\n${rankEmojis[i]} Bạn đạt *Top ${i + 1}* dây thua với *${u.lose_streak} trận* liên tiếp!\n\n💰 Thưởng: *${formatNumber(STREAK_PRIZE)}* đã cộng vào ví.`,
          { parse_mode: "Markdown" }
        );
      } catch {}
    }

    // Reset today_bet = 0 và win_streak / lose_streak về 0 cho tất cả
    db.prepare("UPDATE users SET today_bet = 0, win_streak = 0, lose_streak = 0").run();
    logger.info(`Đã reset đua top ngày ${dd}/${mm}, trao thưởng ${topUsers.length} người. Top thắng: ${topThang.length}, top thua: ${topThua.length}.`);
  }

  function scheduleDailyCashback() {
    const now = Date.now();
    const midnight = new Date(now + 7 * 3600_000); // giờ VN hiện tại
    midnight.setUTCHours(24 - 7, 0, 0, 0); // 17:00 UTC = 00:00 VN kế tiếp
    let msUntilMidnight = midnight.getTime() - now;
    if (msUntilMidnight <= 0) msUntilMidnight += 24 * 3600_000;

    function runMidnightJobs() {
      resetDailyTop();
      sendDailyCashbacks();
    }

    setTimeout(() => {
      runMidnightJobs();
      setInterval(runMidnightJobs, 24 * 3600_000);
    }, msUntilMidnight);
    logger.info(`Đặt lịch 00h00 VN: còn ${Math.round(msUntilMidnight / 60000)} phút nữa.`);
  }

  scheduleDailyCashback();

  return bot;
}
