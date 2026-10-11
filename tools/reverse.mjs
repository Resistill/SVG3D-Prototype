// 逆向管线：GLB → SVG3D
//   1. 读取部件（L0/L1 按节点；L2 按连通分量拆开合并过的网格）
//   2. 拟合基本体：候选坐标系（直立 + 主成分）× 候选形状（盒、圆柱、圆台、球、楔形），按表面采样点的有符号距离误差选最优；
//      误差太大就保留为 mesh，直接引用源网格
//   3. 提取关系：先发射全坐标版本，编译得到空间事实；再自下而上为每个物体选一条主关系（on / against），
//      朝向写成相对参照物的
//   4. 校验：编译关系版本，逐个比对位置与朝向，不一致的退回坐标
import { semanticNames } from './naming.mjs';
import { chainsOf, fitAlong, alongPoses } from './curvefit.mjs';
import { lineCost, neighborhoodScorer, SCORE_DEFAULTS, meshPrice, meshPriceMode } from './score.mjs';
import { sceneObjects } from './worldtris.mjs';
import { rng, bitsHash, readParts, partsOfDocument, splitComponents, uniqueVertices, samplePoints } from './parts.mjs';
import { compile, _curves, FACT_EPS } from '../src/s3d.js';
import { parseDecisions, applyDecisions, applyLocks, PRIMS } from './decisions.mjs';
import { planesOf, panelLines, shellLines } from './panels.mjs';
import { patchesOf } from './patches.mjs';
import { fitSweep, centerline } from './sweepfit.mjs';
import { heightField } from './heights.mjs';
import { assignRoles, scatterOf } from './roles.mjs';

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
// 档位（逆向不要求 100% 复原，保留语义即可）：一个参数决定所有“要多精确”的旋钮
//   tau     位置容差的单位（米）；所有与位置有关的容差按 S = tau / 5mm 缩放（精细档 S = 1，就是原来的数值）
//   fitTol  拟合的相对误差超过它就退回网格引用；语义档一律用最接近的基本体当语义代理（如实写 ~err）
//   digits  尺寸、坐标的小数位（按米）；angle 朝向取整的步长（度，0 表示不取整）
// 场景单位 unit（每个场景单位多少米，默认 1）：档位的数值都按米写，进入几何计算前换算成场景单位——
//   S 再除以 unit，小数位按 10^−digits 米折算，原来写死为米的绝对容差乘 M = 1/unit
export const FIDELITY = {
  detail: { name: 'detail', tau: 0.005, fitTol: 0.02, digits: 4, angle: 0 },
  structure: { name: 'structure', tau: 0.05, fitTol: 0.25, digits: 2, angle: 0.1 },
  semantic: { name: 'semantic', tau: 0.25, fitTol: Infinity, digits: 1, angle: 1 },
};
// 场景单位下的小数位：分辨率最多比 10^−digits 米粗到 3 倍（米制下就是 digits；stud ≈ 0.28 m 的结构档是 1 位，0.1 stud ≈ 2.8 cm，
// 仍小于档位容差；厘米、毫米时更少，最少 0 位）
export const digitsFor = (name, unit = 1) => Math.max(0, Math.ceil((FIDELITY[name] ?? FIDELITY.detail).digits + Math.log10(unit) - Math.log10(3) - 1e-9));
let FID = FIDELITY.detail, S = 1, M = 1, DIGITS = FID.digits;
export const setFidelity = (name, unit = 1) => { FID = FIDELITY[name] ?? FIDELITY.detail; S = FID.tau / unit / 0.005; M = 1 / unit; DIGITS = digitsFor(FID.name, unit); };
// 尺寸签名的量化步长（场景单位）：档位的小数位与 1 cm 中较粗的那个，按米折算——米制下就是原来“写出的数再量化到厘米”
const SIZE_Q = () => Math.max(10 ** -FID.digits, 0.01) * M;
const fmt = (x) => { const p = 10 ** DIGITS, v = Math.round(x * p) / p; return Object.is(v, -0) ? '0' : String(v); };
const fmtA = (deg) => fmt6(FID.angle ? Math.round(deg / FID.angle) * FID.angle : deg); // 角度按档位取整
// 阵列的步长会被乘以实例数：取整误差放大 n 倍，所以位数按“n × 0.5·10^−d ≤ 容差”单独取（至少是档位的位数）
const fmtStep = (x, n) => { const d = Math.min(6, Math.max(DIGITS, Math.ceil(Math.log10((0.5 * Math.max(1, n)) / (1e-3 * S))))); const v = Math.round(x * 10 ** d) / 10 ** d; return Object.is(v, -0) ? '0' : String(v); };
const angTol = () => Math.max(3e-3, (FID.angle * Math.PI / 180) * 1.5);
const vec = (v) => v.map(fmt).join(',');
const fmt6 = (x) => { const v = Math.round(x * 1e6) / 1e6; return Object.is(v, -0) ? '0' : String(v); };
const vec6 = (v) => v.map(fmt6).join(',');
// 拟合出来的数离 4 位小数很近（差不到 2e-6）时吸附过去：0.000001 → 0，8.999999 → 9
const snap = (x) => { const r = Math.round(x * 1e4) / 1e4; return Math.abs(x - r) < 2e-6 ? r : x; };
const vecS = (v) => vec6(v.map(snap));
// 读取部件、拆分量、表面采样在 parts.mjs（稳定的模块，源模型一侧的磁盘缓存按它的内容失效）
export { readParts, partsOfDocument, splitComponents, uniqueVertices, samplePoints };

// ───────── 2. 拟合基本体 ─────────
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
    const R = Ry(yaw), r00 = R[0][0], r02 = R[0][2], r20 = R[2][0], r22 = R[2][2];
    // 逐点取最值（Math.max / Math.min 两两折叠，与展开成参数的结果相同）
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of pts) { const x = p[0] * r00 + p[2] * r02, z = p[0] * r20 + p[2] * r22; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const area = (x1 - x0) * (z1 - z0);
    if (!best || area < best.area - 1e-9) best = { area, yaw };
  }
  let yaw = best ? best.yaw : 0;
  yaw = ((((yaw + 45) % 90) + 90) % 90) - 45;
  if (Math.abs(yaw) < 1e-3 || Math.abs(Math.abs(yaw) - 45) < 1e-3 && false) yaw = 0;
  return frameFrom(pts, Ry(yaw), yaw);
}
// 主成分坐标系
export function pcaFrame(pts) {
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
const triNormal = ([a, b, c]) => { const n = cross(sub(b, a), sub(c, a)); return { n: unit(n), area: len(n) / 2 }; };
// 法线坐标系：按面积把三角形法线聚类（n 与 -n 视为同一方向），最大的平面方向作为第一根轴，
// 与它垂直的最大平面方向作为第二根轴。平面构成的人造部件由此得到精确的朝向（盒子的面、圆柱的端面）
// triN：可选，与 tris 一一对应的 { n, area }（同一批三角形反复拟合时预先算好，数值与这里现算的相同）
function normalFrame(tris, pts, triN = null) {
  const clusters = [];
  const items = (triN ?? tris.map(triNormal)).filter((t) => t.area > 1e-12);
  items.sort((x, y) => y.area - x.area);
  // 找“创建得最早的、方向差不到 1.8° 的簇”：簇的方向按分量量化放进格网（格长 0.04 > 两个相差 1.8° 的单位向量的分量差），
  // 只看 t.n 与 −t.n 所在格子的相邻格子，结果与按创建顺序线性查找相同（曲面上簇几乎和三角形一样多，线性查找是平方的）
  // 簇少（盒子、楔形只有几个）时线性查找更快：簇到 32 个才建格网
  let grid = null;
  const Q = 0.04, cellKey = (x, y, z) => ((x + 32) * 64 + (y + 32)) * 64 + (z + 32);
  const put = (c) => { const k = cellKey(Math.floor(c.dir[0] / Q), Math.floor(c.dir[1] / Q), Math.floor(c.dir[2] / Q)); const l = grid.get(k); if (l) l.push(c); else grid.set(k, [c]); };
  for (const t of items) {
    let cl = null;
    if (!grid) cl = clusters.find((c) => Math.abs(dot(c.dir, t.n)) > 0.9995);
    else for (const s of [1, -1]) {
      const x = Math.floor((s * t.n[0]) / Q), y = Math.floor((s * t.n[1]) / Q), z = Math.floor((s * t.n[2]) / Q);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
        const l = grid.get(cellKey(x + i, y + j, z + k));
        if (l) for (const c of l) if ((!cl || c.k < cl.k) && Math.abs(dot(c.dir, t.n)) > 0.9995) cl = c;
      }
    }
    if (cl) cl.area += t.area;
    else {
      const c = { dir: t.n, area: t.area, k: clusters.length };
      clusters.push(c);
      if (grid) put(c);
      else if (clusters.length >= 32) { grid = new Map(); clusters.forEach(put); }
    }
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
// （拟合里每个采样点要算很多次：写成不分配数组的标量形式，算术与逐项建数组的写法相同）
const sdBox = (q, h) => { const d0 = Math.abs(q[0]) - h[0], d1 = Math.abs(q[1]) - h[1], d2 = Math.abs(q[2]) - h[2]; return Math.hypot(Math.max(d0, 0), Math.max(d1, 0), Math.max(d2, 0)) + Math.min(Math.max(d0, d1, d2), 0); };
// 圆台（轴 a，两端半径 r0、r1，半高 ha）的距离函数；与点无关的量先算好
function frustumSD(a, r0, r1, ha) {
  const [b, c] = [0, 1, 2].filter((k) => k !== a);
  const k = Math.cos(Math.atan2(Math.abs(r0 - r1), 2 * ha));
  return (q) => {
    const t = (q[a] + ha) / (2 * ha), r = r0 + (r1 - r0) * Math.max(0, Math.min(1, t));
    return sd2((Math.hypot(q[b], q[c]) - r) * k, Math.abs(q[a]) - ha);
  };
}
let edgeCr = 0;
const edgeD2 = (px, py, a, b) => {
  const ex = b[0] - a[0], ey = b[1] - a[1], wx = px - a[0], wy = py - a[1];
  const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
  const x = wx - ex * t, y = wy - ey * t;
  edgeCr = ex * wy - ey * wx;
  return x * x + y * y;
};
function sdTri2(px, py, A, B, C) {
  const d0 = edgeD2(px, py, A, B), c0 = edgeCr, d1 = edgeD2(px, py, B, C), c1 = edgeCr, d2 = edgeD2(px, py, C, A), c2 = edgeCr;
  const d = Math.min(d0, d1, d2);
  const s = Math.sign((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]));
  const inside = c0 * s >= 0 && c1 * s >= 0 && c2 * s >= 0;
  return (inside ? -1 : 1) * Math.sqrt(d);
}

// 封闭网格的体积（散度定理）；不封闭时返回 null，不做体积校验
// 顶点按坐标四舍五入到 1e-4 焊接（整数编号代替字符串键：两个顶点同号当且仅当三个取整值都相等，与按字符串比较相同）
function weldIds(tris, scale) {
  const n = tris.length * 3;
  let cap = 16;
  while (cap < 2 * n) cap *= 2;
  const table = new Int32Array(cap).fill(-1), keys = new Float64Array(3 * n), ids = new Int32Array(n);
  const same = (a, b) => a === b || (a !== a && b !== b); // NaN 的字符串键也相等
  let m = 0, k = 0;
  for (const t of tris) for (const v of t) {
    const x = Math.round(v[0] * scale), y = Math.round(v[1] * scale), z = Math.round(v[2] * scale);
    // 哈希：−0 与 0 同值（+ 0 把 −0 变成 0），NaN 用固定的值
    let h = 2166136261;
    for (const c of [x, y, z]) h = c !== c ? Math.imul(h ^ 0x7ff8, 16777619) : bitsHash(h, c + 0);
    h = (h >>> 0) & (cap - 1);
    let id = -1;
    for (let j; (j = table[h]) >= 0; h = (h + 1) & (cap - 1)) if (same(keys[3 * j], x) && same(keys[3 * j + 1], y) && same(keys[3 * j + 2], z)) { id = j; break; }
    if (id < 0) { id = m++; table[h] = id; keys[3 * id] = x; keys[3 * id + 1] = y; keys[3 * id + 2] = z; }
    ids[k++] = id;
  }
  return { ids, count: m };
}
function meshVolume(tris) {
  const { ids, count } = weldIds(tris, 1e4);
  const edges = new Map();
  for (let t = 0; t < tris.length; t++) for (let i = 0; i < 3; i++) {
    const a = ids[3 * t + i], b = ids[3 * t + (i + 1) % 3];
    if (a === b) continue;
    const k = a < b ? a * count + b : b * count + a;
    edges.set(k, (edges.get(k) ?? 0) + 1);
  }
  for (const c of edges.values()) if (c % 2) return null;
  return Math.abs(tris.reduce((s, [a, b, c]) => s + dot(a, cross(b, c)), 0) / 6);
}

// 在一个坐标系里尝试各种形状，返回误差最小的。
// 误差 = 表面采样点到候选表面的平均距离（按最薄方向归一化）；
// 再用体积校验排除“比实物大很多”的候选（例如把弯曲的薄路面套进一个大盒子）
function fitInFrame(F, pts, vol = null, verts = [], only = null) {
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
    if (only !== 'cyl' && only !== 'cone' && Math.abs(h[b] - h[c]) > 0.08 * Math.max(h[b], h[c])) continue;
    // 半径取侧面点到轴的距离的中位数（比包围盒稳健，不受轴略微倾斜与多边形近似影响）
    const radial = (x) => Math.hypot(x[b], x[c]);
    // 正多边形近似的圆柱，侧面顶点恰好在半径 r 上：取顶点的最大径向距离
    const vr = vq.map(radial).filter((x) => x > 0.5 * (h[b] + h[c]) / 2);
    const side = q.filter((x) => Math.abs(x[a]) < 0.8 * h[a]).map(radial).sort((u, v) => u - v);
    const r = vr.length ? Math.max(...vr) : side.length ? side[Math.floor(side.length * 0.75)] : (h[b] + h[c]) / 2;
    push({ shape: 'cyl', axis: a, r0: r, r1: r, e: err(frustumSD(a, r, r, h[a])) }, Math.PI * r * r * 2 * h[a]);
    // 圆台：两端的最大半径
    const near = (s) => q.filter((x) => Math.abs(x[a] - s * h[a]) < 0.02 * h[a] + 1e-6).map(radial);
    const r0 = Math.max(0, ...near(-1)), r1 = Math.max(0, ...near(1));
    if (Math.abs(r0 - r1) > 0.05 * r) push({ shape: 'cone', axis: a, r0, r1, e: err(frustumSD(a, r0, r1, h[a])) }, (Math.PI * 2 * h[a] / 3) * (r0 * r0 + r0 * r1 + r1 * r1));
  }
  if (only === 'sphere' || Math.max(...h) - Math.min(...h) < 0.08 * Math.max(...h)) {
    // 球：顶点到顶点质心的平均距离（顶点都在球面上）
    const vc = vq.length ? scl(vq.reduce((s2, v) => add(s2, v), [0, 0, 0]), 1 / vq.length) : [0, 0, 0];
    const r = vq.length ? vq.reduce((s2, v) => s2 + len(sub(v, vc)), 0) / vq.length : (h[0] + h[1] + h[2]) / 3;
    push({ shape: 'sphere', r, e: err((x) => len(sub(x, vc)) - r) }, (4 / 3) * Math.PI * r ** 3);
  }
  // 楔形：坡沿局部 x 或 z，高的一侧在正或负方向（只在竖直轴朝上时）
  // 盒子已经几乎完美时楔形不可能更好，省掉（规模：楔形的距离函数是拟合里最贵的一项）
  if (F.cols[1][1] > 0.999 && (only === 'wedge' || cands[0].e >= 0.01)) for (const [s, sign] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
    const hs = h[s], hy = h[1], o = s === 0 ? 2 : 0;
    const A = [-hs * sign, -hy], B = [hs * sign, -hy], C = [hs * sign, hy];
    push({ shape: 'wedge', slope: s, sign, e: err((x) => sd2(sdTri2(x[s], x[1], A, B, C), Math.abs(x[o]) - h[o])) }, 4 * hs * hy * h[o]);
  }
  const pool = only ? cands.filter((c) => c.shape === only) : cands;
  if (!pool.length) return null;
  pool.sort((x, y) => effErr(x) - effErr(y));
  return { ...pool[0], frame: F };
}

// 粗档位偏向更简单的形状：楔形、圆锥要比盒子、圆柱明显更好才选（逆向只要求保留语义）
const SHAPE_BIAS = { wedge: 0.6, cone: 0.3 };
const effErr = (c) => c.e * (FID.name === 'detail' ? 1 : 1 + (SHAPE_BIAS[c.shape] ?? 0));

// 管道：表面点沿法线往里退一个半径就落在中心线上。半径 = 2·体积 / 表面积（闭合管道），
// 去掉端盖上的点，中心线点按主轴分段取平均得到折线，再用尽量少的控制点拟合 Catmull-Rom。
// 拐回头的曲线（螺旋）分段会失败，误差很大，自然不会被选中
function fitTube(part, i, vol, primE = Infinity) {
  const tris = part.tris;
  const area = tris.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0);
  if (!(vol > 0) || !(area > 0)) return null;
  let r = (2 * vol) / area;
  // 带法线的采样
  const rnd = rng(7919 * (i + 1));
  const cum = [];
  tris.reduce((s2, [a, b, c], k) => (cum[k] = s2 + len(cross(sub(b, a), sub(c, a))) / 2), 0);
  const S = [];
  for (let k = 0; k < 800; k++) {
    const x = rnd() * area;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    const [a, b, c] = tris[lo];
    let u = rnd(), v = rnd();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    S.push({ p: add(a, add(scl(sub(b, a), u), scl(sub(c, a), v))), n: unit(cross(sub(b, a), sub(c, a))) });
  }
  const F = pcaFrame(S.map((x) => x.p)), ax = F.cols.reduce((b2, c2, k) => (F.h[k] > F.h[F.cols.indexOf(b2)] ? c2 : b2), F.cols[0]);
  const side = S.filter((x) => Math.abs(dot(x.n, ax)) < 0.7);
  if (side.length < 100) return null;
  // 法线朝向不确定：两个方向都试，中心线点更“细”的那个是对的
  const centerline = (sign) => {
    const cs = side.map((x) => sub(x.p, scl(x.n, sign * r)));
    const ts = cs.map((c) => dot(c, ax)), t0 = Math.min(...ts), t1 = Math.max(...ts);
    const K = Math.max(6, Math.min(48, Math.round((t1 - t0) / (2 * r))));
    const bins = Array.from({ length: K }, () => ({ s: [0, 0, 0], n: 0 }));
    cs.forEach((c, k) => { const b = Math.min(K - 1, Math.floor(((ts[k] - t0) / (t1 - t0 || 1)) * K)); bins[b].s = add(bins[b].s, c); bins[b].n++; });
    const poly = bins.filter((b) => b.n).map((b) => scl(b.s, 1 / b.n));
    const spread = cs.reduce((s2, c, k) => { const b = Math.min(K - 1, Math.floor(((ts[k] - t0) / (t1 - t0 || 1)) * K)); return s2 + (bins[b].n ? len(sub(c, scl(bins[b].s, 1 / bins[b].n))) : 0); }, 0) / cs.length;
    return { poly, spread, t0, t1 };
  };
  const A = centerline(1), B = centerline(-1), C = A.spread <= B.spread ? A : B;
  if (C.poly.length < 3 || C.spread > 2 * r) return null;
  // 两端延长到端面（分段平均会把端点往里拉）
  const ext = (p0, p1, t) => { const d = sub(p0, p1), dt = dot(d, ax); return Math.abs(dt) < 1e-9 ? p0 : add(p0, scl(d, (t - dot(p0, ax)) / dt)); };
  const poly = [ext(C.poly[0], C.poly[1], C.t0 + 0.5 * r * 0), ...C.poly.slice(1, -1), ext(C.poly.at(-1), C.poly.at(-2), C.t1)];
  poly[0] = ext(C.poly[0], C.poly[1], C.t0);
  // 按弧长重采样出 M 个控制点，M 从少到多，取误差最小的（差不多时取少的）
  const cumL = [0];
  for (let k = 1; k < poly.length; k++) cumL.push(cumL[k - 1] + len(sub(poly[k], poly[k - 1])));
  const at = (s2) => { let k = 1; while (k < cumL.length - 1 && cumL[k] < s2) k++; const u = (s2 - cumL[k - 1]) / (cumL[k] - cumL[k - 1] || 1); return add(poly[k - 1], scl(sub(poly[k], poly[k - 1]), u)); };
  const segDist = (p, a, b) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / ((abx * abx + aby * aby + abz * abz) || 1)));
    return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + aby * t), p[2] - (a[2] + abz * t));
  };
  const pts = side.slice(0, 400).map((x) => x.p);
  let best = null;
  for (let M = 2; M <= Math.min(12, poly.length); M++) {
    const ctrl = Array.from({ length: M }, (_, k) => at((cumL.at(-1) * k) / (M - 1)));
    const line = M < 3 ? ctrl : _curves.catmullRom(ctrl, false, 10);
    const ds = pts.map((p) => { let m = Infinity; for (let k = 1; k < line.length; k++) m = Math.min(m, segDist(p, line[k - 1], line[k])); return m; });
    const rr = ds.reduce((s2, d) => s2 + d, 0) / ds.length; // 半径取到中心线距离的平均，比 2V/A 更准
    const e = ds.reduce((s2, d) => s2 + Math.abs(d - rr), 0) / ds.length / rr;
    // 每多一个控制点多 3 个数：误差要明显变好（少于原来的 75%）才多加
    if (!best || e < best.e * 0.75) best = { shape: 'tube', ctrl, r: rr, e };
  }
  if (!best || !(best.r > 0)) return null;
  // 笔直的管道就是圆柱（储罐、箭体），语义上应写成圆柱：中心线明显弯曲（偏离首尾连线超过 1.5 倍半径），
  // 或者基本体都拟合得很差、中心线又有可察觉的弯曲（缓缓弯下来的输料管），才当管道
  const a0 = best.ctrl[0], a1 = best.ctrl.at(-1);
  const bend = Math.max(...best.ctrl.map((p) => segDist(p, a0, a1)));
  return bend > 1.5 * best.r || (primE > 0.25 && bend > 0.3 * best.r) ? best : null;
}

// 台阶（楼梯）：朝上的水平面（踏面）大小相近、高度等差、水平中心沿一条直线等距排开 → span from=A to=B steps=n section=宽,厚。
// 踏面下面配得上朝下的面就用两者的距离当厚度，配不上（实心的楼梯）就用一级的高度（踏步连同踢面一起是一块）。
// 误差与其他形状同一套：采样点到这些踏步盒子的距离，按最薄的方向归一化
function fitSteps(part, pts, F) {
  const scale = Math.max(Math.min(...F.h), 0.02 * Math.max(...F.h), 1e-6);
  const planes = planesOf(part.tris, { tol: 0.02 * Math.max(...F.h) + 1e-6, minFrac: 0.005 });
  const box2 = (tris) => { const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity]; for (const t of tris) for (const v of t) { lo[0] = Math.min(lo[0], v[0]); hi[0] = Math.max(hi[0], v[0]); lo[1] = Math.min(lo[1], v[2]); hi[1] = Math.max(hi[1], v[2]); } return { lo, hi, c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2] }; };
  let ups = planes.filter((p) => p.n[1] === 1).map((p) => ({ y: p.d, area: p.area, ...box2(p.tris) }));
  if (ups.length < 3) return null;
  const med = [...ups].sort((a, b) => a.area - b.area)[ups.length >> 1].area;
  ups = ups.filter((u) => u.area > 0.5 * med && u.area < 1.5 * med).sort((a, b) => a.y - b.y);
  const n = ups.length;
  if (n < 3) return null;
  const rise = (ups[n - 1].y - ups[0].y) / (n - 1), stepC = [(ups[n - 1].c[0] - ups[0].c[0]) / (n - 1), (ups[n - 1].c[1] - ups[0].c[1]) / (n - 1)];
  const run = Math.hypot(...stepC);
  if (!(rise > 1e-6) || !(run > 1e-6)) return null;
  // 等差：每一级的高度与水平位移都接近平均值
  for (let i = 1; i < n; i++) {
    if (Math.abs(ups[i].y - ups[i - 1].y - rise) > 0.15 * rise) return null;
    if (Math.hypot(ups[i].c[0] - ups[i - 1].c[0] - stepC[0], ups[i].c[1] - ups[i - 1].c[1] - stepC[1]) > 0.15 * run) return null;
  }
  const u = [stepC[0] / run, stepC[1] / run], wv = [-u[1], u[0]];
  const width = Math.max(...ups.map((t) => Math.abs(wv[0]) * (t.hi[0] - t.lo[0]) + Math.abs(wv[1]) * (t.hi[1] - t.lo[1])));
  const downs = planes.filter((p) => p.n[1] === -1).map((p) => -p.d);
  const gaps = ups.map((t) => Math.min(...downs.map((y) => t.y - y).filter((g) => g > 1e-6 && g < rise * 0.95), Infinity)).filter(Number.isFinite).sort((a, b) => a - b);
  const th = gaps.length >= n / 2 ? gaps[gaps.length >> 1] : rise;
  const A = [ups[0].c[0] - u[0] * run / 2, ups[0].y - rise, ups[0].c[1] - u[1] * run / 2];
  const B = [A[0] + u[0] * run * n, A[1] + rise * n, A[2] + u[1] * run * n];
  // 误差：到第 i 级踏步盒子的距离取最小
  const sdBox3 = (q, h) => { const d = q.map((x, k) => Math.abs(x) - h[k]); return Math.hypot(...d.map((x) => Math.max(x, 0))) + Math.min(Math.max(...d), 0); };
  const e = pts.reduce((acc, p) => {
    const rel = [p[0] - A[0], p[1] - A[1], p[2] - A[2]], x = rel[0] * u[0] + rel[2] * u[1], z = rel[0] * wv[0] + rel[2] * wv[1];
    let best = Infinity;
    for (let i = 0; i < n; i++) best = Math.min(best, Math.abs(sdBox3([x - (i + 0.5) * run, rel[1] - ((i + 1) * rise - th / 2), z], [run / 2, th / 2, width / 2])));
    return acc + best;
  }, 0) / pts.length / scale;
  return { shape: 'steps', from: A, to: B, n, w: width, th, e };
}

