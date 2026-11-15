#!/usr/bin/env bash
# Builds the store upload zip: only the files the extension needs, with
# manifest.json at the zip root (the store rejects a wrapping folder).
# Reads from git HEAD, so commit first. Usage:
#   bash scripts/make-store-zip.sh [chrome|firefox] [output-dir]   # default: chrome, dist/
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-chrome}"
case "$TARGET" in chrome|firefox) ;; *) echo "target must be chrome or firefox" >&2; exit 1;; esac
FILES=(manifest.json background.js core.js content.js toolbar.js
       popup.html popup.js options.html options.js site-rules.js picker.js icons lib)
OUT_DIR="${2:-dist}"
VER=$(grep -m1 '"version"' "$TARGET/manifest.json" | sed -E 's/.*"version": *"([^"]+)".*/\1/')
mkdir -p "$OUT_DIR"
if [ "$TARGET" = chrome ]; then NAME="joplin-clipper-plus-store"; else NAME="joplin-clipper-plus-firefox"; fi
ZIP="$OUT_DIR/$NAME-v$VER.zip"
rm -f "$ZIP"
git archive --format=zip -o "$ZIP" "HEAD:$TARGET" "${FILES[@]}"
echo "built $ZIP"
unzip -l "$ZIP" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
