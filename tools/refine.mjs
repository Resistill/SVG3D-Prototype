// 细化：把一个物体对应的源网格，按更细的档位重新描述，写回工程（名字与引用不变）。
//   类型的实例 → 细化类型本身：def T : T { drop body ; box … }（所有实例一起变细——享元的好处）
//   普通物体   → 保名换形：over x : group pin=origin { box … }
// 拆分用通用的“体素占据 + 贪心合并成盒子”：体素只是中间步骤，输出的是若干干净的盒子（两柱一梁、带门洞的墙）。
// 网格闭合时填满内部，不闭合时把表面当成薄板；体素大小由目标档位决定，盒子太多就放粗一级。

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const fmt = (x, d) => { const v = Math.round(x * 10 ** d) / 10 ** d; return Object.is(v, -0) ? '0' : String(v); };

// 网格是否闭合：按位置焊接后，每条边恰好被两个三角形共用
function isClosed(tris) {
  const key = (p) => p.map((x) => Math.round(x * 1e4)).join(',');
  const edges = new Map();
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const a = key(t[k]), b = key(t[(k + 1) % 3]);
    const e = a < b ? `${a}|${b}` : `${b}|${a}`;
    edges.set(e, (edges.get(e) ?? 0) + 1);
  }
  let open = 0;
  for (const n of edges.values()) if (n !== 2) open++;
  return open <= edges.size * 0.01;
}

// 局部坐标里的三角形 → 若干轴对齐的盒子 [{min, max}]
export function voxelBoxes(tris, { voxel, maxBoxes = 40, maxCells = 96 } = {}) {
  const vs = tris.flat();
  const lo = [0, 1, 2].map((k) => Math.min(...vs.map((v) => v[k]))), hi = [0, 1, 2].map((k) => Math.max(...vs.map((v) => v[k])));
  const ext = sub(hi, lo);
  let v = Math.max(voxel, Math.max(...ext) / maxCells, 1e-6);
  const closed = isClosed(tris);
  for (let attempt = 0; attempt < 6; attempt++, v *= 1.6) {
    const n = ext.map((e) => Math.max(1, Math.ceil(e / v - 1e-9)));
    const idx = (i, j, k) => (k * n[1] + j) * n[0] + i;
    const cellOf = (p) => [0, 1, 2].map((a) => Math.min(n[a] - 1, Math.max(0, Math.floor((p[a] - lo[a]) / v))));
    const solid = new Uint8Array(n[0] * n[1] * n[2]);
    // 表面体素：在三角形上按半个体素的间距采样
    for (const [A, B, C] of tris) {
      const m = Math.max(1, Math.ceil(Math.max(Math.hypot(...sub(B, A)), Math.hypot(...sub(C, A)), Math.hypot(...sub(C, B))) / (v / 2)));
      for (let a = 0; a <= m; a++) for (let b = 0; b <= m - a; b++) {
        const u = a / m, w = b / m, p = [0, 1, 2].map((q) => A[q] + (B[q] - A[q]) * u + (C[q] - A[q]) * w);
        const c = cellOf(p);
        solid[idx(...c)] = 1;
      }
    }
    // 从外面泛洪，没被泛洪到的就是内部（网格有漏缝时泛洪会灌进去，自然退化成只有表面的薄壳）
    {
      const outside = new Uint8Array(solid.length), stack = [];
      const push = (i, j, k) => { if (i < 0 || j < 0 || k < 0 || i >= n[0] || j >= n[1] || k >= n[2]) return; const q = idx(i, j, k); if (outside[q] || solid[q]) return; outside[q] = 1; stack.push([i, j, k]); };
      for (let i = 0; i < n[0]; i++) for (let j = 0; j < n[1]; j++) { push(i, j, 0); push(i, j, n[2] - 1); }
      for (let i = 0; i < n[0]; i++) for (let k = 0; k < n[2]; k++) { push(i, 0, k); push(i, n[1] - 1, k); }
      for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) { push(0, j, k); push(n[0] - 1, j, k); }
      while (stack.length) { const [i, j, k] = stack.pop(); push(i + 1, j, k); push(i - 1, j, k); push(i, j + 1, k); push(i, j - 1, k); push(i, j, k + 1); push(i, j, k - 1); }
      for (let q = 0; q < solid.length; q++) if (!outside[q]) solid[q] = 1;
    }
    // 贪心合并：沿 x 延伸，再沿 z，再沿 y
    const used = new Uint8Array(solid.length), boxes = [];
    const free = (i, j, k) => solid[idx(i, j, k)] && !used[idx(i, j, k)];
    for (let j = 0; j < n[1]; j++) for (let k = 0; k < n[2]; k++) for (let i = 0; i < n[0]; i++) {
      if (!free(i, j, k)) continue;
      let i1 = i; while (i1 + 1 < n[0] && free(i1 + 1, j, k)) i1++;
      let k1 = k; const rowOk = (kk) => { for (let x = i; x <= i1; x++) if (!free(x, j, kk)) return false; return true; };
      while (k1 + 1 < n[2] && rowOk(k1 + 1)) k1++;
      let j1 = j; const layerOk = (jj) => { for (let z = k; z <= k1; z++) for (let x = i; x <= i1; x++) if (!free(x, jj, z)) return false; return true; };
      while (j1 + 1 < n[1] && layerOk(j1 + 1)) j1++;
      for (let y = j; y <= j1; y++) for (let z = k; z <= k1; z++) for (let x = i; x <= i1; x++) used[idx(x, y, z)] = 1;
      // 盒子的边界：贴着包络的那一面取包络的精确值（不被体素取整）
      const bmin = [i, j, k].map((c, a) => lo[a] + c * v), bmax = [i1 + 1, j1 + 1, k1 + 1].map((c, a) => Math.min(hi[a], lo[a] + c * v));
      boxes.push({ min: bmin, max: bmax });
    }
    if (boxes.length <= maxBoxes) return { boxes, voxel: v, closed };
  }
  return null;
}

