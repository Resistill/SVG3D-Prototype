// 闭环（续）：台阶、旋转体、L2 的网格兜底、板件
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sceneToGLB } from '../tools/export.mjs';
import { partsOfDocument, reverse, FIDELITY } from '../tools/reverse.mjs';
import { score } from '../tools/score.mjs';
import { evaluate } from '../tools/eval.mjs';
import { compile, FACT_EPS } from '../src/s3d.js';
import { sceneObjects as sceneObjectsOf } from '../tools/worldtris.mjs';

const roundTrip = (file, level) => {
  const src = readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8');
  const { doc } = sceneToGLB(src, { level });
  const out = reverse(partsOfDocument(doc), { srcFile: `${file}.${level}.glb`, level });
  return { out, ev: evaluate(src, out.src) };
};

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

// 网格按引用价计（工程的 score.meshPrice 可以这样设）时的兜底机制；默认结构的网格按真实信息量计价，拟合不了的多半写成基本体
test('L2 的网格兜底：合并网格拆出来、拟合不了的分量写进部件文件，网格引用指向它；按引用价计时精细档的分数大幅下降', async () => {
  const { partsGlb } = await import('../tools/project.mjs');
  const { score } = await import('../tools/score.mjs');
  const { sceneObjects } = await import('../tools/worldtris.mjs');
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L2' }).doc);
  const meshPrice = { structure: 'ref', terrain: 'ref' };
  const plain = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'detail', meshPrice });
  const fb = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'detail', partsFile: 'p.parts.glb', meshPrice });
  assert.match(fb.src, /src="p\.parts\.glb#merged_\d+~\d+"/);
  const r = compile(fb.src);
  assert.deepEqual(r.errors, []);
  assert.ok(sceneObjects(r, { sourceParts: parts }).every((o) => !o.mesh?.placeholder), '网格引用都对得上源部件');
  const S = (text) => score({ result: compile(text), files: [{ file: null, text }], sourceParts: parts, consts: { delta: 0.005, meshPrice } }).S;
  assert.ok(S(fb.src) < 0.5 * S(plain.src), `${S(fb.src)} 对 ${S(plain.src)}`);
  const bin = await partsGlb(parts, fb.objs, 'p.parts.glb');
  assert.ok(bin && bin.length > 1000);
});

test('L2 的楼梯改写之后，旁边的物体照常定位、零错误编译', () => {
  const src = `material m color=#888888
material n color=#cc4444
box ground size=40,1,40 pin=top mat=m
span stairs from=0,0,0 to=6,3,0 steps=8 section=2,0.2 mat=m
box crate size=1,1,1 at=3,0,1.6 mat=n
box crate2 size=1,1,1 at=3.4,1.6,-1.6 mat=n`;
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L2' }).doc);
  const out = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'structure' });
  assert.match(out.src, /steps=8/);
  assert.deepEqual(compile(out.src).errors, []);
});

