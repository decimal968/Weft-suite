// @ts-nocheck — types are being tightened incrementally; bundling and CI tests do not depend on this flag. Remove file-by-file.
/*! src/backend/backend.ts */
import { parseChoicesBlock } from "./choices";
import { DEFAULT_STAT_LABELS, STAT_KEYS, chatCacheKey, clamp, createDefaultModules, createDefaultSettings, makeId, recomputeSheetPools, safeFileSegment, userKey } from "./engine";
import { buildDeltaMessages, buildInitMessages, parseJsonDelta } from "./extractor";
import { MAX_IMPORT_BYTES, NEW_NPC_BOND, addItemToBag, allocateStatPoint, applyDelta, autoAllocateAllPoints, buildPromptBlock, createDefaultChatData, deepClone, equipItem, normalizeChatData, noteSyncOutcome, performDiceRoll, removeItemFromBag, sanitizeImportedState, sanitizeString, unequipSlot } from "./sanitize";
var MAX_SNAPSHOTS = 30;
var MAX_HISTORY_ROLLS = 30;
var SIDECAR_MAX_TOKENS = 2200;
var SYNC_WAIT_MS = 6000;
var settingsCache = /* @__PURE__ */ new Map();
var chatCache = /* @__PURE__ */ new Map();
var activeChatByUser = /* @__PURE__ */ new Map();
var activeConnByUser = /* @__PURE__ */ new Map();
var lastUserByChat = /* @__PURE__ */ new Map();
var lastKnownUserId;
var syncingChats = /* @__PURE__ */ new Set();
var interceptorDisposer = null;
function rememberUserForChat(chatId, userId) {
  if (userId && userId.trim()) {
    const uid = userId.trim();
    lastKnownUserId = uid;
    if (chatId) lastUserByChat.set(chatId, uid);
    return uid;
  }
  if (chatId) {
    return lastUserByChat.get(chatId) || lastKnownUserId;
  }
  return lastKnownUserId;
}
var SETTINGS_ENUM_KEYS = {
  allocMode: ["player", "auto"],
  theme: ["sakura", "ocean", "gold", "lumiverse", "contrast"]
};
function sanitizeSettingsPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "defaultModules" && v && typeof v === "object") {
      const dm = {};
      for (const mk of ["system", "tracker", "dice", "choices"]) {
        if (typeof v[mk] === "boolean") dm[mk] = v[mk];
      }
      out.defaultModules = dm;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SETTINGS_ENUM_KEYS, k)) {
      const allowed = SETTINGS_ENUM_KEYS[k];
      const s = sanitizeString(v, 40).toLowerCase();
      if (allowed ? allowed.includes(s) : Boolean(s)) out[k] = allowed ? s : s;
      continue;
    }
    // Booleans and theme-ish short strings pass through bounded.
    if (typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      out[k] = sanitizeString(v, 200);
      continue;
    }
    // Drop anything else (objects, arrays, functions, numbers outside known keys).
  }
  return out;
}
async function loadSettings(userId) {
  const key = userKey(userId);
  const cached = settingsCache.get(key);
  if (cached) return cached;
  const defaults = createDefaultSettings();
  try {
    const stored = await spindle.userStorage.getJson("settings.json", {
      fallback: defaults,
      userId
    });
    // Keep only keys that still exist (drops settings of removed features) and
    // fall back to the default for retired theme names.
    const merged = { ...defaults };
    for (const k of Object.keys(defaults)) {
      if (stored && stored[k] !== undefined && typeof stored[k] === typeof defaults[k]) merged[k] = stored[k];
    }
    if (!SETTINGS_ENUM_KEYS.theme.includes(merged.theme)) merged.theme = defaults.theme;
    if (!SETTINGS_ENUM_KEYS.allocMode.includes(merged.allocMode)) merged.allocMode = defaults.allocMode;
    merged.defaultModules = {
      ...createDefaultModules(),
      ...stored?.defaultModules || {}
    };
    settingsCache.set(key, merged);
    return merged;
  } catch {
    settingsCache.set(key, defaults);
    return defaults;
  }
}
async function saveSettings(settings, userId) {
  const key = userKey(userId);
  settingsCache.set(key, settings);
  try {
    await spindle.userStorage.setJson("settings.json", settings, { userId });
  } catch (err) {
    spindle.log.warn(`Failed to save settings: ${String(err)}`);
  }
}
async function resolvePersonaName(userId) {
  if (!spindle.permissions.has("personas")) return "Survivor";
  try {
    const active = await spindle.personas.getActive(userId);
    if (active?.name) return active.name;
    const def = await spindle.personas.getDefault(userId);
    if (def?.name) return def.name;
  } catch {
  }
  return "Survivor";
}
async function loadChatData(chatId, userId) {
  const ckey = chatCacheKey(userId, chatId);
  const cached = chatCache.get(ckey);
  if (cached) return cached;
  const settings = await loadSettings(userId);
  const path = `chats/${safeFileSegment(chatId)}.json`;
  try {
    const exists = await spindle.userStorage.exists(path, userId);
    if (exists) {
      const stored = await spindle.userStorage.getJson(path, {
        fallback: null,
        userId
      });
      if (stored && stored.sheet && stored.world) {
        normalizeChatData(stored, settings.defaultModules);
        chatCache.set(ckey, stored);
        return stored;
      }
    }
  } catch (err) {
    spindle.log.warn(`Could not read chat data for ${chatId}: ${String(err)}`);
  }
  const userName = await resolvePersonaName(userId);
  const fresh = createDefaultChatData(chatId, settings.enabledByDefault, userName, settings.defaultModules);
  chatCache.set(ckey, fresh);
  return fresh;
}
async function saveChatData(data, userId) {
  data.updatedAt = Date.now();
  const ckey = chatCacheKey(userId, data.chatId);
  chatCache.set(ckey, data);
  const path = `chats/${safeFileSegment(data.chatId)}.json`;
  try {
    await spindle.userStorage.setJson(path, data, { userId });
  } catch (err) {
    spindle.log.warn(`Failed to save chat ${data.chatId}: ${String(err)}`);
  }
}
function recordSnapshot(data, messageId, swipeId, turnNotices = [], turnRolls = [], choices = null) {
  const key = `${messageId}:${swipeId}`;
  const snap = {
    messageId,
    swipeId,
    timestamp: Date.now(),
    sheet: deepClone(data.sheet),
    world: deepClone(data.world),
    notices: deepClone(turnNotices),
    rolls: deepClone(turnRolls),
    choices: choices ? deepClone(choices) : null
  };
  data.snapshots[key] = snap;
  data.lastSyncedKey = key;
  const keys = Object.keys(data.snapshots);
  if (keys.length > MAX_SNAPSHOTS) {
    keys.sort((a, b) => (data.snapshots[a]?.timestamp || 0) - (data.snapshots[b]?.timestamp || 0));
    for (const oldKey of keys.slice(0, keys.length - MAX_SNAPSHOTS)) {
      delete data.snapshots[oldKey];
    }
  }
}
function refreshLatestSnapshot(data) {
  if (!data.lastSyncedKey) return;
  const snap = data.snapshots[data.lastSyncedKey];
  if (!snap) return;
  snap.sheet = deepClone(data.sheet);
  snap.world = deepClone(data.world);
}
function restoreSnapshot(data, key) {
  const snap = data.snapshots[key];
  if (!snap) return false;
  data.sheet = deepClone(snap.sheet);
  data.world = deepClone(snap.world);
  data.lastSyncedKey = key;
  data.initialized = true;
  normalizeChatData(data);
  return true;
}
function getPermissionFlags() {
  return {
    interceptor: spindle.permissions.has("interceptor"),
    generation: spindle.permissions.has("generation"),
    chats: spindle.permissions.has("chats"),
    chat_mutation: spindle.permissions.has("chat_mutation"),
    characters: spindle.permissions.has("characters"),
    personas: spindle.permissions.has("personas")
  };
}
async function listConnectionsSafe(userId) {
  if (!spindle.permissions.has("generation")) return [];
  try {
    const list = await spindle.connections.list(userId);
    return list.filter((c) => Boolean(c?.id)).map((c) => ({
      id: c.id,
      name: c.name || c.model || c.provider || "Unnamed Connection",
      provider: c.provider || "",
      model: c.model || "",
      isDefault: Boolean(c.is_default)
    }));
  } catch {
    return [];
  }
}
async function pushStateToFrontend(chatId, rawUserId, extra) {
  const userId = rememberUserForChat(chatId, rawUserId);
  const settings = await loadSettings(userId);
  const data = chatId ? await loadChatData(chatId, userId) : null;
  const connections = await listConnectionsSafe(userId);
  const payload = {
    type: "state_update",
    chatId,
    data,
    settings,
    connections,
    permissions: getPermissionFlags(),
    activeConnectionId: activeConnByUser.get(userKey(userId)) || null,
    syncing: chatId ? syncingChats.has(chatCacheKey(userId, chatId)) : false,
    statusNote: extra?.statusNote
  };
  spindle.sendToFrontend(
    payload,
    userId,
    extra?.frontendSessionId ? { frontendSessionId: extra.frontendSessionId } : void 0
  );
}
function extractTextFromGenerationResult(res) {
  if (typeof res === "string") return res;
  if (!res || typeof res !== "object") return "";
  const obj = res;
  const extractContentValue = (val) => {
    if (typeof val === "string") return val;
    if (Array.isArray(val)) {
      return val.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part;
          if (p.type === "text" && typeof p.text === "string") return p.text;
          if (typeof p.text === "string") return p.text;
        }
        return "";
      }).filter(Boolean).join("\n");
    }
    return "";
  };
  const directContent = extractContentValue(obj.content);
  if (directContent) return directContent;
  if (typeof obj.text === "string") return obj.text;
  if (obj.message && typeof obj.message === "object") {
    const mc = extractContentValue(obj.message.content);
    if (mc) return mc;
  }
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0];
    if (first?.message && typeof first.message === "object") {
      const mc = extractContentValue(first.message.content);
      if (mc) return mc;
    }
    if (typeof first?.text === "string") return first.text;
  }
  return "";
}
async function gatherRecentTranscript(chatId, tailCount = 4) {
  if (!spindle.permissions.has("chat_mutation")) {
    return { transcript: "", tailMessageId: null, tailSwipeId: 0, prevMessageKey: null };
  }
  try {
    let msgs = [];
    const supportsLean = Boolean(
      spindle.host?.capabilities?.["chat-lean-messages-v1"]
    );
    if (supportsLean) {
      try {
        msgs = await spindle.chat.getMessages(chatId, {
          tail: tailCount,
          light: true,
          includeExtra: false
        });
      } catch {
        const all = await spindle.chat.getMessages(chatId);
        msgs = all.slice(-tailCount);
      }
    } else {
      const all = await spindle.chat.getMessages(chatId);
      msgs = all.slice(-tailCount);
    }
    if (!msgs || msgs.length === 0) {
      return { transcript: "", tailMessageId: null, tailSwipeId: 0, prevMessageKey: null, tailContent: "", tailIsAi: false };
    }
    const isUserMsg = (m) => typeof m.is_user === "boolean" ? m.is_user : m.role === "user";
    const transcript = msgs.map((m) => `${isUserMsg(m) ? "[PLAYER]" : "[AI]"} ${m.name || ""}: ${m.content || ""}`).join("\n\n");
    const tail = msgs[msgs.length - 1];
    const tailIsAi = !isUserMsg(tail);
    const prevAi = [...msgs.slice(0, -1)].reverse().find((m) => !isUserMsg(m));
    return {
      transcript,
      tailMessageId: tail.id,
      tailSwipeId: tail.swipe_id ?? 0,
      prevMessageKey: prevAi ? `${prevAi.id}:${prevAi.swipe_id ?? 0}` : null,
      tailContent: tailIsAi && typeof tail.content === "string" ? tail.content : "",
      tailIsAi
    };
  } catch (err) {
    spindle.log.warn(`getMessages failed for ${chatId}: ${String(err)}`);
    return { transcript: "", tailMessageId: null, tailSwipeId: 0, prevMessageKey: null, tailContent: "", tailIsAi: false };
  }
}

