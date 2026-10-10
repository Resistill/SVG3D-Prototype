// 协作工具：自评分数、离屏渲染、工程与命令（docs/PLAN2.md M0a）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/s3d.js';
import { sceneToGLB } from '../tools/export.mjs';
import { partsOfDocument, reverse } from '../tools/reverse.mjs';
import { score, scoreCache, lineCost, numberCost } from '../tools/score.mjs';
import { sceneObjects } from '../tools/worldtris.mjs';
import { rasterize } from '../tools/raster.mjs';
import { runCommand } from '../tools/agent.mjs';
import { splitSource } from '../tools/split.mjs';

test('描述长度的计价：名字与关键字各 1，数字按小数位，注释与元数据不计', () => {
  assert.equal(numberCost('26'), 1);
  assert.equal(numberCost('31.5'), 1);
  assert.equal(numberCost('38.2711'), 2.5);
  assert.equal(numberCost('0.644711'), 3.5);
  assert.equal(lineCost('box leg size=0.6,48,0.6 on=pad offset=12.1,0,-6.1 mat=steel ~fit=1 ~src="x"  // 注释'), 14);
  assert.equal(lineCost('concept wall = kind(box)'), 0, '语义层不计');
  assert.equal(lineCost('// 只有注释'), 0);
});

const SCENE = `
  material steel color=#7f8b96
  box ground size=40,1,40 pin=top
  repeat posts n=6 step=3,0,0 on=ground[-0.2,1,0] { cyl post r=0.2 h=3 mat=steel }
  box shed size=6,3,4 on=ground[0.5,1,0.5]
  wedge roof size=6,1.5,4 on=shed
`;
const scored = (text, parts, delta) => score({ result: compile(text), files: [{ file: null, text }], sourceParts: parts, consts: delta ? { delta } : {} });

test('自评分数：压缩得越好分数越低；删掉物体、凭空加物体、全写成网格引用都更差', () => {
  const parts = partsOfDocument(sceneToGLB(SCENE, { level: 'L0' }).doc);
  const full = reverse(parts, { srcFile: 'x.glb' });
  const raw = reverse(parts, { srcFile: 'x.glb', compress: false });
  const sOrig = scored(SCENE, parts), sFull = scored(full.src, parts), sAbs = scored(full.absSrc, parts), sRaw = scored(raw.src, parts);
  assert.equal(sOrig.R_src + sOrig.R_recon, 0, '原文与源模型几何相同，残差为零');
  assert.ok(sOrig.S <= sFull.S + 1e-9, `原文 ${sOrig.S} ≤ 逆向 ${sFull.S}`);
  assert.ok(sFull.S < sAbs.S, `逆向 ${sFull.S} < 全坐标 ${sAbs.S}`);
  assert.ok(Math.abs(sRaw.S - sAbs.S) / sAbs.S < 0.1, `不压缩 ${sRaw.S} 与全坐标 ${sAbs.S} 相近`);
  assert.ok(sAbs.S < sFull.S_mesh, `全坐标 ${sAbs.S} < 全网格基线 ${sFull.S_mesh}`);
  assert.ok(sFull.explain > 0.5, `解释率 ${sFull.explain}`);
  // 作弊
  const dropped = scored(SCENE.replace(/^\s*wedge roof.*$/m, ''), parts);
  assert.ok(dropped.S > sOrig.S, `删掉屋顶 ${dropped.S} > ${sOrig.S}`);
  const phantom = scored(SCENE + '\nbox ghost size=3,3,3 at=10,0,10', parts);
  assert.ok(phantom.S > sOrig.S, `凭空加一个盒子 ${phantom.S} > ${sOrig.S}`);
  // 逐物体归因：屋顶被删掉后，源部件 roof 的代价落在离它最近的重建物体上
  assert.ok(dropped.sources.find((s) => s.name === 'roof').meanErr > 0.1);
});

