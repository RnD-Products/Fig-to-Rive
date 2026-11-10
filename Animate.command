#!/bin/bash
cd "$(dirname "$0")" || exit 1
echo "Paste the Rive file link (from the plugin) and press Enter:"; read -r L
./scripts/animate.sh "$L"
echo; read -n 1 -s -r -p "Press any key to close"
