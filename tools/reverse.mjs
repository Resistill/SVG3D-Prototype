// 逆向管线：GLB → SVG3D
//   1. 读取部件（L0/L1 按节点；L2 按连通分量拆开合并过的网格）
//   2. 拟合基本体：候选坐标系（直立 + 主成分）× 候选形状（盒、圆柱、圆台、球、楔形），按表面采样点的有符号距离误差选最优；
//      误差太大就保留为 mesh，直接引用源网格
//   3. 提取关系：先发射全坐标版本，编译得到空间事实；再自下而上为每个物体选一条主关系（on / against），
//      朝向写成相对参照物的
//   4. 校验：编译关系版本，逐个比对位置与朝向，不一致的退回坐标
import { semanticNames } from './naming.mjs';
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
// 定长格式化，并把 -0 归为 0（否则 “-0.000” 与 “0.000” 会被当成不同的键）
const fx = (x, d = 3) => (Math.round(x * 10 ** d) / 10 ** d + 0).toFixed(d);
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
function fitInFrame(F, pts, vol = null, verts = []) {
  const q = pts.map((p) => mvT(F.cols, sub(p, F.c)));
  const vq = verts.map((p) => mvT(F.cols, sub(p, F.c)));
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
    // 正多边形近似的圆柱，侧面顶点恰好在半径 r 上：取顶点的最大径向距离
    const vr = vq.map(radial).filter((x) => x > 0.5 * (h[b] + h[c]) / 2);
    const side = q.filter((x) => Math.abs(x[a]) < 0.8 * h[a]).map(radial).sort((u, v) => u - v);
    const r = vr.length ? Math.max(...vr) : side.length ? side[Math.floor(side.length * 0.75)] : (h[b] + h[c]) / 2;
    push({ shape: 'cyl', axis: a, r0: r, r1: r, e: err((x) => sdFrustum(x, a, r, r, h[a])) }, Math.PI * r * r * 2 * h[a]);
    // 圆台：两端的最大半径
    const near = (s) => q.filter((x) => Math.abs(x[a] - s * h[a]) < 0.02 * h[a] + 1e-6).map(radial);
    const r0 = Math.max(0, ...near(-1)), r1 = Math.max(0, ...near(1));
    if (Math.abs(r0 - r1) > 0.05 * r) push({ shape: 'cone', axis: a, r0, r1, e: err((x) => sdFrustum(x, a, r0, r1, h[a])) }, (Math.PI * 2 * h[a] / 3) * (r0 * r0 + r0 * r1 + r1 * r1));
  }
  if (Math.max(...h) - Math.min(...h) < 0.08 * Math.max(...h)) {
    // 球：顶点到顶点质心的平均距离（顶点都在球面上）
    const vc = vq.length ? scl(vq.reduce((s2, v) => add(s2, v), [0, 0, 0]), 1 / vq.length) : [0, 0, 0];
    const r = vq.length ? vq.reduce((s2, v) => s2 + len(sub(v, vc)), 0) / vq.length : (h[0] + h[1] + h[2]) / 3;
    push({ shape: 'sphere', r, e: err((x) => len(sub(x, vc)) - r) }, (4 / 3) * Math.PI * r ** 3);
  }
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
  const vmap = new Map();
  for (const t of part.tris) for (const v of t) vmap.set(v.map((x) => x.toFixed(5)).join(), v);
  const verts = [...vmap.values()];
  const frames = [uprightFrame(pts), pcaFrame(pts), normalFrame(part.tris, pts)].filter(Boolean);
  const fits = frames.map((F) => fitInFrame(F, pts, vol, verts));
  fits.sort((a, b) => a.e - b.e);
  const best = fits[0];
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  const uniq = new Map();
  for (const t of part.tris) for (const v of t) uniq.set(v.map((x) => x.toFixed(5)).join(), v);
  const vc = scl([...uniq.values()].reduce((s, v) => add(s, v), [0, 0, 0]), 1 / Math.max(1, uniq.size));
  return { ...best, aabb: { min: lo, max: hi }, vc };
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
  if (fit.shape === 'box') {
    // 规范表示：水平方向较长的边沿局部 x（盒子转 90° 等于宽深互换，不规范化的话同样的盒子会被当成不同的形状）
    let hh = h, cols = F.cols;
    if (Math.abs(cols[1][1] - 1) < 1e-9) {
      // 直立的盒子：每转 90° 宽深互换，先把转角规范到 (−45°, 45°]（不同坐标系给出的同一个盒子才一致）
      for (let i = 0; i < 4; i++) {
        const yaw = (Math.atan2(-cols[0][2], cols[0][0]) * 180) / Math.PI;
        if (yaw > 45 + 1e-6) { cols = [cols[2], cols[1], scl(cols[0], -1)]; hh = [hh[2], hh[1], hh[0]]; }
        else if (yaw <= -45 + 1e-6) { cols = [scl(cols[2], -1), cols[1], cols[0]]; hh = [hh[2], hh[1], hh[0]]; }
        else break;
      }
    }
    if (Math.abs(cols[1][1] - 1) >= 1e-9) {
      // 不直立的盒子：局部 y 取最长边、x 取次长边（同一个盒子转到任何方向都得到同样的表示）
      const ord = [0, 1, 2].sort((p2, q2) => hh[q2] - hh[p2]);
      const ny = cols[ord[0]], nx = cols[ord[1]];
      cols = [nx, ny, cross(nx, ny)];
      hh = [hh[ord[1]], hh[ord[0]], hh[ord[2]]];
    } else if (hh[2] > hh[0] + 1e-6) { hh = [hh[2], hh[1], hh[0]]; cols = [cols[2], cols[1], scl(cols[0], -1)]; }
    return { ...base, kind: 'box', props: { size: vec(scl(hh, 2)) }, cols, at: sub(F.c, scl(cols[1], hh[1])), box: { min: [-hh[0], 0, -hh[2]], max: [hh[0], 2 * hh[1], hh[2]] }, sym180: true };
  }
  if (fit.shape === 'sphere') return { ...base, kind: 'sphere', props: { r: fmt(fit.r) }, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: sub(fit.vc, [0, fit.r, 0]), box: { min: [-fit.r, 0, -fit.r], max: [fit.r, 2 * fit.r, fit.r] } };
  if (fit.shape === 'cyl' || fit.shape === 'cone') {
    const a = fit.axis, R = Math.max(fit.r0, fit.r1), H = 2 * h[a];
    const props = fit.shape === 'cyl' ? { r: fmt(fit.r0), h: fmt(H) } : { r: fmt(fit.r0), r2: fmt(fit.r1), h: fmt(H) };
    // 绕自身轴旋转对称：轴向中心取包围范围的中点，横向中心取顶点质心；绕轴的转角取规范值
    const d = F.cols[a];
    const c = add(F.c, sub(sub(fit.vc, F.c), scl(d, dot(sub(fit.vc, F.c), d))));
    const perp = (v, alt) => { const w = sub(v, scl(d, dot(v, d))); return len(w) > 1e-6 ? unit(w) : unit(sub(alt, scl(d, dot(alt, d)))); };
    if (Math.abs(d[1]) > 0.999) {
      const dy = d[1] < 0 ? scl(d, -1) : d;
      const cx = perp([1, 0, 0], [0, 0, 1]), cols = [cx, dy, cross(cx, dy)];
      return { ...base, kind: fit.shape, props, cols, at: sub(c, scl(dy, H / 2)), box: { min: [-R, 0, -R], max: [R, H, R] } };
    }
    // 轴不竖直：用 axis=x，局部 x 沿轴，局部 y 尽量朝上
    const cy = perp([0, 1, 0], [0, 0, 1]), cols = [d, cy, cross(d, cy)];
    return { ...base, kind: fit.shape, props: { ...props, axis: 'x' }, cols, at: sub(c, scl(cy, R)), box: { min: [-H / 2, 0, -R], max: [H / 2, 2 * R, R] }, axisSym: true, sym180: fit.shape === 'cyl' };
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
  // 方向用 6 位小数：长物体或远离支点的成员，方向的微小误差会被放大成毫米级的位置误差
  return `rot=(${vec6(unit(axis))},${fmt6((ang * 180) / Math.PI)})`;
}
const relCols = (B, A) => A.map((a) => mvT(B, a)); // A 的轴在 B 坐标系里的表示
const det3c = (c) => dot(c[0], cross(c[1], c[2]));
const reflectDirN = (v, n) => sub(v, scl(n, 2 * dot(v, n)));
// 旋转矩阵（行主序）→ 轴与角（度），角取 (0, 180]
function axisAngleOf(Rm) {
  const tr = Rm[0][0] + Rm[1][1] + Rm[2][2];
  const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  if (ang < 1e-6) return null;
  let u;
  if (Math.abs(Math.sin(ang)) > 1e-6) u = unit([Rm[2][1] - Rm[1][2], Rm[0][2] - Rm[2][0], Rm[1][0] - Rm[0][1]]);
  else { const i = [0, 1, 2].reduce((b, k) => (Rm[k][k] > Rm[b][b] ? k : b), 0); u = unit([0, 1, 2].map((k) => Rm[k][i] + (k === i ? 1 : 0))); }
  return { u, deg: (ang * 180) / Math.PI };
}
// 绕过点 c、方向 u 的轴转 deg 度（右手）
function rotAbout(u, deg, c, p) {
  const a = (deg * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a), v = sub(p, c);
  return add(c, add(add(scl(v, co), scl(cross(u, v), si)), scl(u, dot(u, v) * (1 - co))));
}

