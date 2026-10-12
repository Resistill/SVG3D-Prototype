// 工具集：人（界面）与 AI（命令行 / MCP）共用的“看 / 查 / 做 / 评”。一张命令表，CLI、MCP、HTTP 都由它生成。
// 每个命令：desc（给人和模型看的说明）、args（参数说明）、run(工程, 参数) → 可序列化为 JSON 的结果
import { outline } from './outline.mjs';
import { score, pointErrors } from './score.mjs';
import { sceneObjects } from './worldtris.mjs';
import { rasterize, VIEWS, encodePNG } from './raster.mjs';
import { initProject, openProject, runReverse } from './project.mjs';
import { reverse as reverseParts, samplePoints, pcaFrame } from './reverse.mjs';
import { refineProposal, finer } from './refine.mjs';
import { FIDELITY } from './reverse.mjs';
import { readdirSync, renameSync, mkdirSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safe } from './split.mjs';
import { nodeRoles, ROLE_LABELS, VISIBLE_ROLES } from '../src/roles-view.js';

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
  // 撤回之后只剩注释头的旧提议（// 提议 NNN：…，后面直到下一条提议或文件末尾都没有语句了）：注释头一起删掉
  if (drop.size) lines = lines.filter((l, i) => { if (!/^\/\/ 提议 \d+/.test(l)) return true; const next = lines.slice(i + 1).find((x) => x.trim()); return next != null && !/^\/\/ 提议 \d+/.test(next); });
  const text = lines.join('\n').replace(/\n*$/, '\n') + (prop.body ? `// 提议 ${id}${prop.why ? '：' + prop.why : ''}\n${prop.body}\n` : '');
  return text;
}
// consts 可以覆盖分数常数：细化到某个档位时，用那个档位的 δ 衡量（细化到结构档就用结构档的尺子）
async function scoreWith(P, overrides = {}, consts = {}) {
  const r = P.compile('', overrides);
  const s = score({ result: r, files: P.geometryFiles(overrides), sourceParts: await P.sourceParts(), consts: P.consts(consts), cache: P.scoreCache() });
  return { r, s };
}
// 基础层里声明顶层物体 path 的那一行；已经被 over path : 种类 换过形的返回 null（细化的邻域评分用）
function baseLineOf(P, r, overrides = {}) {
  const files = new Map(P.geometryFiles(overrides).map((f) => [f.file, f.text]));
  const all = [...files.values()].join('\n');
  return (path) => {
    if (path.includes('.') || new RegExp(`^\\s*over\\s+${path}\\s*:`, 'm').test(all)) return null;
    const n = r.nodes.find((x) => x.path === path);
    return n ? files.get(n.file)?.split('\n')[n.line - 1] ?? null : null;
  };
}
// 自动细化：从最差的物体开始，逐个按更细的档位拆分；分数下降就写进修改层，直到解释率达标或预算用完
async function refineAuto(P, parts, { to, budget, target }) {
  const consts = { delta: FIDELITY[to].tau };
  let cur = await scoreWith(P, {}, consts);
  const start = cur.s.S, log = [], tried = new Set(), done = new Set();
  for (let i = 0; i < budget && cur.s.explain < target; i++) {
    // 已经细化过的物体，它内部新拆出来的部件：记着来源（~src="部件#分量"）的可以再细化，没有来源的（整体体素）不再细化
    const srcOf = new Map(cur.r.nodes.map((n) => [n.path, n.meta?.src]));
    const inside = (p) => !srcOf.get(p) && [...done].some((d) => p.startsWith(d + '.'));
    // 网格引用也可以细化（合批进一个网格的贴花、标线换成更简单的写法或者去掉）：排序时网格代价也算进去
    const cands = [...cur.s.objects].filter((o) => !tried.has(o.path) && !inside(o.path)).sort((x, y) => (y.rSrc + y.rRecon + y.mesh) - (x.rSrc + x.rRecon + x.mesh));
    let pr = null;
    // 局部分数（只看这个物体）先筛一遍：最好的候选都不如现在的写法，就不必编译、评分整个场景
    while (cands.length && !pr) {
      const o = cands.shift();
      tried.add(o.path);
      let x;
      // 一个物体出错不影响整轮：记进日志，接着试下一个
      try { x = refineProposal(cur.r, parts, o.path, { to, unit: P.unit, baseLineOf: baseLineOf(P, cur.r) }); } catch (e) { x = { error: `出错：${e.message}` }; }
      if (x.error) log.push({ path: o.path, skipped: x.error });
      else if (tried.has('T:' + x.target)) log.push({ path: o.path, skipped: '同一种类型已经试过' });
      else { tried.add('T:' + x.target); if (x.gain < 0) pr = x; else log.push({ path: o.path, target: x.target, skipped: '局部分数没有变好', local: { current: x.current.S, best: x.local.S, chosen: x.name } }); }
    }
    if (!pr) break;
    // 细化结果写进独立的文件 edits/refine-<目标>.s3d，修改层只追加一行 import（修改层不会被大段文本淹没）
    let file = `edits/refine-${safe(pr.target)}.s3d`;
    for (let k = 2; P.exists(file); k++) file = `edits/refine-${safe(pr.target)}-${k}.s3d`;
    const body = `// 细化到 ${to}：${pr.target}（${pr.name}，${pr.boxes} 个部件）\n${pr.text}\n`;
    const edits = (P.exists('edits.s3d') ? P.read('edits.s3d') : '').replace(/\n*$/, '\n') + `import "${file}"\n`;
    const next = await scoreWith(P, { 'edits.s3d': edits, [file]: body }, consts);
    const known = new Set(cur.r.errors.map((e) => `${e.file}:${e.message}`));
    const errors = next.r.errors.filter((e) => !known.has(`${e.file}:${e.message}`));
    const delta = +(next.s.S - cur.s.S).toFixed(2);
    const ok = delta < 0 && !errors.length;
    // 按工程自己的 δ 又是多少（细化按目标档位的尺子接受；两把尺子方向不同时记下来）
    let deltaProject = null;
    if (P.cfg.score?.delta !== consts.delta) { const a0 = await scoreWith(P, {}, {}), a1 = await scoreWith(P, { 'edits.s3d': edits, [file]: body }, {}); deltaProject = +(a1.s.S - a0.s.S).toFixed(2); }
    if (ok) { P.write(file, body); P.write('edits.s3d', edits); cur = next; done.add(pr.path); }
    log.push({ path: pr.path, target: pr.target, kind: pr.kind, chosen: pr.name, boxes: pr.boxes, local: +pr.gain.toFixed(1), delta, ...(deltaProject != null ? { delta_project: deltaProject } : {}), accepted: ok, ...(ok ? { file } : {}), errors: errors.map((e) => e.message).slice(0, 3) });
  }
  P.write('score.json', JSON.stringify(cur.s, null, 2) + '\n');
  return { to, start, end: cur.s.S, explain: cur.s.explain, accepted: log.filter((x) => x.accepted).length, log };
}

