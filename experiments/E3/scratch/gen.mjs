import fs from 'fs';
// usage: node gen.mjs out.s3d [exclude.json]
const ms=JSON.parse(fs.readFileSync('experiments/E3/scratch/meshes.json','utf8'));
const excl=new Set(process.argv[3]?JSON.parse(fs.readFileSync(process.argv[3],'utf8')):[]);
const r1=(v)=>{const x=Math.round(v*10)/10; return String(Object.is(x,-0)?0:x);};
const sz=(a)=>a.map(v=>r1(Math.max(v,0.1))).join(',');
const out=[]; let n=0;
for(const m of ms){ if(excl.has(m.name)) continue; n++;
  if(m.refd) out.push(`over ${m.name} : box size=${sz(m.size)}`);
  else { out.push(`drop ${m.name}`); out.push(`box ${m.name} size=${sz(m.size)} at=${m.pivot.split(',').map(Number).map(r1).join(',')}`); }
}
fs.writeFileSync(process.argv[2], out.join('\n')+'\n'); console.log(n,'objects',out.length,'lines');