// 旋转体：横截面接近圆形的坐标系里，沿对称轴分箱取最大半径得到外轮廓，Douglas–Peucker 简化 → revolve profile=[(r,y); …]。
// 误差：采样点到旋转面的径向距离（端面上的点只计超出的部分），按最薄方向归一化
// areaMesh：网格的表面积；旋转面的面积比它大很多（例如一圈螺旋扶手被当成整个圆柱面）就不算旋转体
function fitRevolve(pts, verts, F, areaMesh, tris = null) {
  const scale = Math.max(Math.min(...F.h), 0.02 * Math.max(...F.h), 1e-6);
  let best = null;
  for (let a = 0; a < 3; a++) {
    const [b, c] = [0, 1, 2].filter((k) => k !== a);
    if (Math.abs(F.h[b] - F.h[c]) > 0.1 * Math.max(F.h[b], F.h[c])) continue;
    const q = [...pts, ...verts].map((p) => mvT(F.cols, sub(p, F.c)));
    const t0 = Math.min(...q.map((x) => x[a])), H = Math.max(...q.map((x) => x[a])) - t0;
    if (!(H > 1e-6)) continue;
    const K = 24, rmax = new Array(K).fill(0);
    for (const x of q) { const k = Math.min(K - 1, Math.floor(((x[a] - t0) / H) * K)); rmax[k] = Math.max(rmax[k], Math.hypot(x[b], x[c])); }
    // 轮廓：中间用箱子的中心；两端只看紧贴端面的点（尖顶的半径是 0，不是最后一箱里的最大半径）
    const endR = (s0) => Math.max(0, ...q.filter((x) => Math.abs(x[a] - t0 - s0) < 0.01 * H).map((x) => Math.hypot(x[b], x[c])));
    let prof = [[endR(0), 0], ...rmax.map((r, k) => [r, ((k + 0.5) / K) * H]), [endR(H), H]];
    const tol = 0.01 * Math.max(...rmax) + 1e-9;
    const dp = (ps) => {
      if (ps.length < 3) return ps;
      const [A, B] = [ps[0], ps[ps.length - 1]], d = [B[0] - A[0], B[1] - A[1]], L = Math.hypot(...d) || 1;
      let iMax = 0, dMax = 0;
      ps.forEach((p, i) => { const e = Math.abs((p[0] - A[0]) * d[1] - (p[1] - A[1]) * d[0]) / L; if (e > dMax) { dMax = e; iMax = i; } });
      return dMax <= tol ? [A, B] : [...dp(ps.slice(0, iMax + 1)).slice(0, -1), ...dp(ps.slice(iMax))];
    };
    prof = dp(prof);
    // 旋转面的面积（侧面 + 两个端面）：网格只占其中一小部分时不是旋转体
    let areaRev = Math.PI * (prof[0][0] ** 2 + prof[prof.length - 1][0] ** 2);
    for (let k = 1; k < prof.length; k++) areaRev += Math.PI * (prof[k - 1][0] + prof[k][0]) * Math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]);
    if (areaMesh < 0.6 * areaRev) continue;
    const R = (t) => { for (let k = 1; k < prof.length; k++) if (t <= prof[k][1]) { const [r0, y0] = prof[k - 1], [r1, y1] = prof[k]; return y1 > y0 ? r0 + ((r1 - r0) * (t - y0)) / (y1 - y0) : Math.max(r0, r1); } return prof[prof.length - 1][0]; };
    const e = pts.reduce((acc, p) => {
      const x = mvT(F.cols, sub(p, F.c)), t = x[a] - t0, r = Math.hypot(x[b], x[c]), Rt = R(t);
      const cap = t < 0.02 * H || t > 0.98 * H;
      return acc + (cap ? Math.max(0, r - Rt) : Math.abs(r - Rt));
    }, 0) / pts.length / scale;
    if (!best || e < best.e) best = { shape: 'revolve', axis: a, t0, prof, e, H };
    // 外轮廓解释不了（凹进去的碗、盆、碟形天线被填实了）：试试按截面的边界写
    if (e > 0.02) { const sh = fitRevolveShell(pts, F, a, t0, H, scale, tol, tris); if (sh && sh.prof.length <= 16 && sh.e < (best?.e ?? Infinity)) best = sh; }
  }
  return best;
}
// 带内凹的旋转体（碗、盆、碟形天线）：外轮廓（每个高度取最大半径）把凹进去的部分填实了。
// 车削出来的网格，顶点成环：每个环在截面（r, y）上是一个点，网格的边只连相邻的环——把边投到截面上，得到的图就是截面的轮廓折线
// （从轴上出发，绕过外壁、沿口、内壁回到轴上）。环的数目要远少于顶点数（每环至少 4 个顶点），图要是一条两端的链；
// 不是车削的网格（顶点不成环）不试。轮廓按容差简化，端点落在轴上的写成 r = 0（编译器沿轴补齐）
function fitRevolveShell(pts, F, a, t0, H, scale, tol, tris) {
  if (!tris) return null;
  const [b, c] = [0, 1, 2].filter((k) => k !== a);
  const rOf = (p) => { const x = mvT(F.cols, sub(p, F.c)); return [Math.hypot(x[b], x[c]), x[a] - t0]; };
  const Rmax = Math.max(...pts.map((p) => rOf(p)[0])), D = Math.hypot(Rmax, H), q = 1e-3 * D;
  const ids = new Map(), node = [], key = (rp) => `${Math.round(rp[0] / q)},${Math.round(rp[1] / q)}`;
  const idOf = (v) => { const rp = rOf(v), k = key(rp); let id = ids.get(k); if (id === undefined) { ids.set(k, (id = node.length)); node.push(rp); } return id; };
  const adj = [];
  let nv = 0;
  for (const t of tris) {
    const ii = t.map(idOf);
    nv += 3;
    for (let k = 0; k < 3; k++) { const u = ii[k], v = ii[(k + 1) % 3]; if (u === v) continue; (adj[u] ??= new Set()).add(v); (adj[v] ??= new Set()).add(u); }
  }
  // 车削：截面上的点（环）远少于顶点
  if (node.length < 3 || node.length > 200 || node.length * 12 > nv) return null;
  const deg = node.map((_, i) => adj[i]?.size ?? 0);
  if (deg.some((d) => d > 2)) return null; // 不是一条链（分叉：不是车削出来的）
  const ends = deg.map((d, i) => (d === 1 ? i : -1)).filter((i) => i >= 0);
  if (ends.length !== 2) return null;
  const onAxis = Math.max(FID.tau * M, 0.02 * Rmax);
  let [s0, s1] = ends;
  if (node[s0][0] > node[s1][0]) [s0, s1] = [s1, s0];
  if (node[s0][0] > onAxis) return null; // 至少一端在轴上
  const chain = [s0];
  for (let prev = -1, cur = s0; cur !== s1;) { const nx = [...adj[cur]].find((x) => x !== prev); if (nx === undefined) return null; prev = cur; cur = nx; chain.push(cur); }
  if (chain.length !== node.length) return null;
  const raw = chain.map((i) => [node[i][0] <= onAxis && (i === s0 || i === s1) ? 0 : node[i][0], node[i][1]]);
  const dp = (ps) => {
    if (ps.length < 3) return ps;
    const [A, B] = [ps[0], ps[ps.length - 1]], d = [B[0] - A[0], B[1] - A[1]], L = Math.hypot(...d) || 1;
    let iMax = 0, dMax = 0;
    ps.forEach((p, i) => { const e = Math.abs((p[0] - A[0]) * d[1] - (p[1] - A[1]) * d[0]) / L; if (e > dMax) { dMax = e; iMax = i; } });
    return dMax <= tol ? [A, B] : [...dp(ps.slice(0, iMax + 1)).slice(0, -1), ...dp(ps.slice(iMax))];
  };
  const prof = dp(raw);
  if (prof.length > 24) return null;
  // 误差：采样点在截面上到轮廓（加上沿轴补齐的那一段）的距离
  const loop = prof[prof.length - 1][0] > 0 ? [...prof, [0, prof[prof.length - 1][1]]] : prof;
  const segD = (p, A, B) => { const ex = B[0] - A[0], ey = B[1] - A[1], t = Math.max(0, Math.min(1, ((p[0] - A[0]) * ex + (p[1] - A[1]) * ey) / (ex * ex + ey * ey || 1e-30))); return Math.hypot(p[0] - A[0] - ex * t, p[1] - A[1] - ey * t); };
  const e = pts.reduce((acc, p) => { const rp = rOf(p); let m = Infinity; for (let k = 1; k < loop.length; k++) m = Math.min(m, segD(rp, loop[k - 1], loop[k])); return acc + m; }, 0) / pts.length / scale;
  return { shape: 'revolve', axis: a, t0, prof, e, H: Math.max(...prof.map((p) => p[1])), shell: true };
}

// 网格编号 → 采样种子（分块逆向的类型）
const meshSeed = (m) => { let h = 2166136261; for (const ch of String(m)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return (h >>> 0) % 1000003; };
// 写起来更长的形状（多点轮廓的旋转体、样条扫掠）要用省下的残差付得起多写的数，否则用简单的那个：
// 误差小一点就选它的话，一根细杆会被写成 20 个轮廓点的旋转体——轮廓描的是建模与取整的噪声。
// 残差按 primCheaper 的估计（误差在 τ 以内不计，所以简单形状已经在容差以内时多写的全是浪费），
// 再加上形状多出来的面（覆盖率 = 网格面积 / 形状面积不到 1：盖住弯道的楔形，表面大半落在路面以外——e 只量源到形状，看不见这部分），
// 那部分按封顶的距离计；多写的数每个按 1.5
function paysOff(simple, complex, extraNumbers, part) {
  const h = simple.frame.h, scale = Math.max(Math.min(...h), 0.02 * Math.max(...h), 1e-6), tauS = FID.tau * M;
  const area = part.tris.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0), w = 2 * 4 * Math.log2(1 + area / (tauS * tauS));
  // 多出来的面离源表面多远：不超过形状第二小的半尺寸（细杆的方柱多出来的只是棱角，离圆柱不过几厘米；盖住弯道的楔形多出来的离路面很远），封顶 dMax
  const extra = (f) => { if (coverOf(f, area) >= 1) return 0; const d = Math.min(SCORE_DEFAULTS.dMax * M, [...f.frame.h].sort((a, b) => a - b)[1]); return (1 - coverOf(f, area)) * Math.log2(1 + Math.max(0, d - tauS) / tauS); };
  const R = (f) => w * (Math.log2(1 + Math.max(0, f.e * scale - tauS) / tauS) + extra(f));
  return R(simple) - R(complex) > 1.5 * extraNumbers;
}
// 覆盖率：网格表面积 / 形状的表面积（台阶、管、旋转体、扫掠贴着网格走，算 1）
function coverOf(f, areaMesh) {
  if (!f.shape || f.shape === 'tube' || f.shape === 'steps' || f.shape === 'revolve' || f.shape === 'sweep') return 1;
  const h = f.frame.h, R = Math.max(f.r0 ?? 0, f.r1 ?? 0);
  const areaPrim = f.shape === 'sphere' ? 4 * Math.PI * f.r * f.r
    : f.shape === 'cyl' || f.shape === 'cone' ? 2 * Math.PI * R * R + 2 * Math.PI * R * 2 * h[f.axis] : 8 * (h[0] * h[1] + h[0] * h[2] + h[1] * h[2]);
  return areaPrim > 0 ? areaMesh / areaPrim : 1;
}
// 扫掠的结果整体平移
const moveSweep = (sw, d) => ({ ...sw, curve: sw.curve.kind === 'spline' ? { ...sw.curve, ctrl: sw.curve.ctrl.map((p) => add(p, d)) } : { ...sw.curve, c: add(sw.curve.c, d) } });
let SWEEP_SEEN = new Map(), SWEEP_FAILED = new Set();
// only：只在这种形状里挑（决定层指定了形状）；basic：只用盒、圆柱、圆台、球、楔形（“基本体之并”里的每一块）
export function fitPart(part, i, only = null, basic = false) {
  // 拼“基本体之并”时每个部件要拟合几十次：采样少一些（顶点总在采样里，包络仍是准的）
  const pts = samplePoints(part.tris, basic ? 200 : 600, i + 1);
  const vol = meshVolume(part.tris);
  const vmap = new Map();
  // part.vkeys：可选，与 tris 一一对应的三个顶点键（同上）
  if (part.vkeys) part.tris.forEach((t, k) => { const ks = part.vkeys[k]; vmap.set(ks[0], t[0]); vmap.set(ks[1], t[1]); vmap.set(ks[2], t[2]); });
  else for (const t of part.tris) for (const v of t) vmap.set(vkey(v), v);
  const verts = [...vmap.values()];
  const frames = [uprightFrame(pts), pcaFrame(pts), normalFrame(part.tris, pts, part.triN)].filter(Boolean);
  let fits = frames.map((F) => fitInFrame(F, pts, vol, verts, only)).filter(Boolean);
  if (!fits.length) fits = frames.map((F) => fitInFrame(F, pts, vol, verts));
  fits.sort((a, b) => effErr(a) - effErr(b));
  // 基本体拟合得不好时，试试管道（弯管、输料管）
  if (!only && !basic && fits[0].e > 0.02) { const t = fitTube(part, i, vol, fits[0].e); if (t && t.e < fits[0].e) fits.unshift({ ...t, frame: fits[0].frame }); }
  // 拟合得不好时，试试旋转体（整流罩、天线）；语义档一律用基本体当代理（灰盒），不用旋转体。
  // 轮廓最多 16 个点；网格按真实信息量计价的部件（结构、地形）放宽到 64 个——它们拟合不好时不再退回便宜的网格引用，长一点的轮廓也比粗糙的基本体好
  if (!only && !basic && FID.name !== 'semantic' && fits[0].e > 0.02) { const rv = fitRevolve(pts, verts, fits[0].frame, part.tris.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0), part.tris); if (rv && rv.e < fits[0].e && rv.prof.length <= (meshPriceMode(roleP(part), MESH_K) === 'full' ? 64 : 16) && paysOff(fits[0], rv, 2 * rv.prof.length - 3, part)) fits.unshift({ ...rv, frame: fits[0].frame }); }
  // 拟合得不好时，试试扫掠（截面不变、沿一条曲线走：弯曲的路面、螺旋坡道、拱、螺旋扶手；sweepfit.mjs）
  // 两个几乎不花时间的门槛（扫掠拟合每个部件要几毫秒到上百毫秒，真实场景里拟合差的部件有几百个，大多是家具这类别的东西）：
  //   基本体拟合得很差（e > 0.15；示例里的路面、坡道、拱、扶手都在 0.16 以上）——网格按真实信息量计价的部件（结构、地形）
  //   只要按本档的容差拟合失败（e > TOL）就试：拟合不好时它们不再退回便宜的网格引用，粗糙的基本体是唯一的别的选择；
  //   封闭网格要细长：V / A^1.5 < 0.04（扫掠体 = 截面 × 长度，示例里最大 0.03；立方体 0.068，10:1 的长条 0.037）
  const areaP = part.tris.length >= 16 && fits[0].e > (meshPriceMode(roleP(part), MESH_K) === 'full' ? Math.min(0.15, TOL) : 0.15) ? part.tris.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0) : 0;
  if (!only && !basic && !part.noSweep && !coarseRole(part) && areaP > 0 && !(vol > 0 && vol / areaP ** 1.5 >= 0.04)) {
    // 同一个网格、同样的旋转与缩放的部件（没成类型的享元）只差一个平移：结果平移过去（只在主线程上遇到——worker 只预先拟合不共用网格的部件，
    // 所以有没有 worker 结果都一样）
    const Mx = part.matrix, key = part.mesh != null && Mx && (MESH_USE.get(part.mesh) ?? 0) > 1 ? `${part.mesh}|${[0, 1, 2, 4, 5, 6, 8, 9, 10].map((q) => Math.round(Mx[q] * 1e6)).join()}` : null;
    let sw;
    // 不是扫掠与旋转无关：同一个网格（同样的缩放）失败过一次，别的实例不再试。采样的种子由几何决定（三角形数与面积），
    // 不随部件的序号变：源模型改了别处、重跑逆向时，这个部件的结果不变
    const fkey = key && `${part.mesh}|${[0, 4, 8].map((q) => Math.round(Math.hypot(Mx[q], Mx[q + 1], Mx[q + 2]) * 1e6)).join()}`;
    if (key && SWEEP_SEEN.has(key)) { const c = SWEEP_SEEN.get(key); sw = c.sw && moveSweep(c.sw, sub([Mx[12], Mx[13], Mx[14]], c.t)); }
    else if (fkey && SWEEP_FAILED.has(fkey)) sw = null;
    else { sw = fitSweep(part.tris, { tau: FID.tau * M, seed: 1 + ((part.tris.length * 7919 + Math.round(areaP / (M * M))) % 1000003) }); if (key) SWEEP_SEEN.set(key, { sw, t: [Mx[12], Mx[13], Mx[14]] }); if (!sw && fkey) SWEEP_FAILED.add(fkey); }
    // 多写的数：样条每个控制点 3 个；圆弧、螺旋一条曲线语句约 6 个；截面 1–2 个；基本体约 3 个
    if (sw && sw.e < fits[0].e && paysOff(fits[0], sw, (sw.curve.kind === 'spline' ? 3 * sw.curve.ctrl.length : 6) + 2 - 3, part)) fits.unshift({ shape: 'sweep', ...sw, frame: fits[0].frame });
  }
  // 拟合得不好时，试试台阶（楼梯）
  if (!only && !basic && fits[0].e > 0.05) { const st = fitSteps(part, pts, fits[0].frame); if (st && st.e < fits[0].e) fits.unshift({ ...st, frame: fits[0].frame }); }
  const best = fits[0];
  // 覆盖率：网格表面积 / 基本体表面积。实心的楼块、墙接近 1；一块起伏的地形、一道弯曲的长墙、地面贴花只占包络盒很小一部分表面，
  // 硬套一个基本体比保留网格糟得多（网格常常不闭合，所以不用体积判断）
  const areaMesh = part.tris.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0);
  const cover = coverOf(best, areaMesh);
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  const vc = scl(verts.reduce((s, v) => add(s, v), [0, 0, 0]), 1 / Math.max(1, verts.length));
  return { ...best, aabb: { min: lo, max: hi }, vc, cover };
}

// ───────── 发射：每个物体的原语、自身包围盒与世界朝向 ─────────
const TOL = 0.02; // 相对误差阈值，超过就保留为 mesh
const sanitize = (s) => { let t = String(s).replace(/[^\p{L}\p{N}_]/gu, '_'); if (!/^[\p{L}_]/u.test(t)) t = 'p_' + t; return t; };

// 把世界 y 转到方向 u 的最小旋转（绕 y×u 转），返回它的三个列向量
function minRot(u) {
  const ax = cross([0, 1, 0], u), s = len(ax), c = u[1];
  if (s < 1e-12) return c > 0 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const k = scl(ax, 1 / s);
  const rot = (v) => add(add(scl(v, c), scl(cross(k, v), s)), scl(k, dot(k, v) * (1 - c)));
  return [rot([1, 0, 0]), rot([0, 1, 0]), rot([0, 0, 1])];
}

