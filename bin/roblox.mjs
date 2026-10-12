#!/usr/bin/env node
// 工程 → Roblox 基本型的数据（tools/roblox.mjs）：node bin/roblox.mjs <工程目录> [--chunk=4000] [--stud=0.34]
// --stud：每 stud 多少米（默认 0.34，即 5 stud = 1.7 m）；坐标与尺寸乘 工程单位 / stud
// 写到 <工程>/roblox/index.json 与 chunk_<k>.json；预览服务器（bin/serve.mjs）起着时，Studio 里用 HttpService 按块取来拼（docs/agent.md「Roblox」）
import './node-hooks.mjs';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const { openProject } = await import('../tools/project.mjs');
const { robloxPlan } = await import('../tools/roblox.mjs');
const dir = process.argv[2];
const opt = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? '').slice(k.length + 3) || null;
if (!dir) { console.error('用法: node bin/roblox.mjs <工程目录> [--chunk=4000]'); process.exit(1); }
const P = openProject(dir);
const t0 = performance.now();
const r = P.compile();
if (r.errors.length) console.error(`编译有 ${r.errors.length} 个错误（照常导出能导的部分）：${r.errors.slice(0, 3).map((e) => e.message).join('；')}`);
// 小凸包（最大边不到 2 m）写成一块包围框
const plan = robloxPlan(r, { chunkParts: +(opt('chunk') ?? 4000), scale: (P.unit ?? 1) / +(opt('stud') ?? 0.34), smallHull: 2 / (P.unit ?? 1) });
const out = join(dir, 'roblox');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
plan.chunks.forEach((c, k) => writeFileSync(join(out, `chunk_${k}.json`), JSON.stringify(c)));
writeFileSync(join(out, 'index.json'), JSON.stringify(plan.index, null, 1));
console.log(JSON.stringify({ ...plan.index, ms: Math.round(performance.now() - t0) }));