// ───────── 3 & 4. 关系与校验 ─────────
export function reverse(parts, { srcFile = 'source.glb', level = 'L0', compress = true, names = true, previous = null } = {}) {
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
  const related = new Map();
  const link = (m, x, y) => { if (!m.has(x)) m.set(x, []); m.get(x).push(y); };
  for (const f of r0.facts) {
    link(related, f.a, f.b); link(related, f.b, f.a);
    if (['intersects', 'touching', 'inside'].includes(f.rel)) { link(nearOf, f.a, f.b); link(nearOf, f.b, f.a); }
    if (f.rel === 'on') link(onOf, f.a, f.b);
    if (f.rel === 'against') link(againstOf, f.a, { b: f.b, face: f.text.split('.').pop() });
  }

  // ── 压缩：阵列（平移 / 绕竖直轴旋转 / 螺旋）──
  const units = compress ? detectArrays(objs, related) : [];
  const unitOf = new Map(); // 物体 id → { unit, child, k }
  for (const u of units) u.children.forEach((c, ci) => c.members.forEach((o, k) => unitOf.set(o.id, { unit: u, child: c, k: instOf(u, k) })));
  // 镜像：成对的物体或阵列关于同一个竖直平面对称 → 一个写出来，另一个是它的镜像副本
  const mirrors = compress ? detectMirrors(objs, units, unitOf) : [];
  const ghostPath = new Map(); // 被镜像出来的物体 id → 它在副本里的路径
  for (const mi of mirrors) for (const [bid, path] of mi.paths) ghostPath.set(bid, path);
  const pathOf = (o) => {
    if (ghostPath.has(o.id)) return ghostPath.get(o.id);
    const m = unitOf.get(o.id);
    if (!m) return o.id;
    if (m.unit.rotate) return m.k === 0 ? `${m.unit.id}.${m.child.id}` : `${m.unit.id}.r${m.k}.${m.child.id}`;
    return `${m.unit.id}.${m.k}.${m.child.id}`;
  };
  const mirroredEntity = new Set(mirrors.map((mi) => mi.B.id));

  // ── 关系选择 ──
  const toB = (B, p) => mvT(B.cols, sub(p, B.at)); // 世界点 → B 自身坐标
  const norm = (B, pB) => [0, 1, 2].map((k) => { const c = (B.box.min[k] + B.box.max[k]) / 2, hh = (B.box.max[k] - B.box.min[k]) / 2; return hh > 1e-9 ? (pB[k] - c) / hh : 0; });
  const FACE = { left: [-1, 0, 0], right: [1, 0, 0], back: [0, 0, -1], front: [0, 0, 1] };
  // 为“一个位于点 p、朝向 cols 的东西”选一条主关系；cand 过滤可用的参照物；name 给出参照物的路径
  // 参照物的位姿要用它“发射出来”的那一个：阵列副本、镜像副本的局部坐标系由第 0 个成员变换而来，
  // 对旋转对称的形状来说，这和拟合时规范选出的坐标系不一样（几何相同，坐标系不同）
  let E = new Map();
  const poseOf = (B) => { const e = E.get(B.id); return e ? { ...B, ...e } : B; };
  const chooseFor = (A, p, cand, name0) => {
    const name = (B) => name0(B);
    const sup0 = (onOf.get(A.id) ?? []).map((id) => byId.get(id)).filter(cand).sort((x, y) => y.vol - x.vol)[0];
    const sup = sup0 && poseOf(sup0);
    if (sup) {
      const uvw = norm(sup, toB(sup, p));
      const plain = Math.abs(uvw[0]) < 1e-6 && Math.abs(uvw[2]) < 1e-6;
      return { place: plain ? `on=${name(sup)}` : `on=${name(sup)}[${vec6([uvw[0], 1, uvw[2]])}]`, ref: sup, kind: 'on' };
    }
    const ag = (againstOf.get(A.id) ?? []).map((x) => ({ ...x, B: byId.get(x.b) })).filter((x) => x.B && cand(x.B)).sort((x, y) => y.B.vol - x.B.vol)[0];
    if (ag && p === A.at && det3c(poseOf(ag.B).cols) > 0) {
      const B = poseOf(ag.B), nB = mvC(B.cols, FACE[ag.face]);
      let bestF = null, bestS = Infinity;
      for (const d of Object.values({ ...FACE, top: [0, 1, 0], bottom: [0, -1, 0] })) { const s2 = dot(mvC(A.cols, d), nB); if (s2 < bestS) { bestS = s2; bestF = d; } }
      const cA = [0, 1, 2].map((k) => (A.box.min[k] + A.box.max[k]) / 2 + bestF[k] * (A.box.max[k] - A.box.min[k]) / 2);
      const uvw = norm(B, toB(B, add(A.at, mvC(A.cols, cA))));
      FACE[ag.face].forEach((v, k) => { if (v) uvw[k] = v; });
      return { place: `against=${name(B)}[${vec6(uvw)}]`, ref: B, kind: 'against' };
    }
    const near0 = (nearOf.get(A.id) ?? []).map((id) => byId.get(id)).filter(cand).sort((x, y) => y.vol - x.vol)[0];
    if (near0) { const near = poseOf(near0); return { place: `at=${name(near)}[${vec6(norm(near, toB(near, p)))}]`, ref: null, kind: 'at' }; }
    return null;
  };
  const orientRel = (o, ref0, cols = o.cols) => {
    if (!ref0) return orientText(cols);
    const ref = det3c(ref0.cols) < 0 ? { ...ref0, cols: [scl(ref0.cols[0], -1), ref0.cols[1], ref0.cols[2]] } : ref0;
    if (o.symY && Math.abs(dot(cols[1], ref.cols[1]) - 1) < 1e-6) return '';
    return orientText(relCols(ref.cols, cols));
  };

  // 可放置的单元：普通物体与阵列；自下而上放
  const plainObjs = objs.filter((o) => !unitOf.has(o.id) && !mirroredEntity.has(o.id));
  const bottomOf = (x) => (x.children ? Math.min(...x.children.flatMap((c) => c.members.map((o) => o.at[1]))) : x.at[1]);
  const volOf = (x) => (x.children ? x.children.reduce((s, c) => s + c.members.reduce((t, o) => t + o.vol, 0), 0) : x.vol);
  const order = [...plainObjs, ...units.filter((u) => !mirroredEntity.has(u.id))].sort((a, b) => bottomOf(a) - bottomOf(b) || volOf(b) - volOf(a));
  const mirrorOf = new Map(mirrors.map((mi) => [mi.A.id, mi]));

  const emit = (dissolved, fallback) => {
    const placed = new Set(), lines = [], targets = [], stats = { on: 0, against: 0, at: 0, coord: 0 };
    E = new Map();
    // 位姿：以几何中心为准，坐标系由来源决定
    const setPose = (o, cols, box = o.box) => E.set(o.id, { cols, box, at: sub(centerOf(o), mvC(cols, scl(add(box.min, box.max), 0.5))) });
    const isPlaced = (B) => B && placed.has(B.id);
    const nameOf = (B) => pathOf(B);
    const plainLine = (o) => {
      setPose(o, o.cols);
      const c = fallback.has(o.id) ? null : chooseFor(o, o.at, isPlaced, nameOf);
      if (c) stats[c.kind]++; else stats.coord++;
      targets.push({ o, path: o.id, tol: c && c.kind !== 'at' ? 0.025 : 2e-3, kind: c?.kind ?? 'coord' });
      return c ? line(o, c.place, orientRel(o, c.ref)) : absLine(o);
    };
    const emitMirror = (x) => {
      const mi = mirrorOf.get(x.id);
      if (!mi || droppedMirrors.has(mi.B.id)) return;
      lines.push(`mirror ${mi.B.id} of=${x.id} across=${mi.across}`);
      for (const [bid, path] of mi.paths) {
        placed.add(bid); targets.push({ o: byId.get(bid), path, tol: 2e-3, mirror: mi.B.id, kind: 'mirror' });
        const src = byId.get(mi.srcOf.get(bid)), es = E.get(src.id) ?? { cols: src.cols, box: src.box };
        setPose(byId.get(bid), es.cols.map((c) => reflectDirN(c, mi.plane.n)), es.box);
      }
      stats.mirror = (stats.mirror ?? 0) + 1;
    };
    for (const x of order) {
      if (!x.children) { lines.push(plainLine(x)); placed.add(x.id); emitMirror(x); continue; }
      if (dissolved.has(x.id)) {
        // 校验没通过的阵列：拆回普通物体
        for (const c of x.children) for (const o of c.members) { unitOf.delete(o.id); lines.push(plainLine(o)); placed.add(o.id); }
        continue;
      }
      const u = x, anchor = u.children[0], a0 = anchor.members[0];
      const inUnit = (B) => unitOf.get(B.id)?.unit === u;
      if (u.rotate) {
        // rotate 容器：坐标系就是父坐标系，第一个成员照常用关系定位；其余成员由旋转生成
        const { u: ax, deg, c } = u.rotate;
        const onAxis = objs.filter((o) => isPlaced(o) && !inUnit(o) && o.kind !== 'mesh' && len(cross(sub(centerOf(o), c), ax)) < 5e-4).sort((p2, q2) => q2.vol - p2.vol)[0];
        let aboutTxt;
        if (onAxis) aboutTxt = nameOf(onAxis);
        else { aboutTxt = `(${vec6(c)})`; stats.coord++; }
        const axTxt = Math.abs(ax[1] - 1) < 1e-9 ? '' : Math.abs(ax[0] - 1) < 1e-9 ? ' axis=x' : Math.abs(ax[2] - 1) < 1e-9 ? ' axis=z' : ` axis=(${vec6(ax)})`;
        lines.push(`rotate ${u.id} n=${u.n - 1} angle=${fmt6(deg)} about=${aboutTxt}${axTxt} {`);
        const sib = new Set();
        for (const ch of u.children) {
          const o = ch.members[0];
          const cand = (B) => (isPlaced(B) && !inUnit(B)) || (sib.has(B.id) && B !== o);
          const cc = chooseFor(o, o.at, cand, (B) => (sib.has(B.id) ? unitOf.get(B.id).child.id : nameOf(B)));
          const props = Object.entries(o.props).map(([k, v]) => `${k}=${v}`).join(' ');
          lines.push('  ' + [o.kind, ch.id, props, cc ? cc.place : `at=${vec(o.at)}`, cc ? orientRel(o, cc.ref) : orientText(o.cols), `mat=${o.mat}`, `~fit=${fmt(Math.min(...ch.members.map((mm) => mm.fit)))}`].filter(Boolean).join(' '));
          if (cc) stats[cc.kind]++; else stats.coord++;
          sib.add(o.id);
          for (const [k, mm] of ch.members.entries()) {
            targets.push({ o: mm, path: k === 0 ? `${u.id}.${ch.id}` : `${u.id}.r${k}.${ch.id}`, tol: cc && cc.kind !== 'at' ? 0.025 : 2e-3, unit: u.id, kind: 'rotate' });
            setPose(mm, o.cols.map((c) => rotAbout(ax, deg * k, [0, 0, 0], c)), o.box);
          }
        }
        lines.push('}');
        for (const ch of u.children) for (const o of ch.members) placed.add(o.id);
        emitMirror(u);
        continue;
      }
      // 阵列整体的定位：用锚定成员（第 0 个实例里最大的那个）与外部已放好物体的关系，pin=origin 把阵列原点钉上去
      let place = null, ref = null;
      const c = fallback.has(u.id) ? null : chooseFor(a0, u.origin, (B) => isPlaced(B) && !inUnit(B), nameOf);
      if (c && (c.kind !== 'on' || Math.abs(c.ref.cols[1][1] - 1) < 1e-9)) { place = `${c.place} pin=origin`; ref = c.ref; stats[c.kind]++; }
      else { place = `at=${vec(u.origin)} pin=origin`; stats.coord++; }
      // 阵列坐标系：参照物的朝向（on / against 继承），否则世界朝向
      const RF = ref && c.kind !== 'at' ? ref.cols : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const local = (p) => mvT(RF, sub(p, u.origin));
      const stepL = mvT(RF, u.step);
      const dims = u.grid ? `n=(${u.n[0]},1,${u.n[1]})` : `n=${u.n}`;
      const stepTxt = u.grid ? `step=${vec([stepL[0], 0, u.step2Local ?? 0])}` : `step=${vec(stepL)}`;
      lines.push(`repeat ${u.id} ${dims} ${stepTxt}${u.turn ? ` turn=${fmt(u.turn)}` : ''} ${place} {`);
      // 实例里的成员：锚定成员放在原点附近；其余成员优先相对同一实例里的兄弟定位
      const sib = new Set();
      for (const ch of u.children) {
        const o = ch.members[0];
        const cand = (B) => sib.has(B.id) && B !== o;
        const cc = ch === anchor ? null : chooseFor(o, o.at, cand, (B) => unitOf.get(B.id).child.id);
        const props = Object.entries(o.props).map(([k, v]) => `${k}=${v}`).join(' ');
        const lp = local(o.at);
        const placeTxt = cc ? cc.place : lp.every((v) => Math.abs(v) < 1e-6) ? '' : `at=${vec(lp)}`;
        const colsL = o.cols.map((col) => mvT(RF, col));
        const orient = cc ? orientRel(o, cc.ref) : o.symY && Math.abs(colsL[1][1] - 1) < 1e-6 ? '' : orientText(colsL);
        lines.push('  ' + [o.kind, ch.id, props, placeTxt, orient, `mat=${o.mat}`, `~fit=${fmt(Math.min(...ch.members.map((m) => m.fit)))}`].filter(Boolean).join(' '));
        sib.add(o.id);
        for (const [i, m] of ch.members.entries()) {
          const k = instOf(u, i);
          targets.push({ o: m, path: `${u.id}.${k}.${ch.id}`, tol: 2e-3, unit: u.id, kind: 'repeat' });
          setPose(m, u.turn ? o.cols.map((c) => mvC(Ry(u.turn * k), c)) : o.cols, o.box);
        }
      }
      lines.push('}');
      for (const h of u.holes ?? []) lines.push(`drop ${u.id}.${h}`);
      for (const ch of u.children) for (const o of ch.members) placed.add(o.id);
      emitMirror(u);
    }
    // 校验没通过的镜像：被镜像的那一个按普通物体或阵列写出来
    for (const mi of mirrors) if (droppedMirrors.has(mi.B.id)) {
      if (mi.B.children) {
        for (const c of mi.B.children) for (const o of c.members) { lines.push(plainLine(o)); placed.add(o.id); }
      } else { lines.push(plainLine(mi.B)); placed.add(mi.B.id); }
    }
    return { text: header.concat(lines).join('\n'), targets, stats };
  };

  // ── 校验：逐个比对位姿；阵列不通过就拆开，普通物体不通过就退回坐标 ──
  const dissolved = new Set(), fallback = new Set(), droppedMirrors = new Set();
  let out;
  for (let round = 0; round < 6; round++) {
    out = emit(dissolved, fallback);
    const r1 = compile(out.text);
    const byPath = new Map(r1.nodes.map((n) => [n.path, n]));
    let changed = false;
    for (const t of out.targets) {
      if (t.kind === 'coord') continue;
      const n = byPath.get(t.path);
      // 位置：一般比较原点（底面中心）；绕自身轴对称的形状比较几何中心——它们的“原点”是包围盒底面中心，
      // 离轴有一个半径，旋转副本会把这个偏移一起转走，而拟合时每个副本的坐标系是按世界“上”规范选的
      const tolP = t.unit || t.mirror ? 2e-3 * Math.max(1, len(t.o.at) / 50) : t.tol;
      // 一律比较几何中心：中心与表示无关；加上考虑对称的朝向比较，位姿就完全确定了
      const posOk = () => len(sub(scl(add(n.box.min, n.box.max), 0.5), centerOf(t.o))) < tolP;
      const ok = n && n.world && n.box && posOk() && sameOrientation(t.o, n.world.R, !!t.mirror);
      if (ok) continue;
      if (process.env.S3D_DEBUG) console.error('校验不通过', t.path, n ? `中心差 ${len(sub(scl(add(n.box.min, n.box.max), 0.5), centerOf(t.o))).toFixed(4)}` : '找不到节点', n && !sameOrientation(t.o, n.world.R, !!t.mirror) ? '朝向不同' : '');
      if (process.env.S3D_DEBUG && n && /pisa_galleries\.0\.ring/.test(t.path)) console.error(out.text.split('\n').filter((l) => /^repeat pisa_galleries /.test(l) || /^  cyl ring /.test(l)).slice(0, 3).join('\n'));
      changed = true;
      if (t.mirror) { droppedMirrors.add(t.mirror); for (const id of [t.mirror]) ghostPath.forEach((v, k) => { if (v === t.path || v.startsWith(t.mirror + '.')) ghostPath.delete(k); }); }
      else if (t.unit) dissolved.add(t.unit); else fallback.add(t.o.id);
    }
    if (r1.errors.length && !changed) { for (const u of units) dissolved.add(u.id); for (const o of objs) fallback.add(o.id); changed = true; }
    if (!changed) break;
  }
  const kept = units.filter((u) => !dissolved.has(u.id));
  // 语义命名：没有源名字的部件按识别出的概念改名（box46 → terrain，cyls_2 → columns）；
  // 给了上一次的结果（previous）时，对得上的物体沿用上一次的名字
  const named = names ? semanticNames(out.text, { previous }) : { text: out.text, map: {}, renamed: 0 };
  const nm = (id) => named.map[id] ?? id;
  const report = {
    source: srcFile, level, parts: parts.length,
    kinds: Object.fromEntries(Object.entries(objs.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {})).sort()),
    arrays: kept.map((u) => ({ id: nm(u.id), n: u.n, ...(u.holes?.length ? { holes: u.holes } : {}), kind: u.rotate ? 'rotate' : u.turn ? 'screw' : u.grid ? 'grid' : 'linear', children: u.children.map((c) => c.id) })),
    mirrors: mirrors.filter((mi) => !droppedMirrors.has(mi.B.id)).map((mi) => ({ id: nm(mi.B.id), of: nm(mi.A.id), across: mi.across, objects: mi.paths.size })),
    covered: kept.reduce((s, u) => s + u.children.reduce((t, c) => t + c.members.length, 0), 0),
    placement: out.stats,
    meanFit: +(objs.reduce((s, o) => s + o.fit, 0) / objs.length).toFixed(3),
    dissolved: [...dissolved], fallback: [...fallback],
    renamed: named.renamed,
  };
  return { src: named.text + '\n', absSrc, report, objs };
}

