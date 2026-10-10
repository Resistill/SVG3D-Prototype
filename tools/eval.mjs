// 闭环评测：把原始描述与逆向得到的描述各自编译，按世界包围盒 IoU 一一匹配对象，然后比较：
//   几何：匹配率、平均 IoU、形状种类正确率（只统计能用基本体表达的原始对象）
//   关系：空间事实的精确率 / 召回率 / F1（按匹配把逆向结果的对象名换成原始的名字再比）
//   描述质量：坐标依赖率（用 at= 定位的物体比例，越低越好）、语句数比
import { compile } from '../src/s3d.js';

const iou = (a, b) => {
  const ov = [0, 1, 2].map((k) => Math.max(0, Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k])));
  const v = (x) => [0, 1, 2].reduce((s, k) => s * Math.max(1e-9, x.max[k] - x.min[k]), 1);
  const inter = ov[0] * ov[1] * ov[2];
  return inter / (v(a) + v(b) - inter);
};
// 原始对象的形状类别
function classOf(item) {
  if (item.kind === 'csg') return 'complex';
  const g = item.geom;
  switch (g.type) {
    case 'box': case 'beam': return 'box';
    case 'wedge': return 'wedge';
    case 'sphere': return 'sphere';
    case 'cyl': return Math.abs(g.r1 - g.r2) < 1e-6 ? 'cyl' : 'cone';
    case 'rod': return 'cyl';
    case 'mesh': return 'mesh';
    default: return 'complex'; // revolve / sweep / steps
  }
}

function objectsOf(r) {
  const boxes = new Map(r.nodes.map((n) => [n.path, n.box]));
  return r.items.map((it) => ({ path: it.path, cls: classOf(it), box: boxes.get(it.path) })).filter((o) => o.box);
}

export function evaluate(origSrc, reconSrc, opts = {}) {
  const A = compile(origSrc, opts.orig ?? {}), B = compile(reconSrc, opts.recon ?? {});
  const oa = objectsOf(A), ob = objectsOf(B);
  // 贪心匹配：IoU 从高到低
  const pairs = [];
  for (const a of oa) for (const b of ob) { const s = iou(a.box, b.box); if (s > 0.3) pairs.push([s, a, b]); }
  pairs.sort((x, y) => y[0] - x[0]);
  const mA = new Map(), mB = new Map();
  for (const [s, a, b] of pairs) if (!mA.has(a.path) && !mB.has(b.path)) { mA.set(a.path, { b, s }); mB.set(b.path, a.path); }
  const fittable = oa.filter((a) => ['box', 'wedge', 'sphere', 'cyl', 'cone'].includes(a.cls));
  const kindOk = fittable.filter((a) => mA.get(a.path) && mA.get(a.path).b.cls === a.cls).length;
  const complex = oa.filter((a) => a.cls === 'complex');
  const complexAsMesh = complex.filter((a) => mA.get(a.path)?.b.cls === 'mesh').length;
  const confusion = {};
  for (const a of fittable) { const k = `${a.cls}→${mA.get(a.path)?.b.cls ?? '无'}`; confusion[k] = (confusion[k] ?? 0) + 1; }
  // 关系
  const rels = ['on', 'against', 'inside', 'touching', 'intersects'];
  const key = (f) => `${f.rel}|${[f.a, f.b].join('|')}`;
  const truth = new Set(A.facts.map(key));
  const mapped = new Set(B.facts.map((f) => ({ ...f, a: mB.get(f.a), b: mB.get(f.b) })).filter((f) => f.a && f.b).map(key));
  const prf = (filter) => {
    const t = [...truth].filter(filter), m = [...mapped].filter(filter);
    const tp = m.filter((x) => truth.has(x)).length;
    const p = m.length ? tp / m.length : 1, r = t.length ? tp / t.length : 1;
    return { truth: t.length, found: m.length, precision: +p.toFixed(3), recall: +r.toFixed(3), f1: +(p + r ? (2 * p * r) / (p + r) : 0).toFixed(3) };
  };
  const leafLines = reconSrc.split('\n').filter((l) => /^\s*(box|cyl|cone|sphere|wedge|mesh|revolve|span|sweep|pipe)\s/.test(l));
  const lines = (s) => s.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
  return {
    errors: { orig: A.errors.length, recon: B.errors.length },
    objects: { orig: oa.length, recon: ob.length, matched: mA.size, meanIoU: +([...mA.values()].reduce((s, x) => s + x.s, 0) / (mA.size || 1)).toFixed(3) },
    kinds: { fittable: fittable.length, correct: kindOk, accuracy: +(kindOk / (fittable.length || 1)).toFixed(3), complex: complex.length, complexAsMesh, confusion },
    facts: { all: prf(() => true), ...Object.fromEntries(rels.map((r) => [r, prf((x) => x.startsWith(r + '|'))])), onAgainst: prf((x) => /^(on|against)\|/.test(x)) },
    description: {
      // 只算用世界坐标定位的（at=数字）；at=某物[u,v,w] 是相对锚点，算关系
      coordinateRatio: +(leafLines.filter((l) => /\sat=[-\d(.]/.test(l)).length / (leafLines.length || 1)).toFixed(3),
      anchorRatio: +(leafLines.filter((l) => /\sat=[\p{L}_]/u.test(l)).length / (leafLines.length || 1)).toFixed(3),
      statementRatio: +(lines(reconSrc) / lines(origSrc)).toFixed(3),
    },
  };
}
