// 板件分解：有内部空间的大分量（一栋楼的外壳：外墙、楼板、内墙、坡道连成一个网格）写成一个实心盒子或粗体素都不对。
// 三角形按所在平面聚类，每个平面在板内二维坐标里栅格化、合并成矩形——墙板、楼板、坡道；门窗洞是空出来的格子。
//   方向相反、相距不超过 maxThick 的两个平行面配成一块板，厚度 = 两面的距离；配不上的（单面的薄板）按 thick；
//   一块板的覆盖是“一个大矩形挖掉几个洞”、并且这样写更短时，写成 subtract { box body ; box hole … }。
// 不认具体的建筑：只用平面、方向与覆盖。输入输出都在物体坐标系里（y 朝上）。
import { orientText } from './reverse.mjs';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scl(a, 1 / (len(a) || 1));
const fmt = (x, d) => { const v = Math.round(x * 10 ** d) / 10 ** d; return Object.is(v, -0) ? '0' : String(v); };
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// 三角形 → 平面 [{ n, d, tris, area }]：先按法线方向聚类（8° 以内），再按偏移聚类（tol 以内）；接近坐标轴（3° 以内）的方向吸附到轴上
export function planesOf(tris, { tol, minFrac = 0.005 } = {}) {
  const items = [];
  let total = 0;
  for (const t of tris) {
    const n0 = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = len(n0) / 2;
    if (a < 1e-12) continue;
    items.push({ t, n: scl(n0, 1 / (2 * a)), a, c: scl(add(add(t[0], t[1]), t[2]), 1 / 3) });
    total += a;
  }
  items.sort((x, y) => y.a - x.a);
  const COS = Math.cos((8 * Math.PI) / 180), SNAP = Math.cos((3 * Math.PI) / 180);
  // 每个方向簇的单位方向 u = unit(sum) 只在 sum 变了时重算（数值与每次现算相同）
  const dirs = [];
  for (const it of items) {
    let best = null, bestDot = 0;
    for (const d of dirs) { const c = dot(d.u, it.n); if (c > COS && (!best || c > bestDot)) { best = d; bestDot = c; } }
    if (!best) dirs.push((best = { sum: [0, 0, 0], area: 0, items: [] }));
    best.sum = add(best.sum, scl(it.n, it.a)); best.u = unit(best.sum); best.area += it.a; best.items.push(it);
  }
  const planes = [];
  for (const g of dirs) {
    if (g.area < minFrac * total) continue;
    let n = unit(g.sum);
    const ax = AXES.find((x) => dot(x, n) > SNAP);
    if (ax) n = ax;
    const byD = g.items.map((it) => ({ it, d: dot(n, it.c) })).sort((x, y) => x.d - y.d);
    let cur = null;
    for (const x of byD) {
      if (!cur || x.d - cur.d0 > tol) planes.push((cur = { n, d0: x.d, sd: 0, area: 0, tris: [] }));
      cur.sd += x.d * x.it.a; cur.area += x.it.a; cur.tris.push(x.it.t);
    }
  }
  return planes.filter((p) => p.area >= minFrac * total).map((p) => ({ n: p.n, d: p.sd / p.area, area: p.area, tris: p.tris }));
}

// 平面的板内坐标：竖直的墙（法线几乎水平）x 沿墙水平、y 朝上、z = 法线；其余（楼板、坡道）y = 偏上的那个法线方向，x、z 在板内
function frameOf(n) {
  if (Math.abs(n[1]) < 0.3) {
    const y = unit(sub([0, 1, 0], scl(n, n[1])));
    return { kind: 'wall', a: unit(cross(y, n)), b: y, t: n, cols: (x) => [x.a, x.b, x.t] };
  }
  const tUp = n[1] > 0 ? n : scl(n, -1);
  let a = cross(tUp, [0, 0, 1]);
  if (len(a) < 1e-6) a = cross(tUp, [1, 0, 0]);
  a = unit(a);
  const b = cross(a, tUp);
  return { kind: Math.abs(n[1]) > 0.95 ? (n[1] > 0 ? 'floor' : 'ceiling') : 'ramp', a, b, t: tUp, up: n[1] > 0, cols: (x) => [x.a, x.t, x.b] };
}

