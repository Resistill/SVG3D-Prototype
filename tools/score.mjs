// 自评分数：不依赖真值，是 AI 的目标函数，也是人的进度条（docs/PLAN2.md 第 3 节）。
//   S = L_stmt + L_mesh + R_src + R_recon，越低越好
//   L_stmt  描述长度：名字、关键字、引用各 1；数字 1 + 0.5 × (小数位 − 1)；注释与 ~元数据不计
//   L_mesh  仍以源网格引用保留的部分：c_mesh × log2(1 + 三角形数)
//   长度都按米计（δ、dMax、输出的误差），场景单位不是米时按 unit 换算
//   R_src   源模型的每个部件表面采样，到重建表面的距离 d → log2(1 + max(0, d − δ)/δ)，按 log2(1 + 面积/δ²) 加权
//           （这块表面在当前精度下有多少个 δ 见方的格子：精度要求越细、表面越大，同样的误差越贵——评分标准随档位变化）。
//           δ 由档位决定；误差在 δ 以内不计代价（逆向只要求保留语义，不奖励“猜中作者的精确数值”）。
//           距离优先量到**同材质**的重建表面：沥青路面只能由沥青的物体解释，不能拿底下的地面凑数；
//           没有同材质的表面时量到全部表面，并多计一个 δ
//   有效描述：基础层里声明的物体被删掉了，那一行不计长度（替换一个物体不应付两份钱）
//   R_recon 重建物体表面到源表面的距离，同样计价；复杂度权重以顶层语句为单位、内部按面积分摊（惩罚凭空多出来的东西，但不惩罚拆分）
// 解释率 explain = 1 − S / S_mesh，S_mesh 是“全部写成 mesh 引用、世界坐标定位”的基线。
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { samplePoints } from './reverse.mjs';
import { sceneObjects, trisToArray } from './worldtris.mjs';

// 长度常数（delta、dMax）按米给出，unit 是每个场景单位多少米；计算前换算成场景单位（inScene），输出的误差（meanErr、maxErr）再换回米。
// 换算之后分数与单位无关：残差是 d/δ，面积权重是 面积/δ²，都是无量纲的
export const SCORE_DEFAULTS = { delta: 0.005, cRes: 4, cMesh: 10, dMax: 2, samples: 600, unit: 1 };
const inScene = (k) => ({ ...k, delta: k.delta / k.unit, dMax: k.dMax / k.unit });

// 不计入描述长度的语句：语义层与风格层（它们不描述几何）
const SEMANTIC = /^\s*(concept|pattern|check|style|variant|import)\b/;
const TOKEN = /"[^"]*"|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|[\p{L}_][\p{L}\p{N}_]*/gu;

export function numberCost(tok) {
  const m = /\.(\d+)/.exec(tok);
  const d = m ? m[1].replace(/0+$/, '').length : 0;
  return 1 + 0.5 * Math.max(0, d - 1);
}

