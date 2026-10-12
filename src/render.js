// SVG3D 预览渲染：把 compile() 输出的几何条目变成 three.js 网格
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { worldGeom, itemGeometry, makeEvaluator } from './geometry.js';
import { VIEWS, camera as presetCam } from './views.js';
import { nodeRoles, COLLISION_MAT } from './roles-view.js';

// 几何条目超过这么多时合批（见 setScene）
const BATCH_MIN = 2000;
// 误差热力的颜色：与离屏渲染（tools/raster.mjs 的 heatColor）同一条色带：0 绿 → 0.5 黄 → 1 红；没有分数的浅灰
function heatColor(t) {
  const k = t == null ? -1 : Math.round(Math.max(0, Math.min(1, t)) * 20), x = k / 20;
  const rgb = k < 0 ? [205, 205, 205] : x < 0.5 ? [60 + 390 * x, 190, 70] : [235, 190 - 300 * (x - 0.5), 60];
  return new THREE.Color().setRGB(...rgb.map((v) => Math.round(v) / 255), THREE.SRGBColorSpace);
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
    // 源模型叠加层：半透明，不参与拾取与取景
    this.overlay = new THREE.Group();
    this.scene.add(this.content, this.curveLayer, this.overlay);
    // mesh 引用（逆向时退回原网格的部件）是否显示；关掉后只剩基本体，看语义重建本身缺了什么
    this.showMeshes = true;
    // 按角色隐藏（结构 / 装饰 / 地形 / 贴花 / 辅助，见 tools/roles.mjs）；roleCounts：场景里每种角色的物体数
    this.hiddenRoles = new Set();
    this.roleCounts = {};
    // 源模型叠加层的角色：节点名 → 角色（工程逆向时写的 state/source-roles.json），没有的按结构
    this.sourceRoles = null;
    this.meshCount = 0;
    // 合批模式（大场景，见 setScene）：{ meshes: [BatchedMesh], items: [{ path, tags, role, color, mesh, id }], box }；小场景为 null
    this.batch = null;
    // 误差热力：路径 → 0..1（满刻度由调用方定），null 时按材质显示
    this.heat = null;
    this.heatMats = new Map();
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
    this.content.traverse((o) => { if ((o.isMesh || o.isBatchedMesh) && o.geometry) o.geometry.dispose(); });
    this.content.clear();
    this.batch = null;
    this.lastResult = result;
    const warnings = [];
    this.meshCount = 0;
    const solids = result.items.filter((i) => !(i.kind === 'solid' && i.geom.type === 'mesh')).length;
    // 大场景（几何条目超过 BATCH_MIN）合批：每个物体一个 Mesh 时，十几万个物体就是每帧十几万次绘制调用（阴影再一遍），
    // 整张 SpaceCenter 只有 1 帧/秒。按材质（金属度、粗糙度、透明度）合成 BatchedMesh，颜色、高亮、热力用实例颜色，
    // 隔离、角色开关用实例显隐，点选用射线命中的实例号；大场景不画阴影。小场景照旧（每个物体一个 Mesh）
    const big = solids > BATCH_MIN;
    this.sun.castShadow = !big;
    // 碰撞块（~role=collision）画成半透明红色，与看得见的东西区分开；角色开关可以整个关掉
    const roleOf = nodeRoles(result), matOf = (item) => (roleOf(item.path) === 'collision' ? COLLISION_MAT : item.material);
    if (big) this.buildBatches(result, warnings, matOf);
    for (const item of big ? result.items.filter((i) => i.kind === 'solid' && i.geom.type === 'mesh') : result.items) {
      try {
        if (item.kind === 'solid' && item.geom.type === 'mesh') { this.addMeshRef(item); continue; }
        const geom = itemGeometry(item, this.evaluator);
        const mat = matOf(item), mesh = new THREE.Mesh(geom, this.material(mat));
        mesh.castShadow = mesh.receiveShadow = mat !== COLLISION_MAT;
        mesh.userData = { path: item.path, tags: item.tags, origMat: mesh.material };
        mesh.name = item.path;
        this.paint(mesh);
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
    this.nodeMap = new Map(result.nodes.map((n) => [n.path, n]));
    this.roleCounts = {};
    for (const c of this.content.children) { if (c.isBatchedMesh) continue; c.userData.role = roleOf(c.name); this.roleCounts[c.userData.role] = (this.roleCounts[c.userData.role] ?? 0) + 1; }
    if (this.batch) for (const it of this.batch.items) { it.role = roleOf(it.path); this.roleCounts[it.role] = (this.roleCounts[it.role] ?? 0) + 1; }
    this.fitShadow();
    if (this.firstFrame && this.content.children.length) { this.frame(); this.firstFrame = false; }
    this.applyVisibility();
    if (this.selected) this.highlight(this.selected);
    return warnings;
  }

  // 合批：每个几何条目的世界坐标几何统一成“无索引、只有 position 与 normal”，按材质分组，每组一个 BatchedMesh
  buildBatches(result, warnings, matOf = (item) => item.material) {
    const groups = new Map(), box = new THREE.Box3();
    for (const item of result.items) {
      if (item.kind === 'solid' && item.geom.type === 'mesh') continue;
      let g;
      try { g = itemGeometry(item, this.evaluator); } catch (e) { warnings.push(`${item.path}：几何生成失败（${e.message}）`); continue; }
      const src = g.index ? g.toNonIndexed() : g;
      if (!src.getAttribute('normal')) src.computeVertexNormals();
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', src.getAttribute('position'));
      geom.setAttribute('normal', src.getAttribute('normal'));
      if (src !== g) src.dispose();
      geom.computeBoundingBox();
      box.union(geom.boundingBox);
      const m = matOf(item) ?? {}, key = JSON.stringify([m.metal ?? 0.05, m.rough ?? 0.78, m.opacity ?? 1]);
      if (!groups.has(key)) groups.set(key, { m, list: [] });
      groups.get(key).list.push({ item, geom, m });
    }
    const items = [], meshes = [];
    for (const { m, list } of groups.values()) {
      const opacity = m.opacity ?? 1, verts = list.reduce((a, x) => a + x.geom.getAttribute('position').count, 0);
      const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: m.metal ?? 0.05, roughness: m.rough ?? 0.78, transparent: opacity < 1, opacity, side: THREE.DoubleSide });
      const bm = new THREE.BatchedMesh(list.length, verts, 0, mat);
      bm.sortObjects = opacity < 1; // 不透明的不用每帧按距离排序（十几万个实例，排序本身就要十几毫秒）
      // 也不逐个实例做视锥裁剪：裁剪的结果每帧变，绘制列表每帧重建一遍（整张 SpaceCenter：一帧 70–140 ms；不裁剪 40 ms）。俯瞰全场时本来都在视野里
      bm.perObjectFrustumCulled = false;
      bm.userData.batchItems = [];
      for (const { item, geom, m: im } of list) {
        const id = bm.addInstance(bm.addGeometry(geom));
        geom.dispose();
        const it = { path: item.path, tags: item.tags, color: new THREE.Color(im?.color ?? '#c9c9c9'), mesh: bm, id };
        bm.setColorAt(id, it.color);
        bm.userData.batchItems[id] = it;
        items.push(it);
      }
      bm.castShadow = bm.receiveShadow = false;
      this.content.add(bm);
      meshes.push(bm);
    }
    this.batch = { meshes, items, box };
  }
  // 合批模式的颜色：底色（材质颜色，或误差热力的颜色）；选中的物体混一些橙色
  recolorBatches() {
    if (!this.batch) return;
    const set = this.selected && new Set(this.selected);
    const under = (p) => { if (!set) return false; for (let i = p.length; i > 0; i = p.lastIndexOf('.', i - 1)) if (set.has(p.slice(0, i))) return true; return false; };
    const hi = new THREE.Color('#ff7a1a'), c = new THREE.Color();
    for (const it of this.batch.items) {
      c.copy(this.heat ? heatColor(this.heat.get(it.path)) : it.color);
      if (under(it.path)) c.lerp(hi, 0.6);
      it.mesh.setColorAt(it.id, c);
    }
  }

  // mesh 引用：先放半透明占位盒，加载完成后换成源文件里的节点（放到外包络里：先减去 pivot，再套用世界变换）
  addMeshRef(item) {
    const holder = new THREE.Group();
    holder.name = item.path;
    holder.userData.meshRef = true;
    this.meshCount++;
    const ph = new THREE.Mesh(worldGeom(item), new THREE.MeshStandardMaterial({ color: '#8899aa', transparent: true, opacity: 0.35 }));
    ph.userData = { path: item.path, tags: item.tags, origMat: ph.material };
    this.paint(ph);
    holder.add(ph);
    this.content.add(holder);
    const [rel, node] = item.geom.src.split('#');
    const url = new URL(rel, this.srcBase ?? location.href).href;
    if (!this.gltfCache.has(url)) this.gltfCache.set(url, this.loader.loadAsync(url));
    this.gltfCache.get(url).then((gltf) => {
      const srcObj = node ? this.findSourceNode(gltf, node) : gltf.scene;
      if (!srcObj) {
        // 找不到：占位盒改成红色线框，一眼能看出是“没加载上”，而不是一个半透明的盒子静默留着
        console.warn(`mesh ${item.path}：源模型 ${rel} 里找不到节点「${node}」，显示为红色线框占位`);
        ph.userData.origMat = this.missingMat ??= new THREE.MeshBasicMaterial({ color: '#ff3b3b', wireframe: true });
        ph.userData.missing = true;
        this.paint(ph);
        return;
      }
      gltf.scene.updateMatrixWorld(true);
      // 只取这个部件本身：节点是单个 Mesh 时不带它的子节点（子节点是别的部件）
      const obj = srcObj.isMesh ? srcObj.clone(false) : srcObj.clone(true);
      obj.matrixAutoUpdate = false;
      const { R, t } = item.world, p = item.geom.pivot;
      const W = new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], t[0], R[1][0], R[1][1], R[1][2], t[1], R[2][0], R[2][1], R[2][2], t[2], 0, 0, 0, 1);
      obj.matrix.copy(W.multiply(new THREE.Matrix4().makeTranslation(-p[0], -p[1], -p[2])).multiply(srcObj.matrixWorld));
      obj.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; o.userData = { path: item.path, tags: item.tags, origMat: o.material }; this.paint(o); } });
      holder.remove(ph);
      holder.add(obj);
      // 异步加载完成时可能已经选中了它：补上高亮
      if (this.selected?.some((s) => item.path === s || item.path.startsWith(s + '.'))) obj.traverse((o) => { if (o.isMesh) o.material = this.hiMat(o.userData.baseMat); });
    }).catch((e) => console.warn(`mesh ${item.path} 加载失败：${e.message}`));
  }

  // 按 .s3d 里写的原始节点名找源文件里的部件。GLTFLoader 会清洗名字（去掉 / . : 等、重名追加 _1），
  // 所以用 parser.associations 拿到节点下标，再取 glTF JSON 里的原名。名字@k 是同名部件里的第 k 个：
  // 与 tools/reverse.mjs 的 partsOfDocument 一致——深度优先遍历场景，带网格的节点每个图元算一个部件
  findSourceNode(gltf, node) {
    if (!gltf.userData.s3dParts) {
      const json = gltf.parser.json, byName = new Map();
      gltf.scene.traverse((o) => {
        const i = gltf.parser.associations.get(o)?.nodes;
        if (i == null) return;
        const nd = json.nodes[i];
        if (nd.mesh == null || !nd.name) return;
        const n = json.meshes[nd.mesh].primitives.length;
        // 多个图元时 three.js 的节点是 Group，每个图元是一个子 Mesh
        const prims = n === 1 ? [o] : Array.from({ length: n }, (_, j) => o.children.find((c) => c.isMesh && gltf.parser.associations.get(c)?.primitives === j) ?? o);
        if (!byName.has(nd.name)) byName.set(nd.name, []);
        byName.get(nd.name).push(...prims);
      });
      gltf.userData.s3dParts = byName;
    }
    const m = /^(.*)@(\d+)$/.exec(node), parts = gltf.userData.s3dParts;
    if (m && parts.has(m[1])) return parts.get(m[1])[+m[2] - 1] ?? null;
    return parts.get(node)?.[0] ?? null;
  }

  bounds() { const b = new THREE.Box3().setFromObject(this.content); if (this.batch) b.union(this.batch.box); return b; }

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
    // 隔离视图里隐藏的物体不参与拾取
    const shown = (o) => { for (; o; o = o.parent) if (!o.visible) return false; return true; };
    const hit = this.raycaster.intersectObjects(this.content.children, true).find((h) => shown(h.object));
    if (hit?.object.isBatchedMesh) return hit.object.userData.batchItems[hit.batchId] ?? null;
    return hit ? hit.object.userData : null;
  }

  // 高亮某个路径（及其所有后代），返回其世界包围盒
  highlight(paths) {
    paths = paths ? [].concat(paths) : [];
    this.selected = paths.length ? paths : null;
    if (this.helper) { this.scene.remove(this.helper); this.helper = null; }
    // 路径本身或它的某个祖先被选中（按前缀逐级查集合：选中几百个物体时也不必两两比较）
    const set = new Set(paths);
    const under = (p) => { for (let i = p.length; i > 0; i = p.lastIndexOf('.', i - 1)) if (set.has(p.slice(0, i))) return true; return false; };
    const meshes = [];
    this.content.traverse((o) => { if (o.isMesh && o.userData.baseMat) meshes.push(o); });
    for (const m of meshes) m.material = paths.length && under(m.userData.path) ? this.hiMat(m.userData.baseMat) : m.userData.baseMat;
    this.recolorBatches();
    if (!paths.length || !this.nodes) return null;
    const box = new THREE.Box3();
    for (const p of paths) {
      const n = this.nodeMap?.get(p);
      if (n && n.box) box.union(new THREE.Box3(new THREE.Vector3(...n.box.min), new THREE.Vector3(...n.box.max)));
    }
    if (box.isEmpty()) return null;
    this.helper = new THREE.Box3Helper(box.expandByScalar(0.05), '#ff7a1a');
    this.scene.add(this.helper);
    return box;
  }
  hiMat(base) {
    if (!base.userData.hi) { base.userData.hi = base.clone(); base.userData.hi.emissive = new THREE.Color('#ff7a1a'); base.userData.hi.emissiveIntensity = 0.55; }
    return base.userData.hi;
  }

  // ── 视图模式 ──
  // 按当前模式给物体上底色：实体用自己的材质，误差热力用热度色（没有分数的物体浅灰）；高亮叠在底色之上
  paint(m) {
    const u = m.userData;
    u.baseMat = this.heat ? this.heatMat(this.heat.get(u.path)) : u.origMat;
    m.material = u.baseMat;
  }
  heatMat(t) {
    const k = t == null ? -1 : Math.round(Math.max(0, Math.min(1, t)) * 20);
    if (!this.heatMats.has(k)) this.heatMats.set(k, new THREE.MeshStandardMaterial({ color: heatColor(t), roughness: 0.85, metalness: 0, side: THREE.DoubleSide }));
    return this.heatMats.get(k);
  }
  // heat：Map 路径 → 0..1；null 回到实体
  setHeat(heat) {
    this.heat = heat;
    this.content.traverse((o) => { if (o.isMesh && o.userData.origMat) this.paint(o); });
    this.highlight(this.selected);
  }
  // 源模型半透明叠加（与 mesh 引用共用加载器与缓存）；url 为 null 时移除。源模型本身就在场景坐标里，不用变换。
  // only：只叠加这些源部件（名字同 ~src / score.json 的 src，即 名字@k），隔离视图里看一个物体对应的源网格时用
  async setOverlay(url, only = null) {
    const token = (this.overlayToken = (this.overlayToken ?? 0) + 1);
    this.overlay.clear();
    if (!url) return 0;
    if (!this.gltfCache.has(url)) this.gltfCache.set(url, this.loader.loadAsync(url));
    const gltf = await this.gltfCache.get(url);
    if (token !== this.overlayToken) return 0;
    this.ghostMat ??= new THREE.MeshBasicMaterial({ color: '#2f7dff', transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    const ghost = (obj) => { obj.traverse((o) => { if (o.isMesh) { o.material = this.ghostMat; o.castShadow = o.receiveShadow = false; o.renderOrder = 5; } }); this.overlay.add(obj); };
    // 叠加层的网格标上角色（按节点名查 sourceRoles），角色开关对它同样生效
    // （three.js 改写了节点名：按 glTF 里原始的节点名查；先标在原物体上，克隆时 userData 一起复制）
    // 同名的部件按出现顺序编号 名字@k（与工具读源部件的编号相同，findSourceNode 也按这个对应）
    this.findSourceNode(gltf, '');
    for (const [name, list] of gltf.userData.s3dParts) list.forEach((m, k) => { m.userData.sourceRole = this.sourceRoles?.[list.length > 1 ? `${name}@${k + 1}` : name] ?? this.sourceRoles?.[name] ?? 'structure'; });
    const show = (root) => root.traverse((o) => { if (o.userData.sourceRole) o.visible = !this.hiddenRoles.has(o.userData.sourceRole); });
    if (!only) { const all = gltf.scene.clone(true); ghost(all); show(all); return 1; }
    gltf.scene.updateMatrixWorld(true);
    let n = 0;
    for (const name of only) {
      const s = this.findSourceNode(gltf, name);
      if (!s) continue;
      const obj = s.isMesh ? s.clone(false) : s.clone(true);
      obj.matrixAutoUpdate = false;
      obj.matrix.copy(s.matrixWorld);
      ghost(obj);
      n++;
    }
    return n;
  }
  // 隔离视图：只显示这些路径（及其后代），其余隐藏；null 退出
  isolate(paths) {
    this.isolated = paths?.length ? [...paths] : null;
    this.applyVisibility();
  }
  // 显示 / 隐藏 mesh 引用（与隔离视图叠加：两者都允许才显示）
  setShowMeshes(on) {
    this.showMeshes = on;
    this.applyVisibility();
  }
  // 某种角色显示 / 隐藏（重建与源模型叠加层一起）
  setRoleVisible(role, on) {
    if (on) this.hiddenRoles.delete(role); else this.hiddenRoles.add(role);
    this.applyVisibility();
  }
  applyVisibility() {
    const set = this.isolated && new Set(this.isolated);
    const under = (p) => { for (let i = p.length; i > 0; i = p.lastIndexOf('.', i - 1)) if (set.has(p.slice(0, i))) return true; return false; };
    for (const c of this.content.children) if (!c.isBatchedMesh) c.visible = (!set || under(c.name)) && (this.showMeshes || !c.userData.meshRef) && !this.hiddenRoles.has(c.userData.role);
    if (this.batch) for (const it of this.batch.items) it.mesh.setVisibleAt(it.id, (!set || under(it.path)) && !this.hiddenRoles.has(it.role));
    this.overlay.traverse((o) => { if (o.userData.sourceRole) o.visible = !this.hiddenRoles.has(o.userData.sourceRole); });
    for (const l of this.curveLayer.children) l.visible = !set || under(l.userData.path ?? '');
  }
  // 一组路径的世界包围盒（隔离时对准用）
  boxOf(paths) {
    const box = new THREE.Box3();
    for (const p of paths) { const n = this.nodeMap?.get(p); if (n?.box) box.union(new THREE.Box3(new THREE.Vector3(...n.box.min), new THREE.Vector3(...n.box.max))); }
    return box.isEmpty() ? null : box;
  }
  // ── 相机预设（与 tools/raster.mjs 同一份：src/views.js）──
  // 取景范围：整个场景的精确包围盒（逐顶点，与 raster 按三角形求的一致）；返回 { min, max } 数组形式，可以原样传给 render --box
  sceneBox() {
    const b = new THREE.Box3();
    for (const c of this.content.children) if (!c.isBatchedMesh) b.expandByObject(c, true);
    if (this.batch) b.union(this.batch.box);
    return b.isEmpty() ? null : { min: b.min.toArray(), max: b.max.toArray() };
  }
  // 预设相机：view ∈ VIEWS；box 不给时取整个场景；focus 为 true 时按聚焦取景（2.4 倍半径，同 render --focus）
  presetCamera(view = 'iso', { box = null, focus = false } = {}) {
    const b = box ?? this.sceneBox() ?? { min: [-1, -1, -1], max: [1, 1, 1] };
    return { ...presetCam(b, VIEWS[view] ? view : 'iso', focus), box: b };
  }
  // 把交互相机切到预设视角（之后照常可以拖动）。画面不是正方形时横向看到的比 raster 的正方形图多一些，竖直方向的视野相同
  setView(view = 'iso', opts = {}) {
    if (this.fly.on) this.setFly(false);
    const cam = this.presetCamera(view, opts);
    this.controls.target.set(...cam.target);
    this.camera.position.set(...cam.eye);
    this.camera.fov = cam.fov;
    this.camera.far = Math.max(3000, cam.r * 10);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.view = view;
    return cam;
  }
  // 预设视角的快照（PNG data URL）：正方形、size 像素、相机与 raster.mjs 完全相同，可以与 render 的 PNG 并排对照
  snapshot(view = 'iso', { size = 1024, box = null, focus = false } = {}) {
    const cam = this.presetCamera(view, { box, focus });
    const c = new THREE.PerspectiveCamera(cam.fov, 1, cam.near, Math.max(3000, cam.r * 10));
    c.position.set(...cam.eye);
    c.lookAt(...cam.target);
    const r = this.renderer, ratio = r.getPixelRatio(), prev = r.getSize(new THREE.Vector2());
    r.setPixelRatio(1);
    r.setSize(size, size, false);
    r.render(this.scene, c);
    const url = r.domElement.toDataURL('image/png');
    r.setPixelRatio(ratio);
    r.setSize(prev.x, prev.y, false);
    r.render(this.scene, this.camera);
    return { url, view, box: cam.box, camera: { eye: cam.eye, target: cam.target, fov: cam.fov } };
  }

  // 写进 state/selection.json 的相机（AI 想从同一个角度看时用）
  cameraState() {
    const r = (v) => v.toArray().map((x) => +x.toFixed(3));
    return { position: r(this.camera.position), target: r(this.controls.target) };
  }

  exportGLB(name = 'scene') {
    let root = this.content;
    if (this.batch && this.lastResult) {
      root = new THREE.Group();
      for (const item of this.lastResult.items) { try { if (!(item.kind === 'solid' && item.geom.type === 'mesh')) { const m = new THREE.Mesh(itemGeometry(item, this.evaluator), this.material(item.material)); m.name = item.path; root.add(m); } } catch { /* 跳过 */ } }
    }
    new GLTFExporter().parse(root, (buf) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }));
      a.download = `${name}.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, (e) => alert('导出失败：' + e.message), { binary: true });
  }
}
