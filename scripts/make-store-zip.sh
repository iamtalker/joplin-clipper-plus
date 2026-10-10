#!/usr/bin/env bash
# Builds the Chrome Web Store upload zip: only the files the extension needs,
# with manifest.json at the zip root (the store rejects a wrapping folder).
# Reads from git HEAD, so commit first. Usage:
#   bash scripts/make-store-zip.sh [output-dir]      # default: dist/
set -euo pipefail
cd "$(dirname "$0")/.."
FILES=(manifest.json background.js core.js content.js toolbar.js
       popup.html popup.js options.html options.js icons lib)
OUT_DIR="${1:-dist}"
VER=$(grep -m1 '"version"' manifest.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')
mkdir -p "$OUT_DIR"
ZIP="$OUT_DIR/joplin-clipper-plus-store-v$VER.zip"
rm -f "$ZIP"
git archive --format=zip -o "$ZIP" HEAD "${FILES[@]}"
echo "built $ZIP"
unzip -l "$ZIP" | tail -n +4 | head -n -2 | awk '{print "  " $4}'