test('离屏渲染：PNG、ID 图例、聚焦时只标被聚焦的物体', () => {
  const objs = sceneObjects(compile(SCENE));
  const c = rasterize(objs, { size: 256 });
  assert.deepEqual([...c.png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(c.png.readUInt32BE(16), 256);
  const id = rasterize(objs, { size: 128, mode: 'id' });
  assert.equal(id.legend.length, objs.length);
  const f = rasterize(objs, { size: 256, mode: 'labels', focus: 'posts' });
  assert.ok(f.legend.length >= 3 && f.legend.every((l) => l.path.startsWith('posts.')), JSON.stringify(f.legend));
});

test('工程：init → outline / inspect / select / similar / score / render；重跑逆向名字不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3d-'));
  const { doc, io } = sceneToGLB(SCENE, { level: 'L1' });
  const glb = join(dir, 'world.glb');
  writeFileSync(glb, await io.writeBinary(doc));
  const proj = join(dir, 'proj');
  const init = await runCommand('init', proj, { source: glb });
  assert.ok(init.parts >= 9 && init.arrays >= 1, JSON.stringify(init));
  for (const f of ['project.json', 'scene.s3d', 'base.s3d', 'edits.s3d', 'semantics.s3d', 'style.s3d', 'decisions.s3d']) assert.ok(existsSync(join(proj, f)), f);
  const ol = await runCommand('outline', proj, { depth: 1 });
  assert.deepEqual(ol.errors, []);
  assert.ok(ol.outline.some((l) => /repeat ×6/.test(l)), ol.outline.join('\n'));
  const sel = await runCommand('select', proj, { expr: 'kind(cyl)' });
  assert.equal(sel.members.length, 6);
  const [ins] = await runCommand('inspect', proj, { paths: [sel.members[2]] });
  assert.ok(ins.groups.some((g) => g.kind === 'repeat' && g.members === 6), JSON.stringify(ins.groups));
  assert.ok(ins.facts.some((f) => f.rel === 'on'));
  const sim = await runCommand('similar', proj, { paths: [sel.members[0]] });
  assert.equal(sim.count, 6);
  const sc = await runCommand('score', proj, {});
  assert.ok(sc.S > 0 && sc.explain > 0.5, JSON.stringify(sc));
  assert.ok(existsSync(join(proj, 'score.json')));
  const re = await runCommand('render', proj, { view: 'top', mode: 'labels', size: 256 });
  assert.ok(existsSync(re.file) && re.legend.length >= 2, JSON.stringify(re.legend));
  const base0 = readFileSync(join(proj, 'base.s3d'), 'utf8');
  await runCommand('reverse', proj, {});
  assert.equal(readFileSync(join(proj, 'base.s3d'), 'utf8'), base0, '确定性：重跑逆向得到同样的 base.s3d');
});

test('提议：propose → preview → accept 写进修改层；有编译错误的不能接受；reject 的理由进收件箱；MCP 与 CLI 同一张命令表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3d-'));
  const { doc, io } = sceneToGLB(SCENE, { level: 'L0' });
  const glb = join(dir, 'world.glb');
  writeFileSync(glb, await io.writeBinary(doc));
  const proj = join(dir, 'proj');
  await runCommand('init', proj, { source: glb });
  // 删掉屋顶：分数应该变差（源模型里有屋顶）
  const bad = await runCommand('propose', proj, { text: 'drop roof', why: '试试', title: 'drop' });
  assert.ok(bad.delta > 0, JSON.stringify(bad));
  await runCommand('reject', proj, { id: bad.id, why: '分数变差' });
  const inbox = await runCommand('inbox', proj, {});
  assert.equal(inbox.at(-1).why, '分数变差');
  // 引用不存在的物体：不能接受
  const broken = await runCommand('propose', proj, { text: 'over nothing_here mat=steel\\nbox x size=1,1,1 on=nothing_here' });
  assert.ok(broken.errors.length > 0);
  await assert.rejects(() => runCommand('accept', proj, { id: broken.id }), /编译错误/);
  await runCommand('reject', proj, { id: broken.id, why: '有错误' });
  // 正常的修改：接受后写进 edits.s3d，提议移到 accepted/
  const ok = await runCommand('propose', proj, { text: 'over shed color=#aa3333', why: '换个颜色' });
  assert.deepEqual(ok.errors, []);
  const acc = await runCommand('accept', proj, { id: ok.id });
  assert.equal(acc.accepted, ok.id);
  assert.match(readFileSync(join(proj, 'edits.s3d'), 'utf8'), /over shed color=#aa3333/);
  assert.deepEqual(await runCommand('proposals', proj, {}), []);
  assert.ok(readFileSync(join(proj, 'state/log.jsonl'), 'utf8').split('\n').filter(Boolean).length >= 6, '每次调用都有日志');
  // MCP：tools/list 来自同一张命令表；render 附带图像
  const { serve } = await import('../tools/mcp.mjs');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough(), output = new PassThrough();
  let buf = '';
  output.on('data', (d) => (buf += d));
  serve({ project: proj, input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 's3d_render', arguments: { view: 'top', size: '128' } } }) + '\n');
  for (let i = 0; i < 100 && buf.split('\n').filter(Boolean).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
  const msgs = buf.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(msgs.find((m) => m.id === 1).result.tools.some((t) => t.name === 's3d_score'));
  assert.ok(msgs.find((m) => m.id === 2).result.content.some((c) => c.type === 'image'));
  input.end();
});

