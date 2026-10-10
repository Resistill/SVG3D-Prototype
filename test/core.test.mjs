// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compile } from '../src/s3d.js';

const box = (r, path) => {
  const n = r.nodes.find((x) => x.path === path);
  assert.ok(n, `找不到 ${path}`);
  return n.box;
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} ≠ ${b}`);

test('on：堆叠由关系推出高度', () => {
  const r = compile(`
    box base size=10,2,10
    cyl a r=1 h=5 on=base
    cone b r=1 h=3 on=a
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'a').min[1], 2, 'a 底');
  near(box(r, 'b').min[1], 7, 'b 底');
  near(box(r, 'b').max[1], 10, 'b 顶');
});

test('against + align：贴面并对齐', () => {
  const r = compile(`
    box A size=10,6,8
    box B size=2,3,2 against=A.right align=back,bottom
  `);
  assert.deepEqual(r.errors, []);
  const b = box(r, 'B');
  near(b.min[0], 5, '贴在 A 右面');
  near(b.min[2], -4, '背面对齐');
  near(b.min[1], 0, '底面对齐');
});

test('against 在旋转后依然贴住参照物自身的面', () => {
  const r = compile(`
    box A size=10,4,6 turn=90
    box B size=2,2,2 against=A.right
  `);
  assert.deepEqual(r.errors, []);
  // A 转 90° 后，它的 right(+x) 朝向世界 -z；A 在世界中沿 z 的半宽是 5
  const b = box(r, 'B');
  near(b.max[2], -5, 'B 贴在世界 -z 侧');
  assert.ok(r.facts.some((f) => f.text === 'B against A.right'));
});

test('模板参数、阵列与路径引用', () => {
  const r = compile(`
    def post(h=3) { cyl p r=0.2 h=h }
    repeat row n=4 step=2,0,0 center=true {
      post item h=2+i
    }
    box cap size=1,0.2,1 on=row.3.item.p
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'row.0.item').min[0], -3.2, '居中阵列');
  near(box(r, 'cap').min[1], 5, '第 4 根柱子高 2+3');
});

test('span：两点之间的实体与台阶', () => {
  const r = compile(`
    box a size=2,4,2
    box b size=2,4,2 at=10,0,0
    span s from=a.top-right to=b.top-left section=1,0.2
    span st from=(0,0,5) to=(6,3,5) steps=6 section=1,0.2
  `);
  assert.deepEqual(r.errors, []);
  const s = box(r, 's');
  near(s.min[0], 1, '起点');
  near(s.max[0], 9, '终点');
  near(box(r, 'st').max[1], 3, '最后一级踏面到达终点高度');
});

test('子物体引用外部对象时不参与容器尺寸（后置）', () => {
  const r = compile(`
    box ground size=50,1,50 pin=top
    group g on=ground {
      box a size=2,2,2
      box far size=1,1,1 at=ground[0.8,1,0]
    }
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'g.a').min[1], 0, '组按 a 落地');
  near(box(r, 'g.far').min[0], 19.5, '后置物体按外部参照定位');
  assert.ok(r.nodes.find((n) => n.path === 'g.far').late);
});

test('错误：循环依赖与未知引用都给出行号', () => {
  const r = compile(`
    box a size=1,1,1 on=b
    box b size=1,1,1 on=a
    box c size=1,1,1 on=nothing
  `);
  assert.ok(r.errors.some((e) => e.message.includes('循环依赖')));
  assert.ok(r.errors.some((e) => e.line === 4 && e.message.includes('nothing')));
});

