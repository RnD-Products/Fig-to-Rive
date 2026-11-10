// node run2.js <outDir> [layout]  -> converts sample2 (all effects) and writes a ready-to-verify project
const fs = require('fs'), path = require('path');
const { convert } = require('../plugin/convert.js');
const out = process.argv[2], mode = process.argv[3] === 'layout' ? 'layout' : 'artboard';
const S = (r, g, b, a) => ({ type: 'SOLID', color: { r, g, b, a: a === undefined ? 1 : a } });
const rt = (x, y, deg) => { const t = -deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return [[c, -s, x], [s, c, y]]; }; // figma matrix: rotation about top-left
const text = (id, name, s, extra) => Object.assign({ id, name, type: 'TEXT', x: 0, y: 0, width: 80, height: 18, characters: s, fontSize: 14,
  fontName: { family: 'Inter', style: 'Regular' }, textAutoResize: 'WIDTH_AND_HEIGHT', fills: [S(0.1, 0.1, 0.15)],
  layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG' }, extra || {});
const box = (id, name, x, y, w, h, extra) => Object.assign({ id, name, type: 'RECTANGLE', x, y, width: w, height: h, fills: [S(1, 1, 1)], layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' }, extra || {});
const comp = { id: 'C1', name: 'Chip', type: 'COMPONENT', x: 0, y: 0, width: 90, height: 32, cornerRadius: 16, fills: [S(0.37, 0.89, 0.75)],
  layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER', paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6,
  layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG', children: [text('C2', 'Label', 'Chip')] };
const frame = { id: 'F1', name: 'Effects Sheet', type: 'FRAME', x: 0, y: 0, width: 520, height: 420, fills: [S(0.93, 0.94, 0.96)], layoutMode: 'NONE', clipsContent: true,
  children: [
    box('a', 'Image rounded', 24, 24, 120, 90, { fills: [{ type: 'IMAGE', imageHash: 'abc123', scaleMode: 'FILL' }], cornerRadius: 18 }),
    box('b', 'Inside stroke', 168, 24, 120, 90, { cornerRadius: 18, strokes: [S(1, 0.44, 0.37)], strokeWeight: 8, strokeAlign: 'INSIDE' }),
    box('c', 'Outside stroke', 312, 24, 120, 90, { cornerRadius: 18, strokes: [S(0.2, 0.4, 1)], strokeWeight: 8, strokeAlign: 'OUTSIDE' }),
    box('d', 'Drop shadow', 24, 150, 120, 90, { cornerRadius: 18, effects: [{ type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.35 }, offset: { x: 0, y: 10 }, radius: 16 }] }),
    box('e', 'Inner shadow', 168, 150, 120, 90, { cornerRadius: 18, effects: [{ type: 'INNER_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.4 }, offset: { x: 0, y: 6 }, radius: 10 }] }),
    { id: 'f', name: 'Blurred circle', type: 'ELLIPSE', x: 330, y: 150, width: 80, height: 80, fills: [S(0.2, 0.4, 1)], effects: [{ type: 'LAYER_BLUR', visible: true, radius: 8 }], layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' },
    box('g', 'Rotated 25', 60, 290, 110, 50, { fills: [S(0.2, 0.4, 1)], relativeTransform: rt(60, 290, 25), rotation: 25 }),
    { id: 'h', name: 'Rotated card', type: 'FRAME', x: 220, y: 280, width: 120, height: 60, cornerRadius: 12, fills: [S(1, 1, 1)], relativeTransform: rt(220, 280, -15), rotation: -15,
      layoutMode: 'HORIZONTAL', primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
      children: [text('i', 'Tilted label', 'Tilted')] },
    { id: 'j', name: 'Chip instance', type: 'INSTANCE', x: 380, y: 300, width: 90, height: 32, cornerRadius: 16, fills: [S(0.37, 0.89, 0.75)], layoutMode: 'HORIZONTAL',
      primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER', paddingLeft: 12, paddingRight: 12, paddingTop: 6, paddingBottom: 6, layoutSizingHorizontal: 'HUG', layoutSizingVertical: 'HUG',
      children: [text('k', 'Label', 'Chip')] },
  ] };
const res = convert({ nodes: [frame], components: [comp], images: { abc123: { ext: 'png' } } }, { name: 'effects-test', frameMode: mode, componentArtboards: true });
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true }); fs.mkdirSync(path.join(out, 'images'), { recursive: true });
fs.writeFileSync(path.join(out, 'scene.rml'), res.rml); fs.writeFileSync(path.join(out, 'rive.yaml'), res.yaml);
fs.copyFileSync(path.join(__dirname, 'pic.png'), path.join(out, 'images', 'abc123.png'));
res.fonts.forEach(f => fs.copyFileSync(process.env.HOME + '/.rive/versions/1.5.1/samples/text_island/Inter.ttf', path.join(out, f.file)));
console.log('warnings:', res.warnings, '\nnotes:', res.notes);
if (process.env.PAYLOAD) {
  fs.writeFileSync(process.env.PAYLOAD, JSON.stringify({ name: 'effects-test', fileId: process.env.FILE_ID || '', rml: res.rml, yaml: res.yaml, fonts: res.fonts,
    images: res.images.map(im => ({ file: im.file, base64: fs.readFileSync(path.join(__dirname, 'pic.png')).toString('base64') })) }));
}