test('板件：结构档第一遍就把空心的楼写成墙板与楼板（普通部件与享元类型都是），比实心盒子分数低；语义档不变', () => {
  const r = compile(`
subtract shell {
  box outer size=20,8,12
  box inner size=19.4,7.4,11.4 at=0,0.3,0
  box door size=3,4,1 at=outer.front pin=center align=bottom
}
box slab size=19.4,0.3,11.4 at=0,4,0
`);
  const tris = [];
  for (const o of sceneObjectsOf(r)) for (let i = 0; i < o.pos.length; i += 9) tris.push([0, 3, 6].map((k) => [o.pos[i + k], o.pos[i + k + 1], o.pos[i + k + 2]]));
  const white = { name: 'white', color: '#ffffff' }, grey = { name: 'grey', color: '#808080' };
  const cube = (a, b) => { const v = (i) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]; return [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]].flatMap(([p, q, s, t]) => [[v(p), v(s), v(q)], [v(p), v(t), v(s)]]); }; // 法线朝外
  const shift = (ts, d) => ts.map((t) => t.map((p) => [p[0] + d[0], p[1] + d[1], p[2] + d[2]]));
  const ground = { name: 'ground', tris: cube([-30, -1, -30], [60, 0, 30]), material: grey };
  // 屋顶上的一个箱子：立在板件拼成的楼上
  const parts = [{ name: 'hall', tris, material: white }, ground, { name: 'crate', tris: cube([2, 8, -1], [4, 10, 1]), material: grey }];
  const scoreOf = (out) => score({ result: compile(out.src), files: [{ file: 'x.s3d', text: out.src }], sourceParts: parts, consts: { delta: 0.05 } }).S;
  // 这个楼正好是“外壳 − 空腔 − 开口”（见下一条测试）；这里关掉外壳，看板件
  const out = reverse(parts, { srcFile: 'x.glb', fidelity: 'structure', shells: false });
  assert.deepEqual(compile(out.src).errors, []);
  assert.match(out.src, /^group hall .*\{\n(  (box|subtract) .*\n)+/m, '楼写成一组板件');
  assert.match(out.src, /^\s+box wall\S* size=/m);
  assert.match(out.src, /^\s+box slab\S* size=[\d.]+,0\.3,/m, '楼板的厚度来自配对的上下两个面');
  assert.match(out.src, /^box crate .*on=hall/m, '箱子仍然立在楼上');
  assert.deepEqual(out.report.fallback, [], '定位全部通过校验');
  // 楼与楼里的楼板是两个分量：当成小场景（分量各自拆成板件）比整体拆板件略好，记在 subs 里
  assert.equal(out.report.panels.length + out.report.subs.length, 1);
  const solid = reverse(parts, { srcFile: 'x.glb', fidelity: 'structure', panels: false, shells: false, unions: false, subs: false, plates: false });
  assert.match(solid.src, /^box hall /m);
  assert.ok(scoreOf(out) < scoreOf(solid) - 20, `板件 ${scoreOf(out)} < 实心盒子 ${scoreOf(solid)}`);
  assert.equal(reverse(parts, { srcFile: 'x.glb', fidelity: 'semantic' }).report.panels.length, 0, '语义档仍用基本体当代理');
  // 享元：同一个网格的两栋楼 → 一个类型，类型体是板件
  const M = (tx) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1];
  const typed = reverse([{ ...parts[0], name: 'hallA', mesh: '0:0', matrix: M(0) }, { name: 'hallB', tris: shift(tris, [35, 0, 0]), material: white, mesh: '0:0', matrix: M(35) }, ground], { srcFile: 'x.glb', fidelity: 'structure', shells: false });
  assert.deepEqual(compile(typed.src).errors, []);
  assert.match(typed.src, /^def hallA \{\n  group body \{/m);
  assert.equal((typed.report.panels[0] ?? typed.report.subs[0])?.instances, 2);
  assert.deepEqual(typed.report.fallback, []);
});

// 源描述编译成世界三角形（一个部件）
const trisOf = (text) => {
  const tris = [];
  for (const o of sceneObjectsOf(compile(text))) for (let i = 0; i < o.pos.length; i += 9) tris.push([0, 3, 6].map((k) => [o.pos[i + k], o.pos[i + k + 1], o.pos[i + k + 2]]));
  return tris;
};
const cubeTris = (a, b) => { const v = (i) => [i & 1 ? b[0] : a[0], i & 2 ? b[1] : a[1], i & 4 ? b[2] : a[2]]; return [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]].flatMap(([p, q, s, t]) => [[v(p), v(s), v(q)], [v(p), v(t), v(s)]]); }; // 法线朝外

