# SteamDB Co-op Hover Panel

Browser extension (Manifest V3) that injects a compact Co-Optimus co-op info panel into SteamDB hover cards.

## Features

- Detects the hovered game on any SteamDB page and shows Local, Online, Combo, and LAN co-op data.
- Weekly cached master index from Co-Optimus with stale-while-revalidate.
- Per-game detail cache (30-day TTL, 90-day stale window).
- Manual refresh from popup and inline retry in the panel.
- Compact SteamDB-native styling — no external logos, no layout disruption.
- Minimal permissions: only SteamDB and Co-Optimus host access, plus storage and alarms.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, minimal permissions |
| `background.js` | Cache, fetch, matching, parsing, refresh logic |
| `content.js` | Hover-card observer, panel injection |
| `content.css` | Compact panel styles |
| `popup.html/css/js` | Manual refresh + cache status UI |

## Install (unpacked)

1. Go to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top right toggle).
3. Click **Load unpacked**.
4. Select this folder.
5. Open the popup and click **Refresh master index** on first use.

## Known limitations

- Co-Optimus may block automated fetches with HTTP 403. The extension sends browser-like headers to mitigate this, but if the source site changes its access policy the fetch may fail until an update is released.
- Detail-page parsing uses resilient label-based extraction and may need adjustment if Co-Optimus restructures their game pages.

## Roadmap

- [ ] Offscreen/tab-based fetch fallback for 403 cases
- [ ] Manual match override UI for ambiguous titles
- [ ] Firefox (MV3) support