// 栅格化：在 (a, b) 坐标里标出被三角形覆盖的格子（格子中心落在三角形里，或者三角形的顶点落在格子里）
function rasterize(trisList, F, cell, maxCells) {
  const pts = trisList.map((t) => t.map((p) => [dot(p, F.a), dot(p, F.b)]));
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const t of pts) for (const p of t) for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  cell = Math.max(cell, (hi[0] - lo[0]) / maxCells, (hi[1] - lo[1]) / maxCells, 1e-9);
  const nu = Math.max(1, Math.ceil((hi[0] - lo[0]) / cell)), nv = Math.max(1, Math.ceil((hi[1] - lo[1]) / cell));
  // 每个格子取 2×2 个子采样点，所有三角形合起来盖住至少 2 个才算占用：共享边上不漏格、顶点附近不多出一格
  const bits = new Uint8Array(nu * nv);
  const idx = (x, k, nk) => Math.min(nk - 1, Math.max(0, Math.floor((x - lo[k]) / cell)));
  const SUB = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  for (const [p, q, r] of pts) {
    const den = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]);
    if (Math.abs(den) < 1e-18) continue;
    const i0 = idx(Math.min(p[0], q[0], r[0]), 0, nu), i1 = idx(Math.max(p[0], q[0], r[0]), 0, nu);
    const j0 = idx(Math.min(p[1], q[1], r[1]), 1, nv), j1 = idx(Math.max(p[1], q[1], r[1]), 1, nv);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (let s = 0; s < 4; s++) {
      const su = SUB[s][0], sv = SUB[s][1];
      const x = lo[0] + (i + su) * cell, y = lo[1] + (j + sv) * cell;
      const l1 = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / den, l2 = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / den;
      if (l1 >= -1e-9 && l2 >= -1e-9 && l1 + l2 <= 1 + 1e-9) bits[j * nu + i] |= 1 << s;
    }
  }
  const g = bits.map((b) => +(((b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1)) >= 2));
  return { g, nu, nv, lo, cell };
}

// 贪心合并成矩形（先沿 a 伸展，再沿 b 整行伸展）；want(i, j) 决定一个格子是否要覆盖
function rects(nu, nv, want) {
  const used = new Uint8Array(nu * nv), out = [];
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    if (used[j * nu + i] || !want(i, j)) continue;
    let i1 = i;
    while (i1 + 1 < nu && !used[j * nu + i1 + 1] && want(i1 + 1, j)) i1++;
    let j1 = j;
    const rowOk = (jj) => { for (let x = i; x <= i1; x++) if (used[jj * nu + x] || !want(x, jj)) return false; return true; };
    while (j1 + 1 < nv && rowOk(j1 + 1)) j1++;
    for (let y = j; y <= j1; y++) for (let x = i; x <= i1; x++) used[y * nu + x] = 1;
    out.push({ i0: i, i1, j0: j, j1 });
  }
  return out;
}

