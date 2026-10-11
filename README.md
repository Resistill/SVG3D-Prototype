# SVG3D：三维空间描述语言（原型）

AI 重建三维场景时，常用体素或点云逐格判断“这里有没有东西、是什么颜色”。人理解空间的方式不同：先看“它在谁上面、贴着谁、哪些是对称的、哪些在重复”，再给它起名字，比如墙、桥、门、梯。至于具体的墙长什么样，可以有很多种变体。

SVG3D 用这种方式描述场景，帮助 AI **理解场景**、从源模型**重建场景**，重建之后还能**编辑**和**风格化**。最终的使用方式是人与多模态模型协作：导入目标模型、逆向成 SVG3D 工程，再一起逐步细化与纠偏，把整个世界压缩下来。计划见 [docs/PLAN.md](docs/PLAN.md)（语言与逆向）与 [docs/PLAN2.md](docs/PLAN2.md)（人与 AI 协作的工作台），进展记录在两份计划的末尾。

## 原则

1. **描述而非生成**：源码说明“场景是什么”。需要执行一个过程才能得到的东西（随机、分支）不在语言里。
2. **可逆**：每个核心构造都能从几何里识别出来，或者是使用者显式声明的语义。
3. **关系优先，坐标是残差**：位置由关系求出；只有关系表达不了的部分才写坐标。
4. **压缩即理解**：对称、重复、同型（类型与派生）、集合，都是用更短的描述表达规律。
5. **几何客观，语义由使用者定义**：语言只有几何词；“桥墩”“房间”由 concept / pattern 定义。
6. **外包络与外观分离**：语义决定外包络，变体和风格只填充外观，所以风格化不会破坏空间关系。
7. **非破坏编辑**：基础描述和修改层是不同的文件，后面的层覆盖前面的层。
8. **诚实的近似**：空间事实带间隙与容差，拟合结果可以带置信度。
9. **保留语义就够**：逆向不要求 100% 复原，按档位（语义 / 结构 / 精细）决定精度，剩下的由人细化；粗糙而干净的语义也是风格化的好底子。

## 跑起来

```bash
npm run serve
```

打开 <http://localhost:5178>：左边写代码，右边实时预览。点击物体会定位到源码；「语义」标签列出概念、模式、变体和检查；「空间事实」标签列出从几何反推出的关系（按提供者分组，面板上方可以打开 `walkable` 等额外的提供者）。编译在 Web Worker 里进行，几千个物体的工程打字时界面也不卡。

- **浏览器内逆向**：「逆向 GLB…」选择、或直接把 `.glb` 拖进页面，在 Worker 里跑与 `bin/reverse.mjs` 相同的逆向（右边选档位：精细 / 结构 / 语义），结果作为没保存的新文件打开，「下载 .s3d」取走；与命令行的结果逐字节相同（同样的 `srcFile`，即 GLB 与 .s3d 放在同一目录时）。浏览器侧经 es-module-shims 在 Worker 里加载 `tools/*.mjs`，`@gltf-transform/core`、three 都从 CDN 取（版本写死），第一次要联网。
- **视角预设**：视图右上角的 iso / iso2 / top / front / back / left / right 与离屏渲染 `render --view=` 是同一份相机（`src/views.js`）；「快照」按预设截正方形图，工程模式下「离屏渲染」调 `render` 并与界面快照并排显示（同一个取景范围），人和 AI 说“iso 视角左上角那个”指的是同一张图。

打开任意 `.s3d` 文件：在地址后面加 `?file=路径`（相对于仓库根目录），例如工程的组合根 <http://localhost:5178/index.html?file=work/spaceport/scene.s3d>——它 import 的各层会一起加载。编辑器上方的「文件」列表列出组合根和它 import 的所有文件（缩进表示层级），可以切换查看、修改；点击物体会自动切到它所在的文件并选中那一行（类型实例的部件定位到放置实例的语句，Alt+点击才跳到 `def`）。修改后 Ctrl/⌘+S 或「保存」写回磁盘（只能覆盖已有的 `.s3d` 文件）；工具改过文件后刷新页面即可看到。

```bash
npm test
```

```bash
node bin/s3d.mjs examples/spaceport.s3d
```

```bash
node bin/s3d.mjs out/spaceport.L1.s3d --outline=2 --semantics
```

`--outline` 输出分层概要：阵列与副本折叠成一行，每行给出类型、尺寸、实体数、主要关系和识别出的概念，适合作为 AI 阅读大场景的入口；`--semantics` 附加通用语义库。

