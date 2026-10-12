// 闭环（续）：场景单位、并行拟合
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

// 把整个场景挂到一个缩放过的父节点下：同一个世界，换一种长度单位（k = 每米多少个场景单位）
const rescale = (doc, k) => {
  for (const scene of doc.getRoot().listScenes()) {
    const top = doc.createNode('units').setScale([k, k, k]);
    for (const c of scene.listChildren()) { scene.removeChild(c); top.addChild(c); }
    scene.addChild(top);
  }
  return doc;
};

test('场景单位：同一个场景按米、stud（0.28 m）、厘米逆向，形状、阵列、镜像一致，残差分数基本不变', () => {
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
      // 数字按“不粗于米制分辨率的 3 倍”取整，单位不同取整的步长也不同（语义档在 stud 下是整数），残差允许差几个百分点
      // （结构档 stud 下的差别全在整流罩 revolve 的轮廓：0.1 stud 一位小数对 0.01 m 两位）
      assert.ok(Math.abs(x.R - runs[0].R) < 0.04 * runs[0].R, `${fidelity} unit=${x.unit} 残差 ${x.R} 对 ${runs[0].R}`);
    }
  }
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
  // 组合写法（板件、外壳、并、小场景）也在 worker 里预先算：结果同样逐字一致；源文件名不同时不取用
  const pc = await prefit(parts, { fidelity: 'structure', unit: 1, threads: 3, min: 0, composite: { srcFile: 'x.glb' } });
  assert.equal(reverse(parts, { srcFile: 'x.glb', level: 'L1', fidelity: 'structure', prefit: pc }).src, a.src);
  assert.ok([...parts.keys()].some((i) => pc.compOf(parts[i], i, { srcFile: 'x.glb', panels: true, shells: true, unions: true, subs: true, plates: true, hulls: true })?.out), '有部件用上了预先算的组合写法');
  assert.equal(pc.compOf(parts[0], 0, { srcFile: 'y.glb', panels: true, shells: true, unions: true, subs: true, plates: true, hulls: true }), undefined);
});

test('分块逆向：k-d 划分成几块并行逆向后合并，零编译错误；材质与类型只声明一次、物体不重名；分数与整体逆向相差不大', async () => {
  const { reverseTiled, splitTiles, mergeTiles } = await import('../tools/tiles.mjs');
  // 2×2 个 spaceport（同一个网格的享元跨块出现：类型体要逐字相同才合并成一个 def）
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  const lines = src.split(/\r?\n/), top = [], body = [];
  const count = (x, ch) => x.split(ch).length - 1;
  for (let i = 0; i < lines.length; i++) { const l = lines[i]; if (/^material /.test(l)) { top.push(l); continue; } if (/^def /.test(l)) { let d = 0; do { const x = lines[i]; top.push(x); d += count(x, '{') - count(x, '}'); } while (d > 0 && ++i < lines.length); continue; } body.push(l); }
  const scene = [...top, 'def port {', ...body.map((l) => '  ' + l), '}', 'port a at=0,0,0', 'port b at=260,0,0 turn=90', 'port c at=0,0,260', 'port d at=260,0,260 turn=30'].join('\n');
  const parts = partsOfDocument(sceneToGLB(scene, { level: 'L1' }).doc);
  const t = splitTiles(parts, 120);
  assert.ok(t.length >= 4 && t.every((x) => x.length <= 120) && t.flat().length === parts.length, '每块不超过上限，部件不重不漏');
  const one = reverse(parts, { srcFile: 'x.glb', fidelity: 'structure' });
  const tiled = await reverseTiled(parts, { srcFile: 'x.glb', fidelity: 'structure' }, { maxParts: 120, threads: 2 });
  const r = compile(tiled.src);
  assert.deepEqual(r.errors, []);
  const decls = tiled.src.split('\n').map((l) => /^(\S+)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(l)).filter((m) => m && !['drop', 'over'].includes(m[1])).map((m) => m[2]);
  assert.equal(new Set(decls).size, decls.length, '顶层名字不重复');
  assert.equal(tiled.report.tiles.length, t.length);
  const S = (out) => score({ result: compile(out.src), files: [{ file: null, text: out.src }], sourceParts: parts, consts: { delta: 0.05 } }).S;
  assert.ok(S(tiled) < 1.15 * S(one), `分块 ${S(tiled)} 对整体 ${S(one)}`);
  // 合并：同名同文的材质、类型共用；同名不同文的、重名的物体在后来的那块里改名（引号里的 ~src 不动）
  const m = mergeTiles(['// h\nmaterial m color=#111111\ndef T {\n  box body size=1,1,1\n}\nT a at=0,0,0\nbox b size=1,1,1 on=a ~src="a"', '// h\nmaterial m color=#111111\nmaterial n color=#222222\ndef T {\n  box body size=2,2,2\n}\nT a at=5,0,0\nbox c size=1,1,1 on=a mat=n ~src="a"']);
  assert.deepEqual(compile(m).errors, []);
  assert.equal((m.match(/^material m /gm) ?? []).length, 1);
  assert.match(m, /^def T_2 \{\n  box body size=2,2,2/m);
  assert.match(m, /^T_2 a_2 at=5,0,0$/m);
  assert.match(m, /^box c size=1,1,1 on=a_2 mat=n ~src="a"$/m);
});

test('分块合并：同名不同体的类型改名时，路径里指向类型体子物体的段跟着改（不留悬空引用）', async () => {
  const { mergeTiles } = await import('../tools/tiles.mjs');
  const a = '// x\ndef Post {\n  box body size=1,2,1\n}\nPost p1 at=0,0,0\n';
  const b = '// x\ndef Post {\n  box body size=1,3,1\n}\nrepeat row n=2 step=2,0,0 {\n  Post Post at=5,0,0\n}\nbox sign size=1,1,1 on=row.0.Post\n';
  const src = mergeTiles([a, b]);
  assert.deepEqual(compile(src).errors, [], src);
  assert.match(src, /on=row\.0\.Post_2/, src);
});
