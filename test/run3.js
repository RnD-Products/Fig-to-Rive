// node run3.js <outDir>  -> exact-size stroke test: sizes must match Figma pixel for pixel
const fs = require('fs'), path = require('path');
const { convert } = require('../convert.js');
const out = process.argv[2];
const S = (r, g, b, a) => ({ type: 'SOLID', color: { r, g, b, a: a === undefined ? 1 : a } });
const sh = (id, name, type, x, y, w, h, extra) => Object.assign({ id, name, type, x, y, width: w, height: h, fills: [S(1, 0.85, 0.4)], layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED' }, extra || {});
const stroke = (c, w, al) => ({ strokes: [c], strokeWeight: w, strokeAlign: al });
const frame = { id: 'F', name: 'Stroke Test', type: 'FRAME', x: 0, y: 0, width: 420, height: 260, fills: [S(1, 1, 1)], layoutMode: 'NONE', clipsContent: false, children: [
  // free-placed: outer edges must be exactly 50x50 at (20,20) and (100,20)
  sh('a', 'Circle inside 10', 'ELLIPSE', 20, 20, 50, 50, stroke(S(0.1, 0.3, 0.9), 10, 'INSIDE')),
  sh('b', 'Square outside 10', 'RECTANGLE', 110, 30, 50, 50, Object.assign({ cornerRadius: 12 }, stroke(S(0.9, 0.2, 0.2), 10, 'OUTSIDE'))),
  // translucent stroke over a fill: must fall back (a gap would show otherwise)
  sh('c', 'Translucent fallback', 'ELLIPSE', 200, 20, 50, 50, stroke(S(0.1, 0.3, 0.9, 0.5), 10, 'INSIDE')),
  // inside an auto layout row: the slot must keep the 50 px footprint, so the neighbour stays 20 px away
  { id: 'row', name: 'Row', type: 'FRAME', x: 20, y: 130, width: 300, height: 90, fills: [S(0.93, 0.94, 0.97)], layoutMode: 'HORIZONTAL', itemSpacing: 20, paddingLeft: 20, paddingRight: 20, paddingTop: 20, paddingBottom: 20,
    primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'CENTER', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED', clipsContent: false, children: [
      sh('d', 'Row circle', 'ELLIPSE', 20, 20, 50, 50, stroke(S(0.1, 0.3, 0.9), 10, 'INSIDE')),
      sh('e', 'Neighbour', 'RECTANGLE', 90, 20, 50, 50, { fills: [S(0.2, 0.7, 0.4)] }),
      sh('f', 'Dashed ring', 'ELLIPSE', 160, 20, 50, 50, Object.assign({ fills: [], dashPattern: [4, 4], strokeCap: 'NONE', strokeJoin: 'MITER' }, stroke(S(0.1, 0.1, 0.1), 3, 'INSIDE'))),
    ] },
] };
const res = convert({ nodes: [frame] }, { name: 'stroke-test', frameMode: 'artboard' });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'scene.rml'), res.rml); fs.writeFileSync(path.join(out, 'rive.yaml'), res.yaml);
console.log('warnings:', res.warnings);
for (const n of ['Circle inside 10', 'Square outside 10', 'Translucent fallback']) {
  const m = res.rml.match(new RegExp('<Shape[^>]*name="' + n + '"[\\s\\S]*?</Shape>'))[0];
  console.log(n.padEnd(22), (m.match(/<(Ellipse|Rectangle)[^>]*>/) || [])[0].replace(/ name="[^"]*"/, ''), '|', (m.match(/<Stroke thickness="[\d.]+"/) || [])[0], '| clip:', /ClippingShape/.test(m));
}