```bash
node bin/stats.mjs
```

示例：`spaceport`（航天基地）、`spaceport_edit`（修改层）、`spaceport_blueprint`（风格层）、`semantics`（变量、集合、语义）、`curves`、`rotation`、`basics`。

## 一个例子

```
box pad size=26,2,26 on=ground[0.25,1,0]

group rocket on=pad {
  cyl stage1 r=2.4 h=28
  cyl stage2 r=2 h=14 on=stage1
  revolve nose profile=[(2,0); (1.9,2.5); (1.45,5); (0.7,6.6); (0,7)] smooth=true on=stage2
  rotate fins n=3 about=stage1 {
    wedge fin size=3.5,6,0.4 turn=180 at=stage1.w/2,0,0 pin=bottom-right
  }
}
mirror tower2 of=tower across=rocket axis=x

concept deck = kind(box) & on(pier, 2)
```

把 `stage1` 改高，`stage2`、整流罩、摆臂都会跟着移动；改 `tower`，镜像的 `tower2` 跟着变。

---

## 语言参考

### 坐标约定
单位是米，Y 轴朝上，`+x = right/east`，`+z = front/south`。每个物体有自己的局部坐标系，可以任意三维旋转；镜像副本的坐标系是反射的。**基本体的原点在底面中心**。

### 实体

| 写法 | 说明 |
|---|---|
| `box size=w,h,d` | 长方体 |
| `cyl r= h= axis=y` · `cone r= r2= h=` | 圆柱 / 圆台，可沿 x / y / z |
| `sphere r=` · `wedge size=w,h,d` | 球 / 楔形（+x 一侧高） |
| `revolve profile=[(r,y); …] smooth=true angle=360` | 轮廓绕竖直轴旋转，自动在轴上封口 |
| `span from=A to=B section=w,t` | 连接两点的实体；`r=` 圆杆，`steps=n` 台阶，`pin=bottom` 让底面贴着连线 |
| `span from=A drop=B dir=down` | 从 A 沿方向延伸，直到碰到 B 的面（立柱、桩） |
| `sweep path=C profile=rect section=w,t` | 截面沿曲线扫掠；`profile=circle r=`，或任意多边形 `profile=[(u,v); …]` |
| `pipe path=[A; B; C] r=` | 圆管的简写，拐角自动倒圆 |
| `mesh src="文件.glb#节点" size=w,h,d pivot=x,y,z` | 引用源模型里的网格。`size` 是外包络（原点在底面中心），`pivot` 是网格在源文件坐标里对应这个原点的点。它照样参与所有关系，空间事实标为近似 |

### 曲线（不是实体）

| 写法 | 说明 |
|---|---|
| `arc r= angle=a0,a1 rise= plane=xz` | 圆弧；0° 指向 +x，俯视逆时针；`plane=xy/zy` 为竖直平面里的弧 |
| `helix r= pitch= turns=` | 螺旋线 |
| `bezier path=[…]` · `spline path=[…] closed=true` · `line path=[…]` | 贝塞尔 / 过点样条 / 折线 |
| `C.start` `C.mid` `C.end` `C[0.3]` | 曲线上按弧长取点 |

### 关系（决定位置）

| 写法 | 含义 |
|---|---|
| `on=B` · `under=B` | 放在 B 的顶面上 / 贴住 B 的底面 |
| `against=B.left` | 贴住 B 的某个面（自动选用自己朝向它的面） |
| `inside=B` | 中心对中心放进 B |
| `at=x,y,z` · `at=B` · `at=B.top` · `at=B[u,v,w]` | 把自己的 `pin`（默认底面中心）放到某一点；`at=B` 是 B 的几何中心。`at=` **不**继承 B 的朝向 |
| `align=left,back` · `alignto=C` | 再与参照物的这些面对齐（`x/y/z` 为中心对齐） |
| `gap=` · `offset=x,y,z` · `pin=` | 沿法线留空 / 平移 / 定位点（也是旋转支点） |

- `B[u,v,w]` 在 **B 自己的坐标系**里按包围盒归一化取点（每轴 −1..1，0 是中心，`[0,1,0]` 是顶面中心）；B 转了，取点跟着转。
- `offset=` 在**父坐标系**里平移（顶层就是世界坐标，`repeat` 里是实例的坐标系），不随参照物旋转；它叠加在定位关系之上，单独写 `offset` 不起作用（没有关系时直接写 `at=x,y,z`）。
- `on=B[u,1,w]` 与 `on=B offset=dx,0,dz` 落点可以相同；逆向会挑描述更短的那种。