async function previewProposal(P, p, opts = {}) {
  const prop = parseProposal(P.read(join('proposals', p.file)));
  const text = applyProposal(P, p.id, prop);
  const consts = opts.delta ? { delta: opts.delta } : {};
  const before = await scoreWith(P, {}, consts);
  const after = await scoreWith(P, { [prop.layer]: text }, consts);
  const known = new Set(before.r.errors.map((e) => `${e.file}:${e.message}`));
  const errors = after.r.errors.filter((e) => !known.has(`${e.file}:${e.message}`));
  // 逐物体的分数变化，按幅度排序：默认只列变化明显的（≥ 0.5）前 20 个，opts.all 全部列出；描述（语句 + 网格）与残差分开给
  const bmap = new Map(before.s.objects.map((o) => [o.path, o])), amap = new Map(after.s.objects.map((o) => [o.path, o]));
  const desc = (o) => o.stmt + o.mesh, res = (o) => o.rSrc + o.rRecon;
  let changed = [...amap.values()].filter((o) => bmap.has(o.path)).map((o) => { const b = bmap.get(o.path); return { path: o.path, before: b.total, after: o.total, delta: +(o.total - b.total).toFixed(2), desc: +(desc(o) - desc(b)).toFixed(2), res: +(res(o) - res(b)).toFixed(2) }; })
    .filter((x) => opts.all ? Math.abs(x.delta) > 1e-6 : Math.abs(x.delta) >= 0.5).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  if (!opts.all) changed = changed.slice(0, 20);
  const added = [...amap.values()].filter((o) => !bmap.has(o.path)).map((o) => ({ path: o.path, cost: o.total }));
  const removed = [...bmap.values()].filter((o) => !amap.has(o.path)).map((o) => ({ path: o.path, cost: o.total }));
  let render = null;
  if (opts.render) {
    const focus = [...added.map((x) => x.path), ...changed.map((x) => x.path)].slice(0, 12);
    const res = rasterize(sceneObjects(after.r, { sourceParts: await P.sourceParts() }), { view: opts.view ?? 'iso', size: 768, mode: 'labels', focus: focus.length ? focus : null });
    const out = `renders/proposal-${p.id}.png`;
    P.write(out, res.png);
    render = { file: P.path(out), legend: res.legend };
  }
  return { id: p.id, layer: prop.layer, why: prop.why, delta_unit: before.s.consts.delta, errors, before: before.s.S, after: after.s.S, delta: +(after.s.S - before.s.S).toFixed(2), explain: after.s.explain, changed, added: opts.all ? added : added.slice(0, 30), removed: opts.all ? removed : removed.slice(0, 30), render, text, prop };
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

// 源模型的部件：几何量（包络、主轴尺寸）+ 分数里的情况 + 把它单独逆向得到的建议语句
async function inspectSource(P, names) {
  const parts = await P.sourceParts();
  let sc = null;
  try { sc = JSON.parse(P.read('score.json')); } catch { /* 还没评过分 */ }
  const r4 = (v) => v.map((x) => +x.toFixed(4));
  return names.map((name) => {
    const i = parts.findIndex((p) => (p.uid ?? p.name ?? p.from) === name);
    if (i < 0) return { name, error: '源模型里没有这个部件（名字见 score 的 worstSources / sources）' };
    const p = parts[i], vs = p.tris.flat();
    const lo = [0, 1, 2].map((k) => Math.min(...vs.map((v) => v[k]))), hi = [0, 1, 2].map((k) => Math.max(...vs.map((v) => v[k])));
    const area = p.tris.reduce((s, [A, B, C]) => { const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]; return s + Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2; }, 0);
    const F = pcaFrame(samplePoints(p.tris, 800, i + 1));
    let suggestion = null;
    try {
      // 第一条物体语句；板件、基本体之并、外壳是带内容的多行块，整块给出
      const ls = reverseParts([p], { srcFile: P.cfg.source, compress: false, names: false, fidelity: P.cfg.fidelity ?? 'detail', unit: P.unit }).src.split('\n');
      const k = ls.findIndex((l) => /^(box|cyl|cone|sphere|wedge|mesh|revolve|pipe|span|group|subtract) /.test(l));
      if (k >= 0) {
        const head = ls[k].replace(/ ~src="[^"]*"/, '').replace(/ ~fit=\S+/, '');
        const end = head.endsWith(' {') ? ls.findIndex((l, j) => j > k && l === '}') : k;
        suggestion = [head, ...ls.slice(k + 1, end + 1)].join('\n');
      }
    } catch { /* 单独逆向失败 */ }
    return {
      name, tris: p.tris.length, material: p.material, area: +area.toFixed(3),
      box: { min: r4(lo), max: r4(hi), size: r4(hi.map((v, k) => v - lo[k])), center: r4(hi.map((v, k) => (v + lo[k]) / 2)) },
      axes: F.cols.map((c, k) => ({ dir: r4(c), extent: +(2 * F.h[k]).toFixed(4) })),
      score: sc?.sources?.find((x) => x.name === name) ?? null,
      suggestion,
    };
  });
}