// 盒子的几何角色：给拆出来的部件起名
function roleOf(b) {
  const e = sub(b.max, b.min), [w, h, d] = e, thin = Math.min(...e), long = Math.max(...e);
  if (h > 2.5 * Math.max(w, d)) return 'column';
  if (h <= thin + 1e-9 && thin * 4 < Math.min(w, d)) return 'slab';
  if (thin * 4 < h && (w === thin || d === thin)) return 'wall';
  if (long > 4 * (w + h + d - long - thin)) return 'beam';
  return 'block';
}

// 盒子 → 语句（在给定坐标系里：盒子的原点是底面中心）
export function boxLines(boxes, digits = 2) {
  const count = {};
  return boxes.map((b) => {
    const r = roleOf(b);
    count[r] = (count[r] ?? 0) + 1;
    const size = sub(b.max, b.min), at = [(b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2];
    return `box ${r}${count[r] > 1 ? `_${count[r]}` : ''} size=${size.map((x) => fmt(x, digits)).join(',')} at=${at.map((x) => fmt(x, digits)).join(',')}`;
  });
}

// 世界坐标的三角形 → 某个节点的局部坐标（节点的世界变换须是刚体）
export function toLocal(tris, world) {
  const { R, t } = world;
  const inv = (p) => { const d = sub(p, t); return [0, 1, 2].map((k) => R[0][k] * d[0] + R[1][k] * d[1] + R[2][k] * d[2]); };
  return tris.map((tri) => tri.map(inv));
}

// ── 生成细化的提议 ──
import { fitPart, orientText, setFidelity, FIDELITY, digitsFor, splitComponents, reverse as reverseParts } from './reverse.mjs';
import { sceneObjects } from './worldtris.mjs';
import { neighborhoodScorer, SCORE_DEFAULTS, reshapeSaving } from './score.mjs';
import { panelLines } from './panels.mjs';
import { compile, FACT_EPS } from '../src/s3d.js';

const mvT = (cols, v) => [dot(cols[0], v), dot(cols[1], v), dot(cols[2], v)];
const mvC = (cols, v) => [0, 1, 2].map((k) => cols[0][k] * v[0] + cols[1][k] * v[1] + cols[2][k] * v[2]);
const ORDER = ['semantic', 'structure', 'detail'];
export const finer = (f) => ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(f) + 1)];
const areaOf = (tris) => tris.reduce((s2, [a, b, c]) => { const u = sub(b, a), w = sub(c, a); return s2 + Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2; }, 0);

