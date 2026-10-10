#!/usr/bin/env node
// 各示例的规模与耗时，用来对比每个阶段的改动
//   node bin/stats.mjs [file.s3d …]
import { readFileSync, readdirSync } from 'node:fs';
import { compile } from '../src/s3d.js';

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(new URL('../examples/', import.meta.url)).filter((f) => f.endsWith('.s3d')).map((f) => `examples/${f}`);

const rows = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const t0 = performance.now();
  const r = compile(src, { file: f, resolve: (p) => readFileSync(p, 'utf8') });
  const ms = performance.now() - t0;
  const byRel = {};
  for (const x of r.facts) byRel[x.rel] = (byRel[x.rel] ?? 0) + 1;
  const pairs = new Map();
  for (const x of r.facts) { const k = [x.a, x.b].sort().join('|'); pairs.set(k, (pairs.get(k) ?? 0) + 1); }
  rows.push({
    file: f.replace(/^.*\//, ''), nodes: r.nodes.length, items: r.items.length, ghosts: r.nodes.filter((n) => n.ghost).length,
    facts: r.facts.length, approx: r.facts.filter((x) => x.approx).length, dupPairs: [...pairs.values()].filter((c) => c > 1).length,
    rels: Object.entries(byRel).map(([k, v]) => `${k}:${v}`).join(' '), errors: r.errors.length, ms: Math.round(ms),
  });
}
console.table(rows);