test('档位：semantic 一律用基本体当语义代理、数字更短，阵列照样保留；每个档位在自己的 δ 下更好', async () => {
  const src = SCENE + `
    revolve vase profile=[(0,0); (1.2,0.3); (0.6,1.5); (0.9,2.6); (0,2.7)] smooth=true on=ground[0.3,1,-0.4]
    repeat lamps n=5 step=0,0,4.3137 on=ground[-0.4,1,-0.3] { cyl pole r=0.12 h=3.1 }
  `;
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L0' }).doc);
  const out = Object.fromEntries(['detail', 'structure', 'semantic'].map((f) => [f, reverse(parts, { srcFile: 'x.glb', fidelity: f })]));
  assert.match(out.detail.src, /^mesh vase /m, '精细档：花瓶保留为网格引用');
  assert.match(out.semantic.src, /^(cyl|cone|box|sphere|wedge) vase /m, '语义档：花瓶用基本体代替');
  for (const f of Object.keys(out)) assert.ok(out[f].report.arrays.length >= 2, `${f} 保留阵列：${JSON.stringify(out[f].report.arrays)}`);
  const at = (f, delta) => scored(out[f].src, parts, delta);
  const L = (f) => at(f, 0.005).L_stmt;
  assert.ok(L('semantic') < L('detail'), `语义档更短：${L('semantic')} < ${L('detail')}`);
  assert.ok(at('semantic', 0.25).S < at('detail', 0.25).S, '粗的 δ 下语义档更好');
  assert.ok(at('detail', 0.005).S < at('semantic', 0.005).S, '细的 δ 下精细档更好');
});