// 阵列里第 i 个成员所在的实例编号（有缺位的阵列不是 0, 1, 2…）
const instOf = (u, i) => (u.ks ? u.ks[i] : i);

// 几何中心：与表示方式无关的物理点（“原点”是包围盒底面中心，取决于局部 y 轴选了哪一头）
const centerOf = (o) => add(o.at, mvC(o.cols, scl(add(o.box.min, o.box.max), 0.5)));

// 朝向是否一致（考虑形状自身的对称）：球与竖直圆柱只看竖直轴；横放的圆柱只看轴线；盒子转 180° 一样
function sameOrientation(o, Rw, mirrored = false) {
  const col = (k) => [Rw[0][k], Rw[1][k], Rw[2][k]];
  const near = (u, v) => len(sub(u, v)) < 3e-3;
  if (o.kind === 'mesh') return mirrored || [0, 1, 2].every((k) => near(col(k), o.cols[k]));
  if (o.symY) return Math.abs(Math.abs(Rw[1][1]) - Math.abs(o.cols[1][1])) < 2e-3;
  if (o.axisSym) return near(col(0), o.cols[0]) || ((o.sym180 || mirrored) && near(col(0), scl(o.cols[0], -1)));
  // 盒子关于自己的三个中面都对称：镜像副本里任意轴取反都是同一个盒子
  const signs = mirrored && o.kind === 'box' ? [[1, 1, 1], [-1, 1, 1], [1, -1, 1], [1, 1, -1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1]]
    : mirrored && o.kind === 'wedge' ? [[1, 1, -1]]
      : o.sym180 ? [[1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1]] : [[1, 1, 1]];
  return signs.some((sg) => [0, 1, 2].every((k) => near(col(k), scl(o.cols[k], sg[k]))));
}

