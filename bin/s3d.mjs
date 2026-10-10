#!/usr/bin/env node
// 命令行：编译 .s3d，打印错误、对象世界包围盒与推导出的空间事实
//   node bin/s3d.mjs examples/spaceport.s3d [--json] [--outline=2] [--semantics]
//   --semantics 附加通用语义库（lib/semantics.s3d），概要里会标出识别出的概念
import { readFileSync } from 'node:fs';
import { compile } from '../src/s3d.js';
import { outline } from '../tools/outline.mjs';

const file = process.argv[2];
if (!file) { console.error('用法: node bin/s3d.mjs <file.s3d> [--json]'); process.exit(1); }
const lib = process.argv.includes('--semantics') ? '\n' + readFileSync(new URL('../lib/semantics.s3d', import.meta.url), 'utf8') : '';
const r = compile(readFileSync(file, 'utf8') + lib, { file, resolve: (p) => readFileSync(p, 'utf8') });

const ol = process.argv.find((a) => a.startsWith('--outline'));
if (ol) {
  for (const e of r.errors) console.log(`错误  ${e.file ? e.file + ' ' : ''}第 ${e.line ?? '?'} 行  ${e.message}`);
  console.log(outline(r, { depth: +(ol.split('=')[1] ?? 2) }));
} else if (process.argv.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
} else {
  const f = (v) => v.map((x) => x.toFixed(2).padStart(7)).join(' ');
  for (const e of r.errors) console.log(`错误  ${e.file ? e.file + ' ' : ''}第 ${e.line ?? '?'} 行  ${e.message}`);
  console.log(`\n对象 ${r.nodes.length} 个，几何条目 ${r.items.length} 个\n`);
  for (const n of r.nodes) {
    if (n.depth > 1 || !n.box) continue;
    console.log(`${'  '.repeat(n.depth)}${n.path.padEnd(28)} ${n.kind.padEnd(9)} min[${f(n.box.min)}]  max[${f(n.box.max)}]${n.late ? '  (后置)' : ''}`);
  }
  console.log(`\n空间事实 ${r.facts.length} 条`);
  for (const x of r.facts.slice(0, 60)) console.log('  ' + x.text);
}
// 用 exitCode 而不是 exit()：输出到管道时 exit() 会截断还没写完的内容
process.exitCode = r.errors.length ? 1 : 0;
