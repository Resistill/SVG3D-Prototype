// 体积误差（tools/volume.mjs）与“大部件当小场景”（tools/reverse.mjs 的 trySubScene）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { surfaces } from '../tools/surfaces.mjs';
import { interiorSamples, insideSource, volumeResidual } from '../tools/volume.mjs';
import { score } from '../tools/score.mjs';
import { reverse } from '../tools/reverse.mjs';
import { compile } from '../src/s3d.js';

// 轴对齐的盒子，法线朝外：三角形数组与三角形汤两种写法
const boxTris = ([x0, y0, z0], [x1, y1, z1]) => {
  const v = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6]];
  return quads.flatMap(([a, b, c, d]) => [[v(a), v(b), v(c)], [v(a), v(c), v(d)]]);
};
const soup = (tris) => Float32Array.from(tris.flat(2));
// 一个空房间：四面实心的墙（墙角互相穿插）加屋顶，中间是空的；旁边一根实心柱子
const room = [boxTris([3, 0, 0], [13, 3, 0.3]), boxTris([3, 0, 9.7], [13, 3, 10]), boxTris([3, 0, 0], [3.3, 3, 10]), boxTris([12.7, 0, 0], [13, 3, 10]), boxTris([3, 3, 0], [13, 3.3, 10])];
const pillar = boxTris([0, 0, 0], [1, 3, 1]);

test('在不在源模型的实体里：实心柱子、墙里、墙角（几块实心的墙互相穿插）算；房间里、外面不算', () => {
  const q = surfaces([pillar, ...room].map((t) => ({ pos: soup(t), color: null }))).all.q;
  assert.equal(insideSource(q, 0.5, 1.5, 0.5), true);
  assert.equal(insideSource(q, 8, 1.5, 0.15), true);
  assert.equal(insideSource(q, 3.15, 1.5, 0.15), true);
  assert.equal(insideSource(q, 8, 1.5, 5), false);
  assert.equal(insideSource(q, 20, 1, 1), false);
  const k = { delta: 0.05, dMax: 2 };
  const solidRoom = interiorSamples(soup(boxTris([3, 0, 0], [13, 3.3, 10])), k, 1), solidPillar = interiorSamples(soup(pillar), k, 2);
  assert.ok(volumeResidual(solidRoom.pts, q, k) > 2, '实心体块填满了房间');
  assert.equal(volumeResidual(solidPillar.pts, q, k), 0, '柱子本来就是实心的');
  assert.equal(interiorSamples(soup(boxTris([3, 0, 0], [13, 3, 0.03])), k, 3), null, '薄的物体不撒点');
});

test('体积误差进评分：实心体块盖住空房间比写成墙与屋顶贵；墙板写法几乎没有体积误差', () => {
  const parts = [{ name: 'room', tris: room.flat(), material: { name: 'm', color: '#888888' } }];
  const S = (text) => score({ result: compile(text), files: [{ file: null, text }], sourceParts: parts, consts: { delta: 0.05 } });
  const solid = S('box room size=10,3.3,10 at=8,0,5');
  const walls = S(['box w1 size=10,3,0.3 at=8,0,0.15', 'box w2 size=10,3,0.3 at=8,0,9.85', 'box w3 size=0.3,3,10 at=3.15,0,5', 'box w4 size=0.3,3,10 at=12.85,0,5', 'box roof size=10,0.3,10 at=8,3,5'].join('\n'));
  assert.ok(solid.R_vol > 100, `实心：${solid.R_vol}`);
  assert.ok(walls.R_vol < 1, `墙板：${walls.R_vol}`);
  assert.ok(walls.S < solid.S, `${walls.S} < ${solid.S}`);
});

test('大部件当小场景：一个模型里 70 根一样的柱子排成一排（散得太多，不拆成一组盒子），写成组里的一条 repeat', () => {
  const tris = Array.from({ length: 70 }, (_, k) => boxTris([2 * k, 0, 0], [2 * k + 0.3, 2.5, 0.3])).flat();
  const out = reverse([{ name: 'Fence_Posts_01', tris, material: { name: 'm', color: '#888888' } }], { srcFile: 'x.glb', fidelity: 'structure' });
  assert.deepEqual(compile(out.src).errors, []);
  assert.equal(out.report.subs.length, 1, out.src);
  assert.match(out.src, /^group Fence_Posts_01 [^\n]*\{\n\s+repeat \S+ n=70 step=2,0,0/m, out.src);
  assert.doesNotMatch(out.src, /^mesh /m);
});
