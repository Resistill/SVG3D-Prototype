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
      assert.ok(Math.abs(x.R - runs[0].R) < 0.03 * runs[0].R, `${fidelity} unit=${x.unit} 残差 ${x.R} 对 ${runs[0].R}`);
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
});