test('细化：两柱一梁的类型被拆成部件（同名扩展 + 名义外包络），挂在它上面的物体不动，按目标档位评分变好', async () => {
  const { Document } = await import('@gltf-transform/core');
  const doc = new Document(), buf = doc.createBuffer();
  const v = [];
  const box = (cx, cy, cz, w, h, d) => {
    const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]].map(([x, y, z]) => [cx + (x - 0.5) * w, cy + y * h, cz + (z - 0.5) * d]);
    for (const [a, b, cc, dd] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]]) v.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[dd]);
  };
  box(-3, 0, 0, 1, 5, 1); box(3, 0, 0, 1, 5, 1); box(0, 5, 0, 7, 1, 1); // 两柱一梁（三块互不相连）
  const gate = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(v)).setBuffer(buf)));
  const gv = []; v.length = 0; box(0, -1, 0, 60, 1, 60); gv.push(...v);
  const ground = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(gv)).setBuffer(buf)));
  const scene = doc.createScene();
  scene.addChild(doc.createNode('Ground').setMesh(ground));
  for (const x of [-15, 0, 15]) scene.addChild(doc.createNode('Gate').setMesh(gate).setTranslation([x, 0, 0]));
  const dir = mkdtempSync(join(tmpdir(), 's3d-')), glb = join(dir, 'gates.glb');
  writeFileSync(glb, await new (await import('@gltf-transform/core')).NodeIO().writeBinary(doc));
  const proj = join(dir, 'p');
  await runCommand('init', proj, { source: glb, fidelity: 'semantic' });
  const base = readFileSync(join(proj, 'base.s3d'), 'utf8');
  assert.match(base, /^def Gate \{/m, '三个门是一个类型');
  const { openProject } = await import('../tools/project.mjs');
  // 三扇门等距，可能被写成阵列：从编译结果里找 Gate 类型的实例
  const insts = openProject(proj).compile().nodes.filter((n) => n.types?.[0] === 'Gate').map((n) => n.path);
  assert.equal(insts.length, 3);
  // 一个挂在门上的物体：细化前后位置不变
  writeFileSync(join(proj, 'edits.s3d'), readFileSync(join(proj, 'edits.s3d'), 'utf8') + `\nbox sign size=1,1,0.2 on=${insts[1]}[0.5,1,0]\n`);
  const before = openProject(proj).compile().nodes.find((n) => n.path === 'sign').box;
  const [r] = await runCommand('refine', proj, { paths: [insts[1]], to: 'structure', apply: true });
  assert.equal(r.kind, 'type', JSON.stringify(r));
  assert.ok(r.boxes >= 3, JSON.stringify(r));
  assert.ok(r.delta < 0 && r.accepted, `按结构档评分应变好：${JSON.stringify(r)}`);
  const edits = readFileSync(join(proj, 'edits.s3d'), 'utf8');
  assert.match(edits, /def Gate : Gate \{\n  drop body\n  group body envelope=/);
  const after = openProject(proj).compile();
  assert.deepEqual(after.errors, []);
  assert.deepEqual(after.nodes.find((n) => n.path === 'sign').box, before, '挂在门上的牌子不动（骨架保留）');
  assert.ok(after.items.filter((i) => i.path.startsWith(insts[2] + '.')).length >= 3, '所有实例一起变细');
  // 自动细化：结果写进独立的文件 edits/refine-<目标>.s3d，修改层只多一行 import；分数照样计入
  const proj2 = join(dir, 'p2');
  await runCommand('init', proj2, { source: glb, fidelity: 'semantic' });
  const auto = await runCommand('refine', proj2, { auto: true, budget: 2, to: 'structure' });
  const acc = auto.log.filter((l) => l.accepted);
  assert.ok(acc.length >= 1 && auto.end < auto.start, JSON.stringify(auto));
  const edits2 = readFileSync(join(proj2, 'edits.s3d'), 'utf8');
  for (const l of acc) {
    assert.ok(edits2.includes(`import "${l.file}"`), edits2);
    assert.match(readFileSync(join(proj2, l.file), 'utf8'), /^(def|over) /m);
  }
  assert.doesNotMatch(edits2, /^(def|over) /m, '修改层里只有 import');
});

const SPREAD = `
  material steel color=#7f8b96
  box ground size=200,1,40 pin=top
` + [-80, -20, 40].map((x, i) => `  box shed${i} size=6,3,4 on=ground at=${x},0,0
  wedge roof${i} size=6,1.5,4 on=shed${i}
  cyl tank${i} r=1 h=4 on=ground at=${x + 8},0,5 mat=steel
`).join("");

