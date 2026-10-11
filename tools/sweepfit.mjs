// 扫掠拟合：截面不变、沿一条曲线走的部件（弯曲的路面、坡道、拱、螺旋扶手）→ sweep。
//   1. 中心线（主曲线）：表面采样点建 k 近邻图，从一端按图上的距离给每个点一个初始参数；按参数分箱取质心得到折线，
//      再把每个点投影到折线上、按弧长重新分箱，迭代几次（矩形截面的质心就是截面中心，圆截面同样）
//   2. 中心线依次试：水平面里的圆弧、竖直面里的圆弧、竖直轴的螺旋、Catmull-Rom 样条（控制点从少到多），误差在 tol 以内就用
//   3. 截面：沿拟合出的曲线取与编译器相同的框架（side = T × 上，up = side × T），量每个采样点的 (u, v)：
//      矩形（w = 2·max|u|，t = 2·max|v|）或圆（r = 平均半径），取误差小的
// 只用几何，不认具体的物体。输入是世界坐标的三角形；返回 null 或
//   { curve: { kind: 'arc' | 'helix' | 'spline', … }, profile: 'rect' | 'circle', w, th, r, e（相对误差，按最薄方向归一化）, length }
import { _curves } from '../src/s3d.js';
import { rng } from './parts.mjs';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scl(a, 1 / (len(a) || 1));

// 面积均匀的表面采样（不带顶点：顶点会让分箱的质心偏向细分得密的地方）
function surfaceSamples(tris, n, seed, out = []) {
  const areas = tris.map(([a, b, c]) => len(cross(sub(b, a), sub(c, a))) / 2), total = areas.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return [];
  const cum = [];
  areas.reduce((s, x, i) => (cum[i] = s + x), 0);
  const r = rng(seed);
  out.area = total;
  for (let i = 0; i < n; i++) {
    const x = r() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    const [a, b, c] = tris[lo];
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    out.push(add(a, add(scl(sub(b, a), u), scl(sub(c, a), v))));
  }
  return out;
}

// 点到折线的最近点：{ s（弧长）, q（最近点）, k（线段）, t（线段内参数，未截断）}
function project(p, poly, cum) {
  let best = null;
  for (let k = 1; k < poly.length; k++) {
    const a = poly[k - 1], d = sub(poly[k], a), L2 = dot(d, d) || 1e-30;
    const t0 = dot(sub(p, a), d) / L2, t = Math.max(0, Math.min(1, t0));
    const q = add(a, scl(d, t)), dd = len(sub(p, q));
    if (!best || dd < best.d) best = { d: dd, s: cum[k - 1] + t * (cum[k] - cum[k - 1]), q, k, t: t0 };
  }
  return best;
}
const cumOf = (poly) => { const c = [0]; for (let k = 1; k < poly.length; k++) c.push(c[k - 1] + len(sub(poly[k], poly[k - 1]))); return c; };

