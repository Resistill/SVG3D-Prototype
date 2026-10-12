// Roblox 基本型的换算（tools/roblox.mjs）：零件的体积与原几何一致；挖洞拆成实心零件（不用 CSG）；比例
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile } from '../src/s3d.js';
import { robloxPlan, localParts, SHAPES } from '../tools/roblox.mjs';

// 零件的体积：Block 全的，Wedge 一半，Cylinder πr²L，Ball 4/3πr³
const vol = (shape, [x, y, z]) => (shape === SHAPES.Block ? x * y * z : shape === SHAPES.Wedge ? (x * y * z) / 2 : shape === SHAPES.Cylinder ? (Math.PI * y * z * x) / 4 : (Math.PI * x * y * z) / 6);
const plan = (src, scale = 1) => robloxPlan(compile(src), { scale });
const parts = (p) => p.chunks.flatMap((c) => c.parts);
const total = (p) => parts(p).reduce((a, q) => a + vol(q[1], q.slice(2, 5)), 0);

test('Roblox：盒子、楔形、凹的平板、凸包的零件体积与原几何一致；楔形的高边换到 Roblox 的 +Z', () => {
  assert.ok(Math.abs(total(plan('box a size=2,3,4 turn=30')) - 24) < 1e-3);
  assert.ok(Math.abs(total(plan('wedge w size=2,3,4')) - 12) < 1e-3);
  assert.ok(Math.abs(total(plan('plate p points=[(0,0); (10,0); (10,6); (5,2); (0,6)] h=0.5')) - 20) < 1e-3);
  // 楔形：SVG3D 的高边在 +x；Roblox 的高边在零件的 +Z（Studio 里用射线量过）——零件的 Z 轴应当指向世界 +x
  const w = parts(plan('wedge w size=2,3,4'))[0], R = w.slice(8, 17);
  assert.deepEqual([R[2], R[5], R[8]], [1, 0, 0]);
});

test('Roblox：挖洞的板在这里就拆成实心的盒子（不用 Union / Subtract），体积 = 板 − 洞', () => {
  const p = plan('subtract wall at=0,0,0 {\n  box body size=10,4,0.5\n  box door size=2,3,1 at=-2,0,0\n  box win size=2,1,1 at=3,2,0\n}');
  assert.ok(parts(p).every((q) => q[1] === SHAPES.Block));
  assert.ok(Math.abs(total(p) - (20 - 3 - 1)) < 1e-3, String(total(p)));
  assert.ok(parts(p).length <= 6, String(parts(p).length));
  const q = plan('subtract floor pin=origin {\n  plate body points=[(-5,-5); (-5,5); (5,5); (5,-5)] h=0.1 pin=origin\n  plate hole points=[(-1,-1); (1,-1); (1,1); (-1,1)] h=0.2 at=0,-0.05,0 pin=origin\n}');
  assert.ok(Math.abs(total(q) - (100 - 4) * 0.1) < 1e-3, String(total(q)));
});

test('Roblox：比例乘在坐标与尺寸上（0.28 m 的单位、0.34 m 的 stud）', () => {
  const k = 0.28 / 0.34, q = parts(plan('box a size=10,10,10 at=100,0,0', k))[0];
  assert.ok(Math.abs(q[2] - 10 * k) < 1e-3 && Math.abs(q[5] - 100 * k) < 1e-2);
});
