// 工程：人与 AI 共用的一个目录（docs/PLAN2.md 2.2）。工具与界面都只通过这里读写，没有隐藏状态。
//   project.json   源模型、分数常数、容差
//   scene.s3d      组合根：import 各层（工具与界面只编译它）
//   base.s3d       逆向基础层（机器生成，重跑逆向会重写；人和 AI 不直接改）
//   edits.s3d      修改层；semantics.s3d 语义层；style.s3d 风格层；decisions.s3d 决定层（逆向的约束，不进 scene）
//   state/         选中状态等；renders/ 渲染图；score.json 最近一次评分
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/s3d.js';
import { readParts, reverse } from './reverse.mjs';
import { SCORE_DEFAULTS } from './score.mjs';

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '../lib/semantics.s3d');
export const LAYERS = ['base.s3d', 'edits.s3d', 'semantics.s3d', 'style.s3d'];
// 计入描述长度的层：语义与风格不描述几何
export const GEOMETRY_LAYERS = ['base.s3d', 'edits.s3d'];

const HEADERS = {
  'edits.s3d': '// 修改层：over / drop / copy / 新物体 / def 扩展。重跑逆向后这里的路径仍然有效（稳定命名）\n',
  'semantics.s3d': (dir) => `// 语义层：concept / pattern / check\nimport "${relative(dir, LIB)}"\n`,
  'style.s3d': '// 风格层：只改外观（mat / color / use=）\n',
  'decisions.s3d': '// 决定层：对逆向的约束（哪些部件是一个物体、是一个阵列、是同一个类型、保留为网格……），重跑逆向时遵守。不进 scene\n',
};

const sha1 = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');

export function openProject(dir) {
  dir = resolve(dir);
  const cfgPath = join(dir, 'project.json');
  if (!existsSync(cfgPath)) throw new Error(`${dir} 不是 SVG3D 工程（没有 project.json）；先运行 init`);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const P = {
    dir, cfg,
    path: (name) => join(dir, name),
    read: (name) => readFileSync(join(dir, name), 'utf8'),
    write: (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); },
    exists: (name) => existsSync(join(dir, name)),
    sourcePath: () => resolve(dir, cfg.source),
    // 编译组合根；extra 是临时追加在末尾的语句（临时查询），overrides 是虚拟替换的层内容（预览提议，不碰磁盘）
    compile(extra = '', overrides = {}) {
      const main = 'scene.s3d';
      const text = P.read(main) + (extra ? '\n' + extra : '');
      return compile(text, { file: main, resolve: (p) => overrides[p] ?? readFileSync(resolve(dir, p), 'utf8') });
    },
    // 计入描述长度的文本
    geometryFiles: (overrides = {}) => GEOMETRY_LAYERS.filter((f) => overrides[f] != null || P.exists(f)).map((f) => ({ file: f, text: overrides[f] ?? P.read(f) })),
    _parts: null,
    async sourceParts() { return (P._parts ??= await readParts(P.sourcePath(), { split: cfg.split ?? 'auto' })); },
    selection() { try { return JSON.parse(P.read('state/selection.json')); } catch { return { paths: [] }; } },
  };
  return P;
}

// 新建工程：记录源模型，跑一次逆向，生成各层文件
export async function initProject(dir, source, { split = 'auto', copy = false } = {}) {
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'project.json'))) throw new Error(`${dir} 已经是一个工程`);
  let src = resolve(source);
  if (copy) { mkdirSync(join(dir, 'source'), { recursive: true }); const to = join(dir, 'source', 'world.glb'); writeFileSync(to, readFileSync(src)); src = to; }
  const cfg = { version: 1, source: relative(dir, src), sourceHash: sha1(src), split, score: { ...SCORE_DEFAULTS }, tolerance: { abs: 0.01, rel: 0.005 } };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(cfg, null, 2) + '\n');
  writeFileSync(join(dir, 'scene.s3d'), '// 组合根：按顺序叠加各层（工具与界面只编译这个文件）\n' + LAYERS.map((f) => `import "${f}"`).join('\n') + '\n');
  for (const [f, h] of Object.entries(HEADERS)) if (!existsSync(join(dir, f))) writeFileSync(join(dir, f), typeof h === 'function' ? h(dir) : h);
  mkdirSync(join(dir, 'state'), { recursive: true });
  const P = openProject(dir);
  const rep = await runReverse(P, { fresh: true });
  return { dir, ...rep };
}

// 重跑逆向：上一次的 base.s3d 作为名字记忆（稳定命名），除非 fresh
export async function runReverse(P, { fresh = false } = {}) {
  const parts = await P.sourceParts();
  const previous = !fresh && P.exists('base.s3d') ? P.read('base.s3d') : null;
  const out = reverse(parts, { srcFile: P.cfg.source, level: 'project', previous });
  P.write('base.s3d', out.src);
  P.write('base.report.json', JSON.stringify(out.report, null, 2) + '\n');
  const hash = sha1(P.sourcePath());
  if (hash !== P.cfg.sourceHash) { P.cfg.sourceHash = hash; writeFileSync(P.path('project.json'), JSON.stringify(P.cfg, null, 2) + '\n'); }
  return { parts: parts.length, arrays: out.report.arrays.length, mirrors: out.report.mirrors.length, renamed: out.report.renamed };
}