test('示例场景可编译且关键关系成立', () => {
  const r = compile(readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8'));
  assert.deepEqual(r.errors, []);
  near(box(r, 'rocket.nose').max[1], 2 + 28 + 14 + 7, '火箭总高');
  const facts = new Set(r.facts.map((f) => f.text));
  for (const f of ['rocket.nose on rocket.stage2', 'wings.annex against hangar.body.right', 'wings.mirrored.annex against hangar.body.left',
    'spare inside hangar.body', 'berm against bunker.left', 'rocket.fins.r2.fin on pad'])
    assert.ok(facts.has(f), `缺少事实：${f}`);
});

// ───────── 曲线 ─────────

const world = (r, path) => r.nodes.find((x) => x.path === path).world;
const yawOf = (W) => Math.atan2(W.R[0][2], W.R[0][0]);
const det = (M) => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
const mod2pi = (a) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

test('arc / helix：锚点按弧长取点，start 与 end 落在正确位置', () => {
  const r = compile(`
    arc a r=10 angle=0,90
    helix h r=2 pitch=4 turns=2 at=20,0,0 pin=origin
    box s size=1,1,1 at=a.end pin=center
    box m size=1,1,1 at=a[0.5] pin=center
    box top size=1,1,1 at=h.end pin=center
  `);
  assert.deepEqual(r.errors, []);
  const c = (p) => { const b = box(r, p); return b.min.map((x, k) => (x + b.max[k]) / 2); };
  // 角度 0 指向 +x，逆时针（俯视）转向 -z
  near(c('s')[0], 0, 'end.x'); near(c('s')[2], -10, 'end.z');
  near(c('m')[0], 10 * Math.SQRT1_2, '中点 x');
  near(c('top')[1], 8, '螺旋终点高度 = pitch × turns');
});

test('bezier / spline 经过端点；sweep 沿曲线生成实体', () => {
  const r = compile(`
    bezier b path=[(0,0,0); (5,5,0); (10,0,0)]
    spline s path=[(0,0,10); (5,2,10); (10,0,10); (15,3,10)]
    sweep road path=b profile=rect section=4,0.5 pin=bottom
    sweep tube path=s r=0.5
  `);
  assert.deepEqual(r.errors, []);
  const road = box(r, 'road');
  near(road.min[1], 0, 'pin=bottom：路面底边贴着曲线');
  assert.ok(Math.abs(road.max[1] - 3) < 0.02, `二次贝塞尔顶点 y=2.5，加路面厚 0.5：${road.max[1]}`);
  assert.equal(r.items.filter((i) => i.geom && i.geom.type === 'sweep').length, 2);
  assert.equal(r.curves.length, 2);
});

test('repeat along：沿曲线分布并跟随切线', () => {
  const r = compile(`
    arc ring r=10
    repeat posts n=4 along=ring {
      box post size=2,1,0.2 pin=center
    }
  `);
  assert.deepEqual(r.errors, []);
  // 闭合曲线：4 个实例均分圆周，第 2 个在 90° 处，即 (0,0,-10)
  const w = world(r, 'posts.1');
  near(w.t[0], 0, 'x'); near(w.t[2], -10, 'z');
  near(mod2pi(yawOf(w)), Math.PI, '切线朝向 -x');
});

test('revolve：轮廓自动在轴上封口', () => {
  const r = compile(`revolve nose profile=[(2,0); (1.5,4); (0.5,6)]`);
  assert.deepEqual(r.errors, []);
  const g = r.items[0].geom;
  assert.deepEqual(g.prof[0], [0, 0]);
  assert.deepEqual(g.prof[g.prof.length - 1], [0, 6]);
  near(box(r, 'nose').max[0], 2, '最大半径');
});

// ───────── 镜像与旋转 ─────────

test('mirror of：关于参照物中心的竖直面反射，并翻转手性', () => {
  const r = compile(`
    box core size=4,10,4
    group wing at=8,0,3 {
      box body size=6,3,2
      wedge ramp size=3,3,2 against=body.right
    }
    mirror wing2 of=wing across=core axis=x
  `);
  assert.deepEqual(r.errors, []);
  const a = box(r, 'wing.ramp'), b = box(r, 'wing2.ramp');
  near(b.min[0], -a.max[0], 'x 镜像');
  near(b.min[2], a.min[2], 'z 不变');
  near(det(world(r, 'wing2').R), -1, '副本是镜像（手性翻转）');
  // 副本里的名字可以被引用
  const c = compile(r.nodes.length && `
    box core size=4,10,4
    group wing at=8,0,3 { box body size=6,3,2 }
    mirror wing2 of=wing across=core.left
    sphere ball r=1 on=wing2.body
  `);
  assert.deepEqual(c.errors, []);
  // 关于 core 左面（x=-2）反射：wing 中心 x=8 → -12
  near((box(c, 'ball').min[0] + box(c, 'ball').max[0]) / 2, -12, '过面的镜像');
});

test('mirror 容器：子物体加上它们的镜像', () => {
  const r = compile(`
    mirror pair across=x {
      box a size=2,2,2 at=5,0,1
    }
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'pair.mirrored.a').min[0], -6, '镜像副本');
  near(box(r, 'pair').min[0], -6, '容器包含副本');
  near(box(r, 'pair').max[0], 6, '容器包含原物体');
});

test('rotate：of 复制与容器式旋转对称', () => {
  const r = compile(`
    box hub size=2,2,2
    box arm size=6,1,1 at=4,0,0
    rotate arm2 of=arm about=hub angle=90
    rotate fan n=2 about=hub {
      box blade size=4,0.2,1 at=3,0,0
    }
  `);
  assert.deepEqual(r.errors, []);
  const a2 = box(r, 'arm2');
  near(a2.min[2], -7, '转 90° 后指向 -z');
  near(a2.max[0], 0.5, 'x 宽度变成原来的 z 宽度');
  // n=2 → 原物体 + 2 个副本，默认每次 120°
  near(mod2pi(yawOf(world(r, 'fan.r1'))), 2 * Math.PI / 3, '120°');
  near(mod2pi(yawOf(world(r, 'fan.r2'))), 4 * Math.PI / 3, '240°');
});

test('镜像跟随原物体：改原物体，副本一起变', () => {
  const src = (h) => `box base size=10,1,10\nbox t size=1,${h},1 on=base[0.5,1,0]\nmirror t2 of=t across=base`;
  const a = compile(src(3)), b = compile(src(7));
  near(box(a, 't2').max[1], 4, '高度 3');
  near(box(b, 't2').max[1], 8, '高度 7');
  near(box(b, 't2').min[0], -3, '位置对称');
});

test('非法方向给出错误', () => {
  const r = compile(`box a\nrotate b of=a axis=sideways angle=30`);
  assert.ok(r.errors.some((e) => e.message.includes('sideways')));
});

// ───────── 任意轴三维旋转 ─────────

const upOf = (W) => [W.R[0][1], W.R[1][1], W.R[2][1]];
const nearV = (a, b, msg) => a.forEach((x, k) => near(x, b[k], `${msg}[${k}]`));

test('tilt / roll / rot：顶部分别倒向 front、right、任意轴', () => {
  const r = compile(`
    box a size=2,4,1 tilt=90
    box b size=2,4,1 roll=90 at=10,0,0
    box c size=2,4,1 rot=(0,0,1,90) at=20,0,0
  `);
  assert.deepEqual(r.errors, []);
  nearV(upOf(world(r, 'a')), [0, 0, 1], 'tilt 顶部朝 +z');
  nearV(upOf(world(r, 'b')), [1, 0, 0], 'roll 顶部朝 +x');
  nearV(upOf(world(r, 'c')), [-1, 0, 0], '绕 z 轴右手转 90°');
  near(box(r, 'a').max[2], 4, '倒下后沿 +z 伸出 4');
});

test('aim：让指定的面指向目标，并尽量保持直立', () => {
  const r = compile(`
    box cam size=1,1,2 at=0,5,0 pin=center aim=(10,5,0)
    cyl barrel r=0.2 h=4 aimwith=top aim=(0,8,8)
  `);
  assert.deepEqual(r.errors, []);
  const W = world(r, 'cam');
  nearV([W.R[0][2], W.R[1][2], W.R[2][2]], [1, 0, 0], 'front 指向目标');
  nearV(upOf(W), [0, 1, 0], '保持直立');
  nearV(upOf(world(r, 'barrel')), [0, Math.SQRT1_2, Math.SQRT1_2], '炮管顶端指向 (0,8,8)');
});

test('on 一个倾斜的面：继承三维朝向，平贴在斜面上', () => {
  const r = compile(`
    span ramp from=(0,0,0) to=(10,5,0) section=2,0.2 pin=bottom
    box crate size=1,1,1 on=ramp
  `);
  assert.deepEqual(r.errors, []);
  const a = Math.atan2(5, 10);
  nearV(upOf(world(r, 'crate')), [-Math.sin(a), Math.cos(a), 0], '箱子的“上”垂直于坡面');
  assert.ok(r.facts.some((f) => f.text === 'crate on ramp'), '空间事实在斜面的坐标系里成立');
});

test('rotate 绕水平轴：风车叶片', () => {
  const r = compile(`
    box hub size=1,1,1 at=0,10,0 pin=center
    rotate blades n=2 about=hub axis=z {
      box blade size=0.6,5,0.2 at=hub.top
    }
  `);
  assert.deepEqual(r.errors, []);
  // 绕 +z 右手转 120°：竖直向上的叶片转到左下方
  const up1 = upOf(world(r, 'blades.r1.blade'));
  nearV(up1, [-Math.sin(2 * Math.PI / 3), Math.cos(2 * Math.PI / 3), 0], '第二片叶片的方向');
});

test('mirror 水平面：倒影', () => {
  const r = compile(`
    box ground size=20,1,20 pin=top
    cone spire r=1 h=6 on=ground
    mirror reflection of=spire across=ground.top
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'reflection').min[1], -6, '倒影向下');
  near(det(world(r, 'reflection').R), -1, '镜像');
});

