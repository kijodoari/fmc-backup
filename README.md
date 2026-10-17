# FMC skin collection

Watchfaces ("skins") for the **CMF Watch Pro 2 / Pro 3**, automatically mirrored
from <https://fmc.freethinkel.dev/>.

```
skins/      <name>-<id>.bin   flashable watchface files
previews/   <name>-<id>.png   preview images (same base name as the skin)
manifest.json                 metadata + sync state (author, downloads, URLs, …)
sync-skins.mjs                the sync script (plain Node, no dependencies)
```

## Usage

```bat
:: one-shot: download new + updated skins, prune removed ones
node sync-skins.mjs

:: auto-sync: run immediately, then re-check every 15 minutes (default)
node sync-skins.mjs --watch

:: auto-sync every 5 minutes instead
node sync-skins.mjs --watch 5
```

Skins are pulled straight from the site's PocketBase API, so the script picks up
new uploads and edits automatically — file names are stable
(`<slug>-<record-id>.bin`) and already-downloaded skins are only re-downloaded
when their record changes upstream.

## Run automatically on login / boot (Windows Task Scheduler)

```bat
schtasks /Create /TN "fmc skin sync" /SC ONLOGON ^
  /TR "node C:\Users\LENOVO\Desktop\ai\fmc\sync-skins.mjs" /RL LIMITED
```

Or keep a window open permanently with `node sync-skins.mjs --watch`.