// 斜边：连续 ≥ 3 列，每列的格子连续、一头对齐、另一头逐列单调变化且大致在一条直线上（坡顶的墙、楼梯旁的墙、切角的楼板）。
// 按格子覆盖成矩形会是一串台阶状的窄条；写成一个矩形 + 一个楔形。
// 返回 [{ i0, i1, kind: 'top'（底边对齐、顶边斜）| 'bottom'（顶边对齐、底边斜）, fixed（对齐那一头的格子行号）, e0, e1（斜边在 i0、i1 + 1 处的位置，格子单位）}]，
// 用掉的列在 taken 里标出（taken[i] = true）
function slopeRuns(nu, nv, occ) {
  const col = [];
  for (let i = 0; i < nu; i++) {
    let b = -1, t = -1, gap = false;
    for (let j = 0; j < nv; j++) if (occ(i, j)) { if (b < 0) b = j; else if (j !== t + 1) gap = true; t = j; }
    col.push(b < 0 || gap ? null : { b, t });
  }
  const runs = [], taken = new Uint8Array(nu);
  for (const kind of ['top', 'bottom']) {
    const fixedOf = (c) => (kind === 'top' ? c.b : c.t), edgeOf = (c) => (kind === 'top' ? c.t + 1 : c.b);
    for (let i0 = 0; i0 < nu; ) {
      const c0 = col[i0];
      if (!c0 || taken[i0]) { i0++; continue; }
      let i1 = i0, dir = 0;
      while (i1 + 1 < nu && col[i1 + 1] && !taken[i1 + 1] && fixedOf(col[i1 + 1]) === fixedOf(c0)) {
        const d = Math.sign(edgeOf(col[i1 + 1]) - edgeOf(col[i1]));
        if (d && dir && d !== dir) break;
        if (d) dir = d;
        i1++;
      }
      const n = i1 - i0 + 1, xs = [], es = [];
      for (let i = i0; i <= i1; i++) { xs.push(i + 0.5); es.push(edgeOf(col[i])); }
      if (n >= 3 && dir && Math.abs(es[n - 1] - es[0]) >= 2) {
        // 最小二乘直线；台阶偏离直线不超过一格才算斜边
        const mx = xs.reduce((a, x) => a + x, 0) / n, me = es.reduce((a, e) => a + e, 0) / n;
        const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxe = xs.reduce((a, x, k) => a + (x - mx) * (es[k] - me), 0), beta = sxe / sxx;
        if (es.every((e, k) => Math.abs(e - (me + beta * (xs[k] - mx))) <= 1)) {
          runs.push({ i0, i1, kind, fixed: fixedOf(c0), e0: me + beta * (i0 - mx), e1: me + beta * (i1 + 1 - mx) });
          for (let i = i0; i <= i1; i++) taken[i] = 1;
          i0 = i1 + 1;
          continue;
        }
      }
      i0++;
    }
  }
  return { runs, taken };
}

// 板件：平面配对（方向相反、相距 0 < gap ≤ maxThick、投影有重叠）后栅格化、合并矩形
export function panelSlabs(tris, { cell, thick, maxThick, maxCells = 160, minFrac = 0.005 }) {
  const planes = planesOf(tris, { tol: Math.max(cell / 2, thick / 4), minFrac });
  planes.sort((x, y) => y.area - x.area);
  const paired = new Set(), slabs = [];
  for (const P of planes) {
    if (paired.has(P)) continue;
    paired.add(P);
    const F = frameOf(P.n);
    // 配对：Q 的法线与 P 相反，P 的外表面在 n·x = d，材料在它后面（n·x 更小），Q 在 n·x = d − gap
    let best = null;
    for (const Q of planes) {
      if (paired.has(Q) || dot(Q.n, P.n) > -0.985) continue;
      const gap = P.d + Q.d;
      if (!(gap > 1e-6 && gap <= maxThick)) continue;
      if (!best || Q.area > best.Q.area) best = { Q, gap };
    }
    if (best) paired.add(best.Q);
    const th = best ? best.gap : thick;
    const R = rasterize(best ? [...P.tris, ...best.Q.tris] : P.tris, F, cell, maxCells);
    slabs.push({ P, F, th, R, kind: F.kind });
  }
  return slabs;
}