test('文件拆分：基础层超过 splitLines 行就拆成 base/ 下的类型文件与空间分区，编译结果与分数不变，重跑逆向名字不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3d-'));
  const { doc, io } = sceneToGLB(SPREAD, { level: 'L1' });
  const glb = join(dir, 'world.glb');
  writeFileSync(glb, await io.writeBinary(doc));
  const proj = join(dir, 'proj');
  await runCommand('init', proj, { source: glb });
  const one = await runCommand('score', proj, {});
  const nodes0 = (await runCommand('outline', proj, { depth: 9 })).outline.length;
  const cfgPath = join(proj, 'project.json');
  writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf8')), splitLines: 6 }));
  await runCommand('reverse', proj, {});
  const index = readFileSync(join(proj, 'base.s3d'), 'utf8');
  const imports = [...index.matchAll(/^import "([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.length >= 3 && imports.every((f) => f.startsWith('base/') && existsSync(join(proj, f))), index);
  assert.ok(!/^\s*(box|cyl|repeat)\s/m.test(index), '索引里只有 import');
  const two = await runCommand('score', proj, {});
  assert.equal(two.S, one.S, '拆分不改变分数');
  assert.equal((await runCommand('outline', proj, { depth: 9 })).outline.length, nodes0);
  const files0 = imports.map((f) => readFileSync(join(proj, f), 'utf8')).join('\n');
  await runCommand('reverse', proj, {});
  assert.equal(imports.map((f) => readFileSync(join(proj, f), 'utf8')).join('\n'), files0, '重跑逆向：拼回的旧文本作为名字记忆，结果不变');
});

test('场景单位：init 按部件尺寸猜单位（厘米场景猜成 0.01）并提示确认；分数与米制工程一致；reverse --unit 改单位', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3d-'));
  const make = async (name, k) => {
    const { doc, io } = sceneToGLB(SCENE, { level: 'L1' });
    for (const scene of doc.getRoot().listScenes()) {
      const top = doc.createNode('units').setScale([k, k, k]);
      for (const c of scene.listChildren()) { scene.removeChild(c); top.addChild(c); }
      scene.addChild(top);
    }
    const glb = join(dir, name + '.glb');
    writeFileSync(glb, await io.writeBinary(doc));
    return glb;
  };
  const m = await runCommand('init', join(dir, 'm'), { source: await make('m', 1) });
  const cm = await runCommand('init', join(dir, 'cm'), { source: await make('cm', 100) });
  assert.equal(m.unit, 1);
  assert.equal(cm.unit, 0.01, JSON.stringify(cm));
  assert.match(cm.unitNote, /0.01 米/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'cm', 'project.json'), 'utf8')).unit, 0.01);
  // 写进文件的相对路径用正斜杠（Windows 上也是）：浏览器加载源网格、语义库都靠它
  assert.ok(!JSON.parse(readFileSync(join(dir, 'cm', 'project.json'), 'utf8')).source.includes(String.fromCharCode(92)));
  assert.match(readFileSync(join(dir, 'cm', 'semantics.s3d'), 'utf8'), /import "[^"\\]*lib\/semantics\.s3d"/);
  assert.equal(cm.arrays, m.arrays);
  const sm = await runCommand('score', join(dir, 'm'), { objects: true }), scm = await runCommand('score', join(dir, 'cm'), { objects: true });
  assert.equal(scm.consts.delta, sm.consts.delta, 'δ 按米记录，两个工程相同');
  const R = (x) => x.R_src + x.R_recon;
  assert.ok(Math.abs(R(scm) - R(sm)) <= 0.01 * R(sm) + 0.5, `残差 ${R(scm)} 对 ${R(sm)}`);
  // 误差按米输出：两边同一个源部件的误差一样
  const err = (x, n) => x.sources.find((y) => y.name === n)?.meanErr;
  for (const s0 of sm.sources) assert.ok(Math.abs(err(scm, s0.name) - s0.meanErr) < 1e-3, s0.name);
  // 改单位：写进 project.json，评分随之换算
  const re = await runCommand('reverse', join(dir, 'cm'), { unit: 1, fresh: true });
  assert.equal(re.unit, 1);
  assert.equal(JSON.parse(readFileSync(join(dir, 'cm', 'project.json'), 'utf8')).unit, 1);
  await assert.rejects(runCommand('reverse', join(dir, 'cm'), { unit: -2 }), /unit/);
  const wrong = await runCommand('score', join(dir, 'cm'), {});
  assert.equal(wrong.consts.unit, 1);
  assert.equal(wrong.consts.delta, scm.consts.delta, 'δ 仍按米');
});

