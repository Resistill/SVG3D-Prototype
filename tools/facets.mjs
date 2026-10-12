// 平面块 → 多边形平板（plate）：一个网格里连成一片、共面的三角形是一块“面”，它的外轮廓是一个多边形——
// 发射台两翼的斜坡、不规则的地块、屋面、坡道。盒子、楔形只能用阶梯去凑斜着的边（一边缺、一边多），平板按轮廓写，几个顶点就够。
//   面：相邻（共边）、法线相差不到 angle、顶点离种子平面不超过 tau 的三角形连成一片；按面积从大到小当种子。
//   轮廓：面里只用了一次的边连成环，取面积最大的环（外轮廓），按 tau 化简（Douglas–Peucker）；其余的环是洞。
//   厚度：法线相反、在它背后不超过 maxThick、投影大部分重叠的另一块面和它配成一块板（厚度 = 两面距离；那一块面、
//   以及夹在两面之间的侧面都算进这块板）；配不上的（地面、屋面这类单面）按 thick，板长在面的背后（面就是板的顶面）。
//   洞：面积够大的洞写成 subtract { plate body … ; plate hole … }。
// 输入在物体坐标系里（y 朝上）；返回 { lines, plates, area: 写进板的面的面积, areaAll } 或 null（面太多）。
// 不认具体的东西：只用平面、连通与面积
import { polyArea2 } from '../src/s3d.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scl(a, 1 / (len(a) || 1));
const fmt = (x, d) => { const v = Math.round(x * 10 ** d) / 10 ** d; return Object.is(v, -0) ? '0' : String(v); };
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// 闭合折线的 Douglas–Peucker：先取离第一个点最远的点把环切成两段，各自化简
function simplifyLoop(P, tol) {
  if (P.length <= 3) return P;
  const segDist = (p, a, b) => { const d = [b[0] - a[0], b[1] - a[1]], L2 = d[0] * d[0] + d[1] * d[1]; const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2)) : 0; return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]); };
  const dp = (ps) => {
    if (ps.length < 3) return ps;
    const A = ps[0], B = ps[ps.length - 1];
    let iMax = 0, dMax = 0;
    for (let i = 1; i < ps.length - 1; i++) { const e = segDist(ps[i], A, B); if (e > dMax) { dMax = e; iMax = i; } }
    return dMax <= tol ? [A, B] : [...dp(ps.slice(0, iMax + 1)).slice(0, -1), ...dp(ps.slice(iMax))];
  };
  let far = 0, dF = -1;
  P.forEach((p, i) => { const d = Math.hypot(p[0] - P[0][0], p[1] - P[0][1]); if (d > dF) { dF = d; far = i; } });
  const a = dp(P.slice(0, far + 1)), b = dp([...P.slice(far), P[0]]);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : P;
}
const inPoly = (p, P) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const polyDist = (p, P) => {
  let best = Infinity;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], d = [b[0] - a[0], b[1] - a[1]], L2 = d[0] * d[0] + d[1] * d[1];
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / L2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]));
  }
  return best;
};

