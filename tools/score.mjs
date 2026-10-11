// 自评分数：不依赖真值，是 AI 的目标函数，也是人的进度条（docs/PLAN2.md 第 3 节）。
//   S = L_stmt + L_mesh + R_src + R_recon + R_vol，越低越好
//   L_stmt  描述长度：名字、关键字、引用各 1；数字 1 + 0.5 × (小数位 − 1)；注释与 ~元数据不计
//   L_mesh  仍以源网格引用保留的部分：默认按真实信息量（4.5 × 顶点数 + 3 × 三角形数），工程可以按角色改成引用价 c_mesh × log2(1 + 三角形数)（见 meshPrice）。同一个网格（享元）只在第一次出现时付，以后的实例只付那一行语句
//   长度都按米计（δ、dMax、输出的误差），场景单位不是米时按 unit 换算
//   R_src   源模型的每个部件表面采样，到重建表面的距离 d → log2(1 + max(0, d − δ)/δ)，按 log2(1 + 面积/δ²) 加权
//           （这块表面在当前精度下有多少个 δ 见方的格子：精度要求越细、表面越大，同样的误差越贵——评分标准随档位变化）。
//           δ 由档位决定；误差在 δ 以内不计代价（逆向只要求保留语义，不奖励“猜中作者的精确数值”）。
//           距离优先量到**同材质**的重建表面：沥青路面只能由沥青的物体解释，不能拿底下的地面凑数；
//           没有同材质的表面时量到全部表面，并多计一个 δ
//   有效描述：基础层里声明的物体被删掉了，那一行不计长度（替换一个物体不应付两份钱）；被 over X : 种类 换了形的，
//           那一行只计名字、定位与材质（形状参数作废了）
//   R_recon 重建物体表面到源表面的距离，同样计价；复杂度权重以顶层语句为单位、内部按面积分摊（惩罚凭空多出来的东西，但不惩罚拆分）
//   R_vol   体积误差：重建物体的实体里、源模型实体外面的部分（实心体块填满了空心楼），内部采样点同样计价，
//           权重 c_res × log2(1 + 体积/δ³)，以顶层语句为单位、内部按体积分摊（volume.mjs）。网格引用、薄的物体不计
// 解释率 explain = 1 − S / S_mesh，S_mesh 是“全部写成 mesh 引用、世界坐标定位”的基线。
import { closestMany, pointArray, sharedArray } from './nearest.mjs';
import { samplePoints, sourceSamples, uniqueVertices } from './parts.mjs';
import { colorKey, surfaces, sourceSurfaces, saveSurfaces, loadSurfaces } from './surfaces.mjs';
import { sceneObjects, trisToArray } from './worldtris.mjs';
import { nodeRoles } from '../src/roles-view.js';
import { interiorSamples, volumeResidual, volumeStats, solidStats } from './volume.mjs';
import { assignRoles } from './roles.mjs';

// 长度常数（delta、dMax）按米给出，unit 是每个场景单位多少米；计算前换算成场景单位（inScene），输出的误差（meanErr、maxErr）再换回米。
// 换算之后分数与单位无关：残差是 d/δ，面积权重是 面积/δ²，都是无量纲的
export const SCORE_DEFAULTS = { delta: 0.005, cRes: 4, cMesh: 10, dMax: 2, samples: 600, unit: 1 };
const inScene = (k) => ({ ...k, delta: k.delta / k.unit, dMax: k.dMax / k.unit });

// 网格引用的价钱（L_mesh），按网格所属源部件的角色（roles.mjs）：
//   full：真实信息量——把这个网格用语言逐点写出来的长度：每个顶点 3 个数（按两位小数的数计，各 1.5），每个三角形 3 个引用（各 1）。
//         默认所有角色都这样计：重建场景就是要把它们写成语言，关掉网格引用时场景不能少东西（用户的验收：不画网格的重建与源模型
//         模糊后看起来差不多，compare 命令量）。
//   ref： c_mesh × log2(1 + 三角形数)——只是引用一个现成的资产。工程可以按角色改成这样（例如允许装饰保留网格）。
//   （D9 一度让地形、装饰、贴花默认按引用价，关掉网格后宿舍区的地面、广场全没了，缺三成）
// 工程的 project.json 里 score.meshPrice 按角色改，例如 { "decor": "full" }
export const MESH_PRICE = { structure: 'full', terrain: 'full', decor: 'full', decal: 'full', helper: 'ref' };
const VERTS = new WeakMap();
const vertexCount = (tris) => { let n = VERTS.get(tris); if (n == null) VERTS.set(tris, (n = uniqueVertices(tris).length)); return n; };
export const meshPriceMode = (role, k = SCORE_DEFAULTS) => ({ ...MESH_PRICE, ...(k.meshPrice ?? {}) }[role ?? 'structure'] ?? 'full');
export function meshPrice(tris, role, k = SCORE_DEFAULTS) {
  const how = meshPriceMode(role, k);
  if (how === 'full' && tris?.length) return 4.5 * vertexCount(tris) + 3 * tris.length;
  return (k.cMesh ?? SCORE_DEFAULTS.cMesh) * Math.log2(1 + (tris?.length || 1));
}
const meshPriceOf = (m, k) => meshPrice(m.srcTris, m.role, k);

