// 沿曲线的阵列：一串同样的物体，等弧长地排在一条（看不见的）曲线上，朝向随切线变化（过山车的枕木、路灯）。
// 模型与编译器的 repeat along 完全相同：第 k 个实例的原点在曲线弧长 k/N（闭合）或 k/(N−1)（不闭合）处，
// 实例坐标系由切线决定（orient=full：x 沿切线、z 水平朝外、y 为法向；yaw：只转向、保持竖直）。
// 未知量是 Catmull-Rom 的控制点和成员在实例坐标系里的固定偏移；控制点数从少到多试，用 Levenberg–Marquardt 解。
import { _curves } from '../src/s3d.js';

const { catmullRom, measureCurve, curveAt } = _curves;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => scl(a, 1 / (len(a) || 1));
const mvC = (cols, v) => add(add(scl(cols[0], v[0]), scl(cols[1], v[1])), scl(cols[2], v[2]));

// 实例坐标系（列向量），与 s3d.js 的 instLocal 一致
export function alongFrame(tan, mode) {
  if (mode === 'full') {
    const t = unit(tan);
    const side = len(cross(tan, [0, 1, 0])) > 1e-6 ? unit(cross(tan, [0, 1, 0])) : [0, 0, 1];
    return [t, cross(side, t), side];
  }
  if (mode === 'yaw' && Math.hypot(tan[0], tan[2]) > 1e-9) {
    const a = Math.atan2(-tan[2], tan[0]), c = Math.cos(a), s = Math.sin(a);
    return [[c, 0, -s], [0, 1, 0], [s, 0, c]];
  }
  return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
}

// 曲线上 N 个实例的原点与坐标系；phase 是起点的弧长相位（只在拟合时用，发射前会归零）
export function alongPoses(ctrl, closed, N, mode, phase = 0) {
  const cv = measureCurve(catmullRom(ctrl, closed), closed);
  return Array.from({ length: N }, (_, k) => {
    const a = curveAt(cv, (closed ? k / N : N > 1 ? k / (N - 1) : 0) + phase);
    return { q: a.p, M: alongFrame(a.tan, mode) };
  });
}

// 解线性方程组（高斯消元，部分主元）
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function lm(p0, resid, iters = 80) {
  let p = [...p0], r = resid(p), cost = r.reduce((s, x) => s + x * x, 0), lambda = 1e-3;
  for (let it = 0; it < iters && cost > 1e-16; it++) {
    const J = p.map((_, j) => { const q = [...p], h = 1e-6 * Math.max(1, Math.abs(p[j])); q[j] += h; return resid(q).map((x, i) => (x - r[i]) / h); });
    const n = p.length, JtJ = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, x, i) => s + x * J[b][i], 0)));
    const Jtr = J.map((col) => col.reduce((s, x, i) => s + x * r[i], 0));
    let improved = false;
    for (let tries = 0; tries < 8 && !improved; tries++) {
      const A = JtJ.map((row, a) => row.map((x, b) => (a === b ? x * (1 + lambda) + 1e-12 : x)));
      const d = solve(A, Jtr.map((x) => -x));
      if (!d) { lambda *= 10; continue; }
      const q = p.map((x, j) => x + d[j]), rq = resid(q), cq = rq.reduce((s, x) => s + x * x, 0);
      if (cq < cost) { p = q; r = rq; improved = cost - cq > 1e-18 || true; cost = cq; lambda = Math.max(lambda / 5, 1e-9); } else lambda *= 10;
    }
    if (!improved) break;
  }
  return { p, cost, r };
}

