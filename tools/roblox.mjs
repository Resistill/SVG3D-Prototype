// SVG3D 场景 → Roblox 基本型（Part：Block / Wedge / Cylinder / Ball）。工具在 Roblox Studio 里按这里写出的数据拼场景（bin/roblox.mjs 写文件，
// Studio 那边用 HttpService 从预览服务器取，见 docs/agent.md「Roblox」）。比例：scale = 场景单位的米数 / 每 stud 的米数
// （用户要的是 5 stud = 1.7 m，即 0.34 m/stud；SpaceCenter 的工程单位是 0.28 m，所以乘 0.8235）。
//
// 层级：根 Model → 角色（Structure / Terrain / Decor / Decal / Collision）→ 子关卡（源部件名的第二段，例如 BigMeshGroup_50_-34、
// RoomBuilder_SpaceCenterH1）→ 物体（顶层语句；多块的是 Model，单块的直接是 Part）→ 组、阵列成员（Model）→ 零件。类型体那一层（body）并到上一层。
// 语义：物体上写属性 Role / Source / Concepts / Collidable / Fit，概念另外打成 CollectionService 标签（S3D_概念名）。
// 碰撞块：Transparency 1、CanCollide；旁路表标了 ~collidable=0 的（只看得见、撞不到）CanCollide false。
//
// 几何的换算（局部坐标系是编译结果的 world：R 行主序、列是局部轴，t 是原点）：
//   box、beam、steps 的踏步 → Block；wedge → WedgePart（Roblox 的楔形高边在 +Z、轴向是 X，所以 X=−ez、Y=ey、Z=ex，尺寸 d,h,w）；
//   cyl → Cylinder（Roblox 的圆柱沿 X）；圆台、旋转体按高度切成几段圆柱；sphere → Ball；
//   sweep、pipe → 每段一块（圆截面是圆柱，其余是截面包围框的盒子）；
//   plate → 矩形的直接是 Block，其余切成三角形，每个三角形（带厚度）是两块 WedgePart；hull → 每个面一个朝里加厚的三角形（两块 WedgePart）；
//   不用 Union / 挖洞的 CSG（会影响碰撞）：subtract 在这里就拆成实心的零件——盒子挖盒子：在主体的坐标系里按所有盒子的边切成格子，
//   去掉洞里的格子，剩下的合并成尽量大的盒子（外壳“外盒 − 空腔 − 门洞”同样拆成带门洞的墙板）；平板挖平板：带洞的多边形三角化（earcut）；
//   union 直接把各成员的零件放在一起；其余的（intersect、别的组合）只留第一个成员并记数。
import * as THREE from 'three';
import { triangulate2 } from '../src/s3d.js';
import { nodeRoles } from '../src/roles-view.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scl(a, 1 / (len(a) || 1));
const mv = (R, v) => [0, 1, 2].map((i) => R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]);