// 一条语句拆成词：方括号、圆括号、引号里的空格不拆
function splitTokens(line) {
  const out = [];
  let cur = '', depth = 0, q = false;
  for (const ch of line.trim()) {
    if (q) { cur += ch; if (ch === '"') q = false; continue; }
    if (ch === '"') { q = true; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// 被 over X : 种类 换了形的语句能省下的长度：形状参数作废了，只留名字、定位与材质（细化的邻域评分也用它）
const PLACE_KEYS = new Set(['on', 'at', 'against', 'offset', 'pin', 'align', 'turn', 'rot', 'inside', 'gap', 'under', 'mat']);
export function reshapeSaving(line) {
  const ts = splitTokens(line);
  return lineCost(line) - lineCost(ts.filter((x, i) => i < 2 || x.startsWith('~') || PLACE_KEYS.has(/^([\p{L}_][\p{L}\p{N}_]*)=/u.exec(x)?.[1])).join(' '));
}

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
const triList = (pos) => { const out = []; for (let i = 0; i < pos.length; i += 9) out.push([[pos[i], pos[i + 1], pos[i + 2]], [pos[i + 3], pos[i + 4], pos[i + 5]], [pos[i + 6], pos[i + 7], pos[i + 8]]]); return out; };

// 表面集合（按材质颜色分组的树，见 surfaces.mjs）：{ byColor: Map(颜色 → 树), all: 树 }
// 重建物体的采样种子取自路径（不取序号）：语句挪了位置、换了文件，分数不变
const seedOf = (s) => { let h = 2166136261; for (let j = 0; j < s.length; j++) h = Math.imul(h ^ s.charCodeAt(j), 16777619); return 1000 + ((h >>> 0) % 1000003); };

// 到一组表面的最近距离：nearest(target, k)(color) 给出 p → [d, 最近的物体]（没有目标、或 dMax 以内没有表面：[dMax, −1]）。
// 距离优先量到同材质的表面；没有同材质的表面时量到全部表面，并多计一个 δ
const pick = (target, k, color) => {
  const same = target && color != null ? target.byColor.get(colorKey(color)) : null;
  return { bvh: same ?? target?.all ?? null, penalty: target && color != null && !same ? k.delta : 0 };
};
function nearest(target, k) {
  return (color = null) => {
    const { bvh, penalty } = pick(target, k, color);
    return (p) => {
      if (!bvh) return [k.dMax, -1];
      const t = bvh.q.closest(p[0], p[1], p[2], k.dMax);
      return t >= 0 ? [Math.min(bvh.q.distance + penalty, k.dMax), bvh.owner[t]] : [k.dMax, -1];
    };
  };
}
// 源部件的采样点（扁平数组，按部件序号）：同一组源部件只采一次，工程里还存进磁盘缓存
function srcSamples(shared, n) {
  if (shared.samples.has(n)) return shared.samples.get(n);
  let out;
  const saved = shared.persist?.load('samples', { n }, (T, m) => (T === Float64Array ? sharedArray(m) : new T(m)));
  if (saved) {
    const { pts, offsets } = saved.blobs;
    out = Array.from({ length: offsets.length - 1 }, (_, i) => pts.subarray(offsets[i], offsets[i + 1]));
  } else {
    out = shared.src.map((s) => flatPoints(sourceSamples(s.tris, s.i, n)));
    if (shared.persist) {
      const offsets = new Int32Array(out.length + 1);
      out.forEach((a, i) => { offsets[i + 1] = offsets[i] + a.length; });
      const pts = new Float64Array(offsets[out.length]);
      out.forEach((a, i) => pts.set(a, offsets[i]));
      shared.persist.save('samples', { n }, {}, { pts, offsets });
    }
  }
  shared.samples.set(n, out);
  return out;
}
const toPoints = (a) => Array.from({ length: a.length / 3 }, (_, i) => [a[3 * i], a[3 * i + 1], a[3 * i + 2]]);
const flatPoints = (pts) => {
  const a = pointArray(pts.length);
  pts.forEach((p, i) => { a[3 * i] = p[0]; a[3 * i + 1] = p[1]; a[3 * i + 2] = p[2]; });
  return a;
};
// 一批点集各自到一组表面的距离（与逐点调用 nearest 的结果逐位相同，点多时分给 worker 线程）：
//   sets [{ pts（扁平的点数组，pointArray）, color }] → 每项 { d: Float64Array, own: Int32Array（最近的物体，−1 表示没有） }
function nearestMany(target, k, sets) {
  const items = [], picks = sets.map(({ pts, color }) => {
    const pk = pick(target, k, color);
    if (pk.bvh && pts.length) pk.item = items.push({ q: pk.bvh.q, pts, max: k.dMax }) - 1;
    return pk;
  });
  const res = closestMany(items);
  return sets.map(({ pts }, j) => {
    const { bvh, penalty, item } = picks[j], n = pts.length / 3, d = new Float64Array(n), own = new Int32Array(n);
    if (item == null) { d.fill(k.dMax); own.fill(-1); return { d, own }; }
    const { d: raw, t } = res[item];
    for (let i = 0; i < n; i++) { if (t[i] >= 0) { d[i] = Math.min(raw[i] + penalty, k.dMax); own[i] = bvh.owner[t[i]]; } else { d[i] = k.dMax; own[i] = -1; } }
    return { d, own };
  });
}
// 逐点距离 → { r（平均代价）, mean, max }；按点的顺序累加（增量评分与全量评分逐位一致）
function aggregate(d, k) {
  let rs = 0, sum = 0, mx = 0;
  for (let i = 0; i < d.length; i++) { rs += Math.log2(1 + Math.max(0, d[i] - k.delta) / k.delta); sum += d[i]; mx = Math.max(mx, d[i]); }
  const n = d.length || 1;
  return { r: rs / n, mean: sum / n, max: mx };
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
// 跨进程：工程给了 persist 时，评分后把状态存进源模型一侧的磁盘缓存（种类 score，键里有评分代码的哈希与常数），
// 新进程里这组常数还没有状态时先读它——命令行每次调用的第一次评分也是增量的。重建一侧变了多少由增量算法自己核对，结果与全量一致
// persist：源模型一侧的磁盘缓存（工程给，见 project.mjs）：{ load(种类, 参数, alloc) → { meta, blobs } | null, save(种类, 参数, meta, blobs) }
export function scoreCache(persist = null) { return { parts: null, shared: null, states: new Map(), persist }; }

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
  // 部件没挂角色（不经过工程直接评分）时按默认规则判，与逆向一致（逆向同样这样判）
  const roles = sourceParts.every((p) => p.role) ? null : assignRoles(sourceParts);
  const src = sourceParts.map((p, i) => {
    // 包围盒按原始坐标取（基线里的数字要和全量评分一模一样）
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of p.tris) for (const v of t) for (let j = 0; j < 3; j++) { if (v[j] < lo[j]) lo[j] = v[j]; if (v[j] > hi[j]) hi[j] = v[j]; }
    // role：工程按 roles.json 判的角色（roles.mjs）；辅助部件（白模体积、雾、碰撞体）不属于场景，不计 R_src、不进基线
    const role = p.role ?? roles?.[i] ?? null;
    return { i, role, skip: role === 'helper', name: p.uid ?? p.name ?? p.from ?? `part_${i}`, meshKey: p.mesh != null ? `m:${p.mesh}` : null, tris: p.tris, color: p.material?.color, area: areaOf(p.tris), box: { lo, hi } };
  });
  // 源表面的树：磁盘缓存里有就直接恢复（不重新建树）
  const persist = cache?.persist, saved = persist?.load('surfaces', {});
  const srcBVH = sourceSurfaces(sourceParts, saved ? loadSurfaces(saved) : null);
  if (persist && !saved) { const { meta, blobs } = saveSurfaces(srcBVH); persist.save('surfaces', {}, meta, blobs); }
  const shared = { src, srcBVH, samples: new Map(), persist };
  if (cache) { cache.parts = sourceParts; cache.shared = shared; cache.states.clear(); }
  return shared;
}

// 评分状态 ↔ 磁盘：逐点的距离与最近的物体按源部件顺序拼成两个大数组，其余（上一次的物体表、每个物体的残差、路径编号）按 JSON 存；
// 源部件的汇总（代价、均值、最近物体的投票）读回来时按逐点数据重算，和当时算出来的一样
function saveState(state, shared, ckey) {
  try {
    const n = state.srcRes.reduce((a, x) => a + x.d.length, 0), d = new Float64Array(n), own = new Int32Array(n), offsets = new Int32Array(state.srcRes.length + 1);
    let o = 0;
    state.srcRes.forEach((x, i) => { d.set(x.d, o); own.set(x.own, o); o += x.d.length; offsets[i + 1] = o; });
    const meta = { prev: [...state.prev].map(([key, x]) => [key, x.j, x.path, x.box, x.color]), recon: [...state.recon], ids: state.ids.path };
    shared.persist.save('score', { ckey }, meta, { d, own, offsets });
  } catch { /* 存不了就算了 */ }
}
function loadState(state, shared, k, ckey) {
  try {
    const saved = shared.persist.load('score', { ckey });
    if (!saved) return;
    const { meta, blobs: { d, own, offsets } } = saved;
    if (offsets.length !== shared.src.length + 1) return;
    state.srcRes = shared.src.map((s, i) => partResult(s, d.slice(offsets[i], offsets[i + 1]), own.slice(offsets[i], offsets[i + 1]), k));
    state.prev = new Map(meta.prev.map(([key, j, path, box, color]) => [key, { j, path, box, color }]));
    state.recon = new Map(meta.recon);
    state.ids = { path: meta.ids, of: new Map(meta.ids.map((p, i) => [p, i])) };
  } catch { state.srcRes = null; state.prev = null; state.recon = new Map(); }
}

// result：compile() 的结果；files：描述文本（[{file, text}]，已包括 import 的文件）；sourceParts：readParts() 的源部件；
// cache：scoreCache()，可选（给了就增量评分）
export function score({ result, files, sourceParts, consts = {}, cache = null }) {
  const k0 = { ...SCORE_DEFAULTS, ...consts }, k = inScene(k0), u = k0.unit;
  // 计时：S3D_TIMING=1 时把各阶段耗时打到 stderr
  const T0 = performance.now(), lap = (what) => process.env.S3D_TIMING && console.error(`[score] ${what} ${Math.round(performance.now() - T0)}ms`);
  const recon = sceneObjects(result, { sourceParts }).filter((o) => o.pos.length);
  const shared = sharedOf(sourceParts, cache), { src, srcBVH } = shared;
  // 网格引用的角色：部件没挂角色时取上面按默认规则判的（网格的价钱按角色）
  const roleOfSrc = new Map(src.map((s) => [s.name, s.role]));
  for (const o of recon) if (o.mesh && o.mesh.role == null) o.mesh.role = roleOfSrc.get(o.mesh.src) ?? null;
  const ckey = JSON.stringify(['vol1', k.delta, k.dMax, k.samples, k.cRes, src.filter((x) => x.skip).map((x) => x.i).join()]);
  const state = cache ? (cache.states.get(ckey) ?? cache.states.set(ckey, { recon: new Map(), prev: null, srcRes: null }).get(ckey)) : null;
  if (state && !state.srcRes && shared.persist) loadState(state, shared, k, ckey);
  lap('sceneObjects');
  const D0 = descriptionLength(files);
  // 有效描述：声明物体的行，物体还在才计
  const declared = new Set(result.nodes.map((n) => `${n.file ?? ''}:${n.line}`));
  const NOT_DECL = /^\s*(material|let|def|over|drop|copy|import|concept|pattern|check|style|variant|\})\b/;
  const fileText = new Map(files.map((f) => [f.file ?? '', f.text.split('\n')]));
  const keep = (x) => { const t = fileText.get(x.file ?? '')?.[x.line - 1] ?? ''; return NOT_DECL.test(t) || !/^\s*[\p{L}_][\p{L}\p{N}_]*\s+[\p{L}_]/u.test(t) || declared.has(`${x.file ?? ''}:${x.line}`); };
  // 换形：over X : 种类（X 是顶层物体）——基础层里声明 X 的那一行，形状参数作废了，只计名字、定位与材质
  const reshaped = new Set();
  for (const { text } of files) for (const m of text.matchAll(/^\s*over\s+([\p{L}_][\p{L}\p{N}_]*)\s*:\s*[\p{L}_]/gmu)) reshaped.add(m[1]);
  const lines = D0.lines.filter(keep).map((x) => {
    const t = fileText.get(x.file ?? '')?.[x.line - 1] ?? '';
    const m = /^([\p{L}_][\p{L}\p{N}_]*)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(t);
    return m && reshaped.has(m[2]) && !/^(over|def|material|drop)$/.test(m[1]) && !/\{\s*$/.test(t) ? { ...x, cost: lineCost(t) - reshapeSaving(t) } : x;
  });
  const D = { total: lines.reduce((s, x) => s + x.cost, 0), lines, dropped: D0.lines.length - lines.length };
  // 每行的长度归到在这一行声明的物体（阵列、模板实例的那一行归到容器）
  const byLine = new Map(D.lines.map((x) => [`${x.file ?? ''}:${x.line}`, x.cost]));
  const stmtOf = new Map();
  for (const n of result.nodes) { const c = byLine.get(`${n.file ?? ''}:${n.line}`); if (c && !n.ghost && n.kind !== 'instance' && !stmtOf.has(`${n.file ?? ''}:${n.line}`)) stmtOf.set(`${n.file ?? ''}:${n.line}`, { path: n.path, cost: c }); }

  lap('description');
  // 重建物体的树：用到时才建（增量评分里什么都没变时用不着）
  let reconBVH0 = null;
  const reconBVH = () => (reconBVH0 ??= surfaces(recon));
  lap('bvh');
  const per = new Map(recon.map((o) => [o.path, { path: o.path, stmt: 0, mesh: 0, rSrc: 0, rRecon: 0, rVol: 0, meanErr: 0, maxErr: 0, src: [] }]));
  // 描述长度归到物体：自己有几何就归自己，否则归第一个有几何的子物体，再不行沿路径向上找（subtract 的子语句归到 subtract）
  const ownerOfPath = (path) => {
    if (per.has(path)) return per.get(path);
    const child = [...per.keys()].find((q) => q.startsWith(path + '.'));
    if (child) return per.get(child);
    for (let p = path; p.includes('.');) { p = p.slice(0, p.lastIndexOf('.')); if (per.has(p)) return per.get(p); }
    return null;
  };
  let attributed = 0;
  for (const { path, cost } of stmtOf.values()) { const p = ownerOfPath(path); if (p) { p.stmt += cost; attributed += cost; } }

  // L_mesh
  let Lmesh = 0;
  const meshSeen = new Set();
  for (const o of recon) if (o.mesh) {
    const key = o.mesh.key ?? o.mesh.src;
    if (meshSeen.has(key)) continue;
    meshSeen.add(key);
    const c = meshPriceOf(o.mesh, k); Lmesh += c; per.get(o.path).mesh += c;
  }

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
    const closer = (p, color, same, limit) => {
      const g = same ? addedSurf.byColor.get(colorKey(color)) : addedSurf.all;
      const pen = !same && color != null ? k.delta : 0;
      if (!g || limit - pen <= 0) return false;
      return g.q.closest(p[0], p[1], p[2], limit - pen) >= 0 && g.q.distance + pen < limit;
    };
    delta.closer = closer;
  }

  const srcOwner = new Map();
  for (const n of result.nodes) if (n.meta?.src && !srcOwner.has(n.meta.src)) { const o = ownerOfPath(n.path); if (o) srcOwner.set(n.meta.src, o.path); }
  // R_src：源部件 → 重建。逐点记距离与最近的物体；增量时只重算受影响的点：
  //   最近的物体被删掉了的点；离某个新增物体的包围盒比现在的距离还近的点（同材质的目标存在时只看同材质的新增物体）
  let Rsrc = 0, touchedParts = 0, touchedPoints = 0, byRemoval = 0;
  const srcOut = [], srcRes = [];
  const near = (color) => nearest(reconBVH(), k)(color);
  // 全量时按块批量查询（一块几百个部件：点数够分给 worker，又不必同时留着全部采样点）
  const BLOCK = 256, full = new Map(), srcPts = srcSamples(shared, k.samples);
  if (!delta) for (let b = 0; b < src.length; b += BLOCK) {
    const block = src.slice(b, b + BLOCK);
    nearestMany(reconBVH(), k, block.map((s) => ({ pts: srcPts[s.i], color: s.color }))).forEach((x, j) => full.set(block[j].i, x));
  }
  for (const s of src) {
    const was = delta ? state.srcRes[s.i] : null;
    let x = was;
    if (delta) {
      const c = colorKey(s.color), same = s.color != null && delta.colorsNow.has(c);
      // 同材质的目标存在时只看同材质的新增物体
      const adds = delta.added.filter((a) => (!same || a.color === c) && boxesMeet(s.box, a.box, was.max));
      const hit = delta.flipped.has(c) ? null : (was.owners.some((o) => delta.removed.has(o)) || adds.length ? adds : false);
      if (hit !== false) {
        const pts = toPoints(srcPts[s.i]), f = near(s.color);
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
      const { d, own } = full.get(s.i);
      full.delete(s.i);
      for (let i = 0; i < own.length; i++) if (own[i] >= 0) own[i] = reconId[own[i]];
      x = partResult(s, d, own, k);
      touchedParts++; touchedPoints += d.length;
    }
    srcRes.push(x);
    if (s.skip) { srcOut.push({ name: s.name, tris: s.tris.length, cost: 0, role: 'helper', skipped: true }); continue; }
    Rsrc += x.c;
    // 归属：~src 指向这个源部件的物体优先（它就是“负责解释这块网格”的那个），没有时归到最近点最多落在其上的物体
    const who = srcOwner.get(s.name) ?? (x.who >= 0 ? ids.path[x.who] : null);
    if (who) { const p = per.get(who); p.rSrc += x.c; p.src.push(s.name); p.meanErr = Math.max(p.meanErr, x.mean); p.maxErr = Math.max(p.maxErr, x.max); }
    srcOut.push({ name: s.name, tris: s.tris.length, cost: +x.c.toFixed(3), meanErr: +(x.mean * u).toFixed(5), maxErr: +(x.max * u).toFixed(5), explainedBy: who });
  }
  lap(`R_src（检查 ${touchedParts}/${src.length} 个部件，重算 ${touchedPoints} 个点，其中 ${byRemoval} 个因为最近的物体被删）`);
  // R_recon：重建物体 → 源。权重以顶层语句为单位：一个物体被细化成很多块、一个类型实例里的各个部件，
  // 共享一个权重、内部按面积分摊——拆分不会因为“块数多”而受罚；凭空多出来的语句照样各算一份
  const triArea = (t) => len3(cross3(sub3(t[1], t[0]), sub3(t[2], t[0]))) / 2;
  let fresh = 0;
  const reconRes = new Map();
  // 没有缓存的物体按块批量查询（同 R_src）
  const todo = recon.map((o, j) => j).filter((j) => !state?.recon.get(keys[j])), computed = new Map();
  for (let b = 0; b < todo.length; b += BLOCK) {
    const block = todo.slice(b, b + BLOCK).map((j) => ({ j, tris: triList(recon[j].pos) }));
    nearestMany(srcBVH, k, block.map(({ j, tris }) => ({ pts: flatPoints(samplePoints(tris, k.samples, seedOf(recon[j].path))), color: recon[j].color }))).forEach(({ d }, m) => {
      const { j, tris } = block[m], res = aggregate(d, k);
      const inner = recon[j].mesh ? null : interiorSamples(recon[j].pos, k, seedOf(recon[j].path));
      computed.set(j, { r: res.r, mean: res.mean, max: res.max, tris: tris.length, area: tris.reduce((s2, t) => s2 + triArea(t), 0), vol: inner?.vol ?? 0, rv: inner ? volumeResidual(inner.pts, srcBVH?.all?.q, k) : 0 });
    });
  }
  const rec = recon.map((o, j) => {
    let x = state?.recon.get(keys[j]);
    if (!x) { x = computed.get(j); fresh++; }
    reconRes.set(keys[j], x);
    return { o, res: x, tris: x.tris, area: x.area, top: o.path.split('.')[0] };
  });
  const groups = new Map();
  for (const x of rec) { const g = groups.get(x.top) ?? { tris: 0, area: 0, vol: 0 }; g.tris += x.tris; g.area += x.area; g.vol += x.res.vol; groups.set(x.top, g); }
  let Rrecon = 0, Rvol = 0;
  for (const { o, res, area, top } of rec) {
    const g = groups.get(top);
    // 每个顶层语句按它的表面积计权（与源侧同样的 log2(1 + 面积/δ²)），内部按面积分摊：拆分前后总面积不变，拆分本身不受罚
    const c = k.cRes * Math.log2(1 + g.area / (k.delta * k.delta)) * (g.area > 0 ? area / g.area : 1) * res.r;
    Rrecon += c;
    const p = per.get(o.path);
    p.rRecon += c; p.meanErr = Math.max(p.meanErr, res.mean); p.maxErr = Math.max(p.maxErr, res.max);
    // 体积误差：同样以顶层语句为单位，权重按体积（log2(1 + 体积/δ³)），内部按体积分摊
    if (res.rv > 0) { const cv = k.cRes * Math.log2(1 + g.vol / k.delta ** 3) * (res.vol / g.vol) * res.rv; Rvol += cv; p.rVol += cv; }
  }
  // 记住这一次的状态（只留这一次的物体，缓存不会越积越多）
  if (state) { state.prev = now; state.srcRes = srcRes; state.recon = reconRes; state.ids = ids; if (shared.persist) saveState(state, shared, ckey); }

  lap(`R_recon（重算 ${fresh}/${recon.length}）`);
  // 基线：每个源部件写成一句世界坐标的 mesh 引用，误差为零（只取决于源部件与 cMesh）
  const fmt = (x) => String(Math.round(x * 1e4) / 1e4);
  let Smesh = 0;
  const baseSeen = new Set(), baseOf = new Array(src.length).fill(0);
  for (const s of src) {
    if (s.skip) continue;
    const { lo, hi } = s.box;
    const first = !s.meshKey || !baseSeen.has(s.meshKey);
    if (s.meshKey) baseSeen.add(s.meshKey);
    const pv = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
    const before = Smesh;
    Smesh += lineCost(`mesh p src="x#${s.name}" size=${[0, 1, 2].map((j) => fmt(hi[j] - lo[j])).join(',')} pivot=${pv.map(fmt).join(',')} at=${pv.map(fmt).join(',')} mat=m`) + (first ? meshPrice(s.tris, s.role, k) : 0);
    baseOf[s.i] = Smesh - before;
  }
  lap('S_mesh');
  const S = D.total + Lmesh + Rsrc + Rrecon + Rvol;
  // 按角色分开（roles.mjs）：重建一侧（描述长度、网格引用、R_recon）按物体的 ~role，源一侧（R_src、基线 S_mesh）按源部件的角色；
  // 每个角色里同样算解释率 1 − S / S_mesh。没归属的描述长度（unattributed）不分，所以各角色的 S 加起来比总分少这一点
  const roleOf = nodeRoles(result), byRole = {};
  const R = (r) => (byRole[r] ??= { S: 0, L_stmt: 0, L_mesh: 0, R_src: 0, R_recon: 0, R_vol: 0, S_mesh: 0, objects: 0, sources: 0 });
  for (const p of per.values()) { const b = R(roleOf(p.path)); b.L_stmt += p.stmt; b.L_mesh += p.mesh; b.R_recon += p.rRecon; b.R_vol += p.rVol; b.objects++; }
  src.forEach((x, i) => { if (x.skip) return; const b = R(x.role ?? 'structure'); b.R_src += srcRes[i].c; b.S_mesh += baseOf[i]; b.sources++; });
  for (const b of Object.values(byRole)) {
    b.S = b.L_stmt + b.L_mesh + b.R_src + b.R_recon + b.R_vol;
    b.explain = b.S_mesh ? +(1 - b.S / b.S_mesh).toFixed(4) : null;
    for (const k of ['S', 'L_stmt', 'L_mesh', 'R_src', 'R_recon', 'R_vol', 'S_mesh']) b[k] = +b[k].toFixed(2);
  }
  const objects = [...per.values()].map((p) => ({ ...p, total: +(p.stmt + p.mesh + p.rSrc + p.rRecon + p.rVol).toFixed(3), stmt: +p.stmt.toFixed(2), mesh: +p.mesh.toFixed(2), rSrc: +p.rSrc.toFixed(3), rRecon: +p.rRecon.toFixed(3), rVol: +p.rVol.toFixed(3), meanErr: +(p.meanErr * u).toFixed(5), maxErr: +(p.maxErr * u).toFixed(5) }));
  const r3 = (x) => +x.toFixed(2);
  return {
    S: r3(S), L_stmt: r3(D.total), unattributed: r3(D.total - attributed), droppedLines: D.dropped, L_mesh: r3(Lmesh), R_src: r3(Rsrc), R_recon: r3(Rrecon), R_vol: r3(Rvol), S_mesh: r3(Smesh), explain: +(1 - S / Smesh).toFixed(4),
    byRole, consts: k0, objects, sources: srcOut,
    worst: [...objects].sort((a, b) => (b.mesh + b.rSrc + b.rRecon + b.rVol) - (a.mesh + a.rSrc + a.rRecon + a.rVol)).slice(0, 20).map((o) => ({ path: o.path, cost: +(o.mesh + o.rSrc + o.rRecon + o.rVol).toFixed(2), meanErr: o.meanErr, mesh: o.mesh > 0 })),
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
//   group：同一个顶层语句里其余物体的表面积与体积（groupContext）——全场评分的 R_recon、R_vol 以顶层语句为单位计权、内部分摊，
//   阵列里的一个成员只分到一小份权重；不给时候选物体自己是一个顶层语句
//   whole：near[0] 只是一个更大的源部件里的一块（逆向把大部件当小场景拆开写时），whole.area 是整个部件的表面积——
//   全场评分里这个部件是一个源部件、写出来的组是一个顶层语句，各一份权重；这一块按面积分到其中一份（源侧与重建侧都是）
export function neighborhoodScorer({ parts, near, others, reconColors, consts = {}, sharedMeshes = new Set(), group = null, whole = null }) {
  const k0 = { ...SCORE_DEFAULTS, ...consts }, k = inScene(k0);
  const srcColors = new Set(parts.map((p) => colorKey(p.material?.color)));
  const ents = near.map((i, m) => {
    const p = parts[i], color = p.material?.color, a = areaOf(p.tris);
    const w = m === 0 && whole?.area > a ? k.cRes * Math.log2(1 + whole.area / (k.delta * k.delta)) * (a / whole.area) : k.cRes * Math.log2(1 + a / (k.delta * k.delta));
    return { i, color, c: colorKey(color), pts: flatPoints(sourceSamples(p.tris, i, k.samples)), w, rest: new Map() };
  });
  if (whole && !group) group = { area: Math.max(0, whole.area - areaOf(parts[near[0]].tris)), vol: 0 };
  const otherSurf = others.length ? surfaces(others) : null;
  const srcSurf = surfaces(near.map((i) => ({ pos: trisToArray(parts[i].tris), color: parts[i].material?.color })));
  // 一批点集各自到一组表面里某种颜色（same）或全部表面的距离，封顶 limit（一个数，或逐点的数组）：
  //   sets [{ pts（扁平）, c, same, pen, limit }] → 每项 Float64Array。逐点的规则：limit − pen ≤ 0 或没碰到表面时取 limit，
  //   否则 min(距离 + pen, limit)（点多时分给 worker 线程，结果与逐点查询相同）
  const distMany = (surf, sets) => {
    const items = [], at = sets.map(({ pts, c, same, pen, limit }) => {
      const g = surf && (same ? surf.byColor.get(c) : surf.all), n = pts.length / 3;
      if (!g || !n) return null;
      if (typeof limit === 'number') return limit - pen > 0 ? items.push({ q: g.q, pts, max: limit - pen }) - 1 : null;
      const maxs = sharedArray(n);
      for (let j = 0; j < n; j++) maxs[j] = limit[j] - pen;
      return items.push({ q: g.q, pts, maxs }) - 1;
    });
    const res = closestMany(items);
    return sets.map(({ pts, pen, limit }, m) => {
      const n = pts.length / 3, out = new Float64Array(n), r = at[m] == null ? null : res[at[m]];
      for (let j = 0; j < n; j++) {
        const lim = typeof limit === 'number' ? limit : limit[j];
        out[j] = !r || lim - pen <= 0 || r.t[j] < 0 ? lim : Math.min(r.d[j] + pen, lim);
      }
      return out;
    });
  };
  return (objs, lines = []) => {
    const recon = objs.filter((o) => o.pos.length);
    const colorsNow = new Set([...reconColors, ...recon.map((o) => colorKey(o.color))]);
    const candSurf = recon.length ? surfaces(recon) : null;
    // R_src：邻域里的每个源部件
    let Rsrc = 0, own = null;
    const modes = ents.map((e) => { const same = e.color != null && colorsNow.has(e.c); return { e, c: e.c, pts: e.pts, same, pen: !same && e.color != null ? k.delta : 0, mode: same ? 'same' : 'all' }; });
    // 邻居源点到“其余物体”的距离：每种模式只算一次
    const miss = modes.filter((m) => !m.e.rest.has(m.mode));
    distMany(otherSurf, miss.map((m) => ({ ...m, limit: k.dMax }))).forEach((d, j) => miss[j].e.rest.set(miss[j].mode, d));
    const ds = distMany(candSurf, modes.map((m) => ({ ...m, limit: m.e.rest.get(m.mode) })));
    modes.forEach(({ e }, j) => {
      const res = aggregate(ds[j], k);
      Rsrc += e.w * res.r;
      own ??= res;
    });
    // R_recon：候选物体 → 邻域里的源部件（离它更远的源部件在 dMax 之外，不影响距离）
    let A = 0, acc = 0;
    const objSets = recon.map((o) => {
      const tris = triList(o.pos), c = colorKey(o.color), same = o.color != null && srcColors.has(c);
      return { area: areaOf(tris), c, same, pen: !same && o.color != null ? k.delta : 0, pts: flatPoints(samplePoints(tris, k.samples, seedOf(o.path ?? ''))), limit: k.dMax };
    });
    distMany(srcSurf, objSets).forEach((d, j) => { const res = aggregate(d, k); A += objSets[j].area; acc += objSets[j].area * res.r; });
    const GA = A + (group?.area ?? 0);
    const Rrecon = A > 0 ? k.cRes * Math.log2(1 + GA / (k.delta * k.delta)) * (acc / GA) : 0;
    // R_vol：候选物体的内部 → 邻域里的源部件（同全场：一组候选共享一个体积权重，内部按体积分摊）
    let V = 0, accV = 0, wrongV = 0;
    for (const o of recon) { if (o.mesh) continue; const inner = interiorSamples(o.pos, k, seedOf(o.path ?? '')); if (inner) { const st = volumeStats(inner.pts, srcSurf.all?.q, k); V += inner.vol; accV += inner.vol * st.r; wrongV += inner.vol * st.wrong; } }
    const GV = V + (group?.vol ?? 0);
    const Rvol = V > 0 ? k.cRes * Math.log2(1 + GV / k.delta ** 3) * (accV / GV) : 0;
    // 网格引用（现在的写法可能就是一块网格）：c_mesh × log2(1 + 三角形数)，与全场的 L_mesh 一样
    const seen = new Set(sharedMeshes);
    const L = lines.reduce((s, l) => s + lineCost(l), 0) + recon.reduce((s, o) => { const key = o.mesh && (o.mesh.key ?? o.mesh.src); if (!o.mesh || seen.has(key)) return s; seen.add(key); return s + meshPriceOf(o.mesh, k); }, 0);
    const r3 = (x) => +x.toFixed(2);
    // volWrong：候选的实体里错填（源模型那里是空的）的体积比例
    return { S: r3(L + Rsrc + Rrecon + Rvol), L: r3(L), R_src: r3(Rsrc), R_recon: r3(Rrecon), R_vol: r3(Rvol), volWrong: V > 0 ? +(wrongV / V).toFixed(4) : 0, meanErr: +((own?.mean ?? 0) * k0.unit).toFixed(4), maxErr: +((own?.max ?? 0) * k0.unit).toFixed(4) };
  };
}

// 邻域评分的 group：一组重建物体（同一个顶层语句里、候选以外的那些）的表面积与体积，按全场评分的算法
// （体积只算会撒内部采样点的：不是网格引用、不薄）
export function groupContext(objs, consts = {}) {
  const k = inScene({ ...SCORE_DEFAULTS, ...consts });
  let area = 0, vol = 0;
  for (const o of objs) {
    if (!o.pos.length) continue;
    const st = solidStats(o.pos);
    area += st.area;
    if (!o.mesh && o.pos.length >= 36 && st.vol > 0 && st.vol / st.area >= k.delta) vol += st.vol;
  }
  return { area, vol };
}

// 一个物体的误差落在哪里：它表面上离源模型最远的采样点（重建 → 源），以及它附近的源表面上离重建最远的采样点（源 → 重建）。
// 与评分同一套距离（同材质优先、多计 δ、封顶 dMax）；坐标是场景坐标，距离按米。用来定位“残差还剩一些，但不知道在哪”
export function pointErrors({ result, sourceParts, path, consts = {}, top = 10 }) {
  const k0 = { ...SCORE_DEFAULTS, ...consts }, k = inScene(k0), u = k0.unit;
  const recon = sceneObjects(result, { sourceParts }).filter((o) => o.pos.length);
  const mine = recon.filter((o) => o.path === path || o.path.startsWith(path + '.'));
  if (!mine.length) return null;
  const src = sourceParts.map((p, i) => ({ i, name: p.uid ?? p.name ?? p.from ?? `part_${i}`, tris: p.tris, pos: trisToArray(p.tris), color: p.material?.color }));
  const fix = (p) => p.map((x) => +x.toFixed(3));
  const fwd = nearest(surfaces(src), k), out1 = [];
  for (const o of mine) { const f = fwd(o.color); for (const p of samplePoints(triList(o.pos), k.samples, seedOf(o.path))) { const [d] = f(p); if (d > k.delta) out1.push({ at: fix(p), err: +(d * u).toFixed(4), object: o.path }); } }
  // 源 → 重建：只看这个物体附近（包络外扩 dMax）的源部件
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const o of mine) for (let i = 0; i < o.pos.length; i += 3) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], o.pos[i + j]); hi[j] = Math.max(hi[j], o.pos[i + j]); }
  const inside = (p) => [0, 1, 2].every((j) => p[j] >= lo[j] - k.dMax && p[j] <= hi[j] + k.dMax);
  const back = nearest(surfaces(recon), k), out2 = [];
  for (const s of src) {
    if (!s.tris.some((t) => t.some(inside))) continue;
    const f = back(s.color);
    for (const p of sourceSamples(s.tris, s.i, k.samples)) { if (!inside(p)) continue; const [d, owner] = f(p); if (d > k.delta) out2.push({ at: fix(p), err: +(d * u).toFixed(4), source: s.name, nearest: owner >= 0 ? recon[owner].path : null }); }
  }
  const pick = (xs) => xs.sort((a, b) => b.err - a.err).slice(0, top);
  return { delta: k0.delta, reconToSource: { over: out1.length, worst: pick(out1) }, sourceToRecon: { over: out2.length, worst: pick(out2) } };
}