test('增量评分：连续改动（删除、换形、新材质、移动、恢复）时与全量评分逐位一致，只重算受影响的部分', () => {
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  const parts = partsOfDocument(sceneToGLB(src, { level: 'L0' }).doc);
  const base = reverse(parts, { srcFile: 'x.glb', fidelity: 'structure' }).src;
  const cache = scoreCache();
  const steps = [
    base,
    base + '\ndrop spare\n',
    base + '\nover pad : box size=30,1,30\n',
    base + '\nmaterial ruby color=#cc2244\nover hangar_body mat=ruby\n',
    base + '\nmaterial ruby color=#cc2244\nover hangar_body mat=ruby\nover bunker at=0,0,0\n',
    base,
  ];
  // 并列（到两个物体的距离相同）时的归属取决于 BVH 的结构，不要求一致；代价、误差逐位一致
  const strip = (x) => JSON.stringify({ ...x, objects: x.objects.map(({ src: _s, rSrc: _r, total: _t, meanErr: _m, maxErr: _x, ...o }) => o), worst: null, sources: x.sources.map(({ explainedBy: _e, ...y }) => y) });
  for (const [i, text] of steps.entries()) {
    const r = compile(text);
    assert.deepEqual(r.errors, [], `第 ${i} 步`);
    const full = score({ result: r, files: [{ file: null, text }], sourceParts: parts, consts: { delta: 0.05 } });
    const inc = score({ result: r, files: [{ file: null, text }], sourceParts: parts, consts: { delta: 0.05 }, cache });
    assert.equal(inc.S, full.S, `第 ${i} 步`);
    assert.equal(strip(inc), strip(full), `第 ${i} 步`);
  }
  // 常数不同各自一份状态，互不干扰
  const r = compile(base);
  assert.equal(score({ result: r, files: [{ file: null, text: base }], sourceParts: parts, consts: { delta: 0.25 }, cache }).S,
    score({ result: r, files: [{ file: null, text: base }], sourceParts: parts, consts: { delta: 0.25 } }).S);
});

test('文件拆分按楼栋聚组：立在楼上、在楼里的物体与楼进同一个文件；地面这样的大面不当组的根', () => {
  const lines = ['box ground size=400,1,400 pin=top'];
  // 两栋楼隔得很远；每栋楼里摆几件东西（锚点定位，不写 on=），另有一件立在楼顶上
  for (const [b, x] of [['hall', -120], ['depot', 120]]) {
    lines.push(`box ${b} size=30,10,30 at=${x},0,0`);
    for (let i = 0; i < 4; i++) lines.push(`box ${b}_crate_${i} size=1,1,1 at=${x - 10 + 6 * i},0,5`);
    lines.push(`cyl ${b}_vent r=0.5 h=2 on=${b}`);
  }
  // 中间散放的东西：不属于哪栋楼
  for (let i = 0; i < 6; i++) lines.push(`box rock_${i} size=2,2,2 at=${-15 + 6 * i},0,80`);
  const text = lines.join('\n') + '\n';
  const sp = splitSource(text, { maxLines: 8 });
  assert.ok(sp, '超过行数上限，要拆');
  const fileOf = (name) => Object.entries(sp.files).find(([, t]) => new RegExp(`^\\S+ ${name} `, 'm').test(t))?.[0];
  for (const b of ['hall', 'depot']) {
    const f = fileOf(b);
    for (const m of [...[0, 1, 2, 3].map((i) => `${b}_crate_${i}`), `${b}_vent`]) assert.equal(fileOf(m), f, `${m} 与 ${b} 同一个文件`);
  }
  assert.notEqual(fileOf('hall'), fileOf('depot'));
  // 拆分不改变编译结果
  const files = { ...sp.files, 'base.s3d': sp.index };
  const r = compile(sp.index, { file: 'base.s3d', resolve: (p) => files[p] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.nodes.length, compile(text).nodes.length);
});