test('外壳 − 空腔 − 开口：空心的楼第一遍就写成 subtract shell { outer ; cavity ; opening }，楼里的楼板另写；拱门写成矩形 + 横放的圆柱', () => {
  const white = { name: 'white', color: '#ffffff' }, grey = { name: 'grey', color: '#808080' };
  const ground = { name: 'ground', tris: cubeTris([-40, -1, -40], [60, 0, 40]), material: grey };
  const hall = trisOf(`subtract shell {
  box outer size=20,8,12
  box inner size=19.4,7.4,11.4 at=0,0.3,0
  box door size=3,4,1 at=outer.front pin=center align=bottom
}
box slab size=19.4,0.3,11.4 at=0,4,0`);
  const parts = [{ name: 'hall', tris: hall, material: white }, ground];
  const out = reverse(parts, { srcFile: 'x.glb', fidelity: 'structure' });
  assert.deepEqual(compile(out.src).errors, []);
  assert.match(out.src, /^group hall [^\n]*\{\n  subtract shell \{\n    box outer size=20,8,12\n    box cavity size=19\.4,7\.4,11\.4 at=0,0\.3,0\n    box opening size=3,4,[\d.]+ at=0,0,[\d.]+\n  \}\n  box slab size=19\.4,0\.3,11\.4 at=0,4,0\n\}/m, out.src);
  assert.equal(out.report.shells.length, 1);
  const S = (o) => score({ result: compile(o.src), files: [{ file: 'x.s3d', text: o.src }], sourceParts: parts, consts: { delta: 0.05 } }).S;
  const panels = reverse(parts, { srcFile: 'x.glb', fidelity: 'structure', shells: false });
  assert.ok(S(out) < S(panels), `外壳 ${S(out)} < 板件 ${S(panels)}`);
  // 敞开的底面、带拱的门洞（spaceport 的厂房）
  const shed = trisOf(`subtract body {
  box outer size=34,22,26
  box inner size=32.4,21.2,24.4
  box opening size=12,15.4,2.4 at=outer.front pin=center align=bottom
  cyl arch r=6 h=2.4 axis=z at=opening.top pin=center
}`);
  const o2 = reverse([{ name: 'shed', tris: shed, material: white }, ground], { srcFile: 'x.glb', fidelity: 'structure' });
  assert.deepEqual(compile(o2.src).errors, []);
  const m = /^subtract shed [^\n]*\{\n  box outer size=34,22,26\n  box cavity size=32\.4,([\d.]+),24\.4 at=0,(-?[\d.]+),0\n  box opening size=([\d.]+),([\d.]+),[\d.]+ at=0,0,[\d.]+\n  cyl arch r=([\d.]+) h=[\d.]+ axis=z at=0,([\d.]+),[\d.]+\n\}/m.exec(o2.src);
  assert.ok(m, o2.src);
  assert.ok(+m[2] < 0 && Math.abs(+m[1] + +m[2] - 21.2) < 0.1, `空腔从地面下穿出（底面敞开），顶在 21.2：${m[1]} ${m[2]}`);
  assert.ok(Math.abs(+m[3] - 12) < 0.3 && Math.abs(+m[5] - 6) < 0.15 && Math.abs(+m[6] + +m[5] - 15.4) < 0.3, `门洞 12 宽、拱半径 6、拱心高 15.4：${m.slice(3)}`);
  assert.equal(reverse(parts, { srcFile: 'x.glb', fidelity: 'semantic' }).report.shells.length, 0, '语义档仍用基本体当代理');
});

