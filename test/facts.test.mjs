// 事实提供者注册表（docs/PLAN2.md 4.10）：默认的 contact 与改动前逐条一致；walkable 示例；自定义提供者
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile, registerFactProvider, factProviderList, FACT_EPS } from '../src/s3d.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const compileFile = (file, opts = {}) => compile(read(file), { file, resolve: read, ...opts });

test('contact 提供者：spaceport 的空间事实与注册表改造之前逐条一致（顺序、内容）', () => {
  // fixtures/spaceport.facts.json 是改造之前的 deriveFacts 输出；examples/spaceport.s3d 改了就要重新生成
  const before = JSON.parse(read('test/fixtures/spaceport.facts.json'));
  const r = compileFile('examples/spaceport.s3d');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.factProviders, ['contact']);
  assert.ok(r.facts.every((f) => f.provider === 'contact'), '每条事实带 provider');
  // 按 JSON 比较（fixture 里 -0 写成 0）
  assert.deepEqual(JSON.parse(JSON.stringify(r.facts.map(({ provider, ...f }) => f))), before);
});

test('walkable：默认不启用；打开后按顶面朝上、净空、面积判断', () => {
  const src = `box floor size=10,0.2,10
box table size=2,0.8,1 on=floor
box roof size=4,0.2,4 at=floor[0.6,1,0.6] offset=0,1.2,0
cyl drum r=1 h=1 on=floor[-0.6,1,0.6]
box ramp size=4,0.2,2 tilt=30 at=20,0,0
box cellar size=6,0.2,6 at=0,-5,0
box lid size=6,0.2,6 on=cellar offset=0,1.4,0
box tiny size=0.3,0.3,0.3 at=-20,0,0`;
  assert.ok(!compile(src).facts.some((f) => f.provider === 'walkable'), '默认只有 contact');
  const r = compile(src, { factProviders: ['contact', 'walkable'] });
  assert.deepEqual(r.errors, []);
  const walk = new Map(r.facts.filter((f) => f.rel === 'walkable').map((f) => [f.a, f]));
  assert.deepEqual([...walk.keys()].sort(), ['drum', 'floor', 'lid', 'roof', 'table']);
  // 地板 100 m²，桌子、屋顶下面（净空 1.2 m < 2 m）、鼓占掉的部分不算
  const fl = walk.get('floor');
  assert.ok(fl.area > 70 && fl.area < 85, `floor ${fl.area}`);
  assert.equal(fl.b, null);
  assert.equal(fl.text, 'floor walkable');
  assert.ok(Math.abs(walk.get('drum').area - Math.PI) < 0.5, '圆柱的顶面是圆');
  assert.ok(!walk.has('cellar'), '上面 1.4 m 就是盖子：净空不够');
  assert.ok(!walk.has('ramp') && !walk.has('tiny'), '太斜、太小的不算');
  // contact 的事实不受影响，排在前面
  const k = r.facts.findIndex((f) => f.provider === 'walkable');
  assert.ok(r.facts.slice(0, k).every((f) => f.provider === 'contact') && r.facts.slice(k).every((f) => f.provider === 'walkable'));
  assert.deepEqual(r.facts.slice(0, k), compile(src).facts);
});

test('walkable：长度按米，场景单位换算后结果相同', () => {
  const src = (s) => `box floor size=${10 * s},${0.2 * s},${10 * s}
box roof size=${4 * s},${0.2 * s},${4 * s} at=floor[0.6,1,0.6] offset=0,${1.2 * s},0
box crate size=${0.4 * s},${0.4 * s},${0.4 * s} on=floor[-0.8,1,-0.8]`;
  const m = compile(src(1), { factProviders: ['walkable'] }).facts;
  const cm = compile(src(100), { factProviders: ['walkable'], factEps: FACT_EPS / 0.01 }).facts;
  assert.deepEqual(cm.map((f) => f.a), m.map((f) => f.a));
  cm.forEach((f, i) => assert.ok(Math.abs(f.area / 1e4 - m[i].area) < 1e-3, `${f.a}: ${f.area} cm² vs ${m[i].area} m²`));
  // 选项：把净空降到 1 m，屋顶下面也能走
  const low = compile(src(1), { factProviders: ['walkable'], factOptions: { walkable: { clearance: 1 } } }).facts;
  assert.ok(low.find((f) => f.a === 'floor').area > m.find((f) => f.a === 'floor').area + 10);
});

test('自定义提供者：注册后按名字打开，或者直接传对象；出错不影响别的提供者', () => {
  const tall = {
    name: 'test-tall',
    rels: ['tall'],
    // 一元事实：比 ctx.options.h 高的物体（用世界包围盒）
    derive: (objs, ctx) => objs.filter((o) => o.wb.max[1] - o.wb.min[1] > (ctx.options.h ?? 3)).map((o) => ({ rel: 'tall', a: o.path, text: `${o.path} tall` })),
  };
  registerFactProvider(tall);
  assert.ok(factProviderList().some((p) => p.name === 'test-tall' && !p.default));
  assert.ok(factProviderList().some((p) => p.name === 'contact' && p.default));
  const src = 'box a size=1,5,1\nbox b size=1,1,1 on=a\nbox c size=2,2,2 at=5,0,0';
  const r = compile(src, { factProviders: ['contact', 'test-tall'], factOptions: { 'test-tall': { h: 4 } } });
  assert.deepEqual(r.facts.filter((f) => f.provider === 'test-tall').map((f) => f.text), ['a tall']);
  assert.ok(r.facts.some((f) => f.text === 'b on a' && f.provider === 'contact'));
  // 直接传对象（不注册）
  const pair = { name: 'test-pair', derive: (objs, ctx) => ctx.pairs().map(([P, Q]) => ({ rel: 'near', a: P.path, b: Q.path, text: `${P.path} near ${Q.path}` })) };
  assert.ok(compile(src, { factProviders: [pair] }).facts.every((f) => f.provider === 'test-pair' && f.rel === 'near'));
  // 出错的提供者：记一条错误，contact 照常
  const bad = compile(src, { factProviders: ['contact', { name: 'boom', derive: () => { throw new Error('炸了'); } }] });
  assert.ok(bad.errors.some((e) => /boom.*炸了/.test(e.message)));
  assert.ok(bad.facts.some((f) => f.text === 'b on a'));
  // 没注册的名字：报错并退回默认
  const unk = compile(src, { factProviders: ['nope'] });
  assert.ok(unk.errors.some((e) => /nope/.test(e.message)));
  assert.deepEqual(unk.factProviders, ['contact']);
  assert.throws(() => registerFactProvider({ name: 'x' }));
});