### 朝向

`turn`（绕竖直轴）、`tilt`（顶部倒向前）、`roll`（顶部倒向右）、`rot=(x,y,z,deg)`（任意轴）、`aim=B aimwith=top`（让某个面指向目标）。顺序是 基准 → turn → tilt → roll → rot。`on/under/against/inside` 继承参照物的三维朝向，角度都相对参照物；`repeat` 也继承。

### 锚点与度量
`B.top`、`B.top-left-front`、`B.origin`、`B[u,v,w]`（包围盒内 -1..1）、`B.top+(0,2,0)`；尺寸 `B.w B.h B.d`；坐标分量 `B.top.y`（在当前父坐标系里）。路径如 `hangar.body.right`、`tanks.0.tank`。

### 构造与派生

| 写法 | 说明 |
|---|---|
| `group { … }` · `union` · `subtract` · `intersect` | 分组与布尔运算 |
| `material m color=#… default=true` | 默认材质：哪儿都没写 `mat=`（自己和上级都没有）的物体用它 |
| `metre` | 内置常量：一米是多少个场景单位（默认 1；工程按 `unit` 设置），按米写的阈值写成 `3 * metre` |
| `group x envelope=w,h,d { … }` · `envelope=x0,y0,z0,x1,y1,z1` | 名义外包络：关系、锚点、定位点按它算，与内容无关（细化后挂在它上面的物体不动） |
| `repeat n= step= turn= center=true` · `repeat n= along=C orient=yaw\|full\|none` | 网格阵列 / 沿曲线分布；子语句里可以用 `i j k idx` |
| `def name(p=默认值) { … }` | 类型（参数化模板）。模板声明的参数优先于同名的定位关键字 |
| `def B(新参数) : A(覆盖的默认值) { over … ; drop … ; 新部件 }` | **类型派生**。`kind(A)` 包含派生类型（is-a） |
| `def A : A { … }` | 就地扩展类型：所有实例随之改变 |
| `mirror R of=A across=B axis=x` · `rotate R of=A about=B axis=z angle=90` | **变换派生**：副本跟随原物体；可以单独修改副本里的某个部件（见下） |
| `mirror across=… { … }` · `rotate n= about= axis= { … }` | 对称组 / 旋转对称 |
| `copy R of=A [定位] { over … ; drop … ; 新部件 }` | **结构派生**：把 A 的定义在 R 处重新展开，之后可以随意修改 |
| `over 实例 : 类型` | **换类型**：把一个实例（例如阵列里的某一台）换成另一个类型，通常是派生类型；它仍然是阵列的成员，父类型的变化继续传下来 |

### 修改：over 与 drop

```
over 选择器 [属性=值 …] [{ over … | drop … | 新语句 … }]
drop 选择器
```

- 选择器可以是路径、`#tag`、`kind()`、集合运算。写在模板体或块里时，只作用于该实例或成员内部。
- 改了定位关系（on/at…）时，原来的定位关系作废。改模板参数或阵列数量时，按新值重建该节点。
- 表达式在**写它的地方**求值，所以修改层里的 `let` 变量可以直接用。
- **两个时机**：改几何、结构的 over/drop 在求解之前生效，选择器不能依赖空间事实；**只改外观**（`mat`、`color`、`use=`）的 over 在求解之后生效，选择器可以用概念和关系谓词。
- 后写的覆盖先写的。
- **保名换形**：`over 物体 : 种类或类型 [新参数…] [{ 子物体 }]` 换掉形状种类或类型，名字与路径不变，所有引用它的 `on=` / `at=` / `against=` 都不用改。例如 `over hall : subtract { box outer size=10,6,8 ; box door size=4,4,2 at=0,0,4 }`（给厂房开门洞）、`over sign : cyl r=0.5 h=0.1`、`over hut : shed w=5`。基本体与容器之间换只保留定位与外观；模板换成它的派生模板保留全部参数。
- **改阵列的模板**：`over 阵列 { drop 部件 ; 新语句 }` 作用到每一个实例上（块里可以用 `i j k idx`）。
- **改副本**：路径经过 mirror / rotate 副本的修改（`over farm.1.t.rotor.r1.blade size=1,5,0.3`）在副本生成之后生效，只改那一个副本；没改的部分仍然跟随原物体。改原物体（`rotor.blade`）则所有副本一起变。副本不能单独换类型或改模板参数（改用 copy）。