export const SHAPES = { Block: 0, Wedge: 1, Cylinder: 2, Ball: 3 };
export const ROLE_FOLDERS = { structure: 'Structure', terrain: 'Terrain', decor: 'Decor', decal: 'Decal', collision: 'Collision', helper: 'Helper' };
// 白模没有颜色：按角色上色、选材质（结构混凝土、地形沥青、装饰塑料、贴花浅色漆）；源模型有自己颜色的照用
export const ROLE_LOOK = {
  structure: { color: '#c8c8c8', material: 'Concrete' }, terrain: { color: '#7a7a74', material: 'Asphalt' }, decor: { color: '#9fb0c3', material: 'SmoothPlastic' },
  decal: { color: '#e6e0c6', material: 'SmoothPlastic' }, collision: { color: '#ff4040', material: 'ForceField' }, helper: { color: '#ffffff', material: 'SmoothPlastic' },
};
// 白模的颜色：浅灰（三个通道相差不到 12、都在 180 以上）当作没有颜色，按角色上色
const whitebox = (c) => { const m = /^#([0-9a-f]{6})$/i.exec(c); if (!m) return true; const v = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)); return Math.min(...v) >= 180 && Math.max(...v) - Math.min(...v) <= 12; };

// 一块零件：{ shape, size:[x,y,z], pos:[x,y,z], cols:[X,Y,Z]（世界里的三个轴）}
const part = (shape, size, pos, cols) => ({ shape, size, pos, cols });
// 局部坐标系（frame：R 行主序、t）里的一块 → 世界
const toWorld = (W, p) => ({ ...p, pos: add(mv(W.R, p.pos), W.t), cols: p.cols.map((c) => mv(W.R, c)) });

// 楔形（SVG3D：xy 平面里的直角三角形 (−w/2,0)(w/2,0)(w/2,h)，沿 z 拉伸 d；原点在底面中心）→ WedgePart，局部轴 ex,ey,ez、原点 o
function wedgeOf(o, ex, ey, ez, w, h, d) {
  return part(SHAPES.Wedge, [d, h, w], add(o, scl(ey, h / 2)), [scl(ez, -1), ey, ex]);
}
// 一个带厚度的三角形（三维顶点 a,b,c；厚度方向 n（单位向量）上从 off 到 off+th）→ 两块 WedgePart：
// 从最长边对面的顶点作高，分成两个直角三角形，每个是一块楔形（直角在垂足）
export function triPrism(a, b, c, n, off, th) {
  const V = [a, b, c], L = [len(sub(b, c)), len(sub(c, a)), len(sub(a, b))];
  const k = L.indexOf(Math.max(...L)), T = V[k], A = V[(k + 1) % 3], B = V[(k + 2) % 3];
  const AB = sub(B, A), t = dot(sub(T, A), AB) / dot(AB, AB), F = add(A, scl(AB, t));
  const hh = len(sub(T, F));
  if (!(hh > 1e-6)) return [];
  const out = [];
  for (const E of [A, B]) {
    const w = len(sub(F, E));
    if (!(w > 1e-6)) continue;
    const ex = unit(sub(F, E)), ey = unit(sub(T, F)), ez = cross(ex, ey);
    // 楔形原点：底边中点，拉伸方向居中——厚度方向就是 ±n
    const o = add(scl(add(E, F), 0.5), scl(n, off + th / 2));
    out.push(wedgeOf(o, ex, ey, ez, w, hh, th));
  }
  return out;
}

const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
// 圆柱（局部 y 轴、底在 y0、顶在 y1、半径 r）
const cylY = (r, y0, y1, c = [0, 0]) => part(SHAPES.Cylinder, [y1 - y0, 2 * r, 2 * r], [c[0], (y0 + y1) / 2, c[1]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]]);

