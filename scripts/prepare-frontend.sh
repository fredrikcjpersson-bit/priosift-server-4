#!/usr/bin/env bash
# prepare-frontend.sh
# Patches the PrioSift artifact HTML for server mode and copies it to public/index.html.
#
# Usage:
#   ./scripts/prepare-frontend.sh <path-to-downloaded-artifact.html>
#
# What it does:
#   1. Turns off demo mode  (PRIOSIFT_DEMO = true → false)
#   2. Guards the demo-mode startup IIFE so it won't run in server mode
#   3. Writes the result to public/index.html

set -euo pipefail

SRC="${1:-}"
DST="$(dirname "$0")/../public/index.html"

if [[ -z "$SRC" ]]; then
  echo "Usage: $0 <path-to-artifact.html>" >&2
  exit 1
fi
if [[ ! -f "$SRC" ]]; then
  echo "File not found: $SRC" >&2
  exit 1
fi

mkdir -p "$(dirname "$DST")"

# 1. Flip demo flag
sed 's/window\.PRIOSIFT_DEMO\s*=\s*true/window.PRIOSIFT_DEMO = false/g' "$SRC" > "$DST"

# 2. Guard the demo-mode IIFE.
#    The demo IIFE starts with: (async () => { /* demo boot */
#    We replace the first occurrence that sets up demo data with an if-guarded version.
#    This uses a Python one-liner for reliable multi-line replacement.
python3 - "$DST" <<'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    html = f.read()

# Wrap the demo-startup IIFE in an if(window.PRIOSIFT_DEMO) guard.
# The IIFE looks like:  (async () => { ... demoApi ... })();
# Strategy: find the block starting with the comment marker we know is near line 1655
pattern = r'(\(async \(\) => \{[^}]*?demoMode\s*=\s*true.*?\}\)\(\);)'
match = re.search(pattern, html, re.DOTALL)
if match:
    old = match.group(0)
    new = 'if (window.PRIOSIFT_DEMO) {\n' + old + '\n}'
    html = html.replace(old, new, 1)
    print("  ✓ Demo IIFE guarded")
else:
    print("  ⚠ Could not locate demo IIFE – manual check recommended")

with open(path, 'w', encoding='utf-8') as f:
    f.write(html)
PYEOF

echo "✓ Server-mode frontend written to: $DST"
echo ""
echo "Next steps:"
echo "  1. Commit and push to GitHub"
echo "  2. Railway will redeploy automatically"
