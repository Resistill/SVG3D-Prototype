// 闭环：示例场景 → GLB → 逆向 → 与原始描述比对
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sceneToGLB } from '../tools/export.mjs';
import { partsOfDocument, reverse, FIDELITY } from '../tools/reverse.mjs';
import { score } from '../tools/score.mjs';
import { evaluate } from '../tools/eval.mjs';
import { compile, FACT_EPS } from '../src/s3d.js';

const roundTrip = (file, level) => {
  const src = readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8');
  const { doc } = sceneToGLB(src, { level });
  const out = reverse(partsOfDocument(doc), { srcFile: `${file}.${level}.glb`, level });
  return { out, ev: evaluate(src, out.src) };
};

test('航天基地 L0 往返：形状、关系、坐标依赖率达到第一阶段的验收标准', () => {
  const { ev } = roundTrip('spaceport.s3d', 'L0');
  assert.equal(ev.errors.recon, 0, '逆向结果零错误编译');
  assert.equal(ev.objects.matched, ev.objects.orig, '每个对象都找到了对应');
  assert.ok(ev.kinds.accuracy >= 0.95, `形状种类正确率 ${ev.kinds.accuracy}`);
  assert.equal(ev.kinds.complexAsMesh + ev.kinds.complexDescribed, ev.kinds.complex, '复杂形状要么保留为源网格引用，要么描述为扫掠 / 旋转体');
  assert.ok(ev.kinds.complexDescribed >= 2, '两根弯管拟合成管道');
  assert.ok(ev.facts.onAgainst.f1 >= 0.9, `on/against F1 ${ev.facts.onAgainst.f1}`);
  assert.ok(ev.description.coordinateRatio < 0.1, `坐标依赖率 ${ev.description.coordinateRatio}`);
});

test('压缩即理解：航天基地的阵列、旋转对称、螺旋与镜像都被识别出来，描述比原文还短', () => {
  const { out, ev } = roundTrip('spaceport.s3d', 'L0');
  assert.equal(ev.compression.array.recall, 1, `阵列召回 ${JSON.stringify(ev.compression.array)}`);
  assert.equal(ev.compression.mirror.recall, 1, `镜像召回 ${JSON.stringify(ev.compression.mirror)}`);
  assert.ok(ev.description.statementRatio < 1, `语句数比 ${ev.description.statementRatio}`);
  const kinds = Object.fromEntries(out.report.arrays.map((a) => [a.id, a.kind]));
  assert.equal(kinds.tower_legs, 'grid');
  assert.equal(kinds.rocket_fins, 'rotate');
  assert.equal(kinds.spiral_treads, 'screw');
  assert.deepEqual(out.report.arrays.find((a) => a.id === 'tanks').children, ['tank', 'cap', 'ring'], '同一实例里的多个部件合并成一个 repeat');
  assert.ok(out.report.mirrors.some((m) => m.id === 'tower2_decks' && m.of === 'tower_decks' && /axis=x/.test(m.across)), '镜像面写成关系');
});

test('一般轴的旋转：风车叶片绕水平轴、斜塔的立柱环', () => {
  const src = `
    box hub size=1,1,1 at=0,10,0 pin=center
    rotate blades n=2 about=hub axis=z { box blade size=0.6,5,0.2 at=hub.top }
    cyl core r=2 h=6 at=20,0,0
    rotate cols n=7 about=core { cyl col r=0.15 h=4 at=22.6,0,0 }`;
  const { doc } = sceneToGLB(src, { level: 'L0' });
  const out = reverse(partsOfDocument(doc), { srcFile: 'x.glb' });
  const ev = evaluate(src, out.src);
  assert.equal(ev.errors.recon, 0);
  const rot = out.report.arrays.filter((a) => a.kind === 'rotate').map((a) => a.n);
  assert.deepEqual(rot.sort(), [3, 8], `识别出的旋转：${JSON.stringify(out.report.arrays)}`);
  assert.ok(ev.objects.meanIoU > 0.95, `平均 IoU ${ev.objects.meanIoU}`);
});

