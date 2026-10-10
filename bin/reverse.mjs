#!/usr/bin/env node
// 逆向：node bin/reverse.mjs out/spaceport.L0.glb out/spaceport.L0.s3d [--split=components]
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { readParts, reverse } from '../tools/reverse.mjs';

const [input, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const split = (process.argv.find((a) => a.startsWith('--split=')) ?? '--split=auto').split('=')[1];
if (!input || !out) { console.error('用法: node bin/reverse.mjs <模型.glb> <输出.s3d> [--split=auto|nodes|components]'); process.exit(1); }

const level = (/\.(L\d)\./.exec(input) ?? [])[1] ?? '?';
const t0 = performance.now();
const parts = await readParts(input, { split });
// mesh 的 src 写成相对输出文件的路径
const { src, report } = reverse(parts, { srcFile: relative(dirname(out), input), level });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, src);
writeFileSync(out.replace(/\.s3d$/, '.report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, ms: Math.round(performance.now() - t0) }, null, 2));