test('repeat along orient=full：实例随坡度倾斜', () => {
  const r = compile(`
    helix track r=10 pitch=20 turns=1
    repeat sleepers n=8 along=track orient=full { box s size=0.3,0.2,3 pin=center }
    repeat posts n=8 along=track { box p size=0.3,2,0.3 }
  `);
  assert.deepEqual(r.errors, []);
  const s0 = world(r, 'sleepers.0'), p0 = world(r, 'posts.0');
  assert.ok(s0.R[1][0] > 0.2, '枕木的局部 x（切线）带有上升分量');
  nearV(upOf(p0), [0, 1, 0], '默认 orient=yaw 保持竖直');
});

test('drop：从一点竖直落到某个面上；锚点坐标分量', () => {
  const r = compile(`
    box ground size=40,1,40 pin=top
    box slope size=10,1,10 at=10,0,0 roll=-20
    span col from=(0,8,0) drop=ground r=0.2
    span leg from=(10,8,0) drop=slope r=0.2
    box deck size=4,0.5,4 at=-10,6,0
    cyl post r=0.2 h=deck.bottom.y at=deck.bottom pin=top
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'col').min[1], 0, '落到地面');
  // 斜面中心顶点：中心 (10, 0.5·cos20°, -) 处的平面；x=10 正好过中心
  // 斜面以底面中心为支点滚转 20°，过支点的竖直线与顶面的交点高 1/cos20°
  near(box(r, 'leg').min[1], 1 / Math.cos(rad(20)), '落到斜面');
  near(box(r, 'post').min[1], 0, '柱高 = 平台底面高度');
});
const rad = (d) => (d * Math.PI) / 180;

// ───────── 变量、集合与语义 ─────────

const members = (r, name) => r.concepts.find((c) => c.name === name).members.sort();

test('let：数、对象引用、作用域与惰性求值', () => {
  const r = compile(`
    let h = base_h * 2       // 可以引用写在后面的变量
    let base_h = 3
    let anchor = pad.top
    box pad size=10,1,10
    box tower size=2,h,2 at=anchor
    group g at=20,0,0 {
      let h = 1              // 块内的 let 遮蔽外层
      box small size=1,h,1
    }
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'tower').max[1], 7, '1 + 6');
  near(box(r, 'g.small').max[1], 1, '内层 h');
});

