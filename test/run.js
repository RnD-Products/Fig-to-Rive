// node run.js sample.json <outDir>  -> writes scene.rml, rive.yaml, and prints warnings + fonts needed
const fs = require('fs'), path = require('path');
const { convert } = require('../convert.js');
const [,, inFile, outDir] = process.argv;
const res = convert(JSON.parse(fs.readFileSync(inFile, 'utf8')), { name: 'figma-import' });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'scene.rml'), res.rml);
fs.writeFileSync(path.join(outDir, 'rive.yaml'), res.yaml);
console.log('fonts needed:', res.fonts.map(f => f.file));
console.log('warnings:', res.warnings);
