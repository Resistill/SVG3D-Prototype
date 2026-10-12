// 多边形平板（plate）与凸包（hull）：语言里的写法；逆向把共面的面写成平板（tools/facets.mjs）、把岩石写成凸包（tools/hulls.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compile, convexHull3 } from '../src/s3d.js';
import { sceneObjects } from '../tools/worldtris.mjs';
import { reverse } from '../tools/reverse.mjs';
import { facetPlates } from '../tools/facets.mjs';

const volumeOf = (o) => { let V = 0; const p = o.pos; for (let i = 0; i < p.length; i += 9) V += (p[i] * (p[i + 4] * p[i + 8] - p[i + 5] * p[i + 7]) - p[i + 1] * (p[i + 3] * p[i + 8] - p[i + 5] * p[i + 6]) + p[i + 2] * (p[i + 3] * p[i + 7] - p[i + 4] * p[i + 6])) / 6; return V; };
const boundsOf = (o) => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < o.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], o.pos[i + k]); hi[k] = Math.max(hi[k], o.pos[i + k]); } return { lo, hi }; };

test('plate：凹的轮廓拉成平板，体积对；at= 放包围盒的底面中心；放在缺口里的箱子不算“在上面”；点太少报错', () => {
  const r = compile('plate wing points=[(0,0); (10,0); (10,6); (5,2); (0,6)] h=0.5 at=0,0,0\nbox a size=1,1,1 at=-3,0.5,-1\nbox b size=1,1,1 at=0,0.5,1.5');
  assert.deepEqual(r.errors, []);
  const o = sceneObjects(r).find((x) => x.path === 'wing');
  assert.ok(Math.abs(volumeOf(o) - 20) < 1e-6, String(volumeOf(o)));
  assert.deepEqual(boundsOf(o).lo.map((v) => +v.toFixed(6) + 0), [-5, 0, -3]);
  const on = r.facts.filter((f) => f.rel === 'on').map((f) => f.a);
  assert.ok(on.includes('a'), JSON.stringify(r.facts));
  assert.ok(!on.includes('b'), '缺口（凹进去的三角形）里没有板');
  assert.match(compile('plate p points=[(0,0); (1,0)] h=1').errors[0].message, /至少 3 个点/);
});

test('hull：一组点的凸包，里面的点不影响形状；共面的点报错；可以当别人的支撑面', () => {
  const pts = [[0, 0, 0], [2, 0, 0], [0, 2, 0], [0, 0, 2], [2, 2, 0], [2, 0, 2], [0, 2, 2], [2, 2, 2], [1, 1, 1]];
  assert.equal(convexHull3(pts).length, 12);
  const r = compile(`hull c points=[${pts.map((p) => `(${p.join(',')})`).join('; ')}]\nbox b size=1,1,1 on=c`);
  assert.deepEqual(r.errors, []);
  assert.ok(Math.abs(volumeOf(sceneObjects(r).find((x) => x.path === 'c')) - 8) < 1e-6);
  assert.ok(r.facts.some((f) => f.text === 'b on c'));
  assert.match(compile('hull f points=[(0,0,0); (1,0,0); (0,0,1); (1,0,1)]').errors[0].message, /平面/);
});

test('逆向：斜着的三角形坡面（单面的地块）写成一块平板，贴着原来的面；岩石（凸的块）写成一个凸包，点比顶点少', () => {
  // 一块斜坡：三角形，法线朝上偏 +x
  const A = [0, 0, 0], B = [0, 0, 30], C = [20, 8, 15];
  const wing = { name: 'Ground_Slope_01', tris: [[A, B, C]], material: { name: 'm', color: '#888888' }, role: 'terrain' };
  const fp = facetPlates(wing.tris, { tau: 0.05, thick: 0.1, maxThick: 1, digits: 3 });
  assert.equal(fp.plates, 1);
  const po = sceneObjects(compile(fp.lines.join('\n')))[0], b = boundsOf(po);
  assert.ok(Math.abs(b.hi[1] - 8) < 0.01 && Math.abs(b.hi[0] - 20) < 0.1 && Math.abs(b.hi[2] - 30) < 0.01, JSON.stringify(b)); // 厚度长在面的背后（下面）
  // 岩石：球面上的一圈点（凸），三角形扇连起来
  const ring = [], N = 16;
  for (let i = 0; i < N; i++) for (const [y, r] of [[0, 3], [2, 4], [4, 2]]) ring.push([r * Math.cos((2 * Math.PI * i) / N) * 1.5, y, r * Math.sin((2 * Math.PI * i) / N)]);
  const top = [0, 5, 0], bot = [0, 0, 0], tris = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N, q = (k, l) => ring[k * 3 + l];
    tris.push([bot, q(j, 0), q(i, 0)]);
    for (let l = 0; l < 2; l++) tris.push([q(i, l), q(j, l), q(j, l + 1)], [q(i, l), q(j, l + 1), q(i, l + 1)]);
    tris.push([q(i, 2), q(j, 2), top]);
  }
  // 上面的绕向朝里：翻过来（法线朝外，体积误差才认得出实体）
  const rock = { name: 'Nature_Rock_01', tris: tris.map(([a, b, c]) => [a, c, b]), material: { name: 'm', color: '#888888' } };
  const out = reverse([rock], { srcFile: 'x.glb', fidelity: 'structure' });
  assert.deepEqual(compile(out.src).errors, []);
  const m = /^hull Nature_Rock_01 points=\[([^\]]*)\]/m.exec(out.src);
  assert.ok(m, out.src);
  const n = m[1].split(';').length;
  assert.ok(n >= 8 && n < ring.length + 2, `${n} 个点`);
});

test('结构不写成凸包：同一个凸的块，叫 Wall 时不用 hull（门窗洞、踏步会被填平），叫 Rock 时用', () => {
  const ring = [], N = 12;
  for (let i = 0; i < N; i++) for (const [y, r] of [[0, 3], [3, 2]]) ring.push([r * Math.cos((2 * Math.PI * i) / N) * 1.5, y, r * Math.sin((2 * Math.PI * i) / N)]);
  const tris = [];
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N, q = (k, l) => ring[k * 2 + l];
    tris.push([[0, 0, 0], q(i, 0), q(j, 0)], [q(i, 0), q(j, 1), q(j, 0)], [q(i, 0), q(i, 1), q(j, 1)], [q(i, 1), [0, 4, 0], q(j, 1)]);
  }
  const mk = (name) => reverse([{ name, tris, material: { name: 'm', color: '#888888' } }], { srcFile: 'x.glb', fidelity: 'structure' }).src;
  assert.doesNotMatch(mk('Building_ExterWall_01'), /^\s*hull /m);
  assert.match(mk('Nature_Rock_02'), /^hull /m);
});
