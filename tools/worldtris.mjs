// 编译结果 → 每个物体的世界三角形（离屏渲染与自评分数共用）。
// mesh 引用用源模型里对应部件的真实三角形：源部件已经在世界坐标里，按 W · T(−pivot) 搬到引用处（与预览器 addMeshRef 一致）；
// 找不到源部件时用外包络盒代替，并标记 placeholder。
// 几何模块要在 Node 的解析钩子之后加载（three-bvh-csg 改用 ES 源码，见 bin/node-hooks.mjs），所以动态 import
import '../bin/node-hooks.mjs';
const { itemGeometry, makeEvaluator } = await import('../src/geometry.js');

const BOX = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [1, 0, 1], [0, 0, 1], [0, 1, 1], [1, 1, 1],
  [0, 0, 0], [0, 1, 1], [0, 0, 1], [0, 0, 0], [0, 1, 0], [0, 1, 1], [1, 0, 0], [1, 0, 1], [1, 1, 1], [1, 0, 0], [1, 1, 1], [1, 1, 0],
  [0, 0, 0], [1, 0, 1], [1, 0, 0], [0, 0, 0], [0, 0, 1], [1, 0, 1], [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 0], [1, 1, 1], [0, 1, 1],
];

// 源部件按名字查：节点名（L0）、part_NNNN（L1）、合并网格的分量 merged_i#k（L2）
export function sourceIndex(sourceParts) {
  const m = new Map();
  // 唯一标识（名字@k）优先；只给名字时取第一个同名的
  // 合并网格的分量另有一个名字：部件文件（parts.glb）里的节点名，# 换成 ~
  for (const p of sourceParts) { if (p.uid) m.set(p.uid, p); if (p.name && !m.has(p.name)) m.set(p.name, p); if (p.from) { m.set(p.from, p); m.set(p.from.replace(/#/g, '~'), p); } }
  return m;
}

export function trisToArray(tris) {
  const a = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => t.forEach((v, j) => a.set(v, i * 9 + j * 3)));
  return a;
}

export function sceneObjects(result, { sourceParts = [] } = {}) {
  const ev = makeEvaluator();
  const byName = sourceIndex(sourceParts);
  const out = [];
  for (const it of result.items) {
    const { R, t } = it.world ?? { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };
    const xf = (v, pv = [0, 0, 0]) => { const p = [v[0] - pv[0], v[1] - pv[1], v[2] - pv[2]]; return [0, 1, 2].map((k) => R[k][0] * p[0] + R[k][1] * p[1] + R[k][2] * p[2] + t[k]); };
    let pos, mesh = null;
    if (it.kind === 'solid' && it.geom.type === 'mesh') {
      const name = String(it.geom.src).split('#').pop();
      const sp = byName.get(name);
      if (sp) {
        pos = new Float32Array(sp.tris.length * 9);
        sp.tris.forEach((tri, i) => tri.forEach((v, j) => pos.set(xf(v, it.geom.pivot), i * 9 + j * 3)));
        // key：网格数据的身份——享元的同一个网格（引擎导出的 mesh 编号）算一份，否则是这个源部件自己
        mesh = { src: name, tris: sp.tris.length, key: sp.mesh != null ? `m:${sp.mesh}` : name, srcTris: sp.tris, role: sp.role ?? null };
      } else {
        const { w, h, d } = it.geom;
        pos = new Float32Array(BOX.length * 3);
        BOX.forEach((c, i) => pos.set(xf([(c[0] - 0.5) * w, c[1] * h, (c[2] - 0.5) * d]), i * 3));
        mesh = { src: name, tris: 0, placeholder: true };
      }
    } else {
      let g = itemGeometry(it, ev);
      if (g.index) g = g.toNonIndexed();
      pos = Float32Array.from(g.attributes.position.array);
    }
    out.push({ path: it.path, pos, color: it.material?.color ?? '#c9c9c9', mesh });
  }
  return out;
}