test('基本体之并：圆柱与整球焊在一起的罐写成 group { cyl ; sphere }，埋在里面的面也解释了；同样的三个罐成阵列；空腔不算实心块', () => {
  const white = { name: 'white', color: '#ffffff' }, grey = { name: 'grey', color: '#808080' };
  const ground = { name: 'ground', tris: cubeTris([-40, -1, -40], [60, 0, 40]), material: grey };
  // 合批（L2）：同材质的圆柱与球拼成一个网格，球的赤道与圆柱的顶边共用顶点，下半球与顶盖埋在里面
  const src = `material white color=#ffffff
material grey color=#808080
box ground size=100,1,80 at=10,-1,0 mat=grey
repeat tanks n=3 step=10,0,0 at=0,0,0 mat=white {
  cyl tank r=3.5 h=9
  sphere cap r=3.5 on=tank gap=-3.5
}`;
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L2' }).doc);
  const out = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'structure' });
  assert.deepEqual(compile(out.src).errors, []);
  assert.ok(out.report.unions.length === 3 && out.report.unions.every((u) => u.prims === 2), JSON.stringify(out.report.unions));
  assert.match(out.src, /^repeat \S+ n=3 step=10,0,0 [^\n]*\{\n  group \S+[^\n]*\{\n    cyl \S+ r=3\.5 h=9\n    sphere \S+ r=3\.5 at=0,5\.5,0\n  \}\n\}/m, out.src);
  const S = (o) => score({ result: compile(o.src), files: [{ file: 'x.s3d', text: o.src }], sourceParts: parts, consts: { delta: 0.05 } }).S;
  const plain = reverse(parts, { srcFile: 'x.glb', level: 'L2', fidelity: 'structure', unions: false });
  assert.ok(S(out) < 0.5 * S(plain), `${S(out)} 对 ${S(plain)}`);
});

test('扫掠：弯曲的路面、拱写成圆弧 + sweep，螺旋扶手、坡道写成螺旋 + sweep；凹的水池不当扫掠', () => {
  const rev = (file) => reverse(partsOfDocument(sceneToGLB(readFileSync(new URL(`../examples/${file}`, import.meta.url), 'utf8'), { level: 'L0' }).doc), { srcFile: 'x.glb', level: 'L0', fidelity: 'structure' }).src;
  const cv = rev('curves.s3d');
  assert.deepEqual(compile(cv).errors, []);
  const num = (re, s) => { const m = re.exec(s); assert.ok(m, `${re} 在\n${s.split('\n').filter((l) => /_path|^sweep/.test(l)).join('\n')}`); return m.slice(1).map(Number); };
  // 300° 的环形车道：r=40，截面 8 × 0.1
  const [r, a0, a1] = num(/^arc lane_path r=([\d.]+) angle=(-?[\d.]+),(-?[\d.]+) at=/m, cv);
  assert.ok(Math.abs(r - 40) < 0.2 && Math.abs(Math.abs(a1 - a0) - 300) < 6, `${r} ${a0} ${a1}`);
  const [w, t] = num(/^sweep lane path=lane_path section=([\d.]+),([\d.]+)/m, cv);
  assert.ok(Math.abs(w - 8) < 0.3 && Math.abs(t - 0.1) < 0.05, `${w} ${t}`);
  // 3 圈的螺旋扶手：r=9.4，螺距 4.5，圆截面 0.08
  const [hr, hp, ht] = num(/^helix garage_rail_path r=([\d.]+) pitch=([\d.]+) turns=(-?[\d.]+)/m, cv);
  assert.ok(Math.abs(hr - 9.4) < 0.1 && Math.abs(hp - 4.5) < 0.05 && Math.abs(Math.abs(ht) - 3) < 0.1, `${hr} ${hp} ${ht}`);
  assert.match(cv, /^sweep garage_rail path=garage_rail_path r=0\.08 /m);
  assert.match(cv, /^helix garage_ramp_path r=7(\.0\d)? /m, '螺旋坡道');
  // 竖直面里的半圆拱：起止角从小到大
  const [ar, b0, b1] = num(/^arc arch_path r=([\d.]+) angle=(-?[\d.]+),(-?[\d.]+) plane=xy /m, cv);
  assert.ok(Math.abs(ar - 8) < 0.1 && b0 < 5 && b1 > 175, `${ar} ${b0} ${b1}`);
  assert.doesNotMatch(cv, /^sweep plaza_basin /m, '凹的水池不是扫掠');
  // spaceport 的螺旋楼梯扶手：1 圈，r=2.1
  const sp = rev('spaceport.s3d');
  assert.match(sp, /^helix spiral_rail_path r=2\.1 pitch=6\.2\d* turns=(1|0\.99\d)/m);
  assert.match(sp, /^sweep spiral_rail path=spiral_rail_path r=0\.05 /m);
});

