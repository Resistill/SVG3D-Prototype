// 工程：人与 AI 共用的一个目录（docs/PLAN2.md 2.2）。工具与界面都只通过这里读写，没有隐藏状态。
//   project.json   源模型、场景单位（unit：每个场景单位多少米）、档位、分数常数（长度按米）
//   scene.s3d      组合根：import 各层（工具与界面只编译它）
//   base.s3d       逆向基础层（机器生成，重跑逆向会重写；人和 AI 不直接改）；大的时候是索引，内容拆在 base/ 下
//   edits.s3d      修改层；semantics.s3d 语义层；style.s3d 风格层；decisions.s3d 决定层（逆向的约束，不进 scene）
//   state/         选中状态等（state/cache/：源模型一侧的磁盘缓存，可以随时删）；renders/ 渲染图；score.json 最近一次评分
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, FACT_EPS } from '../src/s3d.js';
import { readParts, reverse, FIDELITY, partsNode } from './reverse.mjs';
import { heightField } from './heights.mjs';
import { Document, NodeIO } from '@gltf-transform/core';
import { SCORE_DEFAULTS, scoreCache } from './score.mjs';
import { splitSource, joinSource, importedFiles } from './split.mjs';
import { loadSidecar, attachSidecar } from './sidecar.mjs';
import { prefit } from './fitpool.mjs';
import { packParts, unpackParts } from './parts.mjs';
import { codeHash, readCache, writeCache, sha1 as sha1Of } from './srccache.mjs';

// 写进文件的相对路径一律用 /（Windows 上 path.relative 给的是反斜杠，浏览器与 import 都认不了）
const rel = (from, to) => relative(from, to).split(sep).join('/');
const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '../lib/semantics.s3d');
export const LAYERS = ['base.s3d', 'edits.s3d', 'semantics.s3d', 'style.s3d'];
// 计入描述长度的层：语义与风格不描述几何
export const GEOMETRY_LAYERS = ['base.s3d', 'edits.s3d'];

const HEADERS = {
  'edits.s3d': '// 修改层：over / drop / copy / 新物体 / def 扩展。重跑逆向后这里的路径仍然有效（稳定命名）\n',
  'semantics.s3d': (dir) => `// 语义层：concept / pattern / check\nimport "${rel(dir, LIB)}"\n`,
  'style.s3d': '// 风格层：只改外观（mat / color / use=）\n',
  'decisions.s3d': '// 决定层：对逆向的约束（哪些部件是一个物体、是一个阵列、是同一个类型、保留为网格……），重跑逆向时遵守。不进 scene\n',
};

// 同一个进程里（MCP 服务、自动细化、连续预览提议）多次打开同一个工程：源部件与评分缓存留在内存里；
// 源模型文件变了（大小、修改时间）或换了拆分方式就重读
const SESSIONS = new Map();

const sha1 = (path) => createHash('sha1').update(readFileSync(path)).digest('hex');

// 源模型一侧的磁盘缓存（srccache.mjs）：每种数据由哪些模块产生——这些文件的内容变了，缓存就失效
const CACHE_CODE = { parts: ['parts.mjs', 'sidecar.mjs', 'srccache.mjs'] };
CACHE_CODE.surfaces = [...CACHE_CODE.parts, 'surfaces.mjs', 'nearest.mjs', 'worldtris.mjs'];
CACHE_CODE.samples = CACHE_CODE.parts;
// 评分状态（跨进程的增量评分）：还取决于评分本身的代码
CACHE_CODE.score = [...CACHE_CODE.surfaces, 'score.mjs'];
// 源模型的键：源文件与旁路表的内容、拆分方式、旁路表的配置；读不到文件时返回 null（不用缓存，照常读、照常报错）
function sourceKey(dir, cfg, path) {
  try {
    const side = cfg.sidecar ? sha1(resolve(dir, cfg.sidecar.file)) : null;
    return sha1Of(JSON.stringify({ source: sha1(path), split: cfg.split ?? 'auto', sidecar: cfg.sidecar ?? null, side }));
  } catch { return null; }
}
function sourcePersist(dir, key) {
  if (!key) return null;
  const file = (kind) => join(dir, 'state', 'cache', `${kind}.bin`);
  const k = (kind, params) => sha1Of(JSON.stringify([key, codeHash(CACHE_CODE[kind]), params]));
  return {
    load: (kind, params, alloc) => readCache(file(kind), k(kind, params), alloc),
    save: (kind, params, meta, blobs) => writeCache(file(kind), k(kind, params), meta, blobs),
  };
}

