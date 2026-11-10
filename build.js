// node build.js  -> dist/ui.html (convert.js and zip.js inlined; manifest points here)
const fs = require('fs');
const t = fs.readFileSync('ui.template.html', 'utf8')
  .replace('/*__CONVERT__*/', () => fs.readFileSync('convert.js', 'utf8'))
  .replace('/*__WEBFLOW__*/', () => fs.readFileSync('webflow.js', 'utf8'))
  .replace('/*__ZIP__*/', () => fs.readFileSync('zip.js', 'utf8'))
  .replace('/*__ANALYZE__*/', () => fs.readFileSync('analyze.js', 'utf8'));
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/ui.html', t);
console.log('wrote dist/ui.html', t.length, 'bytes');
