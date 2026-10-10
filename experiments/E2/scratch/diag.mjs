import { readParts, samplePoints } from '../../../tools/reverse.mjs';
const parts = await readParts('out/spaceport.L2.glb', { split: 'auto' });
const name = process.argv[2];
const p = parts.find(q => (q.uid ?? q.name ?? q.from) === name || q.from === name || q.name === name);
console.log(Object.keys(p), p.name, p.uid, p.from, p.tris.length);
const pts = samplePoints(p.tris, 600, 1);
const [cx, cz] = [Number(process.argv[3]), Number(process.argv[4])];
const bins = {};
for (const q of pts) { const r = Math.hypot(q[0]-cx, q[2]-cz); const key = `y${Math.floor(q[1])} r${r.toFixed(1)}`; bins[key]=(bins[key]||0)+1; }
console.log(Object.entries(bins).sort().map(e=>e.join(':')).join('  '));