// 覆盖率低于它（基本体的表面大部分不贴着网格）就退回网格引用，各档位都一样
const COVER_MIN = 0.3;
// 粗档位（结构、语义）保留网格之前先比较代价：相对误差按最薄的方向归一化，薄的东西（地垫、帘子、贴着墙的板）
// 相对误差很大、绝对误差却很小。网格引用的代价（c_mesh × log2(1 + 三角形数)，同一个网格的实例分摊）与
// 基本体的残差（按绝对的平均距离估算，与评分同一套计价，双向）比，基本体便宜就用基本体。精细档仍按相对误差
let MESH_USE = new Map();
function primCheaper(fit, part) {
  // 精细档：引用价的网格（装饰、贴花）拟合不好就引用；按真实信息量计价的（结构、地形）照样比价钱
  if (FID.name === 'detail' && meshPriceMode(roleP(part), MESH_K) === 'ref') return false;
  const h = fit.frame.h, scale = Math.max(Math.min(...h), 0.02 * Math.max(...h), 1e-6);
  const d = fit.e * scale, area = part.tris.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0);
  const tauS = FID.tau * M;
  const prim = 2 * 4 * Math.log2(1 + area / (tauS * tauS)) * Math.log2(1 + Math.max(0, d - tauS) / tauS);
  const mesh = meshPrice(part.tris, roleP(part), MESH_K) / Math.max(1, MESH_USE.get(part.mesh) ?? 1);
  return prim < mesh;
}
// L2 的网格兜底：合并网格拆出来的分量在源文件里没有节点，拟合不了时引用工程里的部件文件（parts.glb，由调用方写出）；
// 节点名把 # 换成 ~（# 是“文件#节点”的分隔符）
let PARTS_FILE = null;
export const partsNode = (from) => String(from).replace(/#/g, '~');

// 名字清理（不认具体的资产库，只用统计与通用的写法）：
//   节点名里的路径前缀（类别/子关卡/…）、SM_ 一类的资产前缀、开头的单字母类别（H_、I_）、贴图尺寸（1024x768）不进名字；
//   场景里大多数名字都带的词（资产库的主题、类别，如 FutureTech）没有区分度，去掉（至少留一个词）；连续重复的词只留一个；
//   Cube / Plane / Object 这类建模软件的默认名当作没有名字，交给语义命名（按识别出的概念起名）
const GENERIC = /^(cube|plane|cylinder|sphere|box|object|mesh|node|group|default|material|geometry|polysurface|p?cube|p?plane|untitled)(_?\d+)*$/i;
const nameTokens = (n) => String(n).split('/').pop().replace(/^SM_/i, '').split(/[_\s.\-()]+/).filter(Boolean);
export function nameCleanerOf(names) { return nameCleaner(names); }
function nameCleaner(names) {
  const uniq = [...new Set(names.filter(Boolean).map((n) => String(n).split('/').pop()))];
  const freq = new Map();
  for (const n of uniq) for (const t of new Set(nameTokens(n))) freq.set(t, (freq.get(t) ?? 0) + 1);
  const common = (t) => uniq.length >= 20 && freq.get(t) >= 0.3 * uniq.length && !/^\d+$/.test(t);
  return (n) => {
    if (n == null) return null;
    let ts = nameTokens(n).filter((t) => !/^\d+x\d+$/i.test(t));
    if (ts.length > 1 && /^[A-Za-z]$/.test(ts[0])) ts = ts.slice(1);
    const kept = ts.filter((t) => !common(t));
    if (kept.some((t) => /\p{L}{3,}/u.test(t))) ts = kept;
    ts = ts.filter((t, i) => i === 0 || t.toLowerCase() !== ts[i - 1].toLowerCase());
    const out = ts.join('_');
    return !out || GENERIC.test(out) ? null : out;
  };
}
let cleanName = (n) => (n == null ? null : String(n).split('/').pop().replace(/^SM_/, ''));
// 类型名不能和语言里的形状、容器同名
const KINDS_RESERVED = new Set(['box', 'cyl', 'cone', 'sphere', 'wedge', 'mesh', 'revolve', 'span', 'sweep', 'pipe', 'group', 'union', 'subtract', 'intersect', 'repeat', 'mirror', 'rotate', 'copy', 'line', 'bezier', 'spline', 'arc', 'helix', 'def', 'over', 'drop', 'let', 'material', 'concept', 'pattern', 'check', 'style', 'variant', 'import']);

// 顶点去重的键：四舍五入到 1e-5，并把 −0 归零（toFixed 会把 ±0.000001 写成 "-0.00000" / "0.00000" 两个键，
// 同一个顶点被算两次，圆柱的横向中心就偏了）
function vkey(v) { return v.map((x) => Math.round(x * 1e5) || 0).join(); }

function primitiveOf(fit, part, srcFile) {
  const fitScore = Math.max(0, Math.min(1, 1 - fit.e / TOL));
  const F = fit.frame, h = F.h, [ex, ey, ez] = F.cols;
  const ref = part.name ? `${srcFile}#${part.uid ?? part.name ?? part.from}` : PARTS_FILE && part.from ? `${PARTS_FILE}#${partsNode(part.from)}` : null;
  // 引用价的角色：贴花一律引用网格；覆盖率低（大片不规则的地面、弯曲的长墙）的也引用。按真实信息量计价的写成基本体，交给板件、小场景细化
  const refPriced = meshPriceMode(roleP(part), MESH_K) === 'ref';
  // 按真实信息量计价的（默认）不退回网格：关掉网格引用时场景不能少东西（用户的验收）。拟合差的写成基本体，交给板件、小场景细化
  const toMesh = part.force === 'mesh' || (refPriced && roleP(part) === 'decal') ? !!ref : !part.force && refPriced && (fit.e > FID.fitTol && !primCheaper(fit, part) || fit.cover < COVER_MIN) && !!ref;
  if (toMesh) {
    // 拟合不了：引用源网格。外包络是世界包围盒，原点在其底面中心
    // （从合并网格里拆出来的部件在源文件里没有节点可引用，只能用最接近的基本体，并如实给出低拟合度）
    const { min, max } = fit.aabb;
    const pivot = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
    const size = sub(max, min);
    return { kind: 'mesh', props: { src: JSON.stringify(ref), size: vec(size), pivot: vec(pivot) }, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: pivot,
      box: { min: [-size[0] / 2, 0, -size[2] / 2], max: [size[0] / 2, size[1], size[2] / 2] }, fit: fitScore, err: fit.e };
  }
  const base = { fit: fitScore, err: fit.e };
  if (fit.shape === 'revolve') {
    // 旋转体：局部 y 是对称轴，原点在轴与轮廓 y=0 的交点；朝向朝上（轴竖直时只是一个 turn，旋转体绕 y 对称，写不写都一样）
    const a = fit.axis, others = [0, 1, 2].filter((k) => k !== a);
    let ey = F.cols[a];
    if (ey[1] < 0) ey = scl(ey, -1);
    const t0 = ey === F.cols[a] ? fit.t0 : -(fit.t0 + (fit.H ?? fit.prof[fit.prof.length - 1][1]));
    const prof = ey === F.cols[a] ? fit.prof : [...fit.prof].reverse().map(([r, y]) => [r, (fit.H ?? fit.prof[fit.prof.length - 1][1]) - y]);
    let ex = F.cols[others[0]];
    const ez = cross(ex, ey);
    if (Math.abs(ey[1] - 1) < 1e-6) ex = [1, 0, 0];
    const cols = Math.abs(ey[1] - 1) < 1e-6 ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : [ex, ey, ez];
    const at = add(F.c, scl(ey, t0));
    const Rm = Math.max(...prof.map((p) => p[0])), Hh = Math.max(...prof.map((p) => p[1])); // 截面是封闭轮廓（带内凹）时最后一点不在顶上
    return { ...base, kind: 'revolve', props: { profile: `[${prof.map(([r, y]) => `(${fmt(r)},${fmt(y)})`).join('; ')}]` }, cols, at, box: { min: [-Rm, 0, -Rm], max: [Rm, Hh, Rm] } };
  }
  if (fit.shape === 'steps') {
    // 台阶：两个端点在父坐标系里（顶层就是世界坐标），不再加定位关系；包围盒取源网格的
    const { min, max } = fit.aabb;
    return { ...base, kind: 'span', props: { from: vec(fit.from), to: vec(fit.to), steps: String(fit.n), section: `${fmt(fit.w)},${fmt(fit.th)}` }, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: [0, 0, 0], box: { min, max }, absolute: true };
  }
  if (fit.shape === 'sweep') {
    // 扫掠：曲线在父坐标系里（顶层就是世界坐标），不再加定位关系；包围盒取源网格的。
    // 样条直接写进 path=[…]（圆截面写成 pipe）；圆弧、螺旋另写一条曲线语句（名字在发射时取物体名加 _path），sweep 引用它
    const { min, max } = fit.aabb, cv = fit.curve;
    const sec = fit.profile === 'circle' ? { r: fmt(fit.r) } : { section: `${fmt(fit.w)},${fmt(fit.th)}` };
    const at0 = { cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: [0, 0, 0], box: { min, max }, absolute: true };
    if (cv.kind === 'spline') {
      const path = `[${cv.ctrl.map((p) => `(${p.map(fmt).join(',')})`).join('; ')}]`;
      return fit.profile === 'circle' ? { ...base, ...at0, kind: 'pipe', props: { path, ...sec, smooth: 'true' } } : { ...base, ...at0, kind: 'sweep', props: { path, ...sec, smooth: 'true' } };
    }
    const norm = (a) => ((a % 360) + 540) % 360 - 180; // (−180, 180]
    let props, turn = 0;
    if (cv.kind === 'helix') { props = { r: fmt(cv.r), pitch: fmtStep(cv.pitch, Math.abs(cv.turns)), turns: String(Math.round(cv.turns * 1000) / 1000) }; turn = norm(cv.phase); }
    else {
      let { a0, a1, yaw = 0 } = cv;
      // 竖直面里的圆弧：起止角从小到大写（平面绕竖直轴转 180°，角 θ 变成 180° − θ），拱写成 angle=0,180 而不是 angle=180,0 turn=180
      if (cv.plane === 'xy' && a1 < a0) { a0 = 180 - a0; a1 = 180 - a1; yaw += 180; }
      const d = norm(a0) - a0;
      props = { r: fmt(cv.r), angle: `${fmtA(a0 + d)},${fmtA(a1 + d)}` };
      if (cv.plane === 'xy') { props.plane = 'xy'; turn = norm(yaw); }
    }
    const turnTxt = Math.abs(+fmtA(turn)) > 1e-9 ? `turn=${fmtA(turn)}` : '';
    return { ...base, ...at0, kind: 'sweep', props: { path: '@curve', ...sec }, curve: { kind: cv.kind, props, at: cv.c, turn: turnTxt } };
  }
  if (fit.shape === 'tube') {
    // 管道：点列在父坐标系里（顶层就是世界坐标），不再加定位关系；包围盒取源网格的
    const { min, max } = fit.aabb;
    return { ...base, kind: 'pipe', props: { path: `[${fit.ctrl.map((p) => `(${p.map(fmt).join(',')})`).join('; ')}]`, r: fmt(fit.r), smooth: 'true' }, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: [0, 0, 0], box: { min, max }, absolute: true };
  }
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
      // 不直立的盒子：局部 y 取最接近世界“上”的那条轴（朝上），这样站立方向不丢——倾斜的面板仍是“立在柱子上、带一个倾角”，
      // 关系（on / against）才成立；x 取其余两条里较长的，符号取最接近“从世界 y 转过去的最小旋转”的那一个
      const k = [0, 1, 2].reduce((b2, i) => (Math.abs(cols[i][1]) > Math.abs(cols[b2][1]) + 1e-6 ? i : b2), 0);
      const ny = cols[k][1] < 0 ? scl(cols[k], -1) : cols[k];
      const [i1, i2] = [0, 1, 2].filter((i) => i !== k);
      const ix = hh[i2] > hh[i1] + 1e-6 * M ? i2 : i1, iz = ix === i1 ? i2 : i1;
      const ref = minRot(ny);
      let nx = cols[ix];
      if (dot(nx, ref[0]) < -1e-9 || (Math.abs(dot(nx, ref[0])) <= 1e-9 && dot(nx, ref[2]) < 0)) nx = scl(nx, -1);
      cols = [nx, ny, cross(nx, ny)];
      hh = [hh[ix], hh[k], hh[iz]];
    } else if (hh[2] > hh[0] + 1e-6 * M) { hh = [hh[2], hh[1], hh[0]]; cols = [cols[2], cols[1], scl(cols[0], -1)]; }
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
    if (Math.abs(d[1]) > 0.7) {
      // 轴偏离竖直不多（斜塔里的立柱）：仍然是竖着的圆柱，只是倾斜了——局部 y 沿轴、朝上，
      // 坐标系取从世界 y 转过去的最小旋转，于是一起倾斜的物体之间相对朝向为零，关系照常成立
      const dy = d[1] < 0 ? scl(d, -1) : d, cols = minRot(dy);
      return { ...base, kind: fit.shape, props, cols, at: sub(c, scl(dy, H / 2)), box: { min: [-R, 0, -R], max: [R, H, R] } };
    }
    // 轴接近水平：用 axis=x，局部 x 沿轴，局部 y 尽量朝上
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

// 粗档位：局部 y 只差一点点就竖直（拟合的噪声，写出来是 rot=(0.002,-1,-0.004,45) 这样的）→ 吸附成竖直，只留偏航（turn=）。
// 倾角不超过档位角度步长的 5 倍，并且最长边 × 倾角不超过容差（远端的偏移在容差以内）
function snapUpright(prim) {
  if (FID.angle && !prim.absolute && prim.kind !== 'mesh' && prim.cols[1][1] < 1 - 1e-9) {
    const tilt = Math.acos(Math.min(1, prim.cols[1][1])), ext = Math.max(...[0, 1, 2].map((k) => prim.box.max[k] - prim.box.min[k]));
    if (tilt < (5 * FID.angle * Math.PI) / 180 && ext * tilt < FID.tau * M) {
      const y = [0, 1, 0], x = unit(sub(prim.cols[0], scl(y, prim.cols[0][1])));
      prim.cols = [x, y, cross(x, y)];
    }
  }
  return prim;
}

// ── 板件（结构档）：拟合差的大部件——有内部空间的楼（外墙、楼板、内墙连成一个网格）——第一遍就按平面拆成墙板、楼板，
// 门窗洞空出来（panels.mjs，细化用的同一套）。和现在的写法（最接近的基本体，或网格引用）在这个部件自己的源表面上按评分比较
// （与全场评分同一套计价，只看这一个部件），板件更好才用。
//   tris：物体坐标系里的三角形；cols、t：物体 → 世界（world = cols·local + t）；part：源部件（世界坐标）；
//   cur：现在的写法 { line：世界坐标里的一行 } 或 { mesh: 网格引用的代价 }；n：类型的实例数（残差按实例数计，描述只写一次）
// 返回 { body（相对包络底面中心 c0 的语句）, c0, box, fit, meanErr, S, curS } 或 null
let PANELS = true;
const PANEL_MIN_TRIS = 24, PANEL_MIN_SIZE = 2; // 一个空心盒子至少 24 个三角形；小于 2 m 的部件不试
const PANEL_PLANAR = 0.8; // 表面至少这么多落在大平面上才试（宿舍区的楼、棚、门框都在 0.88 以上）
// hollow：现在的基本体把空的地方填实了（hollowSolid），不管拟合好坏都要试
function panelsWorth(fit, part, hollow = false) {
  if (!PANELS || coarseRole(part) || FID.name !== 'structure' || part.force || part.tris.length < (hollow ? 2 : PANEL_MIN_TRIS)) return false; // 实心块必须拆时三角形少也试（一块倾斜的平地只有十几个三角形）
  if (!hollow && 1 - fit.e / TOL >= 0.5 && fit.cover >= COVER_MIN) return false;
  const { min, max } = fit.aabb;
  return Math.max(...sub(max, min)) >= PANEL_MIN_SIZE * M;
}
function tryPanels(tris, cols, t, part, cur, n = 1) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) for (const v of tri) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  const c0 = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const local = tris.map((tri) => tri.map((v) => sub(v, c0)));
  // 先做两个便宜的排除（板件很慢）：
  //   表面的大部分不在几个大平面上（岩石、帘子、曲面）——板件解释不了；
  //   现在的写法已经比板件可能的最短写法还短——每两个平面至少一块板，一块板一行至少 6 个词
  const pl = planesOf(local, { tol: 2 * FID.tau * M, minFrac: 0.005 });
  const areaAll = local.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0);
  if (pl.reduce((s2, q) => s2 + q.area, 0) < PANEL_PLANAR * areaAll) return null;
  const { evalLines } = judgeOf(part);
  const total = (ls) => ls.L + n * (ls.R_src + ls.R_recon + ls.R_vol);
  let curS = Infinity;
  if (cur.S != null) curS = cur.S;
  else if (cur.mesh != null) curS = cur.mesh;
  else {
    const ls = evalLines([cur.line]);
    if (ls) curS = total(ls);
    // 现在的基本体已经解释了这个部件（残差很小）：板件至少要好几块盒子，不可能更短
    if (ls && n * (ls.R_src + ls.R_recon + ls.R_vol) < 20) return null;
  }
  if (6 * Math.ceil(pl.length / 2) >= curS) return null;
  const tau = FID.tau * M, opts = { thick: Math.max(2 * FID.tau, 0.1) * M, maxThick: 1 * M, digits: DIGITS };
  const orient = orientText(cols), head = `group g at=${vec(add(t, mvC(cols, c0)))} pin=origin${orient ? ' ' + orient : ''} {`; // 评分时按原点放（容器默认按包络的底面中心放）
  let best = null;
  // 现在的写法是必须换掉的实心块（curS 无穷大）：块数上限放宽、多试一种更粗的格子——宁可写长一点，也不能把空的地方填实
  const cells = curS === Infinity ? [[2 * tau, 400], [4 * tau, 200], [8 * tau, 100], [16 * tau, 60]] : [[2 * tau, 120], [4 * tau, 60], [8 * tau, 30]];
  for (const [cell, maxBoxes] of cells) {
    const p = panelLines(local, { ...opts, cell, maxBoxes });
    if (!p) continue;
    const lines = [head, ...p.lines.map((l) => '  ' + l), '}'];
    // 描述长度本身就不比现在短（或不比已有的板件候选短）：不用评残差
    const L = lines.reduce((s2, l) => s2 + lineCost(l), 0);
    if (L >= Math.min(curS, best?.S ?? Infinity)) continue;
    const ls = evalLines(lines);
    if (ls && (!best || total(ls) < best.S)) best = { S: total(ls), ls, lines: p.lines };
  }
  if (!best || best.S >= curS) return null;
  const { body, shift, box } = centerBody(best.lines);
  // 拟合度：源表面到板件的平均距离，按 4τ 归一化（τ 以内的误差在评分里不计）
  const meanErr = best.ls.meanErr * M;
  return { body, c0: add(c0, shift), box, fit: Math.max(0, Math.min(1, 1 - meanErr / (4 * tau))), meanErr: best.ls.meanErr, S: +best.S.toFixed(2), curS: +curS.toFixed(2) };
}
// 局部评分：只看这一个源部件（与全场评分同一套计价）。板件、基本体之并都拿它和现在的写法比；
// 源部件的采样与 BVH 用到时才建，同一个部件的几种候选共用（每次逆向开始时清空：档位不同，计价不同）
let JUDGES = new WeakMap();
// 部件的角色（roles.mjs）；派生出来的部件对象（类型的局部坐标版本）带着 role 属性
let PART_ROLE = new WeakMap();
const roleP = (p) => p.role ?? PART_ROLE.get(p) ?? 'structure';
// 不做花时间的拆解（板件、外壳、并、扫掠、小场景）、只写成基本体代理或网格引用的角色：网格按引用价计的装饰、贴花。
// 按真实信息量计价时（默认）照样拆：关掉网格引用时场景要和源模型看起来差不多，贴花写成一个厚盒子、红绿灯包成一个大盒子都算不像
const coarseRole = (p) => { const r = roleP(p); return (r === 'decor' || r === 'decal') && meshPriceMode(r, MESH_K) === 'ref'; };
// 网格表面的高度（heights.mjs）：发射出来的 on=地形.top[u,w] 要按它编译、校验
let HEIGHT = null;
function judgeOf(part) {
  let J = JUDGES.get(part);
  if (J) return J;
  const consts = { ...SCORE_DEFAULTS, delta: FID.tau, unit: 1 / M };
  let scorer = null;
  const score = (objs, lines) => (scorer ??= neighborhoodScorer({ parts: [{ tris: part.tris, material: part.material }], near: [0], others: [], reconColors: new Set(), consts, whole: SUB_WHOLE }))(objs, lines);
  const color = part.material?.color;
  const evalLines = (lines) => {
    const r = compile(lines.join('\n'), { factEps: FACT_EPS * M });
    return r.errors.length ? null : score(sceneObjects(r).map((o) => ({ ...o, color })), lines);
  };
  JUDGES.set(part, (J = { evalLines }));
  return J;
}
// 容器按自己包围盒的底面中心定位（at=、on= 都是），不是按原点：把一组语句（第一层都带 at=）平移到“包络的底面中心在原点”。
// 内容的包络与源网格的包络差一点（格子取整、单面薄板的厚度、基本体的取整），所以先编译一次取内容自己的包络。
// 返回平移后的语句、平移量（加到原来的原点上）与平移后的包络
// subtract：包络只是第一个子物体（被减体），只拿它算
function centerBody(lines, subtract = false) {
  const boxOfLines = (ls) => {
    const bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
    for (const o of sceneObjects(compile(ls.join('\n'), { factEps: FACT_EPS * M }))) for (let i = 0; i < o.pos.length; i += 3) for (let k = 0; k < 3; k++) { bl[k] = Math.min(bl[k], o.pos[i + k]); bh[k] = Math.max(bh[k], o.pos[i + k]); }
    return { min: bl, max: bh };
  };
  const b0 = boxOfLines(subtract ? lines.slice(0, 1) : lines), c1 = [(b0.min[0] + b0.max[0]) / 2, b0.min[1], (b0.min[2] + b0.max[2]) / 2];
  const body = lines.map((l) => (/^\S/.test(l) ? l.replace(/ at=(-?[\d.e-]+),(-?[\d.e-]+),(-?[\d.e-]+)/, (_, x, y, z) => ` at=${vec(sub([+x, +y, +z], c1))}`) : l));
  // 平移后的数字按档位取整：包络的底面中心离原点还差不到半个取整步长，同样记进原点（编译器就是这样放的）
  const b1 = boxOfLines(subtract ? body.slice(0, 1) : body), c2 = [(b1.min[0] + b1.max[0]) / 2, b1.min[1], (b1.min[2] + b1.max[2]) / 2];
  return { body, shift: add(c1, c2), box: { min: sub(b1.min, c2), max: sub(b1.max, c2) } };
}

// ── 基本体之并：几个基本体的网格拼成的部件（罐 = 圆柱 + 球，火箭 = 两段圆柱 + 整流罩）整体只能拟合成 revolve 或网格，
// 而且源网格里埋在里面的面（球的下半、圆柱的顶盖）解释不了。在非流形边上把网格拆成面片（patches.mjs），
// 相邻的面片两两试着合并，合并后仍是一个好的基本体（盒、圆柱、圆台、球、楔形）就合并，误差最小的先合；
// 最后每一块都得是好的基本体（面积不到 2% 的碎片可以丢下），块数 2–6，写成 group { cyl … ; sphere … }。
// 与现在的写法在这个部件自己的源表面上比评分（同板件），更好才用。参数与 tryPanels 相同。
// 语义档不试：一律用基本体当代理；而且 25 cm 的尺子下，只看这一个部件的局部分数高估了收益（附近的物体本来就解释了它的一部分），
// 宿舍区、H1 的全场分数反而变差（+1.3%、+0.6%）
const UNION_MAX_PATCHES = 16, UNION_MAX_PRIMS = 6; // 面片多于 16 块的很少能拼成几个基本体，却占了大部分时间（两两试合并）
// 几何部分（拆面片、合并、拟合、写出每一块）只取决于三角形与档位，可以在 worker 线程里预先算（fitpool.mjs）：
// 返回 { lines（相对 c0 的语句）, c0, prims } 或 null
export function unionGeometry(tris) {
  if (tris.length < 8) return null;
  const { patches, adj, closed } = patchesOf(tris);
  if (patches.length < 2 || patches.length > UNION_MAX_PATCHES) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) for (const v of tri) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  const c0 = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const local = tris.map((tri) => tri.map((v) => sub(v, c0)));
  const triArea = local.map(([a, b, c]) => len(cross(sub(b, a), sub(c, a))) / 2), areaAll = triArea.reduce((s2, x) => s2 + x, 0);
  // 每个三角形的法线、顶点键只算一次（一块要和别的块反复合并、拟合）
  const triN = local.map(triNormal), vkeys = local.map((t) => t.map(vkey));
  // 一块 = 若干面片；拟合按面片集合记忆（种子取最小的三角形编号，结果与合并的顺序无关）
  const memo = new Map();
  const fitOf = (ids) => {
    const key = [...ids].sort((x, y) => x - y).join();
    if (!memo.has(key)) {
      const ts = [...ids].flatMap((k) => patches[k]).sort((x, y) => x - y);
      const sub3 = ts.map((k) => local[k]);
      memo.set(key, { ts, area: ts.reduce((s2, k) => s2 + triArea[k], 0), fit: sub3.length ? fitPart({ tris: sub3, triN: ts.map((k) => triN[k]), vkeys: ts.map((k) => vkeys[k]) }, ts[0], null, true) : null });
    }
    return memo.get(key);
  };
  const tMerge = Math.min(0.05, FID.fitTol), tKeep = Math.min(0.25, FID.fitTol);
  // 相邻：共用顶点，或者包围盒相距不到容差（不连着的两层：立面的正反两面、贴在一起的两块）
  const pbox = patches.map((ts) => { const b = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] }; for (const k of ts) for (const v of local[k]) for (let d = 0; d < 3; d++) { b.lo[d] = Math.min(b.lo[d], v[d]); b.hi[d] = Math.max(b.hi[d], v[d]); } return b; });
  const gapTol = FID.tau * M;
  for (let a = 0; a < patches.length; a++) for (let b = a + 1; b < patches.length; b++) {
    if ([0, 1, 2].every((d) => pbox[a].lo[d] <= pbox[b].hi[d] + gapTol && pbox[b].lo[d] <= pbox[a].hi[d] + gapTol)) { adj[a].add(b); adj[b].add(a); }
  }
  let blocks = patches.map((_, k) => ({ ids: new Set([k]), adj: new Set(adj[k]) }));
  for (;;) {
    let best = null;
    for (let i = 0; i < blocks.length; i++) for (let j = i + 1; j < blocks.length; j++) {
      const A = blocks[i], B = blocks[j];
      if (![...B.ids].some((k) => A.adj.has(k))) continue;
      // 两块都由封闭的面片组成：各自已是完整的实体，不拼
      if ([...A.ids, ...B.ids].every((k) => closed[k])) continue;
      // 合并后的误差既要小，也不能比两块各自的误差明显变大（两段半径不同的圆柱合起来像一个圆台，平均误差不大，但两块各自是精确的圆柱）
      const f = fitOf(new Set([...A.ids, ...B.ids])).fit, eA = fitOf(A.ids).fit?.e ?? Infinity, eB = fitOf(B.ids).fit?.e ?? Infinity;
      if (f && f.e <= Math.min(tMerge, Math.max(eA, eB) + tMerge / 5) && (!best || f.e < best.e)) best = { i, j, e: f.e };
    }
    if (!best) break;
    const A = blocks[best.i], B = blocks[best.j];
    const C = { ids: new Set([...A.ids, ...B.ids]), adj: new Set([...A.adj, ...B.adj]) };
    blocks = blocks.filter((_, k) => k !== best.i && k !== best.j).concat([C]);
  }
  const kept = [];
  for (const b of blocks) {
    const f = fitOf(b.ids);
    // 不是基本体的一块再试旋转体（火箭的整流罩）；管道、台阶的位置写在父坐标系里，不放进来
    if (f.fit && f.fit.e > tKeep && FID.name !== 'semantic') {
      const rv = fitPart({ tris: f.ts.map((k) => local[k]), noSweep: true }, f.ts[0]);
      if (rv.shape === 'revolve' && rv.e <= tKeep) { kept.push({ ...f, fit: rv }); continue; }
    }
    if (f.fit && f.fit.e <= tKeep) kept.push(f);
    else if (f.area > 0.02 * areaAll) return null;
  }
  if (kept.length < 2 || kept.length > UNION_MAX_PRIMS) return null;
  // 法线整体朝里、又装在另一块里面的一块是空腔的内表面（空心楼的内墙面），不是实心的基本体：并不成立（交给“外壳 − 空腔 − 开口”）。
  // 朝向 = 按面积加权的 法线·(面中心 − 块中心)，与它的绝对值之和相比明显为负才算朝里（正反两面的薄片接近 0）。
  // 单独一块朝里的（房间的内墙面）照旧：现在的写法也是实心的
  const boxOf = (f) => { const b = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] }; for (const k of f.ts) for (const v of local[k]) for (let d = 0; d < 3; d++) { b.lo[d] = Math.min(b.lo[d], v[d]); b.hi[d] = Math.max(b.hi[d], v[d]); } return b; };
  const inward = kept.map((f) => {
    const c = f.fit.frame.c;
    let sum = 0, abs = 0;
    for (const k of f.ts) { const tri = local[k], d = dot(triN[k].n, sub(scl(add(add(tri[0], tri[1]), tri[2]), 1 / 3), c)) * triArea[k]; sum += d; abs += Math.abs(d); }
    return sum < -0.5 * abs;
  });
  const tIn = FID.tau * M;
  for (let i = 0; i < kept.length; i++) if (inward[i]) {
    const A = boxOf(kept[i]);
    if (kept.some((g, j) => j !== i && !inward[j] && (() => { const B = boxOf(g); return [0, 1, 2].every((d) => A.lo[d] >= B.lo[d] - tIn && A.hi[d] <= B.hi[d] + tIn); })())) return null;
  }
  kept.sort((x, y) => y.area - x.area || x.ts[0] - y.ts[0]);
  const count = {};
  const lines = kept.map((f) => {
    const prim = snapUpright(primitiveOf(f.fit, { tris: f.ts.map((k) => local[k]) }, 'x'));
    if (prim.kind === 'mesh' || prim.absolute) return null;
    count[prim.kind] = (count[prim.kind] ?? 0) + 1;
    const nm = count[prim.kind] > 1 ? `${prim.kind}_${count[prim.kind]}` : prim.kind;
    return [prim.kind, nm, ...Object.entries(prim.props).map(([k, v]) => `${k}=${v}`), `at=${vec(prim.at)}`, orientText(prim.cols)].filter(Boolean).join(' ');
  });
  return lines.includes(null) ? null : { lines, c0, prims: kept.length };
}
// pre：worker 预先算好的几何（undefined 表示没有，现算）
function tryUnion(tris, cols, t, part, cur, n = 1, pre = undefined) {
  const g = pre !== undefined ? pre : unionGeometry(tris);
  if (!g) return null;
  const { lines, c0 } = g;
  const { evalLines } = judgeOf(part);
  const total = (ls) => ls.L + n * (ls.R_src + ls.R_recon + ls.R_vol);
  const curS = cur.S ?? (cur.mesh != null ? cur.mesh : (() => { const ls = evalLines([cur.line]); return ls ? total(ls) : Infinity; })());
  const orient = orientText(cols), head = `group g at=${vec(add(t, mvC(cols, c0)))} pin=origin${orient ? ' ' + orient : ''} {`;
  const L = [head, ...lines.map((l) => '  ' + l), '}'];
  if (L.reduce((s2, l) => s2 + lineCost(l), 0) >= curS) return null;
  const ls = evalLines(L);
  if (!ls || total(ls) >= curS) return null;
  const { body: body0, shift, box } = centerBody(lines);
  const body = body0.map((l) => l.replace(/ at=0,0,0(?= |$)/, '')); // 落在原点的那一块不用写位置
  const meanErr = ls.meanErr * M, tau = FID.tau * M;
  return { body, c0: add(c0, shift), box, fit: Math.max(0, Math.min(1, 1 - meanErr / (4 * tau))), meanErr: ls.meanErr, S: +total(ls).toFixed(2), curS: +curS.toFixed(2), prims: g.prims };
}
let PREFIT = null, UNIONS = true, COMPOSITE_MS = { panels: 0, unions: 0, shells: 0 }, UNION_SEEN = new Map();