// 主曲线：返回有序的中心线折线（两端延到最外的投影）或 null（图不连通、太短）
// area：表面积（用来估截面的大小）
export function centerline(P, { K = 48, area } = {}) {
  const n = P.length;
  if (n < 50) return null;
  // k 近邻图（暴力，n ≈ 800）
  // 每个点只留最近的 kNN 个：点放进格网（格长按表面采样的密度，一格几个点），一圈一圈往外找，
  // 第 k 近的距离不超过已经找过的范围就停（结果与逐个比较相同；插入法维护有序的前 k 个，距离相同时编号小的在前）
  const kNN = 10, nb = [];
  const lo3 = [0, 1, 2].map((k) => Math.min(...P.map((p) => p[k]))), hi3 = [0, 1, 2].map((k) => Math.max(...P.map((p) => p[k])));
  let cell = Math.max(1e-9, 3 * Math.sqrt((area ?? 1) / n));
  // 整数键：以包围盒的角为原点（格子太多时放大，键不超过 2^53）
  while ([0, 1, 2].reduce((m, k) => m * (Math.floor((hi3[k] - lo3[k]) / cell) + 3), 1) > 2 ** 50) cell *= 2;
  const NX = Math.floor((hi3[0] - lo3[0]) / cell) + 3, NY = Math.floor((hi3[1] - lo3[1]) / cell) + 3, NZ = Math.floor((hi3[2] - lo3[2]) / cell) + 3;
  const key = (a, b, c) => (a < 0 || b < 0 || c < 0 || a >= NX || b >= NY || c >= NZ ? -1 : (a * NY + b) * NZ + c), grid = new Map();
  const cellOf = (p) => [Math.floor((p[0] - lo3[0]) / cell) + 1, Math.floor((p[1] - lo3[1]) / cell) + 1, Math.floor((p[2] - lo3[2]) / cell) + 1];
  P.forEach((p, i) => { const k = key(...cellOf(p)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  for (let i = 0; i < n; i++) {
    const ds = [], [x, y, z] = P[i], [ci, cj, ck] = cellOf(P[i]);
    const consider = (j) => {
      if (j === i) return;
      const q = P[j], d2 = (q[0] - x) ** 2 + (q[1] - y) ** 2 + (q[2] - z) ** 2;
      if (ds.length === kNN && (d2 > ds[kNN - 1][0] || (d2 === ds[kNN - 1][0] && j > ds[kNN - 1][1]))) return;
      let k = ds.length < kNN ? ds.length : kNN - 1;
      if (ds.length < kNN) ds.push(null);
      while (k > 0 && (ds[k - 1][0] > d2 || (ds[k - 1][0] === d2 && ds[k - 1][1] > j))) { ds[k] = ds[k - 1]; k--; }
      ds[k] = [d2, j];
    };
    for (let R = 0; ; R++) {
      for (let a = -R; a <= R; a++) for (let b = -R; b <= R; b++) for (let c = -R; c <= R; c++) {
        if (Math.max(Math.abs(a), Math.abs(b), Math.abs(c)) !== R) continue;
        const l = grid.get(key(ci + a, cj + b, ck + c));
        if (l) for (const j of l) consider(j);
      }
      if (ds.length === kNN && ds[kNN - 1][0] <= (R * cell) ** 2) break;
      // 点很稀（几块离得很远）：不再一圈圈找，逐个比较
      if (R >= 3) { ds.length = 0; for (let j = 0; j < n; j++) consider(j); break; }
    }
    nb.push(ds.map(([d2, j]) => [Math.sqrt(d2), j]));
  }
  // 边不能太长：采样稀的时候，宽的螺旋坡道的近邻会跨到上下相邻的一圈。上限是“第 3 近邻距离”中位数的 2.5 倍
  const d3 = nb.map((l) => l[Math.min(2, l.length - 1)][0]).sort((x, y) => x - y), dMaxE = 2.5 * d3[n >> 1];
  const adj = nb.map(() => []);
  const parent = new Int32Array(n).map((_, i) => i), find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const link = (i, j, d) => { adj[i].push([j, d]); adj[j].push([i, d]); const a = find(i), b = find(j); if (a !== b) { parent[a] = b; return true; } return false; };
  let parts = n;
  const long = [];
  for (let i = 0; i < n; i++) for (const [d, j] of nb[i]) if (d <= dMaxE) { if (link(i, j, d)) parts--; } else long.push([d, i, j]);
  // 剪掉长边把图剪碎了（点稀的地方）：长边从短到长补回，补到连通为止
  long.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
  for (const [d, i, j] of long) { if (parts === 1) break; if (find(i) !== find(j)) { link(i, j, d); parts--; } }
  // 近邻图本身就不连通（很细的管子，一圈上的点彼此最近）：把每个分量用到别的分量最短的那条边连上，直到连通
  for (;;) {
    const comp = new Int32Array(n).fill(-1);
    let nc = 0;
    for (let i = 0; i < n; i++) if (comp[i] < 0) { const st = [i]; comp[i] = nc; while (st.length) { const u = st.pop(); for (const [v] of adj[u]) if (comp[v] < 0) { comp[v] = nc; st.push(v); } } nc++; }
    if (nc === 1) break;
    // 分量 0 到其余分量最短的一条边
    let best = null;
    for (let i = 0; i < n; i++) if (comp[i] === 0) for (let j = 0; j < n; j++) if (comp[j] !== 0) { const d = len(sub(P[i], P[j])); if (!best || d < best[0]) best = [d, i, j]; }
    adj[best[1]].push([best[2], best[0]]); adj[best[2]].push([best[1], best[0]]);
  }
  // 最短路（二叉堆）
  const dijkstra = (src) => {
    const dist = new Float64Array(n).fill(Infinity), heap = [[0, src]];
    dist[src] = 0;
    const push = (e) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= e[0]) break; heap[i] = heap[p]; i = p; } heap[i] = e; };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < (m === i ? last[0] : heap[m][0])) m = l; if (r < heap.length && heap[r][0] < (m === i ? last[0] : heap[m][0])) m = r; if (m === i) break; heap[i] = heap[m]; i = m; } heap[i] = last; } return top; };
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      for (const [v, w] of adj[u]) if (d + w < dist[v]) { dist[v] = d + w; push([dist[v], v]); }
    }
    return dist;
  };
  const c = scl(P.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / n);
  let a = 0;
  for (let i = 1; i < n; i++) if (len(sub(P[i], c)) > len(sub(P[a], c))) a = i;
  const da = dijkstra(a);
  if (da.some((x) => x === Infinity)) return null;
  let b = 0;
  for (let i = 1; i < n; i++) if (da[i] > da[b]) b = i;
  const db = dijkstra(b);
  const s0 = Array.from(db);
  // 分箱的长度要比截面大：箱太细时折线会摆进截面的宽度方向，而且越迭代越摆；也不能太粗（多圈的螺旋，一箱跨的角度大，质心收向轴线）。
  // 截面周长 ≈ 表面积 / 长度，箱长先取它（8–48 箱）；折线相邻两段转过的角度超过 30° 就按比例加密再来
  const L0 = Math.max(...s0);
  let Kit = Math.max(8, Math.min(K, Math.round(L0 / Math.max(1e-9, area / L0)))), poly = null;
  for (let round = 0; round < 3; round++) {
    poly = principal(P, s0, Kit);
    if (!poly) return null;
    let turn = 0;
    for (let i = 2; i < poly.length; i++) turn = Math.max(turn, Math.acos(Math.max(-1, Math.min(1, dot(unit(sub(poly[i], poly[i - 1])), unit(sub(poly[i - 1], poly[i - 2])))))));
    const Kmax = Math.min(K, Math.floor(L0 / Math.max(1e-9, area / L0 / 4))); // 箱长不短于四分之一截面周长（扁平的带子约为半个宽度）
    const Knew = Math.min(Kmax, Math.ceil((Kit * turn) / (Math.PI / 6)));
    if (turn <= Math.PI / 6 || Knew <= Kit) break;
    Kit = Knew;
  }
  return extendEnds(P, poly);
}
// 主曲线迭代：按参数 s 分 Kit 箱取质心，再把点投影到折线上得到新的 s
function principal(P, s0, Kit) {
  let s = s0, poly = null;
  for (let it = 0; it < 4; it++) {
    const L = Math.max(...s);
    if (!(L > 0)) return null;
    const bins = Array.from({ length: Kit }, () => ({ p: [0, 0, 0], n: 0 }));
    s.forEach((x, i) => { const k = Math.min(Kit - 1, Math.floor((x / L) * Kit)); bins[k].p = add(bins[k].p, P[i]); bins[k].n++; });
    poly = bins.filter((q) => q.n).map((q) => scl(q.p, 1 / q.n));
    if (poly.length < 4) return null;
    const cum = cumOf(poly);
    s = P.map((p) => project(p, poly, cum).s);
  }
  return poly;
}
// （不做平滑：三点平均在弯曲处会让折线向里收缩，每遍乘 (1 + cos β)/2；质心的噪声交给后面的最小二乘与重新定中）
function extendEnds(P, poly) {
  // 两端延到最外的投影（分箱的质心离端面有半箱）：只看投影落在端段之外的点
  const cum = cumOf(poly), m = poly.length;
  let lo = 0, hi = 0;
  for (const p of P) {
    const pr = project(p, poly, cum);
    if (pr.k === 1 && pr.t < 0) lo = Math.min(lo, pr.t * cum[1]);
    if (pr.k === m - 1 && pr.t > 1) hi = Math.max(hi, (pr.t - 1) * (cum[m - 1] - cum[m - 2]));
  }
  poly[0] = add(poly[0], scl(unit(sub(poly[0], poly[1])), -lo));
  poly[m - 1] = add(poly[m - 1], scl(unit(sub(poly[m - 1], poly[m - 2])), hi));
  return poly;
}

