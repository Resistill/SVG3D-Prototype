#!/usr/bin/env node
// 规模压力测试（docs/PLAN2.md 4.5）：spaceport 包成一个 def，复制成 N×N 的网格（随机偏航），导出、逆向、计时
//   node --import ./bin/node-hooks.mjs bin/stress.mjs [N=4] [档位=structure] [par（worker 线程并行拟合）]
//   10×10 约 1.1 万个部件；S3D_TIMING=1 打出逆向各阶段的耗时
import { readFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).href;
const { sceneToGLB } = await import(root + 'tools/export.mjs');
const { partsOfDocument, reverse } = await import(root + 'tools/reverse.mjs');
const { compile } = await import(root + 'src/s3d.js');
const N = +(process.argv[2] ?? 4), fidelity = process.argv[3] ?? 'structure';
const src = readFileSync(new URL('examples/spaceport.s3d', root), 'utf8');
// 材质与 def 留在顶层，其余包进 def port
const lines = src.split(/\r?\n/), top = [], body = [];
const count = (x, ch) => x.split(ch).length - 1;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/^material /.test(l)) { top.push(l); continue; }
  if (/^def /.test(l)) { let d = 0; do { const x = lines[i]; top.push(x); d += count(x, '{') - count(x, '}'); } while (d > 0 && ++i < lines.length); continue; }
  body.push(l);
}
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const tiles = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) tiles.push(`port tile_${i}_${j} at=${i * 260},0,${j * 260} turn=${Math.round(rnd() * 360)}`);
const scene = [...top, 'def port {', ...body.map((l) => '  ' + l), '}', ...tiles].join('\n');
let t = performance.now();
const lap = (w) => { const n = performance.now(); console.log(`${w}: ${((n - t) / 1000).toFixed(1)} s`); t = n; };
const r0 = compile(scene); lap(`编译原文（${r0.nodes.length} 个节点，${r0.errors.length} 个错误${r0.errors.length ? '：' + r0.errors[0].message : ''}）`);
const { doc } = sceneToGLB(scene, { level: 'L0' }); lap('导出');
const parts = partsOfDocument(doc); lap(`读部件（${parts.length} 个）`);
const { prefit } = await import(root + 'tools/fitpool.mjs');
const pre = process.argv[4] === 'par' ? await prefit(parts, { fidelity, unit: 1 }) : null; if (pre) lap(`并行拟合（${pre.count} 个）`);
const out = reverse(parts, { srcFile: 'x.glb', level: 'L0', fidelity, prefit: pre }); lap(`逆向（${out.report.arrays.length} 组阵列，${out.report.mirrors.length} 组镜像）`);
const r1 = compile(out.src); lap(`编译逆向结果（${r1.errors.length} 个错误）`);
