import fs from 'fs'; import {execFileSync} from 'child_process';
const ms=JSON.parse(fs.readFileSync('experiments/E3/scratch/meshes.json','utf8')); const all=[];
for(let i=0;i<ms.length;i+=60){ const out=execFileSync('node',['--import','./bin/node-hooks.mjs','bin/s3d-tool.mjs','inspect','--source',...ms.slice(i,i+60).map(m=>m.part),'--project=work/e3'],{maxBuffer:1<<28}).toString(); all.push(...JSON.parse(out)); }
fs.writeFileSync('experiments/E3/scratch/srcall.json',JSON.stringify(all)); console.log(all.length);
