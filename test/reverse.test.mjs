// 闭环：示例场景 → GLB → 逆向 → 与原始描述比对
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sceneToGLB } from '../tools/export.mjs';
import { partsOfDocument, reverse } from '../tools/reverse.mjs';
import { evaluate } from '../tools/eval.mjs';

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
  assert.equal(ev.kinds.complexAsMesh, ev.kinds.complex, '复杂形状都保留为源网格引用');
  assert.ok(ev.facts.onAgainst.f1 >= 0.9, `on/against F1 ${ev.facts.onAgainst.f1}`);
  assert.ok(ev.description.coordinateRatio < 0.1, `坐标依赖率 ${ev.description.coordinateRatio}`);
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
