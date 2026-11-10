// Runs in Figma's sandbox. It only *reads* the selection and posts a plain JSON
// snapshot to the UI, which does the conversion (convert.js) and builds the zip.
// Nothing is flattened, outlined or rasterised here, except image fills, which are
// sent as the original image bytes.

figma.showUI(__html__, { width: 440, height: 640 });

var MIXED = figma.mixed;
function plain(v) { return v === MIXED ? undefined : v; }

function snapshot(node, ctx) {
  var o = {
    id: node.id, name: node.name, type: node.type, visible: node.visible,
    x: node.x, y: node.y, width: node.width, height: node.height,
    opacity: node.opacity, rotation: node.rotation, relativeTransform: node.relativeTransform
  };
  // Extra facts the design analysis needs.
  if ('isMask' in node && node.isMask) o.isMask = true;
  if ('blendMode' in node) o.blendMode = node.blendMode;
  if ('dashPattern' in node && node.dashPattern && node.dashPattern.length) o.dashPattern = node.dashPattern;
  if ('fills' in node) {
    o.fills = plain(node.fills) || [];
    o.fills.forEach(function (p) { if (p.type === 'IMAGE' && p.imageHash) ctx.hashes[p.imageHash] = true; });
  }
  if ('strokes' in node) { o.strokes = node.strokes; o.strokeWeight = plain(node.strokeWeight); o.strokeAlign = node.strokeAlign; if (node.strokeWeight === MIXED) o.strokeMixed = true;
    // How the stroke ends and turns, so dashes and corners match (Figma defaults: no cap, miter join).
    if ('strokeCap' in node) o.strokeCap = plain(node.strokeCap);
    if ('strokeJoin' in node) o.strokeJoin = plain(node.strokeJoin);
  }
  if ('effects' in node) o.effects = node.effects;
  if ('cornerRadius' in node) {
    if (node.cornerRadius === MIXED) {
      o.topLeftRadius = node.topLeftRadius; o.topRightRadius = node.topRightRadius;
      o.bottomLeftRadius = node.bottomLeftRadius; o.bottomRightRadius = node.bottomRightRadius;
    } else o.cornerRadius = node.cornerRadius;
  }
  if ('clipsContent' in node) o.clipsContent = node.clipsContent;
  // Auto layout, on the frame itself.
  if ('layoutMode' in node) {
    o.layoutMode = node.layoutMode; o.layoutWrap = node.layoutWrap;
    o.primaryAxisAlignItems = node.primaryAxisAlignItems; o.counterAxisAlignItems = node.counterAxisAlignItems;
    o.itemSpacing = node.itemSpacing; o.counterAxisSpacing = node.counterAxisSpacing;
    o.paddingLeft = node.paddingLeft; o.paddingRight = node.paddingRight;
    o.paddingTop = node.paddingTop; o.paddingBottom = node.paddingBottom;
  }
  // How this node sits inside an auto layout parent.
  if ('layoutSizingHorizontal' in node) { o.layoutSizingHorizontal = node.layoutSizingHorizontal; o.layoutSizingVertical = node.layoutSizingVertical; }
  if ('layoutPositioning' in node) o.layoutPositioning = node.layoutPositioning;
  ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) { if (node[k]) o[k] = node[k]; });
  if (node.type === 'TEXT') {
    o.characters = node.characters;
    if (node.hasMissingFont) o.hasMissingFont = true;
    o.fontName = plain(node.fontName); o.fontSize = plain(node.fontSize);
    o.textAutoResize = node.textAutoResize;
    o.textAlignHorizontal = node.textAlignHorizontal; o.textAlignVertical = node.textAlignVertical;
    // One entry per run of identical styling, so mixed text stays mixed text.
    o.segments = node.getStyledTextSegments(['fontSize', 'fontName', 'letterSpacing', 'lineHeight', 'fills']);
    o.segments.forEach(function (s) { (s.fills || []).forEach(function (p) { if (p.type === 'IMAGE' && p.imageHash) ctx.hashes[p.imageHash] = true; }); });
  }
  if ('vectorPaths' in node) o.vectorPaths = node.vectorPaths;
  // Different ends can have different caps (a dot at one end). The node-level cap is then "mixed", so read it per point.
  if (node.type === 'VECTOR' && node.strokeCap === MIXED && node.vectorNetwork) {
    var caps = [];
    node.vectorNetwork.vertices.forEach(function (v) { if (v.strokeCap && v.strokeCap !== 'NONE' && v.strokeCap !== 'ROUND' && v.strokeCap !== 'SQUARE') caps.push({ x: v.x, y: v.y, cap: v.strokeCap }); });
    if (caps.length) o.endCaps = caps;
  }
  if (node.type === 'INSTANCE') { ctx.instances.push(node); ctx.instanceSnaps.push(o); }
  if ('children' in node) o.children = node.children.map(function (c) { return snapshot(c, ctx); });
  return o;
}