export function openProject(dir) {
  dir = resolve(dir);
  const cfgPath = join(dir, 'project.json');
  if (!existsSync(cfgPath)) throw new Error(`${dir} 不是 SVG3D 工程（没有 project.json）；先运行 init`);
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const P = {
    dir, cfg,
    get unit() { return cfg.unit ?? 1; },
    // 分数常数：长度按米（project.json 的 score），加上场景单位；extra 临时覆盖（如细化时用目标档位的 δ）
    consts: (extra = {}) => ({ ...SCORE_DEFAULTS, ...cfg.score, ...extra, unit: cfg.unit ?? 1 }),
    path: (name) => join(dir, name),
    read: (name) => readFileSync(join(dir, name), 'utf8'),
    write: (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); },
    exists: (name) => existsSync(join(dir, name)),
    sourcePath: () => resolve(dir, cfg.source),
    // 编译组合根；extra 是临时追加在末尾的语句（临时查询），overrides 是虚拟替换的层内容（预览提议，不碰磁盘）
    compile(extra = '', overrides = {}) {
      const main = 'scene.s3d';
      const text = P.read(main) + (extra ? '\n' + extra : '');
      return compile(text, { file: main, factEps: FACT_EPS / (cfg.unit ?? 1), metre: 1 / (cfg.unit ?? 1), heightAt: P._parts ? (P._heights ??= heightField(P._parts)) : null, resolve: (p) => overrides[p] ?? readFileSync(resolve(dir, p), 'utf8') });
    },
    // 几何层里有没有 .top[…] 这样的曲面锚点（有的话编译需要源网格）
    usesSurfaceAnchors: () => { try { return P.geometryFiles().some((x) => /\.top\[/.test(x.text)); } catch { return false; } },
    _heights: null,
    // 计入描述长度的文本
    // 基础层可能拆成了多个文件（base.s3d 是索引），修改层可能 import 细化结果（edits/refine-*.s3d），import 的文件一并计入
    geometryFiles: (overrides = {}) => GEOMETRY_LAYERS.flatMap((f) => importedFiles((x) => overrides[x] ?? P.read(x), f))
      .map((f) => ({ file: f, text: overrides[f] ?? P.read(f) })),
    _parts: null,
    async sourceParts() {
      if (P._parts) return P._parts;
      const path = P.sourcePath(), st = statSync(path), key = `${path}|${st.size}|${st.mtimeMs}|${cfg.split ?? 'auto'}`;
      let ses = SESSIONS.get(dir);
      if (!ses || ses.key !== key) {
        // 磁盘缓存里有这个源模型（同样的源文件、旁路表与读取代码）就直接恢复，否则读 GLB 并存一份
        const persist = sourcePersist(dir, sourceKey(dir, cfg, path)), saved = persist?.load('parts', {});
        let parts, sidecar;
        if (saved) { parts = unpackParts({ meta: saved.meta.parts, blobs: saved.blobs }); sidecar = saved.meta.sidecar; }
        else {
          parts = await readParts(path, { split: cfg.split ?? 'auto' });
          // 旁路表（project.json 的 sidecar）：对上的列挂到部件上，逆向写成 ~元数据
          sidecar = cfg.sidecar ? attachSidecar(parts, loadSidecar(resolve(dir, cfg.sidecar.file)), cfg.sidecar) : null;
          if (persist) { const pk = packParts(parts); persist.save('parts', {}, { parts: pk.meta, sidecar }, pk.blobs); }
        }
        SESSIONS.set(dir, (ses = { key, parts, sidecar, cache: scoreCache(persist) }));
      }
      P.sidecar = ses.sidecar;
      return (P._parts = ses.parts);
    },
    // 增量评分的缓存（与 sourceParts() 读到的源部件配套；缓存自己会核对源部件是不是同一组）
    scoreCache: () => SESSIONS.get(dir)?.cache ?? null,
    selection() { try { return JSON.parse(P.read('state/selection.json')); } catch { return { paths: [] }; } },
  };
  return P;
}

