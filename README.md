# Weft Chronicle v3.0.0

A **Lumiverse Spindle** extension for the **Weft** preset (`Weft_v4_4.json`). It keeps a character sheet and story tracker for each chat, rolls fair d20 dice, and renders them as cards under the AI's replies.

## What it does

- **System Window**: stats, HP/SP/MP, XP and levels, gear, skills, quests, and level-up notices. XP to the next level is `100 × level`. Gear and skill bonuses together never exceed +3, matching the preset.
- **Story Tracker**: scene, arc/phase, NPCs with Bond / Spark / Heat, private thoughts, secrets, threads and timers. New NPCs start at Bond 0-5, Spark 0, Heat 0. Heat only shows while the scene is charged.
- **Fair d20**: crypto-RNG rolls (advantage/disadvantage supported). A roll is bound to the AI's next reply, and stays bound if you regenerate or swipe that reply.
- **CYOA "What Now?" card**: parses the preset's choices and sends the option you tap as your next message. Your half-typed draft is restored afterwards.
- **Undo**: sheet/tracker state is snapshotted per AI message and swipe. Swiping, regenerating or deleting a reply rewinds the state.

## How state is kept

Dice and arithmetic (XP thresholds, bonus caps, HP clamps) are deterministic. Everything else (HP changes, XP awards, new items, NPC meters) is a **sidecar guess**: after each AI reply, a small LLM call reads the last few messages and returns a JSON delta that the extension validates and applies. The next generation waits (up to 6 s) for an in-flight sync, so the prompt never sees stale state.

> **Pick a small, fast Sidecar Model** in Settings → State Sync. If none is selected, every sync runs on your main chat model, which is slow and costs real tokens.

## Pairing with the preset

In the preset's Prompt Variables: `System window` **Off**, `Tracker` **Off**, `Dice` **Off**, `CYOA` **On**. The extension no longer injects its own CYOA instruction; the preset's CYOA block is the only source. Details and migration steps: [docs/preset-pairing.md](./docs/preset-pairing.md).

## Install

1. In **Lumiverse → Extensions → Install from GitHub**, enter the repository URL.
2. Grant the requested permissions (`interceptor`, `generation`, `chats`, `chat_mutation`, `characters`, `personas`).
3. Open the **Weft** drawer tab, pick a Sidecar Model, and tap **Initialize with AI** (or import JSON).

## Settings

Modules per chat (System / Tracker / Dice / Choices), which inline cards to show, theme (5), Sidecar Model, level-up allocation (you choose or auto), auto-sync, prompt injection, and enable-by-default for new chats. Chat state can be moved with Export / Import JSON in Settings.

## Development

`backend.js` and `frontend.js` are bundles built from `src/`; never hand-edit them.

```
src/backend/   engine.ts, sanitize.ts, extractor.ts, choices.ts, backend.ts
src/frontend/  engine.ts, cards.ts, styles.ts, frontend.ts
```

| Command | Purpose |
|---|---|
| `npm run build` | Bundle `src/` into `backend.js` and `frontend.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Engine, parser and RPC tests against a mock host |
| `npm run verify` | Typecheck + build + tests |

See [CHANGELOG.md](./CHANGELOG.md) for what changed in 3.0.0.