// 把一组中心排成链：每个点只与互为两个最近邻之一的点相连；度都不超过 2 的连通分量是一条链。
// 不要求等间距：等间距的是曲线上的点，成员有侧向偏移时（路肩外侧的路灯），弯道内外侧的间距可以差一倍；
// 真假交给拟合判断，这里只排除间距悬殊（超过 ratio 倍）的链
export function chainsOf(points, { min = 8, ratio = 3 } = {}) {
  const n = points.length;
  const nn = points.map((p, i) => points.map((q, j) => ({ j, d: i === j ? Infinity : len(sub(p, q)) })).sort((a, b) => a.d - b.d).slice(0, 2));
  const adj = points.map(() => new Set());
  for (let i = 0; i < n; i++) for (const { j, d } of nn[i]) {
    if (!nn[j].some((x) => x.j === i)) continue;
    adj[i].add(j); adj[j].add(i);
  }
  const seen = new Set(), out = [];
  for (let s = 0; s < n; s++) {
    if (seen.has(s)) continue;
    const comp = [], stack = [s];
    seen.add(s);
    while (stack.length) { const x = stack.pop(); comp.push(x); for (const y of adj[x]) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
    if (comp.length < min || comp.some((x) => adj[x].size > 2)) continue;
    const closed = comp.every((x) => adj[x].size === 2);
    let start = closed ? Math.min(...comp) : comp.find((x) => adj[x].size === 1);
    const order = [start], used = new Set([start]);
    for (let cur = start; ;) { const nx = [...adj[cur]].find((y) => !used.has(y)); if (nx == null) break; order.push(nx); used.add(nx); cur = nx; }
    if (order.length !== comp.length) continue;
    const ds = order.slice(1).map((x, k) => len(sub(points[x], points[order[k]])));
    if (closed) ds.push(len(sub(points[order[0]], points[order.at(-1)])));
    if (Math.max(...ds) > ratio * Math.min(...ds)) continue;
    out.push({ order, closed });
  }
  return out;
}

// 拟合：centers 已按链排好。返回控制点、偏移、模式、哪个成员是第 0 个实例（reversed 为真时先把链反向：
// 第 0 个不动、其余倒序），以及最大误差；拟合不了返回 null。
// 沿切线的偏移与起点相位几乎等价（问题病态），所以偏移只解法向与侧向两个分量。
// 闭合曲线的起点可以是链上任意一个成员，而编译器把第 0 个实例放在第 0 个控制点上：拟合时让相位自由，
// 拟合完找一个恰好落在某个成员上的控制点，把控制点与成员都循环移位到从它开始，相位就归零了。
// 水平的曲线上 full 与 yaw 完全一样（x 沿切线、y 朝上），写成默认的 yaw
const flat = (ctrl) => ctrl.every((p) => Math.abs(p[1] - ctrl[0][1]) < 1e-6);

export function fitAlong(centers, { closed, tol = 5e-4, maxK = 16, modes = ['full', 'yaw'] } = {}) {
  const N = centers.length;
  const per = 12; // 与 catmullRom 的默认采样数一致：第 j 个控制点是折线的第 j·per 个顶点
  for (const mode of modes) {
    for (let K = closed ? 3 : 2; K <= Math.min(maxK, Math.floor((N - 1) / 2)); K++) {
      // 方程（3N 个）至少是未知量（3K + 3 个）的两倍
      const pick = (j) => centers[Math.round(closed ? (j * N) / K : (j * (N - 1)) / (K - 1))];
      const p0 = [...Array.from({ length: K }, (_, j) => pick(j)).flat(), 0, 0, 0];
      const unpack = (p) => ({ ctrl: Array.from({ length: K }, (_, j) => p.slice(3 * j, 3 * j + 3)), off: [0, p[3 * K], p[3 * K + 1]], phase: closed ? p[3 * K + 2] : 0 });
      const model = (x, order = centers) => alongPoses(x.ctrl, closed, N, mode, x.phase).map(({ q, M }, k) => sub(add(q, mvC(M, x.off)), order[k]));
      const { p } = lm(p0, (q) => model(unpack(q)).flat(), 150);
      const x = unpack(p);
      if (Math.max(...model(x).map(len)) > tol) continue;
      if (!closed) return { ctrl: x.ctrl, off: x.off, mode: flat(x.ctrl) ? 'yaw' : mode, closed, N, start: 0, err: Math.max(...model(x).map(len)) };
      // 归零相位：找一个恰好落在成员上的控制点，循环移位。闭合曲线的接缝处切线不连续（t=0 用第一段的切线），
      // 链的方向与原曲线相反时会差一点——这时用反向的控制点作初值，在反方向上再解一次
      const reindex = (x, cs) => {
        const cv = measureCurve(catmullRom(x.ctrl, true), true);
        for (let j = 0; j < K; j++) {
          const f = cv.cum[j * per] / cv.total, m = (f - x.phase) * N, k0 = Math.round(m);
          if (Math.abs(m - k0) > 1e-3) continue;
          const start = ((k0 % N) + N) % N;
          const y = { ctrl: [...x.ctrl.slice(j), ...x.ctrl.slice(0, j)], off: x.off, phase: 0 };
          const err = Math.max(...model(y, [...cs.slice(start), ...cs.slice(0, start)]).map(len));
          if (err <= tol) return { ctrl: y.ctrl, off: y.off, start, err };
        }
        return null;
      };
      const r = reindex(x, centers);
      if (r) return { ...r, mode: flat(r.ctrl) ? 'yaw' : mode, closed, N, reversed: false };
      const rc = [centers[0], ...centers.slice(1).reverse()];
      const rp0 = [...[x.ctrl[0], ...x.ctrl.slice(1).reverse()].flat(), x.off[1], -x.off[2], -x.phase];
      const back = unpack(lm(rp0, (q) => model(unpack(q), rc).flat(), 60).p);
      const r2 = Math.max(...model(back, rc).map(len)) <= tol && reindex(back, rc);
      if (r2) return { ...r2, mode: flat(r2.ctrl) ? 'yaw' : mode, closed, N, reversed: true };
    }
  }
  return null;
}
