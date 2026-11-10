#!/bin/bash
# One-time setup check for a new computer. Safe to run as many times as you like.
#   ./scripts/setup.sh
cd "$(dirname "$0")/.." || exit 1
MISSING=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; MISSING=1; }
echo "Checking this computer..."

# 1) Node.js (runs the helper)
if command -v node >/dev/null 2>&1; then ok "Node.js $(node --version)"
else bad "Node.js is missing. Install it from https://nodejs.org, then run ./scripts/setup.sh again."; fi

# 2) Rive CLI
RIVE="$(command -v rive 2>/dev/null)"; [ -z "$RIVE" ] && [ -x "${RIVE_BIN:-$HOME/.rive/bin/rive}" ] && RIVE="${RIVE_BIN:-$HOME/.rive/bin/rive}"
if [ -z "$RIVE" ]; then
  echo "  ✗ The Rive CLI is not installed."
  read -r -p "    Install it now from releases.rive.app? [y/N] " a
  if [ "$a" = "y" ] || [ "$a" = "Y" ]; then
    curl -fsSL https://releases.rive.app/cli/install.sh | sh
    RIVE="$HOME/.rive/bin/rive"
    if ! grep -qs '.rive/bin' "$HOME/.zshrc"; then echo 'export PATH="$HOME/.rive/bin:$PATH"' >> "$HOME/.zshrc"; echo "    (added ~/.rive/bin to your PATH in ~/.zshrc; open a new Terminal tab to use it)"; fi
  else MISSING=1; fi
fi
if [ -n "$RIVE" ] && [ -x "$RIVE" ]; then
  ok "Rive CLI $("$RIVE" --version 2>&1 | head -1)"
  # 3) Rive login
  WHO="$("$RIVE" whoami 2>&1 | grep -v -i "is available" | head -1)"  # skip the "update available" notice
  case "$WHO" in
    "Not logged in"*|"") bad "Not signed in to Rive. Run:  rive login   (it opens your browser; use the account you want)";;
    *) ok "Signed in to Rive as: $WHO";;
  esac
fi

# 4) Fonts
N=$(ls "Fonts Library"/*.ttf "Fonts Library"/*.otf 2>/dev/null | wc -l | tr -d ' ')
if [ "$N" -gt 0 ]; then ok "Fonts Library: $N font file(s)"; else echo "  ! Fonts Library is empty: text will use a stand-in font. Put your .ttf files there."; fi

# 5) Projects build
if [ -n "$RIVE" ] && [ -x "$RIVE" ]; then
  for P in ../Projects/*/; do
    [ -f "$P/rive.yaml" ] || continue
    if (cd "$P" && "$RIVE" . --verify >/dev/null 2>&1); then ok "Project builds: $(basename "$P")"; else echo "  ! Project did not verify (check fonts): $(basename "$P")"; fi
  done
fi

echo
if [ "$MISSING" -eq 0 ]; then
  echo "All set. Next:"
  echo "  1) Double-click  \"Start Helper.command\"  (leave its window open)."
  echo "  2) In Figma: Plugins > Development > Import plugin from manifest > Fig To Rive/plugin/manifest.json"
  echo "  3) Open the plugin, paste the token the helper printed (first time only)."
  echo "  If you use a DIFFERENT Rive account: delete the 'push:' lines in each ../Projects/*/rive.yaml,"
  echo "  and set your project id in \"Figma to Rive/config.json\" (rive push --list shows the ids)."
else
  echo "Fix the ✗ items above, then run ./scripts/setup.sh again."
fi
