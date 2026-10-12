// 角色（tools/roles.mjs）：按名字判结构 / 装饰 / 地形 / 贴花 / 辅助；分散的模型；逆向按角色取舍写法；评分分角色报
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameWords, roleClassifier, assignRoles, scatterOf } from '../tools/roles.mjs';
import { reverse } from '../tools/reverse.mjs';
import { score } from '../tools/score.mjs';
import { compile } from '../src/s3d.js';
import { nodeRoles } from '../src/roles-view.js';

// 轴对齐的盒子：12 个三角形
const boxTris = ([x0, y0, z0], [x1, y1, z1]) => {
  const v = (i) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 6, 4], [1, 5, 7, 3], [0, 4, 5, 1], [2, 3, 7, 6], [0, 1, 3, 2], [4, 6, 7, 5]];
  return quads.flatMap(([a, b, c, d]) => [[v(a), v(b), v(c)], [v(a), v(c), v(d)]]);
};
const part = (name, tris) => ({ name, uid: name, tris, material: { name: 'whitebox', color: '#c9c9c9' } });

test('名字里的词：驼峰拆开，取最后一个有归属的词（中心词在后）；贴花、辅助的词出现就算；roles.json 的规则排在前面', () => {
  assert.deepEqual(nameWords('Group/SM_WallLamp_02@3'), ['sm', 'wall', 'lamp']);
  const one = roleClassifier();
  const r = (name) => one(part(name, boxTris([0, 0, 0], [1, 1, 1])));
  assert.equal(r('SM_WallLamp_02'), 'decor');
  assert.equal(r('SM_ConcreteWall_01'), 'structure');
  assert.equal(r('Road_FlowerBed_03'), 'decor');
  assert.equal(r('SM_I_Terrain_Road_Desert_Decal_Sand_12'), 'decal');
  assert.equal(r('Fog_Cube'), 'helper');
  assert.equal(r('SM_Road_01'), 'terrain');
  assert.equal(roleClassifier([{ role: 'structure', name: 'FlowerBed' }])(part('Road_FlowerBed_03', boxTris([0, 0, 0], [1, 1, 1]))), 'structure');
});

// 一面墙、墙上的灯、地上的贴花（散成几片的薄片）、包着十把椅子的白模体积 Cube、散在四处的几根围栏柱
const scene = () => [
  part('Building_Wall_01', boxTris([0, 0, 0], [10, 3, 0.3])),
  part('WallLamp_01', boxTris([4.8, 2, 0.3], [5.2, 2.3, 0.5])),
  part('Road_Decal_01', [0, 1, 2, 3].flatMap((k) => boxTris([2 + 6 * (k & 1), 0, 10 + 6 * (k >> 1)], [3 + 6 * (k & 1), 0.005, 11 + 6 * (k >> 1)]))),
  ...Array.from({ length: 10 }, (_, k) => part(`Chair_${k + 1}`, boxTris([1 + 1.5 * k, 0, 6], [1.5 + 1.5 * k, 0.9, 6.5]))),
  part('Cube', boxTris([0, 0, 5], [17, 4, 8])),
  part('Fence_Posts_01', [0, 1, 2, 3].flatMap((k) => boxTris([6 * k, 0, 12], [6 * k + 0.2, 1.2, 12.2]))),
];

test('整场判角色：白模体积（默认名、三角形少、整个包住 ≥ 10 个部件）是辅助；分散：块多、各块体积之和远小于整体包围盒', () => {
  const parts = scene(), roles = assignRoles(parts);
  const of = (n) => roles[parts.findIndex((p) => p.name === n)];
  assert.equal(of('Cube'), 'helper');
  assert.equal(of('Chair_3'), 'decor');
  assert.equal(of('Road_Decal_01'), 'decal');
  assert.equal(of('Fence_Posts_01'), 'structure');
  assert.equal(scatterOf(parts.find((p) => p.name === 'Road_Decal_01')).scattered, true);
  assert.equal(scatterOf(parts.find((p) => p.name === 'Fence_Posts_01')).scattered, true);
  assert.equal(scatterOf(parts[0]).scattered, false);
});