// 平面里的圆（Kåsa 最小二乘）：pts 是二维点
function circle2(pts) {
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
  const n = pts.length;
  for (const [x, y] of pts) { const z = x * x + y * y; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sz += z; sxz += x * z; syz += y * z; }
  // [sxx sxy sx; sxy syy sy; sx sy n] · [A B C] = [sxz syz sz]，圆心 (A/2, B/2)，r² = C + cx² + cy²
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], rhs = [sxz, syz, sz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-18) return null;
  const col = (k) => M.map((r, i) => r.map((v, j) => (j === k ? rhs[i] : v)));
  const A = det(col(0)) / D, B = det(col(1)) / D, C = det(col(2)) / D;
  const cx = A / 2, cy = B / 2, r2 = C + cx * cx + cy * cy;
  return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null;
}
// 沿折线展开的角度（不跳 2π）
function unwrap(angles) {
  const out = [angles[0]];
  for (let i = 1; i < angles.length; i++) { let d = angles[i] - angles[i - 1]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; out.push(out[i - 1] + d); }
  return out;
}
const deg = (x) => (x * 180) / Math.PI;
// 中心线有噪声：残差的均方根在 tol 以内、最大值不超过 3 tol 才算对得上
const fits = (rs, tol) => Math.sqrt(rs.reduce((s2, r) => s2 + r * r, 0) / rs.length) <= tol && Math.max(...rs) <= 3 * tol;