// 写基础层：超过 splitLines 行（默认 400，0 = 不拆）就拆成 base/ 下的多个文件，base.s3d 只做索引；旧的分区文件先清掉
export function writeBase(P, text) {
  const dir = P.path('base');
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.s3d')) rmSync(join(dir, f));
  const lim = P.cfg.splitLines ?? 400;
  const sp = lim > 0 ? splitSource(text, { maxLines: lim }) : null;
  if (!sp) { P.write('base.s3d', text); return null; }
  for (const [f, t] of Object.entries(sp.files)) P.write(f, t);
  P.write('base.s3d', sp.index);
  return sp.zones;
}

// 场景单位的默认值：glTF 规定按米，但导出时常常是厘米、毫米。部件尺寸（包围盒最长边）的中位数在米制里一般是 0.1–10，
// 只有明显偏大时才猜成厘米（> 50）或毫米（> 500）；猜不出非公制的单位（如 stud），所以 init 的结果里总是提示人确认
export function guessUnit(parts) {
  const ext = parts.map((p) => { const vs = p.tris.flat(); return Math.max(...[0, 1, 2].map((k) => Math.max(...vs.map((v) => v[k])) - Math.min(...vs.map((v) => v[k])))); })
    .filter((x) => x > 0).sort((a, b) => a - b);
  const median = ext.length ? ext[ext.length >> 1] : 1;
  const unit = median > 500 ? 0.001 : median > 50 ? 0.01 : 1;
  return { unit, median: +median.toPrecision(3) };
}
const checkUnit = (u) => { if (!(u > 0) || !Number.isFinite(u)) throw new Error(`unit 是每个场景单位多少米，要是正数（米 1、厘米 0.01、stud 0.28）：${u}`); return u; };
const writeCfg = (path, cfg) => writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');

// 新建工程：记录源模型，跑一次逆向，生成各层文件。unit 不给时按部件尺寸猜一个，并在结果里提示确认
export async function initProject(dir, source, { split = 'auto', copy = false, fidelity = 'structure', unit = null, sidecar = null } = {}) {
  if (!FIDELITY[fidelity]) throw new Error(`没有档位 ${fidelity}（可用：${Object.keys(FIDELITY).join(' / ')}）`);
  if (unit != null) checkUnit(unit);
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true });
  if (existsSync(join(dir, 'project.json'))) throw new Error(`${dir} 已经是一个工程`);
  let src = resolve(source);
  if (copy) { mkdirSync(join(dir, 'source'), { recursive: true }); const to = join(dir, 'source', 'world.glb'); writeFileSync(to, readFileSync(src)); src = to; }
  const parts = await readParts(src, { split });
  const guess = unit == null ? guessUnit(parts) : null;
  const side = sidecar ? attachSidecar(parts, loadSidecar(resolve(sidecar)), {}) : null;
  // 档位：逆向不要求 100% 复原；它同时决定逆向的精度与分数的 δ（几何误差的单位，按米）
  const { unit: _u, ...score } = SCORE_DEFAULTS;
  const cfg = { version: 1, source: rel(dir, src), sourceHash: sha1(src), unit: unit ?? guess.unit, split, fidelity, ...(side ? { sidecar: { file: rel(dir, resolve(sidecar)), match: side.match, position: side.position, fields: side.fields } } : {}), score: { ...score, delta: FIDELITY[fidelity].tau } };
  writeCfg(join(dir, 'project.json'), cfg);
  writeFileSync(join(dir, 'scene.s3d'), '// 组合根：按顺序叠加各层（工具与界面只编译这个文件）\n' + LAYERS.map((f) => `import "${f}"`).join('\n') + '\n');
  for (const [f, h] of Object.entries(HEADERS)) if (!existsSync(join(dir, f))) writeFileSync(join(dir, f), typeof h === 'function' ? h(dir) : h);
  mkdirSync(join(dir, 'state'), { recursive: true });
  const P = openProject(dir);
  P._parts = parts;
  const rep = await runReverse(P, { fresh: true });
  const note = guess && `场景单位按 1 = ${cfg.unit} 米（部件尺寸的中位数是 ${guess.median} 个单位，猜的）；不对的话用 reverse --unit=<每个单位多少米> --fresh 改（stud 是 0.28）`;
  return { dir, ...rep, ...(note ? { unitNote: note } : {}), ...(side ? { sidecar: side } : {}) };
}