test('曲面锚点：B.top[u,w] 落在网格的真实表面（没有网格数据时退回包围盒并警告）、球顶；B.side[θ,v] 与 B.surface[θ,φ] 可以 against', () => {
  const src = `mesh hill src="x.glb#hill" size=20,4,20 pivot=0,0,0
box a size=1,1,1 on=hill.top[0.5,0]
sphere ball r=2 at=10,0,0
box c size=0.4,0.4,0.4 on=ball.top[0.25,0]
cyl tank r=3 h=8 at=-10,0,0
box pipe size=1,0.5,0.5 against=tank.side[90,0.5]
box d size=0.2,0.2,0.2 against=ball.surface[0,90]`;
  const bottom = (r, p) => r.nodes.find((n) => n.path === p).box.min;
  const flat = compile(src);
  assert.deepEqual(flat.errors, []);
  assert.equal(flat.warnings.length, 1, '没有网格数据：警告一次');
  assert.ok(Math.abs(bottom(flat, 'a')[1] - 4) < 1e-9, '退回包围盒的顶面');
  const r = compile(src, { heightAt: (s, x, z) => (s === 'x.glb#hill' ? 4 - 0.01 * (x * x + z * z) : null) });
  assert.deepEqual(r.warnings, []);
  assert.ok(Math.abs(bottom(r, 'a')[1] - 3.75) < 1e-9, `网格表面：${bottom(r, 'a')}`);
  assert.ok(Math.abs(bottom(r, 'c')[1] - (2 + Math.sqrt(4 - 0.25))) < 1e-9, '球顶');
  const pipe = r.nodes.find((n) => n.path === 'pipe').box;
  assert.ok(Math.abs(pipe.max[2] + 3) < 1e-9 && Math.abs((pipe.min[1] + pipe.max[1]) / 2 - 4) < 1e-9, `圆柱侧面 90°（−z 一侧）、半高：${JSON.stringify(pipe)}`);
  assert.ok(Math.abs(bottom(r, 'd')[1] - 4) < 1e-9, '球面的北极：贴上去的是底面');
  assert.match(compile('box a size=1,1,1\nbox b size=1,1,1 against=a.side[0,0.5]').errors[0].message, /没有侧面锚点/);
});