// 板件 → 语句；boxes 超过 maxBoxes 就把格子放粗再来
export function panelLines(tris, { cell, thick, maxThick, maxBoxes = 60, digits = 2, maxCells = 160 }) {
  for (let tries = 0; tries < 6; tries++, cell *= 1.6) {
    const slabs = panelSlabs(tris, { cell, thick, maxThick, maxCells });
    const out = [], count = {};
    let boxes = 0;
    const name = (k) => { count[k] = (count[k] ?? 0) + 1; return count[k] > 1 ? `${k}_${count[k]}` : k; };
    for (const s of slabs) {
      const { g, nu, nv, lo, cell: c } = s.R, F = s.F, n = s.P.n, d = s.P.d, th = s.th;
      const full = rects(nu, nv, (i, j) => g[j * nu + i]);
      if (!full.length) continue;
      // 板的外包矩形与洞
      let bi0 = nu, bi1 = -1, bj0 = nv, bj1 = -1, occ = 0;
      for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) if (g[j * nu + i]) { occ++; bi0 = Math.min(bi0, i); bi1 = Math.max(bi1, i); bj0 = Math.min(bj0, j); bj1 = Math.max(bj1, j); }
      const holes = rects(nu, nv, (i, j) => i >= bi0 && i <= bi1 && j >= bj0 && j <= bj1 && !g[j * nu + i]);
      const fill = occ / ((bi1 - bi0 + 1) * (bj1 - bj0 + 1));
      const toAB = (r) => ({ a0: lo[0] + r.i0 * c, a1: lo[0] + (r.i1 + 1) * c, b0: lo[1] + r.j0 * c, b1: lo[1] + (r.j1 + 1) * c });
      // 矩形在物体坐标系里的底面中心、尺寸、朝向
      const place = (r) => placeAB(toAB(r));
      const placeAB = ({ a0, a1, b0, b1 }) => {
        const am = (a0 + a1) / 2, bm = (b0 + b1) / 2;
        if (F.kind === 'wall') {
          // 材料在外表面后面：厚度中心在 n·x = d − thk/2
          const at = add(add(scl(F.a, am), scl(F.b, b0)), scl(n, d - th / 2));
          return { size: [a1 - a0, b1 - b0, th], at };
        }
        // 楼板、坡道：盒子的 y 是偏上的法线方向；外表面朝上时材料在下面
        const tBottom = F.up ? d - th : -d;
        const at = add(add(scl(F.a, am), scl(F.b, bm)), scl(F.t, tBottom));
        return { size: [a1 - a0, th, b1 - b0], at };
      };
      const cols = F.cols(F), orient = orientText(cols);
      const vec = (v) => v.map((x) => fmt(x, digits)).join(',');
      // 名字：墙、坡道；水平的板不分楼板与屋顶（朝上的外表面既可能是楼面也可能是屋面），一律叫 slab
      const kind = s.kind === 'wall' || s.kind === 'ramp' ? s.kind : 'slab';
      if (holes.length && fill >= 0.6 && 2 + holes.length < full.length) {
        // 一个大矩形挖掉几个洞：subtract 的原点是外包矩形的底面中心，洞在它的坐标系里
        const body = { i0: bi0, i1: bi1, j0: bj0, j1: bj1 }, B = place(body), Bab = toAB(body);
        const lines = holes.map((h) => {
          const H = toAB(h), dx = (H.a0 + H.a1) / 2 - (Bab.a0 + Bab.a1) / 2;
          const local = F.kind === 'wall' ? [dx, H.b0 - Bab.b0, 0] : [dx, -th, (H.b0 + H.b1) / 2 - (Bab.b0 + Bab.b1) / 2];
          const size = F.kind === 'wall' ? [H.a1 - H.a0, H.b1 - H.b0, 3 * th] : [H.a1 - H.a0, 3 * th, H.b1 - H.b0];
          return `  box ${name('hole')} size=${vec(size)}${local.some((x) => Math.abs(x) > 1e-9) ? ` at=${vec(local)}` : ''}`;
        });
        out.push(`subtract ${name(kind)} at=${vec(B.at)}${orient ? ' ' + orient : ''} {`, `  box body size=${vec(B.size)}`, ...lines, '}');
        boxes += 1 + holes.length;
      } else {
        // 斜边先写成矩形 + 楔形（先按列找，再在剩下的格子里按行找），剩下的格子照常合并成矩形
        const cu = slopeRuns(nu, nv, (i, j) => g[j * nu + i]);
        const rest0 = (i, j) => g[j * nu + i] && !cu.taken[i];
        const cv = slopeRuns(nv, nu, (j, i) => rest0(i, j));
        const rest = (i, j) => rest0(i, j) && !cv.taken[j];
        const runs = [...cu.runs.map((r) => ({ ...r, axis: 'u' })), ...cv.runs.map((r) => ({ ...r, axis: 'v' }))];
        const rs = runs.length ? rects(nu, nv, rest) : full;
        for (const r of rs) { const B = place(r); out.push(`box ${name(kind)} size=${vec(B.size)} at=${vec(B.at)}${orient ? ' ' + orient : ''}`); }
        boxes += rs.length;
        // 厚度方向的中心（墙：外表面后面 th/2；楼板、坡道：同 place 里盒子的厚度中心）
        const thick = F.kind === 'wall' ? scl(n, d - th / 2) : scl(F.t, (F.up ? d - th : -d) + th / 2);
        for (const p of runs) {
          // X：斜边延伸的方向，Y：斜边变化的方向；u、v 是板内二维坐标（沿 F.a、F.b）
          const [X, Y, x0, y0] = p.axis === 'u' ? [F.a, F.b, lo[0], lo[1]] : [F.b, F.a, lo[1], lo[0]];
          const xa = x0 + p.i0 * c, xb = x0 + (p.i1 + 1) * c, E0 = y0 + p.e0 * c, E1 = y0 + p.e1 * c;
          const top = p.kind === 'top', base = top ? Math.min(E0, E1) : Math.max(E0, E1), far = top ? y0 + p.fixed * c : y0 + (p.fixed + 1) * c;
          // 矩形：对齐的那一头到斜边较近的一端
          const [r0, r1] = top ? [far, base] : [base, far];
          if (r1 - r0 > 1e-9) {
            const B = p.axis === 'u' ? placeAB({ a0: xa, a1: xb, b0: r0, b1: r1 }) : placeAB({ a0: r0, a1: r1, b0: xa, b1: xb });
            out.push(`box ${name(kind)} size=${vec(B.size)} at=${vec(B.at)}${orient ? ' ' + orient : ''}`);
            boxes++;
          }
          // 楔形（+x 一侧高）：斜边朝上、高端在 +X 时轴就是 (X, Y, X×Y)；高端在 −X 绕 Y 转半圈；斜边朝下（挂在矩形下面）绕 X 转半圈，深的一端同理
          const Z = cross(X, Y), neg = (v) => scl(v, -1), up = top ? E1 > E0 : E1 < E0;
          const wc = top ? (up ? [X, Y, Z] : [neg(X), Y, neg(Z)]) : (up ? [X, neg(Y), neg(Z)] : [neg(X), neg(Y), Z]);
          const at = add(p.axis === 'u' ? add(scl(F.a, (xa + xb) / 2), scl(F.b, base)) : add(scl(F.a, base), scl(F.b, (xa + xb) / 2)), thick);
          const wo = orientText(wc);
          out.push(`wedge ${name(kind)} size=${vec([xb - xa, Math.abs(E1 - E0), th])} at=${vec(at)}${wo ? ' ' + wo : ''}`);
          boxes++;
        }
      }
    }
    if (boxes && boxes <= maxBoxes) return { lines: out, boxes, cell, planes: slabs.length };
  }
  return null;
}