export const COMMANDS = {
  init: {
    desc: '从源模型（GLB）新建工程：记录源模型、按档位跑一次逆向、生成各层文件。档位：semantic（只保留语义，一律用基本体当代理，最适合风格化）/ structure（默认）/ detail（尽量复原）',
    args: { source: '源模型 .glb 的路径', fidelity: '档位：semantic / structure（默认）/ detail', copy: '可选：把源模型复制进工程（source/world.glb）', unit: '可选：场景单位，每个单位多少米（米 1、厘米 0.01、stud 0.28）；不给时按部件尺寸猜，并在结果的 unitNote 里提示确认', sidecar: '可选：旁路表（CSV）：按节点名对上源部件，类别、碰撞类型等分类列写成物体的 ~元数据（匹配列、位置列、字段自动推断，记在 project.json 的 sidecar 里，可以改）' },
    noProject: true,
    async run(dir, a) { return initProject(dir, a.source ?? a._?.[0], { copy: !!a.copy, fidelity: a.fidelity ?? 'structure', unit: a.unit != null ? +a.unit : null, sidecar: a.sidecar ?? null }); },
  },
  reverse: {
    desc: '重跑逆向，重写 base.s3d（上一次的结果作为名字记忆，修改层的路径保持有效）；可以换档位、改场景单位',
    args: { fresh: '可选：不沿用上一次的名字', fidelity: '可选：换档位 semantic / structure / detail（同时改变分数的 δ）', unit: '可选：改场景单位（每个单位多少米）；档位容差、分数的 δ 与 dMax 都按米，随之换算' },
    async run(P, a) { return runReverse(P, { fresh: !!a.fresh, fidelity: a.fidelity ?? null, unit: a.unit != null ? +a.unit : null }); },
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
    desc: '查看物体：源语句、属性、世界包围盒、空间事实、所属阵列 / 镜像 / 类型与同类数量、副本来源、概念、元数据、逐物体分数。--source 时查看源模型的部件：包络、三角形数、面积、主轴与沿主轴的尺寸、材质、分数，以及把它单独逆向得到的建议语句',
    args: { paths: '一个或多个路径（--source 时是源部件名，例如 merged_4#120）', selection: '可选：查看界面里当前选中的物体（state/selection.json）', source: '可选：查看源模型的部件' },
    async run(P, a) {
      if (a.source) return inspectSource(P, pathsArg(P, a));
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
          // 一元事实（b 为空，例如 walkable 提供者的 X walkable）只看主体
          facts: r.facts.filter((f) => (f.b == null ? inside(f.a) : inside(f.a) !== inside(f.b) && (inside(f.a) || inside(f.b)))).map((f) => ({ rel: f.rel, a: f.a, b: f.b, gap: f.gap, ...(f.provider && f.provider !== 'contact' ? { provider: f.provider } : {}) })).slice(0, 40),
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
  errors: {
    desc: '一个物体的误差落在哪里：它表面上离源模型最远的采样点（重建 → 源）、它附近的源表面上离重建最远的采样点（源 → 重建，带最近的重建物体），距离按米、超过 δ 的才列；用来定位“残差还剩一些，但不知道在哪”',
    args: { paths: '物体路径', top: '每个方向列几个（默认 10）', delta: '可选：按这个 δ（米）' },
    async run(P, a) {
      const path = [].concat(a.paths ?? a._ ?? [])[0];
      if (!path) throw new Error('给一个物体路径');
      const res = pointErrors({ result: P.compile(), sourceParts: await P.sourceParts(), path, consts: P.consts(a.delta ? { delta: +a.delta } : {}), top: +(a.top ?? 10) });
      if (!res) throw new Error(`没有物体 ${path}（或它没有几何）`);
      return { path, ...res };
    },
  },
  fit: {
    desc: '拟合一个源部件：按每种基本体（box / cyl / cone / sphere / wedge）分别拟合，给出语句与拟合误差（~err 是相对误差，越小越贴）；可以直接用在提议里（over 物体 : 种类 …）',
    args: { source: '源部件名（score 的 worstSources、inspect --source 里的名字）', kinds: '可选：只试这几种，逗号分隔' },
    async run(P, a) {
      const name = a.source ?? a._?.[0];
      const parts = await P.sourceParts();
      const part = parts.find((p) => (p.uid ?? p.name ?? p.from) === name);
      if (!part) throw new Error(`源模型里没有部件 ${name}`);
      const kinds = a.kinds ? String(a.kinds).split(',') : ['box', 'cyl', 'cone', 'sphere', 'wedge'];
      // 借用决定层的“指定形状”：只在这一种形状里挑，不退回网格
      return kinds.map((kind) => {
        const out = reverseParts([part], { srcFile: P.cfg.source, compress: false, names: false, fidelity: P.cfg.fidelity ?? 'detail', unit: P.unit, decisions: `${kind} fitted ~src=${JSON.stringify(name)}` });
        const line = out.src.split('\n').find((l) => /^\S+ fitted /.test(l)) ?? null;
        return { kind, line: line?.replace(/ ~src=.*$/, ''), err: line ? +(/~err=(\S+)/.exec(line)?.[1] ?? out.objs[0]?.err ?? NaN) : null, fit: line ? +(/~fit=(\S+)/.exec(line)?.[1] ?? NaN) : null };
      }).sort((x, y) => (x.err ?? Infinity) - (y.err ?? Infinity));
    },
  },
  detect: {
    desc: '对一部分物体（或源部件）单独跑一遍带压缩的逆向：找阵列、镜像、类型，返回生成的语句（不改文件；要用就写成提议，先 drop 原来的物体）',
    args: { paths: '物体路径（取它们的 ~src，阵列与组取全部成员）', source: '可选：源部件名，逗号分隔', selection: '可选：用界面里的选中' },
    async run(P, a) {
      const parts = await P.sourceParts();
      const byId = new Map();
      for (const p of parts) for (const id of [p.uid, p.name, p.from]) if (id && !byId.has(id)) byId.set(id, p);
      let names = a.source ? String(a.source).split(',') : [];
      const paths = pathsArg(P, a);
      const picked = [];
      if (paths.length) {
        const r = P.compile();
        // 带 ~src 的直接取；阵列成员这样没有 ~src 的，按世界包围盒的重叠度（IoU > 0.5）找源部件
        const boxes = new Map();
        const boxOf = (p) => { if (!boxes.has(p)) { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (const t of p.tris) for (const v of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); } boxes.set(p, { lo, hi }); } return boxes.get(p); };
        const iou = (A, B) => { const v = (lo, hi) => [0, 1, 2].reduce((m, k) => m * Math.max(1e-9, hi[k] - lo[k]), 1); const ov = [0, 1, 2].map((k) => Math.max(0, Math.min(A.hi[k], B.max[k]) - Math.max(A.lo[k], B.min[k]))); const o = ov[0] * ov[1] * ov[2]; return o / (v(A.lo, A.hi) + v(B.min, B.max) - o); };
        for (const n of r.nodes) {
          if (!paths.some((q) => n.path === q || n.path.startsWith(q + '.'))) continue;
          if (n.meta?.src) { names.push(n.meta.src); continue; }
          if (!r.items.some((i) => i.path === n.path) || !n.box) continue;
          let best = null, bs = 0.5;
          for (const p of parts) { const x = iou(boxOf(p), n.box); if (x > bs) { bs = x; best = p; } }
          if (best) picked.push(best);
        }
      }
      const sub = [...new Set([...names.map((x) => byId.get(x)).filter(Boolean), ...picked])];
      if (sub.length < 2) throw new Error(`对上的源部件不到两个（${sub.length}）：给物体路径（带 ~src 的）或 --source=部件名`);
      const out = reverseParts(sub, { srcFile: P.cfg.source, fidelity: P.cfg.fidelity ?? 'detail', unit: P.unit, defaultMaterial: false });
      const body = out.src.split('\n').filter((l) => l.trim() && !/^(\/\/|material )/.test(l));
      return { parts: sub.length, arrays: out.report.arrays, mirrors: out.report.mirrors, kinds: out.report.kinds, lines: body.length, text: body.join('\n') };
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
  compare: {
    desc: '源模型与重建（默认不画网格引用）同一取景各渲一张、模糊后比：missing = 源有而重建没有的占比（少东西），extra = 重建多出来的占比，diff = 模糊后的灰度差（0–1）。差异图 renders/compare-<视角>.png：红是缺的，蓝是多的，灰是两边都有',
    args: { views: '视角，逗号分隔（默认 iso,iso2,top）', size: '边长像素（默认 512）', blur: '模糊半径（像素，默认 size/64）', meshes: '可选：重建里也画网格引用', only: '可选：只比这些角色', box: '可选：取景范围（默认源模型的包围盒）' },
    async run(P, a) {
      const parts = await P.sourceParts();
      const { trisToArray } = await import('./worldtris.mjs');
      const only = a.only ? String(a.only).split(',').map((r) => r.trim()) : null;
      const keep = (r) => (only ? only.includes(r) : VISIBLE_ROLES.has(r));
      const src = parts.filter((p) => keep(p.role ?? 'structure')).map((p, i) => ({ path: p.uid ?? p.name ?? `part_${i}`, pos: trisToArray(p.tris), color: '#c9c9c9' }));
      const result = P.compile(), roleOf = nodeRoles(result);
      const rec = sceneObjects(result, { sourceParts: parts }).filter((o) => o.pos.length && (a.meshes || !o.mesh) && keep(roleOf(o.path))).map((o) => ({ ...o, color: '#c9c9c9' }));
      const size = +(a.size ?? 512), r = Math.max(1, Math.round(+(a.blur ?? size / 64)));
      const bx = a.box ? String(a.box).split(',').map(Number) : null;
      let box = bx && { min: bx.slice(0, 3), max: bx.slice(3) };
      // 盒式模糊（两遍一维）
      const blur = (v, W, H) => {
        const t = new Float32Array(W * H), o = new Float32Array(W * H);
        for (let y = 0; y < H; y++) { let acc = 0; for (let x = -r; x < W; x++) { if (x + r < W) acc += v[y * W + x + r]; if (x - r - 1 >= 0) acc -= v[y * W + x - r - 1]; if (x >= 0) t[y * W + x] = acc / (2 * r + 1); } }
        for (let x = 0; x < W; x++) { let acc = 0; for (let y = -r; y < H; y++) { if (y + r < H) acc += t[(y + r) * W + x]; if (y - r - 1 >= 0) acc -= t[(y - r - 1) * W + x]; if (y >= 0) o[y * W + x] = acc / (2 * r + 1); } }
        return o;
      };
      const views = (a.views ? String(a.views).split(',') : ['iso', 'iso2', 'top']).map((v) => v.trim());
      const out = {};
      for (const view of views) {
        if (!VIEWS[view]) throw new Error(`没有视角 ${view}`);
        const A = rasterize(src, { view, mode: 'color', size, box });
        box ??= A.box;
        const B = rasterize(rec, { view, mode: 'color', size, box: A.box });
        const { W, H } = A, n = W * H;
        const occ = (R) => { const m = new Float32Array(n); for (let i = 0; i < n; i++) m[i] = Number.isFinite(R.zbuf[i]) ? 1 : 0; return m; };
        const lum = (R, m) => { const g = new Float32Array(n); for (let i = 0; i < n; i++) g[i] = m[i] ? (R.rgb[3 * i] + R.rgb[3 * i + 1] + R.rgb[3 * i + 2]) / 765 : 1; return g; };
        const ma = occ(A), mb = occ(B), ba = blur(ma, W, H), bb = blur(mb, W, H), la = blur(lum(A, ma), W, H), lb = blur(lum(B, mb), W, H);
        let sa = 0, miss = 0, extra = 0, diff = 0;
        for (let i = 0; i < n; i++) { sa += ba[i]; miss += Math.max(0, ba[i] - bb[i]); extra += Math.max(0, bb[i] - ba[i]); diff += Math.abs(la[i] - lb[i]); }
        // 差异图：红 = 缺（源有、重建没有），蓝 = 多，灰 = 两边都有
        const rgb = new Uint8Array(3 * n);
        for (let i = 0; i < n; i++) {
          const m = ma[i] && !mb[i], x = mb[i] && !ma[i], both = ma[i] && mb[i];
          rgb[3 * i] = m ? 230 : both ? 170 : x ? 60 : 255; rgb[3 * i + 1] = m ? 40 : both ? 170 : x ? 90 : 255; rgb[3 * i + 2] = m ? 40 : both ? 170 : x ? 230 : 255;
        }
        const file = `renders/compare-${view}${a.meshes ? '-meshes' : ''}${only ? '-' + only.join('+') : ''}.png`;
        P.write(file, encodePNG(rgb, W, H));
        out[view] = { missing: +(miss / (sa || 1)).toFixed(4), extra: +(extra / (sa || 1)).toFixed(4), diff: +(diff / n).toFixed(4), file: P.path(file) };
      }
      return { meshes: !!a.meshes, only, blur: r, box: [...box.min, ...box.max].join(','), views: out };
    },
  },
  render: {
    desc: '离屏渲染成 PNG：view=iso|iso2|top|front|back|left|right，mode=color|id|labels|error（按 score.json 的误差从绿到红上色）；focus=路径或 selection（只标注、并且不被遮挡）；source 渲染源模型；only 只画某些角色（structure,terrain…）；box 指定取景（返回值里的 box 可原样传回，源与重建取景一致）；ortho 正交相机',
    args: { view: '视角（默认 iso）', mode: '模式（默认 labels）', focus: '可选：路径（或源部件名），或 selection', size: '边长像素（默认 1024）', out: '输出文件（默认 renders/<view>-<mode>.png）', source: '可选：渲染源模型而不是重建结果', box: '可选：取景范围 x0,y0,z0,x1,y1,z1', ortho: '可选：正交相机', cut: '可选：水平剖切高度（切掉高于它的部分，剖面画成轮廓线；配合 --view=top 看某一层的平面）', elev: '可选：俯仰角（度），--view=front --elev=0 --ortho 是真正的立面', only: '可选：只画这些角色，逗号分隔（structure / terrain / decor / decal / helper；源模型按部件的角色，重建按 ~role）' },
    async run(P, a) {
      const parts = await P.sourceParts();
      const only = a.only ? String(a.only).split(',').map((r) => r.trim()).filter(Boolean) : null;
      for (const r of only ?? []) if (!ROLE_LABELS[r]) throw new Error(`没有角色 ${r}（可用：${Object.keys(ROLE_LABELS).join(' / ')}）`);
      let objs;
      if (a.source) {
        const { trisToArray } = await import('./worldtris.mjs');
        objs = parts.filter((p) => (only ? only.includes(p.role ?? 'structure') : VISIBLE_ROLES.has(p.role ?? 'structure'))).map((p, i) => ({ path: p.uid ?? p.name ?? p.from ?? `part_${i}`, pos: trisToArray(p.tris), color: p.material?.color ?? '#c9c9c9' }));
      } else {
        const result = P.compile();
        objs = sceneObjects(result, { sourceParts: parts });
        { const roleOf = nodeRoles(result); objs = objs.filter((o) => (only ? only.includes(roleOf(o.path)) : VISIBLE_ROLES.has(roleOf(o.path)))); }
      }
      const view = a.view ?? 'iso', mode = a.mode ?? 'labels';
      if (mode === 'error') {
        // 误差热图：每个物体（或源部件）的平均误差，以 4δ 为满刻度
        let sc = null;
        try { sc = JSON.parse(P.read('score.json')); } catch { throw new Error('先运行 score'); }
        const full = 4 * (sc.consts?.delta ?? 0.05);
        const err = new Map((a.source ? sc.sources.map((x) => [x.name, x.meanErr]) : sc.objects.map((x) => [x.path, x.meanErr])));
        for (const o of objs) { const e = err.get(o.path); if (e != null) o.heat = e / full; }
      }
      const bx = a.box ? String(a.box).split(',').map(Number) : null;
      if (bx && (bx.length !== 6 || bx.some((v) => !Number.isFinite(v)))) throw new Error('box 写成 x0,y0,z0,x1,y1,z1');
      if (!VIEWS[view]) throw new Error(`没有视角 ${view}（可用：${Object.keys(VIEWS).join(' ')}）`);
      const focus = a.focus === 'selection' ? P.selection().paths : a.focus ? [].concat(a.focus) : null;
      const res = rasterize(objs, { view, mode, size: +(a.size ?? 1024), focus: focus?.length ? focus : null, box: bx && { min: bx.slice(0, 3), max: bx.slice(3) }, ortho: !!a.ortho, cut: a.cut != null ? +a.cut : null, elev: a.elev != null ? +a.elev : null });
      const out = a.out ?? `renders/${a.source ? 'source-' : ''}${view}-${mode}${focus ? '-focus' : ''}${only ? '-' + only.join('+') : ''}.png`;
      P.write(out, res.png);
      return { file: P.path(out), view, mode, focus, ...(only ? { only, objects: objs.length } : {}), box: [...res.box.min, ...res.box.max].join(','), legend: res.legend };
    },
  },
  propose: {
    desc: '提交一条提议（AI 的修改不直接写进层文件）：追加到某一层的语句，可撤销该层的某几行；返回编号、新出现的编译错误与分数变化',
    args: { render: '可选：同时渲染应用提议之后的场景', text: '语句（多行用 \\n 分隔），或用 --file=路径', layer: '目标层：edits（默认）/ semantics / style / decisions', why: '理由（一句话，人会看到）', title: '可选：短标题（用作文件名）', retract: '可选：要撤销的目标层行号，逗号分隔' },
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
      const { text, prop, ...pv } = await previewProposal(P, { id, file }, { render: !!a.render, delta: a.delta ? +a.delta : null });
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
    args: { id: '提议编号', render: '可选：渲染应用提议之后的场景（聚焦在变化的物体上）', view: '可选：渲染视角', all: '可选：列出全部变化的物体（默认只列变化 ≥ 0.5 的前 20 个）；每个物体的 desc 是描述的变化、res 是残差的变化', delta: '可选：按这个 δ（米）评分' },
    async run(P, a) { const { text, prop, ...pv } = await previewProposal(P, findProposal(P, a.id ?? a._?.[0]), { render: !!a.render, view: a.view, delta: a.delta ? +a.delta : null, all: !!a.all }); return pv; },
  },
  accept: {
    desc: '接受一条提议：追加进目标层（有新的编译错误时拒绝接受，除非 --force），提议移到 proposals/accepted/',
    args: { id: '提议编号', force: '可选：有编译错误也接受' },
    async run(P, a) {
      const p = findProposal(P, a.id ?? a._?.[0]);
      const pv = await previewProposal(P, p, { delta: a.delta ? +a.delta : null });
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
  refine: {
    desc: '细化：把物体对应的源网格按更细的档位重新描述（类型实例 → 细化类型本身，所有实例一起变；普通物体 → 保名换形成 group），名字与引用不变。生成几个候选（全部分量 / 按面积只留大块 / 体素），用只看这个物体的局部分数挑最好的——粗档位下窗框、饰条这类小构件会被舍弃。默认生成提议；--apply 分数下降就接受；--auto 从最差的物体开始逐个细化（局部分数没变好的直接跳过），直到解释率达到 --target 或用完 --budget',
    args: { paths: '要细化的物体（可选）', worst: '可选：细化分数里最差的 N 个', to: '目标档位：structure / detail（默认比工程档位细一档）', apply: '可选：分数下降就直接接受（按工程的 δ；--by=target 按目标档位的 δ）', by: '可选：target——--apply 按目标档位的 δ 判断', auto: '可选：自动模式', budget: '自动模式最多尝试几个物体（默认 10）', target: '自动模式的解释率目标（默认 1，即直到预算用完）' },
    async run(P, a) {
      const to = a.to ?? finer(P.cfg.fidelity ?? 'semantic');
      const parts = await P.sourceParts();
      if (a.auto) return refineAuto(P, parts, { to, budget: +(a.budget ?? 10), target: +(a.target ?? 1) });
      let targets = pathsArg(P, a);
      if (a.worst) {
        let sc = null;
        try { sc = JSON.parse(P.read('score.json')); } catch { sc = await COMMANDS.score.run(P, {}); }
        targets = sc.worst.filter((w) => !w.mesh).slice(0, +a.worst).map((w) => w.path);
      }
      if (!targets.length) throw new Error('要细化哪些物体？给路径，或 --worst=N，或 --auto');
      const r = P.compile(), out = [], seen = new Set();
      for (const path of targets) {
        const pr = refineProposal(r, parts, path, { to, unit: P.unit, baseLineOf: baseLineOf(P, r) });
        if (pr.error) { out.push(pr); continue; }
        if (seen.has(pr.target)) continue; // 同一种类型只细化一次
        seen.add(pr.target);
        const d = FIDELITY[to].tau;
        const pv = await COMMANDS.propose.run(P, { text: pr.text, why: `细化到 ${to}（按 δ=${d} 衡量）：${pr.kind === 'type' ? '类型' : '物体'} ${pr.target} → ${pr.name}，${pr.boxes} 个部件；局部分数 ${pr.current.S} → ${pr.local.S}`, title: `refine-${pr.target}`.slice(0, 40), delta: d });
        // 按工程自己的 δ 再算一次：refine 按目标档位挑候选，但写不写进工程要看工程的分数（--by=target 才按目标档位）
        const pvP = P.cfg.score?.delta === d ? pv : await previewProposal(P, findProposal(P, pv.id), {});
        const judge = a.by === 'target' ? pv.delta : pvP.delta;
        let accepted = false;
        if (a.apply && judge < 0 && !pv.errors.length) { await COMMANDS.accept.run(P, { id: pv.id, delta: a.by === 'target' ? d : null }); accepted = true; }
        const warning = Math.sign(pv.delta) !== Math.sign(pvP.delta) ? `按目标档位（δ=${d}）是 ${pv.delta}，按工程（δ=${P.cfg.score?.delta}）是 ${pvP.delta}：两把尺子方向不同` : undefined;
        out.push({ path, target: pr.target, kind: pr.kind, chosen: pr.name, boxes: pr.boxes, local: { current: pr.current.S, best: pr.local.S, instances: pr.instances }, candidates: pr.candidates, id: pv.id, delta: pv.delta, delta_project: pvP.delta, ...(warning ? { warning } : {}), errors: pv.errors, accepted });
      }
      return out;
    },
  },
  check: {
    desc: '空跑：把一段语句临时叠加到某一层上编译（不生成提议、不改文件），报告新出现的编译错误；语句对场景没有任何效果时给出警告。不带 text 时检查整个工程',
    args: { text: '可选：要试的语句（多行用 \\n 分隔）', file: '可选：从文件读语句', layer: '叠加到哪一层（默认 edits）', score: '可选：顺便算分数变化（不生成提议、不占预算）' },
    async run(P, a) {
      const layer = (a.layer ?? 'edits').replace(/\.s3d$/, '') + '.s3d';
      const before = P.compile();
      if (!a.text && !a.file) return { errors: before.errors, objects: before.items.length };
      const body = a.file ? readFileSync(a.file, 'utf8') : String(a.text).replace(/\\n/g, '\n');
      const after = P.compile('', { [layer]: (P.exists(layer) ? P.read(layer) : '') + '\n' + body + '\n' });
      const known = new Set(before.errors.map((e) => `${e.file}:${e.message}`));
      const errors = after.errors.filter((e) => !known.has(`${e.file}:${e.message}`));
      // 有没有效果：比较每个几何条目的种类、形状参数、位姿、材质
      const sig = (r) => new Map(r.items.map((i) => [i.path, JSON.stringify([i.kind, i.geom, i.world && [i.world.R.flat().map((v) => +v.toFixed(5)), i.world.t.map((v) => +v.toFixed(5))], i.material])]));
      const A = sig(before), B = sig(after);
      const added = [...B.keys()].filter((k) => !A.has(k)), removed = [...A.keys()].filter((k) => !B.has(k));
      const modified = [...B.keys()].filter((k) => A.has(k) && A.get(k) !== B.get(k));
      const warnings = [];
      if (!errors.length && !added.length && !removed.length && !modified.length) warnings.push('这段语句对场景没有任何效果（几何、位置、材质都没变）——检查路径和写法');
      let score;
      if (a.score) { const over = { [layer]: (P.exists(layer) ? P.read(layer) : '') + '\n' + body + '\n' }; const s0 = await scoreWith(P), s1 = await scoreWith(P, over); score = { before: s0.s.S, after: s1.s.S, delta: +(s1.s.S - s0.s.S).toFixed(2) }; }
      return { errors, warnings, ...(score ? { score } : {}), added: added.slice(0, 30), removed: removed.slice(0, 30), modified: modified.slice(0, 30) };
    },
  },
  score: {
    desc: '自评分数：S = 描述长度 + 网格引用 + 双向几何残差（越低越好）；explain 是解释率；worst 是下一步最值得修的物体',
    args: { objects: '可选：输出每个物体的分数' },
    async run(P, a) {
      const s = score({ result: P.compile(), files: P.geometryFiles(), sourceParts: await P.sourceParts(), consts: P.consts(), cache: P.scoreCache() });
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
  // 层文件里用到网格的曲面锚点（B.top[u,w] 落在网格的真实表面上）：先读源部件，编译时才有网格数据
  try { if (P.usesSurfaceAnchors()) await P.sourceParts(); } catch { /* 读不到源模型：编译退回包围盒并给警告 */ }
  let out, err = null;
  try { out = await c.run(P, args); return out; } catch (e) { err = e.message; throw e; } finally {
    // 每次调用都记下来（可以回放、可以分析 agent 的行为）
    try { mkdirSync(P.path('state'), { recursive: true }); appendFileSync(P.path('state/log.jsonl'), JSON.stringify({ t: new Date().toISOString(), cmd: name, args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== '_')), ms: Date.now() - t0, error: err, S: out?.S ?? out?.after ?? undefined }) + '\n'); } catch { /* 日志失败不影响命令 */ }
  }
}
