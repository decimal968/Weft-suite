/*! src/backend/engine.ts */
export var STAT_KEYS = ["str", "dex", "int", "cha", "con", "wis"];
export var DEFAULT_STAT_LABELS = {
  str: "STR",
  dex: "DEX",
  int: "INT",
  cha: "CHA",
  con: "CON",
  wis: "WIS"
};
export function makeId(prefix = "id") {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const buf = new Uint32Array(2);
    cryptoObj.getRandomValues(buf);
    const rand = (buf[0].toString(36) + buf[1].toString(36)).slice(0, 10);
    return `${prefix}_${Date.now().toString(36)}_${rand}`;
  }
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}
export function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}
export function statModifier(value) {
  const v = Math.floor(Number.isFinite(value) ? value : 5);
  if (v <= 2) return -2;
  if (v <= 4) return -1;
  if (v <= 6) return 0;
  if (v <= 8) return 1;
  if (v <= 10) return 2;
  if (v <= 12) return 3;
  if (v <= 14) return 4;
  if (v <= 16) return 5;
  return 6;
}
interface PoolsOptions {
  fillToMax?: boolean;
  raiseCurrentByMaxDelta?: boolean;
}
interface PoolsInput {
  level: number;
  stats: { con: number; int: number; [key: string]: number };
}
interface SheetLike extends PoolsInput {
  hp: number; hpMax: number;
  sp: number; spMax: number;
  mp: number; mpMax: number;
  xpNext: number;
  [key: string]: unknown;
}
export function formatMod(mod) {
  return mod >= 0 ? `+${mod}` : `${mod}`;
}
export function computePools(sheet: PoolsInput, opts: PoolsOptions = {}): { hpMax: number; spMax: number; mpMax: number; xpNext: number } {
  const lv = Math.max(1, Math.floor(sheet.level));
  const con = Math.max(1, Math.floor(sheet.stats.con));
  const intStat = Math.max(1, Math.floor(sheet.stats.int));
  return {
    hpMax: 40 + 3 * con + 4 * (lv - 1),
    spMax: 14 + 2 * con + (lv - 1),
    mpMax: 14 + 2 * intStat,
    xpNext: 100 * lv // preset rule: XP to next level = 100 x level
  };
}
export function recomputeSheetPools(sheet: SheetLike, opts: PoolsOptions = {}): SheetLike {
  const prevHpMax = sheet.hpMax;
  const prevSpMax = sheet.spMax;
  const prevMpMax = sheet.mpMax;
  const next = computePools(sheet);
  sheet.hpMax = next.hpMax;
  sheet.spMax = next.spMax;
  sheet.mpMax = next.mpMax;
  sheet.xpNext = next.xpNext;
  if (opts.fillToMax) {
    sheet.hp = sheet.hpMax;
    sheet.sp = sheet.spMax;
    sheet.mp = sheet.mpMax;
  } else if (opts.raiseCurrentByMaxDelta) {
    sheet.hp = clamp(sheet.hp + Math.max(0, sheet.hpMax - prevHpMax), 0, sheet.hpMax);
    sheet.sp = clamp(sheet.sp + Math.max(0, sheet.spMax - prevSpMax), 0, sheet.spMax);
    sheet.mp = clamp(sheet.mp + Math.max(0, sheet.mpMax - prevMpMax), 0, sheet.mpMax);
  } else {
    sheet.hp = clamp(sheet.hp, 0, sheet.hpMax);
    sheet.sp = clamp(sheet.sp, 0, sheet.spMax);
    sheet.mp = clamp(sheet.mp, 0, sheet.mpMax);
  }
  return sheet;
}
export function createDefaultModules() {
  return { system: true, tracker: true, dice: true, choices: true };
}
export function createDefaultSettings() {
  return {
    enabledByDefault: true,
    defaultModules: createDefaultModules(),
    injectPrompt: true,
    autoSync: true,
    sidecarConnectionId: "",
    theme: "sakura",
    allocMode: "player",
    showInlineSystem: true,
    showInlineTracker: true,
    showInlineDice: true,
    showInlineChoices: true,
    inlineStartsOpen: false
  };
}
export function createDefaultSheet(name = "Survivor") {
  const stats = {
    str: 5,
    dex: 6,
    int: 6,
    cha: 5,
    con: 5,
    wis: 6
  };
  const pools = computePools({ level: 1, stats });
  return {
    name,
    race: "Human",
    cls: "",
    subcls: "",
    rank: "",
    guild: "",
    title: "",
    level: 1,
    xp: 0,
    xpNext: pools.xpNext,
    pts: 0,
    hp: pools.hpMax,
    hpMax: pools.hpMax,
    sp: pools.spMax,
    spMax: pools.spMax,
    useMp: false,
    mpLabel: "MP",
    mp: pools.mpMax,
    mpMax: pools.mpMax,
    stats,
    statLabels: { ...DEFAULT_STAT_LABELS },
    gear: { weapon: null, armor: null, accessory: null },
    bag: [],
    cash: "",
    skills: [],
    effects: [],
    quests: [],
    lastLog: "Sheet created."
  };
}
export function createDefaultWorld() {
  return {
    location: "Unknown",
    time: "Day 1",
    weather: "",
    mood: "",
    arc: "Opening",
    phase: "Setup",
    dayCount: 1,
    npcs: [],
    threads: [],
    notes: "",
    pc: { outfit: "", pos: "", cond: "", carry: "" }
  };
}
export function userKey(userId) {
  return userId && userId.trim() ? userId.trim() : "__default__";
}
export function safeFileSegment(id) {
  return String(id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96) || "unknown";
}
export function chatCacheKey(userId, chatId) {
  return `${userKey(userId)}::${chatId}`;
}
