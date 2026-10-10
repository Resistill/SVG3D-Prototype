// SVG3D 预览渲染：把 compile() 输出的几何条目变成 three.js 网格
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { worldGeom, itemGeometry, makeEvaluator } from './geometry.js';

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
    this.loader = new GLTFLoader();
    this.gltfCache = new Map();
    this.evaluator = makeEvaluator();
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
      if (this.fly.on) return;
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 4 && this.clickCb) this.clickCb(this.pick(ptr(e)), e);
    });
    this.initFly();
    let tPrev = performance.now();
    const loop = () => {
      const t = performance.now(), dt = Math.min(0.1, (t - tPrev) / 1000);
      tPrev = t;
      if (this.fly.on) this.stepFly(dt); else this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  // ── 漫游：点击锁定鼠标，鼠标转视角，WASD 移动、Q/E 升降、Shift 加速、滚轮调速，Esc 退出 ──
  initFly() {
    this.fly = { on: false, keys: new Set(), yaw: 0, pitch: 0, speed: 10, onChange: null };
    const canvas = this.renderer.domElement;
    const typing = () => /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement?.tagName ?? '');
    addEventListener('keydown', (e) => {
      if (!this.fly.on || typing()) return;
      this.fly.keys.add(e.code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.fly.keys.delete(e.code));
    addEventListener('blur', () => this.fly.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.fly.on || document.pointerLockElement !== canvas) return;
      this.fly.yaw -= e.movementX * 0.0022;
      this.fly.pitch = Math.max(-1.55, Math.min(1.55, this.fly.pitch - e.movementY * 0.0022));
    });
    canvas.addEventListener('wheel', (e) => { if (this.fly.on) { e.preventDefault(); this.fly.speed *= e.deltaY > 0 ? 1 / 1.2 : 1.2; } }, { passive: false });
    canvas.addEventListener('click', () => { if (this.fly.on && document.pointerLockElement !== canvas) canvas.requestPointerLock?.(); });
    // 鼠标锁被释放（Esc）就退出漫游
    document.addEventListener('pointerlockchange', () => { if (this.fly.on && document.pointerLockElement !== canvas && this.fly.locked) this.setFly(false); this.fly.locked = document.pointerLockElement === canvas; });
  }
  setFly(on) {
    if (on === this.fly.on) return;
    const canvas = this.renderer.domElement;
    if (on) {
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.fly.yaw = Math.atan2(-d.x, -d.z);
      this.fly.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
      // 速度按场景大小：大约 8 秒走完场景的半径
      const b = this.bounds();
      this.fly.speed = b.isEmpty() ? 10 : Math.max(2, b.getSize(new THREE.Vector3()).length() / 16);
      this.controls.enabled = false;
      this.fly.on = true;
      canvas.requestPointerLock?.();
    } else {
      this.fly.on = false;
      this.fly.keys.clear();
      // 回到环视：把目标点放在眼前
      const d = new THREE.Vector3();
      this.camera.getWorldDirection(d);
      this.controls.target.copy(this.camera.position).add(d.multiplyScalar(Math.max(5, this.fly.speed)));
      this.controls.enabled = true;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
    }
    this.fly.onChange?.(on);
  }
  toggleFly() { this.setFly(!this.fly.on); }
  stepFly(dt) {
    const f = this.fly, k = f.keys;
    this.camera.rotation.set(f.pitch, f.yaw, 0, 'YXZ');
    const fwd = new THREE.Vector3(-Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch));
    const right = new THREE.Vector3(Math.cos(f.yaw), 0, -Math.sin(f.yaw));
    const v = new THREE.Vector3();
    if (k.has('KeyW')) v.add(fwd);
    if (k.has('KeyS')) v.sub(fwd);
    if (k.has('KeyD')) v.add(right);
    if (k.has('KeyA')) v.sub(right);
    if (k.has('KeyE') || k.has('Space')) v.y += 1;
    if (k.has('KeyQ')) v.y -= 1;
    if (v.lengthSq() > 0) this.camera.position.addScaledVector(v.normalize(), f.speed * dt * (k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1));
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

  setScene(result) {
    this.content.traverse((o) => { if (o.isMesh && o.geometry) o.geometry.dispose(); });
    this.content.clear();
    const warnings = [];
    for (const item of result.items) {
      try {
        if (item.kind === 'solid' && item.geom.type === 'mesh') { this.addMeshRef(item); continue; }
        const geom = itemGeometry(item, this.evaluator);
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

  // mesh 引用：先放半透明占位盒，加载完成后换成源文件里的节点（放到外包络里：先减去 pivot，再套用世界变换）
  addMeshRef(item) {
    const holder = new THREE.Group();
    holder.name = item.path;
    const ph = new THREE.Mesh(worldGeom(item), new THREE.MeshStandardMaterial({ color: '#8899aa', transparent: true, opacity: 0.35 }));
    ph.userData = { path: item.path, tags: item.tags, baseMat: ph.material };
    holder.add(ph);
    this.content.add(holder);
    const [url, node] = item.geom.src.split('#');
    if (!this.gltfCache.has(url)) this.gltfCache.set(url, this.loader.loadAsync(url));
    this.gltfCache.get(url).then((gltf) => {
      // 节点可以写成 名字@k（重名节点里的第 k 个）
      const m = node && /^(.*)@(\d+)$/.exec(node);
      let srcObj = gltf.scene;
      if (m) { const hits = []; gltf.scene.traverse((o) => { if (o.name === m[1]) hits.push(o); }); srcObj = hits[+m[2] - 1] ?? hits[0]; }
      else if (node) srcObj = gltf.scene.getObjectByName(node);
      if (!srcObj) throw new Error(`找不到节点 ${node}`);
      gltf.scene.updateMatrixWorld(true);
      const obj = srcObj.clone(true);
      obj.matrixAutoUpdate = false;
      const { R, t } = item.world, p = item.geom.pivot;
      const W = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2], 0, 0, 0, 1);
      obj.matrix.copy(W.multiply(new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2])).multiply(srcObj.matrixWorld));
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.userData = { path: item.path, tags: item.tags, baseMat: o.material }; } });
      holder.remove(ph);
      holder.add(obj);
    }).catch((e) => console.warn(`mesh ${item.path} 加载失败：${e.message}`));
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
    // 雾与远裁剪面按场景大小：大场景（几百米）不会被雾吃掉
    const all = this.bounds(), R = all.isEmpty() ? r : Math.max(all.getSize(new THREE.Vector3()).length() / 2, 2);
    this.scene.fog.near = R * 2.5; this.scene.fog.far = R * 7;
    this.camera.far = Math.max(3000, R * 10); this.camera.updateProjectionMatrix();
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    if (!box) dir.set(0.75, 0.55, 0.9).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(dir.multiplyScalar(r * (box ? 2.4 : 1.6)));
  }

  pick(v) {
    this.raycaster.setFromCamera(v, this.camera);
    const hit = this.raycaster.intersectObjects(this.content.children, true)[0];
    return hit ? hit.object.userData : null;
  }

  // 高亮某个路径（及其所有后代），返回其世界包围盒
  highlight(paths) {
    paths = paths ? [].concat(paths) : [];
    this.selected = paths.length ? paths : null;
    if (this.helper) { this.scene.remove(this.helper); this.helper = null; }
    const under = (p) => paths.some((s) => p === s || p.startsWith(s + '.'));
    const meshes = [];
    this.content.traverse((o) => { if (o.isMesh && o.userData.baseMat) meshes.push(o); });
    for (const m of meshes) {
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
