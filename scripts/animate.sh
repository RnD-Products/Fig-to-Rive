#!/bin/bash
# One command: Rive file (from the plugin) -> animated, Webflow-safe, previewed, pushed as a NEW file "<name> animated".
#   ./scripts/animate.sh <rive file link or id> [--no-push] [--no-webflow]
# Your imported file is never changed. Preview images land in ../Projects/<name>/build/preview-*.png.
cd "$(dirname "$0")/.." || exit 1
RIVE="${RIVE_BIN:-$HOME/.rive/bin/rive}"; [ -x "$RIVE" ] || RIVE="$(command -v rive)"
PY="$(command -v python3 || command -v python)"; [ -z "$PY" ] && { echo "Python 3 is not installed (python.org)."; exit 1; }
IN="$1"; shift
[ -z "$IN" ] && { echo "usage: ./scripts/animate.sh <rive file link or id> [--no-push] [--no-webflow]"; exit 1; }
ID=$(echo "$IN" | grep -oE '[0-9]{6,}' | tail -1)
[ -z "$ID" ] && { echo "could not find a file id in: $IN"; exit 1; }
PUSH=1; WF="--webflow"
for a in "$@"; do [ "$a" = "--no-push" ] && PUSH=0; [ "$a" = "--no-webflow" ] && WF=""; done
"$RIVE" whoami >/dev/null 2>&1 || { echo "Not signed in to Rive. Run:  $RIVE login"; exit 1; }
TMP=$(mktemp -d)
"$RIVE" create "$TMP/p" --from-remote-file="$ID" >/dev/null 2>&1 || { echo "could not pull file $ID"; exit 1; }
NAME=$($PY - "$TMP/p/rive.yaml" <<'P'
import re,sys
t=open(sys.argv[1]).read()
m=re.search(r'^name:\s*"?([^"\n]+)"?',t,re.M); print(m.group(1).strip() if m else 'kit')
P
)
DEST="../Projects/$NAME"
mkdir -p ../Projects
[ -e "$DEST" ] && DEST="$DEST $(date +%H%M%S)"      # never overwrite an existing project
mv "$TMP/p" "$DEST"; rmdir "$TMP"
PID=$(sed -n 's/.*projectId[: ]*\([0-9]*\).*/\1/p' "$DEST/rive.yaml" | head -1)
$PY - "$DEST/rive.yaml" "$NAME animated" <<'P'
import re,sys
t=open(sys.argv[1]).read()
t=re.sub(r'^push:.*?(?=^\S|\Z)','',t,flags=re.S|re.M)
t=re.sub(r'^name:.*$','name: "%s"'%sys.argv[2],t,count=1,flags=re.M)
open(sys.argv[1],'w').write(t)
P
$PY tools/auto_kit.py "$DEST" $WF || exit 1
if [ $PUSH = 1 ]; then
  P=$PID
  (cd "$DEST" && "$RIVE" push --yes --name="auto animation" ${P:+--project=$P} 2>&1 | tail -2)
fi
echo "Done: $DEST"