一个完整的例子：三台风车是同一个类型的实例，一台换成派生类型、另一台的一片扇叶折断；之后父类型加一片扇叶，三台都变成四片，生锈和折断都还在。

```
def turbine(h=20) {
  cyl tower r=0.8 h=h
  sphere hub r=0.8 on=tower
  rotate rotor n=2 axis=z at=hub.center pin=origin { box blade size=1,9,0.3 pin=bottom }
}
def rusty_turbine : turbine { over rotor.r1.blade mat=rust }
repeat farm n=3 step=20,0,0 on=ground { turbine t }

over farm.1.t : rusty_turbine                 // 这一台换成派生类型
over farm.2.t.rotor.r2.blade size=1,5,0.3     // 那一台的一片扇叶折断
def turbine : turbine { over rotor n=3 }      // 父类型：三片 → 四片
```

### 层：import

```
import "spaceport.s3d"        // 基础描述（可以是逆向工具重新生成的）
over tower lv=10              // 修改层只写修改
```

`import` 把另一个文件的语句按顺序放在这里。**修改层**写几何修改；**风格层**只写外观（重新定义材质、`over … use=模板`），外包络不变，空间事实不变。错误会带上它来自哪个文件。

### 变量与集合

| 写法 | 说明 |
|---|---|
| `let 名字 = 表达式` | 变量：数、向量、对象、集合。块内整体可见，惰性求值；最外层的 let 在模板里也可见 |
| `#tag` · `kind(box, house)` · `a.*.b` · `all()` · `[a; b]` | 集合：按标签 / 类型（is-a）/ 路径通配 / 全部 / 列表 |
| `A \| B` · `A & B` · `A - B` · `children(S)` · `descendants(S)` | 并 / 交 / 差 / 下级 |
| `S where 条件` | 逐个成员筛选：`w h d`（自身尺寸）、`x y z`（世界中心）、`top bottom`（真实形状在世界里的最高 / 最低点）、`kind`、`name`、`it`，以及成员的元数据 |
| `on(S, k)` · `supports(S)` · `against(S)` · `inside(S)` · `contains(S)` · `touching(S)` · `intersects(S)` | 按空间关系筛选（求解后才有，只能用在语义层） |
| `sin cos tan sqrt abs min max floor ceil round pow count` | 函数（角度用度） |

### 语义层

| 写法 | 说明 |
|---|---|
| `concept 名字 = 集合` · `concept 下位 : 上位 = where 条件` | 一元语义及其层级 |
| `pattern 名字(角色, 集合角色*) { 角色 in 集合 ; 甲 关系 乙 ; 布尔表达式 }` | 多对象模式；`名字.角色` 取绑定，`count(名字)` 是匹配次数 |
| `check "说明" 表达式` | 规则检查：集合为空或条件为真即通过 |
| `style 集合 mat= color=` · `variant 集合 use=模板` | 外观覆盖的简写，等价于只改外观的 `over` |
| `material 名字 color= metal= rough= opacity=` | 材质，用 `mat=名字` 引用；后定义的覆盖先定义的 |

概念有自己的命名空间，只在 concept / pattern / style / check 里可见，不会和几何里的同名对象冲突。同名概念以后写的为准，所以场景可以覆盖 import 进来的定义。变体（`use=`）只填充外包络，对语义层不可见。

### 通用语义库

`lib/semantics.s3d` 用几何与关系定义常见构件：`terrain` `slab` `platform` `wall` `member` `column` `beam` `roof` `volume` `tank` `prop` `step`。定义只用与写法无关的量（最长 / 最短边 `max(w,h,d)` `min(w,h,d)`、世界高度 `top - bottom`），所以一根梁不论写成 `box(w=6)`、转过 90° 的 `box(h=6)`，还是逆向得到的 `mesh`，理解都相同。

```
import "../lib/semantics.s3d"
concept column = all() where top > 5        // 覆盖库里的定义
concept truss_leg : column = on(platform)   // 派生更细的概念
```

### 元数据

任意语句上可以写 `~key=value`，例如 `~fit=0.93 ~src="node_117"`。它不参与几何，可以在 `where` 里读（`all() where fit < 0.5`）。逆向工具用它记录拟合残差与来源，修改层也可以按它寻址。

---

## 空间事实