// 一行语句的长度（去掉注释与 ~元数据）
export function lineCost(line) {
  let s = line.replace(/\s~[\p{L}_][\p{L}\p{N}_]*=("[^"]*"|\S+)/gu, '');
  const q = s.indexOf('//');
  if (q >= 0 && (s.slice(0, q).match(/"/g) ?? []).length % 2 === 0) s = s.slice(0, q);
  if (!s.trim() || SEMANTIC.test(s)) return 0;
  let c = 0;
  for (const m of s.matchAll(TOKEN)) c += /^-?\d/.test(m[0]) ? numberCost(m[0]) : 1;
  return c;
}

// 一段描述（已展开 import 的若干文件）的长度；逐行，便于按物体归因
export function descriptionLength(files) {
  let total = 0;
  const lines = [];
  for (const { file, text } of files) text.split('\n').forEach((l, i) => { const c = lineCost(l); if (c) { total += c; lines.push({ file, line: i + 1, cost: c }); } });
  return { total, lines };
}

const areaOf = (tris) => tris.reduce((s2, t) => s2 + len3(cross3(sub3(t[1], t[0]), sub3(t[2], t[0]))) / 2, 0);
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const toGeom = (pos) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); return g; };
const triList = (pos) => { const out = []; for (let i = 0; i < pos.length; i += 9) out.push([[pos[i], pos[i + 1], pos[i + 2]], [pos[i + 3], pos[i + 4], pos[i + 5]], [pos[i + 6], pos[i + 7], pos[i + 8]]]); return out; };

// 把若干物体合成一棵 BVH，记住每个三角形属于哪个物体
function bvhOf(objs, ids = objs.map((_, k) => k)) {
  const n = objs.reduce((s, o) => s + o.pos.length, 0);
  const pos = new Float32Array(n), owner = new Int32Array(n / 9);
  let off = 0;
  objs.forEach((o, k) => { pos.set(o.pos, off); owner.fill(ids[k], off / 9, (off + o.pos.length) / 9); off += o.pos.length; });
  if (!n) return null;
  const geom = toGeom(pos);
  const bvh = new MeshBVH(geom);
  // MeshBVH 建树时会重排索引：faceIndex 是重排后的编号，要经过索引换回原来的三角形
  const index = geom.index.array;
  return { bvh, owner, triOf: (fi) => Math.floor(index[3 * fi] / 3) };
}

// 按材质颜色分组的表面集合：{ byColor: Map(颜色 → BVH), all: BVH }
const colorKey = (c) => String(c ?? '').toLowerCase();
// 重建物体的采样种子取自路径（不取序号）：语句挪了位置、换了文件，分数不变
const seedOf = (s) => { let h = 2166136261; for (let j = 0; j < s.length; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619); return 1000 + ((h >>> 0) % 1000003); };
function surfaces(objs) {
  const groups = new Map();
  objs.forEach((o, k) => { const c = colorKey(o.color); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(k); });
  const byColor = new Map([...groups].map(([c, ids]) => [c, bvhOf(ids.map((k) => objs[k]), ids)]));
  return { byColor, all: bvhOf(objs) };
}

// 到一组表面的最近距离：nearest(target, k)(color) 给出 p → [d, 最近的物体]（没有目标、或 dMax 以内没有表面：[dMax, −1]）。
// 距离优先量到同材质的表面；没有同材质的表面时量到全部表面，并多计一个 δ
function nearest(target, k) {
  const v = new THREE.Vector3(), hit = {};
  return (color = null) => {
    const same = target && color != null ? target.byColor.get(colorKey(color)) : null;
    const bvh = same ?? target?.all ?? null;
    const penalty = target && color != null && !same ? k.delta : 0;
    return (p) => {
      if (!bvh) return [k.dMax, -1];
      const res = bvh.bvh.closestPointToPoint(v.set(p[0], p[1], p[2]), hit, 0, k.dMax);
      return res ? [Math.min(res.distance + penalty, k.dMax), bvh.owner[bvh.triOf(res.faceIndex)]] : [k.dMax, -1];
    };
  };
}
// 逐点距离 → { r（平均代价）, mean, max }；按点的顺序累加（增量评分与全量评分逐位一致）
function aggregate(d, k) {
  let rs = 0, sum = 0, mx = 0;
  for (let i = 0; i < d.length; i++) { rs += Math.log2(1 + Math.max(0, d[i] - k.delta) / k.delta); sum += d[i]; mx = Math.max(mx, d[i]); }
  const n = d.length || 1;
  return { r: rs / n, mean: sum / n, max: mx };
}
// 点集到一组表面的距离；返回 { r, mean, max, owners（每个点最近的物体） }
function residual(points, target, k, color = null) {
  const f = nearest(target, k)(color);
  const d = new Float64Array(points.length), owners = new Array(points.length);
  points.forEach((p, i) => { [d[i], owners[i]] = f(p); });
  return { ...aggregate(d, k), owners };
}
// 一个源部件的逐点结果 → 代价与归属。权重 = 这块表面在当前精度下有多少个 δ 见方的格子（取对数）：
// 表面越大、精度要求越细，同样的误差越贵；归到最近点最多落在其上的那个重建物体（who、owners 是物体编号）
function partResult(s, d, own, k) {
  const res = aggregate(d, k);
  const votes = new Map();
  for (const o of own) if (o >= 0) votes.set(o, (votes.get(o) ?? 0) + 1);
  const top = [...votes].sort((a, b) => b[1] - a[1])[0];
  return { c: k.cRes * Math.log2(1 + s.area / (k.delta * k.delta)) * res.r, mean: res.mean, max: res.max, who: top ? top[0] : -1, owners: [...votes.keys()], d, own };
}
// 点到包围盒的距离
const boxDist = (p, b) => Math.hypot(...[0, 1, 2].map((j) => Math.max(b.lo[j] - p[j], 0, p[j] - b.hi[j])));

// 增量评分的缓存：同一组源部件上反复评分（细化、预览提议）时，只重算变了的部分，结果与全量评分一致。
//   源侧固定的东西（三角形数组、BVH、面积、包围盒、基线）只算一次；
//   R_recon 每个重建物体的残差只取决于它自己的几何（源固定），按“路径 + 颜色 + 几何哈希”缓存；
//   R_src 每个源部件逐点记下距离与最近的物体。与上一次评分相比：删掉的物体只影响以它为最近表面的点；
//   新增的物体只会让距离变小，只影响比现在的距离离它更近的点（同材质的目标存在时只看同材质的新增物体）；
//   某种颜色的重建物体整组出现或消失时，这种颜色的源部件全部重算（同材质优先的目标变了）；改动太多时全部重算。
// 常数不同（细化时用目标档位的 δ）各自一份状态
export function scoreCache() { return { parts: null, shared: null, states: new Map() }; }

const hashPos = (pos) => {
  const u32 = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
  let h = 2166136261;
  for (let i = 0; i < u32.length; i++) h = Math.imul(h ^ u32[i], 16777619);
  return (h >>> 0).toString(36) + ':' + pos.length;
};
const boxOfPos = (pos) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let j = 0; j < 3; j++) { const x = pos[i + j]; if (x < lo[j]) lo[j] = x; if (x > hi[j]) hi[j] = x; }
  return { lo, hi };
};
const boxesMeet = (a, b, pad) => [0, 1, 2].every((j) => a.lo[j] - pad <= b.hi[j] && b.lo[j] <= a.hi[j] + pad);

