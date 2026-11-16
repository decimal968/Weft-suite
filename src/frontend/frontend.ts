// @ts-nocheck — types are being tightened incrementally; bundling and CI tests do not depend on this flag. Remove file-by-file.
/*! src/frontend/frontend.ts */
import { bshStage, esc, escXml, escXmlAttr, formatRollForChat, renderChoicesCard, renderDiceCard, renderInventoryWindow, renderNoticeCard, renderQuestWindow, renderSystemWindow, renderTrackerCard, resolveSystemTheme } from "./cards";
import { DC_PRESETS, STAT_KEYS, computeMaxGearBonus, formatMod, statModifier } from "./engine";
import { WEFT_CHRONICLE_CSS } from "./styles";
import { icon } from "./icons";
var WEFT_THEMES = [
  { id: "sakura", label: "Sakura (pink)" },
  { id: "ocean", label: "Ocean (blue)" },
  { id: "gold", label: "Gold (warm)" },
  { id: "lumiverse", label: "Lumiverse Native" },
  { id: "contrast", label: "High Contrast (black / #FFF)" }
];
var CREST_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 21 7 21 17 12 22 3 17 3 7 12 2"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>`;
var DICE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z"/><path d="M12 22V12"/><path d="M12 12 3 7"/><path d="M12 12l9-5"/><circle cx="12" cy="7.5" r="0.8" fill="currentColor"/></svg>`;
export function setup(ctx) {
  const cleanups = [];
  ctx.dom.addStyle(WEFT_CHRONICLE_CSS);
  cleanups.push(() => ctx.dom.cleanup());
  let activeSubTab = "system";
  let chatId = ctx.getActiveChat().chatId;
  let data = null;
  let settings = null;
  let connections = [];
  let permissions = {
    interceptor: false,
    generation: false,
    chats: false,
    chat_mutation: false,
    characters: false,
    personas: false
  };
  let syncing = false;
  let statusNote = "";
  const injectedWrappers = /* @__PURE__ */ new Map();
  const rollDraft = {
    action: "",
    stat: "dex",
    dc: 15,
    gearBonus: 0,
    mode: "normal"
  };
  function getActiveConnectionId() {
    try {
      const active = ctx.connections?.getActive?.()?.activeProfileId;
      if (active) return active;
    } catch {
    }
    const def = connections.find((c) => c.isDefault) || connections[0];
    return def?.id || null;
  }
  const drawerTab = ctx.ui.registerDrawerTab({
    id: "weft_chronicle_tab",
    title: "Weft Chronicle",
    shortName: "Weft",
    headerTitle: "Weft Chronicle",
    description: "Authentic Weft System Window, Story Tracker, Inventory, Quests & Fair d20 Dice.",
    keywords: ["weft", "rpg", "status", "system", "tracker", "dice", "d20", "npc", "quests", "settings", "cyoa", "choices"],
    iconSvg: CREST_SVG
  });
  cleanups.push(() => drawerTab.destroy());
  let settingsTabHandle = null;
  if (typeof ctx.ui.registerSettingsTab === "function") {
    try {
      settingsTabHandle = ctx.ui.registerSettingsTab({
        id: "weft_chronicle_settings",
        title: "Weft Chronicle",
        shortName: "Weft",
        iconSvg: CREST_SVG,
        description: "Configure Weft Chronicle modules, themes, inline chat cards, and sidecar AI.",
        keywords: ["weft", "system", "tracker", "dice", "rpg", "sidecar", "theme", "cyoa", "choices"]
      });
      cleanups.push(() => settingsTabHandle?.destroy());
    } catch {
      settingsTabHandle = null;
    }
  }
  const rollAction = ctx.ui.registerInputBarAction({
    id: "weft_quick_roll",
    label: "Roll d20",
    subtitle: "Fair RNG check (Weft Chronicle)",
    iconSvg: DICE_SVG,
    enabled: true
  });
  cleanups.push(() => rollAction.destroy());
  function send(type, extra = {}) {
    const activeConnectionId = getActiveConnectionId();
    ctx.sendToBackend({ type, chatId, activeConnectionId, ...extra });
  }
  async function pickChoice(key, index, sourceBtn) {
    if (!key || !Number.isFinite(index)) return;
    const snap = data?.snapshots?.[key];
    const opt = snap?.choices?.options?.[index];
    if (!opt) return;
    if (Array.isArray(snap.choices.claimed) && snap.choices.claimed.includes(index)) return;
    const text = String(opt.text || "").trim().slice(0, 600);
    if (!text) return;
    const restoreBtn = () => {
      if (sourceBtn) {
        sourceBtn.disabled = false;
        sourceBtn.classList.remove("is-busy");
      }
    };
    if (sourceBtn) {
      sourceBtn.disabled = true;
      sourceBtn.classList.add("is-busy");
    }
    // Preferred path: the composer bridge (composer-v1) — set the option as
    // the draft and hit Send, exactly like the preset's native Send action.
    let outcome = "error";
    try {
      const composer = ctx.composer;
      if (composer && typeof composer.setText === "function" && typeof composer.send === "function") {
        let mounted = true;
        try {
          const state = typeof composer.getState === "function" ? composer.getState() : null;
          if (state && state.mounted === false) mounted = false;
        } catch {
          mounted = true;
        }
        if (mounted) {
          // Don't destroy a half-typed message: put it back once the choice is sent.
          let draft = "";
          try {
            const st = typeof composer.getState === "function" ? composer.getState() : null;
            const t = st && (st.text ?? st.draft ?? st.value);
            if (typeof t === "string") draft = t;
          } catch {
          }
          composer.setText(text);
          try {
            await composer.send();
          } finally {
            if (draft.trim()) {
              try {
                composer.setText(draft);
              } catch {
              }
            }
          }
          outcome = "sent";
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err || "");
      outcome = /busy/i.test(msg) ? "busy" : "error";
    }
    if (outcome === "sent") {
      send("choice_claim", { key, index });
      return;
    }
    if (outcome === "busy") {
      restoreBtn();
      send("choice_feedback", { kind: "busy" });
      return;
    }
    // Fallback (older host without composer-v1, or send failed): copy to the
    // clipboard so the user can paste and press Send themselves.
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        send("choice_claim", { key, index });
        send("choice_feedback", { kind: "copied" });
        restoreBtn();
        return;
      }
    } catch {
    }
    restoreBtn();
    send("choice_feedback", { kind: "error" });
  }
  function updateChromeState() {
    const diceOn = Boolean(data?.enabled && data?.modules?.dice);
    rollAction.setEnabled(diceOn);
    if (!data || !data.enabled) {
      drawerTab.setBadge(null);
      return;
    }
    const pendingRolls = data.modules.dice ? data.rolls.filter((r) => !r.consumed).length : 0;
    if (pendingRolls > 0) {
      drawerTab.setBadge(String(pendingRolls));
    } else if (data.modules.system && data.sheet.pts > 0) {
      drawerTab.setBadge(`+${data.sheet.pts}`);
    } else {
      drawerTab.setBadge(null);
    }
  }
  async function hydrateFrontendConnections() {
    if (connections.length > 0) return;
    try {
      const list = ctx.connections ? await ctx.connections.list() : [];
      if (Array.isArray(list) && list.length > 0) {
        connections = list.map((c) => ({
          id: c.id,
          name: c.name || c.model || c.provider,
          provider: c.provider,
          model: c.model,
          isDefault: Boolean(c.is_default)
        }));
        renderAll();
      }
    } catch {
    }
  }
  function clearAllInlineCards() {
    for (const entry of injectedWrappers.values()) {
      try {
        ctx.dom.uninject(entry.wrapper);
      } catch {
      }
    }
    injectedWrappers.clear();
  }
  function findSnapshotForMessage(d, messageId) {
    if (d.lastSyncedKey && d.lastSyncedKey.startsWith(`${messageId}:`)) {
      const activeSnap = d.snapshots[d.lastSyncedKey];
      if (activeSnap) return { snap: activeSnap, key: d.lastSyncedKey };
    }
    const matching = Object.entries(d.snapshots || {}).filter(([, s]) => s && s.messageId === messageId).sort((a, b) => (b[1]?.timestamp || 0) - (a[1]?.timestamp || 0));
    if (matching.length > 0) {
      return { snap: matching[0][1], key: matching[0][0] };
    }
    return null;
  }
  function findLatestChoices(d) {
    if (!d) return null;
    const entries = Object.entries(d.snapshots || {}).filter(([, s]) => s && s.choices && Array.isArray(s.choices.options) && s.choices.options.length > 0);
    if (entries.length === 0) return null;
    entries.sort((a, b) => (b[1]?.timestamp || 0) - (a[1]?.timestamp || 0));
    return { snap: entries[0][1], key: entries[0][0] };
  }
  function isInsideOurInjection(el) {
    return Boolean(el.closest(".wc-inline-wrap"));
  }
  // Hosts keep hidden swipe siblings in the DOM (parked off-canvas or
  // display:none). Injecting into those is what produced the duplicate
  // half-visible cards bleeding off the screen edge.
  function isDisplayedElement(el) {
    if (!el || !el.isConnected) return false;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.contentVisibility === "hidden") return false;
    } catch {
      return false;
    }
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    try {
      const r = rects[0];
      if (r.width === 0 && r.height === 0) return false;
      // Parked off-viewport (swipe tracks translate hidden swipes sideways).
      if (r.right < 0 || r.left > (window.innerWidth || 0)) return false;
    } catch {
    }
    return !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true";
  }
  // Best-effort read of the host's swipe indicator ("2 / 3") inside the
  // message row. Returns 0-based swipe index, or null when undeterminable.
  function readSwipeIndex(el) {
    if (!el) return null;
    try {
      const candidates = el.querySelectorAll('[class*="swipe" i], [class*="pager" i], [data-swipe-id], [data-swipe]');
      for (const node of candidates) {
        const attr = node.getAttribute("data-swipe-id") || node.getAttribute("data-swipe");
        if (attr !== null && attr !== "") {
          const n = parseInt(attr, 10);
          if (Number.isFinite(n)) return n;
        }
        const t = (node.textContent || "").trim();
        const m = t.match(/^(\d+)\s*\/\s*(\d+)$/);
        if (m) return Math.max(0, parseInt(m[1], 10) - 1);
      }
    } catch {
    }
    return null;
  }
  // Cards always sit as a full-width sibling right after the message row.
  function resolveInlineTarget(bubbleEl) {
    return { target: bubbleEl, position: "afterend" };
  }
  function buildInlineHtml(d, cfg, snap, snapKey) {
    const parts = [];
    const sysTh = resolveSystemTheme(cfg);
    if (d.initialized && d.modules.dice && cfg.showInlineDice && Array.isArray(snap.rolls) && snap.rolls.length > 0) {
      for (const r of snap.rolls) {
        parts.push(renderDiceCard(r, cfg.theme));
      }
    }
    if (d.initialized && d.modules.system && Array.isArray(snap.notices) && snap.notices.length > 0) {
      for (const n of snap.notices) {
        parts.push(renderNoticeCard(n, sysTh));
      }
    }
    if (d.initialized && d.modules.system && cfg.showInlineSystem) {
      parts.push(renderSystemWindow(snap.sheet, cfg, { mode: "inline", open: cfg.inlineStartsOpen }));
    }
    if (d.initialized && d.modules.tracker && cfg.showInlineTracker) {
      parts.push(renderTrackerCard(snap.world, cfg, { mode: "inline", open: cfg.inlineStartsOpen }));
    }
    if (d.modules.choices && cfg.showInlineChoices && snap.choices && Array.isArray(snap.choices.options) && snap.choices.options.length > 0) {
      parts.push(renderChoicesCard(snap.choices, cfg.theme, { open: cfg.inlineStartsOpen, snapKey }));
    }
    if (parts.length === 0) return "";
    return `<div class="wc-inline-wrap is-below" data-wc-theme="${esc(cfg.theme)}">${parts.join("")}</div>`;
  }
  function syncInlineChatCards() {
    const choicesReady = Boolean(
      data && settings && data.enabled && data.modules && data.modules.choices && settings.showInlineChoices &&
        Object.values(data.snapshots || {}).some((s) => s && s.choices && Array.isArray(s.choices.options) && s.choices.options.length > 0)
    );
    if (!data || !settings || !data.enabled || (!data.initialized && !choicesReady)) {
      clearAllInlineCards();
      return;
    }
    const wantAny =
      (data.modules.system && settings.showInlineSystem) ||
      (data.modules.tracker && settings.showInlineTracker) ||
      (data.modules.dice && settings.showInlineDice) ||
      (data.modules.choices && settings.showInlineChoices);
    if (!wantAny) {
      clearAllInlineCards();
      return;
    }
    const activeIds = /* @__PURE__ */ new Set();
    let mounted = [];
    try {
      mounted = ctx.dom.listMessageElements();
    } catch {
      mounted = [];
    }
    // Keep one VISIBLE element per messageId — hidden swipe siblings must not
    // collect their own copy of the cards.
    const visibleById = new Map();
    for (const item of mounted || []) {
      if (!item || !item.element || typeof item.messageId !== "string" || !item.messageId) continue;
      if (!isDisplayedElement(item.element)) continue;
      if (!visibleById.has(item.messageId)) visibleById.set(item.messageId, item);
    }
    mounted = Array.from(visibleById.values());
    // When the visible element exposes its swipe index (pager "2 / 3"), only
    // paint cards for the snapshot recorded for THAT swipe. A regenerated or
    // swiped-to turn keeps the old swipe's id, so the stale cards hiding
    // behind the streaming reply never flash in.
    const dropWrapper = (mid) => {
      const existing = injectedWrappers.get(mid);
      if (existing) {
        try {
          ctx.dom.uninject(existing.wrapper);
        } catch {
        }
        injectedWrappers.delete(mid);
      }
    };
    for (const item of mounted) {
      const found = findSnapshotForMessage(data, item.messageId);
      if (!found) continue;
      const currentSwipe = readSwipeIndex(item.element);
      if (currentSwipe !== null && typeof found.snap?.swipeId === "number" && found.snap.swipeId !== currentSwipe) {
        dropWrapper(item.messageId);
        continue;
      }
      const snap = found.snap;
      const snapKey = found.key;
      // Inline cards show as-of-that-turn state (snapshots are refreshed on
      // every sync and manual edit), so scrolling up never shows future HP.
      const effectiveSnap = snap;
      const resolved = resolveInlineTarget(item.element);
      const html = buildInlineHtml(data, settings, effectiveSnap, snapKey);
      if (!html) continue;
      activeIds.add(item.messageId);
      const existing = injectedWrappers.get(item.messageId);
      const needsReinject = !existing || !existing.wrapper.isConnected || existing.target !== resolved.target || existing.position !== resolved.position;
      if (existing && !needsReinject) {
        const prevOpenStates = Array.from(existing.wrapper.querySelectorAll("details")).map((el) => el.open);
        existing.wrapper.innerHTML = html;
        const nextDetails = Array.from(existing.wrapper.querySelectorAll("details"));
        nextDetails.forEach((el, idx) => {
          if (typeof prevOpenStates[idx] === "boolean") el.open = prevOpenStates[idx];
        });
      } else {
        if (existing) {
          try {
            ctx.dom.uninject(existing.wrapper);
          } catch {
          }
          injectedWrappers.delete(item.messageId);
        }
        try {
          const wrapper = ctx.dom.inject(resolved.target, html, resolved.position);
          wrapper.addEventListener("click", (ev) => {
            const btn = ev.target?.closest("[data-act]");
            if (!btn) return;
            ev.stopPropagation();
            if (btn.dataset.act === "alloc" && btn.dataset.stat) {
              send("allocate_stat", { stat: btn.dataset.stat, amount: 1 });
            } else if (btn.dataset.act === "auto_alloc") {
              send("auto_allocate");
            } else if (btn.dataset.act === "choice_pick") {
              void pickChoice(btn.dataset.key, Number(btn.dataset.idx), btn);
            }
          });
          injectedWrappers.set(item.messageId, {
            wrapper,
            target: resolved.target,
            position: resolved.position
          });
        } catch {
        }
      }
    }
    for (const [mid] of injectedWrappers.entries()) {
      if (!activeIds.has(mid) && !findSnapshotForMessage(data, mid)) {
        dropWrapper(mid);
      }
    }
  }
  let inlineTimer = null;
  let inlineSettleTimer = null;
  function scheduleInlineSync(delay = 120) {
    if (inlineTimer) clearTimeout(inlineTimer);
    if (inlineSettleTimer) clearTimeout(inlineSettleTimer);
    inlineTimer = setTimeout(() => {
      inlineTimer = null;
      syncInlineChatCards();
      inlineSettleTimer = setTimeout(() => {
        inlineSettleTimer = null;
        syncInlineChatCards();
      }, 420);
    }, delay);
  }
  cleanups.push(() => {
    if (inlineTimer) clearTimeout(inlineTimer);
    if (inlineSettleTimer) clearTimeout(inlineSettleTimer);
    clearAllInlineCards();
  });
  function edgeSegHtml(idPrefix, mode) {
    const attr = (m) => `data-edge="${m}"`;
    const cls = (m) => `wc-seg-btn${mode === m ? " is-active" : ""}`;
    if (idPrefix === "wc-m-edge") {
      return `<div class="wc-seg" id="${idPrefix}">
        <button type="button" class="${cls("normal")}" ${attr("normal")}>Normal</button>
        <button type="button" class="${cls("adv")}" ${attr("adv")}>Advantage</button>
        <button type="button" class="${cls("dis")}" ${attr("dis")}>Disadvantage</button>
      </div>`;
    }
    return `<div class="wc-seg" id="${idPrefix}">
      <button type="button" class="${cls("normal")}" data-act="edge" data-mode="normal">Normal</button>
      <button type="button" class="${cls("adv")}" data-act="edge" data-mode="adv">Advantage</button>
      <button type="button" class="${cls("dis")}" data-act="edge" data-mode="dis">Disadvantage</button>
    </div>`;
  }
  function openQuickRollModal() {
    if (!chatId) return;
    const sheet = data?.sheet;
    const autoGear = sheet ? computeMaxGearBonus(sheet) : 0;
    const modal = ctx.ui.showModal({ title: "Weft Fair d20 Roll", width: 420 });
    const statOpts = [
      `<option value="none">Flat (no stat \xB7 +0)</option>`,
      ...STAT_KEYS.map((k) => {
        const val = sheet ? sheet.stats[k] : 5;
        const lbl = sheet ? sheet.statLabels[k] : k.toUpperCase();
        const sel = rollDraft.stat === k ? "selected" : "";
        return `<option value="${k}" ${sel}>${esc(lbl)} ${val} (${formatMod(statModifier(val))})</option>`;
      })
    ].join("");
    const dcOpts = DC_PRESETS.map(
      (p) => `<option value="${p.dc}" ${p.dc === rollDraft.dc ? "selected" : ""}>${esc(p.label)}</option>`
    ).join("");
    modal.root.innerHTML = `
      <div class="wc-modal">
        <div class="wc-field">
          <label>What is ${esc(sheet?.name || "your character")} attempting?</label>
          <input class="wc-input" id="wc-m-action" placeholder="e.g., Force the rusted lock quietly" value="${esc(rollDraft.action)}" />
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Stat</label><select class="wc-select" id="wc-m-stat">${statOpts}</select></div>
          <div class="wc-field"><label>Difficulty (DC)</label><select class="wc-select" id="wc-m-dc-preset">${dcOpts}</select></div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Custom DC</label><input class="wc-input" id="wc-m-dc" type="number" min="1" max="40" value="${rollDraft.dc}" /></div>
          <div class="wc-field"><label>Gear Bonus (-3 to +3)</label><input class="wc-input" id="wc-m-gear" type="number" min="-3" max="3" value="${autoGear}" /></div>
        </div>
        ${(sheet?.skills || []).length > 0 ? `<div class="wc-field"><label>Skill (adds its dice bonus)</label><select class="wc-select" id="wc-m-skill"><option value="">— no skill —</option>${(sheet.skills || []).map((sk) => { const b = Number(sk.bonus) || 0; return `<option value="${esc(sk.id)}">${esc(sk.name)} (${b >= 0 ? "+" : ""}${b})</option>`; }).join("")}</select></div>` : ""}
        <div class="wc-field"><label>Edge</label>${edgeSegHtml("wc-m-edge", rollDraft.mode)}</div>
        <div class="wc-dim">Rolled with unbiased crypto RNG. Binds the AI's next reply. Gear + skill bonus never exceeds +3 combined.</div>
        <div class="wc-modal-foot">
          <button class="wc-btn" id="wc-m-cancel">Cancel</button>
          <button class="wc-btn is-primary" id="wc-m-roll">${icon("d20", 15)} Roll Fair d20</button>
        </div>
      </div>
    `;
    const presetSel = modal.root.querySelector("#wc-m-dc-preset");
    const dcInp = modal.root.querySelector("#wc-m-dc");
    presetSel?.addEventListener("change", () => {
      if (dcInp && presetSel) dcInp.value = presetSel.value;
    });
    modal.root.querySelectorAll("#wc-m-edge [data-edge]").forEach((btn) => {
      btn.addEventListener("click", () => {
        rollDraft.mode = btn.getAttribute("data-edge") || "normal";
        modal.root.querySelectorAll("#wc-m-edge [data-edge]").forEach((b) => b.classList.toggle("is-active", b === btn));
      });
    });
    modal.root.querySelector("#wc-m-cancel")?.addEventListener("click", () => modal.dismiss());
    const buildPayload = () => {
      const action = modal.root.querySelector("#wc-m-action")?.value.trim() || "Attempt check";
      const stat = modal.root.querySelector("#wc-m-stat")?.value || "none";
      const dc = Number(dcInp?.value || 15);
      let gearBonus = Math.max(-3, Math.min(3, Math.round(Number(modal.root.querySelector("#wc-m-gear")?.value || 0))));
      const skillId = modal.root.querySelector("#wc-m-skill")?.value || "";
      const skill = (sheet?.skills || []).find((sk) => sk.id === skillId);
      let skillBonus = skill ? Math.max(-3, Math.min(3, Number(skill.bonus) || 0)) : 0;
      // Same rule as the backend: gear + skill never exceed +3 together.
      if (gearBonus + skillBonus > 3) skillBonus = 3 - gearBonus;
      if (gearBonus + skillBonus < -3) skillBonus = -3 - gearBonus;
      rollDraft.action = action;
      rollDraft.stat = stat;
      rollDraft.dc = dc;
      rollDraft.gearBonus = gearBonus;
      return { action, stat, dc, gearBonus, skillBonus, skillLabel: skill ? skill.name : "", mode: rollDraft.mode };
    };
    modal.root.querySelector("#wc-m-roll")?.addEventListener("click", () => {
      send("roll_dice", buildPayload());
      modal.dismiss();
    });
  }
  function openEditIdentityModal() {
    if (!data) return;
    const s = data.sheet;
    const modal = ctx.ui.showModal({ title: "Edit System Sheet", width: 440, maxHeight: 580 });
    modal.root.innerHTML = `
      <div class="wc-modal">
        <div class="wc-row-2">
          <div class="wc-field"><label>Name</label><input class="wc-input" id="wc-id-name" value="${esc(s.name)}" /></div>
          <div class="wc-field"><label>Race / Origin</label><input class="wc-input" id="wc-id-race" value="${esc(s.race)}" /></div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Class / Role</label><input class="wc-input" id="wc-id-cls" value="${esc(s.cls)}" placeholder="e.g., Survivor, Mage" /></div>
          <div class="wc-field"><label>Subclass / Specialty</label><input class="wc-input" id="wc-id-subcls" value="${esc(s.subcls)}" /></div>
        </div>
        <div class="wc-row-3">
          <div class="wc-field"><label>Level</label><input class="wc-input" id="wc-id-lv" type="number" min="1" value="${s.level}" /></div>
          <div class="wc-field"><label>Unspent Pts</label><input class="wc-input" id="wc-id-pts" type="number" min="0" value="${s.pts}" /></div>
          <div class="wc-field"><label>Rank (optional)</label><input class="wc-input" id="wc-id-rank" value="${esc(s.rank)}" /></div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Title</label><input class="wc-input" id="wc-id-title" value="${esc(s.title)}" /></div>
          <div class="wc-field"><label>Funds / Currency</label><input class="wc-input" id="wc-id-cash" value="${esc(s.cash)}" placeholder="e.g., 42g or $85" /></div>
        </div>
        <div class="wc-row-2">
          <label class="wc-toggle-row"><span>Enable 3rd Pool (MP/Sanity)</span><input type="checkbox" id="wc-id-usemp" ${s.useMp ? "checked" : ""} /></label>
          <div class="wc-field"><label>3rd Pool Label</label><input class="wc-input" id="wc-id-mplbl" value="${esc(s.mpLabel)}" /></div>
        </div>
        <div class="wc-card-title">Stat Names (setting labels)</div>
        <div class="wc-row-3">
          ${STAT_KEYS.map(
      (k) => `<div class="wc-field"><label>${esc(k.toUpperCase())}</label><input class="wc-input" id="wc-lb-${k}" maxlength="24" value="${esc(s.statLabels[k])}" /></div>`
    ).join("")}
        </div>
        <div class="wc-card-title">Direct Stat Overrides</div>
        <div class="wc-row-3">
          ${STAT_KEYS.map(
      (k) => `<div class="wc-field"><label>${esc(s.statLabels[k])}</label><input class="wc-input" id="wc-st-${k}" type="number" min="1" max="99" value="${s.stats[k]}" /></div>`
    ).join("")}
        </div>
        <div class="wc-modal-foot">
          <button class="wc-btn" id="wc-id-cancel">Cancel</button>
          <button class="wc-btn is-primary" id="wc-id-save">Save Changes</button>
        </div>
      </div>
    `;
    modal.root.querySelector("#wc-id-cancel")?.addEventListener("click", () => modal.dismiss());
    modal.root.querySelector("#wc-id-save")?.addEventListener("click", () => {
      const val = (id) => modal.root.querySelector(`#${id}`)?.value ?? "";
      send("update_identity", {
        patch: {
          name: val("wc-id-name"),
          race: val("wc-id-race"),
          cls: val("wc-id-cls"),
          subcls: val("wc-id-subcls"),
          rank: val("wc-id-rank"),
          title: val("wc-id-title"),
          cash: val("wc-id-cash"),
          level: Number(val("wc-id-lv")),
          pts: Number(val("wc-id-pts")),
          useMp: modal.root.querySelector("#wc-id-usemp")?.checked ?? false,
          mpLabel: val("wc-id-mplbl"),
          statLabels: Object.fromEntries(STAT_KEYS.map((k) => [k, (modal.root.querySelector(`#wc-lb-${k}`)?.value || "").trim().slice(0, 24) || k.toUpperCase()]))
        }
      });
      for (const k of STAT_KEYS) {
        const num = Number(val(`wc-st-${k}`));
        if (Number.isFinite(num) && num !== s.stats[k]) {
          send("update_stat", { stat: k, value: num });
        }
      }
      modal.dismiss();
    });
  }
  function openItemModal(existing) {
    const modal = ctx.ui.showModal({
      title: existing ? `Inspect / Edit Item` : "Add Item to Inventory",
      width: 400
    });
    const cats = [
      ["misc", "Misc"],
      ["weapon", "Weapon"],
      ["armor", "Armor"],
      ["accessory", "Accessory"],
      ["potion", "Potion / Meds"],
      ["material", "Material / Ammo"],
      ["key", "Key Item"],
      ["book", "Book / Note"],
      ["valuable", "Valuable"]
    ];
    const rars = [
      ["ordinary", "Ordinary (+0)"],
      ["common", "Common (+0)"],
      ["uncommon", "Uncommon (+1)"],
      ["rare", "Rare (+1)"],
      ["epic", "Epic (+2)"],
      ["legendary", "Legendary (+3)"],
      ["mythic", "Mythic (+3)"]
    ];
    const curCat = existing?.category || "misc";
    const curRar = existing?.rarity || "ordinary";
    const canEquip = curCat === "weapon" || curCat === "armor" || curCat === "accessory";
    modal.root.innerHTML = `
      <div class="wc-modal">
        <div class="wc-field"><label>Item Name</label><input class="wc-input" id="wc-it-name" placeholder="e.g., Crowbar, First-Aid Kit, Iron Sword" value="${esc(existing?.name || "")}" /></div>
        <div class="wc-row-2">
          <div class="wc-field">
            <label>Category</label>
            <select class="wc-select" id="wc-it-cat">
              ${cats.map(([v, lbl]) => `<option value="${v}" ${curCat === v ? "selected" : ""}>${lbl}</option>`).join("")}
            </select>
          </div>
          <div class="wc-field">
            <label>Rarity</label>
            <select class="wc-select" id="wc-it-rar">
              ${rars.map(([v, lbl]) => `<option value="${v}" ${curRar === v ? "selected" : ""}>${lbl}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Quantity</label><input class="wc-input" id="wc-it-qty" type="number" min="1" value="${existing?.qty ?? 1}" /></div>
          <label class="wc-toggle-row" style="align-self:end"><span>${existing ? "Equip now" : "Equip immediately"}</span><input type="checkbox" id="wc-it-eq" ${existing && !canEquip ? "disabled" : ""} /></label>
        </div>
        <div class="wc-field"><label>Note / Effect</label><textarea class="wc-textarea" id="wc-it-note" rows="2" placeholder="Short effect, lore, or condition">${esc(existing?.note || "")}</textarea></div>
        <div class="wc-modal-foot">
          ${existing ? `<button class="wc-btn is-danger" id="wc-it-del" style="margin-right:auto">Remove All</button>` : ""}
          <button class="wc-btn" id="wc-it-cancel">Cancel</button>
          <button class="wc-btn is-primary" id="wc-it-save">${existing ? "Save Item" : "Add Item"}</button>
        </div>
      </div>
    `;
    const catSel = modal.root.querySelector("#wc-it-cat");
    const eqCb = modal.root.querySelector("#wc-it-eq");
    catSel?.addEventListener("change", () => {
      if (!eqCb) return;
      const v = catSel.value;
      const eq = v === "weapon" || v === "armor" || v === "accessory";
      eqCb.disabled = !eq;
      if (!eq) eqCb.checked = false;
    });
    modal.root.querySelector("#wc-it-del")?.addEventListener("click", () => {
      if (existing) send("remove_item", { id: existing.id, qty: existing.qty });
      modal.dismiss();
    });
    modal.root.querySelector("#wc-it-cancel")?.addEventListener("click", () => modal.dismiss());
    modal.root.querySelector("#wc-it-save")?.addEventListener("click", () => {
      const name = modal.root.querySelector("#wc-it-name")?.value.trim();
      if (!name) return;
      const payload = {
        id: existing?.id,
        name,
        category: modal.root.querySelector("#wc-it-cat")?.value,
        rarity: modal.root.querySelector("#wc-it-rar")?.value,
        qty: Number(modal.root.querySelector("#wc-it-qty")?.value || 1),
        note: modal.root.querySelector("#wc-it-note")?.value.trim() || "",
        equip: modal.root.querySelector("#wc-it-eq")?.checked ?? false
      };
      send(existing ? "update_item" : "add_item", { item: payload });
      modal.dismiss();
    });
  }
  function openQuestModal(existing) {
    const modal = ctx.ui.showModal({ title: existing ? "Edit Quest" : "Add Quest", width: 420 });
    const obsText = existing ? existing.objectives.map((o) => `${o.done ? "[x] " : ""}${o.text}`).join("\n") : "";
    modal.root.innerHTML = `
      <div class="wc-modal">
        <div class="wc-field"><label>Quest Title</label><input class="wc-input" id="wc-q-title" value="${esc(existing?.title || "")}" /></div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Type</label><select class="wc-select" id="wc-q-kind"><option value="main" ${existing?.kind === "main" ? "selected" : ""}>Main</option><option value="side" ${existing?.kind === "side" || !existing ? "selected" : ""}>Side</option><option value="daily" ${existing?.kind === "daily" ? "selected" : ""}>Daily</option></select></div>
          <div class="wc-field"><label>Status</label><select class="wc-select" id="wc-q-status"><option value="active" ${!existing || existing.status === "active" ? "selected" : ""}>Active</option><option value="available" ${existing?.status === "available" ? "selected" : ""}>Available</option><option value="done" ${existing?.status === "done" ? "selected" : ""}>Done</option><option value="failed" ${existing?.status === "failed" ? "selected" : ""}>Failed</option></select></div>
        </div>
        <div class="wc-field"><label>Objectives (one per line; prefix "[x] " if done)</label><textarea class="wc-textarea" id="wc-q-obs" rows="3">${esc(obsText)}</textarea></div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Reward (optional)</label><input class="wc-input" id="wc-q-rew" value="${esc(existing?.reward || "")}" /></div>
          <div class="wc-field"><label>Warning / Penalty</label><input class="wc-input" id="wc-q-pen" value="${esc(existing?.penalty || "")}" /></div>
        </div>
        <div class="wc-modal-foot"><button class="wc-btn" id="wc-q-cancel">Cancel</button><button class="wc-btn is-primary" id="wc-q-save">Save Quest</button></div>
      </div>
    `;
    modal.root.querySelector("#wc-q-cancel")?.addEventListener("click", () => modal.dismiss());
    modal.root.querySelector("#wc-q-save")?.addEventListener("click", () => {
      const title = modal.root.querySelector("#wc-q-title")?.value.trim();
      if (!title) return;
      const lines = (modal.root.querySelector("#wc-q-obs")?.value || "").split("\n").map((l) => l.trim()).filter(Boolean);
      const objectives = lines.map((line, i) => ({
        id: existing?.objectives[i]?.id || `ob_${Date.now()}_${i}`,
        text: line.replace(/^\[[x ]\]\s*/i, ""),
        done: /^\[x\]\s*/i.test(line)
      }));
      send("upsert_quest", {
        quest: {
          id: existing?.id,
          title,
          kind: modal.root.querySelector("#wc-q-kind")?.value,
          status: modal.root.querySelector("#wc-q-status")?.value,
          objectives,
          reward: modal.root.querySelector("#wc-q-rew")?.value.trim() || "",
          penalty: modal.root.querySelector("#wc-q-pen")?.value.trim() || ""
        }
      });
      modal.dismiss();
    });
  }
  function openWorldModal() {
    if (!data) return;
    const w = data.world;
    const modal = ctx.ui.showModal({ title: "Edit Scene & Arc", width: 420 });
    modal.root.innerHTML = `
      <div class="wc-modal">
        <div class="wc-field"><label>Current Location</label><input class="wc-input" id="wc-w-loc" value="${esc(w.location)}" /></div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Time / Timeline</label><input class="wc-input" id="wc-w-time" value="${esc(w.time)}" /></div>
          <div class="wc-field"><label>Day #</label><input class="wc-input" id="wc-w-day" type="number" min="1" value="${w.dayCount}" /></div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Arc</label><input class="wc-input" id="wc-w-arc" value="${esc(w.arc)}" placeholder="Opening / Rising / Turning / Climax" /></div>
          <div class="wc-field"><label>Scene Phase</label><input class="wc-input" id="wc-w-phase" value="${esc(w.phase)}" placeholder="Setup / Tension / Confrontation" /></div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Weather</label><input class="wc-input" id="wc-w-weather" value="${esc(w.weather)}" /></div>
          <div class="wc-field"><label>Scene Mood</label><input class="wc-input" id="wc-w-mood" value="${esc(w.mood)}" /></div>
        </div>
        <div class="wc-field"><label>Notes</label><textarea class="wc-textarea" id="wc-w-notes" rows="2">${esc(w.notes)}</textarea></div>
        <div class="wc-row-2">
          <div class="wc-field"><label>PC Outfit</label><input class="wc-input" id="wc-w-pc-outfit" value="${esc(w.pc?.outfit || "")}" placeholder="Rain-soaked coat" /></div>
          <div class="wc-field"><label>PC Position</label><input class="wc-input" id="wc-w-pc-pos" value="${esc(w.pc?.pos || "")}" placeholder="On the rail, hand on the brass key" /></div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>PC Condition</label><input class="wc-input" id="wc-w-pc-cond" value="${esc(w.pc?.cond || "")}" placeholder="Exhausted, left side numb" /></div>
          <div class="wc-field"><label>PC Carrying</label><input class="wc-input" id="wc-w-pc-carry" value="${esc(w.pc?.carry || "")}" placeholder="Brass key, revolver, locket" /></div>
        </div>
        <div class="wc-modal-foot"><button class="wc-btn" id="wc-w-cancel">Cancel</button><button class="wc-btn is-primary" id="wc-w-save">Save</button></div>
      </div>
    `;
    modal.root.querySelector("#wc-w-cancel")?.addEventListener("click", () => modal.dismiss());
    modal.root.querySelector("#wc-w-save")?.addEventListener("click", () => {
      send("update_world", {
        patch: {
          location: modal.root.querySelector("#wc-w-loc")?.value || "",
          time: modal.root.querySelector("#wc-w-time")?.value || "",
          dayCount: Number(modal.root.querySelector("#wc-w-day")?.value || 1),
          arc: modal.root.querySelector("#wc-w-arc")?.value || "",
          phase: modal.root.querySelector("#wc-w-phase")?.value || "",
          weather: modal.root.querySelector("#wc-w-weather")?.value || "",
          mood: modal.root.querySelector("#wc-w-mood")?.value || "",
          notes: modal.root.querySelector("#wc-w-notes")?.value || "",
          pc: {
            outfit: modal.root.querySelector("#wc-w-pc-outfit")?.value || "",
            pos: modal.root.querySelector("#wc-w-pc-pos")?.value || "",
            cond: modal.root.querySelector("#wc-w-pc-cond")?.value || "",
            carry: modal.root.querySelector("#wc-w-pc-carry")?.value || ""
          }
        }
      });
      modal.dismiss();
    });
  }
  function openNpcModal(existing) {
    const modal = ctx.ui.showModal({ title: "Edit NPC", width: 430, maxHeight: 580 });
    modal.root.innerHTML = `
      <div class="wc-modal">
        <div class="wc-row-2">
          <div class="wc-field"><label>Name</label><input class="wc-input" id="wc-n-name" value="${esc(existing?.name || "")}" /></div>
          <div class="wc-field"><label>Role</label><input class="wc-input" id="wc-n-role" value="${esc(existing?.role || "")}" /></div>
        </div>
        <div class="wc-row-2">
          <div class="wc-field"><label>Current Mood</label><input class="wc-input" id="wc-n-mood" value="${esc(existing?.mood || existing?.attitude || "Guarded")}" /></div>
          <label class="wc-toggle-row" style="align-self:end"><span>Present in scene</span><input type="checkbox" id="wc-n-pres" ${existing ? existing.present ? "checked" : "" : "checked"} /></label>
        </div>
        <div class="wc-row-3">
          <div class="wc-field"><label>Bond (0-100)</label><input class="wc-input" id="wc-n-bond" type="number" min="0" max="100" value="${existing?.bond ?? 3}" /></div>
          <div class="wc-field"><label>Spark (0-100)</label><input class="wc-input" id="wc-n-spark" type="number" min="0" max="100" value="${existing?.spark ?? 0}" /></div>
          <div class="wc-field"><label>Heat (0-100)</label><input class="wc-input" id="wc-n-heat" type="number" min="0" max="100" value="${existing?.heat ?? 0}" /></div>
        </div>
        <div class="wc-field"><label>Location</label><input class="wc-input" id="wc-n-loc" value="${esc(existing?.location || data?.world.location || "")}" /></div>
        <div class="wc-field"><label>Private Thought</label><input class="wc-input" id="wc-n-th" value="${esc(existing?.lastThought || "")}" placeholder="What they are thinking right now..." /></div>
        <div class="wc-field"><label>Wants (Current Goal)</label><input class="wc-input" id="wc-n-goal" value="${esc(existing?.goal || "")}" /></div>
        <div class="wc-field"><label>Secret (optional)</label><input class="wc-input" id="wc-n-sec" value="${esc(existing?.secret || "")}" /></div>
        <div class="wc-modal-foot"><button class="wc-btn" id="wc-n-cancel">Cancel</button><button class="wc-btn is-primary" id="wc-n-save">Save NPC</button></div>
      </div>
    `;
    modal.root.querySelector("#wc-n-cancel")?.addEventListener("click", () => modal.dismiss());
    modal.root.querySelector("#wc-n-save")?.addEventListener("click", () => {
      const name = modal.root.querySelector("#wc-n-name")?.value.trim();
      if (!name) return;
      send("upsert_npc", {
        npc: {
          id: existing?.id,
          name,
          role: modal.root.querySelector("#wc-n-role")?.value.trim() || "",
          mood: modal.root.querySelector("#wc-n-mood")?.value.trim() || "Guarded",
          attitude: modal.root.querySelector("#wc-n-mood")?.value.trim() || "Guarded",
          bond: Number(modal.root.querySelector("#wc-n-bond")?.value ?? 50),
          spark: Number(modal.root.querySelector("#wc-n-spark")?.value ?? 15),
          heat: Number(modal.root.querySelector("#wc-n-heat")?.value ?? 15),
          location: modal.root.querySelector("#wc-n-loc")?.value.trim() || "",
          present: modal.root.querySelector("#wc-n-pres")?.checked ?? true,
          lastThought: modal.root.querySelector("#wc-n-th")?.value.trim() || "",
          goal: modal.root.querySelector("#wc-n-goal")?.value.trim() || "",
          secret: modal.root.querySelector("#wc-n-sec")?.value.trim() || ""
        }
      });
      modal.dismiss();
    });
  }
  function openSimpleAddModal(kind) {
    if (kind === "export" && data) {
      const modal = ctx.ui.showModal({ title: "Export Weft Chronicle JSON", width: 460 });
      const json = JSON.stringify({ format: "weft-chronicle", version: 3, exportedAt: new Date().toISOString(), sheet: data.sheet, world: data.world, rolls: data.rolls }, null, 2);
      modal.root.innerHTML = `
        <div class="wc-modal">
          <textarea class="wc-textarea" id="wc-exp" rows="12" readonly>${esc(json)}</textarea>
          <div class="wc-modal-foot">
            <button class="wc-btn is-primary" id="wc-exp-copy">Copy JSON</button>
            <button class="wc-btn" id="wc-exp-close">Close</button>
          </div>
        </div>
      `;
      modal.root.querySelector("#wc-exp-copy")?.addEventListener("click", () => {
        navigator.clipboard?.writeText(json).catch(() => {
        });
      });
      modal.root.querySelector("#wc-exp-close")?.addEventListener("click", () => modal.dismiss());
      return;
    }
    if (kind === "import") {
      const modal = ctx.ui.showModal({ title: "Import Weft Chronicle JSON", width: 460 });
      modal.root.innerHTML = `
        <div class="wc-modal">
          <div class="wc-field"><label>Paste exported JSON</label><textarea class="wc-textarea" id="wc-imp" rows="10" placeholder='{"sheet":...,"world":...}'></textarea></div>
          <div class="wc-modal-foot"><button class="wc-btn" id="wc-imp-cancel">Cancel</button><button class="wc-btn is-primary" id="wc-imp-go">Import</button></div>
        </div>
      `;
      modal.root.querySelector("#wc-imp-cancel")?.addEventListener("click", () => modal.dismiss());
      modal.root.querySelector("#wc-imp-go")?.addEventListener("click", () => {
        const json = modal.root.querySelector("#wc-imp")?.value || "";
        if (json.trim()) send("import_json", { json });
        modal.dismiss();
      });
      return;
    }
    if (kind === "effect") {
      const modal = ctx.ui.showModal({ title: "Add Active Effect", width: 380 });
      modal.root.innerHTML = `
        <div class="wc-modal">
          <div class="wc-field"><label>Effect Name</label><input class="wc-input" id="wc-ef-name" placeholder="e.g., Sprained Ankle, Adrenaline" /></div>
          <div class="wc-row-2">
            <div class="wc-field"><label>Kind</label><select class="wc-select" id="wc-ef-kind"><option value="debuff">Debuff</option><option value="buff">Buff</option><option value="neutral">Neutral</option></select></div>
            <div class="wc-field"><label>Duration (turns, blank=ongoing)</label><input class="wc-input" id="wc-ef-dur" type="number" min="1" /></div>
          </div>
          <div class="wc-field"><label>Note</label><input class="wc-input" id="wc-ef-note" /></div>
          <div class="wc-modal-foot"><button class="wc-btn" id="wc-ef-c">Cancel</button><button class="wc-btn is-primary" id="wc-ef-s">Add</button></div>
        </div>
      `;
      modal.root.querySelector("#wc-ef-c")?.addEventListener("click", () => modal.dismiss());
      modal.root.querySelector("#wc-ef-s")?.addEventListener("click", () => {
        const name = modal.root.querySelector("#wc-ef-name")?.value.trim();
        if (!name) return;
        const durRaw = modal.root.querySelector("#wc-ef-dur")?.value.trim();
        send("add_effect", {
          effect: {
            name,
            kind: modal.root.querySelector("#wc-ef-kind")?.value,
            duration: durRaw ? Number(durRaw) : null,
            note: modal.root.querySelector("#wc-ef-note")?.value.trim() || ""
          }
        });
        modal.dismiss();
      });
      return;
    }
    if (kind === "skill") {
      const modal = ctx.ui.showModal({ title: "Add Skill / Trait", width: 380 });
      modal.root.innerHTML = `
        <div class="wc-modal">
          <div class="wc-field"><label>Skill Name</label><input class="wc-input" id="wc-sk-name" placeholder="e.g., Field Triage, Lockpicking" /></div>
          <div class="wc-field"><label>Cost (optional)</label><input class="wc-input" id="wc-sk-cost" placeholder="e.g., 4 SP or Passive" /></div>
          <div class="wc-field"><label>Note</label><input class="wc-input" id="wc-sk-note" /></div>
          <div class="wc-field"><label>Dice Bonus (optional)</label><input class="wc-input" id="wc-sk-bonus" type="number" min="-3" max="3" placeholder="e.g., 1 — gear + skill cap at +3 combined" /></div>
          <div class="wc-modal-foot"><button class="wc-btn" id="wc-sk-c">Cancel</button><button class="wc-btn is-primary" id="wc-sk-s">Add</button></div>
        </div>
      `;
      modal.root.querySelector("#wc-sk-c")?.addEventListener("click", () => modal.dismiss());
      modal.root.querySelector("#wc-sk-s")?.addEventListener("click", () => {
        const name = modal.root.querySelector("#wc-sk-name")?.value.trim();
        if (!name) return;
        const bonus = Number(modal.root.querySelector("#wc-sk-bonus")?.value || 0);
        send("add_skill", {
          skill: {
            name,
            cost: modal.root.querySelector("#wc-sk-cost")?.value.trim() || "",
            note: modal.root.querySelector("#wc-sk-note")?.value.trim() || "",
            bonus: Number.isFinite(bonus) ? Math.min(3, Math.max(-3, Math.floor(bonus))) : 0
          }
        });
        modal.dismiss();
      });
      return;
    }
    if (kind === "thread") {
      const modal = ctx.ui.showModal({ title: "Add Thread / Seed", width: 380 });
      modal.root.innerHTML = `
        <div class="wc-modal">
          <div class="wc-field"><label>Title</label><input class="wc-input" id="wc-th-t" placeholder="e.g., Radio broadcast from Highway 111" /></div>
          <div class="wc-field"><label>Kind</label><select class="wc-select" id="wc-th-st"><option value="active">Open Thread</option><option value="seed">Seed</option><option value="timer">Countdown Timer</option><option value="resolved">Resolved</option></select></div>
          <div class="wc-field" id="wc-th-turns-wrap" style="display:none"><label>Turns until it lands</label><input class="wc-input" id="wc-th-turns" type="number" min="1" max="99" value="3" /></div>
          <div class="wc-field"><label>Detail</label><textarea class="wc-textarea" id="wc-th-d" rows="2"></textarea></div>
          <div class="wc-modal-foot"><button class="wc-btn" id="wc-th-c">Cancel</button><button class="wc-btn is-primary" id="wc-th-s">Add</button></div>
        </div>
      `;
      const kindSel = modal.root.querySelector("#wc-th-st");
      const turnsWrap = modal.root.querySelector("#wc-th-turns-wrap");
      kindSel?.addEventListener("change", () => {
        if (turnsWrap) turnsWrap.style.display = kindSel.value === "timer" ? "" : "none";
      });
      modal.root.querySelector("#wc-th-c")?.addEventListener("click", () => modal.dismiss());
      modal.root.querySelector("#wc-th-s")?.addEventListener("click", () => {
        const title = modal.root.querySelector("#wc-th-t")?.value.trim();
        if (!title) return;
        const kindVal = modal.root.querySelector("#wc-th-st")?.value;
        const turns = Math.floor(Number(modal.root.querySelector("#wc-th-turns")?.value || 3));
        const thread = kindVal === "timer"
          ? { title, status: "active", kind: "timer", turnsLeft: Math.min(99, Math.max(1, Number.isFinite(turns) ? turns : 3)), detail: modal.root.querySelector("#wc-th-d")?.value.trim() || "" }
          : { title, status: kindVal, detail: modal.root.querySelector("#wc-th-d")?.value.trim() || "" };
        send("upsert_thread", { thread });
        modal.dismiss();
      });
    }
  }
  function renderModuleDisabledCard(mod, title, desc) {
    return `
      <div class="wc-card">
        <div class="wc-card-title">${esc(title)} is OFF for this chat</div>
        <div class="wc-muted">${esc(desc)}</div>
        <div class="wc-actions-row">
          <button class="wc-btn is-primary" data-act="enable_mod" data-mod="${mod}">Turn ${esc(title)} ON</button>
        </div>
      </div>
    `;
  }
// Settings-section accordion state (numeric ids, survives re-renders).
// 1 = Modules stays open by default; everything else starts collapsed.
var settingsAccCollapsed = new Set([2, 3, 4]);
function accHead(id, title, hintRight) {
  const collapsed = settingsAccCollapsed.has(id);
  return `<button type="button" class="wc-card-head wc-acc-h${collapsed ? " is-collapsed" : ""}" data-acc="${id}" aria-expanded="${!collapsed}"><span class="wc-card-title">${title}</span><span class="wc-acc-r">${hintRight ? `<span class="wc-dim">${hintRight}</span>` : ""}${icon("chev", 15)}</span></button>`;
}
var noticeFilter = "all";
var NOTICE_FILTERS = [
  ["all", "All"],
  ["levelup", "Level"],
  ["quest", "Quests"],
  ["item", "Items"],
  ["skill", "Skills"],
  ["warn", "Warnings"],
  ["change", "Changes"]
];
function groupNotices(list) {
  // Fold same kind+title+lines bursts ("HP −4 ×3") into one row with a counter.
  const out = [];
  for (const n of list) {
    const linesKey = JSON.stringify(Array.isArray(n.lines) ? n.lines : []);
    const prev = out.length > 0 ? out[out.length - 1] : null;
    if (prev && prev.kind === n.kind && prev.title === n.title && prev.linesKey === linesKey) {
      prev.count += 1;
      prev.ids.push(n.id);
    } else {
      out.push({ kind: n.kind, title: n.title, linesKey, count: 1, notice: n, ids: [n.id] });
    }
  }
  return out;
}
function renderNoticeFeed(d) {
  const list = Array.isArray(d.notices) ? d.notices : [];
  if (list.length === 0) return "";
  const filtered = list.filter((n) => noticeFilter === "all" || n.kind === noticeFilter);
  const grouped = groupNotices(filtered.slice(0, 12));
  const chips = NOTICE_FILTERS.map(([k, label]) => `<button class="wc-chip ${noticeFilter === k ? "is-active" : ""}" data-act="notice_filter" data-filter="${k}">${label}</button>`).join("");
  return `
    <div class="wc-card">
      <div class="wc-card-head"><span class="wc-card-title">Notifications</span><span class="wc-dim">${filtered.length} of ${list.length}</span></div>
      <div class="wc-chip-row">${chips}</div>
      <div class="wc-notif-list">
        ${grouped.length === 0 ? `<div class="wc-dim">Nothing in this filter.</div>` : grouped.map((g) => `
          <div class="wc-notif-row" data-k="${esc(g.notice.kind || "")}">
            <div class="wc-notif-main">
              <b>${esc(g.notice.title)}${g.count > 1 ? ` <span class="wc-pill">×${g.count}</span>` : ""}</b>
              <span>${esc((g.notice.lines || []).join(" · "))}</span>
            </div>
            <button class="wc-btn is-xs" data-act="dismiss_notice" data-ids="${esc(g.ids.join(","))}" title="Dismiss" aria-label="Dismiss notification">×</button>
          </div>`).join("")}
      </div>
      <div class="wc-actions-row" style="justify-content:flex-end"><button class="wc-btn is-xs" data-act="clear_notices">Clear All</button></div>
    </div>
  `;
}
  function renderSystemTab(d, cfg) {
    if (!d.modules.system) {
      return renderModuleDisabledCard(
        "system",
        "System Window",
        "System stats, HP/SP/XP, inventory, quests, and System Notifications are paused for this chat (0 prompt tokens used)."
      );
    }
    const initBanner = !d.initialized ? `<div class="wc-banner">
           <span>Not initialized for this chat yet.</span>
           <button class="wc-btn is-primary is-xs" data-act="init_ai" ${syncing ? "disabled" : ""}>${icon("sparkles", 13)} Initialize with AI</button>
         </div>` : "";
    const latestNotices = renderNoticeFeed(d);
    return `
      ${initBanner}
      ${latestNotices}
      ${renderSystemWindow(d.sheet, cfg, { mode: "drawer" })}
    `;
  }
  function renderGearTab(d, cfg) {
    if (!d.modules.system) {
      return renderModuleDisabledCard(
        "system",
        "System Window (Inventory & Quests)",
        "Turn the System module ON to manage equipped gear, pack items, and quests."
      );
    }
    return `
      ${renderInventoryWindow(d.sheet, cfg)}
      ${renderQuestWindow(d.sheet, cfg)}
    `;
  }
  function renderTrackerTab(d, cfg) {
    if (!d.modules.tracker) {
      return renderModuleDisabledCard(
        "tracker",
        "Story Tracker",
        "Scene tracking, Bond/Spark/Heat NPC bars, private thoughts, secrets, and open threads are paused for this chat."
      );
    }
    const initBanner = !d.initialized ? `<div class="wc-banner">
           <span>Tracker not initialized yet.</span>
           <button class="wc-btn is-primary is-xs" data-act="init_ai" ${syncing ? "disabled" : ""}>${icon("sparkles", 13)} Initialize with AI</button>
         </div>` : "";
    return `
      ${initBanner}
      ${renderTrackerCard(d.world, cfg, { mode: "drawer" })}
    `;
  }
  function renderDiceTab(d, cfg) {
    if (!d.modules.dice) {
      return renderModuleDisabledCard(
        "dice",
        "Fair d20 Dice Roller",
        "Real-RNG dice rolling and the Roll d20 input-bar action are turned OFF for this chat."
      );
    }
    const pending = d.rolls.filter((r) => !r.consumed);
    const autoGear = computeMaxGearBonus(d.sheet);
    return `
      <div class="wc-card">
        <div class="wc-card-head">
          <span class="wc-card-title">Fair Real-RNG d20 Roller</span>
          ${pending.length > 0 ? `<button class="wc-btn is-xs" data-act="clear_pending">Clear Pending (${pending.length})</button>` : ""}
        </div>
        <div class="wc-field">
          <label>Action</label>
          <input class="wc-input" id="wc-d-action" placeholder="e.g., Climb the fire escape silently" value="${esc(rollDraft.action)}" />
        </div>
        <div class="wc-row-3">
          <div class="wc-field">
            <label>Stat</label>
            <select class="wc-select" id="wc-d-stat">
              <option value="none" ${rollDraft.stat === "none" ? "selected" : ""}>Flat (+0)</option>
              ${STAT_KEYS.map((k) => {
      const v = d.sheet.stats[k];
      return `<option value="${k}" ${rollDraft.stat === k ? "selected" : ""}>${esc(d.sheet.statLabels[k])} (${formatMod(statModifier(v))})</option>`;
    }).join("")}
            </select>
          </div>
          <div class="wc-field"><label>DC</label><input class="wc-input" id="wc-d-dc" type="number" min="1" max="40" value="${rollDraft.dc}" /></div>
          <div class="wc-field"><label>Gear</label><input class="wc-input" id="wc-d-gear" type="number" min="-3" max="3" value="${autoGear}" /></div>
        </div>
        ${(d.sheet.skills || []).length > 0 ? `<div class="wc-field"><label>Skill (adds its dice bonus)</label><select class="wc-select" id="wc-d-skill"><option value="">— no skill —</option>${d.sheet.skills.map((sk) => { const b = Number(sk.bonus) || 0; return `<option value="${esc(sk.id)}">${esc(sk.name)} (${b >= 0 ? "+" : ""}${b})</option>`; }).join("")}</select></div>` : ""}
        <div class="wc-field"><label>Edge</label>${edgeSegHtml("wc-d-edge", rollDraft.mode)}</div>
        <div class="wc-actions-row">
          ${DC_PRESETS.slice(1, 5).map((p) => `<button class="wc-btn is-xs" data-act="set_dc" data-dc="${p.dc}">DC ${p.dc}</button>`).join("")}
          <button class="wc-btn is-primary" style="margin-left:auto" data-act="inline_roll">${icon("d20", 14)} Roll d20</button>
        </div>
      </div>

      ${d.rolls.length > 0 ? `<div class="wc-list">
               ${d.rolls.slice(0, 10).map((r) => renderDiceCard(r, cfg.theme)).join("")}
               <div class="wc-actions-row" style="justify-content:flex-end;">
                 <button class="wc-btn is-xs" data-act="copy_last_roll" title="Copy the latest roll as plain text for the chat">Copy Last Roll</button>
                 <button class="wc-btn is-xs" data-act="clear_rolls">Clear Roll History</button>
               </div>
             </div>` : `<div class="wc-card"><div class="wc-dim">Rolls use unbiased crypto RNG and automatically bind the AI's next reply.</div></div>`}
    `;
  }
  function renderChoicesTab(d, cfg) {
    if (!d.modules.choices) {
      return renderModuleDisabledCard(
        "choices",
        "CYOA Choices",
        "The What Now? choices card is turned OFF for this chat."
      );
    }
    const latest = findLatestChoices(d);
    if (!latest) {
      return `<div class="wc-card">
        <div class="wc-card-title">What Now?</div>
        <div class="wc-dim">No choices in the tracked replies yet. When the story ends with a <code>&lt;choices&gt;</code> block (Weft's CYOA), the options appear here and inline under the reply in chat.</div>
      </div>`;
    }
    return `<div class="wc-card">
      <div class="wc-card-head"><span class="wc-card-title">What Now? · Latest Reply</span><span class="wc-dim">one-shot</span></div>
      ${renderChoicesCard(latest.snap.choices, cfg.theme, { open: true, snapKey: latest.key })}
      <div class="wc-dim" style="margin-top:8px">Tapping a choice sends it as your next message. Picked paths are marked and can't be sent twice.</div>
    </div>`;
  }
  function renderSettingsContent(d, cfg) {
    const missingPerms = ["interceptor", "generation", "chats", "chat_mutation", "characters", "personas"].filter(
      (p) => !permissions[p]
    );
    return `
      ${missingPerms.length > 0 ? `<div class="wc-banner">
               <span>Missing permissions: ${esc(missingPerms.join(", "))}</span>
               <button class="wc-btn is-primary is-xs" data-act="req_perms">Grant</button>
             </div>` : ""}

      ${d ? `<div class="wc-card${settingsAccCollapsed.has(1) ? " is-collapsed" : ""}">
               ${accHead(1, "Modules", "this chat")}
               <label class="wc-toggle-row">
                 <span><strong>System Window</strong><small>Stats, HP/SP/XP, Gear, Quests & System Notices</small></span>
                 <input type="checkbox" data-mod-toggle="system" ${d.modules.system ? "checked" : ""} />
               </label>
               <label class="wc-toggle-row">
                 <span><strong>Story Tracker</strong><small>Scene/Arc, NPC Bond/Spark/Heat, Thoughts, Secrets & Threads</small></span>
                 <input type="checkbox" data-mod-toggle="tracker" ${d.modules.tracker ? "checked" : ""} />
               </label>
               <label class="wc-toggle-row">
                 <span><strong>Fair d20 Dice Roller</strong><small>Real crypto RNG checks & Roll d20 composer button</small></span>
                 <input type="checkbox" data-mod-toggle="dice" ${d.modules.dice ? "checked" : ""} />
               </label>
               <label class="wc-toggle-row">
                 <span><strong>CYOA Choices</strong><small>Tappable What Now? card from the preset's CYOA options — tap sends your next message</small></span>
                 <input type="checkbox" data-mod-toggle="choices" ${d.modules.choices ? "checked" : ""} />
               </label>
             </div>` : ""}

      <div class="wc-card${settingsAccCollapsed.has(2) ? " is-collapsed" : ""}">
        ${accHead(2, "Cards in Chat", "shown below each AI reply")}
        <label class="wc-toggle-row"><span>System Window card</span><input type="checkbox" data-cfg="showInlineSystem" ${cfg.showInlineSystem ? "checked" : ""} /></label>
        <label class="wc-toggle-row"><span>Story Tracker card</span><input type="checkbox" data-cfg="showInlineTracker" ${cfg.showInlineTracker ? "checked" : ""} /></label>
        <label class="wc-toggle-row"><span>Dice Result cards</span><input type="checkbox" data-cfg="showInlineDice" ${cfg.showInlineDice ? "checked" : ""} /></label>
        <label class="wc-toggle-row"><span>CYOA Choice cards</span><input type="checkbox" data-cfg="showInlineChoices" ${cfg.showInlineChoices ? "checked" : ""} /></label>
        <label class="wc-toggle-row"><span>Cards start expanded</span><input type="checkbox" data-cfg="inlineStartsOpen" ${cfg.inlineStartsOpen ? "checked" : ""} /></label>
        <div class="wc-field">
          <label>Theme</label>
          <select class="wc-select" id="wc-cfg-theme">
            ${WEFT_THEMES.map((t) => `<option value="${t.id}" ${cfg.theme === t.id ? "selected" : ""}>${esc(t.label)}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="wc-card${settingsAccCollapsed.has(3) ? " is-collapsed" : ""}">
        ${accHead(3, "State Sync")}
        <div class="wc-field">
          <label>Sidecar Model (reads each reply and updates HP / XP / items / NPCs)</label>
          <select class="wc-select" id="wc-cfg-conn">
            <option value="" ${!cfg.sidecarConnectionId ? "selected" : ""}>Same as chat (costly — pick a small model)</option>
            ${connections.map(
      (c) => `<option value="${esc(c.id)}" ${cfg.sidecarConnectionId === c.id ? "selected" : ""}>${esc(c.name)} (${esc(c.provider)} \xB7 ${esc(c.model)})</option>`
    ).join("")}
          </select>
        </div>
        ${!cfg.sidecarConnectionId ? `<div class="wc-dim" style="margin:-4px 0 8px;color:var(--wc-bad)">No sidecar picked: every sync runs on your main chat model. Choose a small, fast connection to keep it cheap.</div>` : ""}
        <div class="wc-field">
          <label>Level-Up Stat Allocation</label>
          <select class="wc-select" id="wc-cfg-alloc">
            <option value="player" ${cfg.allocMode === "player" ? "selected" : ""}>You Choose (+2 pts/lv)</option>
            <option value="auto" ${cfg.allocMode === "auto" ? "selected" : ""}>Auto-Assign</option>
          </select>
        </div>
        <label class="wc-toggle-row"><span>Auto-sync after every AI reply</span><input type="checkbox" data-cfg="autoSync" ${cfg.autoSync ? "checked" : ""} /></label>
        <label class="wc-toggle-row"><span>Inject live state into the AI prompt</span><input type="checkbox" data-cfg="injectPrompt" ${cfg.injectPrompt ? "checked" : ""} /></label>
        <label class="wc-toggle-row"><span>Enable automatically in new chats</span><input type="checkbox" data-cfg="enabledByDefault" ${cfg.enabledByDefault ? "checked" : ""} /></label>
      </div>

      ${d ? `<div class="wc-card${settingsAccCollapsed.has(4) ? " is-collapsed" : ""}">
               ${accHead(4, "Move / Reset", "this chat")}
               <div class="wc-actions-row" style="justify-content:space-between;">
                 <div class="wc-actions-row">
                   <button class="wc-btn is-xs" data-act="modal_add" data-kind="export">Export JSON</button>
                   <button class="wc-btn is-xs" data-act="modal_add" data-kind="import">Import JSON</button>
                 </div>
                 <button class="wc-btn is-xs is-danger" data-act="reset_chat">Reset Chat</button>
               </div>
             </div>` : ""}
    `;
  }
  function captureViewState(root) {
    if (!root) return null;
    const active = root.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active
      ? (active.dataset?.act ? `act:${active.dataset.act}` :
         active.dataset?.cfg ? `cfg:${active.dataset.cfg}` :
         active.dataset?.subtab ? `subtab:${active.dataset.subtab}` :
         active.id ? `id:${active.id}` : null)
      : null;
    return { scrollTop: root.scrollTop, focusKey };
  }
  function restoreViewState(root, vs) {
    if (!root || !vs) return;
    if (typeof vs.scrollTop === "number") root.scrollTop = vs.scrollTop;
    if (vs.focusKey) {
      const [kind, val] = vs.focusKey.split(":", 2);
      const sel = kind === "act" ? `[data-act="${CSS.escape(val)}"]`
        : kind === "cfg" ? `[data-cfg="${CSS.escape(val)}"]`
        : kind === "subtab" ? `[data-subtab="${CSS.escape(val)}"]`
        : `#${CSS.escape(val)}`;
      const el = root.querySelector(sel);
      if (el && typeof el.focus === "function") {
        try {
          el.focus({ preventScroll: true });
        } catch {
          el.focus();
        }
      }
    }
  }
  function renderAll() {
    updateChromeState();
    const theme = settings?.theme || "sakura";
    const settingsViewState = captureViewState(settingsTabHandle?.root || null);
    if (settingsTabHandle && settings) {
      settingsTabHandle.root.innerHTML = `<div class="wc-root" data-wc-theme="${esc(theme)}">${renderSettingsContent(data, settings)}</div>`;
      restoreViewState(settingsTabHandle.root, settingsViewState);
    }
    const drawerViewState = captureViewState(drawerTab.root);
    if (!chatId || !data || !settings) {
      drawerTab.root.innerHTML = `
        <div class="wc-root" data-wc-theme="${esc(theme)}">
          <div class="wc-card">
            <div class="wc-card-title">Weft Chronicle</div>
            <div class="wc-muted">Open any chat in Lumiverse to activate your System Window, Story Tracker, and Fair d20 Dice Roller.</div>
            <button class="wc-btn is-primary" data-act="refresh">Refresh Active Chat</button>
          </div>
          ${settings ? renderSettingsContent(null, settings) : ""}
        </div>
      `;
      restoreViewState(drawerTab.root, drawerViewState);
      scheduleInlineSync(60);
      return;
    }
    const pendingRolls = data.modules.dice ? data.rolls.filter((r) => !r.consumed).length : 0;
    const latestChoices = findLatestChoices(data);
    const unclaimedChoices = latestChoices ? Math.max(0, latestChoices.snap.choices.options.length - (latestChoices.snap.choices.claimed?.length || 0)) : 0;
    const viewCfg = settings;
    const body = activeSubTab === "system" ? renderSystemTab(data, viewCfg) : activeSubTab === "gear" ? renderGearTab(data, viewCfg) : activeSubTab === "tracker" ? renderTrackerTab(data, viewCfg) : activeSubTab === "dice" ? renderDiceTab(data, viewCfg) : activeSubTab === "choices" ? renderChoicesTab(data, viewCfg) : renderSettingsContent(data, settings);
    const syncErr = typeof data.lastSyncError === "string" && data.lastSyncError ? data.lastSyncError : null;
    const subLine = syncing
      ? esc(statusNote || "Syncing\u2026")
      : syncErr
        ? `Sync failed \u2014 ${esc(syncErr)}`
        : data.enabled
            ? esc(statusNote || "Active in this chat")
            : "Paused for this chat";
    drawerTab.root.innerHTML = `
      <div class="wc-root" data-wc-theme="${esc(theme)}">
        <div class="wc-topbar">
          <div class="wc-brand">
            <span class="wc-brand-dot" style="opacity:${data.enabled ? "1" : "0.3"}"></span>
            <div>
              <div class="wc-brand-title">Weft Chronicle</div>
              <div class="wc-brand-sub${syncErr ? " is-bad" : ""}">${subLine}</div>
            </div>
          </div>
          <div class="wc-actions-row">
            <button class="wc-btn is-xs" data-act="toggle_chat" title="Pause or resume all modules for this chat">${data.enabled ? "On" : "Off"}</button>
            <button class="wc-btn is-xs ${syncErr ? "is-danger" : "is-primary"}" data-act="sync_now" ${syncing || !data.enabled ? "disabled" : ""} title="${syncErr ? "Retry the failed sync" : "Sync state from the latest reply"}">${syncing ? "\u2026" : syncErr ? "Retry" : "Sync"}</button>
          </div>
        </div>

        <div class="wc-tabs" aria-label="Weft Chronicle sections">
          <button class="wc-tab ${activeSubTab === "system" ? "is-active" : ""} ${!data.modules.system ? "is-off" : ""}" data-subtab="system">${icon("system", 14)}<span>System</span>${data.modules.system && data.sheet.pts > 0 ? ` <span class="wc-pill">+${data.sheet.pts}</span>` : ""}</button>
          <button class="wc-tab ${activeSubTab === "gear" ? "is-active" : ""} ${!data.modules.system ? "is-off" : ""}" data-subtab="gear">${icon("shield", 14)}<span>Gear</span></button>
          <button class="wc-tab ${activeSubTab === "tracker" ? "is-active" : ""} ${!data.modules.tracker ? "is-off" : ""}" data-subtab="tracker">${icon("map", 14)}<span>Tracker</span></button>
          <button class="wc-tab ${activeSubTab === "dice" ? "is-active" : ""} ${!data.modules.dice ? "is-off" : ""}" data-subtab="dice">${icon("d20", 14)}<span>Dice</span>${pendingRolls > 0 ? ` <span class="wc-pill">${pendingRolls}</span>` : ""}</button>
          <button class="wc-tab ${activeSubTab === "choices" ? "is-active" : ""} ${!data.modules.choices ? "is-off" : ""}" data-subtab="choices" title="What Now? — choices from the latest reply">${icon("chat", 14)}<span>Pick</span>${unclaimedChoices > 0 ? ` <span class="wc-pill">${unclaimedChoices}</span>` : ""}</button>
          <button class="wc-tab wc-tab-icon ${activeSubTab === "settings" ? "is-active" : ""}" data-subtab="settings" title="Settings" aria-label="Settings">${icon("sliders", 15)}</button>
        </div>

        ${body}
      </div>
    `;
    restoreViewState(drawerTab.root, drawerViewState);
    scheduleInlineSync(80);
  }
  const handleClick = async (ev) => {
    // Settings-section accordion toggles share this delegate.
    const acc = ev.target?.closest("[data-acc]");
    if (acc) {
      const id = Number(acc.dataset.acc);
      if (settingsAccCollapsed.has(id)) settingsAccCollapsed.delete(id);
      else settingsAccCollapsed.add(id);
      const collapsed = settingsAccCollapsed.has(id);
      acc.classList.toggle("is-collapsed", collapsed);
      acc.setAttribute("aria-expanded", String(!collapsed));
      const card = acc.closest(".wc-card");
      if (card) card.classList.toggle("is-collapsed", collapsed);
      return;
    }
    const target = ev.target?.closest("[data-act], [data-subtab]");
    if (!target) return;
    const sub = target.dataset.subtab;
    if (sub) {
      activeSubTab = sub;
      renderAll();
      return;
    }
    const act = target.dataset.act;
    switch (act) {
      case "refresh": {
        chatId = ctx.getActiveChat().chatId;
        send("bootstrap");
        return;
      }
      case "toggle_chat": {
        if (!data) return;
        send("toggle_chat_enabled", { enabled: !data.enabled });
        return;
      }
      case "enable_mod": {
        send("toggle_module", { module: target.dataset.mod, enabled: true });
        return;
      }
      case "sync_now": {
        send("sync_now");
        return;
      }
      case "init_ai": {
        send("init_from_ai");
        return;
      }

      case "edit_identity": {
        openEditIdentityModal();
        return;
      }
      case "pool": {
        send("adjust_pool", { pool: target.dataset.pool, delta: Number(target.dataset.delta || 0) });
        return;
      }
      case "add_xp": {
        send("add_xp", { amount: Number(target.dataset.xp || 0) });
        return;
      }
      case "clear_notices": {
        send("clear_notices");
        return;
      }
      case "rest": {
        send("rest", { kind: target.dataset.kind || "short" });
        return;
      }
      case "alloc": {
        send("allocate_stat", { stat: target.dataset.stat, amount: 1 });
        return;
      }
      case "auto_alloc": {
        send("auto_allocate");
        return;
      }
      case "notice_filter": {
        noticeFilter = target.dataset.filter || "all";
        renderAll();
        return;
      }
      case "dismiss_notice": {
        send("dismiss_notice", { ids: target.dataset.ids || target.dataset.id || "" });
        return;
      }
      case "edge": {
        rollDraft.mode = target.dataset.mode === "adv" || target.dataset.mode === "dis" ? target.dataset.mode : "normal";
        renderAll();
        return;
      }
      case "choice_pick": {
        void pickChoice(target.dataset.key, Number(target.dataset.idx), target);
        return;
      }
      case "rm_effect": {
        send("remove_effect", { id: target.dataset.id });
        return;
      }
      case "rm_skill": {
        send("remove_skill", { id: target.dataset.id });
        return;
      }
      case "add_item": {
        openItemModal();
        return;
      }
      case "edit_item": {
        const it = data?.sheet.bag.find((x) => x.id === target.dataset.id);
        if (it) openItemModal(it);
        return;
      }
      case "equip": {
        send("equip_item", { id: target.dataset.id });
        return;
      }
      case "unequip": {
        send("unequip_slot", { slot: target.dataset.slot });
        return;
      }
      case "rm_item": {
        send("remove_item", { id: target.dataset.id, qty: 1 });
        return;
      }
      case "add_quest": {
        openQuestModal();
        return;
      }
      case "toggle_obj_btn": {
        send("toggle_objective", { questId: target.dataset.qid, objectiveId: target.dataset.oid });
        return;
      }
      case "cycle_quest_status": {
        const q = data?.sheet.quests.find((x) => x.id === target.dataset.id);
        if (!q) return;
        const nextStatus = q.status === "available" ? "active" : q.status === "active" ? "done" : "active";
        send("upsert_quest", { quest: { ...q, status: nextStatus } });
        return;
      }
      case "edit_quest": {
        const q = data?.sheet.quests.find((x) => x.id === target.dataset.id);
        if (q) openQuestModal(q);
        return;
      }
      case "rm_quest": {
        send("remove_quest", { id: target.dataset.id });
        return;
      }
      case "edit_world": {
        openWorldModal();
        return;
      }
      case "add_npc": {
        openNpcModal();
        return;
      }
      case "edit_npc": {
        const npc = data?.world.npcs.find((n) => n.id === target.dataset.id);
        if (npc) openNpcModal(npc);
        return;
      }
      case "rm_npc": {
        send("remove_npc", { id: target.dataset.id });
        return;
      }
      case "npc_bond": {
        const npc = data?.world.npcs.find((n) => n.id === target.dataset.id);
        if (!npc) return;
        send("upsert_npc", {
          npc: { ...npc, bond: npc.bond + Number(target.dataset.delta || 0) }
        });
        return;
      }
      case "cycle_thread": {
        const th = data?.world.threads.find((t) => t.id === target.dataset.id);
        if (!th) return;
        const order = ["active", "seed", "resolved"];
        const next = order[(order.indexOf(th.status) + 1) % order.length];
        send("upsert_thread", { thread: { ...th, status: next } });
        return;
      }
      case "rm_thread": {
        send("remove_thread", { id: target.dataset.id });
        return;
      }
      case "modal_add": {
        const kind = target.dataset.kind;
        openSimpleAddModal(kind);
        return;
      }
      case "set_dc": {
        rollDraft.dc = Number(target.dataset.dc || 15);
        const inp = drawerTab.root.querySelector("#wc-d-dc");
        if (inp) inp.value = String(rollDraft.dc);
        return;
      }
      case "inline_roll": {
        const action = drawerTab.root.querySelector("#wc-d-action")?.value.trim() || "Attempt check";
        const stat = drawerTab.root.querySelector("#wc-d-stat")?.value || "none";
        const dc = Number(drawerTab.root.querySelector("#wc-d-dc")?.value || 15);
        const gearBonus = Math.max(-3, Math.min(3, Math.round(Number(drawerTab.root.querySelector("#wc-d-gear")?.value || 0))));
        const skillId = drawerTab.root.querySelector("#wc-d-skill")?.value || "";
        const skill = (data?.sheet?.skills || []).find((sk) => sk.id === skillId);
        let skillBonus = skill ? Math.max(-3, Math.min(3, Number(skill.bonus) || 0)) : 0;
        // Same rule as the backend: gear + skill never exceed +3 together.
        if (gearBonus + skillBonus > 3) skillBonus = 3 - gearBonus;
        if (gearBonus + skillBonus < -3) skillBonus = -3 - gearBonus;
        rollDraft.action = action;
        rollDraft.stat = stat;
        rollDraft.dc = dc;
        rollDraft.gearBonus = gearBonus;
        send("roll_dice", { action, stat, dc, gearBonus, skillBonus, skillLabel: skill ? skill.name : "", mode: rollDraft.mode });
        return;
      }
      case "clear_pending": {
        send("clear_pending_rolls");
        return;
      }
      case "clear_rolls": {
        send("clear_roll_history");
        return;
      }
      case "copy_last_roll": {
        const latest = data && Array.isArray(data.rolls) && data.rolls.length > 0 ? data.rolls[data.rolls.length - 1] : null;
        if (latest) {
          try {
            navigator.clipboard?.writeText(formatRollForChat(latest));
          } catch {
          }
        }
        return;
      }
      case "req_perms": {
        const missing = ["interceptor", "generation", "chats", "chat_mutation", "characters", "personas"].filter(
          (p) => !permissions[p]
        );
        try {
          await ctx.permissions.request([...missing], {
            reason: "Weft Chronicle uses these permissions to inject RPG/Tracker state, sync turns with your sidecar LLM, and read cards/personas."
          });
          send("bootstrap");
        } catch {
        }
        return;
      }
      case "reset_chat": {
        const res = await ctx.ui.showConfirm({
          title: "Reset Weft Chronicle for this Chat?",
          message: "This clears the System sheet, inventory, Story Tracker, NPCs, and roll history for this chat.",
          variant: "danger",
          confirmLabel: "Reset"
        });
        if (res.confirmed) send("reset_chat");
        return;
      }
    }
  };
  const handleChange = (ev) => {
    const el = ev.target;
    if (!el) return;
    if (el.dataset.act === "toggle_obj") {
      send("toggle_objective", { questId: el.dataset.qid, objectiveId: el.dataset.oid });
      return;
    }
    if (el.dataset.modToggle) {
      send("toggle_module", { module: el.dataset.modToggle, enabled: el.checked });
      return;
    }
    if (el.dataset.cfg) {
      send("update_settings", { patch: { [el.dataset.cfg]: el.checked } });
      return;
    }
    if (el.id === "wc-cfg-conn") {
      send("update_settings", { patch: { sidecarConnectionId: el.value } });
      return;
    }
    if (el.id === "wc-cfg-theme") {
      send("update_settings", { patch: { theme: el.value } });
      return;
    }
    if (el.id === "wc-cfg-alloc") {
      send("update_settings", { patch: { allocMode: el.value } });
      return;
    }
    if (el.id === "wc-d-action") rollDraft.action = el.value;
    if (el.id === "wc-d-stat") rollDraft.stat = el.value;
    if (el.id === "wc-d-dc") rollDraft.dc = Number(el.value || 15);
    if (el.id === "wc-d-gear") rollDraft.gearBonus = Number(el.value || 0);
  };
  const bindContainer = (el) => {
    el.addEventListener("click", handleClick);
    el.addEventListener("change", handleChange);
    cleanups.push(() => {
      el.removeEventListener("click", handleClick);
      el.removeEventListener("change", handleChange);
    });
  };
  bindContainer(drawerTab.root);
  if (settingsTabHandle) bindContainer(settingsTabHandle.root);
  cleanups.push(rollAction.onClick(() => openQuickRollModal()));
  cleanups.push(
    drawerTab.onActivate(() => {
      const active = ctx.getActiveChat().chatId;
      if (active && active !== chatId) {
        clearAllInlineCards();
        chatId = active;
      }
      send("bootstrap");
    })
  );
  cleanups.push(
    ctx.onBackendMessage((raw) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw;
      if (msg.type === "state_update") {
        if (msg.chatId !== chatId) {
          clearAllInlineCards();
        }
        chatId = msg.chatId;
        data = msg.data;
        settings = msg.settings;
        if (Array.isArray(msg.connections) && msg.connections.length > 0) {
          connections = msg.connections;
        }
        permissions = msg.permissions;
        syncing = msg.syncing;
        statusNote = msg.statusNote || "";
        renderAll();
        void hydrateFrontendConnections();
      }
    })
  );
  for (const evName of ["CHAT_SWITCHED", "CHARACTER_MESSAGE_RENDERED", "MESSAGE_SWIPED", "MESSAGE_DELETED"]) {
    cleanups.push(
      ctx.events.on(evName, (payload) => {
        if (evName === "CHAT_SWITCHED") {
          const obj = payload || {};
          const nextId = typeof obj.chatId === "string" ? obj.chatId : typeof obj.id === "string" ? obj.id : ctx.getActiveChat().chatId;
          if (nextId && nextId !== chatId) {
            clearAllInlineCards();
            chatId = nextId;
            send("bootstrap");
          }
          return;
        }
        scheduleInlineSync(160);
      })
    );
  }
  renderAll();
  send("bootstrap");
  void hydrateFrontendConnections();
  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
      }
    }
  };
}