// 体素拆盒子（在拟合坐标系里切：斜放的网格也能用少量盒子贴紧）→ 语句
function voxelLines(tris, { voxel, maxBoxes, digits }) {
  const fit = fitPart({ tris, name: null, material: null }, 0);
  const cols = fit.frame.cols;
  const res = voxelBoxes(tris.map((t) => t.map((p) => mvT(cols, p))), { voxel, maxBoxes });
  if (!res) return null;
  const orient = orientText(cols);
  const lines = boxLines(res.boxes, digits).map((l) => {
    // 盒子在拟合坐标系里：位置换回物体坐标系，朝向写成拟合坐标系的朝向
    const m = / at=([-\d.]+),([-\d.]+),([-\d.]+)$/.exec(l);
    const at = mvC(cols, [+m[1], +m[2], +m[3]]);
    return l.replace(/ at=[^ ]+$/, ` at=${at.map((x) => fmt(x, digits)).join(',')}${orient ? ' ' + orient : ''}`);
  });
  return { lines, boxes: res.boxes.length, voxel: res.voxel };
}

// 一组分量 → 在物体自己的坐标系里跑一遍逆向（逐块拟合、找关系、找阵列与镜像）；
// 面积大、又拟合不好的分量（一整栋楼的外壳）换成同名的一组体素盒子（substitute='voxel'）或板件（'panel'：墙板、楼板、开洞）。
// 每个子块记下来源 ~src="部件#分量"，以后还能逐层细化
function nestedLines(comps, { to, unit, digits, voxel, panel, substitute = 'voxel' }) {
  const out = reverseParts(comps.map((c) => ({ ...c, name: null })), { srcFile: 'refine', fidelity: to, unit, types: false, names: false, defaultMaterial: false });
  setFidelity(to, unit);
  const total = comps.reduce((s2, c) => s2 + c.area, 0);
  const bySrc = new Map(comps.map((c) => [c.from, c]));
  const poor = new Map();
  for (const o of out.objs) { const c = bySrc.get(o.src); if (substitute && c && (o.fit ?? 1) < 0.5 && c.area > 0.03 * total) poor.set(o.id, c); }
  const materials = out.src.split('\n').filter((l) => /^material /.test(l));
  const lines = [];
  let voxels = 0;
  for (const l of out.src.split('\n')) {
    if (!l.trim() || /^(\/\/|material )/.test(l)) continue;
    const m = /^([\p{L}_][\p{L}\p{N}_]*) ([\p{L}_][\p{L}\p{N}_]*) /u.exec(l);
    const c = m && poor.get(m[2]);
    const v = c && (substitute === 'panel' ? panelLines(c.tris, { ...panel, cell: voxel, maxBoxes: 16, digits }) : voxelLines(c.tris, { voxel, maxBoxes: 8, digits }));
    if (v) { lines.push(`group ${m[2]} ~src="${c.from}" {`, ...v.lines.map((x) => '  ' + x), '}'); voxels += v.boxes; continue; }
    lines.push(l.replace(/ ~fit=\S+/, ''));
  }
  return { lines, materials, boxes: out.objs.length - poor.size + voxels, arrays: out.report.arrays.length, voxelized: voxels ? poor.size : 0 };
}