// 中心线 → 曲线。tol：中心线点到曲线的最大距离
//   arc（水平）：{ kind: 'arc', plane: 'xz', c, r, a0, a1 }（角度按语言的约定：0° 指向 +x，俯视逆时针，点 = c + r(cos, 0, −sin)）
//   arc（竖直面）：{ kind: 'arc', plane: 'xy', c, r, a0, a1, yaw }（先在 xy 平面里，再绕竖直轴转 yaw 度）
//   helix：{ kind: 'helix', c（底端所在高度的轴心）, r, pitch, turns, phase }（点 = c + (r cos θ, pitch·(θ−θ0)/2π, −r sin θ)，θ 从 phase 开始）
//   spline：{ kind: 'spline', ctrl }
export function fitCurve(poly, tol) {
  const n = poly.length;
  const c = scl(poly.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / n);
  const a0 = poly[0], a1 = poly[n - 1];
  const segD = (p, a, b) => { const d = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), d) / (dot(d, d) || 1))); return len(sub(p, add(a, scl(d, t)))); };
  // 直的：交给基本体
  // 直的（偏离首尾连线不到容差，或不到连线长度的 5%：微微下垂的横杆、牌子）：交给基本体
  const dev = poly.map((p) => segD(p, a0, a1));
  if (fits(dev, tol) || Math.max(...dev) < 0.05 * len(sub(a1, a0))) return null;
  // 两个端点是外推出来的（沿端段的弦），径向会偏：判断曲线类型、拟合参数只用内部的点，端点只用来定角度范围
  const inner = poly.slice(1, -1), m = inner.length;
  const ys = inner.map((p) => p[1]), yMin = Math.min(...ys), yMax = Math.max(...ys);
  // 水平圆弧 / 螺旋：俯视是圆
  const C2 = circle2(inner.map((p) => [p[0], -p[2]]));
  if (C2 && C2.r < 1e4 * tol) {
    const angAll = unwrap(poly.map((p) => Math.atan2(-p[2] - C2.cy, p[0] - C2.cx))), ang = angAll.slice(1, -1);
    if (fits(inner.map((p) => Math.abs(Math.hypot(p[0] - C2.cx, -p[2] - C2.cy) - C2.r)), tol)) {
      const span = angAll[n - 1] - angAll[0];
      const yMean = ys.reduce((s2, y) => s2 + y, 0) / m;
      if (fits(ys.map((y) => Math.abs(y - yMean)), tol) && Math.abs(span) < 2 * Math.PI - 1e-3 && Math.abs(span) > Math.PI / 9) {
        const y = ys.reduce((s, x) => s + x, 0) / m;
        return { kind: 'arc', plane: 'xz', c: [C2.cx, y, -C2.cy], r: C2.r, a0: deg(angAll[0]), a1: deg(angAll[n - 1]) };
      }
      // 螺旋：高度随角度线性变化
      let sa = 0, sy = 0, saa = 0, say = 0;
      for (let i = 0; i < m; i++) { sa += ang[i]; sy += ys[i]; saa += ang[i] * ang[i]; say += ang[i] * ys[i]; }
      const k = (m * say - sa * sy) / (m * saa - sa * sa || 1), b0 = (sy - k * sa) / m;
      if (fits(inner.map((p, i) => Math.abs(p[1] - (k * ang[i] + b0))), tol) && Math.abs(span) > 0.5 && Math.abs(k * span) > 2 * tol) {
        // 语言里的螺旋：转角为正时俯视逆时针，高度随转过的角度增加；顺时针（转角为负）同样升高：turns 取负
        const turns = span / (2 * Math.PI), rise = k * span; // 从起点到终点的高度变化
        if (rise > 0) return { kind: 'helix', c: [C2.cx, k * angAll[0] + b0, -C2.cy], r: C2.r, pitch: Math.abs(rise / turns), turns, phase: deg(angAll[0]) };
        // 往下走的螺旋：倒过来从终点开始
        return { kind: 'helix', c: [C2.cx, k * angAll[n - 1] + b0, -C2.cy], r: C2.r, pitch: Math.abs(rise / turns), turns: -turns, phase: deg(angAll[n - 1]) };
      }
    }
  }
  // 竖直平面里的圆弧（拱）：中心线在一个竖直平面里
  {
    // 平面里的水平方向：内部点水平坐标的主方向（拱的两脚连线在平面里），首尾连线定正负
    let sxx = 0, sxz = 0, szz = 0;
    for (const p of inner) { const dx = p[0] - c[0], dz = p[2] - c[2]; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
    const th2 = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    let ex = [Math.cos(th2), 0, Math.sin(th2)];
    if (dot(ex, sub(a1, a0)) < 0) ex = scl(ex, -1);
    const h = [a1[0] - a0[0], 0, a1[2] - a0[2]];
    if (len(h) > tol) {
      const nrm = [-ex[2], 0, ex[0]];
      if (fits(inner.map((p) => Math.abs(dot(sub(p, c), nrm))), tol)) {
        const C = circle2(inner.map((p) => [dot(sub(p, a0), ex), p[1] - a0[1]]));
        if (C && fits(inner.map((p) => Math.abs(Math.hypot(dot(sub(p, a0), ex) - C.cx, p[1] - a0[1] - C.cy) - C.r)), tol)) {
          const ang = unwrap(poly.map((p) => Math.atan2(p[1] - a0[1] - C.cy, dot(sub(p, a0), ex) - C.cx)));
          if (Math.abs(ang[n - 1] - ang[0]) > Math.PI / 9) {
          // 平面 xy 里点 = c + (r cos θ, r sin θ, 0)；局部 x 转到 ex：yaw = atan2(−ex_z, ex_x)
          const yaw = deg(Math.atan2(-ex[2], ex[0]));
          return { kind: 'arc', plane: 'xy', c: add(add(a0, scl(ex, C.cx)), [0, C.cy, 0]), r: C.r, a0: deg(ang[0]), a1: deg(ang[n - 1]), yaw };
          }
        }
      }
    }
  }
  // 样条：按弧长重采样出 M 个控制点，M 从少到多，误差在 tol 以内就停
  const cum = cumOf(poly), L = cum[n - 1];
  const at = (s) => { let k = 1; while (k < n - 1 && cum[k] < s) k++; const u = (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1); return add(poly[k - 1], scl(sub(poly[k], poly[k - 1]), u)); };
  let best = null;
  for (let M = 3; M <= 8; M++) {
    const ctrl = Array.from({ length: M }, (_, k) => at((L * k) / (M - 1)));
    const line = _curves.catmullRom(ctrl, false, 10);
    const rs = poly.map((p) => { let m2 = Infinity; for (let k = 1; k < line.length; k++) m2 = Math.min(m2, segD(p, line[k - 1], line[k])); return m2; });
    const err = Math.sqrt(rs.reduce((s2, r) => s2 + r * r, 0) / rs.length);
    if (!best || err < best.err) best = { kind: 'spline', ctrl, err };
    if (fits(rs, tol)) break;
  }
  if (!best || best.err > 2 * tol) return null;
  // 语义上的“沿一条线走”：控制点连成的折线相邻两段转角不超过 60°（来回折返的是别的东西：箱盖、护栏的立柱被串成锯齿）
  const c2 = best.ctrl;
  for (let k = 2; k < c2.length; k++) if (dot(unit(sub(c2[k], c2[k - 1])), unit(sub(c2[k - 1], c2[k - 2]))) < 0.5) return null;
  return best;
}