test('逆向按角色：辅助不写进几何（只在注释里）；贴花默认写成语言（按引用价计时保留网格引用）；角色写成 ~role；评分分角色报，辅助不计', () => {
  const parts = scene();
  const out = reverse(parts, { srcFile: 'x.glb', level: 'L0' });
  const r = compile(out.src);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(out.report.helpers, ['Cube']);
  assert.ok(!r.nodes.some((n) => n.meta?.src === 'Cube'), '辅助部件不进场景');
  assert.match(out.src, /辅助部件（不写进几何）：Cube/);
  const roleOf = nodeRoles(r);
  const bySrc = (s) => r.nodes.find((n) => n.meta?.src === s);
  const decal = bySrc('Road_Decal_01');
  assert.ok(decal, out.src);
  assert.equal(roleOf(decal.path), 'decal');
  assert.notEqual(decal.kind, 'mesh', '默认按真实信息量计价：关掉网格时不能少东西');
  const outRef = reverse(scene(), { srcFile: 'x.glb', level: 'L0', meshPrice: { decal: 'ref' } });
  assert.match(outRef.src, /^mesh Road_Decal_01 /m, '贴花按引用价计时保留网格引用');
  assert.equal(roleOf(bySrc('WallLamp_01').path), 'decor');
  assert.equal(roleOf(bySrc('Building_Wall_01').path), 'structure');
  assert.equal(bySrc('Building_Wall_01').meta.role, undefined, '结构是默认，不写 ~role');
  // 分散的围栏柱拆成一组盒子；椅子（类型的实例）的角色写在成员上，实例跟着它
  const fence = bySrc('Fence_Posts_01');
  assert.equal(fence.kind, 'group');
  assert.equal(r.nodes.filter((n) => n.path.startsWith(fence.path + '.') && n.kind === 'box').length, 4);
  const chairs = r.nodes.filter((n) => /^Chair\.\d+\.\w+$/.test(n.path));
  assert.equal(chairs.length, 10);
  assert.ok(chairs.every((n) => roleOf(n.path) === 'decor'));

  parts.forEach((p, i) => { p.role = assignRoles(parts)[i]; });
  const s = score({ result: r, files: [{ file: 'x.s3d', text: out.src }], sourceParts: parts });
  assert.ok(!s.byRole.helper, '辅助部件不计分');
  assert.equal(s.byRole.decor.sources, 11);
  const sum = Object.values(s.byRole).reduce((a, b) => a + b.S, 0);
  assert.ok(Math.abs(sum + s.unattributed - s.S) < 0.05 * Object.keys(s.byRole).length, `${sum} + ${s.unattributed} 对 ${s.S}`);
  const sm = Object.values(s.byRole).reduce((a, b) => a + b.S_mesh, 0);
  assert.ok(Math.abs(sm - s.S_mesh) < 0.05, `${sm} 对 ${s.S_mesh}`);
});

test('碰撞：挡墙、空气墙（名字里的词、Block 打头的连写、分组路径里的 Blocker）单独成一类，写进几何、带 ~role=collision', () => {
  const one = roleClassifier();
  const r = (name) => one(part(name, boxTris([0, 0, 0], [1, 1, 1])));
  assert.equal(r('Blocker/Lv_01/BlockWallCube@3'), 'collision');
  assert.equal(r('Blocker/Lv_01/SM_EFX_BlockPlane'), 'collision');
  assert.equal(r('Props/Collision_Box_02'), 'collision');
  assert.equal(r('SM_StoneBlock_Wall'), 'structure');
  assert.equal(r('SM_Block_01'), 'structure');
  // 法线朝外的实心盒子（上面的 boxTris 朝里：体积误差会把它当空心的拆成板）
  const solid = (lo, hi) => boxTris(lo, hi).map(([p, q, r]) => [p, r, q]);
  const out = reverse([part('Blocker/L/BlockWallCube', solid([0, 0, 0], [10, 4, 0.5])), part('Wall_01', solid([0, 0, 2], [10, 3, 2.3]))], { srcFile: 'x.glb', fidelity: 'structure' });
  assert.match(out.src, /^box BlockWallCube [^\n]*~role="collision"/m, out.src);
  const roleOf = nodeRoles(compile(out.src));
  assert.equal(roleOf('BlockWallCube'), 'collision');
  assert.equal(roleOf('Wall_01'), 'structure');
});