test('L1（抹去名字）与 L0 同样好；L2（合并网格）仍可用', () => {
  const l1 = roundTrip('spaceport.s3d', 'L1').ev;
  assert.ok(l1.kinds.accuracy >= 0.95 && l1.facts.onAgainst.f1 >= 0.9);
  const l2 = roundTrip('spaceport.s3d', 'L2').ev;
  assert.equal(l2.errors.recon, 0);
  assert.ok(l2.kinds.accuracy >= 0.85, `L2 形状种类正确率 ${l2.kinds.accuracy}`);
  assert.ok(l2.facts.onAgainst.f1 >= 0.85, `L2 on/against F1 ${l2.facts.onAgainst.f1}`);
});

test('逆向输出带拟合度与来源，并且命名稳定', () => {
  const a = roundTrip('basics.s3d', 'L0').out, b = roundTrip('basics.s3d', 'L0').out;
  assert.equal(a.src, b.src, '同一输入，输出逐字相同');
  assert.match(a.src, /~fit=/);
  assert.match(a.src, /~src="table"/);
});

test('语义命名：源模型没有名字（L1）时按识别出的概念起名，改名不影响任何指标', () => {
  const { out, ev } = roundTrip('spaceport.s3d', 'L1');
  assert.ok(out.report.renamed > 20, `改名 ${out.report.renamed} 处`);
  assert.match(out.src, /^box terrain /m);
  assert.match(out.src, /^repeat columns(_\d+)? /m);
  assert.doesNotMatch(out.src, /^(box|cyl|wedge|sphere)\s+(box|cyl|wedge|sphere)\d+\s/m, '基本体不再用形状编号命名');
  assert.equal(ev.errors.recon, 0);
  assert.equal(ev.objects.matched, ev.objects.orig);
  assert.equal(ev.semantic.all.f1, 1, `语义 F1 ${JSON.stringify(ev.semantic.all)}`);
  const raw = reverse(partsOfDocument(sceneToGLB(readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8'), { level: 'L1' }).doc), { level: 'L1', names: false });
  const ev2 = evaluate(readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8'), raw.src);
  assert.deepEqual(ev2.facts, ev.facts, '改名前后空间事实完全相同');
});

test('稳定命名：源模型改动后重跑逆向（带上一次的结果），未改动的物体沿用原来的名字', () => {
  const rd = (p) => readFileSync(new URL(`../examples/${p}`, import.meta.url), 'utf8');
  const C = (f) => compile(rd(f), { file: f, resolve: rd });
  const rev = (f, previous) => reverse(partsOfDocument(sceneToGLB(rd(f), { file: f, resolve: rd, level: 'L1' }).doc), { level: 'L1', previous }).src;
  const iou = (a, b) => {
    if (!a || !b) return 0;
    const ov = [0, 1, 2].map((k) => Math.max(0, Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k])));
    const v = (x) => [0, 1, 2].reduce((s, k) => s * Math.max(1e-9, x.max[k] - x.min[k]), 1);
    return (ov[0] * ov[1] * ov[2]) / (v(a) + v(b) - ov[0] * ov[1] * ov[2]);
  };
  const tb = (R, p) => { const n = R.nodes.find((x) => x.path === p); return n?.tight ?? n?.box; };
  const srcOf = (R, p, S) => { let best = null, bs = 0.5; for (const it of S.items) { const s = iou(tb(R, p), tb(S, it.path)); if (s > bs) { bs = s; best = it.path; } } return best; };
  // spaceport_edit 是 spaceport 的修改层：火箭加长、塔改 10 层、厂房加宽、罐 3 → 5、拆灯、加厂房
  const A = C('spaceport.s3d'), B = C('spaceport_edit.s3d');
  const out0 = rev('spaceport.s3d');
  const R0 = compile(out0);
  const R1 = compile(rev('spaceport_edit.s3d', out0));
  let ok = 0, total = 0;
  for (const n of R0.nodes.filter((x) => x.tight && (!x.path.includes('.') || /^[^.]+\.0\.[^.]+$/.test(x.path)))) {
    const s0 = srcOf(R0, n.path, A);
    if (!s0 || iou(tb(A, s0), tb(B, s0)) < 0.95) continue; // 源里删掉或改了形状的不算
    total++;
    if (R1.nodes.some((x) => x.path === n.path) && srcOf(R1, n.path, B) === s0) ok++;
  }
  assert.ok(total >= 20);
  assert.equal(ok, total, `路径命中 ${ok}/${total}`);
});

test('阵列的例外：缺成员的阵列写成 repeat + drop；只有更短时才算规律', () => {
  const back = (src) => {
    const { doc } = sceneToGLB(src, { level: 'L1' });
    const out = reverse(partsOfDocument(doc), { level: 'L1' });
    return { out, ev: evaluate(src, out.src) };
  };
  // 一排 6 根带灯的柱子拆掉第 3 根
  const { out, ev } = back(`
    box ground size=60,1,30 pin=top
    repeat posts n=6 step=4,0,0 on=ground {
      cyl post r=0.2 h=3
      sphere lamp r=0.4 on=post
    }
    drop posts.2
  `);
  assert.match(out.src, /^repeat \S+ n=6 /m);
  assert.match(out.src, /^drop \S+\.2$/m);
  assert.equal(ev.errors.recon, 0);
  assert.equal(ev.objects.matched, ev.objects.orig);
  assert.equal(ev.compression.array.recall, 1);
  // 三个一样的盒子摆成 L 形：凑得成“2×2 缺一角”，但写成阵列并不更短
  const L = back(`
    box ground size=60,1,30 pin=top
    box a size=1,1,1 on=ground
    box b size=1,1,1 on=ground[0.2,1,0]
    box c size=1,1,1 on=ground[0,1,0.3]
  `);
  assert.doesNotMatch(L.out.src, /^(repeat|drop) /m);
});

test('沿曲线的阵列：恢复出曲线本身（闭合样条上的枕木、路肩外侧的路灯）', () => {
  const src = `
    box ground size=80,1,80 pin=top
    spline road path=[(-30,0,10); (-10,0,-5); (10,0,8); (30,0,-6)]
    repeat lamps n=12 along=road {
      cyl pole r=0.15 h=5 at=0,0,3
      box arm size=1.6,0.12,0.12 at=0,4.9,2.4
    }
    spline loop closed=true path=[(0,2,20); (15,6,28); (5,9,38); (-12,4,30)]
    repeat ties n=40 along=loop orient=full { box tie size=0.2,0.1,1.5 pin=top }
  `;
  const out = reverse(partsOfDocument(sceneToGLB(src, { level: 'L1' }).doc), { level: 'L1' });
  const ev = evaluate(src, out.src);
  assert.equal(ev.errors.recon, 0);
  assert.equal(ev.objects.matched, ev.objects.orig);
  assert.equal(ev.compression.array.recall, 1, JSON.stringify(ev.compression.array));
  // 路灯：灯杆与灯臂是同一个 repeat 的两个部件，曲线落在地面上，控制点就是原来的那 4 个（方向可能相反）
  const road = /^spline (\S+) path=\[(.*)\]$/m.exec(out.src);
  assert.ok(road, out.src);
  const pts = road[2].split(';').map((p) => p.replace(/[()\s]/g, '').split(',').map(Number));
  const want = [[-30, 0, 10], [-10, 0, -5], [10, 0, 8], [30, 0, -6]];
  const near = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < 1e-3);
  assert.ok(pts.every((p, j) => near(p, want[j])) || pts.every((p, j) => near(p, want[3 - j])), road[0]);
  assert.match(out.src, new RegExp(`^repeat \\S+ n=12 along=${road[1]} \\{\\n  \\S+ \\S+ .*\\n  \\S+ \\S+ .*\\n\\}`, 'm'));
  // 枕木：闭合曲线，orient=full
  assert.match(out.src, /^spline \S+ closed=true path=\[/m);
  assert.match(out.src, /^repeat \S+ n=40 along=\S+ orient=full \{/m);
});

test('部分圆弧上的旋转阵列：沿 300° 弧排的路灯写成 rotate', () => {
  const { out, ev } = roundTrip('curves.s3d', 'L0');
  assert.equal(ev.compression.array.recall, 1, JSON.stringify(ev.compression.array));
  assert.match(out.src, /^rotate \S+ n=10 angle=30 /m);
});

test('由关系决定长度的阵列：轨道下垂到地面的立柱写成 span … drop=，与枕木共用一条曲线', () => {
  const src = `
    box ground size=80,1,80 pin=top
    spline loop closed=true path=[(0,4,0); (15,8,8); (5,11,18); (-12,6,10)]
    repeat ties n=40 along=loop orient=full { box tie size=0.2,0.1,1.5 pin=top }
    repeat legs n=12 along=loop { span col from=(0,-0.3,0) drop=ground r=0.2 }
  `;
  const out = reverse(partsOfDocument(sceneToGLB(src, { level: 'L1' }).doc), { level: 'L1' });
  const ev = evaluate(src, out.src);
  assert.equal(ev.errors.recon, 0);
  assert.equal(ev.compression.array.recall, 1, JSON.stringify(ev.compression.array));
  assert.equal((out.src.match(/^spline /gm) ?? []).length, 1, '只有一条曲线');
  assert.match(out.src, /^repeat \S+ n=12 along=\S+ \{\n  span \S+ from=\(0,-0\.3,0\) drop=\S+ r=0\.2 /m);
});

test('倾斜的物体保留站立方向：光伏阵列是一个 5×4 网格，立柱立在地上；斜塔的立柱立在环上', () => {
  const src = `
    box ground size=80,1,80 pin=top
    repeat solar n=(5,1,4) step=5.5,0,4.5 center=true on=ground {
      cyl post r=0.12 h=1.6
      box panel size=5,0.1,2.8 on=post tilt=25
    }
    group pisa at=-20,0,20 roll=5 {
      cyl core r=4 h=20
      repeat galleries n=3 step=0,5.6,0 {
        cyl ring r=4.8 h=0.5 at=0,5.6,0
        rotate cols n=11 { cyl col r=0.18 h=5.1 at=4.55,0.5,0 }
      }
    }
  `;
  const out = reverse(partsOfDocument(sceneToGLB(src, { level: 'L1' }).doc), { level: 'L1' });
  const ev = evaluate(src, out.src);
  assert.equal(ev.errors.recon, 0);
  assert.equal(ev.compression.array.recall, 1, JSON.stringify(ev.compression.array));
  assert.match(out.src, /^repeat \S+ n=\(5,1,4\) step=5\.5,0,4\.5 on=/m, '一个网格，立在地上');
  assert.equal(ev.facts.on.recall, 1, `on ${JSON.stringify(ev.facts.on)}`);
  // 斜塔的立柱写成倾斜的 y 轴圆柱（不是 axis=x）
  assert.doesNotMatch(out.src, /cyl \S+ r=0\.18 h=5\.1 axis=x/);
});

test('管道拟合：弯管写成 pipe 并恢复半径；笔直的（储罐、箭体）仍是圆柱', () => {
  const src = `
    box ground size=60,1,60 pin=top
    bezier feedline path=[(-10,0.5,10); (-10,0.5,0); (10,1.5,8); (10,1.5,-6)]
    sweep feed path=feedline r=0.35
    group tank on=ground[0.5,1,-0.5] { cyl body r=3 h=8
      sphere dome r=3 at=body.top pin=center }
  `;
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L2' }).doc);
  const out = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'structure' });
  const pipe = /^pipe \S+ path=\[([^\]]+)\] r=([\d.]+)/m.exec(out.src);
  assert.ok(pipe, out.src);
  assert.ok(Math.abs(+pipe[2] - 0.35) < 0.02, `半径 ${pipe[2]}`);
  assert.doesNotMatch(out.src, /^pipe \S+ path=[^\n]* r=([3-9]|\d\d)/m, '储罐不是管道');
  assert.equal(evaluate(src, out.src).errors.recon, 0);
});

test('享元类型：同一个网格被多个节点使用 → 一个 def + 若干实例（缩放不同的另成一个类型）；名字去掉路径前缀', async () => {
  const { Document } = await import('@gltf-transform/core');
  const doc = new Document(), buf = doc.createBuffer();
  const boxMesh = (w, h, d) => {
    // 一个底面在 y=0 的盒子（12 个三角形）
    const v = [], c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([x, y, z]) => [(x - 0.5) * w, y * h, (z - 0.5) * d]);
    for (const [a, b, cc, dd] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]) v.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[dd]);
    const prim = doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(v)).setBuffer(buf));
    return doc.createMesh().addPrimitive(prim);
  };
  const scene = doc.createScene();
  const ground = boxMesh(60, 1, 60), house = boxMesh(4, 3, 6);
  scene.addChild(doc.createNode('Big/cell_1/SM_Ground').setMesh(ground).setTranslation([0, -1, 0]));
  const q = (deg) => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];
  [[-10, 0], [0, 90], [12, 180]].forEach(([x, deg], k) => scene.addChild(doc.createNode(`Big/cell_${k}/SM_House_01`).setMesh(house).setTranslation([x, 0, 5]).setRotation(q(deg))));
  scene.addChild(doc.createNode('Big/cell_9/SM_House_01').setMesh(house).setTranslation([0, 0, -15]).setScale([2, 1, 1]));
  scene.addChild(doc.createNode('Big/cell_8/SM_House_01').setMesh(house).setTranslation([15, 0, -15]).setScale([2, 1, 1]));
  const out = reverse(partsOfDocument(doc), { srcFile: 'x.glb', fidelity: 'structure' });
  assert.match(out.src, /^def House_01 \{\n  box body size=(4,3,6|6,3,4)/m, out.src);
  assert.match(out.src, /^def House_01_v2 \{\n  box body size=(8,3,6|6,3,8)/m, '缩放不同的另成一个类型');
  assert.doesNotMatch(out.src, /material null/);
  assert.equal((out.src.match(/^House_01 /gm) ?? []).length, 3);
  assert.doesNotMatch(out.src.replace(/ ~src="[^"]*"/g, ''), /Big_cell|SM_/, '名字去掉了路径与 SM_ 前缀（~src 里保留来源）');
  assert.equal((out.src.match(/^House_01 \S+ on=Ground/gm) ?? []).length, 3, '实例立在地面上');
  const r = compile(out.src);
  assert.deepEqual(r.errors, []);
  // 三个实例的位置与朝向都对
  const ctr = (p) => { const b = r.nodes.find((n) => n.path === p).box; return [0, 2].map((k) => +((b.min[k] + b.max[k]) / 2).toFixed(3)); };
  const ids = [...out.src.matchAll(/^House_01 (\S+)/gm)].map((m) => m[1]);
  // 结构档的容差是 5 cm（数字按档位取位数）
  ids.map(ctr).sort((a, b) => a[0] - b[0]).forEach((c, k) => [[-10, 5], [0, 5], [12, 5]][k].forEach((v, j) => assert.ok(Math.abs(c[j] - v) < 0.05, `${ids[k]}: ${c}`)));
});

// 把整个场景挂到一个缩放过的父节点下：同一个世界，换一种长度单位（k = 每米多少个场景单位）
const rescale = (doc, k) => {
  for (const scene of doc.getRoot().listScenes()) {
    const top = doc.createNode('units').setScale([k, k, k]);
    for (const c of scene.listChildren()) { scene.removeChild(c); top.addChild(c); }
    scene.addChild(top);
  }
  return doc;
};

test('场景单位：同一个场景按米、stud（0.28 m）、厘米逆向，形状、阵列、镜像一致，残差分数不变', () => {
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  for (const fidelity of ['structure', 'semantic']) {
    const runs = [1, 0.28, 0.01].map((unit) => {
      const parts = partsOfDocument(rescale(sceneToGLB(src, { level: 'L0' }).doc, 1 / unit));
      const out = reverse(parts, { srcFile: 'x.glb', fidelity, unit });
      const r = compile(out.src, { factEps: FACT_EPS / unit });
      assert.deepEqual(r.errors, [], `${fidelity} unit=${unit}`);
      const s = score({ result: r, files: [{ file: null, text: out.src }], sourceParts: parts, consts: { delta: FIDELITY[fidelity].tau, unit } });
      const kinds = {};
      for (const o of out.objs) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
      return { unit, kinds, arrays: out.report.arrays.map((a) => a.id + ':' + a.children.join('+')).sort(), mirrors: out.report.mirrors.map((m) => m.of).sort(), R: s.R_src + s.R_recon };
    });
    for (const x of runs.slice(1)) {
      assert.deepEqual(x.kinds, runs[0].kinds, `${fidelity} unit=${x.unit} 形状`);
      assert.deepEqual(x.arrays, runs[0].arrays, `${fidelity} unit=${x.unit} 阵列`);
      assert.deepEqual(x.mirrors, runs[0].mirrors, `${fidelity} unit=${x.unit} 镜像`);
      assert.ok(Math.abs(x.R - runs[0].R) < 0.01 * runs[0].R, `${fidelity} unit=${x.unit} 残差 ${x.R} 对 ${runs[0].R}`);
    }
  }
});

test('决定层：忽略、指定形状与名字、合并、保留网格、锁定定位；满足不了的与找不到的写进报告', () => {
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L0' }).doc);
  const first = reverse(parts, { srcFile: 'x.glb', level: 'L0', fidelity: 'structure' });
  // 人改过地面的定位（写在上一次的基础层里），并且要求以后不要再动
  const groundLine = first.src.split('\n').find((l) => /^box ground /.test(l));
  assert.ok(groundLine, first.src.slice(0, 400));
  const previous = first.src.replace(groundLine, groundLine.replace(/ at=\S+| pin=\S+/g, '') .replace(/ mat=/, ' at=0,-0.5,0 pin=center mat='));
  const decisions = [
    'drop ~src="bunker"',
    'cyl pad_disc ~src="pad"',
    'box hangar_mass ~src=["hangar.body","hangar.roof"]',
    'mesh spare_mesh ~src="spare"',
    'over ground ~lock=place',
    'repeat lamps ~src=["lights.0.pole","lights.1.pole"]',
    'drop ~src="no_such_part"',
  ].join('\n');
  const out = reverse(parts, { srcFile: 'x.glb', level: 'L0', fidelity: 'structure', previous, decisions });
  const d = out.report.decisions;
  assert.equal(d.applied.length, 5, JSON.stringify(d));
  assert.equal(d.unsatisfied.length, 1, JSON.stringify(d.unsatisfied));
  assert.match(d.unsatisfied[0].text, /^repeat lamps/);
  assert.deepEqual(d.dangling.map((x) => x.missing), [['no_such_part']]);
  assert.doesNotMatch(out.src, /~src="bunker"/, '掩体被忽略');
  assert.match(out.src, /^cyl pad_disc .*~src="pad"/m, '发射台写成圆柱，名字是决定里的');
  assert.match(out.src, /^box hangar_mass /m, '厂房主体与屋顶合成一个盒子');
  assert.doesNotMatch(out.src, /~src="hangar\.roof"/);
  assert.match(out.src, /^mesh spare_mesh /m, '保留为网格');
  assert.match(out.src, /^box ground .*at=0,-0\.5,0 pin=center/m, '地面沿用人改过的定位');
  assert.deepEqual(compile(out.src).errors, []);
});

test('台阶：楼梯写成 span … steps=n，级数、截面与原文一致，几何包络对得上；成对的楼梯写成镜像', () => {
  const src = readFileSync(new URL('../examples/basics.s3d', import.meta.url), 'utf8');
  const out = reverse(partsOfDocument(sceneToGLB(src, { level: 'L0' }).doc), { srcFile: 'x.glb', level: 'L0' });
  const m = /^span stairs from=(\S+) to=(\S+) steps=(\d+) section=(\S+)/m.exec(out.src);
  assert.ok(m, out.src.split('\n').filter((l) => /stairs/.test(l)).join('\n'));
  assert.equal(+m[3], 8);
  assert.deepEqual(m[4].split(',').map(Number), [2, 0.2]);
  const box = (r) => r.nodes.find((n) => n.path === 'stairs').box;
  const a = box(compile(src)), b = box(compile(out.src));
  for (const k of ['min', 'max']) a[k].forEach((v, i) => assert.ok(Math.abs(v - b[k][i]) < 0.01, `${k}: ${a[k]} 对 ${b[k]}`));
  const sp = reverse(partsOfDocument(sceneToGLB(readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8'), { level: 'L0' }).doc), { srcFile: 'x.glb', level: 'L0' });
  assert.ok((sp.src.match(/^span \S+ from=\S+ to=\S+ steps=/gm) ?? []).length >= 2, '两段楼梯');
  assert.ok(sp.report.mirrors.some((x) => /stair/.test(x.of)), JSON.stringify(sp.report.mirrors));
});

test('旋转体：整流罩写成 revolve（底部半径、高度、尖顶与原文一致）；螺旋扶手这类只占旋转面一小部分的不算', () => {
  const sp = reverse(partsOfDocument(sceneToGLB(readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8'), { level: 'L0' }).doc), { srcFile: 'x.glb', level: 'L0', fidelity: 'structure' });
  const m = /^revolve rocket_nose profile=\[([^\]]+)\]/m.exec(sp.src);
  assert.ok(m, sp.src.split('\n').filter((l) => /nose/.test(l)).join('\n'));
  const prof = m[1].split(';').map((p) => p.replace(/[()\s]/g, '').split(',').map(Number));
  assert.ok(Math.abs(prof[0][0] - 2) < 0.05 && prof[0][1] === 0, `底部 ${prof[0]}`);
  const top = prof[prof.length - 1];
  assert.ok(Math.abs(top[1] - 7) < 0.05 && top[0] < 0.3, `尖顶 ${top}`);
  assert.deepEqual(compile(sp.src).errors, []);
  const cv = reverse(partsOfDocument(sceneToGLB(readFileSync(new URL('../examples/curves.s3d', import.meta.url), 'utf8'), { level: 'L0' }).doc), { srcFile: 'x.glb', level: 'L0', fidelity: 'structure' });
  assert.doesNotMatch(cv.src, /^revolve garage_rail /m, '螺旋扶手不是旋转体');
});

test('并行拟合：worker 线程预先算的拟合与单线程逐字一致', async () => {
  const { prefit } = await import('../tools/fitpool.mjs');
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L1' }).doc);
  const pre = await prefit(parts, { fidelity: 'structure', unit: 1, threads: 3, min: 0 });
  assert.ok(pre && pre.count > 50, JSON.stringify(pre && pre.count));
  const a = reverse(parts, { srcFile: 'x.glb', level: 'L1', fidelity: 'structure' });
  const b = reverse(parts, { srcFile: 'x.glb', level: 'L1', fidelity: 'structure', prefit: pre });
  assert.equal(b.src, a.src);
});

test('L2 的网格兜底：合并网格拆出来、拟合不了的分量写进部件文件，网格引用指向它；精细档的分数大幅下降', async () => {
  const { partsGlb } = await import('../tools/project.mjs');
  const { score } = await import('../tools/score.mjs');
  const { sceneObjects } = await import('../tools/worldtris.mjs');
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L2' }).doc);
  const plain = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'detail' });
  const fb = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'detail', partsFile: 'p.parts.glb' });
  assert.match(fb.src, /src="p\.parts\.glb#merged_\d+~\d+"/);
  const r = compile(fb.src);
  assert.deepEqual(r.errors, []);
  assert.ok(sceneObjects(r, { sourceParts: parts }).every((o) => !o.mesh?.placeholder), '网格引用都对得上源部件');
  const S = (text) => score({ result: compile(text), files: [{ file: null, text }], sourceParts: parts, consts: { delta: 0.005 } }).S;
  assert.ok(S(fb.src) < 0.5 * S(plain.src), `${S(fb.src)} 对 ${S(plain.src)}`);
  const bin = await partsGlb(parts, fb.objs, 'p.parts.glb');
  assert.ok(bin && bin.length > 1000);
});
