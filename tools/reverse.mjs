// 逆向管线：GLB → SVG3D
//   1. 读取部件（L0/L1 按节点；L2 按连通分量拆开合并过的网格）
//   2. 拟合基本体：候选坐标系（直立 + 主成分）× 候选形状（盒、圆柱、圆台、球、楔形），按表面采样点的有符号距离误差选最优；
//      误差太大就保留为 mesh，直接引用源网格
//   3. 提取关系：先发射全坐标版本，编译得到空间事实；再自下而上为每个物体选一条主关系（on / against），
//      朝向写成相对参照物的
//   4. 校验：编译关系版本，逐个比对位置与朝向，不一致的退回坐标
import { NodeIO } from '@gltf-transform/core';
import { compile } from '../src/s3d.js';

// ───────── 小工具 ─────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scl(a, 1 / (len(a) || 1));
const mvT = (cols, v) => [dot(cols[0], v), dot(cols[1], v), dot(cols[2], v)]; // 世界 → 局部（列为局部轴）
const mvC = (cols, v) => add(add(scl(cols[0], v[0]), scl(cols[1], v[1])), scl(cols[2], v[2])); // 局部 → 世界
const Ry = (deg) => { const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a); return [[c, 0, -s], [0, 1, 0], [s, 0, c]]; }; // 列
const mulCols = (A, B) => B.map((b) => mvC(A, b)); // 两组列向量的复合
const fmt = (x) => { const v = Math.round(x * 10000) / 10000; return Object.is(v, -0) ? '0' : String(v); };
const vec = (v) => v.map(fmt).join(',');
const fmt6 = (x) => { const v = Math.round(x * 1e6) / 1e6; return Object.is(v, -0) ? '0' : String(v); };
const vec6 = (v) => v.map(fmt6).join(',');
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hex = (rgb) => '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, linearToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909) ^ (s += 0x9e3779b9)) >>> 0) / 4294967296; }

// ───────── 1. 读取部件 ─────────
export async function readParts(path, opts = {}) {
  return partsOfDocument(await new NodeIO().read(path), opts);
}
export function partsOfDocument(doc, { split = 'auto' } = {}) {
  const parts = [];
  for (const scene of doc.getRoot().listScenes()) scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const M = node.getWorldMatrix(); // 列主序
    const tf = (p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION').getArray(), idx = prim.getIndices()?.getArray();
      const tris = [];
      const vert = (i) => tf([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      const n = idx ? idx.length : pos.length / 3;
      for (let i = 0; i < n; i += 3) tris.push([vert(idx ? idx[i] : i), vert(idx ? idx[i + 1] : i + 1), vert(idx ? idx[i + 2] : i + 2)]);
      const mat = prim.getMaterial();
      const material = mat ? { name: mat.getName() || null, color: hex(mat.getBaseColorFactor().slice(0, 3)), metal: mat.getMetallicFactor(), rough: mat.getRoughnessFactor() } : { name: null, color: '#c9c9c9' };
      parts.push({ name: node.getName() || null, tris, material });
    }
  });
  const doSplit = split === 'components' || (split === 'auto' && parts.some((p) => /^merged_/.test(p.name ?? '')));
  return doSplit ? parts.flatMap(splitComponents) : parts;
}

// 按共享顶点（位置焊接）把三角形分成连通分量
function splitComponents(part) {
  const key = (p) => p.map((x) => Math.round(x * 1e4)).join(',');
  const parent = part.tris.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  part.tris.forEach((t, i) => t.forEach((v) => {
    const k = key(v);
    if (owner.has(k)) { const a = find(i), b = find(owner.get(k)); if (a !== b) parent[a] = b; } else owner.set(k, i);
  }));
  const groups = new Map();
  part.tris.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  return [...groups.values()].map((tris, k) => ({ name: null, tris, material: part.material, from: `${part.name}#${k}` }));
}

