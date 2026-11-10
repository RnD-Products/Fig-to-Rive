# Set up on a new computer

Do these in order. The whole thing takes a few minutes.

## 1. Get the files
```bash
git clone https://github.com/RnD-Products/riveCLi.git
```
The repo is private, so GitHub must be signed in on that computer: use GitHub Desktop, or run `gh auth login` first.

## 2. Run the setup check
```bash
cd riveCLi/"Fig To Rive" && ./scripts/setup.sh
```
It checks Node.js, the Rive CLI, your Rive login, the fonts and the kit projects, and tells you what to fix.
- If it says **Permission denied**, run `chmod +x scripts/setup.sh` once and try again.
- If **Node.js** is missing, install it from https://nodejs.org and run `./scripts/setup.sh` again.
- If the **Rive CLI** is missing, setup asks "Install it now? [y/N]". Answer `y`. (The CLI is installed per computer: it does
  not come from GitHub, and you only do this once on each computer.)

## 3. Sign in to Rive
If setup says you are not signed in:
```bash
rive login
```
It opens your browser: sign in with the Rive account you want to use on this computer. Then run `./scripts/setup.sh` again. Every line
should show a check mark.

## 4. Start the helper
Double-click **`Start Helper.command`** (in the `Fig To Rive` folder) and leave its window open. It signs you in to Rive if needed, picks your Rive project
(asks only if you have several), and prints a token.
To stop it, press Ctrl-C in that window.

## 5. Add the plugin to Figma (once per computer)
In the Figma desktop app: Plugins -> Development -> Import plugin from manifest -> pick `Fig To Rive/plugin/manifest.json`.
Open the plugin, click the **gear icon**, paste the token from step 4 and press **Enter** (first time only). The dot next to the
gear turns green when the helper is connected.

## Using a different Rive account?
- In each `Projects/*/rive.yaml`, delete the `push:` lines. They hold the ids of the Rive file it was uploaded to.
- You do not need to edit `Fig To Rive/config.json`: `Start Helper.command` picks a project from your account and saves it there.
- The next push then creates a new file in your account.

## Good to know
- **Supported computers for the Rive CLI:** Macs with Apple Silicon (M1 or newer) and Linux x86_64. Windows uses
  `irm https://releases.rive.app/cli/install.ps1 | iex`.
- **Nothing about your login moves between computers.** Rive, Figma, GitHub and Claude each sign in separately.
- **Fonts:** put your `.ttf` files in `Fig To Rive/Fonts Library/`, named as the plugin reports (for example `Geist-Medium.ttf`). Without
  them the converter uses a stand-in font.
- **Updating GitHub:** `git add -A && git commit -m "what changed" && git push` from inside the folder.
- **Keep this repo private.** `Exports/` holds your design data and reports.
