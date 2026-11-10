// node analyze-run.js <snapshot.json>  -> prints the design analysis
const { analyze } = require('../analyze.js');
const snap = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const r = analyze(snap, {});
console.log(r.verdict, '| score', r.score, '|', JSON.stringify(r.counts), '|', JSON.stringify(r.stats));
r.issues.forEach(i => console.log(`[${i.severity}] ${i.title} x${i.count}  (${i.nodes.slice(0,3).map(n=>n.name).join(', ')})`));
