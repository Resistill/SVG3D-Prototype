// 把 SVG3D 场景导出成 GLB，作为逆向管线的“源模型”。
// 三个难度：
//   L0：每个对象一个节点，节点名就是对象路径（相当于源模型有完整命名与拆分）
//   L1：抹去名字、打乱顺序（拆分还在，命名没了）
//   L2：同一材质合并成一个网格（命名和拆分都没了，需要几何分割）
import '../bin/node-hooks.mjs';
import { Document, NodeIO } from '@gltf-transform/core';

const { itemGeometry, makeEvaluator } = await import('../src/geometry.js');
const { compile } = await import('../src/s3d.js');

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hexToLinear(hex) {
  let h = String(hex ?? '#c9c9c9').replace('#', '');
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  return [0, 2, 4].map((i) => srgbToLinear(parseInt(h.slice(i, i + 2), 16) / 255));
}
// 稳定的伪随机顺序（L1 打乱用），只依赖名字
function hashStr(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

export function sceneToGLB(src, { file = null, resolve = null, level = 'L0' } = {}) {
  const r = compile(src, { file, resolve });
  if (r.errors.length) throw new Error(`源场景有错误：\n${r.errors.map((e) => `  第 ${e.line} 行 ${e.message}`).join('\n')}`);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('scene');
  const mats = new Map();
  const materialOf = (m) => {
    const key = JSON.stringify([m.name ?? null, m.color, m.metal ?? 0.05, m.rough ?? 0.78]);
    if (!mats.has(key)) {
      mats.set(key, doc.createMaterial(m.name ?? `color_${String(m.color ?? '#c9c9c9').replace('#', '')}`)
        .setBaseColorFactor([...hexToLinear(m.color), 1]).setMetallicFactor(m.metal ?? 0.05).setRoughnessFactor(m.rough ?? 0.78));
    }
    return mats.get(key);
  };
  const ev = makeEvaluator();
  const parts = [];
  const skipped = [];
  for (const item of r.items) {
    if (item.kind === 'solid' && item.geom.type === 'mesh') { skipped.push(item.path); continue; }
    let g = itemGeometry(item, ev);
    if (g.index) g = g.toNonIndexed();
    parts.push({ path: item.path, material: item.material, pos: g.attributes.position.array, nrm: g.attributes.normal.array });
  }
  const addNode = (name, pos, nrm, material) => {
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer))
      .setMaterial(materialOf(material));
    scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  };
  if (level === 'L2') {
    const byMat = new Map();
    for (const p of parts) {
      const k = JSON.stringify(p.material);
      if (!byMat.has(k)) byMat.set(k, { material: p.material, pos: [], nrm: [] });
      const b = byMat.get(k);
      b.pos.push(p.pos); b.nrm.push(p.nrm);
    }
    let i = 0;
    for (const b of byMat.values()) {
      const cat = (arrs) => { const out = new Float32Array(arrs.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
      addNode(`merged_${i++}`, cat(b.pos), cat(b.nrm), b.material);
    }
  } else {
    const list = level === 'L1' ? [...parts].sort((a, b) => hashStr(a.path) - hashStr(b.path)) : parts;
    list.forEach((p, i) => addNode(level === 'L1' ? `part_${String(i).padStart(4, '0')}` : p.path, p.pos, p.nrm, p.material));
  }
  return { doc, io: new NodeIO(), parts: parts.length, skipped };
}