// 来源 ~src → 源部件：先按完整名字找（L2 的部件名本身带 #）；找不到就是“部件#分量”——细化出来的子块，分量按世界坐标拆（可以嵌套）。
// 返回 { part（这个来源的几何，分量也包装成部件）, whole（它所在的源部件，邻域评分用） }
const SPLITS = new WeakMap();
function sourceOf(parts, src) {
  const exact = parts.find((p) => (p.uid ?? p.name ?? p.from) === src);
  if (exact) return { part: exact, whole: exact };
  const i = src.lastIndexOf('#'), k = +src.slice(i + 1);
  if (i < 0 || !Number.isInteger(k)) return null;
  const up = sourceOf(parts, src.slice(0, i));
  if (!up) return null;
  let cache = SPLITS.get(parts);
  if (!cache) SPLITS.set(parts, (cache = new Map()));
  if (!cache.has(up.part.uid ?? up.part.name)) cache.set(up.part.uid ?? up.part.name, splitComponents(up.part));
  const comp = cache.get(up.part.uid ?? up.part.name)[k];
  return comp ? { part: { ...up.part, uid: src, name: null, from: src, tris: comp.tris }, whole: up.whole } : null;
}

// 一个物体（编译结果里的节点路径，基本体或网格引用都可以）→ 细化提议 { target, kind: 'type' | 'object', text, boxes, candidates, current, local }；拆不了返回 { error }
// 候选：全部分量 / 按面积只留大块（99%、97%、90%）/ 整体体素（几种粒度）。用邻域评分（全场分数在这个物体附近的变化，按目标档位的 δ）挑最好的：
// 窗框、饰条这种小构件在粗档位下“写出来的代价 > 省掉的残差”，自然被舍弃。unit：场景单位（每个单位多少米），档位的数值按米、随之换算
// baseLineOf(路径)：基础层里声明这个顶层物体的那一行（还没被换过形时）；over X : group 让它的形状参数作废，邻域评分要把省下的算进去
export function refineProposal(result, parts, path, { to = 'structure', unit = 1, baseLineOf = null } = {}) {
  const byPath = new Map(result.nodes.map((n) => [n.path, n]));
  let n = byPath.get(path);
  if (!n) return { path, error: '没有这个物体' };
  // 实例里的部件（实例.body）→ 实例本身
  if (!n.meta?.src && path.includes('.')) { const up = byPath.get(path.slice(0, path.lastIndexOf('.'))); if (up?.types) n = up; }
  // 对应的源部件：自己的 ~src；类型的实例可以借同类型的另一个实例；都没有时（阵列成员）按世界包围盒的重叠度找
  if (!n.meta?.src && n.types) { const twin = result.nodes.find((m) => m.types?.[0] === n.types[0] && m.meta?.src); if (twin) n = twin; }
  // 类型内部的子块（细化过的类型）：~src 指向细化时借用的那个实例的分量，换一个实例几何就对不上——暂不支持再细化
  const segs = n.path.split('.');
  if (n.meta?.src && segs.slice(1).some((_, i) => byPath.get(segs.slice(0, i + 1).join('.'))?.types)) return { path, error: '类型内部的子块暂不支持再细化' };
  const found = n.meta?.src ? sourceOf(parts, n.meta.src) : null;
  let part = found?.part, whole = found?.whole;
  if (!part && n.box) {
    let best = 0.5;
    for (const p of parts) {
      const vs = p.tris.flat(), lo = [0, 1, 2].map((k) => Math.min(...vs.map((v) => v[k]))), hi = [0, 1, 2].map((k) => Math.max(...vs.map((v) => v[k])));
      const ov = [0, 1, 2].map((k) => Math.max(0, Math.min(hi[k], n.box.max[k]) - Math.max(lo[k], n.box.min[k])));
      const vol = (a, b) => [0, 1, 2].reduce((m, k) => m * Math.max(1e-9, b[k] - a[k]), 1);
      const iou = (ov[0] * ov[1] * ov[2]) / (vol(lo, hi) + vol(n.box.min, n.box.max) - ov[0] * ov[1] * ov[2]);
      if (iou > best) { best = iou; part = whole = p; }
    }
  }
  if (!part) return { path, error: '找不到对应的源部件' };
  if (!n.world || Math.abs(Math.abs(det3(n.world.R)) - 1) > 1e-6 || det3(n.world.R) < 0) return { path, error: '物体的变换不是刚体（缩放或镜像），暂不支持' };
  const F = FIDELITY[to] ?? FIDELITY.structure;
  const consts = { delta: F.tau, unit };
  const local = toLocal(part.tris, n.world);
  // 现在的几何（物体坐标系里）：它的包围盒写成名义外包络 envelope——
  // 关系、锚点、定位点都按它算，拆成多少块，挂在它上面的物体都不动（保住第一遍的骨架）
  const cur = localObjects(result, n, parts);
  const env = boxOf(cur);
  // 邻域评分的基准：现在的几何（世界坐标）；候选在物体坐标系里写成，评分前换回世界坐标，路径按写进场景之后的样子取（采样种子取自路径）
  const hood = neighborhood(result, parts, n, whole, consts);
  const { R, t } = n.world;
  // 没写材质的部件在场景里继承原物体的材质（over … : group 保留原来的 mat）：按原物体的颜色计价
  const inherited = hood.cur[0]?.color;
  const toWorld = (r, prefix) => {
    const own = new Set(r.items.filter((i) => i.material?.name).map((i) => i.path));
    return sceneObjects(r).map((o) => {
      const pos = new Float32Array(o.pos.length);
      for (let i = 0; i < o.pos.length; i += 3) for (let j = 0; j < 3; j++) pos[i + j] = R[j][0] * o.pos[i] + R[j][1] * o.pos[i + 1] + R[j][2] * o.pos[i + 2] + t[j];
      return { ...o, pos, path: `${prefix}.${o.path}`, color: own.has(o.path) ? o.color : inherited ?? o.color };
    });
  };
  const envTxt = env ? ` envelope=${[...env.min, ...env.max].map((x) => fmt(x, 4)).join(',')}` : '';
  const wrap = (body) => (n.types
    ? { path: n.path, target: n.types[0], kind: 'type', envelope: env, text: `def ${n.types[0]} : ${n.types[0]} {\n  drop body\n  group body${envTxt} {\n${body.map((l) => '    ' + l).join('\n')}\n  }\n}` }
    : { path: n.path, target: n.path, kind: 'object', envelope: env, text: `over ${n.path} : group${envTxt} {\n${body.map((l) => '  ' + l).join('\n')}\n}` });
  // 类型：改 def 会让所有实例一起变好（享元），残差的变化按实例数计；描述只写一次
  const N = n.types ? Math.max(1, result.nodes.filter((m) => m.types?.[0] === n.types[0] && !m.path.includes('.') === !n.path.includes('.')).length) : 1;
  const total = (x) => +(x.L + N * (x.R_src + x.R_recon)).toFixed(2);
  const current = hood.scorer(hood.cur);
  const base = !n.types && baseLineOf ? baseLineOf(n.path) : null, saving = base ? reshapeSaving(base) : 0;
  current.S = total(current);
  const cands = [];
  const seen = new Set();
  const add = (name, c) => {
    if (!c) return;
    const key = c.lines.join('\n');
    if (seen.has(key)) return;
    seen.add(key);
    const r = compile([...(c.materials ?? []), ...c.lines].join('\n'), { factEps: FACT_EPS / unit });
    if (r.errors.length) { cands.push({ name, error: r.errors[0].message }); return; }
    const w = wrap(c.lines);
    const ls = hood.scorer(toWorld(r, n.types ? `${n.path}.body` : n.path), w.text.split('\n'));
    if (saving) { ls.L = +(ls.L - saving).toFixed(2); ls.S = +(ls.S - saving).toFixed(2); }
    // 去掉一个物体只在它的表面确实被周围的物体解释了的时候才行（平均误差不超过 2τ：贴花、标线、重合的面）；
    // 分数不计语义，一栋楼、一丛灌木不能因为“写出来比误差贵”就消失
    if (c.empty && ls.meanErr > 2 * F.tau) { cands.push({ name, error: `周围的物体解释不了它（平均误差 ${ls.meanErr} m）` }); return; }
    ls.S = total(ls);
    cands.push({ name, ...w, boxes: c.boxes, parts: c.parts, arrays: c.arrays, voxel: c.voxel, local: ls });
  };
  const digits = digitsFor(to, unit), voxel = Math.max(2 * F.tau, 1e-3) / unit;
  // 板件：单面薄板的厚度、配对成一块板的最大厚度（墙、楼板一般不超过 1 m）
  const panel = { thick: Math.max(2 * F.tau, 0.1) / unit, maxThick: 1 / unit };
  // 分量在世界坐标里拆（编号与 ~src 的“部件#分量”一致），再换到物体坐标系
  const comps = splitComponents(part).map((c) => { const tris = toLocal(c.tris, n.world); return { ...c, tris, area: areaOf(tris) }; }).sort((a, b) => b.area - a.area);
  if (comps.length > 1) {
    const total = comps.reduce((s2, c) => s2 + c.area, 0);
    const kept = new Set();
    for (const frac of [1, 0.99, 0.97, 0.9]) {
      let acc = 0, k = 0;
      while (k < comps.length && acc < frac * total * (1 - 1e-9)) acc += comps[k++].area;
      k = Math.max(1, k);
      if (kept.has(k)) continue;
      kept.add(k);
      const label = frac === 1 ? `全部 ${comps.length} 块` : `面积前 ${Math.round(frac * 100)}%（${k}/${comps.length} 块）`;
      add(label, { ...nestedLines(comps.slice(0, k), { to, unit, digits, voxel, substitute: null }), parts: k });
      const v = nestedLines(comps.slice(0, k), { to, unit, digits, voxel });
      if (v.voxelized) add(`${label}，拟合差的 ${v.voxelized} 块换成体素`, { ...v, parts: k });
      const w = nestedLines(comps.slice(0, k), { to, unit, digits, voxel, panel, substitute: 'panel' });
      if (w.voxelized) add(`${label}，拟合差的 ${w.voxelized} 块换成板件`, { ...w, parts: k });
    }
  }
  setFidelity(to, unit);
  for (const [v, mb] of [[voxel, to === 'detail' ? 120 : 40], [voxel * 4, 16], [voxel * 16, 6]]) {
    const c = voxelLines(local, { voxel: v, maxBoxes: mb, digits });
    if (c) add(`体素 ${fmt(c.voxel, 3)}（${c.boxes} 块）`, { ...c, parts: comps.length });
  }
  // 去掉：由周围的物体解释（贴在墙上的贴花、路面标线离表面只有几厘米；合批进一个网格的一堆小装饰）。名义外包络还在，挂在它上面的物体不动
  add('去掉（由周围的物体解释）', { lines: [], boxes: 0, parts: 0, empty: true });
  // 板件：有内部空间的大分量（外墙、楼板、内墙连成一个网格）按平面拆成墙板、楼板，门窗洞空出来
  for (const [cell, mb] of [[voxel, to === 'detail' ? 240 : 120], [voxel * 2, 60], [voxel * 4, 30]]) {
    const p = panelLines(local, { ...panel, cell, maxBoxes: mb, digits });
    if (p) add(`板件 ${fmt(p.cell, 3)}（${p.boxes} 块）`, { lines: p.lines, boxes: p.boxes, parts: comps.length });
  }
  const ok = cands.filter((c) => !c.error).sort((a, b) => a.local.S - b.local.S);
  if (!ok.length) return { path, error: '没有可用的候选', candidates: cands.map((c) => ({ name: c.name, error: c.error })) };
  const best = ok[0];
  return {
    ...best, current, instances: N, gain: +(best.local.S - current.S).toFixed(2),
    candidates: cands.map((c) => ({ name: c.name, ...(c.error ? { error: c.error } : { boxes: c.boxes, S: c.local.S, L: c.local.L, R: +(c.local.R_src + c.local.R_recon).toFixed(2) }) })),
  };
}
// 邻域：这个物体的源部件 + 离它不超过 dMax 的其他源部件；附近其他的重建物体（世界坐标）。
// 同一个编译结果、同一组源部件反复细化（--auto）时，整个场景的几何与源部件的包围盒只算一次
const WORLD = new WeakMap(), BOXES = new WeakMap();
const boxMeet = (a, b, pad) => [0, 1, 2].every((j) => a.min[j] - pad <= b.max[j] && b.min[j] <= a.max[j] + pad);
function neighborhood(result, parts, n, part, consts) {
  const k = { ...SCORE_DEFAULTS, ...consts }, pad = k.dMax / k.unit;
  let boxes = BOXES.get(parts);
  if (!boxes) BOXES.set(parts, (boxes = parts.map((p) => boxOf([{ pos: p.tris.flat(2) }]))));
  const own = parts.indexOf(part);
  const near = [own, ...parts.map((_, i) => i).filter((i) => i !== own && boxMeet(boxes[i], boxes[own], pad))];
  const U = near.reduce((u, i) => ({ min: u.min.map((x, j) => Math.min(x, boxes[i].min[j])), max: u.max.map((x, j) => Math.max(x, boxes[i].max[j])) }), { min: [...boxes[own].min], max: [...boxes[own].max] });
  let world = WORLD.get(result);
  if (!world) WORLD.set(result, (world = sceneObjects(result, { sourceParts: parts }).filter((o) => o.pos.length).map((o) => ({ ...o, box: boxOf([o]) }))));
  const mine = (p) => p === n.path || p.startsWith(n.path + '.');
  const rest = world.filter((o) => !mine(o.path));
  return {
    cur: world.filter((o) => mine(o.path)),
    scorer: neighborhoodScorer({ parts, near, others: rest.filter((o) => boxMeet(o.box, U, pad)), reconColors: new Set(rest.map((o) => String(o.color ?? '').toLowerCase())), consts, sharedMeshes: new Set(rest.filter((o) => o.mesh).map((o) => o.mesh.key ?? o.mesh.src)) }),
  };
}
// 物体（及其内部各部件）现在的几何，变换到物体自己的坐标系
function localObjects(result, n, parts) {
  const items = result.items.filter((i) => i.path === n.path || i.path.startsWith(n.path + '.'));
  const { R, t } = n.world;
  return sceneObjects({ ...result, items }, { sourceParts: parts }).map((o) => {
    const pos = new Float32Array(o.pos.length);
    for (let i = 0; i < o.pos.length; i += 3) {
      const d = [o.pos[i] - t[0], o.pos[i + 1] - t[1], o.pos[i + 2] - t[2]];
      for (let k = 0; k < 3; k++) pos[i + k] = R[0][k] * d[0] + R[1][k] * d[1] + R[2][k] * d[2];
    }
    return { ...o, pos };
  });
}
function boxOf(objs) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const o of objs) for (let i = 0; i < o.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], o.pos[i + k]); hi[k] = Math.max(hi[k], o.pos[i + k]); }
  return Number.isFinite(lo[0]) ? { min: lo, max: hi } : null;
}
const det3 = (R) => R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
