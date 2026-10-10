#!/usr/bin/env node
// 逆向：node bin/reverse.mjs out/spaceport.L0.glb out/spaceport.L0.s3d [--fidelity=semantic|structure|detail] [--unit=每个场景单位多少米] [--split=components] [--fresh]
// 输出文件已经存在时，把它当作上一次的结果：几何上对得上的物体沿用原来的名字（编辑层的路径不失效）；--fresh 重新起名
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { readParts, reverse } from '../tools/reverse.mjs';
import { prefit } from '../tools/fitpool.mjs';
import { partsGlb } from '../tools/project.mjs';

const [input, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const split = (process.argv.find((a) => a.startsWith('--split=')) ?? '--split=auto').split('=')[1];
const fidelity = (process.argv.find((a) => a.startsWith('--fidelity=')) ?? '--fidelity=detail').split('=')[1];
const unit = +((process.argv.find((a) => a.startsWith('--unit=')) ?? '--unit=1').split('=')[1]);
if (!input || !out) { console.error('用法: node bin/reverse.mjs <模型.glb> <输出.s3d> [--fidelity=semantic|structure|detail] [--unit=1] [--split=auto|nodes|components]'); process.exit(1); }

const level = (/\.(L\d)\./.exec(input) ?? [])[1] ?? '?';
const t0 = performance.now();
const parts = await readParts(input, { split });
// mesh 的 src 写成相对输出文件的路径
const previous = !process.argv.includes('--fresh') && existsSync(out) ? readFileSync(out, 'utf8') : null;
const pre = await prefit(parts, { fidelity, unit });
// 合并网格拆出来、拟合不了的分量写进同目录的 <输出>.parts.glb，网格引用指向它
const partsFile = out.replace(/^.*[\\/]/, '').replace(/\.s3d$/, '') + '.parts.glb';
const { src, report, objs } = reverse(parts, { srcFile: relative(dirname(out), input).split(sep).join('/'), level, previous, fidelity, unit, prefit: pre, partsFile });
const bin = await partsGlb(parts, objs, partsFile);
if (bin) writeFileSync(out.replace(/\.s3d$/, '.parts.glb'), bin);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, src);
writeFileSync(out.replace(/\.s3d$/, '.report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, ms: Math.round(performance.now() - t0) }, null, 2));
