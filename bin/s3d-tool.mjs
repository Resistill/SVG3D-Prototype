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
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] ?? true; else args._.push(a);
}
if (args._.length) args.paths ??= args._;
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