// L2 的网格兜底：逆向引用了 parts.glb 里的分量（合并网格拆出来、源文件里没有节点的部件）时，把这些分量写成一个 GLB。
// 三角形就是世界坐标，节点不带变换；节点名是分量的标识（# 换成 ~）
export async function partsGlb(parts, objs, file = 'parts.glb') {
  const used = new Set(objs.filter((o) => o.kind === 'mesh').map((o) => JSON.parse(o.props.src)).filter((s) => s.startsWith(file + '#')).map((s) => s.slice(file.length + 1)));
  if (!used.size) return null;
  const doc = new Document(), buf = doc.createBuffer(), scene = doc.createScene();
  for (const p of parts) {
    if (!p.from || !used.has(partsNode(p.from))) continue;
    const pos = new Float32Array(p.tris.length * 9);
    p.tris.forEach((t, i) => t.forEach((v, j) => pos.set(v, i * 9 + j * 3)));
    const prim = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf));
    if (p.material?.color) {
      const c = p.material.color.match(/[0-9a-f]{2}/gi)?.map((h) => (parseInt(h, 16) / 255) ** 2.2) ?? [0.8, 0.8, 0.8];
      prim.setMaterial(doc.createMaterial(p.material.name ?? 'm').setBaseColorFactor([...c.slice(0, 3), 1]));
    }
    scene.addChild(doc.createNode(partsNode(p.from)).setMesh(doc.createMesh().addPrimitive(prim)));
  }
  return new NodeIO().writeBinary(doc);
}
async function writePartsFile(P, parts, objs) {
  const bin = await partsGlb(parts, objs);
  if (bin) writeFileSync(P.path('parts.glb'), bin);
  else if (P.exists('parts.glb')) rmSync(P.path('parts.glb'));
}

// 重跑逆向：上一次的 base.s3d 作为名字记忆（稳定命名），除非 fresh。fidelity / unit 给了就先改工程设置
export async function runReverse(P, { fresh = false, fidelity = null, unit = null } = {}) {
  if (fidelity && !FIDELITY[fidelity]) throw new Error(`没有档位 ${fidelity}（可用：${Object.keys(FIDELITY).join(' / ')}）`);
  if (unit != null) checkUnit(unit);
  if (fidelity) { P.cfg.fidelity = fidelity; P.cfg.score = { ...P.cfg.score, delta: FIDELITY[fidelity].tau }; }
  if (unit != null) P.cfg.unit = unit;
  if (fidelity || unit != null) writeCfg(P.path('project.json'), P.cfg);
  const parts = await P.sourceParts();
  const previous = !fresh && P.exists('base.s3d') ? joinSource(P.read) : null;
  // 决定层（decisions.s3d）：逆向必须满足的约束；满足不了的、找不到源部件的写进报告
  const decisions = P.exists('decisions.s3d') ? P.read('decisions.s3d') : null;
  // 部件很多时先在 worker 线程里并行拟合
  const pre = await prefit(parts, { fidelity: P.cfg.fidelity ?? 'detail', unit: P.unit });
  const out = reverse(parts, { srcFile: P.cfg.source, level: 'project', previous, fidelity: P.cfg.fidelity ?? 'detail', unit: P.unit, decisions, prefit: pre, partsFile: 'parts.glb' });
  await writePartsFile(P, parts, out.objs);
  writeBase(P, out.src);
  P.write('base.report.json', JSON.stringify(out.report, null, 2) + '\n');
  const hash = sha1(P.sourcePath());
  if (hash !== P.cfg.sourceHash) { P.cfg.sourceHash = hash; writeCfg(P.path('project.json'), P.cfg); }
  return { fidelity: P.cfg.fidelity ?? 'detail', unit: P.unit, ...(out.report.decisions ? { decisions: { applied: out.report.decisions.applied.length, unsatisfied: out.report.decisions.unsatisfied, dangling: out.report.decisions.dangling } } : {}), parts: parts.length, arrays: out.report.arrays.length, mirrors: out.report.mirrors.length, meshes: out.objs.filter((o) => o.kind === 'mesh').length, renamed: out.report.renamed };
}