// 曲线 → 稠密的点与切线（与编译器的曲线同一个参数化）
export function curvePoints(cv, segs = 200) {
  if (cv.kind === 'spline') {
    const pts = _curves.catmullRom(cv.ctrl, false, 10);
    return pts.map((p, i) => ({ p, T: unit(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)])) }));
  }
  const out = [];
  for (let i = 0; i <= segs; i++) {
    const s = i / segs;
    if (cv.kind === 'helix') {
      const th = ((cv.phase + 360 * cv.turns * s) * Math.PI) / 180, dth = 2 * Math.PI * cv.turns, rise = cv.pitch * Math.abs(cv.turns);
      out.push({ p: add(cv.c, [cv.r * Math.cos(th), rise * s, -cv.r * Math.sin(th)]), T: unit([-cv.r * Math.sin(th) * dth, rise, -cv.r * Math.cos(th) * dth]) });
    } else {
      const th = ((cv.a0 + (cv.a1 - cv.a0) * s) * Math.PI) / 180, dth = ((cv.a1 - cv.a0) * Math.PI) / 180;
      if (cv.plane === 'xz') out.push({ p: add(cv.c, [cv.r * Math.cos(th), 0, -cv.r * Math.sin(th)]), T: unit([-Math.sin(th) * dth, 0, -Math.cos(th) * dth]) });
      else {
        const yw = (cv.yaw * Math.PI) / 180, ex = [Math.cos(yw), 0, -Math.sin(yw)];
        out.push({ p: add(cv.c, add(scl(ex, cv.r * Math.cos(th)), [0, cv.r * Math.sin(th), 0])), T: unit(add(scl(ex, -Math.sin(th) * dth), [0, Math.cos(th) * dth, 0])) });
      }
    }
  }
  return out;
}