// ── 外壳 − 空腔 − 开口（panels.mjs 的 shellLines）：空心的楼写成 subtract shell { box outer ; box cavity ; box opening … ; cyl arch … }，
// 楼里的楼板、内墙接着写成板件（外面再包一层 group）。和板件一样在物体坐标系里做、按这个部件自己的源表面比评分。
// 结构档、精细档都试（语义档一律用基本体当代理）；参数与 tryPanels 相同
function tryShell(tris, cols, t, part, cur, n = 1) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) for (const v of tri) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  const c0 = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const local = tris.map((tri) => tri.map((v) => sub(v, c0)));
  const tau = FID.tau * M;
  const sh = shellLines(local, { tau, digits: DIGITS, maxThick: 2 * M, thick: Math.max(2 * FID.tau, 0.1) * M, cell: 2 * tau, maxBoxes: 60 });
  if (!sh) return null;
  const { evalLines } = judgeOf(part);
  const total = (ls) => ls.L + n * (ls.R_src + ls.R_recon + ls.R_vol);
  const curS = cur.S ?? (cur.mesh != null ? cur.mesh : (() => { const ls = evalLines([cur.line]); return ls ? total(ls) : Infinity; })());
  const shellBlock = [`subtract shell at=${vec(sh.at)} {`, ...sh.shell.map((l) => '  ' + l), '}'];
  // 楼里没有别的东西：物体本身就是 subtract；有楼板、内墙：group { subtract shell … ; 板件 }
  const kind = sh.extra.length ? 'group' : 'subtract';
  const lines = sh.extra.length ? [...shellBlock, ...sh.extra] : sh.shell;
  const orient = orientText(cols), head = `${kind} g at=${vec(add(t, mvC(cols, c0)))} pin=origin${orient ? ' ' + orient : ''} {`;
  const L = [head, ...lines.map((l) => '  ' + l), '}'];
  if (L.reduce((s2, l) => s2 + lineCost(l), 0) >= curS) return null;
  const ls = evalLines(L);
  if (!ls || total(ls) >= curS) return null;
  const { body: body0, shift, box } = centerBody(lines, kind === 'subtract');
  const body = body0.map((l) => l.replace(/ at=0,0,0(?= |$)/, ''));
  const meanErr = ls.meanErr * M;
  return { kind, body, c0: add(c0, shift), box, fit: Math.max(0, Math.min(1, 1 - meanErr / (4 * tau))), meanErr: ls.meanErr, S: +total(ls).toFixed(2), curS: +curS.toFixed(2), openings: sh.openings, arches: sh.arches, interior: sh.extra.length > 0 };
}
let SHELLS = true;
const shellWorth = (fit, part, hollow = false) => {
  if (!SHELLS || coarseRole(part) || FID.name === 'semantic' || part.force || part.tris.length < PANEL_MIN_TRIS) return false;
  if (!hollow && 1 - fit.e / TOL >= 0.5 && fit.cover >= COVER_MIN) return false;
  const { min, max } = fit.aabb;
  return Math.max(...sub(max, min)) >= PANEL_MIN_SIZE * M;
};
const unionWorth = (fit, part) => UNIONS && FID.name !== 'semantic' && !coarseRole(part) && !part.force && fit.e > TOL && part.tris.length >= 8;
// 网格引用的代价（与评分的 L_mesh 一样，同一个网格的实例分摊）加上这一行
// 网格的价钱按角色（score.mjs 的 meshPrice；工程可以按角色改，reverse 的 meshPrice 选项）
let MESH_K = SCORE_DEFAULTS;
const meshCostOf = (prim, part) => lineCost(`mesh x src=${prim.props.src} size=${prim.props.size} pivot=${prim.props.pivot}`) + meshPrice(part.tris, roleP(part), MESH_K) / Math.max(1, MESH_USE.get(part.mesh) ?? 1);
// 有内容的物体（板件、基本体之并）：内容接在这一行后面，按缩进写
const bodyOf = (o, ind = '') => (o.body ? [' {', ...o.body.map((l) => ind + '  ' + l), ind + '}'].join('\n') : '');
const primLineOf0 = (prim) => [prim.kind, 'cur', ...Object.entries(prim.props).map(([k, v]) => `${k}=${v}`), prim.absolute ? '' : `at=${vec(prim.at)}`, prim.absolute ? '' : orientText(prim.cols)].filter(Boolean).join(' ');
// 沿圆弧、螺旋的扫掠：曲线语句一起写（两行），名字是临时的
const primLineOf = (prim) => (prim.curve ? [[prim.curve.kind, 'cur_path', ...Object.entries(prim.curve.props).map(([k, v]) => `${k}=${v}`), `at=${vec(prim.curve.at)}`, 'pin=origin', prim.curve.turn].filter(Boolean).join(' '), primLineOf0({ ...prim, props: { ...prim.props, path: 'cur_path' } })].join('\n') : primLineOf0(prim));
// 普通部件换成板件：物体坐标系取拟合的偏航（拟合坐标系直立时），否则世界朝向
// 基本体之并同样（物体坐标系取世界朝向：每一块有自己的朝向）；两种都成立时取分数低的
// 分散的模型（一个节点里装着很多互不相连的块，各块包围盒之和远小于整体：几片外墙、楼梯的零件、散放的杂物）：
// 整体只能套一个虚胖的大包围盒——关系、分区、阵列都被它误导。按连通分量拆开，每块拟合成基本体，写成 group { 各块 }，
// 名字与来源不变。拆开后的局部分数不超过现在写法的 1.25 倍才拆（语义上偏向拆开，但几十片零件写成几十个盒子远比一行网格引用长）；
// 不拆的标上 ~scatter=块数，并且不当别人的参照物（同贴花）。贴花、辅助不拆；块太多（> 60，碎屑）的不拆
const SCATTER_SLACK = 1.25;
const SCATTER_MAX = 60;
function scatterGeometry(tris) {
  const sc = scatterOf({ tris });
  if (!sc.scattered || sc.comps.length > SCATTER_MAX) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const tri of tris) for (const v of tri) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  const c0 = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const count = {};
  const lines = sc.comps.map((ids) => {
    const ts = ids.map((k) => tris[k].map((v) => sub(v, c0)));
    const prim = snapUpright(primitiveOf(fitPart({ tris: ts, noSweep: true }, ids[0], null, true), { tris: ts }, 'x'));
    count[prim.kind] = (count[prim.kind] ?? 0) + 1;
    const nm = count[prim.kind] > 1 ? `${prim.kind}_${count[prim.kind]}` : prim.kind;
    return [prim.kind, nm, ...Object.entries(prim.props).map(([k, v]) => `${k}=${v}`), prim.absolute ? '' : `at=${vec(prim.at)}`, prim.absolute ? '' : orientText(prim.cols)].filter(Boolean).join(' ');
  });
  if (lines.some((l) => !/^(box|cyl|cone|sphere|wedge) /.test(l))) return null;
  const { body: body0, shift, box } = centerBody(lines);
  return { body: body0.map((l) => l.replace(/ at=0,0,0(?= |$)/, '')), c0: add(c0, shift), box, n: lines.length };
}
// 拆开的写法（物体坐标系里、相对 g.c0）与现在的写法比局部分数；n：类型的实例数
function scatterAccept(g, part, cur, n = 1) {
  const { evalLines } = judgeOf(part);
  const total = (ls) => ls.L + n * (ls.R_src + ls.R_recon + ls.R_vol);
  const curS = cur.S ?? (cur.mesh != null ? cur.mesh : (() => { const ls = evalLines([cur.line]); return ls ? total(ls) : Infinity; })());
  const ls = evalLines([`group g at=${vec(g.c0)} {`, ...g.body.map((l) => '  ' + l), '}']);
  return !!ls && total(ls) <= SCATTER_SLACK * curS;
}
// 分散、但没拆开的部件（块数）：不当别人的参照物
let SCATTERED = new WeakMap();

// ── 部件当小场景（大部件的拆解）──
// 结构、地形里拟合不好的大部件（整栋楼的外墙壳、桁架塔、一圈弧形扶手）：网格按真实信息量计价，不能再退回网格引用，
// 而一个粗糙的基本体既对不上表面、又把楼里的空间填实了（R_vol）。先把它拆成块——互不相连的分量；只有一块时用板件分解出的盒子——
// 再把这些块交给逆向管线本身（拟合、阵列、镜像、关系），写成一个组：一排等距的肋条成了一条 repeat，桁架的横杆、扶手的立柱同样，
// 单块照常试扫掠、旋转体、台阶。递归一层：子场景里不再拆子场景。与现在的写法比局部分数（同板件），更低才用
// 门槛：已经认出来的形状（台阶、管、扫掠、旋转体）不拆；现在的写法分数不到 SUB_MIN_S 的不拆（子场景至少好几行，每行 8–10，赢不了）
const SUB_MAX_PIECES = 400, SUB_MIN_S = 120;
// SUB_WHOLE：正在拆的大部件的表面积（子场景里各块的局部评分按面积分到这个部件的那一份权重，见 neighborhoodScorer 的 whole）
let SUB_DEPTH = 0, SUBS = true, SUB_WHOLE = null;
const subSceneWorth = (fit, part, hollow = false) => SUBS && SUB_DEPTH === 0 && !['steps', 'tube', 'sweep', 'revolve'].includes(fit.shape) && !coarseRole(part) && !part.force && FID.name !== 'semantic' && meshPriceMode(roleP(part), MESH_K) === 'full'
  && part.tris.length >= PANEL_MIN_TRIS && (hollow || !(1 - fit.e / TOL >= 0.5 && fit.cover >= COVER_MIN)) && Math.max(...sub(fit.aabb.max, fit.aabb.min)) >= PANEL_MIN_SIZE * M;
// 结构与功能的硬规则：大的实心基本体（盒、圆柱、楔形……体积超过 8 m³）里，超过 30% 落在源模型的实体外面（空心楼的内部、
// 坡道下面的空间被填实了）就不能用——人、AI 都会以为那里走不进去。这时板件、外壳、小场景都要试（不管拟合好坏），
// 现在的写法按分数无穷大算：拆得出来就用拆出来的。分数本身也会罚它（R_vol），但大部件拆开写很长，单凭分数实心盒子有时还是赢
const HOLLOW_FRAC = 0.3, HOLLOW_MIN_VOL = 8;
const SOLID_KINDS = new Set(['box', 'cyl', 'cone', 'wedge', 'sphere']);
function hollowSolid(prim, part) {
  if (!SOLID_KINDS.has(prim.kind) || coarseRole(part) || part.force || !prim.box) return false;
  const b = prim.box, vol = (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);
  if (!(vol >= HOLLOW_MIN_VOL * M * M * M)) return false;
  const ls = judgeOf(part).evalLines([primLineOf(prim)]);
  return !!ls && ls.volWrong > HOLLOW_FRAC;
}
// 一组块（每块一组三角形，坐标在 frame 里）→ 子场景的语句（相对 c0：全部块的包络底面中心）。模块里的状态（各种缓存、当前设置）存下、做完恢复
// ctx（同一种拆法的几个变体共用）：c0 用全部块的；area 是整个部件的表面积——全场评分里这个部件是一个整体，各块的局部评分按它分权重
function subSceneLines(pieces, part, ctx) {
  const c0 = ctx.c0;
  // 材质同这个部件，设成默认材质：组里的语句不写 mat=，继承组的材质
  // 名字：板件分解出来的块带着 wall、slab 这类名字（挂在三角形数组的 name 上）；分量没有名字
  // 原样保留的块（tris.keep：板件已经写好的“大矩形挖洞”，重新拟合会丢掉洞）不交给逆向
  const kept = pieces.filter((t) => t.keep), fitted = pieces.filter((t) => !t.keep);
  const mk = (tris) => ({ name: tris.name ?? null, tris: tris.map((tri) => tri.map((v) => sub(v, c0))), role: roleP(part), material: part.material ?? { name: null, color: '#c9c9c9' } });
  const subParts = fitted.map((tris) => { if (!ctx.parts.has(tris)) ctx.parts.set(tris, mk(tris)); return ctx.parts.get(tris); });
  let lines = [];
  if (subParts.length) {
    const saved = [SUB_WHOLE, FID, S, M, DIGITS, SUBS, PARTS_FILE, PANELS, UNIONS, PREFIT, SHELLS, COMPOSITE_MS, UNION_SEEN, SWEEP_SEEN, SWEEP_FAILED, MESH_USE, JUDGES, SCATTERED, PART_ROLE, HEIGHT, cleanName, MESH_K];
    SUB_DEPTH++;
    SUB_WHOLE = { area: ctx.area };
    let out;
    const t0 = performance.now();
    try {
      out = reverse(subParts, { srcFile: 'x', level: 'L1', fidelity: FID.name, unit: 1 / M, types: false, defaultMaterial: true, names: false, meshPrice: MESH_K.meshPrice, panels: PANELS, shells: SHELLS, unions: UNIONS });
    } finally {
      [SUB_WHOLE, FID, S, M, DIGITS, SUBS, PARTS_FILE, PANELS, UNIONS, PREFIT, SHELLS, COMPOSITE_MS, UNION_SEEN, SWEEP_SEEN, SWEEP_FAILED, MESH_USE, JUDGES, SCATTERED, PART_ROLE, HEIGHT, cleanName, MESH_K] = saved;
      SUB_DEPTH--;
    }
    COMPOSITE_MS.subRev = (COMPOSITE_MS.subRev ?? 0) + performance.now() - t0;
    // 去掉材质声明与 mat=（各块的材质都同这个部件，继承组的材质）、拟合度这类元数据
    lines = out.src.split('\n').filter((l) => l.trim() && !/^\s*\/\//.test(l) && !/^material /.test(l)).map((l) => l.replace(/ ~(fit|err|src|scatter)=("[^"]*"|\S+)/g, '').replace(/ mat=\S+/g, ''));
    if (lines.some((l) => /^\s*mesh /.test(l))) return null;
  }
  // 原样保留的块接在后面：顶层的 at= 平移到 c0；名字和别的语句冲突时改名
  const used = new Set(lines.filter((l) => /^\S/.test(l)).map((l) => l.split(/\s+/)[1]));
  for (const t of kept) {
    const [head, ...body] = t.keep, nm = head.split(/\s+/)[1];
    let nn = nm;
    for (let k = 2; used.has(nn); k++) nn = `${nm}_${k}`;
    used.add(nn);
    lines.push(head.replace(` ${nm} `, ` ${nn} `).replace(/ at=(-?[\d.e-]+),(-?[\d.e-]+),(-?[\d.e-]+)/, (_, x, y, z) => ` at=${vec(sub([+x, +y, +z], c0))}`), ...body);
  }
  // 摊平：顶层放在原点、不带别的属性的组（板件、并写出来的组，内容已按包络的底面中心摆好）把内容提上来；名字冲突时不摊平
  const names = () => new Set(lines.filter((l) => /^\S/.test(l)).map((l) => l.split(/\s+/)[1]));
  for (let i = 0; i < lines.length; i++) {
    if (!/^group \S+ at=0,0,0 \{$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j] !== '}') j++;
    const body = lines.slice(i + 1, j).map((l) => l.replace(/^  /, '')), own = new Set(body.filter((l) => /^\S/.test(l)).map((l) => l.split(/\s+/)[1]));
    const rest = names();
    rest.delete(lines[i].split(/\s+/)[1]);
    const ref = new RegExp(`=${lines[i].split(/\s+/)[1]}(?![\\w])`);
    if ([...own].some((n) => rest.has(n)) || lines.some((l, k) => k !== i && ref.test(l))) continue;
    lines = [...lines.slice(0, i), ...body, ...lines.slice(j + 1)];
    i += body.length - 1;
  }
  return { lines, c0 };
}
// 子场景的候选：分量（2–400 块）；只有一块时，板件分解的盒子（格子从细到粗）。frame 里的三角形 ftris，cols、cur 同 tryPanels。
// 返回 { body, at（frame 里，组的包络底面中心）, box, S, curS, pieces } 或 null
// n：类型的实例数（残差按实例数计，描述只写一次）
function trySubScene(ftris, part, cur, n = 1) {
  const { evalLines } = judgeOf(part);
  const total = (ls) => ls.L + n * (ls.R_src + ls.R_recon + ls.R_vol);
  // cur.S：已经有更好的候选（板件、外壳、并）时直接给它的分数
  const curS = cur.S ?? (cur.mesh != null ? cur.mesh : (() => { const ls = evalLines([cur.line]); return ls ? total(ls) : Infinity; })());
  if (curS < SUB_MIN_S) return null;
  const tries = [];
  const sc = scatterOf({ tris: ftris });
  if (sc.comps && sc.comps.length >= 2 && sc.comps.length <= SUB_MAX_PIECES) tries.push(sc.comps.map((ids) => ids.map((i) => ftris[i])));
  else if (!sc.comps || sc.comps.length < 2) {
    const tau = FID.tau * M, opts = { thick: Math.max(2 * FID.tau, 0.1) * M, maxThick: 1 * M, digits: DIGITS };
    for (const cell of [8 * tau, 4 * tau, 2 * tau]) { // 粗的先试（便宜，先给出一个好的分数）
      const p = panelLines(ftris, { ...opts, cell, maxBoxes: SUB_MAX_PIECES });
      if (!p) continue;
      // 按语句分块：单行的盒子、楔形各是一块（交给子场景找阵列、关系）；多行的（subtract：大矩形挖洞）原样保留
      const blocks = [];
      for (let i = 0; i < p.lines.length; i++) {
        if (!p.lines[i].endsWith('{')) { blocks.push([p.lines[i]]); continue; }
        let j = i;
        while (j < p.lines.length && p.lines[j] !== '}') j++;
        blocks.push(p.lines.slice(i, j + 1));
        i = j;
      }
      const pieces = blocks.map((b) => {
        const t = [];
        for (const o of sceneObjects(compile(b.join('\n'), { factEps: FACT_EPS * M }))) for (let i = 0; i < o.pos.length; i += 9) t.push([[o.pos[i], o.pos[i + 1], o.pos[i + 2]], [o.pos[i + 3], o.pos[i + 4], o.pos[i + 5]], [o.pos[i + 6], o.pos[i + 7], o.pos[i + 8]]]);
        t.name = b[0].split(/\s+/)[1].replace(/_\d+$/, '');
        if (b.length > 1) t.keep = b;
        return t;
      }).filter((t) => t.length);
      if (pieces.length >= 2) tries.push(pieces);
    }
  }
  // 按面积只留大块（同 refine 的候选）：外墙壳的主体是几面墙、屋顶与楼板，细碎的小板、小洞写出来不划算的，比分数时自然舍掉。
  // 粗的先试：它们便宜，先得到一个好的分数，细的候选描述长度超过它就不必评残差
  const areaOfT = (ts) => ts.reduce((a, [p, q, r]) => a + len(cross(sub(q, p), sub(r, p))) / 2, 0);
  // 每组（一种拆法）里的变体从粗到细；同一组里细的块更多、描述只会更长：描述长度已经超过最好的分数、
  // 或者总分比上一个（更粗的）还差，更细的就不再试（子场景的逆向是这里的大头）
  // 只有小块（最大尺寸不到 1 m）可以舍：面积小、却又高又显眼的块（高架下的支柱）舍掉就“少东西”了（compare 的验收）
  const extentOf = (ts) => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (const t of ts) for (const v of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); } return Math.max(...sub(hi, lo)); };
  const lists = tries.map((pieces) => {
    const big = pieces.filter((ts) => extentOf(ts) >= 1 * M), small = pieces.filter((ts) => extentOf(ts) < 1 * M);
    const byArea = small.map((ts) => ({ ts, a: areaOfT(ts) })).sort((x, y) => y.a - x.a), all = byArea.reduce((a, x) => a + x.a, 0) + big.reduce((a, ts) => a + areaOfT(ts), 0), vs = [];
    const bigArea = all - byArea.reduce((a, x) => a + x.a, 0);
    for (const q of [0.75, 0.9, 0.97]) {
      let acc = bigArea, k = 0;
      while (k < byArea.length && acc < q * all) acc += byArea[k++].a;
      if (big.length + k >= 1 && k < small.length && !vs.some((v) => v.length === big.length + k)) vs.push([...big, ...byArea.slice(0, k).map((x) => x.ts)]);
    }
    vs.push(pieces);
    return vs;
  });
  let best = null;
  const area = areaOfT(ftris);
  for (const vs of lists) {
    let prev = Infinity;
    const all = vs[vs.length - 1], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const tris of all) for (const tri of tris) for (const v of tri) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    const ctx = { c0: [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2], area, parts: new WeakMap() };
    for (const pieces of vs) {
      COMPOSITE_MS.subCalls = (COMPOSITE_MS.subCalls ?? 0) + 1;
      const sub0 = subSceneLines(pieces, part, ctx);
      if (!sub0) continue;
      const L = sub0.lines.reduce((a, l) => a + lineCost(l), 0);
      if (L >= Math.min(curS, best?.S ?? Infinity)) break;
      const t1 = performance.now(), ls = evalLines([`group g at=${vec(sub0.c0)} pin=origin {`, ...sub0.lines.map((l) => '  ' + l), '}']);
      COMPOSITE_MS.subEval = (COMPOSITE_MS.subEval ?? 0) + performance.now() - t1;
      if (!ls) continue;
      const S0 = total(ls);
      if (S0 < Math.min(curS, best?.S ?? Infinity)) best = { S: S0, ls, ...sub0, pieces: pieces.length };
      if (S0 > prev) break;
      prev = S0;
    }
  }
  if (!best) return null;
  // 组按包络的底面中心放：语句不动，组的位置 = c0 + 语句包络的底面中心
  const bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
  for (const o of sceneObjects(compile(best.lines.join('\n'), { factEps: FACT_EPS * M }))) for (let i = 0; i < o.pos.length; i += 3) for (let k = 0; k < 3; k++) { bl[k] = Math.min(bl[k], o.pos[i + k]); bh[k] = Math.max(bh[k], o.pos[i + k]); }
  const c1 = [(bl[0] + bh[0]) / 2, bl[1], (bl[2] + bh[2]) / 2];
  return { body: best.lines, at: add(best.c0, c1), box: { min: sub(bl, c1), max: sub(bh, c1) }, S: +best.S.toFixed(2), curS: +curS.toFixed(2), pieces: best.pieces, meanErr: best.ls.meanErr };
}
const fitScoreOf = (fit) => Math.max(0, Math.min(1, 1 - fit.e / TOL));
// 贴花按引用价时保留网格；按真实信息量计价时，散成几片的贴花同样拆成一组薄块
const scatterWorth = (part) => !part.force && part.tris.length >= 6 && roleP(part) !== 'helper' && !(roleP(part) === 'decal' && meshPriceMode('decal', MESH_K) === 'ref');