// ── 外壳 − 空腔 − 开口：空心的楼（厂房、仓库）写成 subtract shell { box outer ; box cavity ; box door … ; cyl arch … }。
// 外包盒的面上有外表面、它后面（不超过 maxThick，也不超过这个方向尺寸的 30%）有朝里的平行面——这一面是墙，朝里的面是空腔的边界；
// 至少三面墙才算空心。没有墙的一面：有外表面就当作同样厚的实心面，没有外表面就是敞开的（空腔穿出去）。
// 开口：墙的外表面在空腔正对着的范围里没被三角形盖住的连通格子——几乎填满外接矩形的是矩形洞，像“矩形 + 半圆”的是拱门。
// 剩下的三角形（楼里的楼板、内墙）交给板件。输入在物体坐标系里（y 朝上）；返回 { shell: subtract 里的语句, at: 外壳的底面中心, extra: 板件语句 } 或 null
export function shellLines(tris, { tau, digits = 2, maxThick, thick, cell: cell0, maxBoxes = 60 }) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  const ext = sub(hi, lo);
  if (Math.min(...ext) <= 4 * tau) return null;
  const planes = planesOf(tris, { tol: tau, minFrac: 0.002 });
  const sides = [];
  for (let a = 0; a < 3; a++) for (const s of [1, -1]) {
    const pos = s > 0 ? hi[a] : lo[a], [u, v] = [0, 1, 2].filter((k) => k !== a), face = ext[u] * ext[v];
    const pick = (ok) => planes.filter(ok).sort((x, y) => y.area - x.area)[0] ?? null;
    const outer0 = pick((p) => p.n[a] === s && Math.abs(p.d - s * pos) <= tau);
    // 外表面只盖住这一面的一小部分（敞开的底面只剩一圈墙脚）：这一面是敞开的
    const outer = outer0 && outer0.area >= 0.5 * face ? outer0 : null;
    const mt = Math.min(maxThick, 0.3 * ext[a]);
    // 朝里的面 n = −s·e_a：n·x = d → x_a = −s·d；墙厚 = s·(pos − x_a)
    const inner = pick((p) => p.n[a] === -s && s * (pos + s * p.d) > tau / 2 && s * (pos + s * p.d) <= mt && p.area >= 0.2 * face);
    sides.push({ a, s, pos, outer, outer0, inner, inPos: inner ? -s * inner.d : null, th: inner ? s * (pos + s * inner.d) : null });
  }
  const walls = sides.filter((x) => x.outer && x.inner);
  if (walls.length < 3) return null;
  const ths = walls.map((w) => w.th).sort((x, y) => x - y), th0 = ths[ths.length >> 1];
  const cl = [...lo], ch = [...hi];
  for (const x of sides) {
    const bound = x.inner ? x.inPos : x.outer ? x.pos - x.s * th0 : x.pos + x.s * th0;
    if (x.s > 0) ch[x.a] = bound; else cl[x.a] = bound;
  }
  if ([0, 1, 2].some((k) => cl[k] >= ch[k] - tau)) return null;
  const fmtv = (p) => p.map((x) => fmt(x, digits)).join(',');
  const bottomAt = (lo3, hi3) => [(lo3[0] + hi3[0]) / 2, lo3[1], (lo3[2] + hi3[2]) / 2];
  const boxLine = (name, lo3, hi3) => `box ${name} size=${fmtv(sub(hi3, lo3))} at=${fmtv(bottomAt(lo3, hi3))}`;
  const shell = [boxLine('outer', lo, hi), boxLine('cavity', cl, ch)];
  const found = []; // 开口：{ l3, h3（占的区域，拱门含半圆）, rect: [l3, h3], arch: { at, r, depth, axis } }
  for (const w of walls) {
    const { a, s } = w, [u, v] = a === 1 ? [0, 2] : [a === 0 ? 2 : 0, 1];
    const c = Math.max(cell0, ext[u] / 160, ext[v] / 160), nu = Math.max(1, Math.round(ext[u] / c)), nv = Math.max(1, Math.round(ext[v] / c));
    const cu = ext[u] / nu, cv = ext[v] / nv;
    // 外表面的栅格：每格 2×2 个子采样点，盖住至少 2 个算占用（同 rasterize）
    const bits = new Uint8Array(nu * nv);
    const SUB = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
    for (const t of w.outer.tris) {
      const P = t.map((p) => [(p[u] - lo[u]) / cu, (p[v] - lo[v]) / cv]);
      const [p, q, r] = P, den = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1]);
      if (Math.abs(den) < 1e-18) continue;
      const i0 = Math.max(0, Math.floor(Math.min(p[0], q[0], r[0]))), i1 = Math.min(nu - 1, Math.floor(Math.max(p[0], q[0], r[0])));
      const j0 = Math.max(0, Math.floor(Math.min(p[1], q[1], r[1]))), j1 = Math.min(nv - 1, Math.floor(Math.max(p[1], q[1], r[1])));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) for (let k = 0; k < 4; k++) {
        const x = i + SUB[k][0], y = j + SUB[k][1];
        const l1 = ((q[1] - r[1]) * (x - r[0]) + (r[0] - q[0]) * (y - r[1])) / den, l2 = ((r[1] - p[1]) * (x - r[0]) + (p[0] - r[0]) * (y - r[1])) / den;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l1 + l2 <= 1 + 1e-9) bits[j * nu + i] |= 1 << k;
      }
    }
    const covered = (i, j) => { const b = bits[j * nu + i]; return (b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1) >= 2; };
    // 洞要通到空腔里：从空腔正对着的格子开始找
    const inCav = (i, j) => { const x = lo[u] + (i + 0.5) * cu, y = lo[v] + (j + 0.5) * cv; return x > cl[u] && x < ch[u] && y > cl[v] && y < ch[v]; };
    const seen = new Uint8Array(nu * nv);
    for (let j0 = 0; j0 < nv; j0++) for (let i0 = 0; i0 < nu; i0++) {
      if (seen[j0 * nu + i0] || covered(i0, j0) || !inCav(i0, j0)) continue;
      const comp = [], stack = [[i0, j0]];
      seen[j0 * nu + i0] = 1;
      while (stack.length) {
        const [i, j] = stack.pop();
        comp.push([i, j]);
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const x = i + di, y = j + dj;
          if (x < 0 || y < 0 || x >= nu || y >= nv || seen[y * nu + x] || covered(x, y)) continue;
          seen[y * nu + x] = 1; stack.push([x, y]);
        }
      }
      // 洞可以伸出空腔正对的范围（门开到地面，而地面以上才是空腔），但大半要在里面
      if (comp.length < 4 || comp.filter(([i, j]) => inCav(i, j)).length < comp.length / 2) continue;
      const bi0 = Math.min(...comp.map((x) => x[0])), bi1 = Math.max(...comp.map((x) => x[0])), bj0 = Math.min(...comp.map((x) => x[1])), bj1 = Math.max(...comp.map((x) => x[1]));
      const W = (bi1 - bi0 + 1) * cu, H = (bj1 - bj0 + 1) * cv, u0 = lo[u] + bi0 * cu, v0 = lo[v] + bj0 * cv;
      const mid = w.pos - (s * w.th) / 2, depth = 3 * w.th;
      const opening = (vTop) => {
        const l3 = [0, 0, 0], h3 = [0, 0, 0];
        l3[a] = mid - depth / 2; h3[a] = mid + depth / 2; l3[u] = u0; h3[u] = u0 + W; l3[v] = v0; h3[v] = vTop;
        return { l3, h3 };
      };
      const fill = comp.length / ((bi1 - bi0 + 1) * (bj1 - bj0 + 1));
      // 拱门：下面是矩形，上面是直径等于宽度的半圆（只在竖直的墙上）；与洞的重合度（交 / 并）比矩形的填充率高才算
      const r = W / 2, vc = v0 + H - r, uc = u0 + r;
      let archIoU = 0;
      if (a !== 1 && vc > v0 + cv) {
        const mine = new Set(comp.map(([i, j]) => j * nu + i));
        let inter = 0, uni = mine.size;
        for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) {
          const x = lo[u] + (i + 0.5) * cu, y = lo[v] + (j + 0.5) * cv;
          const pred = y <= vc || (x - uc) ** 2 + (y - vc) ** 2 <= r * r;
          if (pred && mine.has(j * nu + i)) inter++; else if (pred) uni++;
        }
        archIoU = inter / uni;
      }
      if (fill >= 0.85 && fill >= archIoU) {
        const { l3, h3 } = opening(v0 + H);
        found.push({ a, l3, h3, rect: [l3, h3] });
        continue;
      }
      if (archIoU < 0.85) continue;
      const { l3, h3 } = opening(vc);
      const at = [0, 0, 0];
      at[a] = mid; at[u] = uc; at[v] = vc - r;
      const ah = [...h3];
      ah[v] = vc + r;
      found.push({ a, l3, h3: ah, rect: [l3, h3], arch: { at, r, depth, axis: a === 0 ? 'x' : 'z' } });
    }
  }
  // 被别的开口盖住：在自己所在的墙面上的范围落在另一个开口里（穿墙的方向只要有重叠）
  const inside = (x, y) => [0, 1, 2].every((k) => (k === x.a ? x.l3[k] < y.h3[k] && x.h3[k] > y.l3[k] : x.l3[k] >= y.l3[k] - tau && x.h3[k] <= y.h3[k] + tau));
  const vol3 = (x) => (x.h3[0] - x.l3[0]) * (x.h3[1] - x.l3[1]) * (x.h3[2] - x.l3[2]);
  const holesBox = found.filter((x) => !found.some((y) => y !== x && vol3(y) > vol3(x) && inside(x, y)));
  if (holesBox.length > 12) return null;
  let nOpen = 0, nArch = 0;
  for (const x of holesBox) {
    shell.push(boxLine(++nOpen > 1 ? `opening_${nOpen}` : 'opening', ...x.rect));
    if (x.arch) shell.push(`cyl ${++nArch > 1 ? `arch_${nArch}` : 'arch'} r=${fmt(x.arch.r, digits)} h=${fmt(x.arch.depth, digits)} axis=${x.arch.axis} at=${fmtv(x.arch.at)}`);
  }
  // 外壳解释了的三角形：外表面、朝里的面、洞口四周的侧面（落在开口占的区域里）
  const used = new Set();
  const levels = [[], [], []];
  for (const x of sides) { if (x.outer0) levels[x.a].push(x.pos); if (x.inner) levels[x.a].push(x.inPos); }
  for (const t of tris) {
    const n = cross(sub(t[1], t[0]), sub(t[2], t[0])), l = len(n);
    if (!(l > 0)) { used.add(t); continue; }
    const a = [0, 1, 2].find((k) => Math.abs(n[k]) > 0.999 * l);
    if (a !== undefined && levels[a].some((y) => Math.abs((t[0][a] + t[1][a] + t[2][a]) / 3 - y) <= tau)) used.add(t);
  }
  const near = (c, b) => [0, 1, 2].every((k) => c[k] >= b.l3[k] - tau && c[k] <= b.h3[k] + tau);
  const left = tris.filter((t) => !used.has(t) && !holesBox.some((b) => near(scl(add(add(t[0], t[1]), t[2]), 1 / 3), b)));
  const area = (ts) => ts.reduce((s2, [a, b, c]) => s2 + len(cross(sub(b, a), sub(c, a))) / 2, 0);
  let extra = [];
  if (area(left) > 0.03 * area(tris)) {
    const p = panelLines(left, { cell: cell0, thick, maxThick, digits, maxBoxes });
    if (p) extra = p.lines;
  }
  return { shell, at: bottomAt(lo, hi), extra, openings: nOpen, arches: nArch };
}