// 三角形 → 面（连成一片、共面）
export function facetsOf(tris, { tau, angle = 5 }) {
  const cosA = Math.cos((angle * Math.PI) / 180);
  // 顶点焊接：相距不到 w 的顶点算同一个（网格里常有相差一毫米的“同一个点”，按取整的键会分成两个，
  // 共边对不上、T 形接缝的修补又把边从这里切开，整块面的轮廓就乱了）。空间哈希，查相邻的 27 格
  const q = Math.max(tau * 1e-3, 1e-6), w = Math.max(tau * 0.02, 1e-5);
  const cells = new Map(), reps = [];
  const key = (v) => {
    const c = v.map((x) => Math.floor(x / w));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const r of cells.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? []) if (Math.abs(reps[r][0] - v[0]) <= w && Math.abs(reps[r][1] - v[1]) <= w && Math.abs(reps[r][2] - v[2]) <= w) return `v${r}`;
    }
    const r = reps.length, ck = c.join();
    reps.push(v);
    if (!cells.has(ck)) cells.set(ck, []);
    cells.get(ck).push(r);
    return `v${r}`;
  };
  // 退化的三角形（两个顶点重合、面积几乎为 0）不要：它们的边会把共边计数弄乱，整块面就没有轮廓了
  const info = tris.map((t) => { const c = cross(sub(t[1], t[0]), sub(t[2], t[0])), k = t.map(key); let a = len(c) / 2; if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2] || a < q * q) a = 0; return { n: a > 0 ? scl(c, 1 / (2 * a)) : [0, 1, 0], a, k }; });
  // 相邻：共用一个顶点就算（布尔运算、拼接出来的网格常有 T 形接缝，共边的判断会把一块面切成好几片）
  const byVert = new Map();
  info.forEach((x, i) => { if (!(x.a > 0)) return; for (const k of new Set(x.k)) { if (!byVert.has(k)) byVert.set(k, []); byVert.get(k).push(i); } });
  const region = new Int32Array(tris.length).fill(-1), out = [];
  const order = [...tris.keys()].filter((i) => info[i].a > 0).sort((i, j) => info[j].a - info[i].a);
  for (const s0 of order) {
    if (region[s0] >= 0) continue;
    const n = info[s0].n, d = dot(n, tris[s0][0]), id = out.length, members = [s0];
    region[s0] = id;
    for (let h = 0; h < members.length; h++) {
      for (const k of info[members[h]].k) for (const j of byVert.get(k) ?? []) {
        if (region[j] >= 0 || dot(info[j].n, n) < cosA || tris[j].some((v) => Math.abs(dot(n, v) - d) > tau)) continue;
        region[j] = id;
        members.push(j);
      }
    }
    // 平面按面积加权重新拟合（法线取平均、过加权的形心）：容差放宽时种子三角形不一定在中间
    let nn = [0, 0, 0], cc = [0, 0, 0], A = 0;
    for (const i of members) { const a = info[i].a; nn = add(nn, scl(info[i].n, a)); cc = add(cc, scl(add(add(tris[i][0], tris[i][1]), tris[i][2]), a / 3)); A += a; }
    const n1 = unit(nn), c1 = scl(cc, 1 / A);
    out.push({ n: n1, d: dot(n1, c1), c: c1, ids: members, area: A });
  }
  // 每块面的边界环：只用了一次的边，按三角形的绕向连起来。T 形接缝先修好：落在一条边中间的顶点把这条边切开
  // （否则长边与对面的几条短边对不上，都成了“边界”）
  const tj = 4 * q;
  for (const F of out) {
    const pos = new Map();
    for (const i of F.ids) for (let e = 0; e < 3; e++) pos.set(info[i].k[e], tris[i][e]);
    const keys = [...pos.keys()], dir = [];
    for (const i of F.ids) for (let e = 0; e < 3; e++) {
      const a = info[i].k[e], b = info[i].k[(e + 1) % 3];
      if (a === b) continue;
      const A = pos.get(a), B = pos.get(b), AB = sub(B, A), L2 = dot(AB, AB);
      const mids = [];
      if (keys.length <= 4000) for (const k of keys) {
        if (k === a || k === b) continue;
        const P = pos.get(k), t = dot(sub(P, A), AB) / L2;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        if (len(sub(P, add(A, scl(AB, t)))) <= tj) mids.push([t, k]);
      }
      mids.sort((x, y) => x[0] - y[0]);
      const chain = [a, ...mids.map((m) => m[1]), b];
      for (let c = 0; c + 1 < chain.length; c++) dir.push([chain[c], chain[c + 1]]);
    }
    const used = new Map();
    for (const [a, b] of dir) { const k2 = a < b ? `${a}|${b}` : `${b}|${a}`; used.set(k2, (used.get(k2) ?? 0) + 1); }
    const adj = new Map(), link = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    for (const [k2, c] of used) { if (c !== 1) continue; const [a, b] = k2.split('|'); link(a, b); link(b, a); }
    const gone = new Set(), ek = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const nextOf = (v) => (adj.get(v) ?? []).find((w) => !gone.has(ek(v, w)));
    const loops = [];
    for (const start of adj.keys()) {
      while (nextOf(start) != null) {
        const path = [start], at = new Map([[start, 0]]);
        let cur = start;
        for (let guard = 0; guard < 1e6; guard++) {
          const nx = nextOf(cur);
          if (nx == null) break;
          gone.add(ek(cur, nx));
          if (at.has(nx)) {
            // 回到路上的点：切下这一圈（一块面只在一个顶点上连着时有好几圈）
            const k = at.get(nx), ring = path.slice(k);
            for (const v of ring) at.delete(v);
            path.length = k;
            if (ring.length >= 3) loops.push(ring.map((v) => pos.get(v)));
            if (!path.length) break;
            at.set(nx, path.length);
            path.push(nx);
            cur = nx;
            continue;
          }
          at.set(nx, path.length);
          path.push(nx);
          cur = nx;
        }
      }
    }
    F.loops = loops;
  }
  return out;
}