test('集合：#标签、kind、路径通配、并交差、where', () => {
  const r = compile(`
    box a size=1,1,1 #red
    box b size=1,3,1 at=5,0,0 #red #tall
    cyl c r=1 h=5 at=10,0,0 #tall
    repeat row n=3 step=2,0,0 at=0,0,10 { cone k r=0.5 h=1 }
    concept reds   = #red
    concept both   = #red & #tall
    concept either = #red | #tall
    concept onlyRed = #red - #tall
    concept boxes  = kind(box)
    concept cones  = row.*.k
    concept high   = all() where h > 2
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(members(r, 'both'), ['b']);
  assert.deepEqual(members(r, 'either'), ['a', 'b', 'c']);
  assert.deepEqual(members(r, 'onlyRed'), ['a']);
  assert.deepEqual(members(r, 'cones'), ['row.0.k', 'row.1.k', 'row.2.k']);
  assert.deepEqual(members(r, 'high'), ['b', 'c']);
});

test('concept：用空间关系定义新语义，求解后识别', () => {
  const r = compile(`
    box ground size=60,1,20 pin=top
    repeat piers n=3 step=10,0,0 center=true on=ground { cyl p r=0.6 h=5 }
    box deck size=26,0.5,4 on=piers
    box shed size=4,3,4 at=ground[0.8,1,0]
    wedge roof size=4,1.5,4 on=shed
    cyl lamp r=0.1 h=3 on=deck
    concept pier  = kind(cyl) & on(ground) & supports(kind(box))
    concept deck_ = kind(box) & on(pier, 2)
    concept roof_ = kind(wedge) & on(kind(box))
    concept bridge = pier | deck_
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(members(r, 'pier'), ['piers.0.p', 'piers.1.p', 'piers.2.p']);
  assert.deepEqual(members(r, 'deck_'), ['deck']);
  assert.deepEqual(members(r, 'roof_'), ['roof']);
  assert.equal(members(r, 'bridge').length, 4);
  // 节点上带有识别出的概念
  assert.deepEqual(r.nodes.find((n) => n.path === 'deck').concepts, ['deck_', 'bridge']);
});

test('模板就是使用者定义的类型：kind(模板名)', () => {
  const r = compile(`
    def house(w=4) { box body size=w,3,w; wedge roof size=w,1,w on=body }
    house h1 at=0,0,0
    house h2 at=10,0,0 w=8
    concept houses = kind(house)
    concept big = kind(house) where w > 5
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(members(r, 'houses'), ['h1', 'h2']);
  assert.deepEqual(members(r, 'big'), ['h2']);
});

test('style 按集合改材质；check 找出违反规则的对象', () => {
  const r = compile(`
    material stone color=#999999
    box ground size=40,1,40 pin=top
    box a size=1,1,1 on=ground #post
    box b size=1,1,1 at=5,3,0 #post
    style #post mat=stone
    style b color=#ff0000
    check "立柱必须落地" #post - on(ground)
    check count(#post) >= 2
    check count(#post) > 5
  `);
  assert.deepEqual(r.errors, []);
  const mat = (p) => r.items.find((i) => i.path === p).material;
  assert.equal(mat('a').name, 'stone');
  assert.equal(mat('b').color, '#ff0000', '后写的样式覆盖先写的');
  assert.deepEqual(r.checks.map((c) => c.ok), [false, true, false]);
  assert.deepEqual(r.checks[0].violators, ['b']);
});

test('集合作为参照物：on=#walls 放在它们的总包围盒上', () => {
  const r = compile(`
    box w1 size=1,3,8 at=-4,0,0 #wall
    box w2 size=1,3,8 at=4,0,0 #wall
    box roof size=10,0.3,9 on=#wall
    let walls = #wall
    sphere mark r=0.2 at=walls.top
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'roof').min[1], 3, '屋顶落在墙顶');
  near((box(r, 'roof').min[0] + box(r, 'roof').max[0]) / 2, 0, '居中于两面墙之间');
  near(box(r, 'mark').min[1], 3, '集合的锚点');
});

test('关系谓词不能用来决定位置；颜色与标签不冲突；数学函数', () => {
  const r = compile(`
    box ground size=10,1,10 pin=top
    box a size=1,1,1 on=ground color=#abc
    box b size=1,1,1 on=on(ground)
    box c size=1,sqrt(16),1 at=5,0,0
  `);
  assert.ok(r.errors.some((e) => e.message.includes('只能用在 concept')));
  assert.equal(r.items.find((i) => i.path === 'a').material.color, '#abc');
  near(box(r, 'c').max[1], 4, 'sqrt');
});

test('概念与对象同名不冲突：几何里指对象，语义层里指概念', () => {
  const r = compile(`
    box ground size=20,1,20 pin=top
    box cabin size=2,2,2 on=ground
    wedge cap size=2,1,2 on=cabin
    concept cabin = kind(box) & supports(kind(wedge))
    check cabin - on(ground)
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(members(r, 'cabin'), ['cabin']);
  assert.ok(r.checks[0].ok);
});

// ───────── 编译期的随机与条件、多对象模式、按语义替换变体 ─────────

test('pattern：多个角色之间的关系，换顺序不算新匹配', () => {
  const r = compile(`
    box ground size=40,1,20 pin=top
    box p1 size=0.5,4,0.5 at=-3,0,0
    box p2 size=0.5,4,0.5 at=3,0,0
    box beam size=7,0.5,0.6 at=0,4,0
    box p3 size=0.5,4,0.5 at=12,0,0
    pattern gate(post1, post2, lintel) {
      post1 in kind(box) & on(ground)
      post2 in kind(box) & on(ground)
      lintel in kind(box)
      lintel on post1
      lintel on post2
    }
    concept lintels = gate.lintel
    check count(gate) == 1
  `);
  assert.deepEqual(r.errors, []);
  const g = r.patterns.find((p) => p.name === 'gate');
  assert.equal(g.matches.length, 1, 'post1/post2 互换算同一个');
  assert.deepEqual([g.matches[0].post1, g.matches[0].post2].sort(), ['p1', 'p2']);
  assert.deepEqual(members(r, 'lintels'), ['beam']);
  assert.ok(r.checks[0].ok);
});

test('pattern 集合角色：一个房间 = 地板 + 立在上面的所有墙 + 压在墙上的顶', () => {
  const r = compile(`
    def room(w=8, d=6) {
      box floor size=w,0.3,d
      box n size=w,3,0.3 on=floor align=back
      box s size=w,3,0.3 on=floor align=front
      box e size=0.3,3,d-0.6 on=floor align=right
      box top size=w,0.3,d on=n alignto=floor align=front,left
    }
    room r1 at=0,0,0
    room r2 at=20,0,0 d=10
    box lone size=8,0.3,6 at=0,0,20
    pattern enclosure(floor, walls*, roof) {
      floor in kind(box) where h < 1
      walls in kind(box) where h > 2
      roof in kind(box) where h < 1
      walls on floor
      roof on walls
      count(walls) >= 3
    }
    style enclosure.walls color=#ddccaa
  `);
  assert.deepEqual(r.errors, []);
  const e = r.patterns.find((p) => p.name === 'enclosure');
  assert.equal(e.matches.length, 2, '两个房间；孤立的板不算');
  assert.equal(e.matches[0].walls.length, 3);
  assert.equal(r.items.find((i) => i.path === 'r2.e').material.color, '#ddccaa');
});

test('variant：按语义把对象换成另一个模板，外包络与其他物体的关系不变', () => {
  const r = compile(`
    box ground size=40,1,20 pin=top
    repeat piers n=3 step=8,0,0 center=true on=ground { cyl p r=0.5 h=4 }
    box slab size=20,0.6,4 on=piers.*.p
    sphere lamp r=0.3 on=slab
    def planks(w=1, h=1, d=1, gap=0.1) {
      repeat pl n=floor(w/1) step=w/floor(w/1),0,0 center=true {
        box plank size=w/floor(w/1)-gap,h,d
      }
    }
    concept deck = kind(box) & on(kind(cyl), 2)
    variant deck use=planks gap=0.2
  `);
  assert.deepEqual(r.errors, []);
  assert.ok(!r.items.some((i) => i.path === 'slab'), '原来的板不再渲染');
  const planks = r.items.filter((i) => i.path.startsWith('slab.skin.pl.'));
  assert.equal(planks.length, 20, '20 米长，每米一块');
  near(box(r, 'slab.skin').min[1], 4, '变体落在原来的外包络里');
  near(box(r, 'slab.skin').max[1], 4.6, '高度也一样');
  near(box(r, 'lamp').min[1], 4.6, '其他物体与它的关系不受影响');
  assert.ok(r.facts.some((f) => f.text === 'lamp on slab'), '空间事实仍按外包络');
  assert.deepEqual(r.variants[0].members, ['slab']);
});

test('变体对语义层不可见：集合、检查只看原来的外包络', () => {
  const r = compile(`
    box ground size=20,1,20 pin=top
    box a size=4,2,4 on=ground #thing
    def fancy(w=1, h=1, d=1) { box inner size=w*0.5,h*2,d*0.5 #thing }
    variant #thing use=fancy
    check "没有悬空" kind(box) - on(all()) - ground
    check count(#thing) == 1
  `);
  assert.deepEqual(r.errors, []);
  assert.ok(r.checks.every((c) => c.ok), JSON.stringify(r.checks));
  assert.ok(r.items.some((i) => i.path === 'a.skin.inner'));
});

// ───────── 空间事实：每对只一条、形状感知 ─────────

const factOf = (r, a, b) => r.facts.filter((f) => (f.a === a && f.b === b) || (f.a === b && f.b === a));

test('空间事实：每对物体只有一条最强的关系，旋转物体不会再多出近似接触', () => {
  const r = compile(`
    box ground size=40,1,40 pin=top
    box hut size=4,3,4 on=ground turn=30
    wedge ramp size=3,3,4 against=hut.left align=bottom
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(factOf(r, 'hut', 'ground').map((f) => f.rel), ['on']);
  assert.deepEqual(factOf(r, 'ramp', 'hut').map((f) => f.text), ['ramp against hut.left']);
  assert.ok(r.facts.every((f) => !f.approx));
});

test('空间事实按真实形状：圆柱外侧的柱子不算在圆柱里面，扫掠不会“装下”路径围住的东西', () => {
  const r = compile(`
    cyl core r=4 h=10
    cyl col r=0.2 h=8 at=(4.55*cos(45),0,4.55*sin(45))
    arc loop r=10
    sweep rail path=loop profile=rect section=0.4,0.2
    box crate size=1,1,1 at=0,0,0
    sphere ball r=1 at=8,0,0
    box block size=2,2,2 at=9.5,0,0
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(factOf(r, 'col', 'core'), [], '柱子离圆柱面还有 0.35 米');
  assert.ok(!r.facts.some((f) => f.rel === 'inside' && f.b === 'rail'), '没有东西在细细的轨道“里面”');
  assert.deepEqual(factOf(r, 'ball', 'block').map((f) => f.rel), ['intersects'], '球与盒子相交');
});

test('intersects 是一条事实，也能当关系谓词用', () => {
  const r = compile(`
    box beam size=10,0.5,0.5 at=0,3,0
    repeat cols n=3 step=4,0,0 center=true { box c size=0.5,6,0.5 }
    concept pierced = kind(box) & intersects(beam)
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(members(r, 'pierced'), ['cols.0.c', 'cols.1.c', 'cols.2.c']);
});

test('repeat 继承参照物的朝向：转过角度的墙面上排窗', () => {
  const r = compile(`
    box wall size=10,6,0.4 turn=30
    repeat win n=(3,2,1) step=2.5,2,0 center=true against=wall.front {
      box pane size=1,1.2,0.1
    }
  `);
  assert.deepEqual(r.errors, []);
  const panes = r.facts.filter((f) => f.rel === 'against' && f.b === 'wall');
  assert.equal(panes.length, 6, '六扇窗都贴在墙的正面');
  assert.ok(panes.every((f) => f.text.endsWith('wall.front')));
});

// ───────── 精简之后：派生、覆盖、复制、层 ─────────

test('已删除的生成特性给出明确的错误', () => {
  assert.ok(compile('box a size=rand(),1,1').errors.some((e) => e.message.includes('未知函数 rand')));
  assert.ok(compile('if 1 > 0 { box a }').errors.some((e) => e.message.includes('派生类型')));
  assert.ok(compile('box a size=5%2,1,1').errors.some((e) => e.message.includes('%')));
});

test('def B : A：覆盖参数、删除与新增部件、is-a；同名派生就地扩展类型', () => {
  const r = compile(`
    def tower(floors=1) { box base size=4,3*floors,4; wedge roof size=4,1.5,4 on=base }
    def tall : tower(floors=3) { drop roof; cone spire r=2 h=4 on=base }
    def flat(parapet=0.3) : tower(floors=2) { over roof color=#888888; box rim size=4.4,parapet,4.4 on=base }
    def tower : tower { box flag size=0.1,2,0.1 on=base[0.8,1,0.8] }
    tower a
    tall b at=10,0,0
    flat c at=20,0,0 parapet=0.5
    concept towers = kind(tower)
    concept talls = kind(tall)
  `);
  assert.deepEqual(r.errors, []);
  const kids = (p) => r.nodes.filter((n) => n.path.startsWith(p + '.') && n.depth === 1).map((n) => n.id).sort();
  assert.deepEqual(kids('a'), ['base', 'flag', 'roof']);
  assert.deepEqual(kids('b'), ['base', 'flag', 'spire']);
  assert.deepEqual(kids('c'), ['base', 'flag', 'rim', 'roof']);
  near(box(r, 'b.base').max[1], 9, '派生类型覆盖了 floors 的默认值');
  near(box(r, 'c.rim').max[1] - box(r, 'c.rim').min[1], 0.5, '派生类型自己的参数');
  assert.equal(r.items.find((i) => i.path === 'c.roof').material.color, '#888888');
  assert.deepEqual(members(r, 'towers'), ['a', 'b', 'c'], 'kind(tower) 包含派生类型');
  assert.deepEqual(members(r, 'talls'), ['b']);
});

test('over：改属性、换定位关系、加部件；表达式在写它的地方求值', () => {
  const r = compile(`
    box ground size=40,1,40 pin=top
    box pad size=6,1,6 on=ground
    box crate size=1,1,1 at=10,0,0 #cargo
    box keg size=1,1,1 at=-10,0,0 #cargo
    let lift = 3
    over crate on=pad size=2,lift,2
    over #cargo { sphere tag r=0.2 on=it }
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'crate').min[1], 1, '定位关系换成了 on=pad（原来的 at 作废）');
  near(box(r, 'crate').max[1], 4, 'size 用的是写 over 处的变量 lift');
  near(box(r, 'crate.tag').min[1], 4, '块里的新语句成为每个成员的部件');
  near(box(r, 'keg.tag').min[1], 1);
});

test('drop 删除对象；改模板参数会按新参数重建实例；对副本的覆盖报错', () => {
  const r = compile(`
    def shelf(n=2) { repeat boards n=n step=0,1,0 { box b size=2,0.1,0.5 } }
    shelf s
    box junk size=1,1,1 at=5,0,0
    drop junk
    over s n=5
    mirror s2 of=s across=(3,0,0)
    over s2 color=#ff0000
  `);
  assert.ok(!r.nodes.some((n) => n.path === 'junk'));
  assert.equal(r.nodes.filter((n) => /^s\.boards\.\d+\.b$/.test(n.path)).length, 5);
  assert.equal(r.nodes.filter((n) => /^s2\.boards\.\d+\.b$/.test(n.path)).length, 5, '副本跟随修改后的原物体');
  assert.ok(r.errors.length === 0, '只改外观的 over 在求解后应用，副本可以被上色');
  const bad = compile(`box a\nmirror a2 of=a across=(3,0,0)\nover a2 size=2,2,2`);
  assert.ok(bad.errors.some((e) => e.message.includes('副本跟随原物体')));
});

test('copy：结构派生，可以带修改；与原物体互不影响', () => {
  const r = compile(`
    box ground size=60,1,20 pin=top
    def hut(w=4) { box body size=w,3,w; wedge roof size=w,1.5,w on=body; box door size=1,2,0.2 against=body.front align=bottom }
    hut h1 on=ground[-0.5,1,0]
    copy h2 of=h1 on=ground[0.5,1,0] {
      drop door
      over body color=#aa3333
      box chimney size=0.6,2,0.6 on=body[0.6,1,0.6]
    }
  `);
  assert.deepEqual(r.errors, []);
  assert.ok(r.nodes.some((n) => n.path === 'h1.door'), '原物体不受影响');
  assert.ok(!r.nodes.some((n) => n.path === 'h2.door'));
  assert.ok(r.nodes.some((n) => n.path === 'h2.chimney'));
  near((box(r, 'h2').min[0] + box(r, 'h2').max[0]) / 2, 15, '副本有自己的定位');
  assert.equal(r.items.find((i) => i.path === 'h2.body').material.color, '#aa3333');
});

test('concept 的层级与元数据', () => {
  const r = compile(`
    box d1 size=1,2.1,0.1 #door ~fit=0.95 ~src="node_3"
    box d2 size=1.8,2.1,0.1 at=5,0,0 #door ~fit=0.4
    concept door = #door
    concept double_door : door = where w > 1.6
    concept doubtful = all() where fit < 0.5
    check "低置信度的部件" doubtful
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(members(r, 'double_door'), ['d2']);
  assert.equal(r.concepts.find((c) => c.name === 'double_door').parent, 'door');
  assert.deepEqual(members(r, 'doubtful'), ['d2']);
  assert.equal(r.nodes.find((n) => n.path === 'd1').meta.src, 'node_3');
  assert.deepEqual(r.checks[0].violators, ['d2']);
});

// ───────── 层：import ─────────

const layered = (files, main) => compile(files[main], { file: main, resolve: (p) => files[p] });

test('import：修改层覆盖基础描述；风格层不改变空间事实', () => {
  const files = {
    'base.s3d': `
      box ground size=40,1,40 pin=top
      def hut(w=4) { box body size=w,3,w; wedge roof size=w,1.5,w on=body }
      hut h1 on=ground
      repeat posts n=3 step=3,0,0 at=10,0,0 { cyl p r=0.2 h=2 }
      sphere lamp r=0.3 on=h1.roof`,
    'edit.s3d': `import "base.s3d"
      over h1 w=8
      over posts n=5
      drop posts.0`,
    'style.s3d': `import "base.s3d"
      material wood color=#8a5a3c
      def shingles(w=1, h=1, d=1) { wedge s size=w,h,d }
      over h1.roof use=shingles
      over kind(cyl) mat=wood`,
  };
  const base = layered(files, 'base.s3d'), edit = layered(files, 'edit.s3d'), style = layered(files, 'style.s3d');
  for (const r of [base, edit, style]) assert.deepEqual(r.errors, []);
  near(box(edit, 'h1.body').max[0] - box(edit, 'h1.body').min[0], 8, '参数被覆盖');
  near(box(edit, 'lamp').min[1], 4.5, '依赖它的灯跟着移动（roof 顶在 3 + 1.5）');
  assert.deepEqual(edit.nodes.filter((n) => /^posts\.\d+$/.test(n.path)).map((n) => n.path), ['posts.1', 'posts.2', 'posts.3', 'posts.4']);
  const factSet = (r) => r.facts.map((f) => f.text).sort().join('\n');
  assert.equal(factSet(style), factSet(base), '风格层不改变空间事实');
  assert.ok(style.items.some((i) => i.path === 'h1.roof.skin.s'));
});

test('import 的错误带文件名；循环 import 报错', () => {
  const r = layered({ 'a.s3d': 'import "b.s3d"\nbox x size=1,1,1', 'b.s3d': 'box y on=nothing' }, 'a.s3d');
  assert.ok(r.errors.some((e) => e.file === 'b.s3d' && e.message.includes('nothing')));
  const c = layered({ 'a.s3d': 'import "b.s3d"', 'b.s3d': 'import "a.s3d"' }, 'a.s3d');
  assert.ok(c.errors.some((e) => e.message.includes('循环')));
});

test('mesh：引用源模型的网格，外包络参与关系', () => {
  const r = compile(`
    box ground size=20,1,20 pin=top
    mesh statue src="assets/park.glb#Statue" size=2,3,1.5 pivot=0.4,0,-0.2 on=ground ~fit=0.6
    box plinth size=1,0.2,1 on=statue
  `);
  assert.deepEqual(r.errors, []);
  near(box(r, 'plinth').min[1], 3, '放在网格外包络的顶上');
  const it = r.items.find((i) => i.path === 'statue');
  assert.equal(it.geom.src, 'assets/park.glb#Statue');
  assert.ok(r.facts.find((f) => f.a === 'statue' && f.b === 'ground').approx, '网格只有外包络，事实标为近似');
});

test('通用语义库：理解与写法无关；场景里的同名概念覆盖库里的', () => {
  const lib = readFileSync(new URL('../lib/semantics.s3d', import.meta.url), 'utf8');
  const scene = `
    box ground size=100,1,100 pin=top
    box a size=0.4,6,0.4 on=ground
    box b size=6,0.4,0.4 on=ground[0.2,1,0]
    box c size=0.4,6,0.4 on=ground[-0.2,1,0] roll=90
    box pad size=8,0.3,8 on=ground[0,1,0.3]
  `;
  const r = compile(`${scene}\n${lib}`);
  assert.deepEqual(r.errors, []);
  const m = (name) => r.concepts.find((c) => c.name === name).members;
  assert.deepEqual(m('terrain'), ['ground']);
  assert.deepEqual(m('column'), ['a'], '竖着的细长体');
  assert.deepEqual(m('beam').sort(), ['b', 'c'], '写成 w=6 与写成 h=6 再转 90°，都是横着的梁');
  assert.deepEqual(m('platform'), ['pad']);
  // import 库之后重新定义：以后写的为准，概念只出现一次
  const o = layered({ 'lib.s3d': lib, 'a.s3d': `import "lib.s3d"\n${scene}\nconcept column = all() where top > 5` }, 'a.s3d');
  assert.equal(o.concepts.filter((c) => c.name === 'column').length, 1);
  assert.deepEqual(o.concepts.find((c) => c.name === 'column').members.sort(), ['a']);
});

test('where 里的 top / bottom 是真实形状的世界高度', () => {
  const r = compile(`
    box ground size=20,1,20 pin=top
    box tilted size=0.2,0.2,4 on=ground tilt=30
    concept leaning = all() where top - bottom > 1.5 and top - bottom < 2.5
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.concepts[0].members, ['tilted']);
});

// 风车：三台是同一个类型的实例；改一台的一片扇叶不影响别的；父类型加扇叶，所有实例与派生都跟着加，单独的修改保留
const windfarm = `
  material white color=#eeeeee
  material rust color=#8b4a2b
  box ground size=100,1,100 pin=top
  def turbine(h=20) {
    cyl tower r=0.8 h=h mat=white
    sphere hub r=0.8 on=tower mat=white
    rotate rotor n=2 axis=z at=hub.center pin=origin {
      box blade size=1,9,0.3 pin=bottom mat=white
    }
  }
  def rusty_turbine : turbine { over rotor.r1.blade mat=rust }
  repeat farm n=3 step=20,0,0 on=ground { turbine t }
`;
const blades = (r, prefix) => r.items.filter((it) => it.path.startsWith(prefix + '.rotor') && /blade$/.test(it.path))
  .map((b) => `${b.path.slice(prefix.length + 7)}:${b.material?.name}${b.geom.h !== 9 ? `:h${b.geom.h}` : ''}`);

test('派生：改一台风车的一片扇叶（旋转副本），父类型加扇叶后修改仍在、其余风车不受影响', () => {
  const r = compile(windfarm + `
    over farm.1.t.rotor.r1.blade size=1,5,0.3
    over farm.1.t.rotor.r2.blade mat=rust
    def turbine : turbine { over rotor n=3 }
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(blades(r, 'farm.0.t'), ['blade:white', 'r1.blade:white', 'r2.blade:white', 'r3.blade:white']);
  assert.deepEqual(blades(r, 'farm.1.t'), ['blade:white', 'r1.blade:white:h5', 'r2.blade:rust', 'r3.blade:white']);
  assert.deepEqual(blades(r, 'farm.2.t'), blades(r, 'farm.0.t'));
  // 折断的那片仍从轮毂伸出、方向不变（与另一台的同一片只差风车间距）
  const W = (p) => r.nodes.find((n) => n.path === p).world;
  const a = W('farm.1.t.rotor.r1.blade'), b = W('farm.0.t.rotor.r1.blade');
  a.R.forEach((row, i) => row.forEach((v, j) => near(v, b.R[i][j], `R[${i}][${j}]`)));
  near(a.t[0] - b.t[0], 20, '间距'); near(a.t[1], b.t[1], 'y'); near(a.t[2], b.t[2], 'z');
  // 副本仍然记得自己来自哪里
  assert.equal(r.nodes.find((n) => n.path === 'farm.1.t.rotor.r1.blade').of, 'farm.1.t.rotor.blade');
});

test('换类型：over 实例 : 派生类型；派生类型里可以改旋转副本；父类型的变化继续传下来', () => {
  const r = compile(windfarm + `
    over farm.1.t : rusty_turbine
    def turbine : turbine { over rotor n=3 }
  `);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(blades(r, 'farm.1.t'), ['blade:white', 'r1.blade:rust', 'r2.blade:white', 'r3.blade:white']);
  assert.deepEqual(blades(r, 'farm.0.t'), ['blade:white', 'r1.blade:white', 'r2.blade:white', 'r3.blade:white']);
  assert.deepEqual(r.nodes.find((n) => n.path === 'farm.1.t').types, ['rusty_turbine', 'turbine']);
  // copy 块里也可以改副本；copy 复制的是定义，所以也跟着父类型变成 4 片
  const c = compile(windfarm + `
    copy extra of=farm.1.t on=ground[0,1,0.4] { over rotor.r1.blade mat=rust }
    def turbine : turbine { over rotor n=3 }
  `);
  assert.deepEqual(c.errors, []);
  assert.deepEqual(blades(c, 'extra'), ['blade:white', 'r1.blade:rust', 'r2.blade:white', 'r3.blade:white']);
});

test('换类型与改副本的错误提示', () => {
  const msg = (extra) => compile(windfarm + extra).errors.map((e) => e.message).join(' | ');
  assert.match(msg('over farm.1.t : nothing'), /没有这个类型或形状种类/);
  assert.match(msg('over farm.1.t.rotor.r1.blade : turbine'), /副本，不能单独换类型/);
  assert.match(msg('over farm.1.t.rotor.r9.blade mat=rust'), /没有/);
});

test('变体（外观）里的 mirror / rotate 也会生成副本', () => {
  const r = compile(`
    def fancy(w=1,h=1,d=1) { box core size=w,h,d
      rotate fins n=3 { box fin size=0.2,h,1 at=w/2,0,0 } }
    box ground size=50,1,50 pin=top
    cyl tower r=1 h=10 on=ground
    over tower use=fancy
  `);
  assert.deepEqual(r.errors, []);
  assert.equal(r.items.filter((i) => /\.fin$/.test(i.path)).length, 4);
});

test('保名换形：over 物体 : 种类 / 类型，名字与路径不变，引用它的关系照常成立；over 阵列 { … } 作用到每个实例', () => {
  const r = compile(`
    box ground size=40,1,40 pin=top
    box hall size=10,6,8 on=ground
    box sign size=1,1,0.1 against=hall.front
    def shed(w=4) { box body size=w,3,w
      wedge roof size=w,1,w on=body }
    over hall : subtract { box outer size=10,6,8
      box door size=4,4,2 at=0,0,4 }
    over sign : cyl r=0.5 h=0.1
    box hut size=4,3,4 on=ground[0.4,1,0.4]
    over hut : shed w=5
    repeat row n=3 step=4,0,0 on=ground[-0.4,1,-0.4] { box tank size=1,2,1 }
    over row { drop tank
      cyl tank r=0.5 h=3+idx }
  `);
  assert.deepEqual(r.errors, []);
  const kinds = Object.fromEntries(r.items.map((i) => [i.path, i.kind === 'csg' ? 'csg' : i.geom.type]));
  assert.equal(kinds.hall, 'csg');
  assert.equal(kinds.sign, 'cyl');
  near(box(r, 'sign').min[2], 4, '招牌仍然贴在厂房正面');
  assert.deepEqual(r.nodes.find((n) => n.path === 'hut').types, ['shed']);
  assert.deepEqual(['row.0.tank', 'row.1.tank', 'row.2.tank'].map((p) => r.items.find((i) => i.path === p).geom.h), [3, 4, 5]);
});