// ───────── 镜像检测 ─────────
// 候选：同形状的两个物体（或同结构的两个阵列）。对每一对取它们参考点的垂直平分面（竖直面），
// 再核对每个成员反射之后是否正好落在另一边的成员上。镜像面优先写成“过某个物体中心、垂直于它的某根轴”。
function detectMirrors(objs, units, unitOf) {
  const reflect = (p, n, d) => sub(p, scl(n, 2 * (dot(p, n) - d)));
  const reflectDir = (v, n) => sub(v, scl(n, 2 * dot(v, n)));
  const sizeKey = (o) => [o.kind, o.props.axis ?? '', o.mat, ...Object.entries(o.props).filter(([k]) => !['src', 'pivot', 'axis'].includes(k)).map(([k, v]) => `${k}=${String(v).split(',').map((x) => Math.round(+x * 100)).join(',')}`)].join('|');
  const ents = [];
  // 参考点用全部成员的质心（网格反射后原点会换到另一个角上，质心不会）
  const centroid = (u) => scl(u.children.flatMap((c) => c.members.map(centerOf)).reduce((s2, p) => add(s2, p), [0, 0, 0]), 1 / u.children.reduce((s2, c) => s2 + c.members.length, 0));
  for (const u of units) ents.push({ id: u.id, unit: u, ref: centroid(u), members: u.children.flatMap((c) => c.members.map((o, k) => ({ o, child: c.id, k: instOf(u, k) }))), key: 'U' + u.children.map((c) => sizeKey(c.members[0])).join('/') + '|' + c_n(u) + '|' + (u.holes ?? []).join(',') });
  for (const o of objs) if (!unitOf.has(o.id)) ents.push({ id: o.id, obj: o, ref: centerOf(o), members: [{ o, child: null, k: null }], key: 'O' + sizeKey(o) });
  function c_n(u) { return JSON.stringify(u.n); }
  // 一个成员反射后是否与另一个物体重合（位置；朝向考虑形状自身的对称）
  const matches = (a, b, n, d) => {
    const pa = reflect(centerOf(a), n, d);
    if (len(sub(pa, centerOf(b))) > 0.004 + 1e-4 * len(sub(a.box.max, a.box.min))) return false;
    if (a.kind === 'mesh') return true;
    const rc = a.cols.map((c) => reflectDir(c, n));
    return sameOrientation(b, toRows(rc), true);
  };
  // 候选平面
  const planes = [];
  for (let i = 0; i < ents.length; i++) for (let j = i + 1; j < ents.length; j++) {
    const A = ents[i], B = ents[j];
    if (A.key !== B.key || Math.abs(A.ref[1] - B.ref[1]) > 1e-3) continue;
    let nrm = sub(B.ref, A.ref); nrm[1] = 0;
    if (len(nrm) < 1e-6) continue;
    nrm = unit(nrm);
    const f = nrm.find((v) => Math.abs(v) > 1e-9);
    if (f < 0) nrm = scl(nrm, -1);
    const d = dot(nrm, scl(add(A.ref, B.ref), 0.5));
    let pl = planes.find((p) => len(sub(p.n, nrm)) < 1e-3 && Math.abs(p.d - d) < 5e-3);
    if (!pl) planes.push((pl = { n: nrm, d, pairs: [] }));
    pl.pairs.push([A, B]);
  }
  // 逐个平面核对每一对的全部成员，算出副本里每个成员的路径
  const verified = [];
  for (const pl of planes) {
    const good = [];
    for (const [A, B] of pl.pairs) {
      const paths = new Map(), usedB = new Set();
      let ok = true;
      for (const ma of A.members) {
        const mb = B.members.find((x) => !usedB.has(x.o.id) && x.child === ma.child && matches(ma.o, x.o, pl.n, pl.d));
        if (!mb) { ok = false; break; }
        usedB.add(mb.o.id);
        paths.set(mb.o.id, ma.child ? `${B.id}.${ma.k}.${ma.child}` : B.id);
        (A.srcOf ??= new Map()).set(mb.o.id, ma.o.id);
      }
      if (ok) good.push({ A, B, paths });
    }
    const objectsCovered = good.reduce((s, g) => s + g.paths.size, 0);
    if (good.length >= 2 || objectsCovered >= 3) verified.push({ ...pl, good, objectsCovered });
  }
  verified.sort((x, y) => y.objectsCovered - x.objectsCovered);
  const used = new Set(), out = [];
  for (const pl of verified) {
    // 镜像面：找一个中心落在面上、某根水平轴垂直于面的物体；找不到就写成点 + 法线
    let across = null;
    for (const o of objs) {
      if (o.kind === 'mesh') continue;
      const cLocal = scl(add(o.box.min, o.box.max), 0.5), c = add(o.at, mvC(o.cols, cLocal));
      if (Math.abs(dot(c, pl.n) - pl.d) > 1e-3) continue;
      const ax = ['x', 'z'].find((a) => Math.abs(Math.abs(dot(o.cols[a === 'x' ? 0 : 2], pl.n)) - 1) < 1e-6);
      if (ax) { across = { obj: o, axis: ax }; break; }
    }
    for (const g of pl.good) {
      if (used.has(g.A.id) || used.has(g.B.id)) continue;
      // 名字更短的作为原件（tower 与 tower2、annex 与 mirrored_annex），一样长时按字母顺序
      const [A, B] = g.A.id.length < g.B.id.length || (g.A.id.length === g.B.id.length && g.A.id <= g.B.id) ? [g.A, g.B] : [g.B, g.A];
      const paths = A === g.A ? g.paths : null;
      let finalPaths = paths;
      if (!paths) {
        // 方向反过来：重新按 B → A 的成员对应关系算路径
        finalPaths = new Map();
        const usedA = new Set();
        for (const mb of A.members) {
          const ma = B.members.find((x) => !usedA.has(x.o.id) && x.child === mb.child && matches(mb.o, x.o, pl.n, pl.d));
          if (!ma) { finalPaths = null; break; }
          usedA.add(ma.o.id);
          finalPaths.set(ma.o.id, mb.child ? `${B.id}.${mb.k}.${mb.child}` : B.id);
          (B.srcOfRev ??= new Map()).set(ma.o.id, mb.o.id);
        }
        if (!finalPaths) continue;
      }
      used.add(A.id); used.add(B.id);
      const acrossTxt = across && across.obj.id !== A.id && across.obj.id !== B.id ? `${across.obj.id} axis=${across.axis}` : `(${vec6(scl(pl.n, pl.d))}) axis=(${vec6(pl.n)})`;
      const srcOf = paths ? g.A.srcOf : B.srcOfRev;
      out.push({ A: A.unit ?? A.obj, B: B.unit ?? B.obj, across: acrossTxt, paths: finalPaths, plane: pl, acrossObj: across?.obj ?? null, srcOf: new Map([...finalPaths.keys()].map((bid) => [bid, srcOf.get(bid)])) });
    }
  }
  return out;
}

