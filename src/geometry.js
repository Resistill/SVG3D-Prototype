// SVG3D 几何：把 compile() 输出的几何条目变成 three.js 几何体。预览器与 Node 工具（导出、逆向）共用。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';

const OPS = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION };

// 统一成非索引、带 normal/uv 的几何体，便于合并与布尔运算
export function normalize(g) {
  if (g.index) g = g.toNonIndexed();
  g.clearGroups();
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
}

function geomOf(s) {
  switch (s.type) {
    case 'box': return new THREE.BoxGeometry(s.w, s.h, s.d).translate(0, s.h / 2, 0);
    case 'wedge': {
      const sh = new THREE.Shape([new THREE.Vector2(-s.w / 2, 0), new THREE.Vector2(s.w / 2, 0), new THREE.Vector2(s.w / 2, s.h)]);
      return new THREE.ExtrudeGeometry(sh, { depth: s.d, bevelEnabled: false }).translate(0, 0, -s.d / 2);
    }
    case 'plate': {
      // 轮廓在 xz 平面：Shape 的 (x, −z) 拉伸 h 后绕 x 转 −90°，就是 (x, 0..h, z)
      const sh = new THREE.Shape(s.pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      return new THREE.ExtrudeGeometry(sh, { depth: s.h, bevelEnabled: false }).rotateX(-Math.PI / 2);
    }
    case 'cyl': {
      const R = Math.max(s.r1, s.r2);
      const g = new THREE.CylinderGeometry(s.r2, s.r1, s.h, 40).translate(0, s.h / 2, 0);
      if (s.axis === 'x') g.rotateZ(-Math.PI / 2).translate(-s.h / 2, R, 0);
      if (s.axis === 'z') g.rotateX(Math.PI / 2).translate(0, R, -s.h / 2);
      return g;
    }
    case 'sphere': return new THREE.SphereGeometry(s.r, 40, 20).translate(0, s.r, 0);
    case 'beam': return new THREE.BoxGeometry(s.L, s.t, s.w).translate(0, s.dy, 0);
    case 'rod': return new THREE.CylinderGeometry(s.r, s.r, s.L, 14).rotateZ(-Math.PI / 2);
    case 'steps': return mergeGeometries(s.treads.map((t) => normalize(new THREE.BoxGeometry(...t.s).translate(...t.c))));
    case 'sweep': return sweepGeom(s);
    case 'mesh': return new THREE.BoxGeometry(s.w, s.h, s.d).translate(0, s.h / 2, 0); // 加载前的占位
    case 'revolve': return new THREE.LatheGeometry(s.prof.map(([r, y]) => new THREE.Vector2(r, y)), 48, 0, (s.angle * Math.PI) / 180);
  }
  throw new Error('未知几何 ' + s.type);
}

// 沿核心算好的截面框架铺出管体；未闭合时两端封口
function sweepGeom({ frames, prof, closed, smooth }) {
  const n = frames.length, m = prof.length, pos = [], idx = [];
  const at = (f, [u, v]) => [0, 1, 2].map((k) => f.p[k] + f.side[k] * u + f.up[k] * v);
  const segs = closed ? n : n - 1;
  if (smooth) {
    for (const f of frames) for (const q of prof) pos.push(...at(f, q));
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % n;
      for (let a = 0; a < m; a++) {
        const a2 = (a + 1) % m, A = i * m + a, B = i2 * m + a, C = i2 * m + a2, D = i * m + a2;
        idx.push(A, B, C, A, C, D);
      }
    }
  } else {
    // 棱角截面：每条边单独一条带，法线不跨棱平均
    for (let a = 0; a < m; a++) {
      const base = pos.length / 3, a2 = (a + 1) % m;
      for (const f of frames) pos.push(...at(f, prof[a]), ...at(f, prof[a2]));
      for (let i = 0; i < segs; i++) {
        const i2 = (i + 1) % n, A = base + i * 2, D = A + 1, B = base + i2 * 2, C = B + 1;
        idx.push(A, B, C, A, C, D);
      }
    }
  }
  if (!closed) {
    for (const [f, end] of [[frames[0], false], [frames[n - 1], true]]) {
      const ring = prof.map((q) => at(f, q));
      const c = [0, 1, 2].map((k) => ring.reduce((s, p) => s + p[k], 0) / m);
      const base = pos.length / 3;
      pos.push(...c, ...ring.flat());
      for (let a = 0; a < m; a++) {
        const a2 = (a + 1) % m;
        if (end) idx.push(base, base + 1 + a2, base + 1 + a); else idx.push(base, base + 1 + a, base + 1 + a2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// 把局部几何烘焙到世界坐标（正交矩阵 R，可能含镜像，再平移 t）
export function worldGeom(item) {
  const g = normalize(geomOf(item.geom));
  const { R, t } = item.world;
  const M = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2], 0, 0, 0, 1);
  g.applyMatrix4(M);
  if (M.determinant() < 0) {
    // 镜像会让三角形绕序反转（内外颠倒），交换每个三角形的第 2、3 个顶点恢复
    for (const attr of Object.values(g.attributes)) {
      const a = attr.array, k = attr.itemSize;
      for (let i = 0; i < attr.count; i += 3) for (let j = 0; j < k; j++) {
        const x = a[(i + 1) * k + j]; a[(i + 1) * k + j] = a[(i + 2) * k + j]; a[(i + 2) * k + j] = x;
      }
    }
  }
  return g;
}


export function makeEvaluator() {
  const ev = new Evaluator();
  ev.useGroups = false;
  ev.attributes = ['position', 'normal', 'uv'];
  return ev;
}

// 一个条目（实体或布尔树）在世界坐标里的几何体
export function itemGeometry(item, evaluator = makeEvaluator()) {
  if (item.kind === 'solid') return worldGeom(item);
  const brush = (it) => {
    if (it.kind === 'solid') { const b = new Brush(worldGeom(it)); b.updateMatrixWorld(); return b; }
    let acc = null;
    for (const c of it.children) { const b = brush(c); acc = acc ? evaluator.evaluate(acc, b, OPS[it.op]) : b; }
    return acc;
  };
  return brush(item).geometry;
}
