"use strict";
// End-to-end RPC flows against the mocked host: import bootstrap, dice resolution,
// notice dismissal, edit-lease sidecar suppression.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockHost, loadBackendWithHost } = require("./mock-host.js");

function fresh() {
  const host = createMockHost();
  loadBackendWithHost(host);
  return host;
}
const flush = async (n = 60) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

const VALID_IMPORT = JSON.stringify({
  format: "weft-chronicle", version: 3,
  sheet: { name: "Test Hero", level: 2, stats: { str: 7, dex: 7, int: 5, cha: 5, con: 6, wis: 5 } },
  world: { location: "Port Ryujin" },
});

async function freshInitialized() {
  const host = fresh();
  const handler = host.getFrontendHandler();
  await handler({ type: "bootstrap" }, "user1", "session1");
  await flush();
  await handler({ type: "import_json", json: VALID_IMPORT }, "user1", "session1");
  await flush();
  return host;
}

const AI_MSG = 'You ease the door open. The hinges scream.\n<choices th="sakura">\n<c k="action">*Force the door* "Quietly" || too loud || needs a crowbar</c>\n</choices>';

test("GENERATION_ENDED records snapshot with choices + swipe_id key", async () => {
  const host = await freshInitialized();
  host.spindle.chat.getMessages = async () => [{ id: "m2", role: "assistant", content: AI_MSG, is_user: false, swipe_id: 3 }];
  await host.handlers["GENERATION_ENDED"]({ chatId: "chat1", messageId: "m2", error: null, generationType: "normal", content: AI_MSG }, "user1");
  await flush();
  const data = host.store.get("chats/chat1.json");
  assert.ok(data.snapshots, "snapshots recorded");
  const keys = Object.keys(data.snapshots);
  assert.deepEqual(keys, ["m2:3"]);
  assert.equal(data.snapshots["m2:3"].choices.options.length, 1);
  assert.equal(data.snapshots["m2:3"].choices.options[0].kind, "action");
});

test("roll_dice → GENERATION_ENDED marks roll consumed with messageId", async () => {
  const host = await freshInitialized();
  const handler = host.getFrontendHandler();
  await handler({ type: "roll_dice", action: "Pick the lock", stat: "dex", dc: 15 }, "user1", "session1");
  await flush();
  let data = host.store.get("chats/chat1.json");
  assert.equal(data.rolls.length, 1);
  assert.equal(data.rolls[0].consumed, false);
  await host.handlers["GENERATION_ENDED"]({ chatId: "chat1", messageId: "m9", error: null, generationType: "normal", content: "The lock clicks." }, "user1");
  await flush();
  data = host.store.get("chats/chat1.json");
  assert.equal(data.rolls[0].consumed, true);
  assert.equal(data.rolls[0].messageId, "m9");
});

test("import_json: garbage persists nothing; valid export initializes", async () => {
  const host = fresh();
  const handler = host.getFrontendHandler();
  await handler({ type: "bootstrap" }, "user1", "session1");
  await flush();
  await handler({ type: "import_json", json: "{\"sheet\":null}" }, "user1", "session1");
  await flush();
  assert.equal(host.store.get("chats/chat1.json"), undefined, "garbage import must not persist");
  await handler({ type: "import_json", json: VALID_IMPORT }, "user1", "session1");
  await flush();
  const data = host.store.get("chats/chat1.json");
  assert.equal(data.sheet.name, "Test Hero");
  assert.equal(data.sheet.level, 2);
  assert.equal(data.initialized, true);
});

test("dismiss_notice removes only the requested ids (seeded via import)", async () => {
  const host = fresh();
  const handler = host.getFrontendHandler();
  await handler({ type: "bootstrap" }, "user1", "session1");
  await flush();
  const seeded = JSON.stringify({
    format: "weft-chronicle", version: 3,
    sheet: { name: "Test Hero", level: 1, stats: { str: 5, dex: 5, int: 5, cha: 5, con: 5, wis: 5 } },
    world: { location: "Somewhere" },
    notices: [
      { id: "ntc_a", kind: "warn", title: "A", lines: [], timestamp: 1 },
      { id: "ntc_b", kind: "levelup", title: "B", lines: [], timestamp: 2 },
      { id: "ntc_c", kind: "item", title: "C", lines: [], timestamp: 3 },
    ],
  });
  await handler({ type: "import_json", json: seeded }, "user1", "session1");
  await flush();
  await handler({ type: "dismiss_notice", ids: ["ntc_a", "ntc_c"] }, "user1", "session1");
  await flush();
  const data = host.store.get("chats/chat1.json");
  assert.deepEqual(data.notices.map((n) => n.id), ["ntc_b"]);
});

// ---------- regression tests for the v3 audit fixes ----------
async function freshWithSidecar(sidecarJson) {
  const host = createMockHost();
  let interceptor = null;
  host.spindle.registerInterceptor = (fn) => { interceptor = fn; return () => {}; };
  host.spindle.generate.quiet = async () => ({ content: sidecarJson });
  loadBackendWithHost(host);
  const h = host.getFrontendHandler();
  await h({ type: "bootstrap" }, "user1", "session1");
  await flush();
  await h({ type: "import_json", json: VALID_IMPORT }, "user1", "session1");
  await flush();
  host.send = async (m) => { await h(m, "user1", "session1"); await flush(); };
  host.interceptor = () => interceptor;
  host.chat = () => host.store.get("chats/chat1.json");
  host.ended = async (messageId, content = "ok", type = "normal") => {
    await host.handlers["GENERATION_ENDED"]({ chatId: "chat1", messageId, error: null, generationType: type, content }, "user1");
    await flush(200);
  };
  return host;
}
const ctx = (type) => ({ chatId: "chat1", userId: "user1", generationType: type });
const stateOf = (out) => (Array.isArray(out) ? out : out.messages).map((m) => m.content).join("\n");

