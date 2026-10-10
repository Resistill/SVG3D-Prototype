// 自评分数：不依赖真值，是 AI 的目标函数，也是人的进度条（docs/PLAN2.md 第 3 节）。
//   S = L_stmt + L_mesh + R_src + R_recon，越低越好
//   L_stmt  描述长度：名字、关键字、引用各 1；数字 1 + 0.5 × (小数位 − 1)；注释与 ~元数据不计
//   L_mesh  仍以源网格引用保留的部分：c_mesh × log2(1 + 三角形数)
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

export const SCORE_DEFAULTS = { delta: 0.005, cRes: 4, cMesh: 10, dMax: 2, samples: 600 };

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
function surfaces(objs) {
  const groups = new Map();
  objs.forEach((o, k) => { const c = colorKey(o.color); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(k); });
  const byColor = new Map([...groups].map(([c, ids]) => [c, bvhOf(ids.map((k) => objs[k]), ids)]));
  return { byColor, all: bvhOf(objs) };
}

// 点集到一组表面的距离；返回 { r（平均代价）, mean, max, owners（每个点最近的物体） }
function residual(points, target, k, color = null) {
  const v = new THREE.Vector3(), hit = {};
  let rs = 0, sum = 0, mx = 0;
  const owners = [];
  const same = target && color != null ? target.byColor.get(colorKey(color)) : null;
  const bvh = same ?? target?.all ?? null;
  const penalty = target && color != null && !same ? k.delta : 0; // 没有同材质的表面：多计一个 δ
  for (const p of points) {
    let d = k.dMax, owner = -1;
    if (bvh) {
      const res = bvh.bvh.closestPointToPoint(v.set(p[0], p[1], p[2]), hit, 0, k.dMax);
      if (res) { d = Math.min(res.distance + penalty, k.dMax); owner = bvh.owner[bvh.triOf(res.faceIndex)]; }
    }
    rs += Math.log2(1 + Math.max(0, d - k.delta) / k.delta); sum += d; mx = Math.max(mx, d);
    owners.push(owner);
  }
  const n = points.length || 1;
  return { r: rs / n, mean: sum / n, max: mx, owners };
}

// result：compile() 的结果；files：描述文本（[{file, text}]，已包括 import 的文件）；sourceParts：readParts() 的源部件
export function score({ result, files, sourceParts, consts = {} }) {
  const k = { ...SCORE_DEFAULTS, ...consts };
  const recon = sceneObjects(result, { sourceParts }).filter((o) => o.pos.length);
  const src = sourceParts.map((p, i) => ({ i, name: p.uid ?? p.name ?? p.from ?? `part_${i}`, tris: p.tris, pos: trisToArray(p.tris), color: p.material?.color }));
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

  const reconBVH = surfaces(recon), srcBVH = surfaces(src);
  const per = new Map(recon.map((o) => [o.path, { path: o.path, stmt: 0, mesh: 0, rSrc: 0, rRecon: 0, meanErr: 0, maxErr: 0, src: [] }]));
  for (const { path, cost } of stmtOf.values()) { const p = per.get(path) ?? per.get([...per.keys()].find((q) => q.startsWith(path + '.')) ?? ''); if (p) p.stmt += cost; }

  // L_mesh
  let Lmesh = 0;
  for (const o of recon) if (o.mesh) { const c = k.cMesh * Math.log2(1 + (o.mesh.tris || 1)); Lmesh += c; per.get(o.path).mesh += c; }

  // R_src：源部件 → 重建
  let Rsrc = 0;
  const srcOut = [];
  for (const s of src) {
    const pts = samplePoints(s.tris, k.samples, s.i + 1);
    const res = residual(pts, reconBVH, k, s.color);
    // 权重 = 这块表面在当前精度下有多少个 δ 见方的格子（取对数）：表面越大、精度要求越细，同样的误差越贵
    const c = k.cRes * Math.log2(1 + areaOf(s.tris) / (k.delta * k.delta)) * res.r;
    Rsrc += c;
    // 归到最近点最多落在其上的那个重建物体
    const votes = new Map();
    for (const o of res.owners) if (o >= 0) votes.set(o, (votes.get(o) ?? 0) + 1);
    const top = [...votes].sort((a, b) => b[1] - a[1])[0];
    const who = top ? recon[top[0]].path : null;
    if (who) { const p = per.get(who); p.rSrc += c; p.src.push(s.name); p.meanErr = Math.max(p.meanErr, res.mean); p.maxErr = Math.max(p.maxErr, res.max); }
    srcOut.push({ name: s.name, tris: s.tris.length, cost: +c.toFixed(3), meanErr: +res.mean.toFixed(5), maxErr: +res.max.toFixed(5), explainedBy: who });
  }
  // R_recon：重建物体 → 源。权重以顶层语句为单位：一个物体被细化成很多块、一个类型实例里的各个部件，
  // 共享一个权重、内部按面积分摊——拆分不会因为“块数多”而受罚；凭空多出来的语句照样各算一份
  const triArea = (t) => len3(cross3(sub3(t[1], t[0]), sub3(t[2], t[0]))) / 2;
  const rec = recon.map((o, i) => {
    const tris = triList(o.pos);
    const res = residual(samplePoints(tris, k.samples, 1000 + i), srcBVH, k, o.color);
    return { o, res, tris: tris.length, area: tris.reduce((s2, t) => s2 + triArea(t), 0), top: o.path.split('.')[0] };
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

  // 基线：每个源部件写成一句世界坐标的 mesh 引用，误差为零
  const fmt = (x) => String(Math.round(x * 1e4) / 1e4);
  let Smesh = 0;
  for (const s of src) {
    const lo = [0, 1, 2].map((j) => Math.min(...s.tris.flat().map((v) => v[j]))), hi = [0, 1, 2].map((j) => Math.max(...s.tris.flat().map((v) => v[j])));
    const pv = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
    Smesh += lineCost(`mesh p src="x#${s.name}" size=${[0, 1, 2].map((j) => fmt(hi[j] - lo[j])).join(',')} pivot=${pv.map(fmt).join(',')} at=${pv.map(fmt).join(',')} mat=m`) + k.cMesh * Math.log2(1 + s.tris.length);
  }
  const S = D.total + Lmesh + Rsrc + Rrecon;
  const objects = [...per.values()].map((p) => ({ ...p, total: +(p.stmt + p.mesh + p.rSrc + p.rRecon).toFixed(3), stmt: +p.stmt.toFixed(2), mesh: +p.mesh.toFixed(2), rSrc: +p.rSrc.toFixed(3), rRecon: +p.rRecon.toFixed(3), meanErr: +p.meanErr.toFixed(5), maxErr: +p.maxErr.toFixed(5) }));
  const r3 = (x) => +x.toFixed(2);
  return {
    S: r3(S), L_stmt: r3(D.total), droppedLines: D.dropped, L_mesh: r3(Lmesh), R_src: r3(Rsrc), R_recon: r3(Rrecon), S_mesh: r3(Smesh), explain: +(1 - S / Smesh).toFixed(4),
    consts: k, objects, sources: srcOut,
    worst: [...objects].sort((a, b) => (b.mesh + b.rSrc + b.rRecon) - (a.mesh + a.rSrc + a.rRecon)).slice(0, 20).map((o) => ({ path: o.path, cost: +(o.mesh + o.rSrc + o.rRecon).toFixed(2), meanErr: o.meanErr, mesh: o.mesh > 0 })),
  };
}
