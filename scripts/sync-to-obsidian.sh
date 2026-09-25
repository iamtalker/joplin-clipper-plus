#!/usr/bin/env bash
# Copies the files shared with the Obsidian fork (obsidian-clipper-plus) from
# this repo — the source of truth for them — into the sibling checkout.
# Backend-specific files (background.js, popup.html, options.*, manifest.json,
# README.md) are never touched. Run from anywhere:
#   bash scripts/sync-to-obsidian.sh [path-to-obsidian-clipper]
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DST="${1:-$SRC/../obsidian-clipper}"
SHARED=(content.js core.js toolbar.js popup.js lib/Readability.js lib/turndown.js lib/turndown-plugin-gfm.js)
[ -d "$DST" ] || { echo "not found: $DST" >&2; exit 1; }
mkdir -p "$DST/lib"
for f in "${SHARED[@]}"; do cp "$SRC/$f" "$DST/$f"; done
echo "synced ${#SHARED[@]} shared files -> $DST"
