#!/usr/bin/env node
// 闭环评测：node bin/eval.mjs examples/spaceport.s3d out/spaceport.L0.s3d [--json]
import { readFileSync } from 'node:fs';
import { evaluate } from '../tools/eval.mjs';

const [orig, recon] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!orig || !recon) { console.error('用法: node bin/eval.mjs <原始.s3d> <逆向.s3d> [--json]'); process.exit(1); }
const read = (p) => readFileSync(p, 'utf8');
const r = evaluate(read(orig), read(recon), { orig: { file: orig, resolve: read }, recon: { file: recon, resolve: read } });
if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); process.exit(0); }
const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`编译错误      原始 ${r.errors.orig} · 逆向 ${r.errors.recon}`);
console.log(`对象          原始 ${r.objects.orig} · 逆向 ${r.objects.recon} · 匹配 ${r.objects.matched} · 平均 IoU ${r.objects.meanIoU}`);
console.log(`形状种类      ${r.kinds.correct}/${r.kinds.fittable} 正确（${pct(r.kinds.accuracy)}）；复杂形状 ${r.kinds.complex} 个，其中 ${r.kinds.complexAsMesh} 个保留为 mesh`);
console.log(`              ${Object.entries(r.kinds.confusion).map(([k, v]) => `${k}:${v}`).join('  ')}`);
for (const [k, v] of Object.entries(r.facts)) console.log(`事实 ${k.padEnd(10)} 真值 ${String(v.truth).padStart(4)} · 找到 ${String(v.found).padStart(4)} · P ${v.precision} · R ${v.recall} · F1 ${v.f1}`);
console.log(`坐标依赖率    ${pct(r.description.coordinateRatio)}（世界坐标定位，越低越好）；相对锚点 ${pct(r.description.anchorRatio)}`);
console.log(`语句数比      ${r.description.statementRatio}（逆向 / 原始）`);