// 源侧：只取决于源部件，与常数无关
function sharedOf(sourceParts, cache) {
  if (cache?.parts === sourceParts && cache.shared) return cache.shared;
  const src = sourceParts.map((p, i) => {
    // 包围盒按原始坐标取（基线里的数字要和全量评分一模一样）
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of p.tris) for (const v of t) for (let j = 0; j < 3; j++) { if (v[j] < lo[j]) lo[j] = v[j]; if (v[j] > hi[j]) hi[j] = v[j]; }
    return { i, name: p.uid ?? p.name ?? p.from ?? `part_${i}`, tris: p.tris, pos: trisToArray(p.tris), color: p.material?.color, area: areaOf(p.tris), box: { lo, hi } };
  });
  const shared = { src, srcBVH: surfaces(src) };
  if (cache) { cache.parts = sourceParts; cache.shared = shared; cache.states.clear(); }
  return shared;
}

// result：compile() 的结果；files：描述文本（[{file, text}]，已包括 import 的文件）；sourceParts：readParts() 的源部件；
// cache：scoreCache()，可选（给了就增量评分）
export function score({ result, files, sourceParts, consts = {}, cache = null }) {
  const k0 = { ...SCORE_DEFAULTS, ...consts }, k = inScene(k0), u = k0.unit;
  // 计时：S3D_TIMING=1 时把各阶段耗时打到 stderr
  const T0 = performance.now(), lap = (what) => process.env.S3D_TIMING && console.error(`[score] ${what} ${Math.round(performance.now() - T0)}ms`);
  const recon = sceneObjects(result, { sourceParts }).filter((o) => o.pos.length);
  const { src, srcBVH } = sharedOf(sourceParts, cache);
  const ckey = JSON.stringify([k.delta, k.dMax, k.samples, k.cRes]);
  const state = cache ? (cache.states.get(ckey) ?? cache.states.set(ckey, { recon: new Map(), prev: null, srcRes: null }).get(ckey)) : null;
  lap('sceneObjects');
  const D0 = descriptionLength(files);
  // 有效描述：声明物体的行，物体还在才计
  const declared = new Set(result.nodes.map((n) => `${n.file ?? ''}:${n.line}`));
  const NOT_DECL = /^\s*(material|let|def|over|drop|copy|import|concept|pattern|check|style|variant|\})\b/;
  const fileText = new Map(files.map((f) => [f.file ?? '', f.text.split('\n')]));
  const keep = (x) => { const t = fileText.get(x.file ?? '')?.[x.line - 1] ?? ''; return NOT_DECL.test(t) || !/^\s*[\p{L}_][\p{L}\p{N}_]*\s+[\p{L}_]/u.test(t) || declared.has(`${x.file ?? ''}:${x.line}`); };
  const lines = D0.lines.filter(keep);
  const D = { total: lines.reduce((s, x) => s + x.cost, 0), lines, dropped: D0.lines.length - lines.length };
  // 每行的长度归到在这一行声明的物体（阵列、模板实例的那一行归到容器）
  const byLine = new Map(D.lines.map((x) => [`${x.file ?? ''}:${x.line}`, x.cost]));
  const stmtOf = new Map();
  for (const n of result.nodes) { const c = byLine.get(`${n.file ?? ''}:${n.line}`); if (c && !n.ghost && n.kind !== 'instance' && !stmtOf.has(`${n.file ?? ''}:${n.line}`)) stmtOf.set(`${n.file ?? ''}:${n.line}`, { path: n.path, cost: c }); }

  lap('description');
  const reconBVH = surfaces(recon);
  lap('bvh');
  const per = new Map(recon.map((o) => [o.path, { path: o.path, stmt: 0, mesh: 0, rSrc: 0, rRecon: 0, meanErr: 0, maxErr: 0, src: [] }]));
  for (const { path, cost } of stmtOf.values()) { const p = per.get(path) ?? per.get([...per.keys()].find((q) => q.startsWith(path + '.')) ?? ''); if (p) p.stmt += cost; }

  // L_mesh
  let Lmesh = 0;
  for (const o of recon) if (o.mesh) { const c = k.cMesh * Math.log2(1 + (o.mesh.tris || 1)); Lmesh += c; per.get(o.path).mesh += c; }

  // 这一次的重建物体：键（路径 + 颜色 + 几何）与包围盒；和上一次比，得到新增的物体与删掉的物体
  const keys = recon.map((o) => `${o.path}|${colorKey(o.color)}|${hashPos(o.pos)}`);
  const now = new Map(keys.map((key, j) => [key, { j, path: recon[j].path, box: boxOfPos(recon[j].pos), color: colorKey(recon[j].color) }]));
  // 物体路径的编号（逐点记最近的物体用；跨多次评分不变）
  const ids = state?.ids ?? { of: new Map(), path: [] };
  const idOf = (p) => { let i = ids.of.get(p); if (i == null) { i = ids.path.length; ids.path.push(p); ids.of.set(p, i); } return i; };
  const reconId = recon.map((o) => idOf(o.path));
  let delta = null; // null：全部重算
  if (state?.prev && state.srcRes) {
    const added = [], removed = new Set(), colorsNow = new Set([...now.values()].map((x) => x.color)), colorsPrev = new Set([...state.prev.values()].map((x) => x.color));
    for (const [key, x] of now) if (!state.prev.has(key)) added.push(x);
    for (const [key, x] of state.prev) if (!now.has(key)) removed.add(idOf(x.path));
    const flipped = new Set([...colorsNow].filter((c) => !colorsPrev.has(c)).concat([...colorsPrev].filter((c) => !colorsNow.has(c))));
    delta = { added, removed, flipped, colorsNow };
  }
  // 改动牵连了大半个场景（被挂靠的物体换了形，挂在它上面的都跟着动）：逐点核对不比全部重算省，直接全部重算
  if (delta && delta.added.length + delta.removed.size > 0.3 * recon.length) delta = null;
  if (delta) {
    const { added } = delta;
    // 新增的物体单独建一组表面：包围盒初筛之后，按真实几何判断新增的东西是不是比现在的距离更近（同材质规则、多计的 δ 与正式查询一样）
    const addedSurf = added.length ? surfaces(added.map((a) => recon[a.j])) : null;
    const v = new THREE.Vector3(), hitA = {};
    const closer = (p, color, same, limit) => {
      const g = same ? addedSurf.byColor.get(colorKey(color)) : addedSurf.all;
      const pen = !same && color != null ? k.delta : 0;
      if (!g || limit - pen <= 0) return false;
      const res = g.bvh.closestPointToPoint(v.set(p[0], p[1], p[2]), hitA, 0, limit - pen);
      return !!res && res.distance + pen < limit;
    };
    delta.closer = closer;
  }

  // R_src：源部件 → 重建。逐点记距离与最近的物体；增量时只重算受影响的点：
  //   最近的物体被删掉了的点；离某个新增物体的包围盒比现在的距离还近的点（同材质的目标存在时只看同材质的新增物体）
  let Rsrc = 0, touchedParts = 0, touchedPoints = 0, byRemoval = 0;
  const srcOut = [], srcRes = [];
  const near = nearest(reconBVH, k);
  for (const s of src) {
    const was = delta ? state.srcRes[s.i] : null;
    let x = was;
    if (delta) {
      const c = colorKey(s.color), same = s.color != null && delta.colorsNow.has(c);
      // 同材质的目标存在时只看同材质的新增物体
      const adds = delta.added.filter((a) => (!same || a.color === c) && boxesMeet(s.box, a.box, was.max));
      const hit = delta.flipped.has(c) ? null : (was.owners.some((o) => delta.removed.has(o)) || adds.length ? adds : false);
      if (hit !== false) {
        const pts = samplePoints(s.tris, k.samples, s.i + 1), f = near(s.color);
        const d = hit ? was.d.slice() : new Float64Array(pts.length), own = hit ? was.own.slice() : new Int32Array(pts.length);
        for (let i = 0; i < pts.length; i++) {
          if (hit && !delta.removed.has(own[i]) && !(hit.some((a) => boxDist(pts[i], a.box) < d[i]) && delta.closer(pts[i], s.color, same, d[i]))) continue;
          if (hit && delta.removed.has(own[i])) byRemoval++;
          const [di, oi] = f(pts[i]);
          d[i] = di; own[i] = oi >= 0 ? reconId[oi] : -1; touchedPoints++;
        }
        x = partResult(s, d, own, k);
        touchedParts++;
      }
    } else {
      const pts = samplePoints(s.tris, k.samples, s.i + 1), f = near(s.color);
      const d = new Float64Array(pts.length), own = new Int32Array(pts.length);
      pts.forEach((p, i) => { const [di, oi] = f(p); d[i] = di; own[i] = oi >= 0 ? reconId[oi] : -1; });
      x = partResult(s, d, own, k);
      touchedParts++; touchedPoints += pts.length;
    }
    srcRes.push(x);
    Rsrc += x.c;
    const who = x.who >= 0 ? ids.path[x.who] : null;
    if (who) { const p = per.get(who); p.rSrc += x.c; p.src.push(s.name); p.meanErr = Math.max(p.meanErr, x.mean); p.maxErr = Math.max(p.maxErr, x.max); }
    srcOut.push({ name: s.name, tris: s.tris.length, cost: +x.c.toFixed(3), meanErr: +(x.mean * u).toFixed(5), maxErr: +(x.max * u).toFixed(5), explainedBy: who });
  }
  lap(`R_src（检查 ${touchedParts}/${src.length} 个部件，重算 ${touchedPoints} 个点，其中 ${byRemoval} 个因为最近的物体被删）`);
  // R_recon：重建物体 → 源。权重以顶层语句为单位：一个物体被细化成很多块、一个类型实例里的各个部件，
  // 共享一个权重、内部按面积分摊——拆分不会因为“块数多”而受罚；凭空多出来的语句照样各算一份
  const triArea = (t) => len3(cross3(sub3(t[1], t[0]), sub3(t[2], t[0]))) / 2;
  let fresh = 0;
  const reconRes = new Map();
  const rec = recon.map((o, j) => {
    let x = state?.recon.get(keys[j]);
    if (!x) {
      const tris = triList(o.pos);
      const res = residual(samplePoints(tris, k.samples, seedOf(o.path)), srcBVH, k, o.color);
      x = { r: res.r, mean: res.mean, max: res.max, tris: tris.length, area: tris.reduce((s2, t) => s2 + triArea(t), 0) };
      fresh++;
    }
    reconRes.set(keys[j], x);
    return { o, res: x, tris: x.tris, area: x.area, top: o.path.split('.')[0] };
  });
  const groups = new Map();
  for (const x of rec) { const g = groups.get(x.top) ?? { tris: 0, area: 0 }; g.tris += x.tris; g.area += x.area; groups.set(x.top, g); }
  let Rrecon = 0;
  for (const { o, res, area, top } of rec) {
    const g = groups.get(top);
    // 每个顶层语句按它的表面积计权（与源侧同样的 log2(1 + 面积/δ²)），内部按面积分摊：拆分前后总面积不变，拆分本身不受罚
    const c = k.cRes * Math.log2(1 + g.area / (k.delta * k.delta)) * (g.area > 0 ? area / g.area : 1) * res.r;
    Rrecon += c;
    const p = per.get(o.path);
    p.rRecon += c; p.meanErr = Math.max(p.meanErr, res.mean); p.maxErr = Math.max(p.maxErr, res.max);
  }
  // 记住这一次的状态（只留这一次的物体，缓存不会越积越多）
  if (state) { state.prev = now; state.srcRes = srcRes; state.recon = reconRes; state.ids = ids; }

  lap(`R_recon（重算 ${fresh}/${recon.length}）`);
  // 基线：每个源部件写成一句世界坐标的 mesh 引用，误差为零（只取决于源部件与 cMesh）
  const fmt = (x) => String(Math.round(x * 1e4) / 1e4);
  let Smesh = 0;
  for (const s of src) {
    const { lo, hi } = s.box;
    const pv = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
    Smesh += lineCost(`mesh p src="x#${s.name}" size=${[0, 1, 2].map((j) => fmt(hi[j] - lo[j])).join(',')} pivot=${pv.map(fmt).join(',')} at=${pv.map(fmt).join(',')} mat=m`) + k.cMesh * Math.log2(1 + s.tris.length);
  }
  lap('S_mesh');
  const S = D.total + Lmesh + Rsrc + Rrecon;
  const objects = [...per.values()].map((p) => ({ ...p, total: +(p.stmt + p.mesh + p.rSrc + p.rRecon).toFixed(3), stmt: +p.stmt.toFixed(2), mesh: +p.mesh.toFixed(2), rSrc: +p.rSrc.toFixed(3), rRecon: +p.rRecon.toFixed(3), meanErr: +(p.meanErr * u).toFixed(5), maxErr: +(p.maxErr * u).toFixed(5) }));
  const r3 = (x) => +x.toFixed(2);
  return {
    S: r3(S), L_stmt: r3(D.total), droppedLines: D.dropped, L_mesh: r3(Lmesh), R_src: r3(Rsrc), R_recon: r3(Rrecon), S_mesh: r3(Smesh), explain: +(1 - S / Smesh).toFixed(4),
    consts: k0, objects, sources: srcOut,
    worst: [...objects].sort((a, b) => (b.mesh + b.rSrc + b.rRecon) - (a.mesh + a.rSrc + a.rRecon)).slice(0, 20).map((o) => ({ path: o.path, cost: +(o.mesh + o.rSrc + o.rRecon).toFixed(2), meanErr: o.meanErr, mesh: o.mesh > 0 })),
  };
}