求解之后，编译器检查每一对靠得足够近的物体，**每对只输出最强的一条关系**：

`on` > `against` > `inside` > `touching`（接触）> `intersects`（相交）

- `on`、`against` 在参照物自身的坐标系里判断，所以 “A against B.left” 指的是 B 自己的左面，旋转后仍然成立。
- 接触与相交按真实形状判断：盒子、楔形、梁是精确的多面体，圆柱、圆锥是 12 边棱柱，球是精确的，扫掠按每一段的凸包；revolve 和 mesh 暂用外接形状，标为近似。
- 每条事实带实测间隙 `gap` 和容差 `eps`。
- 事实由**提供者**推导（`{ name, derive(objs, ctx) → facts }`），每条带 `provider`。上面五种是默认的 `contact`；`walkable`（顶面朝上、上方净空 ≥ 2 m 的部分面积 ≥ 0.36 m² 的物体，一元事实 `X walkable`，b 为 null）默认不启用：`compile(src, { factProviders: ['contact', 'walkable'], factOptions: { walkable: { clearance: 1.8 } } })`。自己的提供者用 `registerFactProvider(p)` 注册后按名字打开，或直接把对象放进 `factProviders`。长度按米，随 `factEps` 换算成场景单位。

事实是逆向管线的地基：从源模型拟合出的部件，通过事实得到关系，再压缩成可读的描述。

## 逆向管线：源模型 → SVG3D

```bash
node bin/export.mjs examples/spaceport.s3d out/spaceport.L0.glb --level=L0
```

```bash
node bin/reverse.mjs out/spaceport.L0.glb out/spaceport.L0.s3d --fidelity=detail
```

```bash
node bin/eval.mjs examples/spaceport.s3d out/spaceport.L0.s3d
```

也可以一步跑完：`npm run roundtrip`。

1. **读取部件**：按 glTF 节点；合并过的网格（L2）按连通分量拆开。节点名不唯一时，来源标识写成 `名字@k`。物体名从节点名清理而来：去掉路径、资产前缀、贴图尺寸、场景里大多数名字都带的词（资产库的主题、类别），`Cube` / `Plane` 一类默认名交给语义命名；`~src` 保留原名。
   **享元类型**：同一个网格（加同样的缩放与镜像）被多处使用时，只拟合一次，写成 `def` + 若干实例——宿舍区 203 种类型覆盖 1782 个实例。
2. **拟合基本体**：候选坐标系有三种（直立的最小外接矩形、主成分、按面积聚类的面法线），候选形状有盒、圆柱、圆台、球、楔形，弯曲的管道（表面点沿法线退一个半径得到中心线，拟合 Catmull-Rom，写成 `pipe path=[…] r=…`；笔直的管道仍写成圆柱），台阶（朝上的踏面大小相近、高度等差、沿一条直线等距排开，写成 `span … from= to= steps=n section=宽,厚`；L2 里一串踏步盒子组成的线性阵列也写成它），以及旋转体（横截面是圆的，沿轴取外轮廓写成 `revolve profile=[…]`；结构档、精细档）；粗档位偏向更简单的形状；按表面采样点到候选表面的距离（以最薄方向归一化）加封闭网格的体积校验来打分。拟合不了的保留为 `mesh`，直接引用源网格；网格表面积与基本体表面积之比（覆盖率）低于 0.3 的大型不规则网格（地形、路面、贴花）同样保留为网格，不硬套成大盒子。
   **板件**（结构档）：拟合差的大部件（2 m 以上、表面八成以上落在几个大平面上）再试一次板件分解——按平面拆成墙板、楼板、坡道，门窗洞空出来，写成 `group 名字 { box wall … }`；在这个部件自己的源表面上与基本体（或网格引用）比评分，更好才用。享元类型同样适用（类型体是一组板件，残差按实例数计）。宿舍区结构档逆向 57678 → 49778（−13.7%），H1 66842 → 63779（−4.6%）。
   每个部件带 `~fit`（拟合度）与 `~src`（来源节点）。