function imageExt(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return 'png';
  if (b[0] === 0xFF && b[1] === 0xD8) return 'jpg';
  if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'webp';
  return 'png';
}

async function build(sel, wantComponents, forAnalysis) {
  var ctx = { hashes: {}, instances: [], instanceSnaps: [] };
  var nodes = sel.map(function (n) { return snapshot(n, ctx); });
  // Detached instances: collect their main components so they can also become component artboards.
  var components = [], seen = {};
  if (wantComponents) {
    for (var i = 0; i < ctx.instances.length; i++) {
      var main = await ctx.instances[i].getMainComponentAsync();
      if (main) ctx.instanceSnaps[i].mainComponentId = main.id; // lets the converter link the instance to its component artboard
      if (main && !seen[main.id]) { seen[main.id] = true; var cs = snapshot(main, ctx); if (main.parent && main.parent.type === 'COMPONENT_SET') cs.setName = main.parent.name; components.push(cs); }
    }
  }
  var images = {}, bytes = {};
  var hashes = Object.keys(ctx.hashes);
  for (var j = 0; j < hashes.length; j++) {
    var img = figma.getImageByHash(hashes[j]);
    if (!img) continue;
    var data = await img.getBytesAsync();
    images[hashes[j]] = { ext: imageExt(data), size: data.length };
    if (!forAnalysis) bytes[hashes[j]] = data;
  }
  return { nodes: nodes, components: components, images: images, imageBytes: bytes };
}

function selectionInfo() {
  var sel = figma.currentPage.selection;
  return {
    count: sel.length, names: sel.slice(0, 8).map(function (n) { return n.name; }), types: sel.slice(0, 8).map(function (n) { return n.type; }),
    ids: sel.slice(0, 8).map(function (n) { return n.id; }),
    sizes: sel.slice(0, 8).map(function (n) { return [Math.round(n.width), Math.round(n.height)]; }),
    page: figma.currentPage.name, file: figma.root.name
  };
}
function sendSelection() { var i = selectionInfo(); i.type = 'selection'; figma.ui.postMessage(i); }

