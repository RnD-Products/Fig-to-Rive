# From Figma to an animated, Webflow-ready Rive file

Two steps. The second is automatic.

## 1. Import with the plugin
1. Double-click **Start Helper.command** in the `Fig To Rive` folder (leave it open).
2. In Figma, open the plugin. Tick **Safe layout** and keep the target on **Webflow** (Framer is locked for now).
3. Send the frame to Rive. The plugin creates a Rive file named after the frame.

Finish the design first: importing a frame again erases its animation.

## 2. Animate with one command
Double-click **Animate.command** (in the `Fig To Rive` folder), paste the Rive file link, press Enter. Or in a terminal:

```bash
./scripts/animate.sh <rive file link or id>        # add --no-push to only build and preview
```

It pulls the file, writes `motion.json` by rules, adds the animation, checks the build, saves previews
(`Projects/<name>/build/preview-60/140/330.png`) and pushes the result as a **new** file `<name> animated`.
The imported file and existing project folders are never changed. You must be signed in (`~/.rive/bin/rive login`).

### What the rules animate
The part named AI is the hero (hover grows it a little). Shapes named Glow fade in. Dashed lines draw themselves and get a
travelling streak. Small round shapes are dots; dashed circles are orbit rings. Boxes become cards (large), icons (small, square)
or pills (flat). Cards and icons float gently and get a soft hover glow.

### What you add by hand
Cursors, drag, the small animations inside icons, and tags or pills built from shapes. Edit
`Projects/<name>/motion.json` (see the kit folders for examples) and run the same command again: an existing `motion.json` is kept.
Helpers: `tools/team_shapes.py` (drag-able cursors), `tag_shapes.py` (tags).

## Webflow rules the output follows
Webflow's Rive element (runtime 2.35) differs from the Rive editor:
- a layout box inside a plain Node is not drawn;
- rotation and mirroring of a layout box are ignored (baked into shapes instead);
- scale on a layout box is ignored, so hover and entrance scaling must be built from shapes (the AI ball and glows are);
- dragging a layout box does nothing: drag needs shapes in Nodes;
- hug-sized text is measured differently (the AI text gets a fixed box);
- hue and additive blends are drawn wrongly (replaced by plain gradients).
The plugin's **Safe layout** switch applies the layout fixes at import (`plugin/webflow.js`). For files already animated,
`tools/webflow_patch.py <project dir>` does the same on a pulled project.

## Not done yet
- Hover and entrance scale on cards and icons do not show in Webflow.
- Hue/difference blends remain in the live files of kits 1-4 (the plugin switch handles new imports).
- Framer target (locked in the plugin).
- `scripts/animate.sh` has not been run end to end on a fresh plugin import.

## Where things are
| Path | What |
|---|---|
| `Fig To Rive/` | the main folder |
| `Fig To Rive/plugin/` | the Figma plugin: converter (`convert.js`), Webflow pass (`webflow.js`), UI, `dist/` |
| `Fig To Rive/helper/`, `scripts/`, `claude-inbox/`, `Fonts Library/` | the local helper, shell scripts, Send to Claude files, fonts |
| `Projects/<kit>/` | each kit: `motion.json`, `scene.rml`, fonts, `scene.live-webflow-safe.rml.txt` |
| `Fig To Rive/tools/` | `auto_kit.py`, `animate_kit.py`, `webflow_patch.py`, `flatten_layout.py`, `team_shapes.py`, `tag_shapes.py` |
| `Fig To Rive/scripts/animate.sh`, `Fig To Rive/Animate.command` | the one-command run |