3. **压缩**（压缩即理解）：同形状的物体之间如果总是同一个刚体运动，就是阵列——平移（直线、网格）、绕任意轴旋转（`rotate` 容器，整圈或一段圆弧）、螺旋（带 `turn` 的 `repeat`）；等弧长排在一条曲线上、朝向随切线变化的，拟合出这条曲线（Catmull-Rom 控制点 + 成员的固定偏移，Levenberg–Marquardt），写成 `spline` + `repeat … along=`；长度各不相同、都立在同一个物体上的竖直杆（过山车立柱），按顶点拟合曲线，写成 `span … from=顶点 drop=支撑物`——长度由关系决定，不再是各自的数；几组阵列在同一条曲线上时共用它；同一运动的几组阵列合并成多部件的 `repeat`；缺成员的阵列写成 `repeat` 加 `drop 阵列.k`（只在比逐个写出更短时才算规律）；成对对称的物体或阵列写成 `mirror … of=…`，镜像面写成“过某物中心、垂直于它的某根轴”。
4. **关系**：先发射全坐标版本、编译得到空间事实，再自下而上为每个物体选一条主关系（`on` / `against` / 相对某物的锚点），朝向写成相对参照物的。锚点只是就近取的参照：粗档位（语义、结构）下世界坐标写得更短就写坐标，精细档保留锚点。
5. **校验**：编译关系版本，逐个比对几何中心与（考虑对称的）朝向；不一致的阵列拆开、物体退回坐标。
6. **档位**（`--fidelity=semantic|structure|detail`）：一个容差参数同时决定拟合失败时是否退回网格、数字位数、角度取整、阵列与校验的容差。`semantic`（25 cm）一律用基本体当语义代理，得到干净的灰盒；`structure`（5 cm）结构清楚、细节交给人；`detail`（5 mm）尽量复原。阵列的步长按实例数单独取精度，取整误差不会逐级累加。
   **场景单位**（`--unit=每个场景单位多少米`，默认 1）：档位的容差都按米写，进入计算前换算成场景单位（数字位数按 10^−位数 米折算），所以同一个场景用米、厘米或 stud（0.28 m）逆向，得到的形状、阵列、镜像相同，残差分数也相同。
7. **命名**：源模型没有名字时（L1/L2），按通用语义库识别出的概念起名：`box46` → `terrain`，`cyls_2` → `columns`，阵列里的子物体 → `column`、`prop`。输出文件已经存在时，把它当作上一次的结果：几何上对得上的物体沿用原来的名字，所以源模型改动后重跑逆向，编辑层里的 `over` / `drop` 路径仍然有效（`--fresh` 重新起名）。

**评测**（`bin/eval.mjs`）：按紧包围盒 IoU 一一匹配对象，报告形状种类正确率、空间事实的 P/R/F1、语义识别的 P/R/F1（两边都附加通用语义库，逐个概念比较成员）、阵列与镜像的召回、世界坐标依赖率、语句数比。三个难度：L0 保留名字、L1 抹去名字并打乱、L2 按材质合并网格。

航天基地（L0）的往返结果：

| 指标 | 结果 |
|---|---|
| 形状种类 | 101/101；10 个复杂形状（弯道、管线、抛物面天线…）里 2 根弯管拟合成 `pipe`，其余保留为源网格引用 |
| 平均 IoU | 1.0 |
| on/against F1 | 0.976（on 为 1.0） |
| 阵列召回 | 85/85：燃料罐 [罐, 顶, 环]、两座塔的平台 [平台, 斜撑]、2×2 的塔腿与灯塔、尾翼的旋转对称、24 级螺旋楼梯 |
| 镜像召回 | 48/48（原件与副本两侧都算；L1 同样是 48/48）：对侧的塔与摆臂、厂房两翼 |
| 世界坐标依赖率 | 5.9% |
| 语义识别 F1 | 1.0（L1 也是 1.0，L2 为 0.96） |
| 语句数比 | 0.76（逆向结果比原文还短） |

稳定命名：把 spaceport 改成 spaceport_edit（火箭加长、塔改 10 层、罐 3 → 5 个、拆一根灯、加一座厂房）后带着上一次的结果重跑 L1 逆向，源里没改动的物体 25/25 沿用了原来的路径（不带上一次结果时只有 17/25）。拆掉一根灯后，逆向写出的是 `repeat lights n=(2,1,2) … drop lights.3`——和修改层里人写的那一句一样。

已知局限：单独一对的镜像不会让描述变短，所以不写成 mirror；嵌套的规律没有嵌套地写出（斜塔各层的环是一个阵列，但每层的一圈立柱是 7 个各自独立的 rotate）；螺旋形的管（扶手）和“盒子减去门洞”这类构造还认不出来；有内部空间的大楼外壳在结构档第一遍就拆成墙板与楼板（语义档仍是实心体块，交给细化）；L2 的分割会把多块组成的部件拆碎；源模型带变体（`variant`）时，逆向描述的是变体的外观几何。

