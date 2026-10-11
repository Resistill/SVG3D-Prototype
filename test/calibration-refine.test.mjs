// 校准回归（续）：邻域评分与全场分数同向（自动细化的每一步）
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

test('邻域评分与全场分数同向：自动细化的每一步，普通物体两者相差不到 1', async () => {
  const dir = mkdtempSync(join(tmpdir(), 's3d-cal-'));
  const { doc, io } = sceneToGLB(read('spaceport.s3d'), { level: 'L2' });
  const glb = join(dir, 'world.glb');
  writeFileSync(glb, await io.writeBinary(doc));
  await runCommand('init', join(dir, 'p'), { source: glb, fidelity: 'semantic', unit: 1 });
  const res = await runCommand('refine', join(dir, 'p'), { auto: true, budget: 4, to: 'structure' });
  const steps = res.log.filter((l) => l.delta != null);
  assert.ok(steps.length >= 1, JSON.stringify(res.log));
  for (const l of steps) {
    assert.equal(Math.sign(l.local), Math.sign(l.delta), JSON.stringify(l));
    if (l.kind === 'object') assert.ok(Math.abs(l.local - l.delta) < 1, JSON.stringify(l));
  }
});
