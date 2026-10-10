// 细化：把一个物体对应的源网格，按更细的档位拆成一组盒子，写回工程（名字与引用不变）。
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
import { fitPart, orientText, setFidelity, FIDELITY, splitComponents, reverse as reverseParts } from './reverse.mjs';
import { sceneObjects } from './worldtris.mjs';

const mvT = (cols, v) => [dot(cols[0], v), dot(cols[1], v), dot(cols[2], v)];
const mvC = (cols, v) => [0, 1, 2].map((k) => cols[0][k] * v[0] + cols[1][k] * v[1] + cols[2][k] * v[2]);
const ORDER = ['semantic', 'structure', 'detail'];
export const finer = (f) => ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(f) + 1)];

// 一个物体（编译结果里的节点路径）→ { target, kind: 'type' | 'object', text, boxes }；拆不了返回 { error }
export function refineProposal(result, parts, path, { to = 'structure' } = {}) {
  const byPath = new Map(result.nodes.map((n) => [n.path, n]));
  let n = byPath.get(path);
  if (!n) return { path, error: '没有这个物体' };
  // 实例里的部件（实例.body）→ 实例本身
  if (!n.meta?.src && path.includes('.')) { const up = byPath.get(path.slice(0, path.lastIndexOf('.'))); if (up?.types) n = up; }
  // 对应的源部件：自己的 ~src；类型的实例可以借同类型的另一个实例；都没有时（阵列成员）按世界包围盒的重叠度找
  if (!n.meta?.src && n.types) { const twin = result.nodes.find((m) => m.types?.[0] === n.types[0] && m.meta?.src); if (twin) n = twin; }
  let part = n.meta?.src && parts.find((p) => (p.uid ?? p.name ?? p.from) === n.meta.src);
  if (!part && n.box) {
    let best = 0.5;
    for (const p of parts) {
      const vs = p.tris.flat(), lo = [0, 1, 2].map((k) => Math.min(...vs.map((v) => v[k]))), hi = [0, 1, 2].map((k) => Math.max(...vs.map((v) => v[k])));
      const ov = [0, 1, 2].map((k) => Math.max(0, Math.min(hi[k], n.box.max[k]) - Math.max(lo[k], n.box.min[k])));
      const vol = (a, b) => [0, 1, 2].reduce((m, k) => m * Math.max(1e-9, b[k] - a[k]), 1);
      const iou = (ov[0] * ov[1] * ov[2]) / (vol(lo, hi) + vol(n.box.min, n.box.max) - ov[0] * ov[1] * ov[2]);
      if (iou > best) { best = iou; part = p; }
    }
  }
  if (!part) return { path, error: '找不到对应的源部件' };
  if (!n.world || Math.abs(Math.abs(det3(n.world.R)) - 1) > 1e-6 || det3(n.world.R) < 0) return { path, error: '物体的变换不是刚体（缩放或镜像），暂不支持' };
  if (n.kind === 'mesh' || part && result.items.find((i) => i.path === n.path)?.geom?.type === 'mesh') return { path, error: '它是网格引用（几何已经精确），细化只针对用基本体近似的物体' };
  const F = FIDELITY[to] ?? FIDELITY.structure;
  const local = toLocal(part.tris, n.world);
  // 保住骨架：把物体现在的包络（在它自己的坐标系里）写成名义外包络 envelope，
  // 关系、锚点、定位点都按它算——拆成多少块，挂在它上面的物体都不动
  const env = envelopeOf(result, n, parts);
  const envTxt = env ? ` envelope=${[...env.min, ...env.max].map((x) => fmt(x, 4)).join(',')}` : '';
  const wrap = (body, how) => (n.types
    ? { path: n.path, target: n.types[0], kind: 'type', ...how, envelope: env, text: `def ${n.types[0]} : ${n.types[0]} {\n  drop body\n  group body${envTxt} {\n${body.map((l) => '    ' + l).join('\n')}\n  }\n}` }
    : { path: n.path, target: n.path, kind: 'object', ...how, envelope: env, text: `over ${n.path} : group${envTxt} {\n${body.map((l) => '  ' + l).join('\n')}\n}` });
  // 网格由多块组成（一层层阳台板、两柱一梁）：在物体自己的坐标系里对这些块跑一遍逆向——逐块拟合、找关系、找阵列与镜像
  const comps = splitComponents({ ...part, tris: local });
  if (comps.length > 1) {
    const out = reverseParts(comps.map((c) => ({ ...c, name: null })), { srcFile: 'refine', fidelity: to, types: false });
    setFidelity(to);
    const lines = out.src.split('\n').filter((l) => l.trim() && !/^(\/\/|material )/.test(l)).map((l) => l.replace(/ ~fit=\S+/, '').replace(/ ~src="[^"]*"/, ''));
    return wrap(lines, { parts: comps.length, boxes: out.objs.length, arrays: out.report.arrays.length });
  }
  setFidelity(to);
  // 在拟合坐标系里切体素：斜放的网格也能用少量盒子贴紧
  const fit = fitPart({ ...part, tris: local }, 0);
  const cols = fit.frame.cols;
  const inFrame = local.map((t) => t.map((p) => mvT(cols, p)));
  const res = voxelBoxes(inFrame, { voxel: Math.max(2 * F.tau, 1e-3), maxBoxes: to === 'detail' ? 120 : 40 });
  if (!res) return { path, error: '拆出来的盒子太多' };
  const digits = F.digits;
  const orient = orientText(cols);
  const lines = boxLines(res.boxes, digits).map((l) => {
    // 盒子在拟合坐标系里：位置换回物体坐标系，朝向写成拟合坐标系的朝向
    const m = / at=([-\d.]+),([-\d.]+),([-\d.]+)$/.exec(l);
    const atF = [+m[1], +m[2], +m[3]];
    const at = mvC(cols, atF);
    return l.replace(/ at=[^ ]+$/, ` at=${at.map((x) => fmt(x, digits)).join(',')}${orient ? ' ' + orient : ''}`);
  });
  // 单独一块、基本体又拟合得不好：用体素拆成盒子
  return wrap(lines, { parts: 1, boxes: res.boxes.length, voxel: res.voxel });
}
// 物体（及其内部各部件）现在的几何，在物体自己的坐标系里的包围盒
function envelopeOf(result, n, parts) {
  const items = result.items.filter((i) => i.path === n.path || i.path.startsWith(n.path + '.'));
  if (!items.length) return null;
  const objs = sceneObjects({ ...result, items }, { sourceParts: parts });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const { R, t } = n.world;
  for (const o of objs) for (let i = 0; i < o.pos.length; i += 3) {
    const d = [o.pos[i] - t[0], o.pos[i + 1] - t[1], o.pos[i + 2] - t[2]];
    for (let k = 0; k < 3; k++) { const v = R[0][k] * d[0] + R[1][k] * d[1] + R[2][k] * d[2]; lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); }
  }
  return Number.isFinite(lo[0]) ? { min: lo, max: hi } : null;
}
const det3 = (R) => R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