## 协作工具：人与 AI 共用的工程

最终的使用方式是人与多模态模型协作：模型读场景（图像 + 文本），用 SVG3D 的工具和自己的编码能力压缩场景；人在界面里选中物体、指出问题、确认或否决。两边共用同一个工程目录、同一套工具（计划见 [docs/PLAN2.md](docs/PLAN2.md)，工具手册见 [docs/agent.md](docs/agent.md)）。

```bash
node bin/s3d-tool.mjs init out/spaceport.L2.glb --fidelity=structure --project=work/spaceport
```

源模型之外还有关卡导出的表（类别、碰撞类型……）时加 `--sidecar=表.csv`：按节点名对上源部件（匹配列、位置列自动推断），分类列写成物体的 `~元数据`，可以在 `where` 里读（`all() where collision_profile == "NoCollision"`）。

源模型不是按米建的，加 `--unit`（每个场景单位多少米，如厘米 0.01、stud 0.28）。不给时按部件尺寸猜：明显偏大才猜成厘米或毫米，结果里的 `unitNote` 提示确认；已有的工程用 `reverse --unit=… --fresh` 改。

```bash
node bin/s3d-tool.mjs score --project=work/spaceport
```

```bash
node bin/s3d-tool.mjs render --focus=beam_1 --project=work/spaceport
```

- **工程**：`base.s3d`（逆向结果，可重新生成）+ `edits.s3d` / `semantics.s3d` / `style.s3d` / `decisions.s3d`（决定层：忽略、合并、指定形状与名字、保留网格、锁定定位，重跑逆向时必须满足），由 `scene.s3d` 组合；档位和场景单位（`unit`）记在 `project.json`，分数常数（δ、`dMax`）与输出的误差一律按米。基础层超过 400 行（`project.json` 的 `splitLines`）时自动拆成多个文件：`base/types.s3d`（材质与类型）+ 按楼栋聚组（立在楼上、靠着楼、在楼的投影里的物体跟着楼走）再按水平位置分区的 `base/NN-名字.s3d`，`base.s3d` 只做索引；名字跨文件可见，拆分不改变编译结果与分数。
- **看**：`render` 离屏渲染（纯 JS，零依赖）：多视角、物体编号标注（去重叠）、聚焦时被选中的物体不会被遮挡、误差热图、源模型与重建结果共用取景对照（可用正交相机）。
- **查**：`outline`、`inspect`（`--source` 看源模型的部件：包络、主轴尺寸、建议语句）、`select`（集合表达式）、`similar`（同形部件，类型与阵列的候选）。
- **做**：AI 的修改以提议出现——`propose` / `preview`（逐物体的分数变化，可渲染提议后的场景）/ `accept` / `reject`；`check` 空跑；`note` / `inbox` 是人与 AI 之间的留言；每次调用都记在 `state/log.jsonl`。
- **细化**：`refine <物体> --to=structure|detail` 把物体对应的源网格按更细的档位重新描述：生成几个候选（全部分量在物体坐标系里再逆向一次 / 按面积只留大块 / 拟合差的大块换成体素或板件 / 整体体素 / 整体板件——按平面拆成墙板、楼板、坡道，门窗洞空出来，适合有内部空间的楼），用邻域评分（全场分数在这个物体附近的变化：它自己和附近的源部件、附近的重建物体，同材质规则与全场一致）挑最好的——粗档位下窗框、饰条这类“写出来比省掉的误差还贵”的小构件自然被舍弃。类型实例细化的是类型本身（邻域评分按实例数计）；名字、关系、阵列都不变，名义外包络 `envelope` 保证挂在它上面的物体不动；`--auto` 从最差的物体开始逐个细化，邻域评分没变好的直接跳过，其余按目标档位的尺子全场评分，变好才保留（普通物体的邻域评分与全场分数的变化相差不到 0.1）。细化出来的子块记着来源 `~src="部件#分量"`，可以再细化（逐层细化）。自动细化的每一项写进独立的 `edits/refine-<目标>.s3d`，`edits.s3d` 里只多一行 import。网格引用也能细化（合批的贴花、标线），表面被周围物体解释了的还可以“去掉”（保留名字与外包络）。
- **评**：`score` 自评分数，不需要真值：有效描述长度 + 网格引用 + 双向几何残差（容差以内不计、优先量到同材质的表面），越低越好；`explain` 是相对“全部保留网格”的解释率，`worst` / `worstSources` 指出下一步最值得修的地方。同一个进程里反复评分（MCP 服务、`refine --auto`、连续预览提议）是增量的：只重算改动影响到的物体与采样点，结果与全量评分逐位一致（H1 上一次全量 12 s，一次细化之后的增量 0.3–1.5 s）。在 spaceport L0 上：全部网格引用 8081 > 全世界坐标 3027 > 完整逆向 1668 > 手写原文 720。
- **MCP**：`node bin/s3d-mcp.mjs --project=…`，工具与命令行是同一张表，`render` 直接返回图像。
- **界面**：`npm run serve` 后打开 `index.html?file=work/<工程>/scene.s3d`（或 `?project=work/<工程>`）。同目录有 `project.json` 时进入工程模式：空间事实的容差按场景单位换算，`base.s3d` 与 `base/` 只读（灰色）；工程栏显示 `score.json` 的总分、解释率与最差 5 个物体（点击定位），视图可切换 实体 / 误差热力（满刻度 4δ）/ 源模型半透明叠加。对象面板是可折叠的节点树，双击或「只看」进入隔离视图（可叠加它对应的源模型部件，Esc 退出）。点物体（Shift 多选）写 `state/selection.json`，「选中」面板显示 `inspect` 的内容（所属阵列 / 类型可点击高亮同类、关系、来源、逐物体分数）；「提议」面板预览 / 接受 / 否决提议，「交给 AI」把留言连同选中写进收件箱。保存时会检查磁盘上的版本，文件被工具改过就提示重新加载或覆盖。这些功能靠 `bin/serve.mjs` 的 `/api/*`（`/api/project`、`/api/run` 调同一张命令表、`/api/selection`）；纯静态托管（或 `--no-api`）时只剩只读的部分。

