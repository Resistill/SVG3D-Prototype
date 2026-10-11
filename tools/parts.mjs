// 源部件：读取 GLB（每个节点的每个图元一个部件，三角形变换到世界坐标）、合并网格按连通分量拆开、表面采样。
// 这些是逆向与评分共用、很少改动的部分；源模型一侧的磁盘缓存（srccache.mjs）按这个文件的内容失效
import { NodeIO } from '@gltf-transform/core';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const hex = (rgb) => '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, linearToSrgb(c))) * 255).toString(16).padStart(2, '0')).join('');

export function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909) ^ (s += 0x9e3779b9)) >>> 0) / 4294967296; }

// ───────── 1. 读取部件 ─────────
export async function readParts(path, opts = {}) {
  return partsOfDocument(await new NodeIO().read(path), opts);
}
export function partsOfDocument(doc, { split = 'auto' } = {}) {
  const parts = [];
  // 享元线索：记下每个部件用的是哪个网格（及其中第几个图元）、节点的世界矩阵
  const meshIds = new Map(doc.getRoot().listMeshes().map((m, i) => [m, i]));
  for (const scene of doc.getRoot().listScenes()) scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const M = node.getWorldMatrix(); // 列主序
    const tf = (p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]];
    mesh.listPrimitives().forEach((prim, pk) => {
      const pos = prim.getAttribute('POSITION').getArray(), idx = prim.getIndices()?.getArray();
      const tris = [];
      const vert = (i) => tf([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
      const n = idx ? idx.length : pos.length / 3;
      for (let i = 0; i < n; i += 3) tris.push([vert(idx ? idx[i] : i), vert(idx ? idx[i + 1] : i + 1), vert(idx ? idx[i + 2] : i + 2)]);
      const mat = prim.getMaterial();
      const material = mat ? { name: mat.getName() || null, color: hex(mat.getBaseColorFactor().slice(0, 3)), metal: mat.getMetallicFactor(), rough: mat.getRoughnessFactor() } : { name: null, color: '#c9c9c9' };
      parts.push({ name: node.getName() || null, tris, material, mesh: `${meshIds.get(mesh)}:${pk}`, matrix: Array.from(M) });
    });
  });
  // 来源标识：节点名常常不唯一（同一分区里同一种网格的多个实例同名）——重名的第 k 个写成 名字@k
  const count = new Map(), seen = new Map();
  for (const p of parts) if (p.name) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  for (const p of parts) if (p.name) { if (count.get(p.name) > 1) { const k = (seen.get(p.name) ?? 0) + 1; seen.set(p.name, k); p.uid = `${p.name}@${k}`; } else p.uid = p.name; }
  const doSplit = split === 'components' || (split === 'auto' && parts.some((p) => /^merged_/.test(p.name ?? '')));
  return doSplit ? parts.flatMap(splitComponents) : parts;
}

// 按共享顶点（位置焊接）把三角形分成连通分量
export function splitComponents(part) {
  const key = (p) => p.map((x) => Math.round(x * 1e4)).join(',');
  const parent = part.tris.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const owner = new Map();
  part.tris.forEach((t, i) => t.forEach((v) => {
    const k = key(v);
    if (owner.has(k)) { const a = find(i), b = find(owner.get(k)); if (a !== b) parent[a] = b; } else owner.set(k, i);
  }));
  const groups = new Map();
  part.tris.forEach((t, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  return [...groups.values()].map((tris, k) => ({ name: null, tris, material: part.material, from: `${part.uid ?? part.name}#${k}` }));
}

// 三角形的顶点按 toFixed(4) 去重，保留第一次出现的。逐个算字符串键很慢：先按精确数值去重（同一个顶点在相邻的
// 三角形里重复出现，数值完全相同，键也一定相同），只给第一次出现的数值算键——结果与逐个算键相同
const F64 = new Float64Array(1), U32 = new Uint32Array(F64.buffer);
export const bitsHash = (h, x) => { F64[0] = x; return Math.imul(Math.imul(h ^ U32[0], 16777619) ^ U32[1], 16777619); };
export function uniqueVertices(tris) {
  const n = tris.length * 3;
  let cap = 16;
  while (cap < 2 * n) cap *= 2;
  const table = new Int32Array(cap).fill(-1), vs = new Array(n);
  const out = [], seen = new Set();
  let m = 0;
  for (const t of tris) for (const v of t) {
    const x = v[0], y = v[1], z = v[2];
    let h = (bitsHash(bitsHash(bitsHash(2166136261, x), y), z) >>> 0) & (cap - 1), dup = false;
    for (let j; (j = table[h]) >= 0; h = (h + 1) & (cap - 1)) { const w = vs[j]; if (w[0] === x && w[1] === y && w[2] === z) { dup = true; break; } }
    if (dup) continue;
    table[h] = m; vs[m++] = v;
    const k = v.map((c) => c.toFixed(4)).join();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}
export function samplePoints(tris, n, seed) {
  const areas = tris.map(([a, b, c]) => len(cross(sub(b, a), sub(c, a))) / 2);
  const total = areas.reduce((s, x) => s + x, 0) || 1;
  const pts = uniqueVertices(tris);
  const r = rng(seed);
  const cum = [];
  areas.reduce((s, x, i) => (cum[i] = s + x), 0);
  for (let i = 0; i < n; i++) {
    const x = r() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < x) lo = m + 1; else hi = m; }
    const [a, b, c] = tris[lo];
    let u = r(), v = r();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    pts.push(add(a, add(scl(sub(b, a), u), scl(sub(c, a), v))));
  }
  return pts;
}

// 源部件的表面采样（评分用）：第 i 个部件的种子是 i + 1
export const sourceSamples = (tris, i, n) => samplePoints(tris, n, i + 1);

// 源部件 ↔ 磁盘缓存（srccache.mjs 的 { meta, blobs }）：三角形放进一个 Float64Array，其余字段（名字、材质、网格、矩阵、
// 来源、旁路表的 meta）按 JSON 存（−0、NaN、±Infinity 另外标出来，JSON 本身会把它们写成 0 / null）。
// 恢复出的部件与读入的逐字段相同（字段顺序也相同），三角形的每个顶点仍是独立的数组
const special = (v) => typeof v === 'number' && (Object.is(v, -0) || !Number.isFinite(v));
const encode = (x) => JSON.stringify(x, (k, v) => (special(v) ? { $n: Object.is(v, -0) ? '-0' : String(v) } : v));
const decode = (s) => JSON.parse(s, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$n === 'string' ? Number(v.$n) : v));
export function packParts(parts) {
  const n = parts.reduce((s, p) => s + p.tris.length, 0), tris = new Float64Array(n * 9);
  let o = 0;
  for (const p of parts) for (const t of p.tris) for (const v of t) { tris[o++] = v[0]; tris[o++] = v[1]; tris[o++] = v[2]; }
  return { meta: encode(parts.map((p) => ({ ...p, tris: p.tris.length }))), blobs: { tris } };
}
export function unpackParts({ meta, blobs: { tris } }) {
  let o = 0;
  return decode(meta).map((m) => {
    const p = { ...m }, ts = new Array(m.tris);
    for (let k = 0; k < m.tris; k++, o += 9) ts[k] = [[tris[o], tris[o + 1], tris[o + 2]], [tris[o + 3], tris[o + 4], tris[o + 5]], [tris[o + 6], tris[o + 7], tris[o + 8]]];
    p.tris = ts;
    return p;
  });
}
