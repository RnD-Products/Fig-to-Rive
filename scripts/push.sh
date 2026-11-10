#!/bin/sh
# Verify an unzipped plugin export, then (optionally) push it to your Rive account.
#   ./scripts/push.sh path/to/exported-folder          verify + preview-ready check only
#   ./scripts/push.sh path/to/exported-folder --push   also `rive push` (asks Rive to confirm)
set -e
dir="${1:?usage: push.sh <exported-folder> [--push]}"
rive "$dir" --verify
rive inspect "$dir" --summary
if [ "$2" = "--push" ]; then rive push "$dir"; else echo "Verified. Add --push to upload to your Rive account."; fi
