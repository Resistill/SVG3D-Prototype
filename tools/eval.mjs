// 闭环评测：把原始描述与逆向得到的描述各自编译，按世界包围盒 IoU 一一匹配对象，然后比较：
//   几何：匹配率、平均 IoU、形状种类正确率（只统计能用基本体表达的原始对象）
//   关系：空间事实的精确率 / 召回率 / F1（按匹配把逆向结果的对象名换成原始的名字再比）
//   描述质量：坐标依赖率（用 at= 定位的物体比例，越低越好）、语句数比
//   语义：把通用语义库（lib/semantics.s3d）同时附加到两边，比较每个概念识别出的成员（按匹配换名后的 P / R / F1）
import { readFileSync } from 'node:fs';
import { compile } from '../src/s3d.js';

export const SEMANTICS = readFileSync(new URL('../lib/semantics.s3d', import.meta.url), 'utf8');

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

// 对象是否被压缩构造覆盖：在阵列实例里（路径中有数字段）或是镜像/旋转生成的副本
function objectsOf(r) {
  const byPath = new Map(r.nodes.map((n) => [n.path, n]));
  // 镜像：在 mirror 生成的副本里（mirror X of=… 的 X 之下，或 mirror 容器的 .mirrored 之下）；
  // rotate 生成的副本算作阵列（旋转对称）
  const mirrorRoots = r.nodes.filter((n) => /^mirror/.test(n.kind)).map((n) => n.path);
  const out = r.items.map((it) => {
    const n = byPath.get(it.path);
    const rotRoots = r.nodes.filter((x) => x.kind === 'rotate').map((x) => x.path);
    const array = /(^|\.)\d+(\.|$)|\.r\d+(\.|$)/.test(it.path) || rotRoots.some((g) => it.path.startsWith(g + '.'));
    const mirror = mirrorRoots.some((g) => (it.path === g || it.path.startsWith(g + '.')) && !/^mirror$/.test(byPath.get(g).kind)) || /\.mirrored(\.|$)/.test(it.path);
    return { path: it.path, cls: classOf(it), box: n?.tight ?? n?.box, array, mirror };
  }).filter((o) => o.box);
  // 镜像没有方向：哪一侧是原件只是写法，所以副本的来源也算处在镜像关系里
  const sources = new Set(out.filter((o) => o.mirror).map((o) => byPath.get(o.path)?.of).filter(Boolean));
  for (const o of out) if (sources.has(o.path)) o.mirror = true;
  return out;
}

export function evaluate(origSrc, reconSrc, opts = {}) {
  // 语义库附加在末尾：同名概念以后写的为准，所以两边用的是同一套定义
  const lib = opts.semantics ?? SEMANTICS;
  const withLib = (src) => (lib ? `${src}\n${lib}` : src);
  const A = compile(withLib(origSrc), opts.orig ?? {}), B = compile(withLib(reconSrc), opts.recon ?? {});
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
  // 复杂形状被描述成扫掠体 / 旋转体（逆向拟合出的管道等）
  const complexDescribed = complex.filter((a) => mA.get(a.path)?.b.cls === 'complex').length;
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
  // 压缩召回：原始里被阵列 / 镜像覆盖的对象，在逆向结果里是否也被同类构造覆盖
  const recall = (flag) => {
    const t = oa.filter((a) => a[flag]);
    const hit = t.filter((a) => mA.get(a.path)?.b[flag]).length;
    return { orig: t.length, recovered: hit, recall: +(hit / (t.length || 1)).toFixed(3) };
  };
  // 语义：库里每个概念，在原始里识别出的物体 vs 逆向里识别出的物体（换成原始名字）
  const libNames = lib ? [...lib.matchAll(/^\s*concept\s+([\p{L}_][\p{L}\p{N}_]*)/gmu)].map((m) => m[1]) : [];
  const isObj = new Set(oa.map((a) => a.path));
  const semantic = {};
  let stp = 0, sfound = 0, struth = 0;
  for (const name of libNames) {
    const ca = A.concepts.find((c) => c.name === name), cb = B.concepts.find((c) => c.name === name);
    const t = new Set((ca?.members ?? []).filter((p) => isObj.has(p)));
    const m = new Set((cb?.members ?? []).map((p) => mB.get(p)).filter(Boolean));
    const tp = [...m].filter((x) => t.has(x)).length;
    stp += tp; sfound += m.size; struth += t.size;
    if (!t.size && !m.size) continue;
    const p = m.size ? tp / m.size : 1, r = t.size ? tp / t.size : 1;
    semantic[name] = { truth: t.size, found: m.size, precision: +p.toFixed(3), recall: +r.toFixed(3), f1: +(p + r ? (2 * p * r) / (p + r) : 0).toFixed(3) };
  }
  {
    const p = sfound ? stp / sfound : 1, r = struth ? stp / struth : 1;
    semantic.all = { truth: struth, found: sfound, precision: +p.toFixed(3), recall: +r.toFixed(3), f1: +(p + r ? (2 * p * r) / (p + r) : 0).toFixed(3) };
  }
  const topLines = reconSrc.split('\n').filter((l) => /^(box|cyl|cone|sphere|wedge|plate|hull|mesh|revolve|span|sweep|pipe|repeat|mirror|rotate|copy|group)\s/.test(l));
  // 语句数：把 import 的文件也算进去（修改层本身很短，但它描述的是整个场景）
  const expand = (src, o, seen = new Set()) => src.replace(/^\s*import\s+"([^"]+)".*$/gm, (m, rel) => {
    if (!o?.resolve) return '';
    const base = o.file && o.file.includes('/') ? o.file.slice(0, o.file.lastIndexOf('/') + 1) : '';
    const path = (base + rel).split('/').reduce((acc, x) => (x === '..' ? acc.slice(0, -1) : x === '.' || !x ? acc : [...acc, x]), []).join('/');
    if (seen.has(path)) return '';
    seen.add(path);
    try { return expand(o.resolve(path), { ...o, file: path }, seen); } catch { return ''; }
  });
  const lines = (s, o) => expand(s, o).split('\n').filter((l) => l.trim() && !l.trim().startsWith('//')).length;
  return {
    errors: { orig: A.errors.length, recon: B.errors.length },
    objects: { orig: oa.length, recon: ob.length, matched: mA.size, meanIoU: +([...mA.values()].reduce((s, x) => s + x.s, 0) / (mA.size || 1)).toFixed(3) },
    kinds: { fittable: fittable.length, correct: kindOk, accuracy: +(kindOk / (fittable.length || 1)).toFixed(3), complex: complex.length, complexAsMesh, complexDescribed, confusion },
    facts: { all: prf(() => true), ...Object.fromEntries(rels.map((r) => [r, prf((x) => x.startsWith(r + '|'))])), onAgainst: prf((x) => /^(on|against)\|/.test(x)) },
    compression: { array: recall('array'), mirror: recall('mirror') },
    semantic,
    description: {
      // 只算用世界坐标定位的（at=数字）；at=某物[u,v,w] 是相对锚点，算关系
      // 只算最外层用世界坐标定位的语句；repeat 内缩进的 at= 是相对实例原点的偏移（例如螺旋楼梯的半径）
      coordinateRatio: +(topLines.filter((l) => /\sat=[-\d(.]/.test(l)).length / (topLines.length || 1)).toFixed(3),
      anchorRatio: +(topLines.filter((l) => /\sat=[\p{L}_]/u.test(l)).length / (topLines.length || 1)).toFixed(3),
      statementRatio: +(lines(reconSrc, opts.recon) / lines(origSrc, opts.orig)).toFixed(3),
    },
  };
}