async function resolveConnectionId(settings, userId) {
  if (settings.sidecarConnectionId && settings.sidecarConnectionId.trim()) {
    return settings.sidecarConnectionId.trim();
  }
  const uiActive = activeConnByUser.get(userKey(userId));
  if (uiActive) return uiActive;
  try {
    const list = await spindle.connections.list(userId);
    const valid = list.filter((c) => Boolean(c?.id && c?.provider));
    const picked = valid.find((c) => c.is_default) || valid.find((c) => c.has_api_key) || valid[0] || list.find((c) => c.is_default) || list[0];
    if (picked?.id) return picked.id;
  } catch {
  }
  return void 0;
}
async function runSidecarLlm(messages, settings, userId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55e3);
  try {
    const connectionId = await resolveConnectionId(settings, userId);
    const quietReq = {
      type: "quiet",
      messages,
      parameters: {
        temperature: 0.15,
        max_tokens: SIDECAR_MAX_TOKENS
      },
      reasoning: { source: "off" },
      signal: controller.signal
    };
    if (userId) quietReq.userId = userId;
    if (connectionId) quietReq.connection_id = connectionId;
    try {
      const result = await spindle.generate.quiet(quietReq);
      return extractTextFromGenerationResult(result);
    } catch (quietErr) {
      if (connectionId) {
        try {
          const rawReq = {
            type: "raw",
            messages,
            connection_id: connectionId,
            parameters: {
              temperature: 0.15,
              max_tokens: SIDECAR_MAX_TOKENS
            },
            reasoning: { source: "off" },
            signal: controller.signal
          };
          if (userId) rawReq.userId = userId;
          const rawResult = await spindle.generate.raw(rawReq);
          return extractTextFromGenerationResult(rawResult);
        } catch {
          throw quietErr;
        }
      }
      const msg = quietErr instanceof Error ? quietErr.message : String(quietErr);
      if (/unknown provider/i.test(msg)) {
        throw new Error(
          "No active LLM connection profile found. Open Settings and select a Sidecar LLM Connection."
        );
      }
      throw quietErr;
    }
  } finally {
    clearTimeout(timer);
  }
}
async function runAiBootstrap(chatId, rawUserId) {
  const userId = rememberUserForChat(chatId, rawUserId);
  if (!spindle.permissions.has("generation")) {
    spindle.toast.warning('Grant the "generation" permission to auto-initialize from your chat.', { userId });
    return;
  }
  const data = await loadChatData(chatId, userId);
  if (!data.modules.system && !data.modules.tracker) {
    spindle.toast.info("Both System and Tracker modules are turned OFF for this chat.", { userId });
    return;
  }
  const ckey = chatCacheKey(userId, chatId);
  if (syncingChats.has(ckey)) return;
  syncingChats.add(ckey);
  await pushStateToFrontend(chatId, userId, { statusNote: "Initializing\u2026" });
  try {
    const settings = await loadSettings(userId);
    let userName = data.sheet.name || "Survivor";
    let personaDesc = "";
    if (spindle.permissions.has("personas")) {
      try {
        const persona = await spindle.personas.getActive(userId) || await spindle.personas.getDefault(userId);
        if (persona) {
          userName = persona.name || userName;
          personaDesc = [persona.title, persona.description].filter(Boolean).join("\n");
        }
      } catch {
      }
    }
    let charName = "World";
    let charDesc = "";
    let scenario = "";
    if (spindle.permissions.has("chats")) {
      try {
        const chatRow = await spindle.chats.get(chatId, userId);
        if (chatRow?.character_id && spindle.permissions.has("characters")) {
          const ch = await spindle.characters.get(chatRow.character_id, userId);
          if (ch) {
            charName = ch.name || charName;
            scenario = ch.scenario || "";
            charDesc = [ch.description, ch.personality, ch.first_mes].filter(Boolean).join("\n\n");
          }
        }
      } catch {
      }
    }
    const { transcript, tailMessageId, tailSwipeId, tailContent } = await gatherRecentTranscript(chatId, 6);
    const promptMsgs = buildInitMessages({
      modules: data.modules,
      userName,
      personaDesc,
      charName,
      charDesc,
      scenario,
      recentTranscript: transcript
    });
    const raw = await runSidecarLlm(promptMsgs, settings, userId);
    const delta = parseJsonDelta(raw);
    if (!delta) {
      spindle.toast.warning("Sidecar returned unreadable JSON during init. Try again or pick another sidecar model in Settings.", {
        userId
      });
      return;
    }
    const freshDefaults = createDefaultChatData(chatId, data.enabled, userName, data.modules);
    if (data.modules.system) data.sheet = freshDefaults.sheet;
    if (data.modules.tracker) data.world = freshDefaults.world;
    data.initialized = false;
    const outcome = applyDelta(data, delta, settings);
    if (tailMessageId) {
      recordSnapshot(data, tailMessageId, tailSwipeId, outcome.notices, [], parseChoicesBlock(tailContent));
    }
    await saveChatData(data, userId);
    spindle.toast.success(
      `Initialized${data.modules.system ? ` ${data.sheet.name} (Lv ${data.sheet.level})` : ""}${data.modules.tracker ? ` \xB7 ${data.world.npcs.length} NPC(s)` : ""}.`,
      { userId }
    );
  } catch (err) {
    spindle.log.error(`Bootstrap error: ${String(err)}`);
    spindle.toast.error(`Init failed: ${err instanceof Error ? err.message : String(err)}`, { userId });
  } finally {
    syncingChats.delete(ckey);
    await pushStateToFrontend(chatId, userId);
  }
}
var syncPromises = new Map(); // chatKey -> in-flight sync, so the interceptor can wait for it
function runDeltaSync(chatId, rawUserId, opts) {
  const userId = rememberUserForChat(chatId, rawUserId);
  const key = chatCacheKey(userId, chatId);
  const p = doDeltaSync(chatId, userId, opts).finally(() => {
    if (syncPromises.get(key) === p) syncPromises.delete(key);
  });
  syncPromises.set(key, p);
  return p;
}
// A new generation must not read state that is one sync behind: wait (bounded)
// for a sync that is still running for this chat.
async function waitForSync(userId, chatId) {
  const p = syncPromises.get(chatCacheKey(userId, chatId));
  if (!p) return;
  let timer;
  await Promise.race([p.catch(() => {}), new Promise((r) => { timer = setTimeout(r, SYNC_WAIT_MS); })]);
  clearTimeout(timer);
}
function isAiMessage(m) {
  return typeof m.is_user === "boolean" ? !m.is_user : m.role !== "user";
}
function latestSnapshotForMessage(data, messageId) {
  let best = null;
  for (const [key, snap] of Object.entries(data.snapshots || {})) {
    if (snap && snap.messageId === messageId && (!best || (snap.timestamp || 0) > (best.snap.timestamp || 0))) {
      best = { key, snap };
    }
  }
  return best;
}
// A swiped/regenerated turn keeps the dice its first attempt was bound to,
// otherwise the redo would silently lose the player's roll.
function carryRolls(data, messageId, fresh, isRedo) {
  if (fresh.length > 0 || !isRedo || !messageId) return fresh;
  const prior = latestSnapshotForMessage(data, messageId);
  return prior && Array.isArray(prior.snap.rolls) ? deepClone(prior.snap.rolls) : fresh;
}
// For swipe/regenerate: the state the turn started from, plus its dice.
async function buildRedoView(data, chatId) {
  if (!spindle.permissions.has("chat_mutation")) return null;
  let msgs = [];
  try {
    msgs = await spindle.chat.getMessages(chatId);
  } catch {
    return null;
  }
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  const last = msgs[msgs.length - 1];
  const target = isAiMessage(last) ? last : null;
  const priorMsgs = target ? msgs.slice(0, -1) : msgs;
  const prev = [...priorMsgs].reverse().find(isAiMessage);
  const prevSnap = prev ? data.snapshots[`${prev.id}:${prev.swipe_id ?? 0}`] : null;
  const view = { ...data };
  if (prevSnap) {
    view.sheet = deepClone(prevSnap.sheet);
    view.world = deepClone(prevSnap.world);
  }
  let rolls = null;
  if (target) {
    const own = latestSnapshotForMessage(data, target.id);
    if (own && Array.isArray(own.snap.rolls) && own.snap.rolls.length > 0) {
      rolls = own.snap.rolls.map((r) => ({ ...r, consumed: false }));
    }
  }
  return { view, rolls };
}
async function doDeltaSync(chatId, userId, opts) {
  if (!spindle.permissions.has("generation")) {
    if (opts?.manual) {
      spindle.toast.warning('Grant the "generation" permission to sync state automatically.', { userId });
    }
    return;
  }
  const settings = await loadSettings(userId);
  const data = await loadChatData(chatId, userId);
  if (!data.enabled) return;
  if (!data.modules.system && !data.modules.tracker) {
    if (opts?.manual) {
      spindle.toast.info("Both System and Tracker modules are OFF for this chat.", { userId });
    }
    return;
  }
  if (!data.initialized) {
    await runAiBootstrap(chatId, userId);
    return;
  }
  const ckey = chatCacheKey(userId, chatId);
  if (syncingChats.has(ckey)) return;
  syncingChats.add(ckey);
  await pushStateToFrontend(chatId, userId, { statusNote: "Syncing turn…" });
  try {
    const { transcript, tailMessageId, tailSwipeId, tailContent, prevMessageKey } = await gatherRecentTranscript(chatId, 4);
    const effectiveMsgId = opts?.messageId || tailMessageId;
    const choices = parseChoicesBlock(tailContent || opts?.fallbackContent || "");
    if (opts?.isSwipeOrRegen && prevMessageKey && data.snapshots[prevMessageKey]) {
      restoreSnapshot(data, prevMessageKey);
    }
    const effectiveTranscript = transcript || (opts?.fallbackContent ? `[AI]: ${opts.fallbackContent}` : "");
    if (!effectiveTranscript.trim()) return;
    const promptMsgs = buildDeltaMessages(data, effectiveTranscript, settings);
    let raw = "";
    let sidecarError = null;
    let delta = null;
    try {
      raw = await runSidecarLlm(promptMsgs, settings, userId);
      delta = parseJsonDelta(raw);
    } catch (err) {
      sidecarError = err;
    }
    if (!delta) {
      // One corrective retry: many small models recover when told what went wrong.
      try {
        const retryMsgs = [
          ...promptMsgs,
          { role: "assistant", content: String(raw || "(empty response)").slice(0, 3000) },
          { role: "user", content: "That was not valid JSON. Return ONLY the JSON object described above — no prose, no markdown fences, no commentary. If nothing changed, return {}." }
        ];
        delta = parseJsonDelta(await runSidecarLlm(retryMsgs, settings, userId));
        if (delta) sidecarError = null;
      } catch (err2) {
        if (!sidecarError) sidecarError = err2;
      }
    }
    const isRedo = Boolean(opts?.isSwipeOrRegen);
    if (!delta) {
      // The <choices> card does not depend on the sidecar — keep it for this turn.
      if (effectiveMsgId && choices) {
        recordSnapshot(data, effectiveMsgId, tailSwipeId, [], carryRolls(data, effectiveMsgId, [], isRedo), choices);
      }
      const errMsg = sidecarError
        ? `Sidecar call failed: ${sidecarError instanceof Error ? sidecarError.message : String(sidecarError)}`
        : "Sidecar returned unparseable JSON twice.";
      noteSyncOutcome(data, false, errMsg);
      await saveChatData(data, userId);
      if (opts?.manual) {
        spindle.toast.warning(`Sync failed — ${errMsg}`, { userId });
      }
      return;
    }
    const outcome = applyDelta(data, delta, settings);
    const resolvedThisTurn = [];
    for (const r of data.rolls) {
      if (!r.consumed) {
        r.consumed = true;
        if (effectiveMsgId) r.messageId = effectiveMsgId;
        resolvedThisTurn.push(r);
      }
    }
    if (effectiveMsgId) {
      recordSnapshot(data, effectiveMsgId, tailSwipeId, outcome.notices, carryRolls(data, effectiveMsgId, resolvedThisTurn, isRedo), choices);
    }
    noteSyncOutcome(data, true);
    await saveChatData(data, userId);
    if (outcome.leveledUp) {
      spindle.toast.success(
        `${data.sheet.name} reached Level ${outcome.newLevel}! (+${outcome.ptsGained} stat pts, +25% recovery)`,
        { title: "LEVEL UP", duration: 6e3, userId }
      );
    } else if (opts?.manual || resolvedThisTurn.length > 0) {
      spindle.toast.info(outcome.summary, { title: "Synced", duration: 3500, userId });
    }
  } catch (err) {
    spindle.log.error(`Delta sync failed for ${chatId}: ${String(err)}`);
    try {
      noteSyncOutcome(data, false, err instanceof Error ? err.message : String(err));
      await saveChatData(data, userId);
    } catch (saveErr) {
      spindle.log.warn(`Could not persist sync failure state: ${String(saveErr)}`);
    }
    if (opts?.manual) {
      spindle.toast.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`, { userId });
    }
  } finally {
    syncingChats.delete(ckey);
    await pushStateToFrontend(chatId, userId);
  }
}
function ensureInterceptorRegistered() {
  if (!spindle.permissions.has("interceptor")) {
    if (interceptorDisposer) {
      interceptorDisposer();
      interceptorDisposer = null;
    }
    return;
  }
  if (interceptorDisposer) return;
  interceptorDisposer = spindle.registerInterceptor(
    async (messages, context) => {
      if (!context.chatId) return messages;
      rememberUserForChat(context.chatId, context.userId);
      const dispatchedConnId = context.mainDispatch?.descriptor?.connectionId;
      if (dispatchedConnId && context.userId) {
        activeConnByUser.set(userKey(context.userId), dispatchedConnId);
      }
      if (context.generationType === "quiet" || context.generationType === "impersonate") {
        return messages;
      }
      const settings = await loadSettings(context.userId);
      await waitForSync(context.userId, context.chatId);
      const data = await loadChatData(context.chatId, context.userId);
      let view = data;
      let rolls = null;
      if (context.generationType === "swipe" || context.generationType === "regenerate") {
        // Redo: show the model the state the turn started from (not the state
        // the discarded reply produced) and keep that turn's dice bound.
        const redo = await buildRedoView(data, context.chatId);
        if (redo) {
          view = redo.view;
          rolls = redo.rolls;
        }
      }
      const block = buildPromptBlock(view, settings, rolls ? { rolls } : {});
      if (!block) return messages;
      const out = [...messages];
      let insertIdx = out.length;
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].role === "user") {
          insertIdx = i;
          break;
        }
      }
      out.splice(insertIdx, 0, { role: "system", content: block });
      return {
        messages: out,
        breakdown: [{ messageIndex: insertIdx, name: "Weft Chronicle State" }]
      };
    },
    40
  );
}
ensureInterceptorRegistered();
spindle.on("PERMISSION_CHANGED", () => {
  ensureInterceptorRegistered();
  for (const [uid, chatId] of activeChatByUser.entries()) {
    void pushStateToFrontend(chatId, uid === "__default__" ? void 0 : uid);
  }
});
spindle.on("CONNECTION_PROFILE_LOADED", (payload, rawUserId) => {
  const obj = payload || {};
  const connId = typeof obj.connectionId === "string" ? obj.connectionId : typeof obj.profileId === "string" ? obj.profileId : typeof obj.id === "string" ? obj.id : null;
  const userId = rememberUserForChat(null, rawUserId);
  if (connId && userId) {
    activeConnByUser.set(userKey(userId), connId);
  }
});
spindle.on("CHAT_SWITCHED", async (payload, rawUserId) => {
  const obj = payload || {};
  const chatId = typeof obj.chatId === "string" ? obj.chatId : typeof obj.id === "string" ? obj.id : null;
  if (!chatId) return;
  const userId = rememberUserForChat(chatId, rawUserId);
  activeChatByUser.set(userKey(userId), chatId);
  await pushStateToFrontend(chatId, userId);
});
spindle.on("CHAT_FORKED", async (payload, rawUserId) => {
  try {
    const userId = rememberUserForChat(payload.sourceChatId, rawUserId);
    rememberUserForChat(payload.forkedChatId, userId);
    const src = await loadChatData(payload.sourceChatId, userId);
    const forked = deepClone(src);
    forked.chatId = payload.forkedChatId;
    const matchKey = Object.keys(src.snapshots).filter((k) => k.startsWith(`${payload.forkedAtMessageId}:`)).sort((a, b) => (src.snapshots[b]?.timestamp || 0) - (src.snapshots[a]?.timestamp || 0))[0];
    if (matchKey) {
      restoreSnapshot(forked, matchKey);
    }
    await saveChatData(forked, userId);
    spindle.log.info(`Copied Weft Chronicle state from ${payload.sourceChatId} to fork ${payload.forkedChatId}`);
  } catch (err) {
    spindle.log.warn(`CHAT_FORKED state copy failed: ${String(err)}`);
  }
});
spindle.on("MESSAGE_SWIPED", async (payload, rawUserId) => {
  if (!payload?.chatId || !payload.message?.id) return;
  const userId = rememberUserForChat(payload.chatId, rawUserId);
  if (payload.action === "navigated") {
    const data = await loadChatData(payload.chatId, userId);
    const key = `${payload.message.id}:${payload.swipeId}`;
    if (restoreSnapshot(data, key)) {
      await saveChatData(data, userId);
      await pushStateToFrontend(payload.chatId, userId, {
        statusNote: `Restored swipe #${payload.swipeId + 1}`
      });
    }
  }
});
spindle.on("MESSAGE_DELETED", async (payload, rawUserId) => {
  const obj = payload || {};
  const chatId = typeof obj.chatId === "string" ? obj.chatId : activeChatByUser.get(userKey(rawUserId));
  if (!chatId) return;
  const userId = rememberUserForChat(chatId, rawUserId);
  const data = await loadChatData(chatId, userId);
  // Snapshots belong to AI messages, so rewind to the newest remaining AI
  // message that has one (the tail of the chat is usually the player's message).
  let msgs = [];
  try {
    msgs = await spindle.chat.getMessages(chatId);
  } catch {
    return;
  }
  for (let i = (Array.isArray(msgs) ? msgs.length : 0) - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || !isAiMessage(m)) continue;
    const key = `${m.id}:${m.swipe_id ?? 0}`;
    if (!data.snapshots[key]) continue;
    if (restoreSnapshot(data, key)) {
      await saveChatData(data, userId);
      await pushStateToFrontend(chatId, userId, { statusNote: "Rewound after delete" });
    }
    return;
  }
});
spindle.on("GENERATION_ENDED", async (payload, rawUserId) => {
  if (!payload?.chatId || payload.error) return;
  if (payload.generationType === "impersonate" || payload.generationType === "quiet") return;
  const userId = rememberUserForChat(payload.chatId, rawUserId);
  const settings = await loadSettings(userId);
  const data = await loadChatData(payload.chatId, userId);
  if (!data.enabled) return;
  const isSwipeOrRegen = payload.generationType === "swipe" || payload.generationType === "regenerate";
  if (!(settings.autoSync && (data.modules.system || data.modules.tracker))) {
    // No sidecar: still resolve the dice and keep the <choices> card.
    const resolved = [];
    for (const r of data.rolls) {
      if (!r.consumed) {
        r.consumed = true;
        if (payload.messageId) r.messageId = payload.messageId;
        resolved.push(r);
      }
    }
    const choicesOnly = payload.messageId ? parseChoicesBlock(payload.content || "") : null;
    if (payload.messageId && (resolved.length > 0 || choicesOnly || isSwipeOrRegen)) {
      // GENERATION_ENDED carries no swipe_id — look the message up so
      // swipe/fork undo restores the correct per-swipe snapshot.
      let swipeId = 0;
      try {
        const msgs = await spindle.chat.getMessages(payload.chatId);
        const m = (Array.isArray(msgs) ? msgs : []).find((x) => x && x.id === payload.messageId);
        if (m && Number.isFinite(m.swipe_id)) swipeId = m.swipe_id;
      } catch {
        // keep swipeId 0 if the lookup is unavailable
      }
      const rolls = carryRolls(data, payload.messageId, resolved, isSwipeOrRegen);
      if (rolls.length > 0 || choicesOnly) recordSnapshot(data, payload.messageId, swipeId, [], rolls, choicesOnly);
      await saveChatData(data, userId);
      await pushStateToFrontend(payload.chatId, userId);
    }
    return;
  }
  void runDeltaSync(payload.chatId, userId, {
    messageId: payload.messageId,
    fallbackContent: payload.content,
    isSwipeOrRegen,
    manual: false
  });
});
spindle.onFrontendMessage(async (rawPayload, userId, frontendSessionId) => {
  if (!rawPayload || typeof rawPayload !== "object") return;
  const msg = rawPayload;
  const type = typeof msg.type === "string" ? msg.type : "";
  const reqChatId = typeof msg.chatId === "string" && msg.chatId ? msg.chatId : null;
  const activeChatId = reqChatId || activeChatByUser.get(userKey(userId)) || null;
  if (reqChatId) {
    activeChatByUser.set(userKey(userId), reqChatId);
    rememberUserForChat(reqChatId, userId);
  } else {
    rememberUserForChat(null, userId);
  }
  if (typeof msg.activeConnectionId === "string" && msg.activeConnectionId.trim()) {
    activeConnByUser.set(userKey(userId), msg.activeConnectionId.trim());
  }
  try {
    switch (type) {
      case "bootstrap": {
        let resolvedChatId = activeChatId;
        if (!resolvedChatId && spindle.permissions.has("chats")) {
          try {
            const active = await spindle.chats.getActive(userId);
            if (active?.id) {
              resolvedChatId = active.id;
              activeChatByUser.set(userKey(userId), active.id);
              rememberUserForChat(active.id, userId);
            }
          } catch {
          }
        }
        await pushStateToFrontend(resolvedChatId, userId, { frontendSessionId });
        return;
      }
      case "update_settings": {
        const patch = sanitizeSettingsPatch(msg.patch || {});
        const current = await loadSettings(userId);
        const next = {
          ...current,
          ...patch,
          defaultModules: {
            ...current.defaultModules,
            ...patch.defaultModules || {}
          }
        };
        await saveSettings(next, userId);
        await pushStateToFrontend(activeChatId, userId, { statusNote: "Settings saved" });
        return;
      }
      case "toggle_chat_enabled": {
        if (!activeChatId) return;
        const data = await loadChatData(activeChatId, userId);
        data.enabled = Boolean(msg.enabled);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "toggle_module": {
        if (!activeChatId) return;
        const mod = msg.module;
        if (mod !== "system" && mod !== "tracker" && mod !== "dice" && mod !== "choices") return;
        const data = await loadChatData(activeChatId, userId);
        data.modules[mod] = Boolean(msg.enabled);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId, {
          statusNote: `${mod[0].toUpperCase() + mod.slice(1)} ${data.modules[mod] ? "ON" : "OFF"}`
        });
        return;
      }
      case "allocate_stat": {
        if (!activeChatId) return;
        const stat = msg.stat;
        const amount = typeof msg.amount === "number" ? msg.amount : 1;
        const data = await loadChatData(activeChatId, userId);
        const res = allocateStatPoint(data.sheet, stat, amount);
        if (!res.ok) {
          spindle.toast.warning(res.reason || "Cannot allocate stat.", { userId });
          return;
        }
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "auto_allocate": {
        if (!activeChatId) return;
        const settings = await loadSettings(userId);
        const data = await loadChatData(activeChatId, userId);
        const note = autoAllocateAllPoints(data.sheet, settings.allocPriority);
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId, { statusNote: note });
        return;
      }
      case "update_stat": {
        if (!activeChatId) return;
        const stat = msg.stat;
        const value = Number(msg.value);
        if (!Number.isFinite(value)) return;
        const data = await loadChatData(activeChatId, userId);
        data.sheet.stats[stat] = clamp(value, 1, 99);
        recomputeSheetPools(data.sheet, { raiseCurrentByMaxDelta: true });
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "adjust_pool": {
        if (!activeChatId) return;
        const pool = msg.pool;
        const deltaVal = Number(msg.delta);
        if (!Number.isFinite(deltaVal)) return;
        const data = await loadChatData(activeChatId, userId);
        if (pool === "hp") data.sheet.hp = clamp(data.sheet.hp + deltaVal, 0, data.sheet.hpMax);
        if (pool === "sp") data.sheet.sp = clamp(data.sheet.sp + deltaVal, 0, data.sheet.spMax);
        if (pool === "mp") data.sheet.mp = clamp(data.sheet.mp + deltaVal, 0, data.sheet.mpMax);
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "rest": {
        if (!activeChatId) return;
        const kind = msg.kind === "long" ? "long" : "short";
        const settings = await loadSettings(userId);
        const data = await loadChatData(activeChatId, userId);
        applyDelta(data, { sheet: { rest: kind } }, settings);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId, {
          statusNote: kind === "long" ? "Long rest applied" : "Short rest applied"
        });
        return;
      }
      case "add_xp": {
        if (!activeChatId) return;
        const amount = Number(msg.amount);
        if (!Number.isFinite(amount) || amount <= 0) return;
        const settings = await loadSettings(userId);
        const data = await loadChatData(activeChatId, userId);
        const outcome = applyDelta(data, { sheet: { xpGain: Math.floor(amount) } }, settings);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        if (outcome.leveledUp) {
          spindle.toast.success(`LEVEL UP! ${data.sheet.name} is now Lv ${outcome.newLevel} (+${outcome.ptsGained} pts).`, {
            title: "LEVEL UP",
            userId
          });
        }
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "dismiss_notice": {
        if (!activeChatId) return;
        const ids = Array.isArray(msg.ids)
          ? msg.ids.map((x) => sanitizeString(String(x), 48)).filter(Boolean)
          : typeof msg.ids === "string"
            ? msg.ids.split(",").map((s) => s.trim()).filter(Boolean)
            : [sanitizeString(String(msg.id || ""), 48)].filter(Boolean);
        if (ids.length === 0) return;
        const data = await loadChatData(activeChatId, userId);
        const before = data.notices.length;
        data.notices = data.notices.filter((n) => !ids.includes(n.id));
        if (data.notices.length !== before) await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "clear_notices": {
        if (!activeChatId) return;
        const data = await loadChatData(activeChatId, userId);
        data.notices = [];
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "update_identity": {
        if (!activeChatId) return;
        const patch = msg.patch || {};
        const data = await loadChatData(activeChatId, userId);
        const s = data.sheet;
        if (typeof patch.name === "string") s.name = sanitizeString(patch.name, 60) || s.name;
        if (typeof patch.race === "string") s.race = sanitizeString(patch.race, 60);
        if (typeof patch.cls === "string") s.cls = sanitizeString(patch.cls, 60);
        if (typeof patch.subcls === "string") s.subcls = sanitizeString(patch.subcls, 60);
        if (typeof patch.rank === "string") s.rank = sanitizeString(patch.rank, 40);
        if (typeof patch.guild === "string") s.guild = sanitizeString(patch.guild, 60);
        if (typeof patch.title === "string") s.title = sanitizeString(patch.title, 60);
        if (typeof patch.cash === "string") s.cash = sanitizeString(patch.cash, 60);
        if (typeof patch.useMp === "boolean") s.useMp = patch.useMp;
        if (typeof patch.mpLabel === "string" && patch.mpLabel.trim()) s.mpLabel = sanitizeString(patch.mpLabel, 24) || "MP";
        if (patch.statLabels && typeof patch.statLabels === "object") {
          const next = {};
          for (const k of STAT_KEYS) {
            const v = typeof patch.statLabels[k] === "string" ? patch.statLabels[k].trim().slice(0, 24) : "";
            next[k] = v || DEFAULT_STAT_LABELS[k];
          }
          s.statLabels = next;
        }
        if (typeof patch.level === "number" && Number.isFinite(patch.level)) {
          s.level = clamp(patch.level, 1, 999);
          recomputeSheetPools(s, { raiseCurrentByMaxDelta: true });
        }
        if (typeof patch.pts === "number" && Number.isFinite(patch.pts)) {
          s.pts = clamp(patch.pts, 0, 999);
        }
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "add_item": {
        if (!activeChatId) return;
        const item = msg.item || {};
        if (!item.name?.trim()) return;
        const data = await loadChatData(activeChatId, userId);
        addItemToBag(data.sheet, {
          name: item.name.trim(),
          category: item.category || "misc",
          rarity: item.rarity || "ordinary",
          qty: item.qty || 1,
          note: item.note || ""
        });
        if (item.equip) {
          const added = data.sheet.bag.find((x) => x.name.toLowerCase() === item.name.trim().toLowerCase());
          if (added) equipItem(data.sheet, added.id);
        }
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "update_item": {
        if (!activeChatId) return;
        const item = msg.item || {};
        if (!item.id || !item.name?.trim()) return;
        const data = await loadChatData(activeChatId, userId);
        const existing = data.sheet.bag.find((x) => x.id === item.id);
        if (!existing) return;
        existing.name = item.name.trim();
        if (item.category) existing.category = item.category;
        if (item.rarity) existing.rarity = item.rarity;
        if (typeof item.qty === "number" && Number.isFinite(item.qty)) {
          existing.qty = clamp(item.qty, 1, 9999);
        }
        if (item.note !== void 0) existing.note = item.note.trim();
        if (item.equip) equipItem(data.sheet, existing.id);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "remove_item": {
        if (!activeChatId) return;
        const id = String(msg.id || "");
        const qty = typeof msg.qty === "number" ? msg.qty : 1;
        const data = await loadChatData(activeChatId, userId);
        removeItemFromBag(data.sheet, id, qty);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "equip_item": {
        if (!activeChatId) return;
        const data = await loadChatData(activeChatId, userId);
        equipItem(data.sheet, String(msg.id || ""));
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "unequip_slot": {
        if (!activeChatId) return;
        const slot = msg.slot;
        const data = await loadChatData(activeChatId, userId);
        unequipSlot(data.sheet, slot);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "add_effect": {
        if (!activeChatId) return;
        const ef = msg.effect || {};
        if (!ef.name?.trim()) return;
        const data = await loadChatData(activeChatId, userId);
        data.sheet.effects.push({
          id: makeId("fx"),
          name: ef.name.trim(),
          kind: ef.kind || "neutral",
          duration: typeof ef.duration === "number" ? ef.duration : null,
          note: ef.note || ""
        });
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "remove_effect": {
        if (!activeChatId) return;
        const id = String(msg.id || "");
        const data = await loadChatData(activeChatId, userId);
        data.sheet.effects = data.sheet.effects.filter((e) => e.id !== id);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "add_skill": {
        if (!activeChatId) return;
        const sk = msg.skill || {};
        if (!sk.name?.trim()) return;
        const data = await loadChatData(activeChatId, userId);
        data.sheet.skills.push({
          id: makeId("sk"),
          name: sanitizeString(sk.name, 80),
          cost: sanitizeString(sk.cost, 60),
          note: sanitizeString(sk.note, 200),
          bonus: clamp(Number(sk.bonus) || 0, -3, 3)
        });
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "remove_skill": {
        if (!activeChatId) return;
        const id = String(msg.id || "");
        const data = await loadChatData(activeChatId, userId);
        data.sheet.skills = data.sheet.skills.filter((s) => s.id !== id);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "upsert_quest": {
        if (!activeChatId) return;
        const q = msg.quest || {};
        if (!q.title?.trim()) return;
        const data = await loadChatData(activeChatId, userId);
        const existing = q.id ? data.sheet.quests.find((x) => x.id === q.id) : null;
        if (existing) {
          existing.title = q.title.trim();
          if (q.kind) existing.kind = q.kind;
          if (q.status) existing.status = q.status;
          if (q.reward !== void 0) existing.reward = q.reward;
          if (q.penalty !== void 0) existing.penalty = q.penalty;
          if (Array.isArray(q.objectives)) existing.objectives = q.objectives;
        } else {
          data.sheet.quests.push({
            id: makeId("q"),
            title: q.title.trim(),
            kind: q.kind || "side",
            status: q.status || "active",
            objectives: Array.isArray(q.objectives) ? q.objectives : [],
            reward: q.reward || "",
            penalty: q.penalty || ""
          });
        }
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "toggle_objective": {
        if (!activeChatId) return;
        const qid = String(msg.questId || "");
        const oid = String(msg.objectiveId || "");
        const data = await loadChatData(activeChatId, userId);
        const quest = data.sheet.quests.find((x) => x.id === qid);
        const obj = quest?.objectives.find((o) => o.id === oid);
        if (obj) obj.done = !obj.done;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "remove_quest": {
        if (!activeChatId) return;
        const id = String(msg.id || "");
        const data = await loadChatData(activeChatId, userId);
        data.sheet.quests = data.sheet.quests.filter((q) => q.id !== id);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "update_world": {
        if (!activeChatId) return;
        const patch = msg.patch || {};
        const data = await loadChatData(activeChatId, userId);
        if (typeof patch.location === "string") data.world.location = patch.location.trim();
        if (typeof patch.time === "string") data.world.time = patch.time.trim();
        if (typeof patch.weather === "string") data.world.weather = patch.weather.trim();
        if (typeof patch.mood === "string") data.world.mood = patch.mood.trim();
        if (typeof patch.arc === "string") data.world.arc = patch.arc.trim();
        if (typeof patch.phase === "string") data.world.phase = patch.phase.trim();
        if (typeof patch.notes === "string") data.world.notes = patch.notes.trim();
        if (typeof patch.dayCount === "number" && Number.isFinite(patch.dayCount)) {
          data.world.dayCount = clamp(patch.dayCount, 1, 99999);
        }
        if (patch.pc && typeof patch.pc === "object") {
          const pc = data.world.pc && typeof data.world.pc === "object" ? data.world.pc : data.world.pc = { outfit: "", pos: "", cond: "", carry: "" };
          for (const k of ["outfit", "pos", "cond", "carry"]) {
            if (typeof patch.pc[k] === "string") pc[k] = sanitizeString(patch.pc[k], 160);
          }
        }
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "upsert_npc": {
        if (!activeChatId) return;
        const npc = msg.npc || {};
        if (!npc.name?.trim()) return;
        const data = await loadChatData(activeChatId, userId);
        const existing = npc.id ? data.world.npcs.find((n) => n.id === npc.id) : data.world.npcs.find((n) => n.name.toLowerCase() === npc.name.trim().toLowerCase());
        if (existing) {
          existing.name = npc.name.trim();
          if (npc.role !== void 0) existing.role = npc.role;
          if (npc.present !== void 0) existing.present = Boolean(npc.present);
          if (npc.location !== void 0) existing.location = npc.location;
          if (npc.mood !== void 0) existing.mood = npc.mood;
          if (npc.attitude !== void 0) existing.attitude = npc.attitude;
          if (typeof npc.bond === "number") existing.bond = clamp(npc.bond, 0, 100);
          if (typeof npc.spark === "number") existing.spark = clamp(npc.spark, 0, 100);
          if (typeof npc.heat === "number") existing.heat = clamp(npc.heat, 0, 100);
          if (npc.goal !== void 0) existing.goal = npc.goal;
          if (npc.secret !== void 0) existing.secret = npc.secret;
          if (npc.lastThought !== void 0) existing.lastThought = npc.lastThought;
        } else {
          const bond = typeof npc.bond === "number" ? clamp(npc.bond, 0, 100) : NEW_NPC_BOND;
          data.world.npcs.push({
            id: makeId("npc"),
            name: npc.name.trim(),
            role: npc.role || "",
            present: npc.present ?? true,
            location: npc.location || data.world.location,
            mood: npc.mood || npc.attitude || "Guarded",
            attitude: npc.attitude || npc.mood || "Wary",
            bond,
            spark: clamp(npc.spark ?? 0, 0, 100),
            heat: clamp(npc.heat ?? 0, 0, 100),
            goal: npc.goal || "",
            secret: npc.secret || "",
            lastThought: npc.lastThought || ""
          });
        }
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "remove_npc": {
        if (!activeChatId) return;
        const id = String(msg.id || "");
        const data = await loadChatData(activeChatId, userId);
        data.world.npcs = data.world.npcs.filter((n) => n.id !== id);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "upsert_thread": {
        if (!activeChatId) return;
        const th = msg.thread || {};
        if (!th.title?.trim()) return;
        const data = await loadChatData(activeChatId, userId);
        const existing = th.id ? data.world.threads.find((t) => t.id === th.id) : null;
        if (existing) {
          existing.title = sanitizeString(th.title, 160);
          if (th.status) existing.status = sanitizeString(th.status, 30).toLowerCase();
          if (th.detail !== void 0) existing.detail = sanitizeString(th.detail, 500);
          if (th.kind === "timer") {
            existing.kind = "timer";
            existing.turnsLeft = clamp(Number(th.turnsLeft) || 1, 0, 99);
          }
        } else {
          const entry = {
            id: makeId("th"),
            title: sanitizeString(th.title, 160),
            status: sanitizeString(th.status, 30).toLowerCase() || "active",
            detail: sanitizeString(th.detail, 500)
          };
          if (th.kind === "timer") {
            entry.kind = "timer";
            entry.turnsLeft = clamp(Number(th.turnsLeft) || 1, 1, 99);
          }
          data.world.threads.push(entry);
        }
        if (data.world.threads.length > 14) data.world.threads = data.world.threads.slice(-14);
        data.initialized = true;
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "remove_thread": {
        if (!activeChatId) return;
        const id = String(msg.id || "");
        const data = await loadChatData(activeChatId, userId);
        data.world.threads = data.world.threads.filter((t) => t.id !== id);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "roll_dice": {
        if (!activeChatId) return;
        const settings = await loadSettings(userId);
        const data = await loadChatData(activeChatId, userId);
        const record = performDiceRoll(data.sheet, {
          action: (typeof msg.action === "string" ? msg.action.trim().slice(0, 160) : "") || "Attempt check",
          stat: msg.stat,
          dc: typeof msg.dc === "number" && Number.isFinite(msg.dc) ? msg.dc : 15,
          gearBonus: typeof msg.gearBonus === "number" && Number.isFinite(msg.gearBonus) ? msg.gearBonus : 0,
          skillBonus: typeof msg.skillBonus === "number" && Number.isFinite(msg.skillBonus) ? msg.skillBonus : 0,
          skillLabel: typeof msg.skillLabel === "string" ? msg.skillLabel.slice(0, 60) : "",
          mode: typeof msg.mode === "string" ? msg.mode : "normal",
          who: (typeof msg.who === "string" && msg.who.trim() ? msg.who.trim().slice(0, 60) : data.sheet.name)
        });
        data.rolls.unshift(record);
        if (data.rolls.length > MAX_HISTORY_ROLLS) {
          data.rolls = data.rolls.slice(0, MAX_HISTORY_ROLLS);
        }
        await saveChatData(data, userId);
        spindle.toast.info(
          `d20=${record.roll} \u2192 Total ${record.total} vs DC ${record.dc}: ${record.verdict.toUpperCase()}`,
          { title: `Roll \xB7 ${record.action}`, duration: 5e3, userId }
        );
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "clear_pending_rolls": {
        if (!activeChatId) return;
        const data = await loadChatData(activeChatId, userId);
        for (const r of data.rolls) r.consumed = true;
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "clear_roll_history": {
        if (!activeChatId) return;
        const data = await loadChatData(activeChatId, userId);
        data.rolls = [];
        await saveChatData(data, userId);
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
      case "init_from_ai": {
        if (!activeChatId) return;
        void runAiBootstrap(activeChatId, userId);
        return;
      }
      case "sync_now": {
        if (!activeChatId) return;
        void runDeltaSync(activeChatId, userId, { manual: true });
        return;
      }
      case "reset_chat": {
        if (!activeChatId) return;
        const settings = await loadSettings(userId);
        const userName = await resolvePersonaName(userId);
        const fresh = createDefaultChatData(
          activeChatId,
          settings.enabledByDefault,
          userName,
          settings.defaultModules
        );
        await saveChatData(fresh, userId);
        await pushStateToFrontend(activeChatId, userId, { statusNote: "Chat state reset" });
        return;
      }
      case "choice_claim": {
        if (!activeChatId) return;
        const key = typeof msg.key === "string" ? msg.key : "";
        const index = Number(msg.index);
        const data = await loadChatData(activeChatId, userId);
        const snap = data.snapshots?.[key];
        if (!snap || !snap.choices || !Array.isArray(snap.choices.options)) return;
        if (!Number.isInteger(index) || index < 0 || index >= snap.choices.options.length) return;
        if (!Array.isArray(snap.choices.claimed)) snap.choices.claimed = [];
        if (!snap.choices.claimed.includes(index)) {
          snap.choices.claimed.push(index);
          await saveChatData(data, userId);
        }
        await pushStateToFrontend(activeChatId, userId, {
          statusNote: `Choice sent: ${String(snap.choices.options[index]?.text || "").slice(0, 80)}`
        });
        return;
      }
      case "choice_feedback": {
        if (!activeChatId) return;
        const kind = typeof msg.kind === "string" ? msg.kind : "";
        if (kind === "copied") {
          spindle.toast.info("Choice copied to the clipboard — paste it into the composer and press Send.", { userId });
        } else if (kind === "busy") {
          spindle.toast.warning("A generation is still running — try the choice again when it finishes.", { userId });
        } else if (kind === "error") {
          spindle.toast.error("Could not send or copy the choice. Check the composer and try again.", { userId });
        }
        return;
      }
      case "import_json": {
        if (!activeChatId) return;
        const raw = typeof msg.json === "string" ? msg.json : "";
        if (raw.length > MAX_IMPORT_BYTES) {
          spindle.toast.error("Backup is too large to import.", { userId });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          spindle.toast.error("Backup is not valid JSON.", { userId });
          return;
        }
        // Accept the versioned envelope ({ format, version, sheet, world }) or legacy raw exports.
        const state = sanitizeImportedState(parsed);
        if (!state) {
          spindle.toast.error("Invalid Weft Chronicle backup (missing sheet/world).", { userId });
          return;
        }
        const data = await loadChatData(activeChatId, userId);
        data.sheet = state.sheet;
        data.world = state.world;
        data.rolls = state.rolls;
        if (state.notices.length > 0) data.notices = state.notices;
        data.initialized = true;
        normalizeChatData(data);
        refreshLatestSnapshot(data);
        await saveChatData(data, userId);
        spindle.toast.success("Imported Weft Chronicle state.", { userId });
        await pushStateToFrontend(activeChatId, userId);
        return;
      }
    }
  } catch (err) {
    spindle.log.error(`RPC ${type} failed: ${String(err)}`);
    spindle.toast.error(`Action failed: ${err instanceof Error ? err.message : String(err)}`, { userId });
  }
});
spindle.log.info("Weft Chronicle v2 backend initialized.");
