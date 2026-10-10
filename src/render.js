// SVG3D 预览渲染：把 compile() 输出的几何条目变成 three.js 网格
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Brush, Evaluator, ADDITION, SUBTRACTION, INTERSECTION } from 'three-bvh-csg';

const OPS = { union: ADDITION, subtract: SUBTRACTION, intersect: INTERSECTION };

// 统一成非索引、带 normal/uv 的几何体，便于合并与布尔运算
function normalize(g) {
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
function worldGeom(item) {
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

export class Viewer {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#c9d3dc');
    this.scene.fog = new THREE.Fog('#c9d3dc', 250, 700);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 3000);
    this.camera.position.set(120, 90, 140);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight('#eef4ff', '#5a5446', 1.4));
    this.sun = new THREE.DirectionalLight('#fff4e0', 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);

    this.content = new THREE.Group();
    this.curveLayer = new THREE.Group();
    this.scene.add(this.content, this.curveLayer);
    this.curveMat = new THREE.LineDashedMaterial({ color: '#1f5fd6', dashSize: 0.8, gapSize: 0.5, depthTest: false, transparent: true, opacity: 0.85 });
    this.helper = null;
    this.mats = new Map();
    this.evaluator = new Evaluator();
    this.evaluator.useGroups = false;
    this.evaluator.attributes = ['position', 'normal', 'uv'];
    this.raycaster = new THREE.Raycaster();
    this.hoverCb = this.clickCb = null;
    this.firstFrame = true;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(el);
    this.resize();
    const ptr = (e) => {
      const r = this.renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    let down = null;
    this.renderer.domElement.addEventListener('pointermove', (e) => this.hoverCb && this.hoverCb(this.pick(ptr(e)), e));
    this.renderer.domElement.addEventListener('pointerleave', () => this.hoverCb && this.hoverCb(null));
    this.renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4 && this.clickCb) this.clickCb(this.pick(ptr(e)));
    });
    const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    loop();
  }

  resize() {
    const w = this.el.clientWidth || 1, h = this.el.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  material(m) {
    const key = JSON.stringify(m);
    if (!this.mats.has(key)) {
      const opacity = m.opacity ?? 1;
      this.mats.set(key, new THREE.MeshStandardMaterial({
        color: m.color ?? '#c9c9c9', metalness: m.metal ?? 0.05, roughness: m.rough ?? 0.78,
        transparent: opacity < 1, opacity, side: THREE.DoubleSide,
      }));
    }
    return this.mats.get(key);
  }

  brush(item) {
    if (item.kind === 'solid') { const b = new Brush(worldGeom(item)); b.updateMatrixWorld(); return b; }
    let acc = null;
    for (const c of item.children) {
      const b = this.brush(c);
      acc = acc ? this.evaluator.evaluate(acc, b, OPS[item.op]) : b;
    }
    return acc;
  }

  setScene(result) {
    for (const m of this.content.children) m.geometry.dispose();
    this.content.clear();
    const warnings = [];
    for (const item of result.items) {
      try {
        const geom = item.kind === 'solid' ? worldGeom(item) : this.brush(item).geometry;
        const mesh = new THREE.Mesh(geom, this.material(item.material));
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.userData = { path: item.path, tags: item.tags, baseMat: mesh.material };
        mesh.name = item.path;
        this.content.add(mesh);
      } catch (e) {
        warnings.push(`${item.path}：几何生成失败（${e.message}）`);
      }
    }
    for (const l of this.curveLayer.children) l.geometry.dispose();
    this.curveLayer.clear();
    for (const c of result.curves || []) {
      const pts = c.pts.map((p) => new THREE.Vector3(...p));
      const line = new (c.closed ? THREE.LineLoop : THREE.Line)(new THREE.BufferGeometry().setFromPoints(pts), this.curveMat);
      line.computeLineDistances();
      line.renderOrder = 10;
      line.userData.path = c.path;
      this.curveLayer.add(line);
    }
    this.nodes = result.nodes;
    this.fitShadow();
    if (this.firstFrame && this.content.children.length) { this.frame(); this.firstFrame = false; }
    if (this.selected) this.highlight(this.selected);
    return warnings;
  }

  bounds() { return new THREE.Box3().setFromObject(this.content); }

  fitShadow() {
    const b = this.bounds();
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), r = b.getSize(new THREE.Vector3()).length() / 2;
    this.sun.position.copy(c).add(new THREE.Vector3(0.6, 1, 0.35).normalize().multiplyScalar(r * 2));
    this.sun.target.position.copy(c);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r; cam.right = cam.top = r; cam.near = 0.1; cam.far = r * 4;
    cam.updateProjectionMatrix();
  }

  frame(box) {
    const b = box ?? this.bounds();
    if (b.isEmpty()) return;
    const c = b.getCenter(new THREE.Vector3()), r = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 2);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!box) dir.set(0.75, 0.55, 0.9).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(dir.multiplyScalar(r * (box ? 2.4 : 1.6)));
  }

  pick(v) {
    this.raycaster.setFromCamera(v, this.camera);
    const hit = this.raycaster.intersectObjects(this.content.children, false)[0];
    return hit ? hit.object.userData : null;
  }

  // 高亮某个路径（及其所有后代），返回其世界包围盒
  highlight(paths) {
    paths = paths ? [].concat(paths) : [];
    this.selected = paths.length ? paths : null;
    if (this.helper) { this.scene.remove(this.helper); this.helper = null; }
    const under = (p) => paths.some((s) => p === s || p.startsWith(s + '.'));
    for (const m of this.content.children) {
      const base = m.userData.baseMat;
      if (paths.length && under(m.userData.path)) {
        if (!base.userData.hi) { base.userData.hi = base.clone(); base.userData.hi.emissive = new THREE.Color('#ff7a1a'); base.userData.hi.emissiveIntensity = 0.55; }
        m.material = base.userData.hi;
      } else m.material = base;
    }
    if (!paths.length || !this.nodes) return null;
    const box = new THREE.Box3();
    for (const p of paths) {
      const n = this.nodes.find((x) => x.path === p);
      if (n && n.box) box.union(new THREE.Box3(new THREE.Vector3(...n.box.min), new THREE.Vector3(...n.box.max)));
    }
    if (box.isEmpty()) return null;
    this.helper = new THREE.Box3Helper(box.expandByScalar(0.05), '#ff7a1a');
    this.scene.add(this.helper);
    return box;
  }

  exportGLB(name = 'scene') {
    new GLTFExporter().parse(this.content, (buf) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
      a.download = `${name}.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, (e) => alert('导出失败：' + e.message), { binary: true });
  }
}