// 一个几何条目（局部坐标）→ 局部坐标里的零件
// small：最大边不到这么长（场景单位）的凸包写成包围框的一块 Block（小道具不值得用几十块楔形拼外壳）
export function localParts(g, { small = 0 } = {}) {
  switch (g.type) {
    case 'box': return [part(SHAPES.Block, [g.w, g.h, g.d], [0, g.h / 2, 0], I3)];
    case 'mesh': return [part(SHAPES.Block, [g.w, g.h, g.d], [0, g.h / 2, 0], I3)];
    case 'beam': return [part(SHAPES.Block, [g.L, g.t, g.w], [0, g.dy, 0], I3)];
    case 'rod': return [part(SHAPES.Cylinder, [g.L, 2 * g.r, 2 * g.r], [0, 0, 0], I3)];
    case 'sphere': return [part(SHAPES.Ball, [2 * g.r, 2 * g.r, 2 * g.r], [0, g.r, 0], I3)];
    case 'wedge': return [wedgeOf([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], g.w, g.h, g.d)];
    case 'steps': return g.treads.map((t) => part(SHAPES.Block, t.s, t.c, I3));
    case 'cyl': {
      // 圆台：按半径变化切成几段（每段取中间的半径）
      const R = Math.max(g.r1, g.r2), n = Math.abs(g.r1 - g.r2) > 0.15 * R ? 4 : 1, out = [];
      for (let i = 0; i < n; i++) {
        const y0 = (g.h * i) / n, y1 = (g.h * (i + 1)) / n, r = g.r1 + ((g.r2 - g.r1) * (i + 0.5)) / n;
        if (r > 1e-4) out.push(cylY(r, y0, y1));
      }
      // 沿 x / z 的圆柱：先按 y 轴做，再转过去（geometry.js 的放法：轴居中、底面贴着 y=0，轴高 R）
      if (g.axis === 'x') return out.map((p) => ({ ...p, pos: [p.pos[1] - g.h / 2, R, 0], cols: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] }));
      if (g.axis === 'z') return out.map((p) => ({ ...p, pos: [0, R, p.pos[1] - g.h / 2], cols: [[0, 0, 1], [0, 1, 0], [-1, 0, 0]] }));
      return out;
    }
    case 'revolve': {
      // 旋转体：轮廓每一段一个圆柱（半径变化大的段再切开）；水平的段（端面）不用单独写
      const out = [], P = g.prof;
      for (let k = 1; k < P.length; k++) {
        const [r0, y0] = P[k - 1], [r1, y1] = P[k];
        if (Math.abs(y1 - y0) < 1e-4) continue;
        const lo = Math.min(y0, y1), hi = Math.max(y0, y1), rLo = y0 < y1 ? r0 : r1, rHi = y0 < y1 ? r1 : r0;
        const n = Math.abs(r1 - r0) > 0.25 * Math.max(r0, r1, 1e-6) ? 3 : 1;
        for (let i = 0; i < n; i++) { const r = rLo + ((rHi - rLo) * (i + 0.5)) / n; if (r > 1e-4) out.push(cylY(r, lo + ((hi - lo) * i) / n, lo + ((hi - lo) * (i + 1)) / n)); }
      }
      return out;
    }
    case 'sweep': {
      // 每段（相邻两个截面之间）一块：圆截面是圆柱，其余是截面包围框的盒子
      const F = g.frames, segs = g.closed ? F.length : F.length - 1, out = [];
      const us = g.prof.map((p) => p[0]), vs = g.prof.map((p) => p[1]);
      const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
      const round = g.smooth && g.prof.length >= 12;
      for (let i = 0; i < segs; i++) {
        const f0 = F[i], f1 = F[(i + 1) % F.length], d = sub(f1.p, f0.p), L = len(d);
        if (!(L > 1e-6)) continue;
        const X = unit(d);
        let up = sub(f0.up, scl(X, dot(f0.up, X)));
        if (len(up) < 1e-6) up = Math.abs(X[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        const Y = unit(up), Z = cross(X, Y), side = unit(cross(Y, X));
        // 截面的中心：side·(u0+u1)/2 + up·(v0+v1)/2（side 与 f0.side 同向）
        const sgn = dot(side, f0.side) >= 0 ? 1 : -1;
        const mid = add(scl(add(f0.p, f1.p), 0.5), add(scl(side, (sgn * (u0 + u1)) / 2), scl(Y, (v0 + v1) / 2)));
        if (round) out.push(part(SHAPES.Cylinder, [L, v1 - v0, u1 - u0], mid, [X, Y, Z]));
        else out.push(part(SHAPES.Block, [L, v1 - v0, u1 - u0], mid, [X, Y, Z]));
      }
      return out;
    }
    case 'plate': {
      const P = g.pts, h = g.h;
      // 矩形：一块 Block
      if (P.length === 4) {
        const e = [0, 1, 2, 3].map((i) => [P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]]);
        const perp = [0, 1, 2, 3].every((i) => Math.abs(e[i][0] * e[(i + 1) % 4][0] + e[i][1] * e[(i + 1) % 4][1]) < 1e-6 * (1 + Math.hypot(...e[i]) * Math.hypot(...e[(i + 1) % 4])));
        if (perp) {
          const a = Math.hypot(...e[0]), b = Math.hypot(...e[1]), ux = [e[0][0] / a, 0, e[0][1] / a], uz = [e[1][0] / b, 0, e[1][1] / b];
          const c = [(P[0][0] + P[2][0]) / 2, h / 2, (P[0][1] + P[2][1]) / 2];
          // 右手：x × y = z
          const z = dot(cross(ux, [0, 1, 0]), uz) > 0 ? uz : scl(uz, -1);
          return [part(SHAPES.Block, [a, h, b], c, [ux, [0, 1, 0], z])];
        }
      }
      return triangulate2(P).flatMap(([i, j, k]) => triPrism([P[i][0], 0, P[i][1]], [P[j][0], 0, P[j][1]], [P[k][0], 0, P[k][1]], [0, 1, 0], 0, h));
    }
    case 'hull': {
      // 每个面一个朝里加厚的三角形：厚度取包围框最小边的 1/8（0.4–3）
      const lo = [0, 1, 2].map((k) => Math.min(...g.pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...g.pts.map((p) => p[k])));
      if (Math.max(...sub(hi, lo)) < small) return [part(SHAPES.Block, sub(hi, lo), scl(add(lo, hi), 0.5), I3)];
      const th = Math.max(0.4, Math.min(3, Math.min(...sub(hi, lo)) / 8));
      return g.faces.flatMap(([i, j, k]) => {
        const a = g.pts[i], b = g.pts[j], c = g.pts[k], n = unit(cross(sub(b, a), sub(c, a)));
        return triPrism(a, b, c, n, -th, th);
      });
    }
  }
  return [];
}

