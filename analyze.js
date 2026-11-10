/* Design analysis: look at a Figma snapshot BEFORE importing and say what will break,
 * what will look different in Rive, and how to fix it in Figma.
 *
 * Pure function over the same plain-JSON snapshot convert.js uses, so it runs in the
 * plugin UI and in Node. It mirrors what convert.js can and cannot do: when you add a
 * feature to the converter, retire the matching rule here.
 *
 *   analyze(snapshot, { frameMode, componentArtboards }) ->
 *     { verdict, score, counts:{error,warning,info}, issues:[...], fonts:[...], stats:{...} }
 *
 * issue = { id, severity: 'error'|'warning'|'info', title, why, fix, count, nodes:[{id,name}] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FigmaAnalyze = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONTAINERS = { FRAME: 1, GROUP: 1, COMPONENT: 1, INSTANCE: 1, COMPONENT_SET: 1 };
  var LEAVES = { RECTANGLE: 1, ELLIPSE: 1, LINE: 1, VECTOR: 1, STAR: 1, POLYGON: 1, BOOLEAN_OPERATION: 1, TEXT: 1 };
  var DEFAULT_NAME = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Text|Component|Instance|Polygon|Star|Image|Boolean|Union|Subtract|Intersect|Exclude|Section)( ?\d+)?$/;
  var BLEND_OK = { LINEAR_DODGE: 1, SCREEN: 1, MULTIPLY: 1, OVERLAY: 1, DARKEN: 1, LIGHTEN: 1, COLOR_DODGE: 1, COLOR_BURN: 1, HARD_LIGHT: 1, SOFT_LIGHT: 1, DIFFERENCE: 1, EXCLUSION: 1, HUE: 1, SATURATION: 1, COLOR: 1, LUMINOSITY: 1 };
  var MAX_NODES_PER_ARTBOARD = 1500;
  var MAX_DEPTH = 12;
  var BIG_IMAGE_BYTES = 1500000;
  var BIG_ARTBOARD = 4096;

  function analyze(snapshot, options) {
    options = options || {};
    var issues = {};
    var order = [];
    var stats = { nodes: 0, frames: 0, texts: 0, images: 0, autoLayoutFrames: 0, hidden: 0, instances: 0 };
    var fontSet = {};

    var QUIET_FOR_ILLUSTRATIONS = { 'default-names': 1, group: 1, fractional: 1, deep: 1, 'no-autolayout': 1, empty: 1, 'clip-shadow': 1 };
    function add(id, severity, title, why, fix, node) {
      if (typeof illustration !== 'undefined' && illustration && QUIET_FOR_ILLUSTRATIONS[id]) return;
      var it = issues[id];
      if (!it) { it = issues[id] = { id: id, severity: severity, title: title, why: why, fix: fix, count: 0, nodes: [] }; order.push(id); }
      it.count++;
      if (node && it.nodes.length < 300) it.nodes.push({ id: node.id, name: node.name });
    }
    function visible(list) { return (list || []).filter(function (p) { return p.visible !== false && p.opacity !== 0; }); }
    function hasAL(n) { return n.layoutMode === 'HORIZONTAL' || n.layoutMode === 'VERTICAL'; }
    function isFlipped(n) {
      var m = n.relativeTransform; if (!m) return false;
      return (m[0][0] * m[1][1] - m[0][1] * m[1][0]) < 0;
    }
    function hasCurves(n) {
      return (n.vectorPaths || []).some(function (vp) { return /[CcQqSsTtAa]/.test(vp.data || ''); });
    }
    function surfaceless(n) {
      return !visible(n.fills).length && !(visible(n.strokes).length && n.strokeWeight);
    }

    function visit(node, parent, depth, board) {
      if (node.visible === false) { stats.hidden++; add('hidden', 'info', 'Hidden layers are skipped', 'Layers that are switched off in Figma are not imported.', 'Nothing to do. Delete them if they are leftovers so the file stays clean.', node); return; }
      stats.nodes++; board.count++;
      if (depth > board.depth) board.depth = depth;
      var t = node.type;

      // ---- things the converter does not handle at all ---------------
      if (!CONTAINERS[t] && !LEAVES[t]) {
        add('unsupported-type', 'error', 'Unsupported layer type (' + t + ')', t + ' layers are skipped, so they will be missing in Rive.', 'Replace them with a frame, shape or text layer, or recreate them in Rive.', node);
        return;
      }
      if (node.isMask) {
        add('mask', 'error', 'Mask layers', 'Figma masks are not converted. The masked content will show unmasked.', 'Use a frame with "Clip content" and a corner radius instead of a mask, or put the image in a rounded rectangle as an image fill.', node);
      }
      if (node.blendMode && node.blendMode !== 'NORMAL' && node.blendMode !== 'PASS_THROUGH' && !BLEND_OK[node.blendMode]) {
        add('blend', 'warning', 'Blend modes with no Rive equivalent', 'The ' + node.blendMode + ' blend mode does not exist in Rive, so the layer blends normally.', 'Flatten the effect into the colours, or pick the closest mode (for example Multiply or Screen) in Figma.', node);
      }
      if (isFlipped(node)) {
        add('flipped', 'warning', 'Flipped (mirrored) layers', 'Mirrored layers import un-mirrored.', 'In Figma, flatten the flip (Object → Flatten / Outline stroke) or redraw it mirrored; for icons, export a mirrored copy.', node);
      }
      var name = node.name || '';
      if (DEFAULT_NAME.test(name)) add('default-names', 'info', 'Layers with default names', 'Layer names become names in the Rive hierarchy and are how scripts and state machines find things.', 'Rename the layers you plan to animate or script (for example "Avatar", "Submit button").', node);

      // ---- layout ----------------------------------------------------
      if (CONTAINERS[t]) {
        stats.frames++;
        if (t === 'INSTANCE') stats.instances++;
        if (hasAL(node)) stats.autoLayoutFrames++;
        var kids = (node.children || []).filter(function (c) { return c.visible !== false; });
        if (t === 'COMPONENT_SET') {
          add('component-set', 'warning', 'Component sets (variants)', 'A component set imports as one artboard with every variant stacked, which is rarely what you want.', 'Select one variant at a time, or detach the variants you need. State changes are better built as a Rive state machine.', node);
        }
        if (t !== 'GROUP' && !hasAL(node) && kids.length >= 2 && depth > 0) {
          add('no-autolayout', 'warning', 'Frames without auto layout', 'Their children are placed by position, so they import as fixed boxes and will not reflow when the content or size changes.', 'Select the frame and press Shift+A to add auto layout, then set direction, gap and padding. Ignore this for illustrations that should stay fixed.', node);
        }
        if (t === 'GROUP') {
          add('group', 'info', 'Groups', 'Groups cannot hold layout, so they import as fixed containers.', 'Where the content should flow or resize, convert the group to a frame (Cmd+Opt+G) and add auto layout.', node);
        }
        if (kids.length === 0 && surfaceless(node) && t !== 'INSTANCE') {
          add('empty', 'info', 'Empty frames', 'They draw nothing but still become layout boxes.', 'Delete them, unless they are spacers you need.', node);
        }
        if (t === 'INSTANCE') {
          add('instance', 'info', 'Component instances are detached', 'Instances import as ordinary layout; they stay linked to nothing, so editing the component later will not update them in Rive.', options.componentArtboards === false ? 'Turn on "Components" to also create Rive component artboards.' : 'The main component is also added as a Rive component artboard you can reuse.', node);
        }
        if (hasAL(node)) {
          (node.children || []).forEach(function (c) {
            if (c.visible !== false && c.relativeTransform && !isFlipped(c) && Math.abs(Math.atan2(c.relativeTransform[1][0], c.relativeTransform[0][0])) > 0.01 && c.layoutPositioning !== 'ABSOLUTE') {
              add('rotated-in-al', 'warning', 'Rotated layers inside auto layout', 'Figma lays rotated layers out by their rotated bounding box; Rive lays them out unrotated and then rotates, so neighbours can shift.', 'Wrap the rotated layer in its own fixed-size frame, or set it to "Ignore auto layout" (absolute position).', c);
            }
          });
        }
      }

      // ---- text ------------------------------------------------------
      if (t === 'TEXT') {
        stats.texts++;
        if (node.hasMissingFont) add('missing-font', 'error', 'Missing fonts', 'Figma is using a fallback font here, so the real font name is unknown.', 'Install the font or choose another one in Figma, then analyse again.', node);
        (node.segments && node.segments.length ? node.segments : [{ fontName: node.fontName }]).forEach(function (s) {
          if (s.fontName) fontSet[s.fontName.family + '|' + s.fontName.style] = s.fontName;
        });
        if (node.textAlignHorizontal === 'JUSTIFIED') add('justified', 'info', 'Justified text', 'Justified text is imported left-aligned.', 'Use left, centre or right alignment, or accept the difference.', node);
        if ((node.effects || []).some(function (e) { return e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW' || e.type === 'LAYER_BLUR'); })) {
          add('text-effect', 'warning', 'Shadows or blur on text', 'Effects on text are not converted; the text imports without them.', 'Put a blurred copy of the text underneath, or add the effect in Rive.', node);
        }
        if (node.textAutoResize === 'NONE' && node.height < (node.fontSize || 14) * 1.2) {
          add('tight-text', 'info', 'Text boxes that may clip', 'A fixed-size text box shorter than one line of text can cut the text off when a different font is used.', 'Set the text to "Auto height" or "Auto width".', node);
        }
      }

      // ---- paint ------------------------------------------------------
      visible((node.fills || []).concat(node.strokes || [])).forEach(function (p) {
        if (p.blendMode && p.blendMode !== 'NORMAL' && p.blendMode !== 'PASS_THROUGH' && !BLEND_OK[p.blendMode]) {
          add('paint-blend', 'warning', 'Fill or stroke blend modes with no Rive equivalent', 'The ' + p.blendMode + ' blend mode on a fill or stroke does not exist in Rive, so it is drawn normally.', 'Pick the closest mode (for example Multiply or Screen), or bake the effect into the colour.', node);
        }
      });
      var fills = visible(node.fills);
      fills.forEach(function (p) {
        if (/^GRADIENT_(ANGULAR|DIAMOND)$/.test(p.type)) {
          add('gradient', 'warning', 'Angular and diamond gradients', 'Only linear and radial gradients are converted. These import as a solid colour (the first stop).', 'Use a linear or radial gradient, or recreate the gradient in Rive after import.', node);
        }
        if (p.type === 'IMAGE') {
          stats.images++;
          if (p.scaleMode === 'CROP' || p.scaleMode === 'TILE') add('image-mode', 'warning', 'Image crop and tile modes', 'These modes are shown as "fill", so the crop or tiling is lost.', 'Set the image to Fill or Fit, or crop the image file itself first.', node);
          if (!(node.type === 'RECTANGLE' || node.type === 'ELLIPSE' || CONTAINERS[node.type])) {
            add('image-on-vector', 'warning', 'Image fills on vector shapes', 'Images only import on rectangles, ellipses and frames.', 'Put the image in a rectangle or frame and use the vector as a mask (clip) there, or round the rectangle.', node);
          }
          var info = snapshot.images && snapshot.images[p.imageHash];
          if (info && info.size > BIG_IMAGE_BYTES) {
            add('big-image', 'warning', 'Large images', 'Images are embedded at full size (' + (Math.round(info.size / 1000) / 1000).toFixed(1) + ' MB here), which makes the Rive file heavy and slow to load.', 'Export the image at about 2× its display size and compress it (PNG/JPG/WebP), then replace it in Figma.', node);
          }
          if (node.type === 'ELLIPSE' && Math.abs(node.width - node.height) > 0.5) {
            add('image-ellipse', 'info', 'Images in non-circular ellipses', 'They are clipped to a rounded box, not a true ellipse.', 'Use a circle (equal width and height) or a rectangle with corner radius.', node);
          }
        }
      });
      if (visible(node.fills).filter(function (p) { return p.type === 'IMAGE'; }).length && visible(node.strokes).length && (node.strokeAlign === 'INSIDE')) {
        add('image-inside-stroke', 'info', 'Inside strokes over images', 'The image covers the inside half of the stroke.', 'Use a centre stroke, or put the stroke on a separate frame above the image.', node);
      }
      if (node.strokeMixed) {
        add('mixed-stroke', 'warning', 'Different stroke widths per side', 'Per-side stroke widths are not converted.', 'Use one stroke width, or draw the thick sides as separate rectangles or lines.', node);
      }
      // ---- effects ----------------------------------------------------
      (node.effects || []).forEach(function (e) {
        if (e.visible === false) return;
        if (e.type === 'BACKGROUND_BLUR') add('bg-blur', 'warning', 'Background blur (frosted glass)', 'Background blur is not supported in Rive.', 'Fake it with a semi-transparent fill, or add a blurred copy of the background image.', node);
        if ((e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') && e.spread) add('spread', 'info', 'Shadows with spread', 'Shadow spread is ignored; the shadow imports at the layer\'s own size.', 'Set spread to 0 and adjust blur and offset, or use a larger shape under the layer.', node);
        if (e.type === 'LAYER_BLUR' && CONTAINERS[node.type] && (node.children || []).length) {
          add('blur-container', 'warning', 'Layer blur on frames with content', 'Only the frame\'s own fill is blurred, not what is inside it.', 'Apply the blur to the individual layers, or flatten the group first.', node);
        }
      });
      var hasShadow = (node.effects || []).some(function (e) { return e.visible !== false && e.type === 'DROP_SHADOW'; });
      if (hasShadow && !CONTAINERS[node.type] && (node.strokeAlign === 'INSIDE' || node.strokeAlign === 'OUTSIDE') && visible(node.strokes).length) {
        add('stroke-shadow', 'info', 'Inside/outside strokes with a shadow', 'These cannot be combined (the clip would cut the shadow), so the stroke is drawn centred.', 'Use a centre stroke, or put the shadow on a separate rectangle underneath.', node);
      }

      // ---- shapes -----------------------------------------------------
      var w = node.width, h = node.height;
      if (CONTAINERS[node.type] || LEAVES[node.type]) {
        var frac = function (v) { return Math.abs(v - Math.round(v * 2) / 2) > 0.01; };
        if (frac(w) || frac(h)) add('fractional', 'info', 'Fractional sizes', 'Sizes like ' + (Math.round(w * 1000) / 1000) + ' come from scaled or fill-resized layers and can cause blurry edges.', 'Round sizes to whole pixels (Figma: select layers → Shift+Alt+drag, or type clean numbers).', node);
      }

      (node.children || []).forEach(function (c) { visit(c, node, depth + 1, board); });
    }

    // An illustration (mostly shapes, little text, no real layout) is judged differently from an app screen.
    var counts0 = { all: 0, text: 0, shape: 0, frames: 0, al: 0 };
    (function pre(list) { (list || []).forEach(function (n) {
      if (n.visible === false) return; counts0.all++;
      if (n.type === 'TEXT') counts0.text++;
      else if (/^(RECTANGLE|ELLIPSE|VECTOR|STAR|POLYGON|LINE|BOOLEAN_OPERATION)$/.test(n.type)) counts0.shape++;
      if (CONTAINERS[n.type]) { counts0.frames++; if (hasAL(n)) counts0.al++; }
      pre(n.children);
    }); })(snapshot.nodes);
    var illustration = counts0.all > 8 && counts0.text / counts0.all < 0.15 && counts0.shape / counts0.all > 0.3;
    var top = (snapshot.nodes || []);
    var frames = top.filter(function (n) { return CONTAINERS[n.type]; });
    if (!top.length) add('nothing', 'error', 'Nothing selected', 'Select one or more frames to analyse.', 'Click a frame in Figma, then run the analysis again.', null);
    else if (!frames.length) add('no-frame', 'error', 'No frame selected', 'Only frames, components and groups can become artboards.', 'Wrap your layers in a frame (Cmd+Opt+G), then select the frame.', top[0]);

    var names = {};
    frames.forEach(function (f) {
      var board = { count: 0, depth: 0 };
      visit(f, null, 0, board);
      if (board.count > MAX_NODES_PER_ARTBOARD) add('too-many', 'warning', 'Very large frames', f.name + ' has ' + board.count + ' layers; the Rive file will be slow to build and open.', 'Split it into several frames, or flatten decorative layers into images.', f);
      if (board.depth > MAX_DEPTH) add('deep', 'info', 'Deeply nested layers', f.name + ' nests ' + board.depth + ' levels deep, which makes the layout hard to maintain.', 'Remove wrapper frames that only hold one child.', f);
      if (f.width > BIG_ARTBOARD || f.height > BIG_ARTBOARD) add('big-artboard', 'warning', 'Very large artboards', f.name + ' is ' + Math.round(f.width) + '×' + Math.round(f.height) + ' px.', 'Design at the size you will actually show it; Rive scales vectors for you.', f);
      if (names[f.name]) add('dup-name', 'warning', 'Frames with the same name', 'Rive artboard names should be unique so they can be loaded by name.', 'Rename the frames.', f);
      names[f.name] = true;
    });

    // ---- fonts to supply --------------------------------------------
    var fonts = Object.keys(fontSet).map(function (k) {
      var f = fontSet[k], safe = function (s) { return String(s).replace(/[^A-Za-z0-9]+/g, ''); };
      return { family: f.family, style: f.style, file: safe(f.family) + '-' + safe(f.style) + '.ttf' };
    });
    if (fonts.length) {
      add('fonts', 'info', fonts.length + ' font file' + (fonts.length > 1 ? 's' : '') + ' to supply',
        'Rive does not read fonts from Figma, so each font and weight needs a .ttf file: ' + fonts.map(function (f) { return f.file; }).join(', ') + '.',
        'Put the files in the helper\'s Fonts Library folder (or the project\'s fonts folder) using exactly these names. Without them a stand-in font is used.', null);
    }

    if (illustration) add('illustration', 'info', 'Treated as an illustration', 'This design is mostly shapes with little text and no real layout, so layout and naming tips are left out of the score.', 'Nothing to do. Keep layers grouped by part (for example one group per icon) if you plan to animate them.', null);
    var list = order.map(function (id) { return issues[id]; });
    var rank = { error: 0, warning: 1, info: 2 };
    list.sort(function (a, b) { return rank[a.severity] - rank[b.severity] || b.count - a.count; });
    var counts = { error: 0, warning: 0, info: 0 };
    list.forEach(function (i) { counts[i.severity]++; });
    var score = Math.max(0, 100 - counts.error * 25 - counts.warning * 8 - (illustration ? 0 : counts.info));
    var verdict = counts.error ? 'Fix these before importing' : counts.warning ? 'Will import, with differences' : 'Ready to import';
    stats.kind = illustration ? 'illustration' : 'ui';
    return { verdict: verdict, score: score, counts: counts, issues: list, fonts: fonts, stats: stats };
  }

  return { analyze: analyze };
});