**实战**：在真实游戏地图的两个区域上跑通了“逆向 → 自动细化”（各约 2000 个实例，其中一个有 1400 多个室内物件）：语义档逆向 4–8 s，布局、阵列、类型、室内隔墙与座椅都在；结构档自动细化把大楼外墙从 108 块收敛到 12 块。大场景先用 `node bin/crop.mjs <大.glb> <小.glb> --box=x0,y0,z0,x1,y1,z1` 裁出一块（保留实例化、去掉没用到的网格）。部件很多（≥ 1500）时逆向自动用 worker 线程并行拟合；`bin/stress.mjs N` 是规模压力测试（N×N 份 spaceport，10×10 约 1.1 万个部件，约 1 分钟）。过程与问题记在 [docs/PLAN2.md](docs/PLAN2.md) 的进展记录里，**后续工作见文末的待办清单**。

第一次 AI 在环实验（[experiments/E1](experiments/E1/report.md)）：子 agent 只用这些工具和渲染图改进 spaceport L2 的逆向结果，20 条提议接受 12 条，分数降了 42%，真值评测的每一项几何、关系、语义指标都随之改进。

## 求解是怎么做的

1. **解析与导入**：源码解析成语句树，`import` 的文件按顺序展开。
2. **展开**：模板实例化（沿派生链），阵列复制成实例。
3. **结构派生与修改**：展开 `copy`，按顺序应用 over/drop，再生成 mirror/rotate 的副本（副本跟随修改后的原物体）。
4. **求解**：每个物体的变换由它的关系惰性算出，依赖自动排序；容器里引用外部对象的子物体会被识别为“后置”，从而打破循环。
5. **事实与语义**：推导空间事实，然后识别概念与模式、应用样式、运行检查。有 `variant` 时编译两遍：第一遍识别语义，第二遍在外包络里换上变体。

## 局限

- 每个物体由一条主关系定位，还不是通用约束求解器。
- 锚点基于包围盒；还没有曲面锚点（圆柱侧面的 θ 角）和地形。
- copy 复制的是原对象的定义，不包括后来对原对象的 over。
- 改模板参数会重建该实例，之前对其内部的修改需要写在参数修改之后。
- 逆向管线的局限见上一节。
- 场景单位只在工程（`project.json` 的 `unit`，界面在工程模式下也按它换算）和逆向命令行里生效；界面打开不在工程里的 `.s3d` 时空间事实的容差仍按米（2 cm）。
- 后续工作见 [docs/PLAN2.md](docs/PLAN2.md) 末尾的待办清单。
