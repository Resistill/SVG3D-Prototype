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
const scored = (text, parts) => score({ result: compile(text), files: [{ file: null, text }], sourceParts: parts });

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
