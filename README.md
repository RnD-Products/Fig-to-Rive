# Figma to Rive: layout + live text

A Figma plugin that exports the selected frames as a Rive CLI project.

- **Auto layout is kept.** Frame -> `LayoutComponent` + `LayoutComponentStyle` (direction, gap, padding,
  alignment, wrap, hug/fill/fixed, min/max, absolute position). Children get a `LayoutParticipant`.
- **Text is kept as text.** `Text` + `TextStylePaint` + `TextValueRun`, one run per styled segment.
  Nothing is outlined. The fonts it needs are listed; you supply the `.ttf` files.

## One-click: Send to Rive
1. Double-click `Start Helper.command` in the repo root (or run `node pick-project.js && node serve.js`) and leave it running. It signs you in to
   Rive if needed, picks the project pushes go to (saved in `config.json`), and prints a token. In the plugin, click the **gear**, paste the token, press **Enter**.
2. Put real font files in `Fonts Library/` named like the plugin says (`Inter-Regular.ttf`). Missing ones fall back to a stand-in and are flagged.
3. Select frames -> **Send to Rive**. The helper writes `Exports/<name>/`, runs `rive --verify`, and shows the result.
4. Click **Push to my Rive account**. Nothing is pushed until you click. First push creates a file in the project in
   `config.json` (`projectId`, chosen for you at start); later sends update that same file.

Plugin conveniences: the dot by the gear shows helper status; each Figma file remembers its own Rive link; a font check warns
before sending if a font is missing from `Fonts Library/`; **Recent exports** lists your last 5 with Open / Copy link / Update;
**Import options -> Push automatically** skips the extra click (off by default); Enter in the name or link field sends.
The helper listens on loopback only, needs the token, and only ever runs `rive <dir> --verify` and `rive push`.

## The plugin keeps the frame name
Opening the plugin detects the selected frame and shows it ("Detected frame: ..."), and saves its name (plus size, type
and layer id) to `Exports/claude-inbox/current-frame.md` whenever the selection changes (helper must be running).
That name is used as the artboard name and the Rive file name. The plugin does not upload anything on its own: you tell
Claude what to do, and Claude reads `current-frame.md` (and the **Send to Claude** report) and does the work.

## Use (zip only)
1. Figma desktop -> Plugins -> Development -> Import plugin from manifest -> pick `manifest.json`.
2. Select frames -> run the plugin -> Convert -> download the zip.
3. Unzip, put the listed fonts in `fonts/`, then `./push.sh <folder>` (verify) or `rive <folder>` (preview).
   `./push.sh <folder> --push` uploads to your Rive account.

## Develop
`node build.js` inlines `convert.js` + `zip.js` into `dist/ui.html`.
`node test/run.js test/sample.json <outDir>` runs the converter on a sample snapshot.

## Design analysis tab
Before importing, open the **Design analysis** tab (it re-runs when you change the selection). It lists what will break
(red), what will look different (amber) and tips (blue), each with *why* and *how to fix it in Figma*, plus a
**Select layers in Figma** button. It also lists the font files you need to supply. Rules live in `analyze.js`;
`node test/analyze-run.js test/sample-bad.json` shows them on a deliberately broken sample.

## Send to Claude (get help without going back to Figma)
In the Design analysis tab, **Send to Claude** saves the report, a PNG preview of each selected frame and the full design
data into `Exports/claude-inbox/<design name>/`, and a short `Exports/claude-inbox/latest.md`. Then tell Claude in the
chat: "check the inbox". Needs the helper running (`node serve.js`). Everything stays on your machine; sending again
replaces the previous report for that design.

## Re-importing a changed design
Paste the Rive file's link in the plugin and use **Send to Rive** again: the helper downloads the live file, adds the new
version as an extra artboard named `<frame> - updated` (then `- updated 2`, ...) to the right of the existing ones, and
keeps everything already in the file. Backups go to `Exports/backups/`. Nothing is uploaded until you push.

