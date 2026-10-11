// 表面集合（评分的最近距离查询）：若干物体按材质颜色分组，每组与全部各建一棵树（MeshBVH 建，nearest.mjs 查）。
// 源模型一侧的表面只取决于源部件：树的节点与重排后的索引可以存进磁盘缓存（srccache.mjs），恢复时不必重新建树。
// 源部件 → 表面的做法（sourceSurfaces）也在这里：缓存按这个文件的内容失效
import { MeshBVH } from 'three-mesh-bvh';
import { BufferGeometry, BufferAttribute } from 'three';
import { nearestData, nearestQuery } from './nearest.mjs';
import { trisToArray } from './worldtris.mjs';

export const colorKey = (c) => String(c ?? '').toLowerCase();

// 把若干物体（{ pos, color }）合成一棵树，记住每个三角形属于哪个物体（ids：物体的编号）；
// saved：以前存下的 { nodes, index }（同样的物体、同样的顺序），给了就不再建树
function bvhOf(objs, ids = objs.map((_, k) => k), saved = null) {
  const n = objs.reduce((s, o) => s + o.pos.length, 0);
  const pos = new Float32Array(n), owner = new Int32Array(n / 9);
  let off = 0;
  objs.forEach((o, k) => { pos.set(o.pos, off); owner.fill(ids[k], off / 9, (off + o.pos.length) / 9); off += o.pos.length; });
  if (!n) return null;
  let nodes, index;
  if (saved) ({ nodes, index } = saved);
  else {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    const bvh = new MeshBVH(g);
    if (bvh._roots.length !== 1) throw new Error('surfaces: 只支持没有分组的几何');
    nodes = bvh._roots[0]; index = g.index.array;
  }
  return { q: nearestQuery(nearestData(nodes, index, pos)), owner, nodes, index };
}

// { byColor: Map(颜色 → 树), all: 树 }；saved 是 loadSurfaces 的结果
export function surfaces(objs, saved = null) {
  const groups = new Map();
  objs.forEach((o, k) => { const c = colorKey(o.color); if (!groups.has(c)) groups.set(c, []); groups.get(c).push(k); });
  // 存下的树按分组的序号对应；颜色对不上（不该发生）就重新建
  const byColor = new Map([...groups].map(([c, ids], j) => [c, bvhOf(ids.map((k) => objs[k]), ids, saved?.colors[j] === c ? saved.byColor[j] : null)]));
  return { byColor, all: bvhOf(objs, undefined, saved?.all ?? null) };
}

// 源部件的表面（按部件顺序；颜色取材质颜色）
export const sourceSurfaces = (parts, saved = null) => surfaces(parts.map((p) => ({ pos: trisToArray(p.tris), color: p.material?.color })), saved);

// 存取：{ meta, blobs }（srccache 的格式）。颜色组的顺序就是 surfaces 里分组的顺序（物体顺序不变时相同），恢复时按序号对应
export function saveSurfaces(s) {
  const trees = [...s.byColor.values(), s.all], blobs = {};
  trees.forEach((t, j) => { if (t) { blobs[`n${j}`] = new Uint8Array(t.nodes instanceof Uint8Array ? t.nodes : new Uint8Array(t.nodes)); blobs[`i${j}`] = Uint32Array.from(t.index); } });
  return { meta: { colors: [...s.byColor.keys()], present: trees.map(Boolean) }, blobs };
}
export function loadSurfaces({ meta, blobs }) {
  const tree = (j) => (meta.present[j] ? { nodes: blobs[`n${j}`], index: blobs[`i${j}`] } : null);
  return { colors: meta.colors, byColor: meta.colors.map((_, j) => tree(j)), all: tree(meta.colors.length) };
}
