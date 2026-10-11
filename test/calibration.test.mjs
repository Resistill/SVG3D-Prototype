// 校准回归（docs/PLAN2.md 3.3）：自评分数的序与真值评测一致；邻域评分与全场分数同向。单位换算、增量评分之后都要成立
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '../src/s3d.js';
import { sceneToGLB } from '../tools/export.mjs';
import { partsOfDocument, reverse } from '../tools/reverse.mjs';
import { score, scoreCache } from '../tools/score.mjs';
import { evaluate } from '../tools/eval.mjs';
import { runCommand } from '../tools/agent.mjs';

const read = (f) => readFileSync(new URL(`../examples/${f}`, import.meta.url), 'utf8');
const scored = (text, parts, cache = null) => score({ result: compile(text), files: [{ file: null, text }], sourceParts: parts, cache });

for (const file of ['spaceport.s3d', 'rotation.s3d']) {
  // 不压缩（关系、没有阵列）与全坐标相近而不是严格更低：精细档保留锚点，锚点比坐标多一个名字
  test(`校准序（${file}）：全网格基线 > 全坐标 ≈ 不压缩 > 完整逆向 > 手写原文；增量评分给出同样的分数`, () => {
    const src = read(file);
    const parts = partsOfDocument(sceneToGLB(src, { level: 'L0' }).doc);
    const full = reverse(parts, { srcFile: 'x.glb', level: 'L0' }), raw = reverse(parts, { srcFile: 'x.glb', level: 'L0', compress: false });
    const cache = scoreCache();
    const sFull = scored(full.src, parts, cache), sAbs = scored(full.absSrc, parts, cache), sRaw = scored(raw.src, parts, cache), sOrig = scored(src, parts, cache);
    const S = [sFull.S_mesh, sAbs.S, sFull.S, sOrig.S];
    for (let i = 1; i < S.length; i++) assert.ok(S[i] < S[i - 1], `严格递减：${S.join(' > ')}`);
    assert.ok(Math.abs(sRaw.S - sAbs.S) < 0.1 * sAbs.S && sRaw.S > sFull.S && sRaw.S < sFull.S_mesh, `不压缩 ${sRaw.S}：与全坐标 ${sAbs.S} 相近，在完整逆向与全网格之间`);
    // 增量（同一个缓存连续评了四个版本）与全量一致
    assert.equal(scored(full.src, parts).S, sFull.S);
    assert.equal(scored(src, parts).S, sOrig.S);
  });
}

test('L0 / L1 / L2 三档：L0 ≤ L1 < L2，与真值评测同序', () => {
  const src = read('spaceport.s3d');
  const rows = ['L0', 'L1', 'L2'].map((level) => {
    const parts = partsOfDocument(sceneToGLB(src, { level }).doc);
    const out = reverse(parts, { srcFile: 'x.glb', level });
    const ev = evaluate(src, out.src);
    return { level, S: scored(out.src, parts).S, ev: ev.description.statementRatio * (1 + ev.description.coordinateRatio), quality: [ev.kinds.accuracy, ev.compression.array.recall, ev.compression.mirror.recall] };
  });
  const [l0, l1, l2] = rows;
  // L1 只是抹去了名字：真值评测的指标几乎相同；分数 L0 不比 L1 差——角色按名字判（roles.mjs），L0 认得出路面是地形，
  // 网格按引用计价、保留弯道的网格引用；L1 没有名字，路面当结构拆开写。名字只会帮忙，不会添乱。
  // L2 合并了网格：真值评测的形状正确率、阵列召回、镜像召回至少一项更差，分数更高。
  // （语句数比不再能给 L2 排序：楼梯压成 span、大块的合并网格写成一个实心盒子之后，L2 的语句比 L0 还少，但几何差得多）
  assert.ok(l0.S <= 1.02 * l1.S && Math.abs(l0.ev - l1.ev) < 0.02 * l0.ev, JSON.stringify(rows));
  assert.ok(l2.S > Math.max(l0.S, l1.S) && l2.quality.some((q, k) => q < l0.quality[k]), JSON.stringify(rows));
});
