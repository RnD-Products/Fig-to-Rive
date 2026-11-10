#!/bin/bash
# Double-click this to start the Fig To Rive helper. Leave the window open; press Ctrl-C to stop.
cd "$(dirname "$0")" || { echo "Cannot open the Fig To Rive folder."; read -r -p "Press Enter to close"; exit 1; }
if ! command -v node >/dev/null 2>&1; then echo "Node.js is not installed. Get it from https://nodejs.org, then double-click this again."; read -r -p "Press Enter to close"; exit 1; fi
node helper/pick-project.js
echo "Starting the helper. Keep this window open while you use the plugin."
node helper/serve.js
echo; read -r -p "The helper stopped. Press Enter to close"
