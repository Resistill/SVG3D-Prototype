#!/usr/bin/env node
// 人与 AI 共用的工具（一律 JSON 输出）：node bin/s3d-tool.mjs <命令> [参数…] [--键=值] --project=工程目录
//   node bin/s3d-tool.mjs init out/spaceport.L2.glb --project=work/spaceport
//   node bin/s3d-tool.mjs score --project=work/spaceport
//   node bin/s3d-tool.mjs render --view=iso --mode=labels --focus=tower --project=work/spaceport
//   node bin/s3d-tool.mjs help
import { COMMANDS, runCommand } from '../tools/agent.mjs';

const [name, ...rest] = process.argv.slice(2);
const args = { _: [] };
for (const a of rest) {
  // 值里可以有换行（多行的 --text）
  const m = /^--([^=]+)(?:=([\s\S]*))?$/.exec(a);
  if (m) args[m[1]] = m[2] ?? true; else args._.push(a);
}
if (args._.length) args.paths ??= args._;
// 命令不认识的参数：提醒一下（不报错——静默忽略会让人以为生效了）
const known = new Set(['project', 'paths', '_', ...Object.keys(COMMANDS[name]?.args ?? {})]);
const unknown = Object.keys(args).filter((k) => !known.has(k));
if (COMMANDS[name] && unknown.length) console.error(`提醒：${name} 不认识参数 ${unknown.map((k) => '--' + k).join(' ')}（可用：${Object.keys(COMMANDS[name].args ?? {}).map((k) => '--' + k).join(' ')}）`);
if (!name || name === 'help') {
  console.log(JSON.stringify(Object.fromEntries(Object.entries(COMMANDS).map(([k, c]) => [k, { desc: c.desc, args: c.args }])), null, 2));
} else {
  try {
    const out = await runCommand(name, args.project ?? '.', args);
    console.log(JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exitCode = 1;
  }
}