test('地形取点：立在起伏网格地形上的物体写成 on=地形.top[u,w]，编译后落在表面上；房间这类多层的网格不算地形', async () => {
  // 地形保留网格引用时才有曲面锚点：按引用价计（默认按真实信息量计价，地形也写成语言）
  const meshPrice = { terrain: 'ref', structure: 'ref' };
  const { heightField } = await import('../tools/heights.mjs');
  const H = (x, z) => 2 * Math.sin(x / 9) + 1.5 * Math.cos(z / 7);
  const grid = (f, y0 = 0) => { const t = [], N = 30, S = 2; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const P = (a, b) => [-30 + a * S, f(-30 + a * S, -30 + b * S) + y0, -30 + b * S]; t.push([P(i, j), P(i, j + 1), P(i + 1, j)], [P(i + 1, j), P(i, j + 1), P(i + 1, j + 1)]); } return t; };
  const grey = { name: 'grey', color: '#777777' }, red = { name: 'red', color: '#cc3333' };
  const crates = [[-12, 5], [3, -8], [14, 14], [-20, -18]];
  const parts = [{ name: 'terrain', tris: grid(H), material: grey }, ...crates.map(([x, z]) => ({ name: `crate_${x}_${z}`, tris: cubeTris([x - 1, H(x, z), z - 1], [x + 1, H(x, z) + 2, z + 1]), material: red }))];
  const out = reverse(parts, { srcFile: 'x.glb', fidelity: 'structure', meshPrice });
  assert.equal((out.src.match(/ on=terrain\.top\[-?[\d.]+,-?[\d.]+\]/g) ?? []).length, 4, out.src);
  const r = compile(out.src, { heightAt: heightField(parts) });
  assert.deepEqual(r.errors, []);
  for (const n of r.nodes.filter((x) => /crate/.test(x.path))) {
    const x = (n.box.min[0] + n.box.max[0]) / 2, z = (n.box.min[2] + n.box.max[2]) / 2;
    assert.ok(Math.abs(n.box.min[1] - H(x, z)) < 0.05, `${n.path} 离表面 ${n.box.min[1] - H(x, z)}`);
  }
  // 箱子立在“两层”网格（两层朝上的楼板，角上一根更高的柱子，包围盒的顶面不在楼板上）的上层：射线碰到的确实是上层楼板，
  // 但这个网格不是地形（朝上的面投影起来是两层），不写 .top[]；同样的布置换成单层的起伏地面就写
  const y3 = H(3, 3) + 3, crate2 = { name: 'crate', tris: cubeTris([2, y3, 2], [4, y3 + 2, 4]), material: red };
  const layered = [...grid(H), ...grid(H, 3), ...cubeTris([26, 0, 26], [28, 8, 28])];
  assert.doesNotMatch(reverse([{ name: 'room', tris: layered, material: grey }, crate2], { srcFile: 'x.glb', fidelity: 'structure', meshPrice }).src, /\.top\[/);
  const single = [...grid(H, 3), ...cubeTris([26, 0, 26], [28, 8, 28])];
  assert.match(reverse([{ name: 'ground', tris: single, material: grey }, crate2], { srcFile: 'x.glb', fidelity: 'structure', meshPrice }).src, /on=ground\.top\[/);
});

test('带内凹的旋转体：车削网格的环连成截面轮廓，水池写成 revolve profile=[(0,0); (5,0); (5.2,0.9); (4.7,0.9); (4.6,0.35); (0,0.35)]', () => {
  const src = `material stone color=#cfc8b8
box ground size=40,1,40 pin=top mat=stone
revolve basin profile=[(0,0); (5,0); (5.2,0.9); (4.7,0.9); (4.6,0.35); (0,0.35)] on=ground mat=stone`;
  const out = reverse(partsOfDocument(sceneToGLB(src, { level: 'L0' }).doc), { srcFile: 'x.glb', level: 'L0', fidelity: 'structure' });
  const m = /^revolve basin profile=\[([^\]]+)\]/m.exec(out.src);
  assert.ok(m, out.src);
  const prof = m[1].split(';').map((p) => p.replace(/[()\s]/g, '').split(',').map(Number));
  const want = [[0, 0], [5, 0], [5.2, 0.9], [4.7, 0.9], [4.6, 0.35], [0, 0.35]];
  assert.equal(prof.length, want.length, m[1]);
  prof.forEach((p, i) => assert.ok(Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) < 0.02, `${p} 对 ${want[i]}`));
});

test('侧面锚点：贴在罐体侧面上的接管、牌子写成 against=罐.side[θ,v]，与原文一致；插进圆柱里的不算贴着', () => {
  const src = `material white color=#eeeeee
material red color=#cc3333
box ground size=60,1,60 pin=top mat=white
cyl tank r=3 h=8 at=0,0,0 mat=white
box nozzle size=1.2,0.8,0.8 against=tank.side[37,0.6] turn=37 mat=red
box sign size=0.2,1,2 against=tank.side[200,0.3] turn=200 mat=red
box rod size=2,0.4,0.4 at=0,5,-3.5 mat=red`;
  for (const fidelity of ['structure', 'detail']) {
    const out = reverse(partsOfDocument(sceneToGLB(src, { level: 'L0' }).doc), { srcFile: 'x.glb', level: 'L0', fidelity });
    assert.deepEqual(compile(out.src).errors, []);
    assert.match(out.src, /^box nozzle \S+ against=tank\.side\[37,0\.6\] /m, out.src);
    assert.match(out.src, /^box sign \S+ against=tank\.side\[-160,0\.3\] /m);
    assert.doesNotMatch(out.src, /^box rod .*side\[/m, '插进罐里的杆不是贴着');
    assert.deepEqual(out.report.fallback, []);
  }
});
