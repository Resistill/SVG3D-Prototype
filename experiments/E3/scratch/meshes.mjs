import fs from 'fs';
const dir='work/e3/base/'; const files=fs.readdirSync(dir).filter(f=>f.endsWith('.s3d'));
const sc=JSON.parse(fs.readFileSync('experiments/E3/scratch/score0o.json','utf8'));
const byPath=new Map(sc.objects.map(o=>[o.path,o]));
const src=new Map((sc.sources||[]).map(s=>[s.name,s]));
const out=[];
for(const f of files){ const lines=fs.readFileSync(dir+f,'utf8').split('\n'); lines.forEach((l,i)=>{ const m=l.match(/^(\s*)mesh (\S+) src="[^"#]*#([^"]+)" size=([-\d.,]+) pivot=([-\d.,]+)(.*)$/); if(!m) return;
 const rest=m[6]; const at=(rest.match(/ at=([-\d.,]+)/)||[])[1]; const rel=(rest.match(/ (on|against|under|inside)=(\S+)/)||[]).slice(1).join('=');
 const shape=(rest.match(/~shape="([^"]+)"/)||[])[1]; const o=byPath.get(m[2]); const s=src.get(m[3]);
 out.push({file:f,line:i+1,indent:m[1].length,name:m[2],part:m[3],size:m[4].split(',').map(Number),pivot:m[5],at,rel,shape,mesh:o?.mesh,stmt:o?.stmt,tris:s?.tris,rest:rest.replace(/~.*/,'')});});}
fs.writeFileSync('experiments/E3/scratch/meshes.json',JSON.stringify(out,null,1));
console.log(out.length, out.filter(x=>x.indent>0).length, 'with rel', out.filter(x=>x.rel).length, 'noat', out.filter(x=>!x.at).length);
const sh={}; for(const x of out){sh[x.shape]=(sh[x.shape]||0)+1} console.log(sh);
console.log(out.filter(x=>!x.at||x.indent>0).slice(0,5));
