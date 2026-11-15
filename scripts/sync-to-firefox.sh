#!/usr/bin/env bash
# Regenerates firefox/ from chrome/ (the source of truth). Everything is
# copied as is except:
#   manifest.json  - firefox/manifest.json is maintained by hand (gecko id,
#                    background.scripts instead of a service worker); only
#                    its "version" must be kept equal to chrome's.
#   background.js  - generated: the importScripts("core.js") line is dropped
#                    because Firefox loads core.js through manifest
#                    background.scripts instead.
# Run after every change under chrome/. Usage: bash scripts/sync-to-firefox.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/chrome"
DST="$ROOT/firefox"
FILES=(core.js content.js toolbar.js popup.html popup.js options.html options.js site-rules.js picker.js)
mkdir -p "$DST/lib" "$DST/icons"
for f in "${FILES[@]}"; do cp "$SRC/$f" "$DST/$f"; done
cp "$SRC"/lib/*.js "$DST/lib/"
cp "$SRC"/icons/*.png "$DST/icons/"
sed '/^importScripts(/d' "$SRC/background.js" > "$DST/background.js"
CV=$(grep -m1 '"version"' "$SRC/manifest.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')
FV=$(grep -m1 '"version"' "$DST/manifest.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')
[ "$CV" = "$FV" ] || echo "WARNING: firefox/manifest.json version $FV != chrome $CV - bump it" >&2
echo "synced chrome -> firefox (v$CV)"