## After changing the plugin's code
`node build.js` rebuilds `dist/ui.html` (it inlines `convert.js`, `analyze.js` and `zip.js`), restart the helper
(`node serve.js`), and run the plugin again in Figma.

## What converts
| Figma | Rive |
|---|---|
| Auto layout frame | `LayoutComponent` (direction, gap, padding, alignment, wrap, hug/fill/fixed, absolute) |
| Text | live `Text` (never outlines); one run per styled segment |
| Image fill | the original image file in `images/`, shown as an `Image` (fill/fit) in a rounded clipping box |
| Clip content + drop shadow | the frame keeps clipping; its shadow is drawn by a non-clipping wrapper around it |
| Inner shadow | an overlay above the frame's contents (Figma shades the layers inside too); strength is capped to the shape size. Checkbox in the plugin to turn it off |
| Fill/stroke/effect blend modes | the same Rive blend modes, set on the individual fill, stroke or shadow |
| Drop shadow | feathered fill (`Feather` with offset; `inner` for inner shadows) |
| Layer blur | `Feather` on the node's own fills and strokes |
| Inside / outside stroke on a rectangle or ellipse | the shape is drawn smaller (inside) or larger (outside) by the stroke width and stroked in the centre, so it covers exactly the same pixels as in Figma (50 px circle + 10 px inside stroke = 40 px circle, 10 px stroke). Falls back to the method below when a translucent stroke sits on a fill, or when shadows/blur are involved |
| Inside stroke (other shapes, frames, fallback) | a 2x stroke clipped to the shape's own outline |
| Outside stroke (other shapes, frames, fallback) | a 2x stroke drawn under an opaque fill |
| Radial gradient | `RadialGradient` (circular; elliptical ones are approximated) |
| Vector curves | real bezier vertices (`CubicDetachedVertex`), not straight segments |
| Dashed stroke | `DashPath` with the same dash/gap pattern; stroke ends (cap) and corners (join) follow Figma, so dashes keep their gaps |
| Blend modes | Rive blend modes (Linear Dodge becomes additive, plus screen, multiply, overlay and more) |
| Rotation | `rotation` about the node centre (layout boxes get a centre `ComponentOrigin`) |
| Instance | detached: imported as plain layout |
| Main component | also added as a Rive component artboard (`isComponent` + `ComponentAsset`) |

Two checkboxes in the plugin: **frame properties become the artboard's** (or the frame is a layout box inside a plain
artboard), and **components** (also create component artboards).

**Safe layout** (off by default; pick the target under it: **Webflow**, or **Framer**, which is locked for now): for Webflow, for files that will play in the Rive element in Webflow, whose runtime (2.35)
differs from the Rive editor. It rewrites the output so it draws the same there: layout boxes in Nodes become layout
boxes, rotations and flips are baked into shapes, centred text gets a fixed box, loose shapes are wrapped in Nodes, auto layout
is baked into absolute positions, and hue/additive blends become plain gradients. Code: `webflow.js` (test it with
`node test/webflow-run.js <snapshot.json> <out dir> js`). Not handled here: scale on layout boxes is ignored by Webflow, so hover and
entrance scaling must be built from shapes. Other targets (Framer, ...) can get their own switch the same way.

## Not converted yet (the plugin lists these when it meets them)
Angular/diamond gradients (first stop used), shadow spread, background blur, linear burn blend, shadow/blur on text,
image modes crop/tile (shown as fill), inside/outside strokes combined with a shadow on plain shapes (drawn centred), justified text,
variable-font axes, instances staying linked to their component.

## Where things live
`Rive Folder/Figma to Rive` is this plugin. Your Rive projects are in `Rive Folder/Projects/`. If you move this folder, stop the helper first, then start it again from the new place and re-import `manifest.json` in Figma (Figma remembers the old path).

## Where the data lives
The plugin folder holds only code, so it can go on GitHub. The helper keeps its data **next to it**:
`../Exports/` (exports, `claude-inbox/`, `backups/`) and `../Fonts Library/` (your `.ttf` files). Change them with
`exportsDir` / `fontsDir` in `config.json`. `.token` (the helper's secret) is git-ignored.