// 曲线上的稠密点带截面框架（与编译器的 sweepFrames 一样递推：切线竖直时沿用上一个 side）
function framed(cv) {
  const C = curvePoints(cv);
  let prev = [0, 0, 1];
  for (const x of C) { let sd = cross(x.T, [0, 1, 0]); sd = len(sd) < 1e-4 ? prev : unit(sd); prev = sd; x.side = sd; x.up = unit(cross(sd, x.T)); }
  return C;
}
// 每个采样点在截面里的 (u, v)；落在两端以外（端面上）的点标 end
function offsets(P, C) {
  return P.map((p) => {
    let best = null;
    // 先每隔 4 个点粗找，再在粗找到的点附近细找（曲线上的点等弧长分布，最近点不会跳到别处）
    const d2 = (k) => { const q = C[k].p; return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; };
    let k0 = 0;
    for (let k = 0; k < C.length; k += 4) if (d2(k) < d2(k0)) k0 = k;
    for (let k = Math.max(0, k0 - 4); k <= Math.min(C.length - 1, k0 + 4); k++) { const d = d2(k); if (!best || d < best.d) best = { d, k }; }
    const { p: q, T, side, up } = C[best.k], dq = sub(p, q), along = dot(dq, T);
    const end = (best.k === 0 && along < 0) || (best.k === C.length - 1 && along > 0);
    return { u: dot(dq, side), v: dot(dq, up), end, k: best.k };
  });
}
const quant = (xs, q) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };
// 曲线在截面框架里整体挪 (du, dv)：中心线是分箱的质心，弯曲处偏里、截面不对称时偏向一侧；按截面的上下界重新定中
function shifted(cv, C, du, dv) {
  const mid = C[C.length >> 1];
  if (cv.kind === 'spline') return { ...cv, ctrl: cv.ctrl.map((p) => { let b = C[0]; for (const x of C) if (len(sub(x.p, p)) < len(sub(b.p, p))) b = x; return add(p, add(scl(b.side, du), scl(b.up, dv))); }) };
  if (cv.kind === 'arc' && cv.plane === 'xz') {
    const out = sub(mid.p, cv.c), rad = unit([out[0], 0, out[2]]);
    return { ...cv, r: cv.r + du * Math.sign(dot(mid.side, rad)), c: add(cv.c, [0, dv, 0]) };
  }
  if (cv.kind === 'helix') {
    const out = sub(mid.p, cv.c), rad = unit([out[0], 0, out[2]]);
    return { ...cv, r: cv.r + du * Math.sign(dot(mid.side, rad)), c: add(cv.c, [0, dv / Math.max(0.2, Math.abs(mid.up[1])), 0]) };
  }
  // 竖直面里的圆弧：side 是平面的法线（整体平移），up 在平面里沿半径
  const rad = unit(sub(mid.p, cv.c));
  return { ...cv, c: add(cv.c, scl(mid.side, du)), r: cv.r + dv * Math.sign(dot(mid.up, rad)) };
}

