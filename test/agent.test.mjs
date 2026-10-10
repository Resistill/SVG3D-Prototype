// 协作工具：自评分数、离屏渲染、工程与命令（docs/PLAN2.md M0a）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/s3d.js';
import { sceneToGLB } from '../tools/export.mjs';
import { partsOfDocument, reverse } from '../tools/reverse.mjs';
import { score, lineCost, numberCost } from '../tools/score.mjs';
import { sceneObjects } from '../tools/worldtris.mjs';
import { rasterize } from '../tools/raster.mjs';
import { runCommand } from '../tools/agent.mjs';

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