function panelPrim(fit, part, prim, partIndex = -1) {
  // 已经认出来的（台阶、管道、扫掠、拟合得好的基本体）不拆
  // 分散的模型拆成一组基本体（每个分量一块）；能当小场景拆的（结构的大部件）先试小场景——它按分量拆、每块完整地拟合、再比分数，
  // 包括了这种写法——没有结果时才退回这里（见函数末尾）
  const hollow = hollowSolid(prim, part);
  const subOK = subSceneWorth(fit, part, hollow);
  const tryScatter = () => {
    if (!(scatterWorth(part) && !['steps', 'tube', 'sweep'].includes(fit.shape) && (hollow || fit.e > TOL || fit.cover < COVER_MIN))) return null;
    const g = scatterGeometry(part.tris);
    if (!g) return null;
    const cur0 = hollow ? { S: Infinity } : prim.kind === 'mesh' ? { mesh: meshCostOf(prim, part) } : { line: primLineOf(prim) };
    if (scatterAccept(g, part, cur0)) return { kind: 'group', props: {}, body: g.body, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: g.c0, box: g.box, fit: fitScoreOf(fit), err: fit.e, scatter: { blocks: g.n } };
    SCATTERED.set(part, g.n);
    return null;
  };
  if (!subOK) { const sc = tryScatter(); if (sc) return sc; }
  const cur = hollow ? { S: Infinity } : prim.kind === 'mesh' ? { mesh: meshCostOf(prim, part) } : { line: primLineOf(prim) };
  let out = null;
  const better = (S) => !out || S < (out.panels ?? out.union ?? out.shell ?? out.sub).S;
  const up = fit.frame.cols[1];
  const fcols = up[1] > 0.999 ? fit.frame.cols : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const ftris = panelsWorth(fit, part, hollow) || shellWorth(fit, part, hollow) || subOK ? part.tris.map((tri) => tri.map((v) => mvT(fcols, v))) : null;
  if (panelsWorth(fit, part, hollow)) {
    const t0 = performance.now(), pb = tryPanels(ftris, fcols, [0, 0, 0], part, cur);
    COMPOSITE_MS.panels += performance.now() - t0;
    if (pb) out = { kind: 'group', props: {}, body: pb.body, cols: fcols, at: mvC(fcols, pb.c0), box: pb.box, fit: pb.fit, err: fit.e, panels: { S: pb.S, was: pb.curS, kind: prim.kind } };
  }
  if (shellWorth(fit, part, hollow)) {
    const t0 = performance.now(), sb = tryShell(ftris, fcols, [0, 0, 0], part, cur);
    COMPOSITE_MS.shells += performance.now() - t0;
    if (sb && better(sb.S)) out = { kind: sb.kind, props: {}, body: sb.body, cols: fcols, at: mvC(fcols, sb.c0), box: sb.box, fit: sb.fit, err: fit.e, shell: { S: sb.S, was: sb.curS, kind: prim.kind, openings: sb.openings, arches: sb.arches, interior: sb.interior } };
  }
  if (unionWorth(fit, part)) {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    // 几何部分：worker 预先算好的；或者同一个网格、同样的旋转与缩放（没成类型的享元：拟合差，各实例分开写）
    // 只差一个平移，几何平移过去就是（评分每个实例照做：各实例现在的写法不一样）
    const Mx = part.matrix, key = part.mesh != null && Mx ? `${part.mesh}|${[0, 1, 2, 4, 5, 6, 8, 9, 10].map((k) => Math.round(Mx[k] * 1e6)).join()}` : null;
    const t0 = performance.now();
    let pre = PREFIT?.unionOf?.(part, partIndex);
    if (pre === undefined && key) {
      if (!UNION_SEEN.has(key)) UNION_SEEN.set(key, { g: unionGeometry(part.tris), t: [Mx[12], Mx[13], Mx[14]] });
      const c = UNION_SEEN.get(key);
      pre = c.g && { ...c.g, c0: add(sub(c.g.c0, c.t), [Mx[12], Mx[13], Mx[14]]) };
    }
    const ub = tryUnion(part.tris, I, [0, 0, 0], part, cur, 1, pre);
    COMPOSITE_MS.unions += performance.now() - t0;
    if (ub && better(ub.S)) out = { kind: 'group', props: {}, body: ub.body, cols: I, at: ub.c0, box: ub.box, fit: ub.fit, err: fit.e, union: { S: ub.S, was: ub.curS, kind: prim.kind, prims: ub.prims } };
  }
  if (subOK) {
    const t0 = performance.now(), gb = trySubScene(ftris, part, out ? { line: null, S: (out.panels ?? out.union ?? out.shell).S } : cur);
    COMPOSITE_MS.subs = (COMPOSITE_MS.subs ?? 0) + performance.now() - t0;
    COMPOSITE_MS.subTried = (COMPOSITE_MS.subTried ?? 0) + 1;
    if (gb && better(gb.S)) out = { kind: 'group', props: {}, body: gb.body, cols: fcols, at: mvC(fcols, gb.at), box: gb.box, fit: Math.max(0, Math.min(1, 1 - (gb.meanErr * M) / (4 * FID.tau * M))), err: fit.e, sub: { S: gb.S, was: gb.curS, kind: prim.kind, pieces: gb.pieces } };
  }
  // 小场景、板件、外壳、并都没有结果：退回分散模型的写法（开头跳过了）
  if (!out && subOK) return tryScatter();
  return out;
}

// 朝向（列为局部轴）→ turn / rot 文本；R 是 3×3（行主序），由列构造
const toRows = (cols) => [0, 1, 2].map((i) => cols.map((c) => c[i]));
export function orientText(cols) {
  const R = toRows(cols);
  if (Math.abs(R[1][1] - 1) < 1e-6) {
    const yaw = (Math.atan2(R[0][2], R[0][0]) * 180) / Math.PI;
    const yt = fmtA(yaw);
    return Math.abs(+yt) < 1e-4 ? '' : `turn=${yt}`;
  }
  const tr = R[0][0] + R[1][1] + R[2][2];
  const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
  let axis;
  if (Math.abs(Math.sin(ang)) > 1e-6) axis = [R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]];
  else { const i = [0, 1, 2].reduce((b, k) => (R[k][k] > R[b][b] ? k : b), 0); axis = [0, 1, 2].map((k) => R[k][i] + (k === i ? 1 : 0)); }
  // 方向用 6 位小数：长物体或远离支点的成员，方向的微小误差会被放大成毫米级的位置误差
  const ax = unit(axis);
  return `rot=(${FID.angle ? ax.map((v) => String(Math.round(v * 1000) / 1000 || 0)).join(',') : vec6(ax)},${fmtA((ang * 180) / Math.PI)})`;
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

// 同一种盒子（形状、材质相同，三边排序后相同）的轴标注统一：倾斜的盒子按“最朝上的轴是 y”标注，
// 坡度不同时同一种盒子会写出不同的尺寸顺序（过山车的枕木在陡坡处厚度与宽度互换），阵列检测就认不出它们是同一种。
// 倾斜的成员改用该组多数成员的标注；直立的成员不动（它们的 y 就是站立方向，on 关系依赖它）
function unifyBoxLabels(objs) {
  const sizes = (o) => o.props.size.split(',').map(Number);
  const close = (a, b) => Math.abs(a - b) < 0.01 * S + 0.005 * Math.abs(a);
  const groups = [];
  for (const o of objs) {
    if (o.kind !== 'box') continue;
    const sorted = [...sizes(o)].sort((a, b) => a - b);
    const g = groups.find((x) => x.mat === JSON.stringify(o.material) && x.sorted.every((v, i) => close(v, sorted[i])));
    if (g) g.items.push(o); else groups.push({ mat: JSON.stringify(o.material), sorted, items: [o] });
  }
  for (const g of groups) {
    if (g.items.length < 3) continue;
    // 目标标注：有直立成员时以直立成员为准（它们的 y 是站立方向，最有意义；风车三片叶片里竖直的那一片），
    // 否则按多数（过山车枕木）；按尺寸顺序计票
    const upright = g.items.filter((o) => Math.abs(o.cols[1][1]) > 1 - 1e-9);
    const votes = new Map();
    for (const o of upright.length ? upright : g.items) { const k = sizes(o).map((v) => g.sorted.findIndex((x) => close(x, v))).join(','); votes.set(k, (votes.get(k) ?? 0) + 1); }
    const [best] = [...votes].sort((a, b) => b[1] - a[1])[0];
    const target = best.split(',').map(Number).map((i) => g.sorted[i]);
    for (const o of g.items) {
      const sz = sizes(o);
      if (Math.abs(o.cols[1][1]) > 1 - 1e-9 || sz.every((v, i) => close(v, target[i]))) continue;
      // 找排列 π：新轴 i 用旧轴 π[i]
      const pi = [], used = new Set();
      for (let i = 0; i < 3; i++) { const j = [0, 1, 2].find((jj) => !used.has(jj) && close(sz[jj], target[i])); if (j == null) break; pi.push(j); used.add(j); }
      if (pi.length < 3) continue;
      const c = centerOf(o);
      let cols = pi.map((j) => o.cols[j]);
      if (dot(cols[0], cross(cols[1], cols[2])) < 0) cols = [cols[0], cols[1], scl(cols[2], -1)];
      const hh = pi.map((j) => sz[j]);
      o.cols = cols;
      o.props = { ...o.props, size: vec(hh) };
      o.box = { min: [-hh[0] / 2, 0, -hh[2] / 2], max: [hh[0] / 2, hh[1], hh[2] / 2] };
      o.at = sub(c, scl(cols[1], hh[1] / 2));
    }
  }
}