// ───────── 阵列检测 ─────────
// 同形状、同尺寸、同材质（且相对竖直方向的姿态相同）的物体，如果相邻两个之间总是同一个刚体运动 M，
// 它们就是一个阵列：M 是平移 → 直线阵列（两组平移 → 网格）；M 绕竖直轴旋转 → 旋转对称；旋转加竖直平移 → 螺旋。
// 同一运动、同样数量、成员之间相对位姿固定的几组阵列，合并成一个多部件的 repeat。
function detectArrays(objs, related) {
  // 签名：形状、尺寸（量化到厘米）、材质、相对竖直方向的姿态
  // 签名：形状、材质、相对竖直方向的姿态，加上尺寸数值；尺寸按容差比较（拟合会有毫米级的噪声）
  const nums = (o) => Object.entries(o.props).filter(([k]) => !['src', 'pivot', 'axis'].includes(k)).flatMap(([, v]) => String(v).split(',').map(Number));
  // 朝向不进签名：一般轴的旋转会改变物体相对竖直方向的姿态；每一对的运动在下面单独核对
  const head = (o) => [o.kind, o.props.axis ?? '', o.mat].join('|');
  const sameSize = (a, b) => { const x = nums(a), y = nums(b); return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 0.01 + 0.005 * Math.abs(v)); };
  const groupList = [];
  for (const o of objs) {
    if (o.kind === 'mesh') continue;
    const g = groupList.find((gg) => gg.head === head(o) && sameSize(gg.items[0], o));
    if (g) g.items.push(o); else groupList.push({ head: head(o), items: [o] });
  }
  const groups = new Map(groupList.map((g, i) => [i, g.items]));
  const rowsOf = (cols) => toRows(cols);
  const raw = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const used = new Set();
    const rawStart = raw.length;
    const scale = Math.max(...g.map((o) => len(sub(o.box.max, o.box.min)))) || 1;
    const tol = 0.004 + 1e-4 * scale;
    const close = (a, b) => len(sub(a, b)) < tol;
    // 每一对给出一个候选运动，按容差聚类
    const clusters = [];
    const sameMotion = (m, n) => (m.delta === 0) === (n.delta === 0) && (m.delta === 0
      ? close(m.step, n.step)
      : Math.abs(m.delta - n.delta) < 0.05 && close(m.center, n.center) && Math.abs(m.dy - n.dy) < tol);
    for (const a of g) for (const b of g) {
      if (a === b) continue;
      const Rb = rowsOf(b.cols), Ra = rowsOf(a.cols);
      const Rm = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Rb[i][0] * Ra[j][0] + Rb[i][1] * Ra[j][1] + Rb[i][2] * Ra[j][2]));
      if (Math.abs(Rm[1][1] - 1) > 1e-4) continue;
      const raw0 = (Math.atan2(Rm[0][2], Rm[0][0]) * 180) / Math.PI;
      // 绕竖直轴对称的形状看不出转角，只找平移；转 180° 看起来一样的形状（盒子、横放的圆柱）两种转角都算
      const deltas = a.symY ? [0] : a.sym180 ? [raw0, raw0 + 180] : [raw0];
      for (let delta of deltas) {
        delta = ((((delta + 180) % 360) + 360) % 360) - 180;
        if (Math.abs(Math.abs(delta) - 180) < 1e-9) delta = 180;
        const tm = sub(centerOf(b), mvC(Ry(delta), centerOf(a)));
        let motion;
        if (Math.abs(delta) < 1e-3) motion = { delta: 0, step: tm };
        else {
          // 绕过 c 的竖直轴转 delta，再竖直移动 dy：解 (I − Ry) c = tm 的水平分量
          const rad = (delta * Math.PI) / 180, co = Math.cos(rad), si = Math.sin(rad);
          const m00 = 1 - co, m01 = -si, m10 = si, m11 = 1 - co, det = m00 * m11 - m01 * m10;
          if (Math.abs(det) < 1e-9) continue;
          motion = { delta, center: [(tm[0] * m11 - m01 * tm[2]) / det, 0, (m00 * tm[2] - m10 * tm[0]) / det], dy: tm[1] };
        }
        // 只保留规范方向（平移的第一个非零分量为正；旋转角为正），这样同一组物体不会一会儿正向一会儿反向
        if (motion.delta === 0) { const f = motion.step.find((v) => Math.abs(v) > 1e-6); if (!(f > 0)) continue; }
        else if (motion.delta < 0) continue;
        const cl = clusters.find((c) => sameMotion(c.motion, motion));
        if (cl) cl.pairs++; else clusters.push({ motion, pairs: 1 });
      }
    }
    // 一般轴的旋转（不竖直的轴，例如风车叶片）：由相对旋转求轴和角，再解轴上一点。
    // 盒子等有对称性的形状，自身坐标系有符号歧义，把对称变换都试一遍，由聚类挑出一致的那个
    const SYMS = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]];
    for (const a of g) for (const b of g) {
      if (a === b || a.symY || a.axisSym) continue;
      for (const sg of a.sym180 ? SYMS : [[1, 1, 1]]) {
        const Rb = rowsOf(b.cols.map((c, k) => scl(c, sg[k]))), Ra = rowsOf(a.cols);
        const Rm = [0, 1, 2].map((i) => [0, 1, 2].map((j) => Rb[i][0] * Ra[j][0] + Rb[i][1] * Ra[j][1] + Rb[i][2] * Ra[j][2]));
        if (Math.abs(Rm[1][1] - 1) < 1e-4) continue; // 竖直轴已经处理过
        const aa = axisAngleOf(Rm);
        if (!aa) continue;
        let { u, deg } = aa;
        const f = u.find((v) => Math.abs(v) > 1e-9);
        if (f < 0) { u = scl(u, -1); deg = 360 - deg; }
        if (deg > 180 + 1e-9) continue; // 只保留规范方向
        const mid = scl(add(centerOf(a), centerOf(b)), 0.5), chord = sub(centerOf(b), centerOf(a)), L = len(chord);
        if (L < tol || Math.abs(dot(chord, u)) > tol) continue; // 只接受没有沿轴平移的纯旋转
        const toward = unit(cross(u, chord));
        const c = add(mid, scl(toward, (L / 2) / Math.tan(((deg / 2) * Math.PI) / 180)));
        if (len(sub(rotAbout(u, deg, c, centerOf(a)), centerOf(b))) > tol) continue;
        const motion = { rot: true, u, deg, c };
        const cl = clusters.find((x) => x.motion.rot && Math.abs(x.motion.deg - deg) < 0.05 && dot(x.motion.u, u) > 0.9999 && len(cross(sub(c, x.motion.c), u)) < tol);
        if (cl) cl.pairs++; else clusters.push({ motion, pairs: 1 });
      }
    }
    const apply = (m, o) => (m.rot ? rotAbout(m.u, m.deg, m.c, centerOf(o)) : m.delta ? add(add(mvC(Ry(m.delta), sub(centerOf(o), m.center)), m.center), [0, m.dy, 0]) : add(centerOf(o), m.step));
    // 轴对称的形状（竖直圆柱、球、平行的斜圆柱）看不出自身的转角：按位置找“环”——同一高度上等距、等角分布。
    // 分两轮：先认 3 个或 5 个以上的环（平移解释不了，例如正八边形里成对平行的弦会被平移抢走）；
    // 4 个的留给平移（2×2 的网格更自然），平移之后剩下的再认
    const findRings = (accept) => {
    if (g[0].symY || g[0].axisSym) {
      const ax = g[0].symY ? [0, 1, 0] : g[0].cols[0];
      const ctr = (o) => add(o.at, mvC(o.cols, scl(add(o.box.min, o.box.max), 0.5)));
      const e1 = unit(cross(ax, Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(ax, e1);
      const levels = [];
      for (const o of g.filter((x) => !used.has(x.id))) { const hgt = dot(ctr(o), ax); const lv = levels.find((l) => Math.abs(l.h - hgt) < tol); if (lv) lv.items.push(o); else levels.push({ h: hgt, items: [o] }); }
      for (const lv of levels) {
        if (lv.items.length < 3 || !accept(lv.items.length)) continue;
        const ps = lv.items.map(ctr), cc = scl(ps.reduce((s2, p) => add(s2, p), [0, 0, 0]), 1 / ps.length);
        const rs = ps.map((p) => len(sub(sub(p, cc), scl(ax, dot(sub(p, cc), ax)))));
        const rbar = rs.reduce((s2, x) => s2 + x, 0) / rs.length;
        if (rbar < 10 * tol || rs.some((x) => Math.abs(x - rbar) > tol)) continue;
        const angOf = (p) => (Math.atan2(dot(sub(p, cc), e2), dot(sub(p, cc), e1)) * 180) / Math.PI;
        const items = lv.items.map((o, i) => ({ o, a: angOf(ps[i]) })).sort((x, y) => x.a - y.a);
        const n = items.length, step = 360 / n;
        if (!items.every((it, i) => Math.abs(((((it.a - items[0].a - i * step) % 360) + 540) % 360) - 180) < 0.05)) continue;
        // e1 → e2 是绕 ax 的右手正向；中心取在第一个成员的原点高度上
        const c = cc;
        raw.push({ motion: { rot: true, u: ax, deg: step, c }, members: items.map((it) => it.o) });
        items.forEach((it) => used.add(it.o.id));
      }
    }
    };
    findRings((n) => n !== 4);
    // 同样多的配对时，优先更简单的解释：纯平移先于旋转
    clusters.sort((x, y) => y.pairs - x.pairs || (x.motion.delta ? 1 : 0) - (y.motion.delta ? 1 : 0));
    for (const { motion } of clusters) {
      const free = g.filter((o) => !used.has(o.id));
      if (free.length < 2) break;
      const next = new Map();
      const orientAfter = (m, o) => (m.rot ? o.cols.map((c) => rotAbout(m.u, m.deg, [0, 0, 0], c)) : m.delta ? o.cols.map((c) => mvC(Ry(m.delta), c)) : o.cols);
      for (const a of free) {
        const p = apply(motion, a), oc = orientAfter(motion, a);
        const b = free.find((x) => x !== a && close(centerOf(x), p) && sameOrientation(x, toRows(oc)));
        if (b) next.set(a.id, b);
      }
      const hasPrev = new Set([...next.values()].map((b) => b.id));
      const chains = [], inChain = new Set();
      const follow = (a) => { const ch = [a]; inChain.add(a.id); for (let x = next.get(a.id); x && !inChain.has(x.id); x = next.get(x.id)) { ch.push(x); inChain.add(x.id); } return ch; };
      for (const a of free) if (!hasPrev.has(a.id) && next.has(a.id)) chains.push(follow(a));
      // 闭环（例如绕一圈的旋转对称）：每个成员都有前驱，任选一个开始
      for (const a of free) if (!inChain.has(a.id) && next.has(a.id)) chains.push(follow(a));
      for (const ch of chains) if (ch.length >= 3) { raw.push({ motion, members: ch }); ch.forEach((o) => used.add(o.id)); }
      // 网格：等长的平移链，起点又按另一个平移排成一列；写成 n=(a,1,b) 需要两个方向分别平行于 x 与 z
      if (!motion.delta && !motion.rot) {
        const byLen = new Map();
        for (const ch of chains) if (!ch.some((o) => used.has(o.id))) { if (!byLen.has(ch.length)) byLen.set(ch.length, []); byLen.get(ch.length).push(ch); }
        // 等长的链按“起点之间的平移”分成若干组；每组取间距最小、最长的那一列（避免把两座塔的腿混成一个网格）
        const subLists = [];
        for (const list0 of byLen.values()) {
          let rest = [...list0];
          while (rest.length >= 2) {
            rest.sort((x, y) => centerOf(x[0])[0] - centerOf(y[0])[0] || centerOf(x[0])[2] - centerOf(y[0])[2] || centerOf(x[0])[1] - centerOf(y[0])[1]);
            const c0 = rest[0];
            let best = null;
            for (const cj of rest.slice(1)) {
              const s2 = sub(centerOf(cj[0]), centerOf(c0[0]));
              const run = [c0];
              for (let j = 1; ; j++) { const nx = rest.find((c) => close(centerOf(c[0]), add(centerOf(c0[0]), scl(s2, j)))); if (!nx) break; run.push(nx); }
              if (run.length >= 2 && (!best || run.length > best.run.length || (run.length === best.run.length && len(s2) < len(best.s2)))) best = { run, s2 };
            }
            if (!best) { rest = rest.slice(1); continue; }
            subLists.push(best.run);
            rest = rest.filter((c) => !best.run.includes(c));
          }
        }
        for (const list of subLists) {
          if (list[0].length * list.length < 4) continue;
          const s2 = sub(centerOf(list[1][0]), centerOf(list[0][0]));
          if (!list.every((ch, j) => ch.every((o, i) => close(centerOf(o), add(add(centerOf(list[0][0]), scl(motion.step, i)), scl(s2, j)))))) continue;
          const isX = (v) => Math.abs(v[1]) < 1e-6 && Math.abs(v[2]) < 1e-6, isZ = (v) => Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6;
          let sx, sz;
          if (isX(motion.step) && isZ(s2)) { sx = motion.step; sz = s2; } else if (isZ(motion.step) && isX(s2)) { sx = s2; sz = motion.step; } else continue;
          // 按 (z 方向序号, x 方向序号) 排好，与 repeat 的实例编号一致；原点取两个序号都为 0 的那个
          const all = list.flat();
          const p0 = all.reduce((b, o) => (dot(sub(centerOf(o), centerOf(b)), sx) / dot(sx, sx) < -0.5 || dot(sub(centerOf(o), centerOf(b)), sz) / dot(sz, sz) < -0.5 ? o : b), all[0]);
          const idx = (o) => [Math.round(dot(sub(centerOf(o), centerOf(p0)), sx) / dot(sx, sx)), Math.round(dot(sub(centerOf(o), centerOf(p0)), sz) / dot(sz, sz))];
          const nx = Math.max(...all.map((o) => idx(o)[0])) + 1, nz = Math.max(...all.map((o) => idx(o)[1])) + 1;
          if (nx * nz !== all.length || all.some((o) => idx(o).some((v) => v < 0))) continue;
          all.sort((u, v) => idx(u)[1] - idx(v)[1] || idx(u)[0] - idx(v)[0]);
          raw.push({ motion: { delta: 0, step: sx }, members: all, grid: [nx, nz], step2: sz });
          all.forEach((o) => used.add(o.id));
        }
      }
    }
    findRings(() => true);
    // 有缺口的阵列：常规检测剩下的物体按格点拟合，允许少数缺位（写成 repeat 加 drop 阵列.k）。
    // 至少 3 个成员、缺位不超过五分之一（至少允许 1 个）、第 0 个实例必须在——它决定阵列原点与部件的写法
    const holesOk = (n, present) => present >= 3 && present < n && n - present <= Math.max(1, Math.floor(n / 5));
    const trans = clusters.filter((c) => !c.motion.delta && !c.motion.rot).map((c) => c.motion.step);
    const isXv = (v) => Math.abs(v[1]) < 1e-6 && Math.abs(v[2]) < 1e-6, isZv = (v) => Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6;
    // 已经认出的完整平移阵列可以被吸收：例如一排 6 根拆掉第 3 根，常规检测只认得出后 3 根
    for (;;) {
      const owned = new Map();
      for (const e of raw.slice(rawStart)) if (!e.motion.rot && !e.motion.delta) for (const o of e.members) owned.set(o.id, e);
      const free = g.filter((o) => !used.has(o.id) || owned.has(o.id));
      if (free.length < 3) break;
      let best = null;
      // 以 a 为第 0 个实例、沿 s1（与 s2）的格点上有哪些成员
      const lattice = (a, s1, s2) => {
        const at = new Map();
        for (const b of free) {
          const d = sub(centerOf(b), centerOf(a));
          const i = Math.round(dot(d, s1) / dot(s1, s1)), j = s2 ? Math.round(dot(d, s2) / dot(s2, s2)) : 0;
          if (i < 0 || j < 0 || i > 63 || j > 63) continue;
          if (!close(add(centerOf(a), add(scl(s1, i), s2 ? scl(s2, j) : [0, 0, 0])), centerOf(b)) || !sameOrientation(b, toRows(a.cols))) continue;
          at.set(`${i},${j}`, { b, i, j });
        }
        return [...at.values()];
      };
      // 吸收的阵列必须整个包含进来，并且至少带进一个散落的物体
      const absorbs = (c) => {
        const ids = new Set(c.members.map((o) => o.id));
        const es = new Set(c.members.map((o) => owned.get(o.id)).filter(Boolean));
        return c.members.some((o) => !used.has(o.id)) && [...es].every((e) => e.members.every((o) => ids.has(o.id))) ? [...es] : null;
      };
      const consider = (c) => { if (holesOk(c.N, c.members.length) && (c.replaced = absorbs(c)) && (!best || c.members.length > best.members.length || (c.members.length === best.members.length && c.N < best.N))) best = c; };
      for (const a of free) {
        for (const sx of trans.filter(isXv)) for (const sz of trans.filter(isZv)) {
          const es = lattice(a, sx, sz);
          const nx = Math.max(...es.map((e) => e.i)) + 1, nz = Math.max(...es.map((e) => e.j)) + 1;
          if (nx < 2 || nz < 2) continue;
          es.sort((e, f) => e.j - f.j || e.i - f.i);
          consider({ N: nx * nz, members: es.map((e) => e.b), ks: es.map((e) => e.j * nx + e.i), raw: { motion: { delta: 0, step: sx }, grid: [nx, nz], step2: sz } });
        }
        for (const s1 of trans) {
          const es = lattice(a, s1, null).sort((e, f) => e.i - f.i);
          const n = Math.max(...es.map((e) => e.i)) + 1;
          consider({ N: n, members: es.map((e) => e.b), ks: es.map((e) => e.i), raw: { motion: { delta: 0, step: s1 }, n } });
        }
      }
      if (!best) break;
      for (const e of best.replaced) raw.splice(raw.indexOf(e), 1);
      raw.push({ ...best.raw, members: best.members, ks: best.ks, replaced: best.replaced });
      best.members.forEach((o) => used.add(o.id));
    }
  }
  // 合并：同一运动、同样形状的阵列，第 k 个成员之间相对位姿固定，且第 0 个实例里彼此有空间关系
  const relPose = (a, b) => ({ a, b, t: mvT(a.cols, sub(centerOf(b), centerOf(a))) });
  // 相对位姿一致：中心的相对位置相同，且 b 相对 a 的朝向相同（考虑 b 自身的对称）
  const samePose = (p, q) => len(sub(p.t, q.t)) < 2e-3 && sameOrientation(p.b, toRows(q.b.cols.map((c) => mvC(p.a.cols, mvT(q.a.cols, c)))));
  const keyOf = (x) => JSON.stringify(x.motion.rot
    ? ['R', fx(x.motion.deg, 2), x.motion.u.map((v) => fx(v, 3)), x.motion.c.map((v) => fx(v, 1)), x.members.length]
    : [fx(x.motion.delta, 2), (x.motion.step ?? [x.motion.center[0], x.motion.dy, x.motion.center[2]]).map((v) => fx(v, 2)), x.members.length, x.grid ?? null, x.ks ?? null]);
  const merge = (list) => {
    list.sort((x, y) => y.members.reduce((s, o) => s + o.vol, 0) - x.members.reduce((s, o) => s + o.vol, 0));
    const out = [];
    for (const arr of list) {
      const u = out.find((uu) => keyOf(uu.arrays[0]) === keyOf(arr) && uu.arrays.some((b) => (related.get(b.members[0].id) ?? []).includes(arr.members[0].id))
        && arr.members.every((o, k) => samePose(relPose(uu.arrays[0].members[k], o), relPose(uu.arrays[0].members[0], arr.members[0]))));
      if (u) u.arrays.push(arr); else out.push({ arrays: [arr] });
    }
    return out;
  };
  // 有缺位的阵列要比逐个写出来更短才算规律（压缩即理解）：1 句 repeat + 每个部件 1 句 + 每个缺位 1 句 drop，
  // 对比原来的写法（被吸收的完整阵列每个 1 + 部件数 句，散落的物体每个 1 句）。
  // 任意三个同样的物体都能凑成“2×2 缺一角”，只有一个部件时并不更短；不划算就恢复被吸收的阵列
  const sizeOf = (a) => (a.grid ? a.grid[0] * a.grid[1] : a.n ?? a.members.length);
  const worth = (uu) => {
    const a = uu.arrays[0];
    if (!a.ks) return true;
    const kids = uu.arrays.length;
    const before = uu.arrays.reduce((s, x) => s + (x.replaced ?? []).length * 2 + x.members.length - (x.replaced ?? []).reduce((t, e) => t + e.members.length, 0), 0);
    return 1 + kids + (sizeOf(a) - a.members.length) < Math.min(before, a.members.length * kids);
  };
  let list = raw, unitsList = merge([...list]);
  for (let round = 0; round < 3; round++) {
    const bad = new Set(unitsList.filter((uu) => !worth(uu)).flatMap((uu) => uu.arrays));
    if (!bad.size) break;
    list = list.filter((a) => !bad.has(a)).concat([...bad].flatMap((a) => a.replaced ?? []));
    unitsList = merge([...list]);
  }
  // 命名：从成员名里去掉变化的序号；没有名字时按形状
  const usedNames = new Set(objs.map((o) => o.id));
  const uniq = (base) => { let n = base, i = 2; while (usedNames.has(n)) n = `${base}_${i++}`; usedNames.add(n); return n; };
  return unitsList.map((uu, ui) => {
    const first = uu.arrays[0], m = first.motion;
    // 命名：成员名的最长公共前缀作为阵列名，最长公共后缀作为部件名（例如 tower_legs_0_leg → tower_legs / leg）
    const commonPrefix = (lists) => { const out = []; for (let i = 0; lists.every((t) => i < t.length - 1 && t[i] === lists[0][i]); i++) out.push(lists[0][i]); return out; };
    const commonSuffix = (lists) => commonPrefix(lists.map((t) => [...t].reverse())).reverse();
    const toks = first.members.map((o) => o.id.split('_'));
    const pre = commonPrefix(toks);
    let base = pre.length && !/^\d+$/.test(pre[pre.length - 1]) ? pre.join('_') : pre.length ? pre.join('_') : `${first.members[0].kind}s`;
    const childName = (arr) => { const suf = commonSuffix(arr.members.map((o) => o.id.split('_'))); return suf.length && !/^\d+$/.test(suf[0]) ? suf.join('_') : arr.members[0].kind; };
    const id = uniq(base);
    const seen = new Set();
    const children = uu.arrays.map((arr) => { let c = sanitize(childName(arr)); while (seen.has(c)) c += '_'; seen.add(c); return { id: c, members: arr.members }; });
    const a0 = first.members[0];
    // 纯旋转（任意轴，或竖直轴且没有竖直平移）→ rotate 容器；螺旋 → 带 turn 的 repeat
    if (m.rot) return { id, children, n: first.members.length, rotate: { u: m.u, deg: m.deg, c: m.c } };
    if (m.delta && Math.abs(m.dy) < 1e-6) return { id, children, n: first.members.length, rotate: { u: [0, 1, 0], deg: m.delta, c: [m.center[0], a0.at[1], m.center[2]] } };
    if (m.delta) {
      return { id, children, n: first.members.length, turn: m.delta, step: [0, m.dy, 0], origin: [m.center[0], a0.at[1], m.center[2]] };
    }
    // 缺位：ks 是每个成员所在的实例编号，holes 是缺的编号
    const N = first.grid ? first.grid[0] * first.grid[1] : first.n ?? first.members.length;
    const gaps = first.ks ? { ks: first.ks, holes: [...Array(N).keys()].filter((k) => !first.ks.includes(k)) } : {};
    if (first.grid) {
      return { id, children, n: first.grid, grid: true, step: m.step, step2Local: first.step2[2], origin: a0.at, ...gaps };
    }
    return { id, children, n: N, turn: 0, step: m.step, origin: a0.at, ...gaps };
  }).filter(Boolean);
}

// 调试用：两个候选坐标系各自的最优拟合
export function _debugFits(part, i) {
  const pts = samplePoints(part.tris, 600, i + 1);
  const vol = meshVolume(part.tris);
  return [uprightFrame(pts), pcaFrame(pts), normalFrame(part.tris, pts)].filter(Boolean).map((F) => ({ F, fit: fitInFrame(F, pts, vol) }));
}
