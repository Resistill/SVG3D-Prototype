// 凸包近似（hull 基本体）：岩石、土丘、不规则的块。盒子、球套上去四角多出一大块（整张 SpaceCenter 上的大岩石多出 20–30%），
// 凸包贴着外形走，十几二十个点就够。
//   一块：网格顶点的凸包，只留下必要的点——从几个极点开始，每次加离当前凸包最远的那个顶点，直到其余的都在 tol 以内（或点数到上限）。
//   凹的（山崖、L 形的石堆）：连通分量各一个凸包；再按最长的方向从中间切开，切一次、两次，各块各一个凸包（交给评分挑）。
// 输入在物体坐标系里；返回 [{ pts（选出的点）, lo, hi }]，或 null（点共面）。不认具体的东西：只用几何
import { convexHull3 } from '../src/s3d.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// 面（顶点序号）→ 带法线、偏移的平面
const planesOf = (P, faces) => faces.map(([a, b, c]) => { const n = cross(sub(P[b], P[a]), sub(P[c], P[a])), l = Math.hypot(...n) || 1; return { n: n.map((x) => x / l), d: dot(n, P[a]) / l }; });
const outside = (planes, p) => { let m = -Infinity; for (const F of planes) { const e = dot(F.n, p) - F.d; if (e > m) m = e; } return m; };

export function simplifyHull(V, { tol, maxPts = 24 }) {
  if (V.length < 4) return null;
  const all = convexHull3(V);
  if (!all) return null;
  // 只有凸包上的顶点才可能被选
  const cand = [...new Set(all.flat())].map((i) => V[i]);
  // 起点：六个方向上的极点（去重），不够四个不共面的点时用整个凸包的点
  const ext = new Set();
  for (let k = 0; k < 3; k++) {
    let lo = 0, hi = 0;
    cand.forEach((p, i) => { if (p[k] < cand[lo][k]) lo = i; if (p[k] > cand[hi][k]) hi = i; });
    ext.add(lo); ext.add(hi);
  }
  let pick = [...ext].map((i) => cand[i]);
  let faces = convexHull3(pick);
  if (!faces) { pick = cand.slice(); faces = all.map((f) => f); return { pts: pick }; }
  for (;;) {
    const planes = planesOf(pick, faces);
    let far = -1, dMax = tol;
    cand.forEach((p, i) => { const e = outside(planes, p); if (e > dMax) { dMax = e; far = i; } });
    if (far < 0 || pick.length >= maxPts) break;
    pick = [...pick, cand[far]];
    const f2 = convexHull3(pick);
    if (!f2) break;
    faces = f2;
    // 加进来的点让别的点落进了凸包里面：只留凸包上的点
    const on = new Set(faces.flat());
    if (on.size < pick.length) { pick = [...on].map((i) => pick[i]); faces = convexHull3(pick); if (!faces) break; }
  }
  return { pts: pick };
}

// 三角形 → 几块（按包围盒最长的方向在中间切开，三角形按形心分）
function split(tris) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  const k = [0, 1, 2].reduce((b, j) => (hi[j] - lo[j] > hi[b] - lo[b] ? j : b), 0), mid = (lo[k] + hi[k]) / 2;
  const a = [], b = [];
  for (const t of tris) ((t[0][k] + t[1][k] + t[2][k]) / 3 < mid ? a : b).push(t);
  return a.length && b.length ? [a, b] : [tris];
}

// 几种拆法（每种是一组三角形块）：分量；分量各切一次；各切两次。块太多（> maxPieces）的拆法不要
export function hullVariants(comps, { maxPieces = 8 } = {}) {
  const out = [comps];
  let cur = comps;
  for (let d = 0; d < 2; d++) {
    cur = cur.flatMap(split);
    if (cur.length > maxPieces || cur.length === out[out.length - 1].length) break;
    out.push(cur);
  }
  return out.filter((v) => v.length <= maxPieces);
}

// 一组三角形块 → 每块一个凸包（点、包围盒）
export function hullsOf(pieces, { tol, maxPts = 24 }) {
  const out = [];
  for (const tris of pieces) {
    const seen = new Map();
    for (const t of tris) for (const v of t) seen.set(v.map((x) => Math.round(x * 1e5)).join(), v);
    const h = simplifyHull([...seen.values()], { tol, maxPts });
    if (!h) continue; // 平的一块（贴花、薄片）：凸包没有体积，不写
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of h.pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    out.push({ pts: h.pts, lo, hi });
  }
  return out;
}