// ───────── 3 & 4. 关系与校验 ─────────
export function reverse(parts, { srcFile = 'source.glb', level = 'L0', compress = true, names = true, previous = null, fidelity = 'detail', unit: sceneUnit = 1, types: useTypes = true, decisions = null, prefit = null, partsFile = null, defaultMaterial = true, panels = true, unions = true, shells = true, subs = true, nameStats = null, typeSeed = null, roles: roleRules = null, meshPrice: meshPriceCfg = null } = {}) {
  setFidelity(fidelity, sceneUnit);
  MESH_K = { ...SCORE_DEFAULTS, meshPrice: meshPriceCfg ?? {} };
  PARTS_FILE = partsFile;
  PANELS = panels;
  UNIONS = unions;
  PREFIT = prefit;
  SHELLS = shells;
  SUBS = subs;
  COMPOSITE_MS = { panels: 0, unions: 0, shells: 0 };
  UNION_SEEN = new Map();
  SWEEP_SEEN = new Map();
  SWEEP_FAILED = new Set();
  MESH_USE = new Map();
  JUDGES = new WeakMap();
  SCATTERED = new WeakMap();
  HEIGHT = heightField(parts);
  for (const p of parts) if (p.mesh != null) MESH_USE.set(p.mesh, (MESH_USE.get(p.mesh) ?? 0) + 1);
  // 决定层：先作用到源部件上（忽略、合并、指定形状 / 名字 / 类型名），锁定在最后按上一次的结果替换
  let decided = null;
  const decs = decisions ? parseDecisions(decisions) : [];
  if (decs.length) { decided = applyDecisions(parts, decs); parts = decided.parts; }
  // 角色（roles.mjs）：部件带着 role 就用（工程按 roles.json 判好的），否则按 roleRules 现判。不改部件对象（并行拟合按对象认部件）
  PART_ROLE = new WeakMap();
  { const rs = parts.every((p) => p.role) ? parts.map((p) => p.role) : assignRoles(parts, roleRules); parts.forEach((p, i) => PART_ROLE.set(p, rs[i])); }
  const helpers = parts.filter((p) => roleP(p) === 'helper');
  // 分块逆向（tiles.mjs）：名字清理按全场的名字统计，各块一致
  cleanName = nameCleaner(nameStats ?? parts.map((p) => p.name));
  // 计时：S3D_TIMING=1 时把各阶段耗时打到 stderr（实战里定位瓶颈用）
  const T0 = performance.now(), lap = (what) => process.env.S3D_TIMING && (!SUB_DEPTH || process.env.S3D_TIMING_SUB) && console.error(`[reverse] ${what} ${Math.round(performance.now() - T0)}ms`);
  // ── 享元：同一个网格（加同样的缩放、同样的镜像）被多个节点用到 → 一个类型（def），只拟合一次 ──
  const typeOf = new Map(), types = [];
  if (useTypes) {
    const groups = new Map();
    parts.forEach((p, i) => {
      const tk = typeKey(p, roleP(p));
      if (!tk) return;
      if (!groups.has(tk.key)) groups.set(tk.key, []);
      groups.get(tk.key).push({ i, R: tk.R, t: tk.t });
    });
    const typeNames = new Set();
    for (const [key, ms] of groups) {
      if (ms.length < 2) continue;
      const rep = parts[ms[0].i], { R, t } = ms[0];
      // 类型坐标系 = 网格自己的坐标系（含缩放）：world = R·local + t
      const local = rep.tris.map((tri) => tri.map((v) => mvT(R, sub(v, t))));
      // 局部坐标：不带矩阵（并的缓存按矩阵认同一个网格的世界坐标实例）；类型的代表不试扫掠（扫掠写在世界坐标里，做不成类型，享元就散了）
      // 采样种子：默认取第一个实例的序号；分块逆向时取网格编号的哈希（各块里同一个网格写出同样的类型体，合并时去重）
      const fit = fitPart({ ...rep, tris: local, matrix: null, noSweep: true, role: roleP(rep) }, typeSeed === 'mesh' ? meshSeed(rep.mesh) : ms[0].i);
      const bad = fit.e > FID.fitTol || fit.cover < COVER_MIN || fit.shape === 'tube' || fit.shape === 'sweep';
      // 板件：拟合差的类型（一栋楼被多处使用）在类型坐标系里拆成墙板、楼板，和现在的写法（基本体，或各实例引用网格）比
      const typePart = { ...rep, tris: local, matrix: null, role: roleP(rep) };
      const prim0T = primitiveOf(fit, { ...rep, name: null }, srcFile), hollowT = !bad && hollowSolid(prim0T, typePart);
      // 拟合差的：引用价时现在的写法是各实例引用网格；按真实信息量计价时不退回网格，现在的写法就是那个（差的）基本体
      const curT = hollowT ? { S: Infinity } : bad && meshPriceMode(roleP(typePart), MESH_K) === 'ref' ? { mesh: meshPrice(rep.tris, roleP(typePart), MESH_K) + ms.length * lineCost('src="x" size=1,1,1 pivot=1,1,1') } : { line: primLineOf(prim0T) };
      const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      // 分散的类型体：能当小场景拆的先试小场景（同普通部件），没有结果时才退回分散的写法（见下）
      const subOK = subSceneWorth(fit, typePart, hollowT);
      const scatterT = () => {
        const g = scatterWorth(typePart) && !['steps', 'tube', 'sweep'].includes(fit.shape) && (hollowT || fit.e > TOL || fit.cover < COVER_MIN) ? scatterGeometry(local) : null;
        if (g && !scatterAccept(g, typePart, curT, ms.length)) { for (const m of ms) SCATTERED.set(parts[m.i], g.n); return null; }
        return g;
      };
      let sg = subOK ? null : scatterT();
      const pb = !sg && panelsWorth(fit, typePart, hollowT) ? tryPanels(local, I3, [0, 0, 0], typePart, curT, ms.length) : null;
      // 基本体之并（类型体是几个基本体）：两种都成立时取分数低的
      const ub = !sg && unionWorth(fit, typePart) ? tryUnion(local, I3, [0, 0, 0], typePart, curT, ms.length) : null;
      const sb = !sg && shellWorth(fit, typePart, hollowT) ? tryShell(local, I3, [0, 0, 0], typePart, curT, ms.length) : null;
      // 大部件当小场景（同普通部件）：和板件、并、外壳里最好的那个比
      const best0 = [pb, ub, sb].filter(Boolean).sort((x, y) => x.S - y.S)[0];
      const gs = !sg && subOK ? trySubScene(local, typePart, best0 ? { S: best0.S } : curT, ms.length) : null;
      const gb = gs && { kind: 'group', c0: gs.at, box: gs.box, body: gs.body, fit: Math.max(0, Math.min(1, 1 - (gs.meanErr * M) / (4 * FID.tau * M))), S: gs.S, curS: gs.curS, pieces: gs.pieces };
      if (subOK && !gb && !best0) sg = scatterT();
      const cb = sg ? { ...sg, kind: 'group', fit: 1 - fit.e / TOL } : [pb, ub, sb, gb].filter(Boolean).sort((x, y) => x.S - y.S)[0] ?? null;
      // 拟合不了的：引用价时退回各实例的网格引用，不做类型；按真实信息量计价时类型体就是那个基本体（不退回网格）
      if (bad && !cb && meshPriceMode(roleP(rep), MESH_K) === 'ref') continue;
      let prim, c0, lo, hi;
      if (cb) {
        c0 = cb.c0; lo = add(c0, cb.box.min); hi = add(c0, cb.box.max);
        prim = { kind: cb.kind ?? 'group', props: {}, body: cb.body, cols: I3, at: c0, box: cb.box, ...(cb.n ? { scatter: { blocks: cb.n } } : cb === ub ? { union: { S: ub.S, was: ub.curS, prims: ub.prims } } : cb === sb ? { shell: { S: sb.S, was: sb.curS, openings: sb.openings, arches: sb.arches, interior: sb.interior } } : cb === gb ? { sub: { S: gb.S, was: gb.curS, pieces: gb.pieces } } : { panels: { S: pb.S, was: pb.curS } }) };
      } else {
        prim = primitiveOf(fit, { ...rep, name: null }, srcFile);
        // 类型体的原点放在包络的底面中心：实例的定位规则就和普通基本体一样
        const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => add(prim.at, mvC(prim.cols, [0, 1, 2].map((k) => ((b >> k) & 1 ? prim.box.max[k] : prim.box.min[k])))));
        lo = [0, 1, 2].map((k) => Math.min(...corners.map((c) => c[k]))); hi = [0, 1, 2].map((k) => Math.max(...corners.map((c) => c[k])));
        c0 = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
      }
      const base = ms.map((m) => parts[m.i].typeName).find(Boolean) ?? cleanName(rep.name) ?? `type_${types.length + 1}`;
      let name = sanitize(base), k2 = 2;
      while (typeNames.has(name) || KINDS_RESERVED.has(name)) name = `${sanitize(base)}_v${k2++}`;
      typeNames.add(name);
      const T = { name, prim, c0, box: { min: sub(lo, c0), max: sub(hi, c0) }, fit: cb ? { ...fit, e: TOL * (1 - cb.fit) } : fit, count: ms.length };
      types.push(T);
      for (const m of ms) typeOf.set(m.i, { T, R: m.R, t: m.t });
    }
  }
  // prefit：worker 线程里预先算好的拟合（fitpool.mjs，部件很多时），结果与这里现算的一样
  // worker 预先拟合时不知道角色：装饰、贴花拿到的扫掠不用，现拟合（与单线程一样）
  const preOf = (p, i) => { const f = !p.force && prefit?.fitOf(p, i); return f && !(f.shape === 'sweep' && coarseRole(p)) ? f : null; };
  // preUsed：用了 worker 的拟合的部件——它们的组合写法也可以取 worker 预先算好的（prefitComposite）
  const preUsed = new Set();
  const fits = parts.map((p, i) => { if (typeOf.has(i) || roleP(p) === 'helper') return null; const f = preOf(p, i); if (f) { preUsed.add(i); return f; } return fitPart(p, i, PRIMS.has(p.force) ? p.force : null); });
  lap(`拟合 ${parts.length} 个部件（${types.length} 种类型覆盖 ${typeOf.size} 个实例）`);
  // 名字：L0 用源节点名；没有名字时按形状编号
  const used = new Map(), counters = {};
  const reserved = new Set(parts.filter((p) => p.forceName).map((p) => sanitize(p.forceName)));
  const uniqueId = (id, own = false) => { if (!own && reserved.has(id) && !used.has(id)) used.set(id, 1); if (used.has(id)) { const n = used.get(id) + 1; used.set(id, n); return `${id}_${n}`; } used.set(id, 1); return id; };
  // 角色写进元数据（结构是默认，不写）
  const metaOf = (p) => { const m = roleP(p) === 'structure' ? p.meta : { role: roleP(p), ...(p.meta ?? {}) }; return SCATTERED.has(p) ? { ...(m ?? {}), scatter: SCATTERED.get(p) } : m; };
  const objs = parts.map((p, i) => {
    if (roleP(p) === 'helper') return null;
    const ty = typeOf.get(i);
    if (ty) {
      // 类型的实例：位姿就是节点的刚体变换
      const { T, R, t } = ty, b = T.box;
      return { id: uniqueId(sanitize(cleanName(p.name) ?? T.name)), src: p.uid ?? p.name ?? null, meta: metaOf(p), role: roleP(p), scattered: SCATTERED.has(p), material: p.material, kind: T.name, props: {}, cols: R, at: add(t, mvC(R, T.c0)), box: b,
        fit: Math.max(0, Math.min(1, 1 - T.fit.e / TOL)), err: T.fit.e, vol: (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]), symY: false, instance: true };
    }
    const prim0 = primitiveOf(fits[i], p, srcFile);
    // worker 预先算好的组合写法（同样的源文件名、部件文件与开关才取用）
    const pc = preUsed.has(i) ? prefit?.compOf?.(p, i, { srcFile, partsFile: PARTS_FILE, panels: PANELS, shells: SHELLS, unions: UNIONS, subs: SUBS }) : undefined;
    if (pc?.sc != null) SCATTERED.set(p, pc.sc);
    const prim = (pc !== undefined ? pc.out : panelPrim(fits[i], p, prim0, i)) ?? prim0;
    const nm = p.name && !/^part_\d+$|^merged_/.test(p.name) ? cleanName(p.name) : null;
    const id = p.forceName ? uniqueId(sanitize(p.forceName), true) : uniqueId(nm ? sanitize(nm) : `${prim.kind}${(counters[prim.kind] = (counters[prim.kind] ?? 0) + 1)}`);
    const vol = (prim.box.max[0] - prim.box.min[0]) * (prim.box.max[1] - prim.box.min[1]) * (prim.box.max[2] - prim.box.min[2]);
    const symY = prim.kind === 'sphere' || prim.kind === 'revolve' || (['cyl', 'cone'].includes(prim.kind) && !prim.props.axis);
    snapUpright(prim);
    if (symY && Math.abs(prim.cols[1][1] - 1) < 1e-6) prim.cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    return { id, src: p.uid ?? p.name ?? p.from ?? null, meta: metaOf(p), role: roleP(p), scattered: SCATTERED.has(p), material: p.material, ...prim, vol, symY };
  }).filter(Boolean);
  const typeLines = types.flatMap((T) => {
    // 板件：类型体是一组墙板、楼板（已经相对包络的底面中心）
    if (T.prim.body) return [`def ${T.name} {`, `  ${T.prim.kind} body {  // ${T.count} 个实例；${T.prim.union ? '基本体之并' : T.prim.shell ? '外壳 − 空腔 − 开口' : T.prim.scatter ? '分散的块' : '板件'}`, ...T.prim.body.map((l) => '    ' + l), '  }', '}'];
    // 台阶的位置由两个端点决定（at= 对它不起作用）：端点直接平移到类型的坐标系里（原点在包络的底面中心）
    if (T.prim.kind === 'span') {
      const mv = (v) => vec(sub(v.split(',').map(Number), T.c0));
      const props = Object.entries({ ...T.prim.props, from: mv(T.prim.props.from), to: mv(T.prim.props.to) }).map(([k, v]) => `${k}=${v}`).join(' ');
      return [`def ${T.name} {`, `  span body ${props}  // ${T.count} 个实例`, '}'];
    }
    const props = Object.entries(T.prim.props).map(([k, v]) => `${k}=${v}`).join(' ');
    const at0 = sub(T.prim.at, T.c0);
    return [`def ${T.name} {`, '  ' + [T.prim.kind, 'body', props, at0.some((v) => Math.abs(v) > 1e-6) ? `at=${vec(at0)}` : '', orientText(T.prim.cols)].filter(Boolean).join(' ') + `  // ${T.count} 个实例`, '}'];
  });
  unifyBoxLabels(objs);
  // 材质
  const mats = new Map();
  for (const o of objs) {
    const k = JSON.stringify(o.material);
    if (!mats.has(k)) {
      let name = sanitize(o.material.name ?? `m_${o.material.color.slice(1)}`);
      while ([...mats.values()].some((m) => m.name === name)) name += '_';
      mats.set(k, { ...o.material, name });
    }
    o.mat = mats.get(k).name;
  }
  const header = [`// 由逆向管线从 ${srcFile} 生成（${level}）。~fit 是拟合度，~err 是相对误差；mesh 是拟合不了、直接引用源网格的部件`, ''];
  // 辅助（白模体积、雾、碰撞体）不写进几何，只列出来（roles.json 里可以改判）
  if (helpers.length) header.push(`// 辅助部件（不写进几何）：${helpers.map((p) => p.uid ?? p.name ?? p.from).join('、')}`, '');
  // 默认材质：一半以上的物体是同一种材质时，它标成 default=true，这些物体的行里不再写 mat=（真实地图常常全场一种白模材质）
  const matCount = new Map();
  for (const o of objs) matCount.set(o.mat, (matCount.get(o.mat) ?? 0) + 1);
  const [defMat, defN] = [...matCount].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  // 嵌进别处的输出（细化的子块、detect）不用：省掉的 mat= 在那里会继承外层物体的材质
  // 分块逆向：全场一致的默认材质（defaultMaterial 是材质的键）
  const defaultMat = typeof defaultMaterial === 'string' ? mats.get(defaultMaterial)?.name ?? null : defaultMaterial && defN * 2 >= objs.length && objs.length >= 4 ? defMat : null;
  for (const m of mats.values()) header.push(`material ${m.name} color=${m.color}${m.metal != null ? ` metal=${fmt(m.metal)}` : ''}${m.rough != null ? ` rough=${fmt(m.rough)}` : ''}${m.name === defaultMat ? ' default=true' : ''}`);
  header.push('');
  if (typeLines.length) header.push('// 类型：源模型里同一个网格被多处使用（引擎的享元）', ...typeLines, '');
  const line = (o, place, orient) => {
    if (o.absolute) { place = ''; orient = ''; } // 管道的点列本身就是位置
    const props = Object.entries(o.props).map(([k, v]) => `${k}=${v === '@curve' ? `${o.id}_path` : v}`).join(' ');
    // 沿圆弧、螺旋的扫掠：曲线语句写在前面
    const curve = o.curve ? [o.curve.kind, `${o.id}_path`, ...Object.entries(o.curve.props).map(([k, v]) => `${k}=${v}`), `at=${vec(o.curve.at)}`, 'pin=origin', o.curve.turn].filter(Boolean).join(' ') + '\n' : '';
    // 旁路信息（sidecar 表里对上的列）也写成 ~元数据：不计描述长度，可以在 where 里读
    const meta = Object.entries(o.meta ?? {}).filter(([, v]) => v !== '').map(([k, v]) => `~${k}=${/^-?\d+(\.\d+)?$/.test(v) ? v : JSON.stringify(String(v))}`);
    const head = [o.kind, o.id, props, place, orient, o.mat === defaultMat ? '' : (o.mat === defaultMat ? '' : `mat=${o.mat}`), `~fit=${fmt(o.fit)}`, o.src ? `~src=${JSON.stringify(o.src)}` : '', ...meta].filter(Boolean).join(' ');
    // 板件、基本体之并：内容写在物体自己的坐标系里（原点在包络的底面中心）
    return curve + head + bodyOf(o);
  };
  const absLine = (o) => line(o, `at=${vec(o.at)}`, orientText(o.cols));
  const absSrc = header.concat(objs.map(absLine)).join('\n');

  // 空间事实（全坐标版本）
  const r0 = compile(absSrc, { factEps: FACT_EPS * M, heightAt: HEIGHT });
  lap(`全坐标版本编译（其中板件 ${Math.round(COMPOSITE_MS.panels)}ms、基本体之并 ${Math.round(COMPOSITE_MS.unions)}ms、外壳 ${Math.round(COMPOSITE_MS.shells)}ms、子场景 ${Math.round(COMPOSITE_MS.subs ?? 0)}ms / ${COMPOSITE_MS.subTried ?? 0} 个、子逆向 ${COMPOSITE_MS.subCalls ?? 0} 遍 ${Math.round(COMPOSITE_MS.subRev ?? 0)}ms、评分 ${Math.round(COMPOSITE_MS.subEval ?? 0)}ms）`);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const onOf = new Map(), againstOf = new Map(), nearOf = new Map();
  const related = new Map();
  const link = (m, x, y) => { if (!m.has(x)) m.set(x, []); m.get(x).push(y); };
  // 事实记在叶子物体上（类型实例里是 实例名.body）：归到它所属的顶层物体
  const objOf = (p) => (byId.has(p) ? p : byId.has(p.split('.')[0]) ? p.split('.')[0] : null);
  for (const f0 of r0.facts) {
    const a = objOf(f0.a), b = objOf(f0.b);
    if (!a || !b || a === b) continue;
    const f = { ...f0, a, b };
    link(related, f.a, f.b); link(related, f.b, f.a);
    if (['intersects', 'touching', 'inside'].includes(f.rel)) { link(nearOf, f.a, f.b); link(nearOf, f.b, f.a); }
    if (f.rel === 'on') link(onOf, f.a, f.b);
    if (f.rel === 'against') link(againstOf, f.a, { b: f.b, face: f.text.split('.').pop() });
  }

  // ── 压缩：阵列（平移 / 绕竖直轴旋转 / 螺旋）──
  const units = compress ? detectArrays(objs, related) : [];
  // 沿曲线的阵列：剩下的物体里，等间距排成一串、朝向随切线变化的（过山车枕木）
  if (compress) units.push(...detectCurveArrays(objs, units, onOf));
  // 台阶：一串直立的薄盒子排成线性阵列，步长有水平和竖直两个分量、盒子沿水平步长方向的深度约等于水平步长
  // （L2 里楼梯是一串互不相连的踏步）→ 一段 span … steps=n，代替这个阵列和它的成员
  if (compress) for (let i = units.length - 1; i >= 0; i--) {
    const st = stairOf(units[i]);
    if (!st) continue;
    units.splice(i, 1);
    // 成员从物体列表里拿掉（它们已经不在场景里，不会被当成参照物）；byId 里留着——更早算好的邻近关系里还有它们的编号
    for (const m of st.members) objs.splice(objs.indexOf(m), 1);
    // 名字：阵列的自动名（boxs_3）换成 stairs
    let id = 'stairs', k = 1;
    while (byId.has(id)) id = `stairs_${++k}`;
    st.obj.id = id;
    objs.push(st.obj);
    byId.set(st.obj.id, st.obj);
  }
  const unitOf = new Map(); // 物体 id → { unit, child, k }
  for (const u of units) u.children.forEach((c, ci) => c.members.forEach((o, k) => unitOf.set(o.id, { unit: u, child: c, k: instOf(u, k) })));
  // 镜像：成对的物体或阵列关于同一个竖直平面对称 → 一个写出来，另一个是它的镜像副本
  lap(`阵列检测（${units.length} 组）`);
  const mirrors = compress ? detectMirrors(objs, units.filter((u) => !u.along), unitOf) : [];
  lap(`镜像检测（${mirrors.length} 组）`);
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
  // 锚点坐标的最短写法：参照物在第 k 轴上的半宽为 hh，取 d 位小数的误差是 0.5·10^−d·hh，
  // 取满足“误差 ≤ τ”的最少位数（数字越短，描述越短；τ 由校验容差决定）
  const anchorTxt = (B, uvw, tau) => uvw.map((v, k) => {
    const hh = (B.box.max[k] - B.box.min[k]) / 2;
    const d = Math.max(0, Math.min(6, Math.ceil(Math.log10(Math.max(hh, 1e-9) * 0.5 / tau))));
    const x = Math.round(v * 10 ** d) / 10 ** d;
    return Object.is(x, -0) ? '0' : String(x);
  }).join(',');
  // 米制偏移的最短写法：取 d 位小数的误差是 0.5·10^−d，取满足“误差 ≤ τ”的最少位数；接近 0 的分量写 0
  const offsetTxt = (v, tau) => {
    const d = Math.max(0, Math.min(6, Math.ceil(Math.log10(0.5 / tau))));
    return v.map((x) => { const r = Math.round(x * 10 ** d) / 10 ** d; return Object.is(r, -0) ? '0' : String(r); }).join(',');
  };
  // 两种写法取短的：归一化锚点 B[u,v,w]，或者参照点加父坐标系里的米制偏移 B offset=…（描述长度按 score 的计价）
  const shorter = (...alts) => alts.reduce((a, b) => (lineCost(b) < lineCost(a) ? b : a));
  // 地形判定（网格才有）：竖直方向的范围不到占地短边的 30%，朝上的面投影到水平面上大约只有一层（0.5–1.3 倍包围盒的占地）——
  // 起伏的地面、路面是；房间的网格（地板、天花板两层）、楼不是
  // 竖直的圆柱、圆台（against=B.side[θ,v] 的候选）
  const CYLS = objs.filter((o) => (o.kind === 'cyl' || o.kind === 'cone') && !o.props.axis && Math.abs(o.cols[1][1] - 1) < 1e-6);
  const TERRAIN = new Map();
  const terrainLike = (B) => {
    if (TERRAIN.has(B.id)) return TERRAIN.get(B.id);
    const part = parts.find((q) => (q.uid ?? q.name ?? q.from) === B.src);
    let ok = false;
    if (part) {
      const sz = sub(B.box.max, B.box.min), fp = sz[0] * sz[2];
      let up = 0;
      for (const [a, b, c] of part.tris) up += Math.max(0, cross(sub(b, a), sub(c, a))[1]) / 2;
      ok = sz[1] <= 0.3 * Math.min(sz[0], sz[2]) && up >= 0.5 * fp && up <= 1.3 * fp;
    }
    TERRAIN.set(B.id, ok);
    return ok;
  };
  const chooseFor = (A, p, cand0, name0, tau = 0.005 * S, frame = null) => {
    // 贴花（地面、墙上的薄片）、分散的模型不当参照物：它们的包围盒常常很大、很空
    const cand = (B) => cand0(B) && B.role !== 'decal' && !B.scattered;
    const name = (B) => name0(B);
    // 世界向量 → 父坐标系（顶层是世界；阵列里是实例的坐标系）
    const toParent = (v) => (frame ? mvT(frame, v) : v);
    // 空间事实按真实的几何（容器按里面的内容），on= / against= 却按包围盒放：两者对不上的参照物不用
    //（板件拼成的楼：上一段楼体的一块板搭在下一段的屋顶上，包围盒却是重叠的）
    const boxTol = Math.max(0.0125 * S, 10 ** -DIGITS);
    const topOf = (B) => add(B.at, mvC(B.cols, [(B.box.min[0] + B.box.max[0]) / 2, B.box.max[1], (B.box.min[2] + B.box.max[2]) / 2]));
    const onOk = (B0) => { const B = poseOf(B0); return Math.abs(dot(sub(p, topOf(B)), B.cols[1])) < boxTol; };
    const sup0 = (onOf.get(A.id) ?? []).map((id) => byId.get(id)).filter((B) => B && cand(B) && onOk(B)).sort((x, y) => y.vol - x.vol)[0];
    const sup = sup0 && poseOf(sup0);
    if (sup) {
      const uvw = norm(sup, toB(sup, p));
      const plain = Math.abs(uvw[0]) < 1e-6 && Math.abs(uvw[2]) < 1e-6;
      if (plain) return { place: `on=${name(sup)}`, ref: sup, kind: 'on' };
      const off = toParent(sub(p, topOf(sup)));
      const place = shorter(`on=${name(sup)}[${anchorTxt(sup, [uvw[0], 1, uvw[2]], tau)}]`, `on=${name(sup)} offset=${offsetTxt(off, tau)}`);
      return { place, ref: sup, kind: 'on' };
    }
    // 立在网格地形上（起伏的地面、路面：包围盒的顶面不是它的表面）：A 的底面中心正好落在一个网格的真实表面上，
    // 这个网格俯视包含 A、占地至少是 A 的四倍 → on=地形.top[u,w]（竖直射线取表面，见 heights.mjs）。只用于顶层的物体
    if (HEIGHT && !frame && Math.abs(A.cols[1][1] - 1) < 1e-6) {
      const foot = (B) => (B.box.max[0] - B.box.min[0]) * (B.box.max[2] - B.box.min[2]);
      let best = null;
      for (const B0 of objs) {
        if (B0.kind !== 'mesh' || B0 === A || !cand(B0) || foot(B0) < 4 * foot(A) || !terrainLike(B0)) continue;
        const B = poseOf(B0), l = toB(B, p), uvw = norm(B, l);
        if (Math.abs(uvw[0]) > 1 || Math.abs(uvw[2]) > 1) continue;
        // 写出来的 u、w 取整之后再取表面高度（编译器就是这样算的）
        const txt = anchorTxt(B, [uvw[0], 1, uvw[2]], tau).split(','), u = +txt[0], w = +txt[2];
        const c = [0, 1, 2].map((k) => (B.box.min[k] + B.box.max[k]) / 2), hh = [0, 1, 2].map((k) => (B.box.max[k] - B.box.min[k]) / 2);
        const pv = B.props.pivot.split(',').map(Number), sy = HEIGHT(JSON.parse(B.props.src), c[0] + hh[0] * u + pv[0], c[2] + hh[2] * w + pv[2]);
        if (sy == null) continue;
        const dy = Math.abs(p[1] - sy);
        if (dy <= boxTol && (!best || dy < best.dy)) best = { B, dy, place: `on=${name(B)}.top[${txt[0]},${txt[2]}]` };
      }
      if (best) return { place: best.place, ref: best.B, kind: 'on' };
    }
    // 贴在竖直的圆柱、圆台侧面上（罐体上的接管、柱子上的牌子）：A 朝向轴的那个侧面的中心正好落在侧面上 →
    // against=B.side[θ,v]（θ 按 arc 的约定，v 是高度比例；编译器把 A 那一面的中心放到这一点，法线沿径向）
    // 候选不靠接触事实（多边形近似的圆柱与贴上去的面差一点，常常没有事实）：中心离得够近的竖直圆柱、圆台
    if (!frame && Math.abs(A.cols[1][1] - 1) < 1e-6 && CYLS.length) {
      const cA0 = centerOf(A), dA = len(sub(A.box.max, A.box.min));
      for (const B0 of CYLS) {
        if (B0 === A || !cand(B0)) continue;
        const cB = centerOf(B0), rB = Math.max(+B0.props.r, +(B0.props.r2 ?? 0)), hB = +B0.props.h;
        if (Math.hypot(cA0[0] - cB[0], cA0[2] - cB[2]) > rB + dA || Math.abs(cA0[1] - cB[1]) > hB / 2 + dA) continue;
        const B = poseOf(B0);
        if (Math.abs(B.cols[1][1] - 1) > 1e-6) continue;
        const r1 = +B.props.r, r2 = B0.kind === 'cone' ? +B.props.r2 : r1, h = +B.props.h;
        const cA = add(A.at, mvC(A.cols, scl(add(A.box.min, A.box.max), 0.5))), l = toB(B, cA);
        const th = Math.atan2(-l[2], l[0]), out = [Math.cos(th), 0, -Math.sin(th)];
        // A 朝向轴的那个侧面（局部 ±x、±z 里法线与径向最相反的）
        let best = null;
        for (const [k, sg] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
          const dir = [0, 0, 0]; dir[k] = sg;
          const nB = mvT(B.cols, mvC(A.cols, dir)), s2 = dot(nB, out);
          if (!best || s2 < best.s) best = { s: s2, k, sg, nB };
        }
        if (best.s > -0.95) continue; // 那一面不是朝着轴的
        const half = (A.box.max[best.k] - A.box.min[best.k]) / 2, F = add(l, scl(best.nB, half));
        const v = F[1] / h, rho = Math.hypot(F[0], F[2]), rv = r1 + (r2 - r1) * v;
        if (v < 0 || v > 1 || Math.abs(rho - rv) > 0.5 * tau) continue; // 贴面要贴实：插进去、离开都不算（摆臂插进火箭里的不是贴着）
        const thF = Math.atan2(-F[2], F[0]) * 180 / Math.PI;
        // 位数：弧长误差 r·Δθ、高度误差 h·Δv 都不超过 τ
        const dTh = Math.max(0, Math.min(4, Math.ceil(Math.log10((0.5 * Math.PI / 180 * Math.max(rv, 1e-9)) / tau)))), dV = Math.max(0, Math.min(4, Math.ceil(Math.log10(0.5 * h / tau))));
        const rnd = (x, d) => { const y = Math.round(x * 10 ** d) / 10 ** d; return Object.is(y, -0) ? '0' : String(y); };
        return { place: `against=${name(B)}.side[${rnd(thF, dTh)},${rnd(v, dV)}]`, ref: B, kind: 'against' };
      }
    }
    // 贴着的那个面：A 的包围盒上朝向 B 那一面的中心（B 自身坐标、归一化）；它必须真的落在 B 的包围盒那一面上
    const againstAt = (x) => {
      const B = poseOf(x.B), nB = mvC(B.cols, FACE[x.face]);
      let bestF = null, bestS = Infinity;
      for (const d of Object.values({ ...FACE, top: [0, 1, 0], bottom: [0, -1, 0] })) { const s2 = dot(mvC(A.cols, d), nB); if (s2 < bestS) { bestS = s2; bestF = d; } }
      const cA = [0, 1, 2].map((k) => (A.box.min[k] + A.box.max[k]) / 2 + bestF[k] * (A.box.max[k] - A.box.min[k]) / 2);
      const uvw = norm(B, toB(B, add(A.at, mvC(A.cols, cA))));
      const ok = FACE[x.face].every((v, k) => !v || Math.abs(uvw[k] - v) * (B.box.max[k] - B.box.min[k]) / 2 < boxTol);
      return { B, uvw, ok };
    };
    const ag = p === A.at ? (againstOf.get(A.id) ?? []).map((x) => ({ ...x, B: byId.get(x.b) })).filter((x) => x.B && cand(x.B) && det3c(poseOf(x.B).cols) > 0 && againstAt(x).ok).sort((x, y) => y.B.vol - x.B.vol)[0] : null;
    if (ag) {
      const { B, uvw } = againstAt(ag);
      FACE[ag.face].forEach((v, k) => { if (v) uvw[k] = v; });
      return { place: `against=${name(B)}[${anchorTxt(B, uvw, tau)}]`, ref: B, kind: 'against' };
    }
    const near0 = (nearOf.get(A.id) ?? []).map((id) => byId.get(id)).filter((B) => B && cand(B)).sort((x, y) => y.vol - x.vol)[0];
    if (near0) {
      const near = poseOf(near0), t2 = Math.min(tau, 5e-4 * S);
      const ctr = add(near.at, mvC(near.cols, scl(add(near.box.min, near.box.max), 0.5)));
      // 锚点按参照物的尺寸归一化：落在包络之外很远（|u| > 1.5）时，参照物尺寸的取整误差会被放大好几倍，改用 offset
      const uvw = norm(near, toB(near, p)), offTxt = `at=${name(near)} offset=${offsetTxt(toParent(sub(p, ctr)), t2)}`;
      const place = Math.max(...uvw.map(Math.abs)) > 1.5 ? offTxt : shorter(`at=${name(near)}[${anchorTxt(near, uvw, t2)}]`, offTxt);
      return { place, ref: null, kind: 'at' };
    }
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
    // 曲线写在最前面：几个阵列可以共用一条，阵列被拆开时曲线留着也无害
    for (const u of units) if (u.along && !u.along.shared && !dissolved.has(u.id)) {
      const { ctrl, closed } = u.along;
      lines.push(`spline ${u.along.id}${closed ? ' closed=true' : ''} path=[${ctrl.map((p) => `(${vecS(p)})`).join('; ')}]`);
      stats.curve = (stats.curve ?? 0) + 1;
    }
    for (const u of units) if (u.along?.shared && !dissolved.has(u.id) && units.some((h) => h.along && !h.along.shared && h.along.id === u.along.id && dissolved.has(h.id))) {
      const { ctrl, closed } = u.along;
      lines.push(`spline ${u.along.id}${closed ? ' closed=true' : ''} path=[${ctrl.map((p) => `(${vecS(p)})`).join('; ')}]`);
    }
    // 位姿：以几何中心为准，坐标系由来源决定
    const setPose = (o, cols, box = o.box) => E.set(o.id, { cols, box, at: sub(centerOf(o), mvC(cols, scl(add(box.min, box.max), 0.5))) });
    const isPlaced = (B) => B && placed.has(B.id);
    const nameOf = (B) => pathOf(B);
    const plainLine = (o) => {
      setPose(o, o.cols);
      let c = fallback.has(o.id) || o.absolute ? null : chooseFor(o, o.at, isPlaced, nameOf);
      // 锚点（at=B[…]、at=B offset=…）只是就近取的参照，不是支撑关系：世界坐标写得更短就写坐标（on= / against= 照旧保留）
      //（精细档保留锚点：关系优先，坐标依赖率是它的验收标准；粗档位坐标只有一两位小数，锚点多出的名字是净开销）
      if (c?.kind === 'at' && FID.name !== 'detail' && lineCost(absLine(o)) <= lineCost(line(o, c.place, orientRel(o, c.ref)))) c = null;
      if (c) stats[c.kind]++; else stats.coord++;
      targets.push({ o, path: o.id, tol: (c && c.kind !== 'at' ? 0.025 : 2e-3) * S, kind: c?.kind ?? 'coord' });
      return c ? line(o, c.place, orientRel(o, c.ref)) : absLine(o);
    };
    const emitMirror = (x) => {
      const mi = mirrorOf.get(x.id);
      if (!mi || droppedMirrors.has(mi.B.id)) return;
      lines.push(`mirror ${mi.B.id} of=${x.id} across=${mi.across}${mi.B.role && mi.B.role !== 'structure' ? ` ~role="${mi.B.role}"` : ''}`);
      for (const [bid, path] of mi.paths) {
        placed.add(bid); targets.push({ o: byId.get(bid), path, tol: 2e-3 * S, mirror: mi.B.id, kind: 'mirror' });
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
      if (u.along) {
        // 曲线本身写成 spline（世界坐标），成员写在第 0 个实例的坐标系里
        const { ctrl, closed, mode } = u.along;
        lines.push(`repeat ${u.id} n=${u.n} along=${u.along.id}${mode === 'yaw' ? '' : ` orient=${mode}`} {`);
        const poses = alongPoses(ctrl, closed, u.n, mode);
        if (u.drop) {
          // 长度由关系决定的杆：从顶点垂到支撑物
          const ch = u.children[0], o = ch.members[0];
          const lp = mvT(poses[0].M, sub(u.top(o), poses[0].q));
          lines.push(`  span ${ch.id} from=(${vecS(lp)}) drop=${nameOf(byId.get(u.drop.support))} r=${u.drop.r}${o.mat === defaultMat ? '' : ` mat=${o.mat}`} ~fit=${fmt(Math.min(...ch.members.map((m) => m.fit)))}`);
          for (const [k, m] of ch.members.entries()) {
            targets.push({ o: m, path: `${u.id}.${k}.${ch.id}`, tol: 2e-3 * S, unit: u.id, kind: 'along', rod: true });
            setPose(m, m.cols, m.box);
            placed.add(m.id);
          }
          lines.push('}');
          continue;
        }
        for (const ch of u.children) {
          const o = ch.members[0];
          const lp = mvT(poses[0].M, sub(o.at, poses[0].q));
          const colsL = o.cols.map((c) => mvT(poses[0].M, c));
          const props = Object.entries(o.props).map(([k, v]) => `${k}=${v}`).join(' ');
          const orient = o.symY && Math.abs(colsL[1][1] - 1) < 1e-6 ? '' : orientText(colsL);
          lines.push('  ' + [o.kind, ch.id, props, `at=${vecS(lp)}`, orient, (o.mat === defaultMat ? '' : `mat=${o.mat}`), (o.role && o.role !== 'structure' ? `~role="${o.role}"` : ''), `~fit=${fmt(Math.min(...ch.members.map((m) => m.fit)))}`].filter(Boolean).join(' ') + bodyOf(o, '  '));
          for (const [k, m] of ch.members.entries()) {
            targets.push({ o: m, path: `${u.id}.${k}.${ch.id}`, tol: 2e-3 * S, unit: u.id, kind: 'along' });
            setPose(m, colsL.map((c) => mvC(poses[k].M, c)), o.box);
            placed.add(m.id);
          }
        }
        lines.push('}');
        continue;
      }
      if (u.rotate) {
        // rotate 容器：坐标系就是父坐标系，第一个成员照常用关系定位；其余成员由旋转生成
        const { u: ax, deg, c } = u.rotate;
        const onAxis = objs.filter((o) => isPlaced(o) && !inUnit(o) && o.kind !== 'mesh' && len(cross(sub(centerOf(o), c), ax)) < 5e-4 * S).sort((p2, q2) => q2.vol - p2.vol)[0];
        let aboutTxt;
        if (onAxis) aboutTxt = nameOf(onAxis);
        else { aboutTxt = `(${vec6(c)})`; stats.coord++; }
        const axTxt = Math.abs(ax[1] - 1) < 1e-9 ? '' : Math.abs(ax[0] - 1) < 1e-9 ? ' axis=x' : Math.abs(ax[2] - 1) < 1e-9 ? ' axis=z' : ` axis=(${vec6(ax)})`;
        lines.push(`rotate ${u.id} n=${u.n - 1} angle=${fmt6(deg)} about=${aboutTxt}${axTxt} {`);
        const sib = new Set();
        for (const ch of u.children) {
          const o = ch.members[0];
          const cand = (B) => (isPlaced(B) && !inUnit(B)) || (sib.has(B.id) && B !== o);
          // 阵列成员的校验更严（2 mm），数字精度也要跟上
          const cc = chooseFor(o, o.at, cand, (B) => (sib.has(B.id) ? unitOf.get(B.id).child.id : nameOf(B)), 5e-4 * S);
          const props = Object.entries(o.props).map(([k, v]) => `${k}=${v}`).join(' ');
          lines.push('  ' + [o.kind, ch.id, props, cc ? cc.place : `at=${vec(o.at)}`, cc ? orientRel(o, cc.ref) : orientText(o.cols), (o.mat === defaultMat ? '' : `mat=${o.mat}`), (o.role && o.role !== 'structure' ? `~role="${o.role}"` : ''), `~fit=${fmt(Math.min(...ch.members.map((mm) => mm.fit)))}`].filter(Boolean).join(' ') + bodyOf(o, '  '));
          if (cc) stats[cc.kind]++; else stats.coord++;
          sib.add(o.id);
          for (const [k, mm] of ch.members.entries()) {
            targets.push({ o: mm, path: k === 0 ? `${u.id}.${ch.id}` : `${u.id}.r${k}.${ch.id}`, tol: (cc && cc.kind !== 'at' ? 0.025 : 2e-3) * S, unit: u.id, kind: 'rotate' });
            setPose(mm, o.cols.map((c) => rotAbout(ax, deg * k, [0, 0, 0], c)), o.box);
          }
        }
        lines.push('}');
        for (const ch of u.children) for (const o of ch.members) placed.add(o.id);
        emitMirror(u);
        continue;
      }
      // 阵列整体的定位：用锚定成员与外部已放好物体的关系，pin=origin 把阵列原点钉上去。
      // 锚定成员优先取立在阵列外某物上的那个（光伏阵列的立柱立在地上，面板只架在立柱上），否则取最大的；
      // 平移阵列的原点随之取锚定成员的原点（螺旋的原点在轴上，不动）
      const standsOutside = (ch) => (onOf.get(ch.members[0].id) ?? []).some((id) => !inUnit(byId.get(id)) && isPlaced(byId.get(id)));
      const anchorCh = (!u.turn && u.children.find(standsOutside)) || anchor, a1 = anchorCh.members[0];
      const origin = anchorCh === anchor ? u.origin : a1.at;
      const kids = [anchorCh, ...u.children.filter((ch) => ch !== anchorCh)];
      let place = null, ref = null;
      const c = fallback.has(u.id) ? null : chooseFor(a1, origin, (B) => isPlaced(B) && !inUnit(B), nameOf, 5e-4 * S);
      // 网格写成 n=(a,1,b)：两个方向必须是阵列坐标系的 x 与 z。on / against 会继承参照物的朝向，
      // 参照物转过一个角度时就对不上——改用 at=参照物[u,v,w]：落点相同，但不继承朝向
      const gridOk = (R) => !u.grid || (Math.abs(Math.abs(dot(R[0], unit(u.step))) - 1) < 1e-9 && Math.abs(Math.abs(R[2][2]) - 1) < 1e-9);
      // 参照物倾斜时（斜塔里一层的环立在下一层倾斜的立柱上）同样改用 at=：阵列坐标系保持世界朝向
      // 改用 at= 时参照物重新挑：所有相关的（立在其上的、贴着的、相交的）里最大的那个，归一化坐标才好读
      if (c && c.kind !== 'at' && (!gridOk(c.ref.cols) || (c.kind === 'on' && Math.abs(c.ref.cols[1][1] - 1) >= 1e-9))) {
        const rel = [...(onOf.get(a1.id) ?? []), ...(againstOf.get(a1.id) ?? []).map((x) => x.b), ...(nearOf.get(a1.id) ?? [])]
          .map((id) => byId.get(id)).filter((B) => B && isPlaced(B) && !inUnit(B)).sort((x, y) => y.vol - x.vol);
        const B = poseOf(rel[0]);
        c.place = `at=${nameOf(B)}[${anchorTxt(B, norm(B, toB(B, origin)), 5e-4 * S)}]`; c.kind = 'at'; c.ref = B;
      }
      if (c && (c.kind !== 'on' || Math.abs(c.ref.cols[1][1] - 1) < 1e-9)) { place = `${c.place} pin=origin`; ref = c.ref; stats[c.kind]++; }
      else { place = `at=${vec(origin)} pin=origin`; stats.coord++; }
      // 阵列坐标系：参照物的朝向（on / against 继承），否则世界朝向
      const RF = ref && c.kind !== 'at' ? ref.cols : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
      const local = (p) => mvT(RF, sub(p, origin));
      const stepL = mvT(RF, u.step);
      const dims = u.grid ? `n=(${u.n[0]},1,${u.n[1]})` : `n=${u.n}`;
      const nMax = u.grid ? Math.max(...u.n) : u.n;
      const stepTxt = u.grid ? `step=${[stepL[0], 0, u.step2Local ?? 0].map((v) => fmtStep(v, nMax)).join(',')}` : `step=${stepL.map((v) => fmtStep(v, nMax)).join(',')}`;
      // 螺旋的转角同样会累积：按最远成员离轴的距离换算成位置误差
      lines.push(`repeat ${u.id} ${dims} ${stepTxt}${u.turn ? ` turn=${fmtStep(u.turn, nMax * Math.max(1, (Math.PI / 180) * Math.max(...u.children.flatMap((c) => c.members.map((m) => len(sub(centerOf(m), u.origin)))))))}` : ''} ${place} {`);
      // 实例里的成员：锚定成员放在原点附近；其余成员优先相对同一实例里的兄弟定位
      const sib = new Set();
      for (const ch of kids) {
        const o = ch.members[0];
        const cand = (B) => sib.has(B.id) && B !== o;
        const cc = ch === anchorCh ? null : chooseFor(o, o.at, cand, (B) => unitOf.get(B.id).child.id, 5e-4 * S, RF);
        const props = Object.entries(o.props).map(([k, v]) => `${k}=${v}`).join(' ');
        const lp = local(o.at);
        const placeTxt = cc ? cc.place : lp.every((v) => Math.abs(v) < 1e-6) ? '' : `at=${vec(lp)}`;
        const colsL = o.cols.map((col) => mvT(RF, col));
        const orient = cc ? orientRel(o, cc.ref) : o.symY && Math.abs(colsL[1][1] - 1) < 1e-6 ? '' : orientText(colsL);
        lines.push('  ' + [o.kind, ch.id, props, placeTxt, orient, (o.mat === defaultMat ? '' : `mat=${o.mat}`), (o.role && o.role !== 'structure' ? `~role="${o.role}"` : ''), `~fit=${fmt(Math.min(...ch.members.map((m) => m.fit)))}`].filter(Boolean).join(' ') + bodyOf(o, '  '));
        sib.add(o.id);
        for (const [i, m] of ch.members.entries()) {
          const k = instOf(u, i);
          targets.push({ o: m, path: `${u.id}.${k}.${ch.id}`, tol: 2e-3 * S, unit: u.id, kind: 'repeat' });
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
    lap(`第 ${round} 轮发射`);
    const r1 = compile(out.text, { factEps: FACT_EPS * M, heightAt: HEIGHT });
    lap(`第 ${round} 轮编译`);
    if (process.env.S3D_DUMP && round === 0) dumpText(process.env.S3D_DUMP, out.text);
    const byPath = new Map(r1.nodes.map((n) => [n.path, n]));
    let changed = false;
    for (const t of out.targets) {
      if (t.kind === 'coord') continue;
      const n = byPath.get(t.path);
      // 位置：一般比较原点（底面中心）；绕自身轴对称的形状比较几何中心——它们的“原点”是包围盒底面中心，
      // 离轴有一个半径，旋转副本会把这个偏移一起转走，而拟合时每个副本的坐标系是按世界“上”规范选的
      const tolP = t.unit || t.mirror ? 2e-3 * S * Math.max(1, len(t.o.at) / (50 * M)) : t.tol;
      // 校验容差不小于数字取整的步长（数字按档位取整，粗档位、stud 这样的单位下步长可能比容差还大）
      const tolR = Math.max(tolP, 10 ** -DIGITS);
      // 一律比较几何中心：中心与表示无关；加上考虑对称的朝向比较，位姿就完全确定了
      const posOk = () => len(sub(scl(add(n.box.min, n.box.max), 0.5), centerOf(t.o))) < tolR;
      // span 的杆轴是局部 x：比较杆轴与圆柱轴线
      const rodOk = () => Math.abs(n.world.R[0][0] * t.o.cols[1][0] + n.world.R[1][0] * t.o.cols[1][1] + n.world.R[2][0] * t.o.cols[1][2]) > 1 - 1e-6;
      // 绝对定位的物体（台阶、管道）：朝向由端点、点列决定，比较位置就够了
      const ok = n && n.world && n.box && posOk() && (t.o.absolute || (t.rod ? rodOk() : sameOrientation(t.o, n.world.R, !!t.mirror)));
      if (ok) continue;
      if (process.env.S3D_DEBUG) console.error('校验不通过', t.path, n ? `中心差 ${len(sub(scl(add(n.box.min, n.box.max), 0.5), centerOf(t.o))).toFixed(4)}` : '找不到节点', n && !sameOrientation(t.o, n.world.R, !!t.mirror) ? '朝向不同' : '');
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
  lap('校验结束');
  const named = names ? semanticNames(out.text, { previous, metre: M, heightAt: HEIGHT }) : { text: out.text, map: {}, renamed: 0 };
  // 扫掠的曲线（物体名_path）跟着物体改名
  for (const [a, b] of Object.entries(named.map)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}_.])${a}_path(?![\\p{L}\\p{N}_])`, 'gu');
    if (a !== b && re.test(named.text) && !new RegExp(`(?<![\\p{L}\\p{N}_.])${b}_path(?![\\p{L}\\p{N}_])`, 'u').test(named.text)) named.text = named.text.replace(re, `${b}_path`);
  }
  lap('语义命名');
  // 锁定：沿用上一次基础层里的定位 / 形状 / 整行；锁定之后编译出错的撤回，记进 unsatisfied
  let decisionReport = null;
  if (decided) {
    decisionReport = { ...decided.report };
    if (decided.locks.length) {
      const lk = applyLocks(named.text, previous, decided.locks);
      const before = new Set(compile(named.text, { factEps: FACT_EPS * M, heightAt: HEIGHT }).errors.map((e) => e.message));
      const errs = compile(lk.text, { factEps: FACT_EPS * M, heightAt: HEIGHT }).errors.filter((e) => !before.has(e.message));
      if (errs.length) decisionReport.unsatisfied.push(...lk.report.applied.map((x) => ({ ...x, why: `锁定之后编译出错：${errs[0].message}` })));
      else { named.text = lk.text; decisionReport.applied.push(...lk.report.applied); }
      decisionReport.unsatisfied.push(...lk.report.unsatisfied);
    }
  }
  const nm = (id) => named.map[id] ?? id;
  const report = {
    source: srcFile, level, parts: parts.length,
    kinds: Object.fromEntries(Object.entries(objs.reduce((m, o) => ((m[o.kind] = (m[o.kind] ?? 0) + 1), m), {})).sort()),
    arrays: kept.map((u) => ({ id: nm(u.id), n: u.n, ...(u.holes?.length ? { holes: u.holes } : {}), kind: u.along ? 'along' : u.rotate ? 'rotate' : u.turn ? 'screw' : u.grid ? 'grid' : 'linear', children: u.children.map((c) => c.id) })),
    mirrors: mirrors.filter((mi) => !droppedMirrors.has(mi.B.id)).map((mi) => ({ id: nm(mi.B.id), of: nm(mi.A.id), across: mi.across, objects: mi.paths.size })),
    // 第一遍就拆成板件的部件与类型：分数（只看这个部件）从 was 降到 S
    panels: [...types.filter((T) => T.prim.panels).map((T) => ({ type: T.name, instances: T.count, S: T.prim.panels.S, was: T.prim.panels.was })), ...objs.filter((o) => o.panels).map((o) => ({ id: nm(o.id), S: o.panels.S, was: o.panels.was, instead: o.panels.kind }))],
    shells: [...types.filter((T) => T.prim.shell).map((T) => ({ type: T.name, instances: T.count, ...T.prim.shell })), ...objs.filter((o) => o.shell).map((o) => ({ id: nm(o.id), ...o.shell, instead: o.shell.kind }))],
    scattered: [...types.filter((T) => T.prim.scatter).map((T) => ({ type: T.name, instances: T.count, blocks: T.prim.scatter.blocks })), ...objs.filter((o) => o.scatter).map((o) => ({ id: nm(o.id), blocks: o.scatter.blocks }))],
    unions: [...types.filter((T) => T.prim.union).map((T) => ({ type: T.name, instances: T.count, prims: T.prim.union.prims, S: T.prim.union.S, was: T.prim.union.was })), ...objs.filter((o) => o.union).map((o) => ({ id: nm(o.id), prims: o.union.prims, S: o.union.S, was: o.union.was, instead: o.union.kind }))],
    subs: [...types.filter((T) => T.prim.sub).map((T) => ({ type: T.name, instances: T.count, pieces: T.prim.sub.pieces, S: T.prim.sub.S, was: T.prim.sub.was })), ...objs.filter((o) => o.sub).map((o) => ({ id: nm(o.id), pieces: o.sub.pieces, S: o.sub.S, was: o.sub.was, instead: o.sub.kind }))],
    roles: Object.fromEntries([...parts.reduce((m, p) => m.set(roleP(p), (m.get(roleP(p)) ?? 0) + 1), new Map())].sort()),
    helpers: helpers.map((p) => p.uid ?? p.name ?? p.from),
    covered: kept.reduce((s, u) => s + u.children.reduce((t, c) => t + c.members.length, 0), 0),
    placement: out.stats,
    meanFit: +(objs.reduce((s, o) => s + o.fit, 0) / objs.length).toFixed(3),
    dissolved: [...dissolved], fallback: [...fallback],
    renamed: named.renamed,
    ...(decisionReport ? { decisions: decisionReport } : {}),
  };
  return { src: named.text + '\n', absSrc, report, objs };
}

// 线性阵列 → 台阶（见 reverse 里的调用处）；不是台阶返回 null
function stairOf(u) {
  if (u.grid || u.rotate || u.along || u.turn || u.children.length !== 1 || u.holes?.length || !u.step) return null;
  let ms = u.children[0].members, s = u.step;
  if (ms.length < 3 || !ms.every((o) => o.kind === 'box' && Math.abs(o.cols[1][1] - 1) < 1e-6)) return null;
  if (s[1] < 0) { ms = [...ms].reverse(); s = scl(s, -1); }
  const run = Math.hypot(s[0], s[2]), rise = s[1];
  if (!(run > 1e-6) || !(rise > 1e-6)) return null;
  const uh = [s[0] / run, 0, s[2] / run];
  const size = ms[0].props.size.split(',').map(Number), o = ms[0];
  const ax = [0, 2].find((k) => Math.abs(Math.abs(dot(o.cols[k], uh)) - 1) < 1e-3);
  if (ax == null) return null;
  const depth = size[ax], width = size[2 - ax], th = size[1];
  if (Math.abs(depth - run) > 0.15 * run || th > 1.5 * rise) return null;
  const A = [o.at[0] - uh[0] * run / 2, o.at[1] + th - rise, o.at[2] - uh[2] * run / 2], n = ms.length;
  const B = add(A, [uh[0] * run * n, rise * n, uh[2] * run * n]);
  // 包围盒按台阶本身的几何算（校验比较的是中心）
  const wv = [-uh[2], 0, uh[0]], cs = [];
  for (const [x, y] of [[0, A[1] + rise - th], [run * n, B[1]]]) for (const z of [-width / 2, width / 2]) cs.push([A[0] + uh[0] * x + wv[0] * z, y, A[2] + uh[2] * x + wv[2] * z]);
  const min = [0, 1, 2].map((k) => Math.min(...cs.map((c) => c[k]))), max = [0, 1, 2].map((k) => Math.max(...cs.map((c) => c[k])));
  const obj = { id: u.id, kind: 'span', props: { from: vec(A), to: vec(B), steps: String(n), section: `${fmt(width)},${fmt(th)}` }, cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], at: [0, 0, 0], box: { min, max }, absolute: true,
    mat: o.mat, material: o.material, src: o.src, meta: o.meta, fit: Math.min(...ms.map((m) => m.fit ?? 1)), err: Math.max(...ms.map((m) => m.err ?? 0)), vol: (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]), symY: false };
  return { obj, members: ms };
}

// 阵列里第 i 个成员所在的实例编号（有缺位的阵列不是 0, 1, 2…）
// 调试：S3D_DUMP=文件 时把第一轮发射的文本写出来
const dumpText = (p, t) => import('node:fs').then((fs) => fs.writeFileSync(p, t));
const instOf = (u, i) => (u.ks ? u.ks[i] : i);

// 几何中心：与表示方式无关的物理点（“原点”是包围盒底面中心，取决于局部 y 轴选了哪一头）
// 阵列、镜像检测里同一个物体的中心要算很多次：按物体缓存（at / cols / box 换了对象就重算）
const CENTERS = new WeakMap();
const centerOf = (o) => {
  const m = CENTERS.get(o);
  if (m && m.at === o.at && m.cols === o.cols && m.box === o.box) return m.c;
  const c = add(o.at, mvC(o.cols, scl(add(o.box.min, o.box.max), 0.5)));
  CENTERS.set(o, { at: o.at, cols: o.cols, box: o.box, c });
  return c;
};

// 朝向是否一致（考虑形状自身的对称）：球与竖直圆柱只看竖直轴；横放的圆柱只看轴线；盒子转 180° 一样
function sameOrientation(o, Rw, mirrored = false) {
  const col = (k) => [Rw[0][k], Rw[1][k], Rw[2][k]];
  const near = (u, v) => len(sub(u, v)) < angTol();
  if (o.kind === 'mesh' || o.body) return mirrored || [0, 1, 2].every((k) => near(col(k), o.cols[k]));
  // 绕自身 y 轴对称（球、y 轴圆柱 / 圆锥，可以是倾斜的）：只比较这条轴的方向；球怎么转都一样
  if (o.symY) return o.kind === 'sphere' || Math.abs(dot(col(1), o.cols[1])) > 1 - Math.max(2e-3, angTol() ** 2);
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
  // 台阶（span from= to=）的形状是级数、截面、水平长度与高度，不是两个端点的坐标
  const spanShape = (o) => { const A = o.props.from.split(',').map(Number), B = o.props.to.split(',').map(Number); return { steps: o.props.steps, section: o.props.section, run: String(Math.hypot(B[0] - A[0], B[2] - A[2])), rise: String(B[1] - A[1]) }; };
  const sizeKey = (o) => [o.kind, o.props.axis ?? '', o.mat, ...Object.entries(o.kind === 'span' ? spanShape(o) : o.props).filter(([k]) => !['src', 'pivot', 'axis'].includes(k)).map(([k, v]) => `${k}=${(String(v).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map((x) => Math.round(+x / SIZE_Q())).join(',')}`)].join('|');
  const ents = [];
  // 参考点用全部成员的质心（网格反射后原点会换到另一个角上，质心不会）
  const centroid = (u) => scl(u.children.flatMap((c) => c.members.map(centerOf)).reduce((s2, p) => add(s2, p), [0, 0, 0]), 1 / u.children.reduce((s2, c) => s2 + c.members.length, 0));
  for (const u of units) ents.push({ id: u.id, unit: u, ref: centroid(u), members: u.children.flatMap((c) => c.members.map((o, k) => ({ o, child: c.id, k: instOf(u, k) }))), key: 'U' + u.children.map((c) => sizeKey(c.members[0])).join('/') + '|' + c_n(u) + '|' + (u.holes ?? []).join(',') });
  for (const o of objs) if (!unitOf.has(o.id) && !o.body && !o.curve) ents.push({ id: o.id, obj: o, ref: centerOf(o), members: [{ o, child: null, k: null }], key: 'O' + sizeKey(o) });
  function c_n(u) { return JSON.stringify(u.n); }
  // 一个成员反射后是否与另一个物体重合（位置；朝向考虑形状自身的对称）
  const matches = (a, b, n, d) => {
    const pa = reflect(centerOf(a), n, d);
    if (len(sub(pa, centerOf(b))) > 0.004 * S + 1e-4 * len(sub(a.box.max, a.box.min))) return false;
    if (a.kind === 'mesh') return true;
    // 台阶：反射后的两个端点与另一段的端点重合（朝向已经由端点表达）
    if (a.kind === 'span') { const pt = (o, k) => o.props[k].split(',').map(Number), tol = 0.004 * S + 1e-4 * len(sub(a.box.max, a.box.min)); return ['from', 'to'].every((k) => len(sub(reflect(pt(a, k), n, d), pt(b, k))) < 4 * tol); }
    const rc = a.cols.map((c) => reflectDir(c, n));
    return sameOrientation(b, toRows(rc), true);
  };
  // 候选平面。规模：只在同一签名的实体之间配对（顺序与两两配对相同）；平面按量化的（法线，偏移）放进格网，
  // 只在相邻的格子里找“第一个对得上的”（创建得最早的），结果与线性查找一样
  const planes = [], grid = new Map(), QN = 1e-3, QD = 5e-3 * M;
  const cell = (n, d) => [Math.floor(n[0] / QN), Math.floor(n[2] / QN), Math.floor(d / QD)];
  const findPlane = (nrm, d) => {
    const [a, b, c] = cell(nrm, d);
    let best = null;
    for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) for (let w = -1; w <= 1; w++) {
      for (const p of grid.get(`${a + x},${b + z},${c + w}`) ?? []) if (len(sub(p.n, nrm)) < 1e-3 && Math.abs(p.d - d) < QD && (!best || p.k < best.k)) best = p;
    }
    return best;
  };
  const sameKey = new Map();
  ents.forEach((e, i) => { if (!sameKey.has(e.key)) sameKey.set(e.key, []); sameKey.get(e.key).push(i); });
  for (let i = 0; i < ents.length; i++) for (const j of sameKey.get(ents[i].key)) {
    if (j <= i) continue;
    const A = ents[i], B = ents[j];
    if (Math.abs(A.ref[1] - B.ref[1]) > 1e-3 * M) continue;
    let nrm = sub(B.ref, A.ref); nrm[1] = 0;
    if (len(nrm) < 1e-6) continue;
    nrm = unit(nrm);
    const f = nrm.find((v) => Math.abs(v) > 1e-9);
    if (f < 0) nrm = scl(nrm, -1);
    const d = dot(nrm, scl(add(A.ref, B.ref), 0.5));
    let pl = findPlane(nrm, d);
    if (!pl) {
      planes.push((pl = { n: nrm, d, pairs: [], k: planes.length }));
      const key = cell(nrm, d).join(',');
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(pl);
    }
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
      if (o.kind === 'mesh' || o.body || o.curve) continue;
      const c = centerOf(o);
      if (Math.abs(dot(c, pl.n) - pl.d) > 1e-3 * M) continue;
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

// 阵列的名字：成员名的最长公共前缀作为阵列名、最长公共后缀作为部件名（coaster_ties_17_tie → coaster_ties / tie）；
// 没有名字（L1/L2）时用形状编号，之后由语义命名改掉
function memberNames(members, unit, child) {
  const toks = members.map((o) => o.id.split('_'));
  const common = (lists) => { const out = []; for (let i = 0; lists.every((t) => i < t.length - 1 && t[i] === lists[0][i]); i++) out.push(lists[0][i]); return out; };
  const pre = common(toks), suf = common(toks.map((t) => [...t].reverse())).reverse();
  return {
    unit: pre.length && !/^\d+$/.test(pre.at(-1)) ? sanitize(pre.join('_')) : unit,
    child: suf.length && !/^\d+$/.test(suf[0]) ? sanitize(suf.join('_')) : child,
  };
}

// ───────── 沿曲线的阵列 ─────────
// 同形状、同尺寸、同材质、还没进阵列的物体，按最近邻排成等间距的链（至少 8 个），再拟合一条样条：
// 第 k 个成员 = 曲线上等弧长的第 k 个点 + 随切线转动的固定偏移。拟合与校验都通过才算。
function detectCurveArrays(objs, units, onOf) {
  const inUnit = new Set(units.flatMap((u) => u.children.flatMap((c) => c.members.map((o) => o.id))));
  const nums = (o) => Object.entries(o.props).filter(([k]) => !['src', 'pivot', 'axis'].includes(k)).flatMap(([, v]) => (String(v).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number));
  const sameSize = (a, b) => { const x = nums(a), y = nums(b); return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 0.01 * S + 0.005 * Math.abs(v)); };
  const groups = [];
  for (const o of objs) {
    if (o.kind === 'mesh' || o.body || o.absolute || inUnit.has(o.id)) continue;
    const g = groups.find((gg) => gg[0].kind === o.kind && gg[0].mat === o.mat && (gg[0].props.axis ?? '') === (o.props.axis ?? '') && sameSize(gg[0], o));
    if (g) g.push(o); else groups.push([o]);
  }
  const out = [];
  const taken = new Set([...objs.map((o) => o.id), ...units.map((u) => u.id)]);
  let ci = 0;
  for (const g of groups) {
    if (g.length < 8) continue;
    for (const ch of chainsOf(g.map(centerOf))) {
      let members = ch.order.map((i) => g[i]);
      let f = fitAlong(members.map(centerOf), { closed: ch.closed, tol: 5e-4 * S });
      // 不闭合的链两个方向都试（第 0 个实例在哪一头）；闭合的链由 fitAlong 自己处理方向
      if (!f && !ch.closed) { members = [...members].reverse(); f = fitAlong(members.map(centerOf), { closed: false, tol: 5e-4 * S }); }
      if (!f) continue;
      if (f.reversed) members = [members[0], ...members.slice(1).reverse()];
      if (f.start) members = [...members.slice(f.start), ...members.slice(0, f.start)];
      const nm = memberNames(members, `${g[0].kind}s`, g[0].kind);
      let id = nm.unit, k = 2;
      while (taken.has(id)) id = `${nm.unit}_${k++}`;
      taken.add(id);
      out.push({ id, children: [{ id: nm.child, members }], n: members.length, along: { id: `curve${++ci}`, ctrl: f.ctrl, closed: f.closed, mode: f.mode } });
    }
  }
  // 合并：同一条水平曲线上的几组（路灯的灯杆与灯臂）。yaw 模式下实例坐标系的 y 朝上，
  // 曲线整体竖直平移等价于部件的高度偏移，所以控制点只差一个竖直平移（或正好反向）就是同一条曲线
  const sameCurve = (a, b) => {
    if (a.n !== b.n || a.along.closed !== b.along.closed || a.along.mode !== 'yaw' || b.along.mode !== 'yaw' || a.along.ctrl.length !== b.along.ctrl.length) return null;
    for (const rev of [false, true]) {
      if (rev && a.along.closed) break;
      const cb = rev ? [...b.along.ctrl].reverse() : b.along.ctrl;
      const d = sub(cb[0], a.along.ctrl[0]);
      if (Math.abs(d[0]) < 1e-4 * M && Math.abs(d[2]) < 1e-4 * M && cb.every((p, j) => len(sub(sub(p, a.along.ctrl[j]), d)) < 1e-4 * M)) return { rev };
    }
    return null;
  };
  const merged = [];
  for (const u of out) {
    let host = null, how = null;
    for (const h of merged) if ((how = sameCurve(h, u))) { host = h; break; }
    if (!host) { merged.push(u); continue; }
    const ids = new Set(host.children.map((c) => c.id));
    let cid = u.children[0].id;
    while (ids.has(cid)) cid += '_';
    host.children.push({ id: cid, members: how.rev ? [...u.children[0].members].reverse() : u.children[0].members });
  }
  // 由关系决定长度的竖直杆：半径、材质相同，都立在同一个物体上，长度各不相同（过山车的立柱、栈桥的桩）。
  // 规律在顶点上：顶点沿曲线等弧长分布，长度由“垂到支撑物”决定 → span from=顶点 drop=支撑物
  const taken2 = new Set(merged.flatMap((u) => u.children.flatMap((c) => c.members.map((o) => o.id))));
  const poleGroups = new Map();
  for (const o of objs) {
    if (o.kind !== 'cyl' || inUnit.has(o.id) || taken2.has(o.id) || o.props.axis || !o.symY || Math.abs(o.cols[1][1] - 1) > 1e-6) continue;
    const sup = onOf.get(o.id) ?? [];
    if (sup.length !== 1) continue;
    const key = `${o.props.r}|${o.mat}|${sup[0]}`;
    if (!poleGroups.has(key)) poleGroups.set(key, []);
    poleGroups.get(key).push(o);
  }
  const topOf = (o) => add(o.at, mvC(o.cols, [(o.box.min[0] + o.box.max[0]) / 2, o.box.max[1], (o.box.min[2] + o.box.max[2]) / 2]));
  for (const g of poleGroups.values()) {
    if (g.length < 8 || g.every((o) => Math.abs(o.box.max[1] - g[0].box.max[1]) < 1e-3 * M)) continue;
    for (const ch of chainsOf(g.map(topOf))) {
      let members = ch.order.map((i) => g[i]);
      // drop 的方向是实例坐标系的“下”，只有 yaw（保持竖直）时才是世界的下
      let f = fitAlong(members.map(topOf), { closed: ch.closed, modes: ['yaw'], tol: 5e-4 * S });
      if (!f && !ch.closed) { members = [...members].reverse(); f = fitAlong(members.map(topOf), { closed: false, modes: ['yaw'], tol: 5e-4 * S }); }
      if (!f) continue;
      if (f.reversed) members = [members[0], ...members.slice(1).reverse()];
      if (f.start) members = [...members.slice(f.start), ...members.slice(0, f.start)];
      // 与已有曲线只差一个竖直平移（yaw 模式下等价于部件的高度偏移）就引用它
      let curve = { id: `curve${++ci}`, ctrl: f.ctrl, closed: f.closed, mode: 'yaw' };
      for (const h of merged) {
        const hc = h.along.ctrl;
        if (h.along.closed !== f.closed || hc.length !== f.ctrl.length) continue;
        const cands = f.closed ? [f.ctrl, [f.ctrl[0], ...f.ctrl.slice(1).reverse()]] : [f.ctrl, [...f.ctrl].reverse()];
        if (cands.some((c) => { const d = sub(c[0], hc[0]); return Math.abs(d[0]) < 1e-4 * M && Math.abs(d[2]) < 1e-4 * M && c.every((p, j) => len(sub(sub(p, hc[j]), d)) < 1e-4 * M); })) {
          // 方向必须和那条曲线一致：用它重新核对一遍（反向时成员顺序也反过来）
          for (const ms of f.closed ? [members, [members[0], ...members.slice(1).reverse()]] : [members, [...members].reverse()]) {
            const poses = alongPoses(hc, h.along.closed, ms.length, 'yaw');
            const off = mvT(poses[0].M, sub(topOf(ms[0]), poses[0].q));
            if (ms.every((o, k) => len(sub(add(poses[k].q, mvC(poses[k].M, off)), topOf(o))) < 5e-4 * S)) { curve = { ...h.along, mode: 'yaw', shared: true }; members = ms; break; }
          }
          if (curve.shared) { ci--; break; }
        }
      }
      const nm = memberNames(members, 'poles', 'pole');
      let id = nm.unit, k = 2;
      while (taken.has(id)) id = `${nm.unit}_${k++}`;
      taken.add(id);
      merged.push({ id, children: [{ id: nm.child, members }], n: members.length, along: curve, drop: { support: onOf.get(members[0].id)[0], r: members[0].props.r }, top: topOf });
    }
  }
  // 水平曲线的高度是任意的（部件的高度偏移可以补上）：放到成员的最低点，曲线就是它们立着的那条路
  for (const u of merged) if (u.along.mode === 'yaw' && !u.drop) {
    const corner = (o, b) => add(o.at, mvC(o.cols, [0, 1, 2].map((k) => ((b >> k) & 1 ? o.box.max[k] : o.box.min[k]))));
    const bottom = Math.min(...u.children.flatMap((c) => c.members.flatMap((o) => [0, 1, 2, 3, 4, 5, 6, 7].map((b) => corner(o, b)[1]))));
    u.along.ctrl = u.along.ctrl.map((p) => [p[0], bottom, p[2]]);
  }
  return merged;
}

// ───────── 阵列检测 ─────────
// 同形状、同尺寸、同材质（且相对竖直方向的姿态相同）的物体，如果相邻两个之间总是同一个刚体运动 M，
// 它们就是一个阵列：M 是平移 → 直线阵列（两组平移 → 网格）；M 绕竖直轴旋转 → 旋转对称；旋转加竖直平移 → 螺旋。
// 同一运动、同样数量、成员之间相对位姿固定的几组阵列，合并成一个多部件的 repeat。
function detectArrays(objs, related) {
  // 签名：形状、尺寸（量化到厘米）、材质、相对竖直方向的姿态
  // 签名：形状、材质、相对竖直方向的姿态，加上尺寸数值；尺寸按容差比较（拟合会有毫米级的噪声）
  const nums = (o) => Object.entries(o.props).filter(([k]) => !['src', 'pivot', 'axis'].includes(k)).flatMap(([, v]) => (String(v).match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? []).map(Number));
  // 朝向不进签名：一般轴的旋转会改变物体相对竖直方向的姿态；每一对的运动在下面单独核对
  const head = (o) => [o.kind, o.props.axis ?? '', o.mat, ...(o.body ?? [])].join('|');
  const sameSize = (a, b) => { const x = nums(a), y = nums(b); return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]) < 0.01 * S + 0.005 * Math.abs(v)); };
  const groupList = [];
  for (const o of objs) {
    if (o.kind === 'mesh' || o.absolute) continue; // 板件、基本体之并的形状在内容里（签名带着内容的原文）
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
    const tol = (0.004 + 1e-4 * scale / M) * S; // scale 是场景单位，S 已经含 1/unit：相对项按米折算
    const close = (a, b) => len(sub(a, b)) < tol;
    // 每一对给出一个候选运动，按容差聚类。
    // 规模：组很大时只和空间上最近的 10 个配对（阵列由相邻成员构成）；小组仍然两两配对，结果与原来完全一样
    const BIG = g.length > 24;
    const partners = new Map();
    if (BIG) for (const a of g) { const ca = centerOf(a); partners.set(a.id, g.filter((b) => b !== a).map((b) => [len(sub(centerOf(b), ca)), b]).sort((x, y) => x[0] - y[0]).slice(0, 10).map((x) => x[1])); }
    const partnersOf = (a) => (BIG ? partners.get(a.id) : g);
    const clusters = [];
    // 平移运动按步长量化成哈希，查找相同运动不必线性扫描
    const transIdx = new Map(), qk = (v) => v.map((x) => Math.round(x / (2 * tol))).join(',');
    const findTrans = (step) => { const q = step.map((x) => Math.round(x / (2 * tol))); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) for (const c of transIdx.get(`${q[0] + i},${q[1] + j},${q[2] + k}`) ?? []) if (close(c.motion.step, step)) return c; return null; };
    // 绕竖直轴的转动（delta ≠ 0）：按量化的角度与中心放进格网，只在相邻格子里找创建得最早的（与线性查找结果一样）
    const turnIdx = new Map(), turnKey = (m) => [Math.floor(m.delta / 0.05), Math.floor(m.center[0] / (2 * tol)), Math.floor(m.center[2] / (2 * tol))];
    const findTurn = (m) => {
      const [a0, b0, c0] = turnKey(m);
      let best = null;
      for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) for (const c of turnIdx.get(`${a0 + x},${b0 + y},${c0 + z}`) ?? []) if (sameMotion(c.motion, m) && (!best || c.k < best.k)) best = c;
      return best;
    };
    const sameMotion = (m, n) => (m.delta === 0) === (n.delta === 0) && (m.delta === 0
      ? close(m.step, n.step)
      : Math.abs(m.delta - n.delta) < 0.05 && close(m.center, n.center) && Math.abs(m.dy - n.dy) < tol);
    for (const a of g) for (const b of partnersOf(a)) {
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
        const cl = motion.delta === 0 ? findTrans(motion.step) : findTurn(motion);
        if (cl) { cl.pairs++; cl.ids.add(a.id); cl.ids.add(b.id); }
        else {
          const c = { motion, pairs: 1, ids: new Set([a.id, b.id]), k: clusters.length };
          clusters.push(c);
          if (motion.delta === 0) { const k = qk(motion.step); if (!transIdx.has(k)) transIdx.set(k, []); transIdx.get(k).push(c); }
          else { const k = turnKey(motion).join(','); if (!turnIdx.has(k)) turnIdx.set(k, []); turnIdx.get(k).push(c); }
        }
      }
    }
    // 一般轴的旋转（不竖直的轴，例如风车叶片）：由相对旋转求轴和角，再解轴上一点。
    // 盒子等有对称性的形状，自身坐标系有符号歧义，把对称变换都试一遍，由聚类挑出一致的那个
    const SYMS = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]];
    for (const a of g) for (const b of partnersOf(a)) {
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
        if (cl) { cl.pairs++; cl.ids.add(a.id); cl.ids.add(b.id); } else clusters.push({ motion, pairs: 1, ids: new Set([a.id, b.id]) });
      }
    }
    const apply = (m, o) => (m.rot ? rotAbout(m.u, m.deg, m.c, centerOf(o)) : m.delta ? add(add(mvC(Ry(m.delta), sub(centerOf(o), m.center)), m.center), [0, m.dy, 0]) : add(centerOf(o), m.step));
    // 轴对称的形状（竖直圆柱、球、平行的斜圆柱）看不出自身的转角：按位置找“环”——同一高度上等距、等角分布。
    // 分两轮：先认 3 个或 5 个以上的环（平移解释不了，例如正八边形里成对平行的弦会被平移抢走）；
    // 4 个的留给平移（2×2 的网格更自然），平移之后剩下的再认
    const findRings = (accept) => {
    if (g[0].symY || g[0].axisSym) {
      // 环绕的轴取形状自己的对称轴（竖直的圆柱就是世界 y；斜塔里一起倾斜的立柱是那条倾斜的轴）
      const ax = g[0].symY ? (g[0].kind === 'sphere' ? [0, 1, 0] : g[0].cols[1]) : g[0].cols[0];
      const ctr = (o) => add(o.at, mvC(o.cols, scl(add(o.box.min, o.box.max), 0.5)));
      const e1 = unit(cross(ax, Math.abs(ax[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0])), e2 = cross(ax, e1);
      const levels = [];
      for (const o of g.filter((x) => !used.has(x.id))) { const hgt = dot(ctr(o), ax); const lv = levels.find((l) => Math.abs(l.h - hgt) < tol); if (lv) lv.items.push(o); else levels.push({ h: hgt, items: [o] }); }
      for (const lv of levels) {
        if (lv.items.length < 3 || !accept(lv.items.length)) continue;
        const ps = lv.items.map(ctr);
        // 圆心：在垂直于轴的平面里拟合圆（整圈时就是质心；部分圆弧——例如沿 300° 弧排的路灯——质心不在圆心上）
        const g0 = scl(ps.reduce((s2, p) => add(s2, p), [0, 0, 0]), 1 / ps.length);
        const uv = ps.map((p) => [dot(sub(p, g0), e1), dot(sub(p, g0), e2)]);
        let Suu = 0, Suv = 0, Svv = 0, Su = 0, Sv = 0;
        for (const [u, v] of uv) { const w = u * u + v * v; Suu += u * u; Suv += u * v; Svv += v * v; Su += u * w; Sv += v * w; }
        const det = Suu * Svv - Suv * Suv;
        if (Math.abs(det) < 1e-12) continue;
        const cu = (Su * Svv - Sv * Suv) / (2 * det), cv = (Sv * Suu - Su * Suv) / (2 * det);
        const cc = add(g0, add(scl(e1, cu), scl(e2, cv)));
        const rs = ps.map((p) => len(sub(sub(p, cc), scl(ax, dot(sub(p, cc), ax)))));
        const rbar = rs.reduce((s2, x) => s2 + x, 0) / rs.length;
        if (rbar < 10 * tol || rs.some((x) => Math.abs(x - rbar) > tol)) continue;
        const angOf = (p) => (Math.atan2(dot(sub(p, cc), e2), dot(sub(p, cc), e1)) * 180) / Math.PI;
        let items = lv.items.map((o, i) => ({ o, a: angOf(ps[i]) })).sort((x, y) => x.a - y.a);
        const n = items.length;
        // 相邻角差；最大的那个空当之后是第 0 个成员（整圈时各个空当一样大）
        const gaps = items.map((it, i) => ((items[(i + 1) % n].a - it.a) % 360 + 360) % 360 || 360);
        const gi = gaps.indexOf(Math.max(...gaps));
        items = [...items.slice(gi + 1), ...items.slice(0, gi + 1)];
        const full = gaps.every((x) => Math.abs(x - 360 / n) < 0.05);
        const step = full ? 360 / n : ((items[n - 1].a - items[0].a) % 360 + 360) % 360 / (n - 1);
        // 部分圆弧至少 4 个：任意 3 个等距的点都落在一段圆弧上，不算规律；角步长太小就是直线，交给平移
        if (!full && (n < 4 || step < 2)) continue;
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
    // 规模（大组）：空间格网每组建一次（查找时跳过已用的成员），只从参与过这个运动的成员出发找链——
    // 阵列里相邻的两个成员一定在彼此的近邻里，配对时就记进了这个运动
    const cellB = 2 * tol, ckB = (p) => p.map((x) => Math.floor(x / cellB)), gridB = new Map();
    if (BIG) for (const o of g) { const k = ckB(centerOf(o)).join(','); if (!gridB.has(k)) gridB.set(k, []); gridB.get(k).push(o); }
    let freeAll = null, usedSeen = -1;
    for (const { motion, pairs, ids } of clusters) {
      // 只出现过一次的运动构不成 3 个以上的链，也拼不成网格（网格的每个方向至少两对）
      if (pairs < 2) continue;
      if (used.size !== usedSeen) { freeAll = g.filter((o) => !used.has(o.id)); usedSeen = used.size; }
      if (freeAll.length < 2) break;
      const free = BIG ? freeAll.filter((o) => ids.has(o.id)) : freeAll;
      const next = new Map();
      const orientAfter = (m, o) => (m.rot ? o.cols.map((c) => rotAbout(m.u, m.deg, [0, 0, 0], c)) : m.delta ? o.cols.map((c) => mvC(Ry(m.delta), c)) : o.cols);
      // 按中心的空间哈希找“运动之后落在哪个成员上”
      const cell = 2 * tol, ck = (p) => p.map((x) => Math.floor(x / cell));
      let grid = gridB;
      if (!BIG) { grid = new Map(); for (const o of free) { const k = ck(centerOf(o)).join(','); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(o); } }
      // 规模：按“收集相邻格子再查找”同样的顺序直接在格子里找，找到就停（不分配数组）
      const findNear = (p, ok) => {
        const q = ck(p);
        for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) for (const x of grid.get(`${q[0] + i},${q[1] + j},${q[2] + k}`) ?? []) if (ok(x)) return x;
        return undefined;
      };
      for (const a of free) {
        const p = apply(motion, a), oc = orientAfter(motion, a);
        const b = findNear(p, (x) => x !== a && (!BIG || !used.has(x.id)) && close(centerOf(x), p) && sameOrientation(x, toRows(oc)));
        if (b) next.set(a.id, b);
      }
      const hasPrev = new Set([...next.values()].map((b) => b.id));
      const chains = [], inChain = new Set();
      const follow = (a) => { const ch = [a]; inChain.add(a.id); for (let x = next.get(a.id); x && !inChain.has(x.id); x = next.get(x.id)) { ch.push(x); inChain.add(x.id); } return ch; };
      for (const a of free) if (!hasPrev.has(a.id) && next.has(a.id)) chains.push(follow(a));
      // 闭环（例如绕一圈的旋转对称）：每个成员都有前驱，任选一个开始
      for (const a of free) if (!inChain.has(a.id) && next.has(a.id)) chains.push(follow(a));
      // 先试着把等长的链拼成网格，剩下的链再单独作为直线阵列（否则 5×4 的网格会被拆成 4 排）
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
      for (const ch of chains) if (ch.length >= 3 && !ch.some((o) => used.has(o.id))) { raw.push({ motion, members: ch }); ch.forEach((o) => used.add(o.id)); }
    }
    findRings(() => true);
    // 有缺口的阵列：常规检测剩下的物体按格点拟合，允许少数缺位（写成 repeat 加 drop 阵列.k）。
    // 至少 3 个成员、缺位不超过五分之一（至少允许 1 个）、第 0 个实例必须在——它决定阵列原点与部件的写法
    const holesOk = (n, present) => present >= 3 && present < n && n - present <= Math.max(1, Math.floor(n / 5));
    // 大组只用支持最多的几个平移方向（clusters 已按配对数排好）
    const trans = clusters.filter((c) => !c.motion.delta && !c.motion.rot).slice(0, BIG ? 8 : Infinity).map((c) => c.motion.step);
    const isXv = (v) => Math.abs(v[1]) < 1e-6 && Math.abs(v[2]) < 1e-6, isZv = (v) => Math.abs(v[0]) < 1e-6 && Math.abs(v[1]) < 1e-6;
    // 已经认出的完整平移阵列可以被吸收：例如一排 6 根拆掉第 3 根，常规检测只认得出后 3 根
    for (;;) {
      const owned = new Map();
      for (const e of raw.slice(rawStart)) if (!e.motion.rot && !e.motion.delta) for (const o of e.members) owned.set(o.id, e);
      const free = g.filter((o) => !used.has(o.id) || owned.has(o.id));
      if (free.length < 3) break;
      let best = null;
      // 以 a 为第 0 个实例、沿 s1（与 s2）的格点上有哪些成员
      // 规模：中心预先算好，内层只做标量运算（运算顺序与向量写法相同，结果逐位一致）
      const cs = free.map(centerOf);
      const lattice = (a, s1, s2) => {
        const at = new Map(), ca = centerOf(a), rows = toRows(a.cols);
        const s11 = s1[0] * s1[0] + s1[1] * s1[1] + s1[2] * s1[2], s22 = s2 ? s2[0] * s2[0] + s2[1] * s2[1] + s2[2] * s2[2] : 1;
        free.forEach((b, bi) => {
          const c = cs[bi], d0 = c[0] - ca[0], d1 = c[1] - ca[1], d2 = c[2] - ca[2];
          const i = Math.round((d0 * s1[0] + d1 * s1[1] + d2 * s1[2]) / s11), j = s2 ? Math.round((d0 * s2[0] + d1 * s2[1] + d2 * s2[2]) / s22) : 0;
          if (i < 0 || j < 0 || i > 63 || j > 63) return;
          const p0 = ca[0] + (s1[0] * i + (s2 ? s2[0] * j : 0)), p1 = ca[1] + (s1[1] * i + (s2 ? s2[1] * j : 0)), p2 = ca[2] + (s1[2] * i + (s2 ? s2[2] * j : 0));
          if (!(Math.hypot(p0 - c[0], p1 - c[1], p2 - c[2]) < tol) || !sameOrientation(b, rows)) return;
          at.set(`${i},${j}`, { b, i, j });
        });
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
  const samePose = (p, q) => len(sub(p.t, q.t)) < 2e-3 * S && sameOrientation(p.b, toRows(q.b.cols.map((c) => mvC(p.a.cols, mvT(q.a.cols, c)))));
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
// fitworker.mjs 用：一个部件的拟合，加上它可能用到的“基本体之并”的几何（条件与 unionWorth 相同，决定层与选项留给主线程）
export function prefitPart(tris, i, role = 'structure', meshPriceCfg = null) {
  MESH_K = { ...SCORE_DEFAULTS, meshPrice: meshPriceCfg ?? {} };
  const fit = fitPart({ tris, role }, i);
  return { fit, union: FID.name !== 'semantic' && fit.e > TOL && tris.length >= 8 ? unionGeometry(tris) : undefined };
}
// 享元类型的分组键：同一个网格、同样的缩放与镜像（不能成类型的返回 null）；R 是去掉缩放与镜像的旋转，t 是平移。fitpool.mjs 也用它
export function typeKey(p, role) {
  if (!p.matrix || p.mesh == null || p.force || role === 'helper') return null;
  const M = p.matrix, cs = [[M[0], M[1], M[2]], [M[4], M[5], M[6]], [M[8], M[9], M[10]]], sc = cs.map(len);
  if (sc.some((x) => x < 1e-9)) return null;
  let R = cs.map((c, k) => scl(c, 1 / sc[k]));
  if (Math.abs(dot(R[0], R[1])) > 1e-4 || Math.abs(dot(R[0], R[2])) > 1e-4 || Math.abs(dot(R[1], R[2])) > 1e-4) return null; // 有切变：不是刚体 + 缩放
  const sign = det3c(R) < 0 ? -1 : 1;
  if (sign < 0) R = [scl(R[0], -1), R[1], R[2]]; // 镜像实例：反射吸收进类型自己的坐标系
  return { key: `${p.mesh}|${sc.map((x) => x.toFixed(3)).join(',')}|${sign}`, R, t: [M[12], M[13], M[14]] };
}
// worker 线程里：拟合之后接着算组合写法（板件、外壳、并、小场景，即 panelPrim）——这是大场景逆向的大头，串行时 H1 要一分多钟。
// 结果与主线程现算的逐字一致：只依赖这个部件自己的三角形、角色、名字（网格引用的源）、档位与这几个开关；
// 只对不共用网格的部件预先算（共用的走享元类型；不共用时网格引用的价钱不用分摊，MESH_USE 视为 1）。
// 共用网格、但没成类型的部件（镜像或缩放不同的实例）也可以：同一个网格的部件在同一个 worker 里按序号依次算（扫掠、并的缓存按网格与矩阵，
// 行为与主线程相同），网格的实例数（MESH_USE）由主线程给。先调一次 prefitCompositeInit，再逐个调 prefitComposite。
// item：部件的可序列化部分（tris、name、uid、from、mesh、material、matrix、force）；返回 { fit, union, comp: { out, sc（分散的块数）} }
export function prefitCompositeInit({ meshUse = [], meshPrice = null, partsFile = null, panels = true, shells = true, unions = true, subs = true }) {
  MESH_K = { ...SCORE_DEFAULTS, meshPrice: meshPrice ?? {} };
  PARTS_FILE = partsFile; PANELS = panels; SHELLS = shells; UNIONS = unions; SUBS = subs;
  MESH_USE = new Map(meshUse); JUDGES = new WeakMap(); SCATTERED = new WeakMap(); PART_ROLE = new WeakMap(); HEIGHT = null;
  COMPOSITE_MS = { panels: 0, unions: 0, shells: 0 }; UNION_SEEN = new Map(); SWEEP_SEEN = new Map(); SWEEP_FAILED = new Set();
}
export function prefitComposite(item, i, { role = 'structure', srcFile }) {
  const part = { ...item, role };
  const fit = fitPart(part, i);
  const union = FID.name !== 'semantic' && fit.e > TOL && item.tris.length >= 8 ? unionGeometry(item.tris) : undefined;
  PREFIT = { unionOf: () => union };
  try {
    const prim0 = primitiveOf(fit, part, srcFile);
    const out = panelPrim(fit, part, prim0, i);
    return { fit, union, comp: { out, sc: SCATTERED.get(part) ?? null } };
  } finally { PREFIT = null; }
}

export function _debugFits(part, i) {
  const pts = samplePoints(part.tris, 600, i + 1);
  const vol = meshVolume(part.tris);
  return [uprightFrame(pts), pcaFrame(pts), normalFrame(part.tris, pts)].filter(Boolean).map((F) => ({ F, fit: fitInFrame(F, pts, vol) }));
}
