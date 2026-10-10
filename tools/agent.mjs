// 工具集：人（界面）与 AI（命令行 / MCP）共用的“看 / 查 / 做 / 评”。一张命令表，CLI、MCP、HTTP 都由它生成。
// 每个命令：desc（给人和模型看的说明）、args（参数说明）、run(工程, 参数) → 可序列化为 JSON 的结果
import { outline } from './outline.mjs';
import { score } from './score.mjs';
import { sceneObjects } from './worldtris.mjs';
import { rasterize, VIEWS } from './raster.mjs';
import { initProject, openProject, runReverse } from './project.mjs';

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
    desc: '从源模型（GLB）新建工程：记录源模型、跑一次逆向、生成各层文件',
    args: { source: '源模型 .glb 的路径', copy: '可选：把源模型复制进工程（source/world.glb）' },
    noProject: true,
    async run(dir, a) { return initProject(dir, a.source ?? a._?.[0], { copy: !!a.copy }); },
  },
  reverse: {
    desc: '重跑逆向，重写 base.s3d（上一次的结果作为名字记忆，修改层的路径保持有效）',
    args: { fresh: '可选：不沿用上一次的名字' },
    async run(P, a) { return runReverse(P, { fresh: !!a.fresh }); },
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
  return c.noProject ? c.run(dir, args) : c.run(openProject(dir), args);
}