const mvT = (R, v) => [0, 1, 2].map((j) => R[0][j] * v[0] + R[1][j] * v[1] + R[2][j] * v[2]);
// 世界坐标 → 某个局部坐标系
const toLocal = (W, p) => mvT(W.R, sub(p, W.t));
// 一个盒子条目在另一个坐标系 B 里的包围框（两者同向时就是它本身）
function boxIn(B, it) {
  const g = it.geom, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 8; k++) {
    const p = [k & 1 ? g.w / 2 : -g.w / 2, k & 2 ? g.h : 0, k & 4 ? g.d / 2 : -g.d / 2], q = toLocal(B, add(mv(it.world.R, p), it.world.t));
    for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], q[j]); hi[j] = Math.max(hi[j], q[j]); }
  }
  return { lo, hi };
}
// 盒子挖盒子 → 主体坐标系里的一组盒子（局部坐标）
export function boxMinusBoxes(base, holes) {
  const g = base.geom, B0 = { lo: [-g.w / 2, 0, -g.d / 2], hi: [g.w / 2, g.h, g.d / 2] };
  const H = holes.map((h) => boxIn(base.world, h));
  const cuts = [0, 1, 2].map((k) => [...new Set([B0.lo[k], B0.hi[k], ...H.flatMap((b) => [b.lo[k], b.hi[k]]).filter((v) => v > B0.lo[k] && v < B0.hi[k])].map((v) => Math.round(v * 1e6) / 1e6))].sort((a, b) => a - b));
  const [nx, ny, nz] = cuts.map((c) => c.length - 1), id = (i, j, k) => (k * ny + j) * nx + i;
  const solid = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = [(cuts[0][i] + cuts[0][i + 1]) / 2, (cuts[1][j] + cuts[1][j + 1]) / 2, (cuts[2][k] + cuts[2][k + 1]) / 2];
    solid[id(i, j, k)] = H.some((b) => [0, 1, 2].every((a) => c[a] > b.lo[a] && c[a] < b.hi[a])) ? 0 : 1;
  }
  // 贪心合并：沿 x 伸到头，再沿 z、再沿 y
  const out = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!solid[id(i, j, k)]) continue;
    let i1 = i; while (i1 + 1 < nx && solid[id(i1 + 1, j, k)]) i1++;
    const rowOK = (jj, kk) => { for (let x = i; x <= i1; x++) if (!solid[id(x, jj, kk)]) return false; return true; };
    let k1 = k; while (k1 + 1 < nz && rowOK(j, k1 + 1)) k1++;
    const slabOK = (jj) => { for (let z = k; z <= k1; z++) if (!rowOK(jj, z)) return false; return true; };
    let j1 = j; while (j1 + 1 < ny && slabOK(j1 + 1)) j1++;
    for (let z = k; z <= k1; z++) for (let y = j; y <= j1; y++) for (let x = i; x <= i1; x++) solid[id(x, y, z)] = 0;
    const lo = [cuts[0][i], cuts[1][j], cuts[2][k]], hi = [cuts[0][i1 + 1], cuts[1][j1 + 1], cuts[2][k1 + 1]];
    out.push(part(SHAPES.Block, sub(hi, lo), scl(add(lo, hi), 0.5), I3));
  }
  return out;
}
// 平板挖平板 → 主体坐标系里的一组楔形（带洞的多边形三角化）
export function plateMinusPlates(base, holes) {
  const g = base.geom, V = (p) => new THREE.Vector2(p[0], p[1]);
  const contour = g.pts.map(V);
  const hs = holes.map((h) => h.geom.pts.map(([x, z]) => { const q = toLocal(base.world, add(mv(h.world.R, [x, 0, z]), h.world.t)); return new THREE.Vector2(q[0], q[2]); }));
  const all = [...contour, ...hs.flat()];
  return THREE.ShapeUtils.triangulateShape(contour, hs).flatMap(([a, b, c]) => triPrism([all[a].x, 0, all[a].y], [all[b].x, 0, all[b].y], [all[c].x, 0, all[c].y], [0, 1, 0], 0, g.h));
}
// 一个 CSG 条目 → 世界里的零件（不用 CSG）；拆不了的只留第一个成员，approx 记一笔
export function csgParts(it, partsOfItem) {
  const flat = (x) => (x.kind === 'csg' ? csgParts(x, partsOfItem).parts : partsOfItem(x));
  const [first, ...rest] = it.children;
  if (it.op === 'union') return { parts: it.children.flatMap(flat), approx: false };
  if (it.op === 'subtract' && first.kind === 'solid' && rest.every((h) => h.kind === 'solid')) {
    if (first.geom.type === 'box' && rest.every((h) => h.geom.type === 'box')) return { parts: boxMinusBoxes(first, rest).map((p) => toWorld(first.world, p)), approx: false };
    if (first.geom.type === 'plate' && rest.every((h) => h.geom.type === 'plate')) return { parts: plateMinusPlates(first, rest).map((p) => toWorld(first.world, p)), approx: false };
  }
  return { parts: flat(first), approx: true };
}

