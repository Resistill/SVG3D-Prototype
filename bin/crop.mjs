#!/usr/bin/env node
// 区域裁剪：node bin/crop.mjs <大场景.glb> <输出.glb> --box=x0,y0,z0,x1,y1,z1 [--include=正则] [--exclude=正则]
import { NodeIO } from '@gltf-transform/core';
import { cropDocument } from '../tools/crop.mjs';

const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(k.length + 3) || null;
if (!input || !output) { console.error('用法: node bin/crop.mjs <大场景.glb> <输出.glb> --box=x0,y0,z0,x1,y1,z1 [--include=正则] [--exclude=正则]'); process.exit(1); }
const b = opt('box')?.split(',').map(Number);
const io = new NodeIO();
const doc = await io.read(input);
const rep = cropDocument(doc, { box: b && { min: b.slice(0, 3), max: b.slice(3) }, include: opt('include') && new RegExp(opt('include')), exclude: opt('exclude') && new RegExp(opt('exclude')) });
await io.write(output, doc);
console.log(JSON.stringify(rep));