// ---- clean-up tools: tidy layer names and snap fractional positions/sizes to whole pixels ----------------
function walkNodes(list, deep, fn) { list.forEach(function (n) { fn(n); if (deep && 'children' in n) walkNodes(n.children, true, fn); }); }
var GENERIC = /^(Frame|Group|Rectangle|Ellipse|Vector|Line|Polygon|Star|Slice|Section|Component|Instance|Boolean|Union|Subtract|Intersect|Exclude)\s+\d+$/i;
function cleanedName(name, o) {
  var n = String(name);
  if (o.symbols) n = n.replace(/[\u0000-\u001F\u200B-\u200F\u2028-\u202F\uFE0F]|[\uD83C-\uD83E][\uDC00-\uDFFF]|[\u2600-\u27BF]/g, '');
  if (o.spaces) n = n.replace(/\s+/g, ' ').trim();
  if (o.generic && GENERIC.test(n)) n = n.replace(/\s+\d+$/, '');
  return n || String(name);
}
function nameChanges(nodes, o) {
  var out = [];
  walkNodes(nodes, o.deep, function (n) {
    if (n.type === 'TEXT' || n.type === 'PAGE' || n.type === 'DOCUMENT') return; // text layers are named after their content
    var c = cleanedName(n.name, o);
    if (c !== n.name) out.push({ node: n, from: n.name, to: c });
  });
  return out;
}
function pixelChanges(nodes, o) {
  var out = [];
  walkNodes(nodes, o.deep, function (n) {
    if (!('x' in n) || n.type === 'GROUP' || n.type === 'PAGE' || n.type === 'SECTION' || n.removed) return;
    var t = n.relativeTransform, rotated = t && (Math.abs(t[0][1]) > 1e-3 || Math.abs(t[1][0]) > 1e-3), flipped = t && (t[0][0] * t[1][1] - t[0][1] * t[1][0] < 0);
    if (rotated) return;
    var p = n.parent, inAuto = p && 'layoutMode' in p && p.layoutMode !== 'NONE' && n.layoutPositioning !== 'ABSOLUTE';
    var ch = { node: n, name: n.name }, any = false;
    if (o.pos && !inAuto && !flipped) {
      var nx = Math.round(n.x), ny = Math.round(n.y);
      if (Math.abs(nx - n.x) > 0.001 || Math.abs(ny - n.y) > 0.001) { ch.x = nx; ch.y = ny; ch.fromPos = Math.round(n.x * 100) / 100 + ',' + Math.round(n.y * 100) / 100; any = true; }
    }
    if (o.size && 'resize' in n && n.type !== 'TEXT' && n.type !== 'LINE') {
      var hugW = n.layoutSizingHorizontal === 'HUG' || n.layoutSizingHorizontal === 'FILL', hugH = n.layoutSizingVertical === 'HUG' || n.layoutSizingVertical === 'FILL';
      var nw = hugW ? n.width : Math.max(1, Math.round(n.width)), nh = hugH ? n.height : Math.max(1, Math.round(n.height));
      if (Math.abs(nw - n.width) > 0.001 || Math.abs(nh - n.height) > 0.001) { ch.w = nw; ch.h = nh; ch.fromSize = Math.round(n.width * 100) / 100 + '\u00D7' + Math.round(n.height * 100) / 100; any = true; }
    }
    if (any) out.push(ch);
  });
  return out;
}
// Hidden layers (eye switched off) and hidden fills / strokes / shadows. Topmost hidden layers only, and never inside an instance (those cannot be deleted).
function insideInstance(n) { var p = n.parent; while (p && p.type !== 'PAGE' && p.type !== 'DOCUMENT') { if (p.type === 'INSTANCE') return true; p = p.parent; } return false; }
function hiddenLayers(nodes, o) {
  var out = [];
  if (!o.hl) return out;
  (function go(list) { list.forEach(function (n) { if (n.visible === false) { if (!insideInstance(n) && n.type !== 'PAGE') out.push(n); return; } if (o.deep && 'children' in n) go(n.children); }); })(nodes);
  return out;
}
function liveList(arr, isPaint) { return arr.filter(function (x) { return x.visible !== false && !(isPaint && x.opacity === 0); }); }
function hiddenPaints(nodes, o) {
  var out = [];
  if (!o.hp) return out;
  walkNodes(nodes, o.deep, function (n) {
    if (n.visible === false) return;
    var k = 0, keep = {};
    ['fills', 'strokes', 'effects'].forEach(function (prop) {
      if (!(prop in n)) return; var v = n[prop];
      if (!Array.isArray(v) || !v.length) return;
      var l = liveList(v, prop !== 'effects');
      if (l.length !== v.length) { k += v.length - l.length; keep[prop] = l; }
    });
    if (k) out.push({ node: n, name: n.name, count: k, keep: keep });
  });
  return out;
}
function cleanOpts(m) { var o = m.o || {}; return { deep: o.deep !== false, symbols: !!o.symbols, spaces: !!o.spaces, generic: !!o.generic, pos: !!o.pos, size: !!o.size, hl: !!o.hl, hp: !!o.hp }; }