// 编译结果 → 分块的数据。返回 { index, chunks: [{ paths, parts, attrs, csg }] }
//   paths：本块用到的父节点路径（"Structure/BigMeshGroup_50_-34/Obj/0"），零件用下标引用；
//   parts：[父路径下标, 形状, sx,sy,sz, x,y,z, 9 个旋转（行主序）, 颜色下标, 材质下标, 透明, 碰撞, 名字]；
//   attrs：[路径, { 属性 }, [标签]]。scale：坐标与尺寸乘的比例
// ground：把地面（地形零件中心高度的中位数）放到 Roblox 的这个高度（默认 1：Studio 默认的基板顶面在 0，地面略高于它，不打架）；null 不平移
export function robloxPlan(result, { root = 'SpaceCenter', chunkParts = 4000, digits = 3, scale = 1, smallHull = 0, ground = 1 } = {}) {
  const roleOf = nodeRoles(result), nodes = new Map(result.nodes.map((n) => [n.path, n]));
  const topOf = (p) => p.split('.')[0];
  // 每个顶层物体：来源（自己或子孙的 ~src）、子关卡
  const srcOfTop = new Map();
  for (const n of result.nodes) { const t = topOf(n.path); if (!srcOfTop.has(t) && n.meta?.src) srcOfTop.set(t, String(n.meta.src)); }
  const levelOf = (t) => { const s = srcOfTop.get(t); const seg = s ? s.split('/') : []; return (seg.length >= 3 ? seg[1] : seg[0]) || 'Misc'; };
  // 顶层物体的零件数（决定单块的物体直接写成 Part）
  const conv = [];
  let approxCsg = 0;
  const colors = [], colorIx = new Map(), mats = [], matIx = new Map();
  const ix = (arr, map, v) => { if (!map.has(v)) { map.set(v, arr.length); arr.push(v); } return map.get(v); };
  const round = (x, d = digits) => { const v = Math.round(x * 10 ** d) / 10 ** d; return Object.is(v, -0) ? 0 : v; };
  const lookOf = (path, mat) => {
    const role = roleOf(path), L = ROLE_LOOK[role] ?? ROLE_LOOK.structure;
    const c = String(mat?.color ?? '').toLowerCase();
    return { role, color: c && !whitebox(c) ? c : L.color, material: L.material };
  };
  // 小凸包的门槛：2 m（结构不会有凸包，见 reverse.mjs 的 hullWorth）
  const partsOfItem = (it) => (it.geom ? localParts(it.geom, { small: smallHull }).map((p) => toWorld(it.world, p)) : []);
  for (const it of result.items) {
    if (it.kind === 'solid') { if (it.geom?.type !== 'mesh') conv.push({ path: it.path, parts: partsOfItem(it), mat: it.material }); }
    else if (it.kind === 'csg') {
      const r = csgParts(it, partsOfItem);
      if (r.approx) approxCsg++;
      conv.push({ path: it.path, mat: it.material, parts: r.parts, csg: true });
    }
  }
  // 竖直平移：地形零件中心高度的中位数 → ground
  let dy = 0;
  if (ground != null) {
    const ys = conv.filter((c) => roleOf(c.path) === 'terrain').flatMap((c) => c.parts.map((p) => p.pos[1])).sort((a, b) => a - b);
    if (ys.length) dy = ground / scale - ys[ys.length >> 1];
  }
  // 顶层物体的角色与子关卡：阵列、组本身常常不带 ~role / ~src（写在成员上）——角色按物体里零件的多数，
  // 子关卡没有来源的取空间上最近、有来源的物体的子关卡
  const roleVotes = new Map(), centerOf = new Map();
  for (const c of conv) {
    const t = topOf(c.path), r = roleOf(c.path);
    if (!roleVotes.has(t)) roleVotes.set(t, {});
    roleVotes.get(t)[r] = (roleVotes.get(t)[r] ?? 0) + c.parts.length;
    const C = centerOf.get(t) ?? [0, 0, 0, 0];
    for (const p of c.parts) { C[0] += p.pos[0]; C[1] += p.pos[1]; C[2] += p.pos[2]; C[3]++; }
    centerOf.set(t, C);
  }
  const roleTop = new Map([...roleVotes].map(([t, v]) => [t, Object.entries(v).sort((a, b) => b[1] - a[1])[0][0]]));
  const withSrc = [...centerOf].filter(([t, C]) => srcOfTop.has(t) && C[3]).map(([t, C]) => [t, C[0] / C[3], C[2] / C[3]]);
  const levelTop = new Map();
  for (const [t, C] of centerOf) {
    if (srcOfTop.has(t) || !C[3] || !withSrc.length) { levelTop.set(t, levelOf(t)); continue; }
    const x = C[0] / C[3], z = C[2] / C[3];
    let best = null, bd = Infinity;
    for (const [u, ux, uz] of withSrc) { const d = (ux - x) ** 2 + (uz - z) ** 2; if (d < bd) { bd = d; best = u; } }
    levelTop.set(t, levelOf(best));
  }
  const countTop = new Map();
  for (const c of conv) countTop.set(topOf(c.path), (countTop.get(topOf(c.path)) ?? 0) + c.parts.length);
  // 实例路径：根下按角色、子关卡；物体内部按路径的段（类型体 body 并到上一层）。单块的物体：零件就是物体本身
  const instPath = (path) => {
    const t = topOf(path), role = roleOf(path), base = `${ROLE_FOLDERS[roleTop.get(t) ?? roleOf(t)] ?? 'Structure'}/${levelTop.get(t) ?? levelOf(t)}`;
    const segs = path.split('.').filter((s, i) => i === 0 || s !== 'body');
    return { base, segs, single: countTop.get(t) === 1, role };
  };
  const chunks = [];
  let cur = null;
  const newChunk = () => { cur = { paths: [], pathIx: new Map(), parts: [], attrs: [] }; chunks.push(cur); };
  const pIx = (p) => ix(cur.paths, cur.pathIx, p);
  const enc = (p, look, name, extra) => {
    const R = [0, 1, 2].map((i) => p.cols.map((c) => c[i])); // 行主序：R[i][j] = 第 j 个轴的第 i 个分量
    return [...p.size.map((v) => round(Math.max(v * scale, 0.05))), ...p.pos.map((v, k) => round((k === 1 ? v + dy : v) * scale)), ...R.flat().map((v) => round(v, 5)), ix(colors, colorIx, look.color), ix(mats, matIx, look.material), extra.transp, extra.collide, name];
  };
  const extraOf = (look, path) => {
    const col = metaUp(path, 'collidable');
    if (look.role === 'collision') return { transp: 1, collide: 1 };
    return { transp: 0, collide: col != null && +col === 0 ? 0 : look.role === 'decal' ? 0 : 1 };
  };
  const metaUp = (path, k) => { for (let p = path; p; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') { const v = nodes.get(p)?.meta?.[k]; if (v != null) return v; } return null; };
  let lastTop = null, n = 0, total = 0, csgN = 0;
  const seenTop = new Set();
  for (const c of conv) {
    const t = topOf(c.path);
    if (!cur || (t !== lastTop && n >= chunkParts)) { newChunk(); n = 0; }
    lastTop = t;
    const ip = instPath(c.path), look = lookOf(c.path, c.mat), extra = extraOf(look, c.path);
    // 父路径：单块的物体挂在子关卡下面；否则挂在去掉最后一段的路径下面（物体本身是 Model）
    const parentSegs = ip.single ? [] : ip.segs.slice(0, -1);
    const parent = [ip.base, ...parentSegs].join('/');
    const leaf = ip.single ? ip.segs[0] : ip.segs[ip.segs.length - 1];
    {
      // 一个条目拆成好几块（平板、凸包、旋转体、挖了洞的板）：多块时套一个 Model，里面按序号
      if (c.csg) csgN++;
      if (c.parts.length === 1) for (const p of c.parts) cur.parts.push([pIx(parent), p.shape, ...enc(p, look, leaf, extra)]);
      else { const pp = pIx([parent, leaf].join('/')); c.parts.forEach((p, i) => cur.parts.push([pp, p.shape, ...enc(p, look, `${leaf}_${i + 1}`, extra)])); }
      n += c.parts.length; total += c.parts.length;
    }
    // 物体的语义：顶层第一次出现时写属性与标签（单块的写在零件上，多块的写在物体的 Model 上）
    if (!seenTop.has(t)) {
      seenTop.add(t);
      const node = nodes.get(t), concepts = [...new Set((node?.concepts ?? []).map((x) => (typeof x === 'string' ? x : x.name ?? String(x))))];
      const attrs = { Role: roleTop.get(t) ?? roleOf(t), Source: srcOfTop.get(t) ?? '', Concepts: concepts.join(','), Fit: node?.meta?.fit != null ? +node.meta.fit : null, Collidable: metaUp(t, 'collidable') != null ? +metaUp(t, 'collidable') : null, Kind: node?.kind ?? '' };
      cur.attrs.push([[ip.base, t].join('/'), Object.fromEntries(Object.entries(attrs).filter(([, v]) => v != null && v !== '')), concepts.map((x) => `S3D_${x}`)]);
    }
  }
  const counts = {};
  for (const c of conv) { const r = roleOf(c.path); counts[r] = (counts[r] ?? 0) + c.parts.length; }
  const index = { root, scale, dy: round(dy * scale), chunks: chunks.length, parts: total, csgDecomposed: csgN, csgApprox: approxCsg, objects: seenTop.size, colors, materials: mats, shapes: Object.keys(SHAPES), counts, folders: Object.values(ROLE_FOLDERS) };
  return { index, chunks: chunks.map(({ pathIx, ...c }) => c) };
}
