// 工具集：人（界面）与 AI（命令行 / MCP）共用的“看 / 查 / 做 / 评”。一张命令表，CLI、MCP、HTTP 都由它生成。
// 每个命令：desc（给人和模型看的说明）、args（参数说明）、run(工程, 参数) → 可序列化为 JSON 的结果
import { outline } from './outline.mjs';
import { score } from './score.mjs';
import { sceneObjects } from './worldtris.mjs';
import { rasterize, VIEWS } from './raster.mjs';
import { initProject, openProject, runReverse } from './project.mjs';
import { readdirSync, renameSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── 提议：AI 的修改先写成 proposals/NNN-标题.s3d，人（或按约定的 agent）预览后接受或否决 ──
// 文件首行 // layer=edits why=…；可以有 // retract <行号>（撤销目标层的某一行）；其余是要追加到目标层的语句
const LAYER_OK = new Set(['edits.s3d', 'semantics.s3d', 'style.s3d', 'decisions.s3d']);
function listProposals(P) {
  const d = P.path('proposals');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => /^\d+.*\.s3d$/.test(f)).sort().map((f) => ({ id: f.match(/^(\d+)/)[1], file: f }));
}
function findProposal(P, id) {
  const p = listProposals(P).find((x) => x.id === String(id).padStart(3, '0') || x.file === id);
  if (!p) throw new Error(`没有待处理的提议 ${id}`);
  return p;
}
function parseProposal(text) {
  const lines = text.split('\n');
  const head = /^\/\/\s*layer=(\S+)(?:\s+why=(.*))?$/.exec(lines[0] ?? '');
  const layer = head ? (head[1].endsWith('.s3d') ? head[1] : head[1] + '.s3d') : 'edits.s3d';
  const retract = lines.map((l) => /^\/\/\s*retract\s+(\d+)\s*$/.exec(l)).filter(Boolean).map((m) => +m[1]);
  const body = lines.slice(head ? 1 : 0).filter((l) => !/^\/\/\s*retract\s+\d+/.test(l)).join('\n').trim();
  return { layer, why: head?.[2] ?? '', retract, body };
}
function applyProposal(P, id, prop) {
  if (!LAYER_OK.has(prop.layer)) throw new Error(`提议只能改 ${[...LAYER_OK].join(' / ')}（base.s3d 由逆向生成）`);
  let lines = (P.exists(prop.layer) ? P.read(prop.layer) : '').split('\n');
  for (const n of prop.retract) if (!lines[n - 1]?.trim()) throw new Error(`${prop.layer} 第 ${n} 行是空的，无法撤销`);
  const drop = new Set(prop.retract.map((n) => n - 1));
  lines = lines.filter((_, i) => !drop.has(i));
  const text = lines.join('\n').replace(/\n*$/, '\n') + (prop.body ? `// 提议 ${id}${prop.why ? '：' + prop.why : ''}\n${prop.body}\n` : '');
  return text;
}
async function scoreWith(P, overrides = {}) {
  const r = P.compile('', overrides);
  const s = score({ result: r, files: P.geometryFiles(overrides), sourceParts: await P.sourceParts(), consts: P.cfg.score });
  return { r, s };
}
async function previewProposal(P, p) {
  const prop = parseProposal(P.read(join('proposals', p.file)));
  const text = applyProposal(P, p.id, prop);
  const before = await scoreWith(P);
  const after = await scoreWith(P, { [prop.layer]: text });
  const known = new Set(before.r.errors.map((e) => `${e.file}:${e.message}`));
  const errors = after.r.errors.filter((e) => !known.has(`${e.file}:${e.message}`));
  const changed = after.s.objects.filter((o) => { const b = before.s.objects.find((x) => x.path === o.path); return !b || Math.abs(b.total - o.total) > 0.01; }).map((o) => o.path);
  const gone = before.s.objects.filter((o) => !after.s.objects.some((x) => x.path === o.path)).map((o) => o.path);
  return { id: p.id, layer: prop.layer, why: prop.why, errors, before: before.s.S, after: after.s.S, delta: +(after.s.S - before.s.S).toFixed(2), explain: after.s.explain, changed: changed.slice(0, 30), removed: gone.slice(0, 30), text, prop };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol + 0.005 * Math.abs(a);
const ctr = (b) => b && [0, 1, 2].map((k) => +((b.min[k] + b.max[k]) / 2).toFixed(4));
const ext = (b) => b && [0, 1, 2].map((k) => +(b.max[k] - b.min[k]).toFixed(4));
const pathsArg = (P, a) => (a.selection ? P.selection().paths ?? [] : [].concat(a.paths ?? a._ ?? []));

// 形状签名：种类 + 与写法无关的尺寸（盒子三边排序）+ 材质
function signature(item) {
  if (!item || item.kind !== 'solid') return null;
  const g = item.geom;
  const dims = g.type === 'box' || g.type === 'wedge' ? [g.w, g.h, g.d].sort((a, b) => a - b)
    : g.type === 'cyl' ? [g.r1, g.r2, g.h] : g.type === 'sphere' ? [g.r] : g.type === 'mesh' ? [g.w, g.h, g.d].sort((a, b) => a - b) : null;
  return dims && { type: g.type === 'mesh' ? `mesh:${String(g.src).split('#').pop()}` : g.type, dims, mat: item.material?.name ?? item.material?.color };
}

export const COMMANDS = {
  init: {
    desc: '从源模型（GLB）新建工程：记录源模型、按档位跑一次逆向、生成各层文件。档位：semantic（只保留语义，一律用基本体当代理，最适合风格化）/ structure（默认）/ detail（尽量复原）',
    args: { source: '源模型 .glb 的路径', fidelity: '档位：semantic / structure（默认）/ detail', copy: '可选：把源模型复制进工程（source/world.glb）' },
    noProject: true,
    async run(dir, a) { return initProject(dir, a.source ?? a._?.[0], { copy: !!a.copy, fidelity: a.fidelity ?? 'structure' }); },
  },
  reverse: {
    desc: '重跑逆向，重写 base.s3d（上一次的结果作为名字记忆，修改层的路径保持有效）；可以换档位',
    args: { fresh: '可选：不沿用上一次的名字', fidelity: '可选：换档位 semantic / structure / detail（同时改变分数的 δ）' },
    async run(P, a) { return runReverse(P, { fresh: !!a.fresh, fidelity: a.fidelity ?? null }); },
  },
  outline: {
    desc: '分层概要：阵列与副本折叠成一行；每行给出类型、尺寸、实体数、主要关系、概念',
    args: { depth: '展开深度（默认 2）', path: '可选：只看这个路径之下' },
    async run(P, a) {
      const r = P.compile();
      const sub = a.path ? { ...r, nodes: r.nodes.filter((n) => n.path === a.path || n.path.startsWith(a.path + '.')).map((n) => ({ ...n, path: a.path.includes('.') ? n.path.slice(a.path.lastIndexOf('.') + 1) : n.path })) } : r;
      return { errors: r.errors, outline: outline(sub, { depth: +(a.depth ?? 2) }).split('\n') };
    },
  },
  inspect: {
    desc: '查看物体：源语句、属性、世界包围盒、空间事实、所属阵列 / 镜像 / 类型与同类数量、副本来源、概念、元数据、逐物体分数',
    args: { paths: '一个或多个路径', selection: '可选：查看界面里当前选中的物体（state/selection.json）' },
    async run(P, a) {
      const r = P.compile();
      const byPath = new Map(r.nodes.map((n) => [n.path, n]));
      const items = new Map(r.items.map((i) => [i.path, i]));
      let sc = null;
      try { sc = JSON.parse(P.read('score.json')); } catch { /* 还没评过分 */ }
      const lineOf = (n) => { try { return P.read(n.file ?? 'scene.s3d').split('\n')[n.line - 1]?.trim() ?? null; } catch { return null; } };
      return pathsArg(P, a).map((path) => {
        const n = byPath.get(path);
        if (!n) return { path, error: '没有这个物体' };
        const inside = (x) => x === path || x.startsWith(path + '.');
        const groups = [];
        for (let p = path; p.includes('.'); ) {
          p = p.slice(0, p.lastIndexOf('.'));
          const g = byPath.get(p);
          if (g && (g.kind === 'repeat' || g.kind === 'rotate' || g.kind === 'mirror' || /→/.test(g.kind))) groups.push({ path: p, kind: g.kind, members: r.nodes.filter((m) => m.path.startsWith(p + '.') && m.depth === g.depth + 1).length });
        }
        const sameType = n.types ? r.nodes.filter((m) => m.types?.[0] === n.types[0]).map((m) => m.path) : null;
        const it = items.get(path);
        return {
          path, kind: n.kind, file: n.file, line: n.line, statement: lineOf(n), types: n.types, of: n.of, tags: n.tags, concepts: n.concepts, meta: n.meta,
          geom: it?.geom ?? null, material: it?.material ?? null, center: ctr(n.tight ?? n.box), size: ext(n.tight ?? n.box),
          facts: r.facts.filter((f) => inside(f.a) !== inside(f.b) && (inside(f.a) || inside(f.b))).map((f) => ({ rel: f.rel, a: f.a, b: f.b, gap: f.gap })).slice(0, 40),
          groups, sameType: sameType && { type: n.types[0], count: sameType.length, examples: sameType.slice(0, 8) },
          score: sc?.objects?.filter((o) => inside(o.path)) ?? null,
        };
      });
    },
  },
  select: {
    desc: '按集合表达式选物体（与 concept 的写法相同），例如 "kind(cyl) where h > 5 and top > 30"、"on(ground) - #road"',
    args: { expr: '集合表达式' },
    async run(P, a) {
      const expr = a.expr ?? a._?.join(' ');
      const r = P.compile(`concept __select = ${expr}`);
      const c = r.concepts.find((x) => x.name === '__select');
      return { expr, errors: r.errors.filter((e) => /__select/.test(e.message) || !e.file), members: c?.members ?? [] };
    },
  },
  similar: {
    desc: '找同形部件：全场景里种类、尺寸（容差内）、材质都相同的物体——类型（def）与阵列的候选',
    args: { paths: '一个路径', tol: '尺寸容差（米，默认 0.01）' },
    async run(P, a) {
      const r = P.compile();
      const path = pathsArg(P, a)[0];
      const items = new Map(r.items.map((i) => [i.path, i]));
      const me = signature(items.get(path));
      if (!me) return { path, error: '只支持单个实体（不是组或布尔运算）' };
      const tol = +(a.tol ?? 0.01);
      const hits = r.items.filter((i) => { const s = signature(i); return s && s.type === me.type && s.mat === me.mat && s.dims.length === me.dims.length && s.dims.every((v, k) => near(v, me.dims[k], tol)); });
      const byPath = new Map(r.nodes.map((n) => [n.path, n]));
      const c0 = ctr(byPath.get(path).tight);
      return { path, signature: me, count: hits.length, matches: hits.map((i) => ({ path: i.path, center: ctr(byPath.get(i.path).tight), offset: ctr(byPath.get(i.path).tight).map((v, k) => +(v - c0[k]).toFixed(4)) })) };
    },
  },
  render: {
    desc: '离屏渲染成 PNG：view=iso|iso2|top|front|back|left|right，mode=color|id|labels；focus=路径或 selection（只标注、并且不被遮挡）；source 渲染源模型',
    args: { view: '视角（默认 iso）', mode: '模式（默认 labels）', focus: '可选：路径，或 selection', size: '边长像素（默认 1024）', out: '输出文件（默认 renders/<view>-<mode>.png）', source: '可选：渲染源模型而不是重建结果' },
    async run(P, a) {
      const parts = await P.sourceParts();
      let objs;
      if (a.source) {
        const { trisToArray } = await import('./worldtris.mjs');
        objs = parts.map((p, i) => ({ path: p.name ?? p.from ?? `part_${i}`, pos: trisToArray(p.tris), color: p.material?.color ?? '#c9c9c9' }));
      } else objs = sceneObjects(P.compile(), { sourceParts: parts });
      const view = a.view ?? 'iso', mode = a.mode ?? 'labels';
      if (!VIEWS[view]) throw new Error(`没有视角 ${view}（可用：${Object.keys(VIEWS).join(' ')}）`);
      const focus = a.focus === 'selection' ? P.selection().paths : a.focus ? [].concat(a.focus) : null;
      const res = rasterize(objs, { view, mode, size: +(a.size ?? 1024), focus: focus?.length ? focus : null });
      const out = a.out ?? `renders/${a.source ? 'source-' : ''}${view}-${mode}${focus ? '-focus' : ''}.png`;
      P.write(out, res.png);
      return { file: P.path(out), view, mode, focus, legend: res.legend };
    },
  },
  propose: {
    desc: '提交一条提议（AI 的修改不直接写进层文件）：追加到某一层的语句，可撤销该层的某几行；返回编号、新出现的编译错误与分数变化',
    args: { text: '语句（多行用 \\n 分隔），或用 --file=路径', layer: '目标层：edits（默认）/ semantics / style / decisions', why: '理由（一句话，人会看到）', title: '可选：短标题（用作文件名）', retract: '可选：要撤销的目标层行号，逗号分隔' },
    async run(P, a) {
      const body = a.file ? readFileSync(a.file, 'utf8') : String(a.text ?? '').replace(/\\n/g, '\n');
      if (!body.trim() && !a.retract) throw new Error('提议是空的：用 --text=… 或 --file=…');
      const layer = (a.layer ?? 'edits').replace(/\.s3d$/, '');
      const all = [...listProposals(P), ...['accepted', 'rejected'].flatMap((d) => { const x = P.path(join('proposals', d)); return existsSync(x) ? readdirSync(x) : []; }).map((f) => ({ id: (f.match(/^(\d+)/) ?? [0, '0'])[1] }))];
      const id = String(1 + Math.max(0, ...all.map((p) => +p.id))).padStart(3, '0');
      const slug = String(a.title ?? 'proposal').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40);
      const retract = a.retract ? String(a.retract).split(',').map((n) => `// retract ${n.trim()}`).join('\n') + '\n' : '';
      const file = `${id}-${slug}.s3d`;
      P.write(join('proposals', file), `// layer=${layer} why=${String(a.why ?? '').replace(/\n/g, ' ')}\n${retract}${body.trim()}\n`);
      const { text, prop, ...pv } = await previewProposal(P, { id, file });
      return { ...pv, file: P.path(join('proposals', file)) };
    },
  },
  proposals: {
    desc: '列出待处理的提议',
    args: {},
    async run(P) { return listProposals(P).map((p) => { const pr = parseProposal(P.read(join('proposals', p.file))); return { id: p.id, file: p.file, layer: pr.layer, why: pr.why, lines: pr.body.split('\n').length }; }); },
  },
  preview: {
    desc: '预览一条提议：叠加编译，报告新出现的错误、分数变化、受影响的物体（不改任何文件）',
    args: { id: '提议编号' },
    async run(P, a) { const { text, prop, ...pv } = await previewProposal(P, findProposal(P, a.id ?? a._?.[0])); return pv; },
  },
  accept: {
    desc: '接受一条提议：追加进目标层（有新的编译错误时拒绝接受，除非 --force），提议移到 proposals/accepted/',
    args: { id: '提议编号', force: '可选：有编译错误也接受' },
    async run(P, a) {
      const p = findProposal(P, a.id ?? a._?.[0]);
      const pv = await previewProposal(P, p);
      if (pv.errors.length && !a.force) throw new Error(`提议 ${p.id} 会引入编译错误：${pv.errors.map((e) => e.message).join('；')}`);
      P.write(pv.layer, pv.text);
      mkdirSync(P.path('proposals/accepted'), { recursive: true });
      renameSync(P.path(join('proposals', p.file)), P.path(join('proposals/accepted', p.file)));
      const { text, prop, ...rest } = pv;
      return { accepted: p.id, ...rest };
    },
  },
  reject: {
    desc: '否决一条提议并说明理由：提议移到 proposals/rejected/，理由写进收件箱（AI 下次能读到）',
    args: { id: '提议编号', why: '否决理由' },
    async run(P, a) {
      const p = findProposal(P, a.id ?? a._?.[0]);
      mkdirSync(P.path('proposals/rejected'), { recursive: true });
      renameSync(P.path(join('proposals', p.file)), P.path(join('proposals/rejected', p.file)));
      appendFileSync(P.path('inbox.jsonl'), JSON.stringify({ t: new Date().toISOString(), kind: 'reject', id: p.id, why: a.why ?? '' }) + '\n');
      return { rejected: p.id, why: a.why ?? '' };
    },
  },
  note: {
    desc: '给 AI 留言（界面里“交给 AI”也走这里）：连同当前选中的物体写进收件箱',
    args: { text: '留言', paths: '可选：相关物体（默认取界面当前选中）' },
    async run(P, a) {
      const paths = a.paths?.length ? [].concat(a.paths) : P.selection().paths ?? [];
      const entry = { t: new Date().toISOString(), kind: 'note', paths, text: a.text ?? '' };
      appendFileSync(P.path('inbox.jsonl'), JSON.stringify(entry) + '\n');
      return entry;
    },
  },
  inbox: {
    desc: '读收件箱：人的留言（附选中的物体）与提议的否决理由',
    args: { since: '可选：只看这个时间（ISO）之后的' },
    async run(P, a) {
      if (!P.exists('inbox.jsonl')) return [];
      return P.read('inbox.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => !a.since || e.t > a.since);
    },
  },
  score: {
    desc: '自评分数：S = 描述长度 + 网格引用 + 双向几何残差（越低越好）；explain 是解释率；worst 是下一步最值得修的物体',
    args: { objects: '可选：输出每个物体的分数' },
    async run(P, a) {
      const s = score({ result: P.compile(), files: P.geometryFiles(), sourceParts: await P.sourceParts(), consts: P.cfg.score });
      P.write('score.json', JSON.stringify(s, null, 2) + '\n');
      const { objects, sources, ...summary } = s;
      // 解释得最差的源部件（L2 里是合并网格的分量）：render --source --focus=名字 可以看它是什么
      summary.worstSources = [...sources].sort((x, y) => y.cost - x.cost).slice(0, 10);
      return a.objects ? s : summary;
    },
  },
};

export async function runCommand(name, dir, args = {}) {
  const c = COMMANDS[name];
  if (!c) throw new Error(`没有命令 ${name}（可用：${Object.keys(COMMANDS).join(' ')}）`);
  if (c.noProject) return c.run(dir, args);
  const P = openProject(dir);
  const t0 = Date.now();
  let out, err = null;
  try { out = await c.run(P, args); return out; } catch (e) { err = e.message; throw e; } finally {
    // 每次调用都记下来（可以回放、可以分析 agent 的行为）
    try { mkdirSync(P.path('state'), { recursive: true }); appendFileSync(P.path('state/log.jsonl'), JSON.stringify({ t: new Date().toISOString(), cmd: name, args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== '_')), ms: Date.now() - t0, error: err, S: out?.S ?? out?.after ?? undefined }) + '\n'); } catch { /* 日志失败不影响命令 */ }
  }
}