test("deleting the newest AI message rewinds to the previous AI message's state", async () => {
  const host = await freshWithSidecar(JSON.stringify({ sheet: { hpDelta: -10 } }));
  let msgs = [{ id: "m1", is_user: true, content: "hi" }, { id: "m2", is_user: false, content: "a", swipe_id: 0 }];
  host.spindle.chat.getMessages = async () => msgs;
  await host.ended("m2");
  const hp1 = host.chat().sheet.hp;
  msgs = [...msgs, { id: "m3", is_user: true, content: "b" }, { id: "m4", is_user: false, content: "c", swipe_id: 0 }];
  await host.ended("m4");
  assert.equal(host.chat().sheet.hp, hp1 - 10);
  msgs = msgs.slice(0, 3);
  await host.handlers["MESSAGE_DELETED"]({ chatId: "chat1", messageId: "m4" }, "user1");
  await flush();
  assert.equal(host.chat().sheet.hp, hp1, "state must rewind to the m2 snapshot");
});

test("regenerate keeps the turn's dice bound and does not leak the discarded reply's state", async () => {
  const host = await freshWithSidecar(JSON.stringify({ sheet: { hpDelta: -10 } }));
  const msgs0 = [{ id: "m1", is_user: true, content: "hi" }, { id: "m2", is_user: false, content: "a", swipe_id: 0 }];
  host.spindle.chat.getMessages = async () => msgs0;
  await host.ended("m2"); // turn 1 (no roll)
  const hpBefore = host.chat().sheet.hp;
  await host.send({ type: "roll_dice", action: "Pick lock", stat: "dex", dc: 15 });
  const msgs = [...msgs0, { id: "m3", is_user: true, content: "lock" }, { id: "m4", is_user: false, content: "click", swipe_id: 0 }];
  host.spindle.chat.getMessages = async () => msgs;
  await host.ended("m4", "click");
  const hpAfter = host.chat().sheet.hp;
  assert.equal(hpAfter, hpBefore - 10);
  const regen = stateOf(await host.interceptor()([{ role: "user", content: "lock" }], ctx("regenerate")));
  assert.match(regen, /BINDING DICE ROLLS/, "roll must be re-bound on regenerate");
  assert.match(regen, new RegExp(`HP ${hpBefore}/`), "regenerate must see the pre-turn state");
  // and the redo's own snapshot keeps the roll for a third attempt
  await host.ended("m4", "click again", "regenerate");
  const third = stateOf(await host.interceptor()([{ role: "user", content: "lock" }], ctx("regenerate")));
  assert.match(third, /BINDING DICE ROLLS/);
});

test("a brand-new NPC starts at bond 0-5, spark 0, heat 0 (preset: no instant love)", async () => {
  const host = await freshWithSidecar(JSON.stringify({ world: { npcsUpserted: [{ name: "Mara", present: true, mood: "wary" }] } }));
  host.spindle.chat.getMessages = async () => [{ id: "m1", is_user: true, content: "hi" }, { id: "m2", is_user: false, content: "A stranger glares.", swipe_id: 0 }];
  await host.ended("m2");
  const n = host.chat().world.npcs[0];
  assert.ok(n.bond <= 5, `bond ${n.bond}`);
  assert.equal(n.spark, 0);
  assert.equal(n.heat, 0);
});

test("gear + skill bonuses never exceed +3 combined", async () => {
  const host = await freshWithSidecar("{}");
  await host.send({ type: "roll_dice", action: "x", stat: "dex", dc: 15, gearBonus: 3, skillBonus: 10, skillLabel: "Sneak" });
  const r = host.chat().rolls[0];
  assert.ok(r.gearBonus + r.skillBonus <= 3, `applied ${r.gearBonus + r.skillBonus}`);
});

test("the interceptor waits for an in-flight sync before reading state", async () => {
  const host = await freshWithSidecar("{}");
  let release;
  const gate = new Promise((r) => { release = r; });
  host.spindle.generate.quiet = async () => { await gate; return { content: JSON.stringify({ sheet: { hpDelta: -5 } }) }; };
  host.spindle.chat.getMessages = async () => [{ id: "m1", is_user: true, content: "hi" }, { id: "m2", is_user: false, content: "a", swipe_id: 0 }];
  const hp0 = host.chat().sheet.hp;
  void host.handlers["GENERATION_ENDED"]({ chatId: "chat1", messageId: "m2", error: null, generationType: "normal", content: "a" }, "user1");
  await flush();
  const pending = host.interceptor()([{ role: "user", content: "next" }], ctx("normal"));
  setTimeout(release, 20);
  const out = stateOf(await pending);
  assert.match(out, new RegExp(`HP ${hp0 - 5}/`), "next prompt must contain the post-sync state");
});
