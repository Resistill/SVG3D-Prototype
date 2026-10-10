#!/usr/bin/env node
// 导出 GLB：node bin/export.mjs examples/spaceport.s3d out/spaceport.glb [--level L0|L1|L2]
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sceneToGLB } from '../tools/export.mjs';

const [file, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const level = (process.argv.find((a) => a.startsWith('--level=')) ?? '--level=L0').split('=')[1];
if (!file || !out) { console.error('用法: node bin/export.mjs <场景.s3d> <输出.glb> [--level=L0|L1|L2]'); process.exit(1); }

const { doc, io, parts, skipped } = sceneToGLB(readFileSync(file, 'utf8'), { file, resolve: (p) => readFileSync(p, 'utf8'), level });
mkdirSync(dirname(out), { recursive: true });
await io.write(out, doc);
console.log(`导出 ${parts} 个部件到 ${out}（${level}）${skipped.length ? `，跳过 ${skipped.length} 个 mesh 引用` : ''}`);