// 面的坐标系：y = 法线（接近坐标轴的吸附到轴上），x 取水平方向（y × n；水平的面取世界 x），z = x × y。
// x 水平时朝向正好是 turn（绕竖直轴）再 tilt（顶部倒向前），写成 turn= tilt= 两个角，比任意轴的 rot 好读
function frameOf(n0) {
  let n = n0;
  for (const a of AXES) if (dot(a, n0) > Math.cos((1 * Math.PI) / 180)) n = a;
  const h = cross([0, 1, 0], n), ex = len(h) > 1e-9 ? unit(h) : [1, 0, 0];
  return [ex, n, cross(ex, n)];
}
const fmtAng = (a) => { const v = Math.round(a * 100) / 100; return Object.is(v, -0) ? '0' : String(v); };
function orientOf([ex, n]) {
  const th = Math.atan2(-ex[2], ex[0]), ez0 = [Math.sin(th), 0, Math.cos(th)];
  const phi = Math.atan2(dot(n, ez0), n[1]);
  const t = fmtAng((th * 180) / Math.PI), p = fmtAng((phi * 180) / Math.PI);
  return [t !== '0' ? `turn=${t}` : '', p !== '0' ? `tilt=${p}` : ''].filter(Boolean).join(' ');
}

export function facetPlates(tris, { tau, thick, maxThick, digits = 2, angle = 5, maxPlates = 200, minArea = 0 }) {
  const facets = facetsOf(tris, { tau, angle }).sort((a, b) => b.area - a.area);
  const areaAll = facets.reduce((a, F) => a + F.area, 0);
  // 每块面：坐标系、在法线上的位置；外轮廓与洞按绕向分（与面里三角形同向的是外轮廓，反向的是洞），
  // 洞归到包住它的外轮廓；每个外轮廓一块板（units）
  const units = [];
  for (const F of facets) {
    const cols = frameOf(F.n), [ex, n, ez] = cols;
    const p0 = F.c;
    const to2 = (v) => [dot(sub(v, p0), ex), dot(sub(v, p0), ez)];
    // 外轮廓与洞按包含关系分（不看绕向）：从大到小，落在已有外轮廓里的是洞，否则是又一个外轮廓
    const loops = F.loops.map((L) => L.map(to2)).map((L) => ({ L, A: polyArea2(L) / 2 })).sort((a, b) => Math.abs(b.A) - Math.abs(a.A));
    const outers = [], holeList = [];
    for (const x of loops) (outers.some((O) => inPoly(x.L[0], O.L) && inPoly(x.L[Math.floor(x.L.length / 2)], O.L)) ? holeList : outers).push(x);
    Object.assign(F, { cols, p0, to2, dn: dot(n, p0) });
    // 洞：只有真的空着的才挖——同一个网格里别的面（倾角略不同的一片）把它填上了的，不是洞（挖了就少一块）
    const mine = new Set(F.ids);
    const filled = (H) => tris.some((t, i) => {
      if (mine.has(i)) return false;
      const c = scl(add(add(t[0], t[1]), t[2]), 1 / 3);
      return Math.abs(dot(n, c) - F.dn) <= maxThick + tau && inPoly(to2(c), H.L);
    });
    const holes = holeList.filter((x) => Math.abs(x.A) > 4 * tau * tau && !filled(x));
    const own = outers.map(() => []);
    for (const H of holes) { const k = outers.findIndex((O) => inPoly(H.L[0], O.L)); if (k >= 0) own[k].push(H); }
    outers.forEach((O, k) => {
      const holeA = own[k].reduce((a, H) => a + Math.abs(H.A), 0);
      units.push({ F, n, cols, to2, dn: F.dn, p0, outer: simplifyLoop(O.L, tau), holes: own[k].map((H) => simplifyLoop(H.L, tau)), area: Math.abs(O.A) - holeA, ids: F.ids });
    });
  }
  units.sort((a, b) => b.area - a.area);
  const done = new Set(), lines = [], names = new Map();
  const name = (k) => { const c = (names.get(k) ?? 0) + 1; names.set(k, c); return c === 1 ? k : `${k}_${c}`; };
  let covered = 0, plates = 0;
  for (const U of units) {
    if (done.has(U) || U.outer.length < 3 || U.area < minArea || Math.abs(polyArea2(U.outer)) < 2 * tau * tau) continue;
    done.add(U);
    const [ex, n, ez] = U.cols;
    // 配对：背后的反向面（同一块面的别的外轮廓不算）
    let h = thick, mate = null;
    for (const G of units) {
      if (done.has(G) || G.F === U.F || dot(G.n, n) > -Math.cos((angle * Math.PI) / 180)) continue;
      const t = U.dn - dot(n, G.p0);
      if (!(t > 0.5 * tau && t <= maxThick)) continue;
      // 投影：G 的面积不比 U 小太多、G 的轮廓点大多落在 U 的轮廓里
      const g2 = G.outer.map((p) => U.to2(add(G.p0, add(scl(G.cols[0], p[0]), scl(G.cols[2], p[1])))));
      const inside = g2.filter((p) => inPoly(p, U.outer) || polyDist(p, U.outer) <= 2 * tau).length;
      if (G.area < 0.5 * U.area || inside < 0.8 * g2.length) continue;
      h = t; mate = G;
      break;
    }
    if (mate) {
      done.add(mate); covered += mate.area;
      // 夹在两面之间、轮廓上的侧面
      for (const G of units) {
        if (done.has(G) || Math.abs(dot(G.n, n)) > 0.2) continue;
        const vs = G.outer.map((p) => add(G.p0, add(scl(G.cols[0], p[0]), scl(G.cols[2], p[1]))));
        if (vs.every((v) => { const y = dot(n, v); return y <= U.dn + tau && y >= U.dn - h - tau && polyDist(U.to2(v), U.outer) <= 2 * tau; })) { done.add(G); covered += G.area; }
      }
    }
    covered += U.area;
    // 原点：外轮廓包围框的中心（底面上）；轮廓坐标相对它
    const xs = U.outer.map((p) => p[0]), zs = U.outer.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const at = add(add(U.p0, add(scl(ex, cx), scl(ez, cz))), scl(n, -h));
    const ptsText = (P) => `[${P.map(([x, z]) => `(${fmt(x - cx, digits)},${fmt(z - cz, digits)})`).join('; ')}]`;
    const orient = orientOf(U.cols);
    const kind = Math.abs(n[1]) > 0.9 ? 'floor' : Math.abs(n[1]) < 0.2 ? 'wall' : 'slope';
    const nm = name(kind);
    const holes = U.holes.filter((H) => H.length >= 3);
    if (holes.length) {
      // 洞的坐标与外轮廓同一个原点：pin=origin（不按洞自己的包围盒放）
      const e = Math.max(tau, 0.01);
      lines.push(`subtract ${nm} at=${at.map((v) => fmt(v, digits)).join(',')} pin=origin${orient ? ' ' + orient : ''} {`, `  plate body points=${ptsText(U.outer)} h=${fmt(h, digits)} at=0,0,0 pin=origin`,
        ...holes.map((H, k) => `  plate hole${k ? '_' + (k + 1) : ''} points=${ptsText(H)} h=${fmt(h + 2 * e, digits)} at=0,${fmt(-e, digits)},0 pin=origin`), '}');
    } else lines.push(`plate ${nm} points=${ptsText(U.outer)} h=${fmt(h, digits)} at=${at.map((v) => fmt(v, digits)).join(',')}${orient ? ' ' + orient : ''}`);
    if (++plates > maxPlates) return null;
  }
  return lines.length ? { lines, plates, area: covered, areaAll } : null;
}
