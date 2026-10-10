import fs from 'fs';
const dir='work/e3/base/'; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.s3d'));
const ms=JSON.parse(fs.readFileSync('experiments/E3/scratch/meshes.json','utf8'));
const names=new Set(ms.map(m=>m.name)); const ref=new Map();
for(const f of files){ for(const l of fs.readFileSync(dir+f,'utf8').split('\n')){ const s=l.replace(/\s~\S+=("[^"]*"|\S+)/g,'').replace(/src="[^"]*"/,''); const decl=(s.match(/^\s*\S+\s+(\S+)/)||[])[1];
  for(const m of s.matchAll(/(?:=|\bof=|\[|;|\s)([A-Za-z_][\w]*)(?=[\[.\s,;\]]|$)/g)){ const n=m[1]; if(names.has(n)&&n!==decl){ ref.set(n,(ref.get(n)||0)+1);} } } }
console.log('referenced meshes',ref.size); console.log([...ref].slice(0,10));
for(const m of ms) m.refd=ref.get(m.name)||0;
fs.writeFileSync('experiments/E3/scratch/meshes.json',JSON.stringify(ms,null,1));