figma.ui.onmessage = function (msg) {
  if (msg.type === 'cleanScan' || msg.type === 'cleanApply') {
    var sel = figma.currentPage.selection, o = cleanOpts(msg);
    if (!sel.length) { figma.ui.postMessage({ type: 'cleanScanResult', empty: true }); return; }
    var nameList = nameChanges(sel, o), pixList = pixelChanges(sel, o), hidL = hiddenLayers(sel, o), hidP = hiddenPaints(sel, o);
    if (msg.type === 'cleanApply') {
      var done = 0, examples = [];
      if (msg.which === 'hidden') {
        hidP.forEach(function (c) { try { for (var k in c.keep) c.node[k] = c.keep[k]; done += c.count; if (examples.length < 6) examples.push(c.name + ': ' + c.count + ' hidden fill/stroke/effect'); } catch (e) {} });
        hidL.forEach(function (n) { try { var nm = n.name; n.remove(); done++; if (examples.length < 6) examples.push(nm + ' (hidden layer)'); } catch (e) {} });
      } else if (msg.which === 'names') {
        nameList.forEach(function (c) { try { c.node.name = c.to; done++; if (examples.length < 6) examples.push(c.from + ' \u2192 ' + c.to); } catch (e) {} });
      } else {
        pixList.forEach(function (c) {
          try {
            var n = c.node;
            if (c.w !== undefined) { if ('resizeWithoutConstraints' in n) n.resizeWithoutConstraints(c.w, c.h); else n.resize(c.w, c.h); }
            if (c.x !== undefined) { n.x = c.x; n.y = c.y; }
            done++; if (examples.length < 6) examples.push(c.name + (c.fromPos ? ': ' + c.fromPos + ' \u2192 ' + c.x + ',' + c.y : '') + (c.fromSize ? ' (' + c.fromSize + ' \u2192 ' + c.w + '\u00D7' + c.h + ')' : ''));
          } catch (e) {}
        });
      }
      figma.commitUndo();
      figma.ui.postMessage({ type: 'cleanDone', which: msg.which, done: done, examples: examples });
      if (!sel[0] || sel.some(function (n) { return n.removed; })) { sel = figma.currentPage.selection; }
      nameList = nameChanges(sel, o); pixList = pixelChanges(sel, o); hidL = hiddenLayers(sel, o); hidP = hiddenPaints(sel, o);
    }
    figma.ui.postMessage({ type: 'cleanScanResult', names: { count: nameList.length, examples: nameList.slice(0, 5).map(function (c) { return c.from + ' \u2192 ' + c.to; }) },
      pixels: { count: pixList.length, examples: pixList.slice(0, 5).map(function (c) { return c.name + (c.fromPos ? ': ' + c.fromPos : '') + (c.fromSize ? ' (' + c.fromSize + ')' : ''); }) },
      hidden: { layers: hidL.length, paints: hidP.reduce(function (a, c) { return a + c.count; }, 0), examples: hidL.slice(0, 4).map(function (n) { return n.name + ' (layer)'; }).concat(hidP.slice(0, 3).map(function (c) { return c.name + ' (' + c.count + ' hidden fill/stroke/effect)'; })) } });
    return;
  }

  if (msg.type === 'loadSettings') {
    Promise.all([figma.clientStorage.getAsync('token'), figma.clientStorage.getAsync('fileLink'), figma.clientStorage.getAsync('opts'), figma.clientStorage.getAsync('links'), figma.clientStorage.getAsync('recents'), figma.clientStorage.getAsync('snaps'), figma.clientStorage.getAsync('dests')]).then(function (v) {
      figma.ui.postMessage({ type: 'settings', token: v[0] || '', fileLink: v[1] || '', opts: v[2] || null, links: v[3] || {}, recents: v[4] || [], snaps: v[5] || {}, dests: v[6] || {}, selection: selectionInfo() });
    });
    return;
  }
  if (msg.type === 'saveSettings') {
    figma.clientStorage.setAsync('token', msg.token); figma.clientStorage.setAsync('fileLink', msg.fileLink); figma.clientStorage.setAsync('opts', msg.opts);
    if (msg.links) figma.clientStorage.setAsync('links', msg.links);
    if (msg.recents) figma.clientStorage.setAsync('recents', msg.recents);
    if (msg.snaps) figma.clientStorage.setAsync('snaps', msg.snaps);
    if (msg.dests) figma.clientStorage.setAsync('dests', msg.dests);
    return;
  }
  if (msg.type === 'convert') {
    var sel = figma.currentPage.selection;
    if (!sel.length) { figma.ui.postMessage({ type: 'error', message: 'Select one or more frames first.' }); return; }
    build(sel, !!msg.components).then(function (snap) {
      snap.type = 'snapshot'; snap.fileName = figma.root.name;
      figma.ui.postMessage(snap);
    }).catch(function (e) { figma.ui.postMessage({ type: 'error', message: 'Could not read the selection: ' + e.message }); });
  }
  if (msg.type === 'analyze') {
    var sel2 = figma.currentPage.selection;
    if (!sel2.length) { figma.ui.postMessage({ type: 'analysisSnapshot', nodes: [], images: {}, components: [] }); return; }
    build(sel2, false, true).then(function (snap) {
      snap.type = 'analysisSnapshot'; figma.ui.postMessage(snap);
    }).catch(function (e) { figma.ui.postMessage({ type: 'error', message: 'Could not analyse the selection: ' + e.message }); });
  }
  if (msg.type === 'sendToClaude') {
    var sel3 = figma.currentPage.selection;
    if (!sel3.length) { figma.ui.postMessage({ type: 'error', message: 'Select one or more frames first.' }); return; }
    (async function () {
      var snap = await build(sel3, true, true);
      // A PNG of each selected frame, scaled so its longest side is at most 1600px, so Claude can see the design.
      var previews = [];
      for (var i = 0; i < sel3.length && i < 6; i++) {
        var n = sel3[i];
        var scale = Math.min(2, 1600 / Math.max(n.width, n.height, 1));
        try {
          var bytes = await n.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale } });
          previews.push({ id: n.id, name: n.name, bytes: bytes, scale: scale });
        } catch (e) { /* a layer that cannot be exported is simply skipped */ }
      }
      snap.type = 'claudePayload'; snap.previews = previews; snap.fileName = figma.root.name;
      figma.ui.postMessage(snap);
    })().catch(function (e) { figma.ui.postMessage({ type: 'error', message: 'Could not read the selection: ' + e.message }); });
  }
  if (msg.type === 'resolveNames') {
    // Current Figma names for saved frame ids, so Recent exports never shows a stale name after a rename.
    Promise.all((msg.ids || []).slice(0, 200).map(function (id) { return figma.getNodeByIdAsync(id).then(function (n) { return [id, n ? n.name : null]; }, function () { return [id, null]; }); })).then(function (pairs) {
      var map = {}; pairs.forEach(function (p) { if (p[1] != null) map[p[0]] = p[1]; });
      figma.ui.postMessage({ type: 'names', map: map });
    });
    return;
  }
  if (msg.type === 'select') {
    Promise.all((msg.ids || []).map(function (id) { return figma.getNodeByIdAsync(id); })).then(function (nodes) {
      nodes = nodes.filter(Boolean);
      if (nodes.length) { figma.currentPage.selection = nodes; figma.viewport.scrollAndZoomIntoView(nodes); }
    });
  }
  if (msg.type === 'close') figma.closePlugin();
};

// Tell the UI when the selection changes so the analysis tab can refresh itself.
figma.on('selectionchange', sendSelection);