// 邻域评分：全场分数在一个物体附近的变化量，用来在细化的几个候选之间挑一个，不必每个候选都编译、评分整个场景。
// 与全场评分同一套计价，并且尽量逐项复现它（以前的“局部分数”只和这个物体自己的源网格比、不分材质，18 次里有 2 次与全场方向相反）：
//   源侧：这个物体的源部件，加上离它不超过 dMax 的其他源部件（候选几何可能去解释、或者挡住邻居）；采样方式、种子与全场评分相同；
//   重建侧：目标表面 = 候选几何 + 附近其他的重建物体；同材质规则按全场的颜色集合判断（某种颜色在场景里有没有重建物体），没有时多计一个 δ；
//   候选物体到源的残差（R_recon）同全场：采样种子取自路径，一个顶层语句共享一个面积权重。
// 邻居源点到“其余物体”的距离只算一次；每个候选只算它到候选几何的距离，取两者中小的。坐标一律是世界坐标。
//   parts：全部源部件；near：邻域里源部件的序号（第一个是这个物体自己的）；others：附近其他重建物体 [{pos, color}]；
//   reconColors：场景里其他重建物体的颜色（colorKey）；返回 (objs:[{pos, color, path}], lines) → 分数
export function neighborhoodScorer({ parts, near, others, reconColors, consts = {} }) {
  const k0 = { ...SCORE_DEFAULTS, ...consts }, k = inScene(k0);
  const srcColors = new Set(parts.map((p) => colorKey(p.material?.color)));
  const ents = near.map((i) => {
    const p = parts[i], color = p.material?.color;
    return { i, color, c: colorKey(color), pts: samplePoints(p.tris, k.samples, i + 1), w: k.cRes * Math.log2(1 + areaOf(p.tris) / (k.delta * k.delta)), rest: new Map() };
  });
  const otherSurf = others.length ? surfaces(others) : null;
  const srcSurf = surfaces(near.map((i) => ({ pos: trisToArray(parts[i].tris), color: parts[i].material?.color })));
  const v = new THREE.Vector3(), hit = {};
  // 到一组表面里某种颜色（same）或全部表面的距离，封顶 limit
  const dist = (surf, c, same, pen, p, limit) => {
    const g = surf && (same ? surf.byColor.get(c) : surf.all);
    if (!g || limit - pen <= 0) return limit;
    const res = g.bvh.closestPointToPoint(v.set(p[0], p[1], p[2]), hit, 0, limit - pen);
    return res ? Math.min(res.distance + pen, limit) : limit;
  };
  return (objs, lines = []) => {
    const recon = objs.filter((o) => o.pos.length);
    const colorsNow = new Set([...reconColors, ...recon.map((o) => colorKey(o.color))]);
    const candSurf = recon.length ? surfaces(recon) : null;
    // R_src：邻域里的每个源部件
    let Rsrc = 0, own = null;
    for (const e of ents) {
      const same = e.color != null && colorsNow.has(e.c), pen = !same && e.color != null ? k.delta : 0, mode = same ? 'same' : 'all';
      if (!e.rest.has(mode)) e.rest.set(mode, Float64Array.from(e.pts, (p) => dist(otherSurf, e.c, same, pen, p, k.dMax)));
      const rest = e.rest.get(mode), d = new Float64Array(e.pts.length);
      e.pts.forEach((p, j) => { d[j] = dist(candSurf, e.c, same, pen, p, rest[j]); });
      const res = aggregate(d, k);
      Rsrc += e.w * res.r;
      own ??= res;
    }
    // R_recon：候选物体 → 邻域里的源部件（离它更远的源部件在 dMax 之外，不影响距离）
    let A = 0, acc = 0;
    for (const o of recon) {
      const tris = triList(o.pos), area = areaOf(tris), c = colorKey(o.color);
      const same = o.color != null && srcColors.has(c), pen = !same && o.color != null ? k.delta : 0;
      const pts = samplePoints(tris, k.samples, seedOf(o.path ?? ''));
      const res = aggregate(Float64Array.from(pts, (p) => dist(srcSurf, c, same, pen, p, k.dMax)), k);
      A += area; acc += area * res.r;
    }
    const Rrecon = A > 0 ? k.cRes * Math.log2(1 + A / (k.delta * k.delta)) * (acc / A) : 0;
    // 网格引用（现在的写法可能就是一块网格）：c_mesh × log2(1 + 三角形数)，与全场的 L_mesh 一样
    const L = lines.reduce((s, l) => s + lineCost(l), 0) + recon.reduce((s, o) => s + (o.mesh ? k.cMesh * Math.log2(1 + (o.mesh.tris || 1)) : 0), 0);
    const r3 = (x) => +x.toFixed(2);
    return { S: r3(L + Rsrc + Rrecon), L: r3(L), R_src: r3(Rsrc), R_recon: r3(Rrecon), meanErr: +((own?.mean ?? 0) * k0.unit).toFixed(4), maxErr: +((own?.max ?? 0) * k0.unit).toFixed(4) };
  };
}