// ───────── 2. 拟合基本体 ─────────
function samplePoints(tris, n, seed) {
  const areas = tris.map(([a, b, c]) => len(cross(sub(b, a), sub(c, a))) / 2);
  const total = areas.reduce((s, x) => s + x, 0) || 1;
  const pts = [];
  const seen = new Set();
  for (const t of tris) for (const v of t) { const k = v.map((x) => x.toFixed(4)).join(); if (!seen.has(k)) { seen.add(k); pts.push(v); } }
  const r = rng(seed);
  const cum = [];
  areas.reduce((s, x, i) => (cum[i] = s + x), 0);
  for (let i = 0; i < n; i++) {
    const x = r() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    const [a, b, c] = tris[lo];
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    pts.push(add(a, add(scl(sub(b, a), u), scl(sub(c, a), v))));
  }
  return pts;
}

function hull2(pts) {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], q) <= 1e-12) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], q) <= 1e-12) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// 直立坐标系：竖直轴朝上，水平方向取俯视最小外接矩形的朝向（转角折算到 (-45°, 45°]）
function uprightFrame(pts) {
  const h = hull2(pts.map((p) => [p[0], p[2]]));
  let best = null;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const yaw = (Math.atan2(-(b[1] - a[1]), b[0] - a[0]) * 180) / Math.PI;
    const R = Ry(yaw);
    const xs = pts.map((p) => p[0] * R[0][0] + p[2] * R[0][2]), zs = pts.map((p) => p[0] * R[2][0] + p[2] * R[2][2]);
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
    if (!best || area < best.area - 1e-9) best = { area, yaw };
  }
  let yaw = best ? best.yaw : 0;
  yaw = ((((yaw + 45) % 90) + 90) % 90) - 45;
  if (Math.abs(yaw) < 1e-3 || Math.abs(Math.abs(yaw) - 45) < 1e-3 && false) yaw = 0;
  return frameFrom(pts, Ry(yaw), yaw);
}
// 主成分坐标系
function pcaFrame(pts) {
  const c = scl(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / pts.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
  // Jacobi 特征分解
  const A = C.map((r) => [...r]), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (Math.abs(A[i][j]) > Math.abs(A[p][q])) { p = i; q = j; }
    if (Math.abs(A[p][q]) < 1e-12) break;
    const th = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]), cs = Math.cos(th), sn = Math.sin(th);
    for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = cs * akp - sn * akq; A[k][q] = sn * akp + cs * akq; }
    for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = cs * apk - sn * aqk; A[q][k] = sn * apk + cs * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq; }
  }
  let axes = [0, 1, 2].map((j) => unit([V[0][j], V[1][j], V[2][j]]));
  // 让最接近竖直的轴作为局部 y，并保证右手系
  const yi = axes.reduce((b, a, i) => (Math.abs(a[1]) > Math.abs(axes[b][1]) ? i : b), 0);
  let ey = axes[yi]; if (ey[1] < 0) ey = scl(ey, -1);
  let ex = axes[(yi + 1) % 3];
  let ez = cross(ex, ey);
  ex = cross(ey, ez);
  return frameFrom(pts, [unit(ex), unit(ey), unit(ez)], null);
}
// 法线坐标系：按面积把三角形法线聚类（n 与 -n 视为同一方向），最大的平面方向作为第一根轴，
// 与它垂直的最大平面方向作为第二根轴。平面构成的人造部件由此得到精确的朝向（盒子的面、圆柱的端面）
function normalFrame(tris, pts) {
  const clusters = [];
  const items = tris.map(([a, b, c]) => { const n = cross(sub(b, a), sub(c, a)); return { n: unit(n), area: len(n) / 2 }; }).filter((t) => t.area > 1e-12);
  items.sort((x, y) => y.area - x.area);
  for (const t of items) {
    const cl = clusters.find((c) => Math.abs(dot(c.dir, t.n)) > 0.9995);
    if (cl) cl.area += t.area; else clusters.push({ dir: t.n, area: t.area });
  }
  if (!clusters.length) return null;
  clusters.sort((x, y) => y.area - x.area);
  const a1 = clusters[0].dir;
  const c2 = clusters.find((c) => Math.abs(dot(c.dir, a1)) < 0.02);
  let a2 = c2 ? c2.dir : unit(cross(a1, Math.abs(a1[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  a2 = unit(sub(a2, scl(a1, dot(a2, a1))));
  const axes = [a1, a2, cross(a1, a2)];
  const yi = axes.reduce((b, a, i) => (Math.abs(a[1]) > Math.abs(axes[b][1]) ? i : b), 0);
  let ey = axes[yi]; if (ey[1] < 0) ey = scl(ey, -1);
  // 竖直轴几乎朝上时直接取正上方，避免数值误差带来的微小倾斜
  if (ey[1] > 1 - 1e-9) ey = [0, 1, 0];
  let ex = axes[(yi + 1) % 3];
  ex = unit(sub(ex, scl(ey, dot(ex, ey))));
  const ez = cross(ex, ey);
  return frameFrom(pts, [ex, ey, unit(ez)], null);
}

function frameFrom(pts, cols, yaw) {
  const q = pts.map((p) => mvT(cols, p));
  const lo = [0, 1, 2].map((k) => Math.min(...q.map((x) => x[k]))), hi = [0, 1, 2].map((k) => Math.max(...q.map((x) => x[k])));
  return { cols, yaw, c: mvC(cols, scl(add(lo, hi), 0.5)), h: scl(sub(hi, lo), 0.5) };
}

// 有符号距离（局部坐标，中心在原点）
const sd2 = (dx, dy) => Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
const sdBox = (q, h) => { const d = [Math.abs(q[0]) - h[0], Math.abs(q[1]) - h[1], Math.abs(q[2]) - h[2]]; return len(d.map((x) => Math.max(x, 0))) + Math.min(Math.max(...d), 0); };
function sdFrustum(q, a, r0, r1, ha) {
  const [b, c] = [0, 1, 2].filter((k) => k !== a);
  const t = (q[a] + ha) / (2 * ha), r = r0 + (r1 - r0) * Math.max(0, Math.min(1, t));
  const k = Math.cos(Math.atan2(Math.abs(r0 - r1), 2 * ha));
  return sd2((Math.hypot(q[b], q[c]) - r) * k, Math.abs(q[a]) - ha);
}
function sdTri2(px, py, A, B, C) {
  const edge = (a, b) => { const ex = b[0] - a[0], ey = b[1] - a[1], wx = px - a[0], wy = py - a[1]; const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey))); return [wx - ex * t, wy - ey * t, ex * wy - ey * wx]; };
  const es = [edge(A, B), edge(B, C), edge(C, A)];
  const d = Math.min(...es.map(([x, y]) => x * x + y * y));
  const s = Math.sign((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
  const inside = es.every(([, , cr]) => cr * s >= 0);
  return (inside ? -1 : 1) * Math.sqrt(d);
}

// 封闭网格的体积（散度定理）；不封闭时返回 null，不做体积校验
function meshVolume(tris) {
  const key = (p) => p.map((x) => Math.round(x * 1e4)).join(',');
  const edges = new Map();
  for (const t of tris) for (let i = 0; i < 3; i++) {
    const a = key(t[i]), b = key(t[(i + 1) % 3]);
    if (a === b) continue;
    const k = a < b ? a + '|' + b : b + '|' + a;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  }
  if ([...edges.values()].some((c) => c % 2)) return null;
  return Math.abs(tris.reduce((s, [a, b, c]) => s + dot(a, cross(b, c)), 0) / 6);
}

// 在一个坐标系里尝试各种形状，返回误差最小的。
// 误差 = 表面采样点到候选表面的平均距离（按最薄方向归一化）；
// 再用体积校验排除“比实物大很多”的候选（例如把弯曲的薄路面套进一个大盒子）
function fitInFrame(F, pts, vol = null) {
  const q = pts.map((p) => mvT(F.cols, sub(p, F.c)));
  // 误差按最薄的那个方向归一化：薄板、细杆的偏差要和它的厚度比，而不是和长度比
  const h = F.h, scale = Math.max(Math.min(...h), 0.02 * Math.max(...h), 1e-6);
  const err = (sd) => q.reduce((s, x) => s + Math.abs(sd(x)), 0) / q.length / scale;
  const cands = [];
  const push = (c, V) => {
    if (vol && V > 0) { const d = Math.abs(vol / V - 1); if (d > 0.08) c.e = Math.max(c.e, d); }
    cands.push(c);
  };
  push({ shape: 'box', e: err((x) => sdBox(x, h)) }, 8 * h[0] * h[1] * h[2]);
  for (let a = 0; a < 3; a++) {
    const [b, c] = [0, 1, 2].filter((k) => k !== a);
    if (Math.abs(h[b] - h[c]) > 0.08 * Math.max(h[b], h[c])) continue;
    // 半径取侧面点到轴的距离的中位数（比包围盒稳健，不受轴略微倾斜与多边形近似影响）
    const radial = (x) => Math.hypot(x[b], x[c]);
    const side = q.filter((x) => Math.abs(x[a]) < 0.8 * h[a]).map(radial).sort((u, v) => u - v);
    const r = side.length ? side[Math.floor(side.length * 0.75)] : (h[b] + h[c]) / 2;
    push({ shape: 'cyl', axis: a, r0: r, r1: r, e: err((x) => sdFrustum(x, a, r, r, h[a])) }, Math.PI * r * r * 2 * h[a]);
    // 圆台：两端的最大半径
    const near = (s) => q.filter((x) => Math.abs(x[a] - s * h[a]) < 0.02 * h[a] + 1e-6).map(radial);
    const r0 = Math.max(0, ...near(-1)), r1 = Math.max(0, ...near(1));
    if (Math.abs(r0 - r1) > 0.05 * r) push({ shape: 'cone', axis: a, r0, r1, e: err((x) => sdFrustum(x, a, r0, r1, h[a])) }, (Math.PI * 2 * h[a] / 3) * (r0 * r0 + r0 * r1 + r1 * r1));
  }
  if (Math.max(...h) - Math.min(...h) < 0.08 * Math.max(...h)) { const r = (h[0] + h[1] + h[2]) / 3; push({ shape: 'sphere', r, e: err((x) => len(x) - r) }, (4 / 3) * Math.PI * r ** 3); }
  // 楔形：坡沿局部 x 或 z，高的一侧在正或负方向（只在竖直轴朝上时）
  if (F.cols[1][1] > 0.999) for (const [s, sign] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
    const hs = h[s], hy = h[1], o = s === 0 ? 2 : 0;
    const A = [-hs * sign, -hy], B = [hs * sign, -hy], C = [hs * sign, hy];
    push({ shape: 'wedge', slope: s, sign, e: err((x) => sd2(sdTri2(x[s], x[1], A, B, C), Math.abs(x[o]) - h[o])) }, 4 * hs * hy * h[o]);
  }
  cands.sort((x, y) => x.e - y.e);
  return { ...cands[0], frame: F };
}

export function fitPart(part, i) {
  const pts = samplePoints(part.tris, 600, i + 1);
  const vol = meshVolume(part.tris);
  const frames = [uprightFrame(pts), pcaFrame(pts), normalFrame(part.tris, pts)].filter(Boolean);
  const fits = frames.map((F) => fitInFrame(F, pts, vol));
  fits.sort((a, b) => a.e - b.e);
  const best = fits[0];
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  return { ...best, aabb: { min: lo, max: hi } };
}

// ───────── 发射：每个物体的原语、自身包围盒与世界朝向 ─────────
const TOL = 0.02; // 相对误差阈值，超过就保留为 mesh
const sanitize = (s) => { let t = String(s).replace(/[^\p{L}\p{N}_]/gu, '_'); if (!/^[\p{L}_]/u.test(t)) t = 'p_' + t; return t; };

function primitiveOf(fit, part, srcFile) {
  const fitScore = Math.max(0, Math.min(1, 1 - fit.e / TOL));
  const F = fit.frame, h = F.h, [ex, ey, ez] = F.cols;
  if (fit.e > TOL && part.name) {
    // 拟合不了：引用源网格。外包络是世界包围盒，原点在其底面中心
    // （从合并网格里拆出来的部件在源文件里没有节点可引用，只能用最接近的基本体，并如实给出低拟合度）
    const { min, max } = fit.aabb;
    const pivot = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
    const size = sub(max, min);
    return { kind: 'mesh', props: { src: JSON.stringify(`${srcFile}#${part.name ?? part.from}`), size: vec(size), pivot: vec(pivot) }, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: pivot,
      box: { min: [-size[0] / 2, 0, -size[2] / 2], max: [size[0] / 2, size[1], size[2] / 2] }, fit: fitScore, err: fit.e };
  }
  const base = { fit: fitScore, err: fit.e };
  if (fit.shape === 'box') return { ...base, kind: 'box', props: { size: vec(scl(h, 2)) }, cols: F.cols, at: sub(F.c, scl(ey, h[1])), box: { min: [-h[0], 0, -h[2]], max: [h[0], 2 * h[1], h[2]] } };
  if (fit.shape === 'sphere') return { ...base, kind: 'sphere', props: { r: fmt(fit.r) }, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: sub(F.c, [0, fit.r, 0]), box: { min: [-fit.r, 0, -fit.r], max: [fit.r, 2 * fit.r, fit.r] } };
  if (fit.shape === 'cyl' || fit.shape === 'cone') {
    const a = fit.axis, R = Math.max(fit.r0, fit.r1), H = 2 * h[a];
    const props = fit.shape === 'cyl' ? { r: fmt(fit.r0), h: fmt(H) } : { r: fmt(fit.r0), r2: fmt(fit.r1), h: fmt(H) };
    if (a === 1) return { ...base, kind: fit.shape, props, cols: F.cols, at: sub(F.c, scl(ey, h[1])), box: { min: [-R, 0, -R], max: [R, H, R] } };
    // 轴是水平的（局部 x 或 z）：用 axis=x，并把局部 x 转到这条轴上
    const axisDir = a === 0 ? ex : ez;
    const cols = a === 0 ? F.cols : [ez, ey, scl(ex, -1)];
    return { ...base, kind: fit.shape, props: { ...props, axis: 'x' }, cols, at: sub(F.c, scl(ey, R)), box: { min: [-H / 2, 0, -R], max: [H / 2, 2 * R, R] }, axisDir };
  }
  // 楔形：本语言里的楔形高的一侧在 +x
  const { slope, sign } = fit;
  let cols = F.cols;
  if (slope === 0 && sign < 0) cols = mulCols(F.cols, Ry(180));
  if (slope === 2 && sign > 0) cols = mulCols(F.cols, Ry(-90));
  if (slope === 2 && sign < 0) cols = mulCols(F.cols, Ry(90));
  const w = 2 * h[slope], d = 2 * h[slope === 0 ? 2 : 0];
  return { ...base, kind: 'wedge', props: { size: vec([w, 2 * h[1], d]) }, cols, at: sub(F.c, scl(ey, h[1])), box: { min: [-w / 2, 0, -d / 2], max: [w / 2, 2 * h[1], d / 2] } };
}

// 朝向（列为局部轴）→ turn / rot 文本；R 是 3×3（行主序），由列构造
const toRows = (cols) => [0, 1, 2].map((i) => cols.map((c) => c[i]));
function orientText(cols) {
  const R = toRows(cols);
  if (Math.abs(R[1][1] - 1) < 1e-6) {
    const yaw = (Math.atan2(R[0][2], R[0][0]) * 180) / Math.PI;
    return Math.abs(yaw) < 1e-4 ? '' : `turn=${fmt(yaw)}`;
  }
  const tr = R[0][0] + R[1][1] + R[2][2];
  const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  let axis;
  if (Math.abs(Math.sin(ang)) > 1e-6) axis = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
  else { const i = [0, 1, 2].reduce((b, k) => (R[k][k] > R[b][b] ? k : b), 0); axis = [0, 1, 2].map((k) => R[k][i] + (k === i ? 1 : 0)); }
  return `rot=(${vec(unit(axis))},${fmt((ang * 180) / Math.PI)})`;
}
const relCols = (B, A) => A.map((a) => mvT(B, a)); // A 的轴在 B 坐标系里的表示

// ───────── 3 & 4. 关系与校验 ─────────
export function reverse(parts, { srcFile = 'source.glb', level = 'L0' } = {}) {
  const fits = parts.map((p, i) => fitPart(p, i));
  // 名字：L0 用源节点名；没有名字时按形状编号
  const used = new Map(), counters = {};
  const objs = parts.map((p, i) => {
    const prim = primitiveOf(fits[i], p, srcFile);
    let id = p.name && !/^part_\d+$|^merged_/.test(p.name) ? sanitize(p.name) : `${prim.kind}${(counters[prim.kind] = (counters[prim.kind] ?? 0) + 1)}`;
    if (used.has(id)) { const n = used.get(id) + 1; used.set(id, n); id = `${id}_${n}`; } else used.set(id, 1);
    const vol = (prim.box.max[0] - prim.box.min[0]) * (prim.box.max[1] - prim.box.min[1]) * (prim.box.max[2] - prim.box.min[2]);
    const symY = prim.kind === 'sphere' || (['cyl', 'cone'].includes(prim.kind) && !prim.props.axis);
    if (symY && Math.abs(prim.cols[1][1] - 1) < 1e-6) prim.cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return { id, src: p.name ?? p.from ?? null, material: p.material, ...prim, vol, symY };
  });
  // 材质
  const mats = new Map();
  for (const o of objs) {
    const k = JSON.stringify(o.material);
    if (!mats.has(k)) {
      let name = sanitize(o.material.name ?? `m_${o.material.color.slice(1)}`);
      while ([...mats.values()].some((m) => m.name === name)) name += '_';
      mats.set(k, { name, ...o.material });
    }
    o.mat = mats.get(k).name;
  }
  const header = [`// 由逆向管线从 ${srcFile} 生成（${level}）。~fit 是拟合度，~err 是相对误差；mesh 是拟合不了、直接引用源网格的部件`, ''];
  for (const m of mats.values()) header.push(`material ${m.name} color=${m.color}${m.metal != null ? ` metal=${fmt(m.metal)}` : ''}${m.rough != null ? ` rough=${fmt(m.rough)}` : ''}`);
  header.push('');
  const line = (o, place, orient) => {
    const props = Object.entries(o.props).map(([k, v]) => `${k}=${v}`).join(' ');
    return [o.kind, o.id, props, place, orient, `mat=${o.mat}`, `~fit=${fmt(o.fit)}`, o.src ? `~src=${JSON.stringify(o.src)}` : ''].filter(Boolean).join(' ');
  };
  const absLine = (o) => line(o, `at=${vec(o.at)}`, orientText(o.cols));
  const absSrc = header.concat(objs.map(absLine)).join('\n');

  // 空间事实（全坐标版本）
  const r0 = compile(absSrc);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const onOf = new Map(), againstOf = new Map(), nearOf = new Map();
  for (const f of r0.facts) {
    if (['intersects', 'touching', 'inside'].includes(f.rel)) for (const [x, y] of [[f.a, f.b], [f.b, f.a]]) { if (!nearOf.has(x)) nearOf.set(x, []); nearOf.get(x).push(y); }
    if (f.rel === 'on') { if (!onOf.has(f.a)) onOf.set(f.a, []); onOf.get(f.a).push(f.b); }
    if (f.rel === 'against') { const face = f.text.split('.').pop(); if (!againstOf.has(f.a)) againstOf.set(f.a, []); againstOf.get(f.a).push({ b: f.b, face }); }
  }
  // 自下而上：先放低的、大的
  const order = [...objs].sort((a, b) => a.at[1] - b.at[1] || b.vol - a.vol);
  const placed = new Set(), choice = new Map();
  const toB = (B, p) => mvT(B.cols, sub(p, B.at)); // 世界点 → B 自身坐标
  const norm = (B, pB) => [0, 1, 2].map((k) => { const c = (B.box.min[k] + B.box.max[k]) / 2, hh = (B.box.max[k] - B.box.min[k]) / 2; return hh > 1e-9 ? (pB[k] - c) / hh : 0; });
  const anchor = (B, uvw) => (uvw.every((x) => Math.abs(x) < 1e-6) ? B.id : `${B.id}[${vec6(uvw)}]`);
  const FACE = { left: [-1, 0, 0], right: [1, 0, 0], back: [0, 0, -1], front: [0, 0, 1] };
  for (const A of order) {
    const sup = (onOf.get(A.id) ?? []).map((id) => byId.get(id)).filter((B) => B && placed.has(B.id)).sort((x, y) => y.vol - x.vol)[0];
    if (sup) {
      const uvw = norm(sup, toB(sup, A.at));
      const plain = Math.abs(uvw[0]) < 1e-6 && Math.abs(uvw[2]) < 1e-6;
      choice.set(A.id, { place: plain ? `on=${sup.id}` : `on=${sup.id}[${vec6([uvw[0], 1, uvw[2]])}]`, ref: sup, kind: 'on' });
    } else {
      const ag = (againstOf.get(A.id) ?? []).map((x) => ({ ...x, B: byId.get(x.b) })).filter((x) => x.B && placed.has(x.B.id)).sort((x, y) => y.B.vol - x.B.vol)[0];
      if (ag) {
        const B = ag.B, nB = mvC(B.cols, FACE[ag.face]);
        // A 上朝向 B 的那个面的中心
        let bestF = null, bestS = Infinity;
        for (const [k, d] of Object.entries({ ...FACE, top: [0, 1, 0], bottom: [0, -1, 0] })) { const s = dot(mvC(A.cols, d), nB); if (s < bestS) { bestS = s; bestF = d; } }
        const cA = [0, 1, 2].map((k) => (A.box.min[k] + A.box.max[k]) / 2 + bestF[k] * (A.box.max[k] - A.box.min[k]) / 2);
        const uvw = norm(B, toB(B, add(A.at, mvC(A.cols, cA))));
        FACE[ag.face].forEach((v, k) => { if (v) uvw[k] = v; });
        choice.set(A.id, { place: `against=${B.id}[${vec6(uvw)}]`, ref: B, kind: 'against' });
      } else {
        // 没有支撑和贴面，但与已放好的物体相交、接触或在其内部：用相对它的锚点定位（它动，这个也跟着动）
        const near = (nearOf.get(A.id) ?? []).map((id) => byId.get(id)).filter((B) => B && placed.has(B.id)).sort((x, y) => y.vol - x.vol)[0];
        if (near) choice.set(A.id, { place: `at=${near.id}[${vec6(norm(near, toB(near, A.at)))}]`, ref: null, kind: 'at' });
      }
    }
    placed.add(A.id);
  }
  const relLine = (o) => {
    const c = choice.get(o.id);
    if (!c) return absLine(o);
    if (!c.ref) return line(o, c.place, orientText(o.cols)); // at=锚点：不继承朝向
    // 绕自身竖直轴旋转对称的形状（竖直圆柱、圆台、球）：与参照物同向即可
    if (o.symY && Math.abs(dot(o.cols[1], c.ref.cols[1]) - 1) < 1e-6) { o.cols = c.ref.cols; return line(o, c.place, ''); }
    return line(o, c.place, orientText(relCols(c.ref.cols, o.cols)));
  };
  // 校验：关系版本的每个物体必须与目标位姿一致；不一致的退回坐标
  let fallback = new Set();
  let relSrc;
  for (let round = 0; round < 4; round++) {
    relSrc = header.concat(order.map((o) => (fallback.has(o.id) ? absLine(o) : relLine(o)))).join('\n');
    const r1 = compile(relSrc);
    const bad = [];
    for (const o of objs) {
      if (fallback.has(o.id) || !choice.has(o.id)) continue;
      const n = r1.nodes.find((x) => x.path === o.id);
      const tol = ['on', 'against'].includes(choice.get(o.id).kind) ? 0.025 : 2e-3;
      const ok = n && n.world && len(sub(n.world.t, o.at)) < tol && toRows(o.cols).every((row, i) => row.every((v, j) => Math.abs(v - n.world.R[i][j]) < 2e-3));
      if (!ok) bad.push(o.id);
    }
    if (!bad.length && !r1.errors.length) break;
    bad.forEach((id) => fallback.add(id));
    if (!bad.length && r1.errors.length) { for (const o of objs) fallback.add(o.id); }
  }
  const rel = objs.filter((o) => choice.has(o.id) && !fallback.has(o.id));
  const report = {
    source: srcFile, level, parts: parts.length,
    kinds: Object.fromEntries(Object.entries(objs.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {})).sort()),
    byRelation: Object.fromEntries(['on', 'against', 'at'].map((k) => [k, rel.filter((o) => choice.get(o.id).kind === k).length])),
    coordinate: objs.length - rel.length,
    coordinateRatio: +((objs.length - rel.length) / objs.length).toFixed(3),
    meanFit: +(objs.reduce((s, o) => s + o.fit, 0) / objs.length).toFixed(3),
    fallbackAfterValidation: fallback.size,
  };
  return { src: relSrc + '\n', absSrc, report, objs };
}

// 调试用：两个候选坐标系各自的最优拟合
export function _debugFits(part, i) {
  const pts = samplePoints(part.tris, 600, i + 1);
  const vol = meshVolume(part.tris);
  return [uprightFrame(pts), pcaFrame(pts), normalFrame(part.tris, pts)].filter(Boolean).map((F) => ({ F, fit: fitInFrame(F, pts, vol) }));
}