// 截面：矩形或圆；e 是采样点到扫掠体表面的平均距离，按最薄方向归一化
// 先用 400 个采样点粗筛（k 近邻与最短路是平方的），过了再用 1000 个精算
export function fitSweep(tris, { tau, seed = 1 } = {}) {
  return looksSwept(tris, tau, seed) ? sweepWith(tris, tau, seed, 1000) : null;
}
// 粗筛：400 个采样点的中心线够长——长度至少是截面周长（表面积 / 长度）的 3 倍（扁平的带子：长度至少是宽度的 6 倍）
function looksSwept(tris, tau, seed) {
  const P = surfaceSamples(tris, 400, seed);
  const poly = P.length ? centerline(P, { area: P.area }) : null;
  if (!poly) return false;
  const L = cumOf(poly).at(-1);
  if (L * L < 3 * P.area) return false;
  // 中心线是直的：交给基本体（“直”在噪声下也判断得稳；曲线的种类留给精算）
  const cum = cumOf(poly), h = P.reduce((s2, p) => s2 + project(p, poly, cum).d, 0) / P.length;
  const a0 = poly[0], a1 = poly[poly.length - 1], tol = Math.max(tau, 0.6 * h);
  const segD = (p) => { const d = sub(a1, a0), t = Math.max(0, Math.min(1, dot(sub(p, a0), d) / (dot(d, d) || 1))); return len(sub(p, add(a0, scl(d, t)))); };
  const dev = poly.map(segD);
  return !fits(dev, tol) && Math.max(...dev) >= 0.05 * len(sub(a1, a0));
}
function sweepWith(tris, tau, seed, nSamples) {
  const P = surfaceSamples(tris, nSamples, seed);
  const poly = centerline(P, { area: P.area });
  if (!poly) return null;
  // 中心线是分箱的质心，带着截面大小量级的噪声：容差按采样点到中心线的平均距离的一半放宽（好坏最后看采样点到扫掠体的误差）
  const cumP = cumOf(poly), h = P.reduce((s2, p) => s2 + project(p, poly, cumP).d, 0) / P.length;
  let cv = fitCurve(poly, Math.max(tau, 0.5 * h));
  if (!cv) return null;
  let C = framed(cv), off = offsets(P, C);
  for (let it = 0; it < 2; it++) {
    const mid = off.filter((o) => !o.end);
    if (mid.length < 0.5 * off.length) return null;
    const du = (quant(mid.map((o) => o.u), 0.01) + quant(mid.map((o) => o.u), 0.99)) / 2, dv = (quant(mid.map((o) => o.v), 0.01) + quant(mid.map((o) => o.v), 0.99)) / 2;
    cv = shifted(cv, C, du, dv);
    C = framed(cv); off = offsets(P, C);
  }
  const mid = off.filter((o) => !o.end);
  if (mid.length < 0.5 * off.length) return null;
  const L = cumOf(C.map((x) => x.p)).at(-1);
  const w = 2 * quant(mid.map((o) => Math.abs(o.u)), 0.99), th = 2 * quant(mid.map((o) => Math.abs(o.v)), 0.99);
  const rr = mid.map((o) => Math.hypot(o.u, o.v)), r = rr.reduce((s, x) => s + x, 0) / rr.length;
  if (!(w > 0 && th > 0) || L < 4 * Math.max(w, th)) return null;
  // 真的弯：拱高（曲线离首尾连线最远的距离）至少有截面宽度的一半；否则是一根直的东西（长条花坛、横杆）被噪声拟合成了缓弧
  const e0 = C[0].p, e1 = C[C.length - 1].p, chord = sub(e1, e0), cl2 = dot(chord, chord) || 1;
  const bend = cv.kind === 'helix' ? Infinity : Math.max(...C.map((x) => { const t = Math.max(0, Math.min(1, dot(sub(x.p, e0), chord) / cl2)); return len(sub(x.p, add(e0, scl(chord, t)))); }));
  if (bend < 0.5 * Math.max(w, th)) return null;
  // 扫掠体的侧面积要和网格的表面积相当：中心线来回折返（不是沿一条线走的东西）时侧面积会大得多
  const side = Math.min(2 * (w + th), 2 * Math.PI * r) * L;
  if (!(P.area > 0.6 * side && P.area < 1.5 * side + 2 * w * th)) return null;
  const sd2 = (dx, dy) => Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
  const eRect = off.reduce((s, o) => s + (o.end ? Math.max(0, sd2(Math.abs(o.u) - w / 2, Math.abs(o.v) - th / 2)) : Math.abs(sd2(Math.abs(o.u) - w / 2, Math.abs(o.v) - th / 2))), 0) / off.length;
  const eCirc = off.reduce((s, o) => s + (o.end ? Math.max(0, Math.hypot(o.u, o.v) - r) : Math.abs(Math.hypot(o.u, o.v) - r)), 0) / off.length;
  const circle = eCirc < eRect;
  const scale = Math.max(circle ? 2 * r : Math.min(w, th), 0.02 * Math.max(w, th, L), 1e-6);
  const e = (circle ? eCirc : eRect) / scale;
  // 截面在全长上大体不变才算扫掠
  return e > 0.15 ? null : { curve: cv, profile: circle ? "circle" : "rect", w, th, r, e, length: L };
}
