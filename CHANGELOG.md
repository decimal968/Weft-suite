# Changelog

All notable changes to Weft Chronicle are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). `spindle.json` is the version source
of truth; `package.json` and this file are kept in lockstep by CI.

## [3.0.0] - 2026-11-16

Bug-fix and slim-down release. `src/` is about 21% smaller (8,250 to 6,500 lines) and the bundles about 24% smaller. Saved settings are migrated on load: keys of removed features are dropped and retired theme names fall back to Sakura.

### Fixed

- **Deleting the newest AI message now rewinds state.** The undo looked at the tail message, which was a user message, and did nothing.
- **Regenerate/swipe keeps the dice bound** to the turn and shows the pre-turn state instead of leaking the post-reply state into the prompt.
- **New NPCs start at Bond 0-5 / Spark 0 / Heat 0** (they used to start at 50/15/15), matching the preset's "no instant love" rule. The sidecar prompt says so too.
- **Gear + skill bonuses are capped at +3 combined** everywhere (they could stack to +13 through skills).
- **XP is flat `100 × level`**, as in the preset. The "lifted" curve made the extension disagree with the preset.
- **Rest, Add XP and Sync Now no longer advance a clock** (the clock is gone).
- **The prompt interceptor waits for an in-flight sidecar sync** (bounded at 6 s) instead of racing it.
- **Tapping a CYOA option restores your composer draft** instead of overwriting it.
- **The extension no longer injects its own CYOA instruction**, which conflicted with the preset's.

### Removed

- Survival module (scavenge/encounter loot tables) and the Scene Clock / weather drift.
- Contested rolls, compact dice cards, roll-history export, the "Export Weft Block" action.
- Chat-log import and health check, automatic backups and the restore picker, settings export/import, the sidecar spend and sync-log displays.
- Per-chat theme override, six of eleven themes, the separate System Window color, tracker field toggles.
- `inside` / `footer` card placements and their DOM-guessing code (cards always sit below the message).
- XP curve, heat display, prompt budget, sync pacing, transcript/output caps, auto-allocate priority and the "pause sidecar while editing" lease.

### UI

- NPC Bond / Spark / Heat labels no longer wrap or clip off the card edge.
- The tracker no longer shows "Day 1 · Day 1" when the scene time already says the day.
- Dice form keeps Stat / DC / Gear on one row on phone widths.
- The collapsed "What Now?" card is full width like the other cards.
- Checkboxes in Settings are now switches; accordion headers stay on one line.

### Kept

- JSON export/import of a chat's state (it is how state moves between chats), plus Reset.

### Changed

- The sidecar default is labelled **Same as chat (costly, pick a small model)** with a warning in Settings.

Older release notes (2.x) were dropped with the features they describe; see the repository history.
