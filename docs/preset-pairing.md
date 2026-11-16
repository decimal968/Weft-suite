# Pairing Weft Chronicle with the `Weft_v4_4.json` preset

Weft Chronicle tracks the RPG state itself, renders the System Window, Story Tracker and dice cards, and injects a compact `<weft_chronicle_state>` block into the prompt so the model narrates around it. The preset should not also render those cards.

## Preset Prompt Variables

| Variable | Set to | Why |
|---|---|---|
| `System window` (`system_mode`) | **Off** | The extension renders it. |
| `Tracker` (`tracker_mode`) | **Off** | The extension renders it. |
| `Dice` (`dice_mode`) | **Off** | The extension rolls with crypto RNG and binds the result to the next reply. |
| `cyoa` | **On** | Since 3.0.0 the extension no longer asks for choices itself. The preset's CYOA block is the only source; the extension just renders and sends the tapped option. |

The preset's display-only CYOA regex scripts (`CYOA · choices`, `CYOA · auto-asterisk`, `CYOA · action italics`) duplicate the extension card. Disable them if you want one card only. Keep the CYOA prompt block and its strip-from-context regex.

NPC Inner Chatter is independent and is not rendered by the extension.

## Rules the extension follows (to match the preset)

- XP to next level is `100 × level`.
- Gear and skill bonuses together never exceed +3.
- New NPCs start at Bond 0-5, Spark 0, Heat 0. Heat is shown only while the scene is charged.

## Migrating an existing Weft chat

1. Open the chat with the extension enabled.
2. Settings → Move / Reset → **Import JSON** and paste either a previous `weft-chronicle` export or `{ "sheet": {…}, "world": {…} }`. Everything is sanitized and clamped, so partial data is fine.
3. Or tap **Initialize with AI** in the drawer to let the sidecar build the sheet from the chat.

(The old "Import from Chat Log" scan was removed in 3.0.0.)

## Troubleshooting

- **Duplicate System Windows or double dice**: the preset's `System window` / `Dice` variable is still on.
- **No choices card**: the preset's `cyoa` is off, or the model skipped the block on a short reply.
- **Syncs are slow or expensive**: no Sidecar Model is selected, so syncs run on your main chat model. Pick a small, fast one.
- **State looks wrong after a reply**: HP, XP, items and NPC meters come from the sidecar's reading of the reply, so they can be off. Fix them in the drawer or hit Sync.
