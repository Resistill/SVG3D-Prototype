# SVG3D 计划 2：人与 AI 协作的逆向工作台

> 定位不变：用语言描述世界，把重复与关系抽象出来，把世界压缩下来；逆向得到的工程高度可编辑，人与多模态模型在同一个工程、同一套工具上协作迭代。本计划接续 docs/PLAN.md 的“进展记录”，处理主会话确认的 12 项差距。
>
> 起草时核实到的新事实（影响优先级）：
> - **差距 11 的原因**：`tools/reverse.mjs` 的 `primitiveOf`（第 311–317 行）把不直立的盒子规范成“局部 y = 最长边”，第 333–335 行把不竖直的圆柱写成 `axis=x`。倾斜 25° 的光伏板因此写成 `box panel size=2.8,5,0.1 rot=…`，斜塔立柱写成 `cyl col axis=x rot=(0,0,1,85)`，局部 y 不再是站立方向，编译器 `onTest`（`src/s3d.js:2176`，要求 A、B 竖直轴平行且 A 底贴 B 顶）永远不成立。rotation 的 on 真值 237 条只找回 28 条，就是这个原因；不是事实推导的问题。
> - **L2 没有诚实的兜底**：`splitComponents` 拆出的分量 `name` 为空，`primitiveOf` 第 289 行的 mesh 退路要求 `part.name`，厂房被硬写成 `box volume_1 size=58,22,26 ~fit=0`。
> - **享元线索在读入时丢失**：`partsOfDocument`（reverse.mjs:43）逐节点取 `node.getMesh()`，三角形直接变换到世界坐标，网格身份与节点矩阵都没保留。
> - 阵列成员行只有 `~fit` 没有 `~src`（emit 第 563/588/624 行），所以“逆向对象 ↔ 源部件”的对应目前只对普通物体成立。
> - reverse 测试全套 10.4 s；rotation（321 部件）单次逆向约 7 s。

---

## 1. 原则

延续 PLAN.md 的 9 条（描述而非生成、可逆性的操作定义、关系优先坐标是残差、MDL、几何客观语义分层、语义层只读几何、非破坏分层、诚实近似、核心小靠组合），补充：

10. **人与 AI 共享同一个工程与同一套工具。** 不给 AI 单独的接口：GUI 里人能做的每件事（看、查、做、评）都有同名的命令行工具；AI 用的工具与 GUI 调的是同一个函数。工程就是目录里的文本文件，两边都能读。
11. **工具确定、可复现。** 相同输入得相同输出（采样已用 `rng(seed)`），一律 JSON 输出；每次工具调用可以记录并回放。没有隐藏状态：选中状态、相机、批注、提议都是工程目录里的文件。
12. **AI 的修改以“提议”形式出现。** 提议是对某一层的一段差异（追加语句，或撤销某条语句），人可接受或否决；接受后才进入修改层 / 决定层。AI 永远不直接改 `base.s3d`（它是逆向重新生成的）。
13. **分数是目标函数，也是进度条。** 自评分数不依赖真值，由描述长度加残差构成；AI 以降低分数为目标，人以“解释率”看进度；有真值时再用 eval.mjs 校验分数本身。
14. **不为特定场景特化。** 新机制对任意集合、类型、规律成立；语言不增加只为某类资产服务的词。本计划新增的语言面只有：曲面锚点（3.5）、地形取点（3.6）、`~src` 的列表取值。决定层、提议、批注都不是语言特性，而是工具约定。

---

## 2. 协作循环的架构

### 2.1 参与者与数据流

```
 源模型 source.glb ──reverse(+decisions)──▶ base.s3d（机器层，可重生成）
                                               │ import
 人 ──GUI/编辑器──▶ edits.s3d  decisions.s3d  semantics.s3d  style.s3d
                       ▲            ▲
                       │ accept     │ accept
 AI agent ──propose──▶ proposals/NNN.s3d ◀── 人 reject/accept（GUI 或 CLI）
    │  ▲
    │  └── 读：outline / inspect / similar / slice / render(PNG) / score / inbox
    └───── 写：只写 proposals/ 与 state/agent.json
 GUI ──写──▶ state/selection.json（选中路径 + 相机）、inbox.jsonl（人的批注）
 score.mjs ──▶ score.json（总分 + 逐物体）──▶ GUI 热力图 / 进度条；AI 的目标函数
```

- **选中状态**：GUI 每次选中都写 `state/selection.json`（`{paths, camera:{pos,target}}`）。AI 的 `inspect --selection`、`render --focus=selection` 读它。这是人把“我说的是这个东西”交给 AI 的最简单通道。
- **批注**：人在 GUI 的“交给 AI”框里写一句话，连同当前选中写入 `inbox.jsonl`（`{t, paths, text}`）；AI 用 `inbox` 读（不自动轮询，人告诉它“看收件箱”即可）。
- **提议**：AI 写 `proposals/NNN-标题.s3d`，首行注释写目标层与理由（`// layer=edits  why=…`），正文是追加到该层的语句（撤销用 `// retract 路径 或 行号`）。工具 `preview NNN` 把提议叠加编译并算分数差；`accept NNN` 追加到目标层并把提议移到 `proposals/accepted/`；`reject NNN --why=…` 记到 `inbox.jsonl`，AI 下次能读到否决理由。
- **分数**：`score` 写 `score.json`，GUI 顶栏显示解释率与总分，对象列表可按“逐物体代价”排序并热力着色。

### 2.2 工程目录布局

```
myworld/
  project.json         源模型路径与哈希、层顺序、容差与分数常数、单位
  source/world.glb     源模型（只读，或 project.json 里写外部路径）
  parts.glb            逆向拆出的部件（L2 分量等源文件里没有节点的部件），mesh 引用的目标
  scene.s3d            组合根：按顺序 import 下面各层（GUI 与工具只编译它）
  base.s3d             逆向基础层（机器生成；带 ~fit ~err ~src）
  base.map.json        逆向对象路径 → 源部件列表、拟合候选、被决定层锁定的项
  decisions.s3d        决定层：人 / AI 对逆向的约束（4.6），reverse 的输入，不进 scene
  edits.s3d            修改层：几何修改（over / drop / copy / 新物体 / def 扩展）
  semantics.s3d        场景语义：concept / pattern / check（import lib/semantics.s3d）
  style.s3d            风格层：只改外观
  proposals/           AI 的提议；accepted/ rejected/ 子目录
  state/selection.json state/agent.json
  inbox.jsonl          人给 AI 的批注与否决理由
  score.json           最近一次评分
  renders/             离屏渲染输出
```

`scene.s3d` 内容固定为 `import "base.s3d"` `import "edits.s3d"` `import "semantics.s3d"` `import "style.s3d"`（各层文件本身不写 import；`eval.mjs` 的 `expand` 已能展开 import 计语句数）。谁写哪个文件：

| 文件 | reverse | 人 | AI |
|---|---|---|---|
| base.s3d / base.map.json / parts.glb | 写 | 不写 | 不写 |
| decisions.s3d | 读 | 写 | 经提议 |
| edits / semantics / style | — | 写 | 经提议 |
| proposals/ | — | accept / reject | 写 |
| state/、inbox | — | GUI 写 | 读；agent.json 自己写 |

---

## 3. 自评分数（`tools/score.mjs`）

目标：没有真值也能算；AI 的目标函数；人的进度条；逐物体可归因；防作弊。

### 3.1 定义

`S = L_stmt + L_mesh + R_src + R_recon`，越低越好。

**描述长度 `L_stmt`**：对 `base.s3d` 与 `edits.s3d`（不含 decisions、semantics、style、注释、`~meta`）的语句文本计价：
- 关键字、名字、属性键、引用、方向词：各 1。
- 数字：`1 + 0.5 × max(0, d − 1)`，d 为去掉末尾零后的小数位数。`26`→1，`31.5`→1.5，`38.2711`→2.5，`0.644711`→3.5。于是 `at=38.2711,1.6453,42.7711` 计 8.5，`on=pad` 计 2，`on=terrain[0.25,1,0]` 计 4.5。
- `def` 体只计一次，实例每个按自己的语句计；`repeat`、`mirror`、`rotate` 按写出的文本计（这正是压缩得分的来源）。
- `mesh` 语句照常计 token，另加 **`L_mesh = c_mesh × log2(1 + T)`**，T 为被引用网格的三角形数（“仍以原始网格保留的部分”按数据量计）。

**残差**（按几何，双向，Chamfer 式）：
- 源侧：对每个源部件表面采样（复用 `samplePoints`，600 点，固定种子），求到重建几何表面的距离 `d_i`（重建几何用 `src/geometry.js` 的 `itemGeometry` 生成，three-mesh-bvh 做最近点查询，两者都已是依赖；mesh 引用按源网格本身，距离为位姿误差）。`r_i = log2(1 + d_i/δ)`，`d_i` 以 `D_max` 封顶（默认 2 m，覆盖缺失即重罚）。**`R_src = c_res × Σ_部件 log2(1 + T_o) × mean_i r_i`**：部件越复杂，错误解释越贵。
- 重建侧：对每个重建物体表面采样，求到源表面的距离，同样公式，按物体归因，`R_recon`。它惩罚凭空多出的物体。

默认常数（写进 project.json，可调）：`δ = 5 mm`，`c_res = 4`，`c_mesh = 10`，`D_max = 2 m`。由此得到的拐点：mesh 引用的代价相当于平均误差约 4.7δ ≈ 2.3 cm 的拟合——误差大于此的拟合不如诚实地保留网格，小于此的拟合赢。

**汇总输出** `score.json`：`{S, L_stmt, L_mesh, R_src, R_recon, S_mesh, explain: 1 − S/S_mesh, objects:[{path, src, stmt, mesh, r_src, r_recon, meanErr, maxErr, tris}], worst:[…前 20]}`。`S_mesh` 是“全部写成 mesh 引用、用世界坐标定位”的基线分数，`explain`（解释率）是进度条；`worst` 是“下一步该修什么”的清单。

### 3.2 防作弊

| 作弊 | 为什么失败 |
|---|---|
| 全写成 mesh 引用 | `L_mesh` 按三角形数计，一个 500 三角形的部件约 90，而一个合格的 box 约 8 |
| 写成大量高精度坐标 | 数字按小数位计价；坐标不减少残差（拟合已精确），所以只增不减 |
| 删掉难的物体 | 源侧采样点找不到表面，`d_i = D_max`，`r_i ≈ 8.6`，再乘复杂度 |
| 凭空添加物体“填”残差 | 重建侧采样归因到该物体，`R_recon` 上升 |
| 把误差藏进 `~err` 元数据 | 元数据不计长度，残差按几何重算，不读 `~err` |
| 用超大 δ | δ 是工程设置，评测与实验里固定；报告里必须打印 δ |

### 3.3 与 eval.mjs 的关系与校准验收

- eval.mjs 继续作为有真值时的基准（形状、事实 F1、压缩召回、语义 F1）；score.mjs 是无真值的目标函数。两者都读同一份编译输出（`compile().items/nodes`）。
- **校准验收**（M0 必须通过，常数可调但一旦定下写进 project.json 默认值）：对 spaceport 的 `{全 mesh 基线, 全 at= 基线（reverse 的 absSrc）, compress=false, 完整逆向 L0, 手写原文}` 五个版本，分数必须严格递减；对 L0/L1/L2 三档，分数与 eval 的 `statementRatio × (1 + coordinateRatio)` 同序；rotation 修复差距 11 前后分数应下降（关系取代坐标）。
- M0 的 AI 在环实验里有真值（L2 的真值就是 examples/spaceport.s3d），记录每次迭代的 S 与 eval 指标，报告相关性。

---

## 4. 模块设计

### 4.1 离屏渲染（`tools/raster.mjs`，零新依赖）

- 输入：`compile()` 结果（或源 GLB 的部件三角形），输出 PNG（用 `node:zlib` 自写 PNG 编码器，约 40 行）与同名 JSON 图例。
- 纯 JS 光栅化：`itemGeometry` 得到世界坐标三角形 → 透视 / 正交投影 → 扫描线 + z-buffer，平头着色（法线·光向 + 环境），再输出三种缓冲：**颜色图**、**ID 图**（每个对象一种唯一色，图例 `color → path`）、**深度图**。
- 模式：`color`、`id`、`diff`（源与重建同相机，逐像素深度差热力图）、`error`（按 `score.json` 的逐物体 `meanErr` 着色）、`labels`（ID 图上用 5×7 点阵数字标注对象编号，图例给路径；不渲染文字字形，数字足够）。
- 相机预设：`iso`（0.75,0.55,0.9 方向，与 `Viewer.frame` 一致）、`iso2`、`top`、`front`、`left`，以及 `--focus=路径|selection`（按 `nodes[].box` 取景，取景逻辑与 `render.js` 的 `frame(box)` 相同，保证人看到的与 AI 看到的是同一视角）。默认 1024²，`--size` 可改。
- 性能目标：1e5 三角形 × 6 视角 < 5 s。
- 备选（不推荐）：Puppeteer 截图（新依赖、慢）；Node 里跑 WebGL（headless-gl，编译原生模块）。保留“浏览器预览里按同一相机预设截图”作为对照：在 `Viewer` 加 `snapshot(preset)`，用现有 `preserveDrawingBuffer`。

### 4.2 agent 工具集（`bin/s3d-tool.mjs` + `tools/mcp.mjs`）

一个入口 `node bin/s3d-tool.mjs <命令> [参数] --project=目录`，一律 JSON 输出到 stdout，错误到 stderr 且非零退出；`tools/*.mjs` 是库，`bin/` 只做参数解析。MCP：`tools/mcp.mjs` 用 stdio JSON-RPC 手写 `initialize / tools/list / tools/call`（零依赖，约 150 行），工具表从同一张命令表生成，所以 CLI 与 MCP 永远一致。

| 类 | 命令 | 输入 | 输出 | 实现依据 |
|---|---|---|---|---|
| 查 | `outline [--depth] [--path=前缀] [--region=x0,y0,z0,x1,y1,z1]` | | 分层概要（现有 `outline()`，加前缀与区域过滤） | tools/outline.mjs |
| 查 | `inspect <路径…> \| --selection` | | 该对象的源语句与所在文件行、props、世界盒、紧盒、所有事实、所属阵列 / 镜像 / 类型与同类成员数、副本来源 `of`、概念、`~meta`、逐物体分数、源部件列表 | `compile().nodes/facts/concepts`、base.map.json、score.json |
| 查 | `select "<集合表达式>"` | 如 `kind(cyl) where h > 5 and top > 30` | 路径列表 | 把表达式包成 `concept __q = …` 临时编译 |
| 查 | `similar <路径> [--tol=]` | | 全场景里同形同尺寸（容差内）的物体及其相对位姿 → “候选类型实例” | `detectArrays` 的 `sameSize`/`head` 签名 |
| 查 | `slice --region=… \| --near=<路径> --r=` | | 区域内对象的概要 + 外部关系（大世界放不进上下文时的切片） | 4.5 的空间索引 |
| 查 | `facts <路径或集合>` | | 事实列表（含 gap/eps/approx） | `compile().facts` |
| 查 | `diff <a.s3d> <b.s3d>` | | 按路径的语义差异（新增 / 删除 / 改了哪个属性 / 位姿差） | 两次编译后按路径比 `nodes` |
| 查 | `inbox` | | 人的批注与否决理由 | inbox.jsonl |
| 看 | `render --view=iso\|top\|… --mode=color\|id\|diff\|error\|labels --focus=… --out=` | | PNG + 图例 JSON | 4.1 |
| 做 | `fit <源部件… \| 路径> [--as=box\|cyl\|cone\|sphere\|wedge\|revolve]` | | 各坐标系 × 各形状的候选与误差，推荐一个 | `fitPart`、`_debugFits` |
| 做 | `detect-array <路径…>` / `detect-mirror <路径…>` / `detect-types [<路径…>]` | 对指定子集跑检测 | 候选 repeat / rotate / along / mirror / def 文本 + 误差 + 预计分数变化 | `detectArrays`、`detectCurveArrays`、`detectMirrors` 抽成可对子集调用（现在都接收 `objs` 数组，只需去掉对全局 `units` 的依赖） |
| 做 | `propose --layer=edits\|decisions\|semantics\|style --why=… < 语句` | | 提议文件编号；附叠加编译的错误与分数差 | 2.1 |
| 做 | `preview NNN` / `accept NNN` / `reject NNN --why=` | | | |
| 做 | `reverse [--region=…] [--fresh]` | 读 decisions.s3d | 重新生成 base.s3d / base.map.json / parts.glb；报告哪些决定没能满足 | 4.6 |
| 评 | `score [--objects] [--compare=上次]` | | 3.1 | tools/score.mjs |
| 评 | `check` | | 编译错误、check 结果、修改层里失效的路径（over 指向不存在的对象） | compile |

实现顺序：`inspect / outline / select / similar / render / score / propose / accept` 在 M0；`fit / detect-* / slice / reverse --region` 在 M1–M3。

### 4.3 类型抽取（def）

两条线索，先精确后近似：

1. **享元线索（引擎层）**：`partsOfDocument` 改为记录 `{meshId（Map 按 gltf Mesh 对象分配）, nodeMatrix, localTris}`，世界三角形按需生成。同一 `meshId` 的节点就是同一类型的实例；拟合只在网格局部坐标做一次（也是性能收益），实例位姿 = 节点矩阵。若一个 mesh 有多个 primitive（多材质），实例是一个 `group`。
2. **几何同形组**：对不在阵列里的部件，按接触图（`compile().facts` 的 on/against/touching）取连通分量作为“候选单元”；单元指纹 = 成员签名（kind + 量化尺寸 + 材质）与成员间相对位姿（量化）的规范排序。指纹相同的单元 → 一个 `def`，每个单元一条实例语句。规范化借用 `detectArrays` 的 `sameOrientation / relPose / samePose`。
3. **发射**：`def 名(…) { 成员，内部用 on/against/at=兄弟锚点 }`，实例 `名 inst_k on=… turn=…`（实例的定位走现有 `chooseFor`）。名字：有 glTF 名取公共前缀（`memberNames`），否则按语义库概念（`semanticNames` 扩到 def）。
4. **实体化**：阵列 / 镜像检测改为对“实体”（普通物体、def 实例、已识别阵列）进行，这样“一排房子”写成 `repeat { house h }`、“对称的两座塔”写成 `mirror`。顺序：享元类型 → 几何类型 → 阵列（对实体）→ 镜像（对实体）。
5. **接受准则**：按 3.1 的长度计算，`def` 体一次 + 每实例一条 < 原来逐个写出，才采用（`worth()` 的推广）。只有尺寸不同 → 参数化（M5）；少数部件增删 → `def B : A`（M5）。
6. 验收：spaceport_edit 的 `hangar2`（copy 出的第二座厂房）在 L1 逆向里写成 `def shed` + 两个实例；三栋随意摆放的同款房子（新示例 `examples/village.s3d`）L1 写成 def + 3 实例；ABeautifulGame（见 M2）32 个棋子写成 6 个 def。

### 4.4 容差与近似规律

- 一个来源：`project.json` 的 `tolerance = {abs: 0.01, rel: 0.005}`，`τ(实体) = max(abs, rel × 实体尺寸)`。现在散落的常数（`detectArrays` 的 `tol = 0.004 + 1e-4·scale`、`detectMirrors.matches` 的 0.004、`fitAlong` 的 5e-4、`sameSize` 的 0.01+0.005v、校验的 2e-3 / 0.025、`TOL = 0.02`）全部改为由 τ 派生；决定层可以逐实体覆盖（`~tol=`）。
- 阵列步长、旋转角、曲线控制点改为对全部成员做最小二乘（现在取自第一对），记录最大偏差写进 `~err`。
- 接受准则改为 MDL：`cost(规律语句) + 残差(err) < cost(逐个写出)`，残差按 3.1 公式；校验步比较中心时用 τ 而非 2e-3。
- **数字最短化**：发射前对每个数字做“最粗精度搜索”——逐位减少小数位，只要校验（中心误差 < τ）仍通过就采用。这是通用的描述长度优化，对真实模型的浮点噪声（0.6999999）特别有效。
- 新导出档 `--level=L3`（`tools/export.mjs`）：L2 之上再加顶点抖动 σ=0.3 mm、部件位姿抖动 2 mm、随机 3% 部件重复（模拟 LOD）、随机顺序。在拿到真实模型之前，用它验证容差机制。验收：spaceport L3 的阵列召回 ≥ 90%、分数低于 L3 的“全 at=”基线。

### 4.5 规模

- **空间索引**：`tools/spatial.mjs`，均匀格网哈希（格长 = 中位实体尺寸 × 4），接口 `near(p, r)`, `inRegion(box)`，供 `slice`、阵列候选、镜像候选、校验用。
- **阵列检测**：候选运动只从每个实体在同签名组内的 k 近邻（k=8）生成（阵列由相邻成员产生），链的延伸用“量化中心 → 实体”哈希查表，整体 O(n·k)。镜像：按签名桶分组，候选平面用 `(n, d)` 量化哈希聚合，替换现在线性 `planes.find`；每桶上限 2000，超出按区域分块。
- **校验**：emit→compile→verify 最多 6 轮全量编译；改为只对本轮改动涉及的单元在其区域内局部编译（区域 = 单元包围盒 + 参照物），全量编译只在最后做一次。
- **分块**：`reverse --region` 产出 `base/tile_i_j.s3d`，`base.s3d` 只 import 它们；跨块的阵列 / 镜像在第二遍“合并块边界”里处理（只看每块边缘 1 格的实体）。
- 压力场景：`examples/stress.s3d` 由脚本把 spaceport 复制成 10×10（约 1.1 万部件）与 32×32（约 11 万）网格，带随机 yaw。验收：1e4 部件逆向 < 60 s、1e5 < 15 min（M3）；编译 1e5 节点 < 20 s。

### 4.6 纠偏持久化：决定层 `decisions.s3d`

决定用语言本身写，reverse 把它当作必须满足的约束读入，而不是另造 JSON：

```
// 这些源部件是同一个物体，叫 hangar，保留为网格
mesh hangar ~src=["merged_1#1","merged_1#7"] ~lock=shape
// 这些是一个阵列（人看出来的，检测器没认出来）
repeat lamps n=6 ~src=["part_0012","part_0030",…]
// 这三栋是同一类型
def house ~src=["part_0101","part_0102","part_0103"]
// 这个部件是噪声 / 碎片，忽略
drop ~src="merged_4#188"
// 这个物体的定位关系不要再改（人改过了）
over bunker ~lock=place
```

- 语义：`~src` 绑定源部件；`~lock=shape|place|all` 表示保持上一次 base 里该对象的形状 / 定位 / 全部；`def`/`repeat`/`mirror` 带 `~src` 表示“这些部件构成该构造”，reverse 先满足这些，再对剩余部件跑检测。满足不了（例如所标部件根本不等距）时写进报告 `unsatisfied`，并在 base 里保留为逐个写出 + `~decision=失败原因`。
- 决定层不进 scene（它不描述几何，只约束逆向），所以不计入描述长度；它的效果会体现在 base 里。
- 源模型改版时：`project.json` 记源哈希；部件引用先按名字，再按 IoU 重绑（`semanticNames` 的 previous 匹配逻辑），绑不上的决定列为 `dangling`。
- 稳定命名继续按现有机制（上一次 base 作为 previous）；`check` 命令报告修改层里失效的路径。
- 验收：对 spaceport L2 人工写 5 条决定（厂房分组、路面保留网格、楼梯视为台阶…），重跑 reverse 后 5 条全部生效且修改层路径 100% 命中；换成 spaceport_edit 的 L2 重跑，决定重绑成功率 ≥ 80%。

### 4.7 图形界面的协作功能（`index.html` / `src/app.js` / `src/render.js`）

- **本地服务** `bin/serve.mjs`（node:http，零依赖）取代 `python3 -m http.server`：静态文件 + `/api/project`、`/api/file/<name>`（GET/PUT）、`/api/run`（调用 2.2 的命令，返回 JSON）、`/api/render`（PNG）、`/api/proposals`、`/api/inbox`、`/api/selection`。GUI 和 CLI 调同一批函数。无服务（静态托管）时 GUI 退化为现在的单文件预览。
- **工程视图**：打开目录（`?project=`），文件标签 base（只读、灰色）/ edits / decisions / semantics / style；编译的是 scene.s3d（`preload` 已支持 import）。
- **选中面板**（替换现在只定位源码）：选中后显示 `inspect` 的内容——所属阵列 / 镜像 / 类型（点一下高亮全部同类：`kind(T)` 或同阵列成员）、关系列表（点一条高亮两者，复用 facts 面板逻辑）、来源部件、逐物体分数。多选 shift。`Viewer.highlight` 已支持多路径。
- **对比与误差**：视图模式切换 实体 / 源模型叠加（加载 source.glb 为半透明，复用 `addMeshRef` 的加载器）/ 误差热力（按 score.json 给材质着色）。
- **交给 AI**：输入框 + 当前选中 → `inbox.jsonl`。**提议面板**：列出 proposals/，点一条即叠加编译预览（高亮改动的对象、显示分数差与编译错误），接受 / 否决（带理由）。
- **顶栏进度条**：解释率、总分、最差 5 个对象（点击定位）。
- **多视角一致**：`Viewer.snapshot(preset)` 使用与 raster.mjs 相同的相机预设，人与 AI 讨论“iso 视角左上角那个”时指的是同一张图。

### 4.8 浏览器内逆向

- `partsOfDocument(doc)` 已不依赖 Node；把 `readParts` 的 `NodeIO` 留在 `bin/`，浏览器用 `@gltf-transform/core` 的 `WebIO`（同一包，import map 加一项）读 GLB，然后在 Web Worker 里跑 `reverse()`（纯 JS）。写回 base.s3d 走 `/api/file`；无服务时下载文件。
- `raster.mjs` 与 `score.mjs` 同样是纯 JS（three 在浏览器可用），也可在 Worker 里跑，GUI 的热力图不必依赖服务。
- 验收：在浏览器里拖入 spaceport.L1.glb → 逆向 → 结果与 CLI 逐字节一致（确定性）。

### 4.9 几何词汇补全与 L2

按收益排序：

1. **差距 11 修复（M1 之前，小改）**：`primitiveOf` 的规范化改为“局部 y 取最接近世界上方向（或支撑物上方向）的轴，x 取其余中较长者”；不竖直但 `d[1] > 0.7` 的圆柱写成 `axis=y` + `rot=`，只有接近水平的才 `axis=x`。随之调整 `sameOrientation` 的 `symY` 分支（比较整条轴而不是只比 y 分量）与 `detectArrays` 环检测取轴的方式。验收：rotation on/against 召回从 0.126 升到 ≥ 0.9，坐标依赖率 34% 降到 < 10%。
2. **L2 的 mesh 兜底**：拆出的分量写入 `parts.glb`（用 `@gltf-transform/core` 的 Document 建节点），`primitiveOf` 去掉 `part.name` 条件，mesh 引用指向 `parts.glb#merged_1_1`。验收：L2 不再出现 `~fit=0` 的基本体；L2 分数显著下降。
3. **steps**：`detectArrays` 认出的线性阵列若步长 ≈ (踏步宽, 踏步高, 0) 且成员是同尺寸盒子，发射为 `span … steps=n`（原文的 16 级楼梯在 L2 里是 16 个盒子，这是 L2 “172 对 111”的主要来源之一）。
4. **revolve**：轴对称检测（法线聚类得轴，点到轴距离按高度分箱得轮廓，Douglas–Peucker 简化到误差 < τ），发射 `revolve profile=[…]`；火箭整流罩、雷达天线不再退回 mesh。
5. **曲面锚点（3.5）**与**地形取点（3.6）**：语言侧按 PLAN.md 原设计；逆向侧 `chooseFor` 在 `on` 的参照物是 mesh 且满足高度场条件时写 `on=terrain[u,1,w]`（表面取点），罐体侧面的接管写 `against=tank.side[θ,v]`。地形判定：mesh 的 xz 投影面积 ≫ 厚度且竖直射线单值。
6. **sweep / pipe**：管状检测（截面恒定、骨架曲线）放到最后，先依赖 mesh 兜底 + 分数识别“最值得修的部件”。
7. **L2 过碎**：拆分后把“共面贴合且材质相同”的分量先尝试合并拟合（合并后误差更小则合并），其余交给决定层由人分组。

### 4.10 事实提供者注册表（3.8）

把 `deriveFacts` 里固定的 on/against/inside/touching/intersects 改为 provider 列表（`{name, derive(objs, S) → facts}`），现有五种是第一个 provider；`walkable / reach / sees` 作为示例 provider 放在 M6，机制通用、不特化。GUI 事实面板与 `facts` 命令按 provider 分组。

---

## 5. 里程碑

每个里程碑末尾更新 README 指标表与 docs/PLAN2.md 进展记录；测试全部通过是隐含条件。

| 阶段 | 内容 | 验收标准（可度量） |
|---|---|---|
| **M0 最小闭环**（最先） | 工程布局 + `scene.s3d`；`score.mjs`；`raster.mjs`；`s3d-tool` 的 outline/inspect/select/similar/render/score/propose/preview/accept/reject/inbox；GUI 只加 `?project=` 与 `state/selection.json` 写出；`docs/agent.md`（agent 操作手册）；**实验 E1**（第 6 节） | 分数校准五序严格成立；raster 6 视角 spaceport < 2 s；E1 跑满 ≥ 10 轮并有日志；至少 3 条被接受的 AI 提议使分数下降且 eval 指标不降 |
| **M1 诚实与类型** | 差距 11 修复；L2 mesh 兜底 + parts.glb；享元线索读入；几何同形 def；阵列 / 镜像对实体进行；`~src` 列表与 base.map.json；决定层 4.6；`fit / detect-* / reverse` 命令 | rotation on/against 召回 ≥ 0.9；L2 无 `~fit=0` 基本体、对象数 172 → ≤ 130、分数下降 ≥ 30%；village 示例 L1 写成 def + 3 实例；决定层验收（4.6）通过；spaceport L0/L1 现有指标不退 |
| **M2 真实模型** | 容差 4.4 + L3 档；接入外部模型（需用户逐个批准下载）：Khronos glTF-Sample-Assets 的 ABeautifulGame（棋盘：享元、镜像、类型）、Kenney 某套 CC0 模块化套件拼的场景（模块化资产、重复）、用户自己提供的目标地图（法律由用户负责） | L3 阵列召回 ≥ 90%；ABeautifulGame：解释率 ≥ 60%，32 枚棋子 ≤ 8 个 def，镜像面识别出棋盘中线；Kenney 场景：解释率 ≥ 50%，逆向 + 评分 < 60 s；每个真实模型附 `renders/` 对比图与 worst 清单 |
| **M3 规模** | 空间索引、k 近邻候选、局部校验、分块、stress 示例 | 1e4 部件 < 60 s，1e5 < 15 min；分块与不分块在 spaceport 上结果一致 |
| **M4 协作界面** | `bin/serve.mjs`；工程视图、选中面板、提议面板、交给 AI、热力图、源模型叠加；浏览器内逆向（Worker + WebIO）；**实验 E2**（人在环） | 不打开终端完成一次“导入 GLB → 逆向 → 选中纠偏 → AI 提议 → 接受 → 分数下降”的全流程；浏览器逆向结果与 CLI 逐字节一致；E2 中人均每次纠偏耗时与分数下降记录在案 |
| **M5 几何词汇** | steps、revolve、曲面锚点、地形取点、`def B : A` 与参数化、L2 合并、sweep（尽力） | spaceport L2 对象数 ≤ 115、形状正确率 ≥ 98%；rotation 的 dish / nose 写成 revolve；`spaceport_blueprint` 风格在逆向结果上可用（事实集合不变） |
| **M6 事实提供者** | 3.8 注册表 + walkable / reach / sees 示例 provider | 现有 66 测试不变；provider 可独立关闭 |

优先级调整说明：主会话把“真实模型验证”列为第 1 项，本计划放在 M2，因为没有分数与工具，拿到真实模型也只能肉眼看；M0 的闭环与分数是评估真实模型的前提，M1 的 mesh 兜底与类型抽取是真实模型上最先暴露的短板。差距 11 是规范化缺陷，修复便宜且影响 rotation 全部指标，提前到 M1 开头。规模放在类型之后，因为类型抽取改变了检测的实体模型，索引要建在实体上。

---

## 6. AI 在环实验

**E1（M0，自主）**：工程由 `out/spaceport.L2.glb` 初始化；agent 为 Claude Code 主会话（或子代理），只允许使用 `s3d-tool` 命令与读取 renders/ 下的图片，不允许直接编辑文件；操作手册 `docs/agent.md` 规定循环：`score` → 读 `worst` → `inspect/render --focus` → 决定动作（换形状 / 合并为类型 / 写阵列 / 保留 mesh / 修定位）→ `propose` → `preview` → 分数下降则 `accept`，否则 `reject --why`。上限 20 轮或连续 5 轮无改进。日志 `experiments/E1/log.jsonl` 记每轮工具调用、提议、ΔS、以及对真值的 eval 指标（有真值）。产出：分数曲线、S 与 eval 的相关性、agent 最常失败的动作类型（用来排 M1 的顺序）。M1 后对 L2 重跑 E1，报告差异。

**E2（M4，人在环）**：同一工程，人在 GUI 里选中并批注，AI 读 inbox 提议，人接受 / 否决；记录每条批注到分数变化的耗时。对照组：同样时间内人只用编辑器手改。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 分数常数不当，AI 学会钻空子 | 3.2 的作弊表作为 score 的单元测试；E1 有真值，发现 S 下降而 eval 下降即调常数并记录 |
| 真实模型的几何不是基本体能表达的（异形件、地形、合并网格） | mesh 兜底 + 决定层 + 分数指出最值得修的部件；目标是“压缩能压缩的，诚实保留其余”，而非 100% 拟合 |
| 享元线索缺失（烘焙过的地图） | 几何同形组兜底；L1/L2 已无名字，现有指标就是这种情况的下限 |
| O(n²) 在真实地图上不可用 | M3 的索引；在 M2 之前先用 stress 示例测量，防止真实模型卡死 |
| 决定层与自动检测冲突（人说是阵列，几何不等距） | 决定优先 + 容差放宽到决定给出的 `~tol`；满足不了写 `unsatisfied` 报告，不悄悄忽略 |
| 工程多文件后路径失效 | 稳定命名 + `check` 报失效路径 + 决定层 `~lock` |
| GUI 与 CLI 行为分叉 | 同一函数表生成 CLI、MCP、HTTP 三个入口；E2 用 GUI 跑的每一步在日志里都有等价 CLI 命令 |
| 外部模型下载与版权 | 只用 CC0 / CC-BY 的样例，每次下载请用户批准；用户自己的地图不入库、不提交 |
| 软件光栅化画质一般 | 多模态模型要的是形状与标注而非真实感；需要时 GUI 用 WebGL 截同视角对照图 |

---

## 8. 需要拍板的决定（附推荐）

| # | 问题 | 推荐 |
|---|---|---|
| 1 | 层的组合方式：`scene.s3d` 根文件按序 import 各层，还是各层链式 import | 根文件（各层互不依赖，工具只编译根） |
| 2 | 决定层用 SVG3D 语句 + `~src/~lock`，还是单独 JSON | SVG3D 语句（人与 AI 共用一种语言；不进 scene） |
| 3 | 工具入口：CLI 先行，MCP 为手写 stdio JSON-RPC 薄壳；还是引入 MCP SDK | CLI 先行，M0 末尾加手写 MCP（零依赖） |
| 4 | GUI 后端：`bin/serve.mjs`（node:http）还是纯静态 + File System Access API | serve.mjs；静态模式保留为只读预览 |
| 5 | 离屏渲染：纯 JS 光栅化 vs Puppeteer | 纯 JS 光栅化 |
| 6 | 分数常数与 δ 的默认值（δ=5 mm, c_res=4, c_mesh=10, D_max=2 m） | 按 3.3 校准后定，写入 project.json |
| 7 | E1 的接受策略：贪心（只接受分数下降）还是允许暂时上升 | 贪心；允许 agent 在一条提议里打包多步 |
| 8 | 真实模型候选：ABeautifulGame、Kenney 套件场景、用户地图 | 三者都做，顺序如列；每次下载单独批准 |
| 9 | base.s3d 是否在源或决定改变时自动重生成 | 不自动；显式 `reverse`，避免人正在看的东西变动 |
| 10 | 容差默认 `abs=1 cm, rel=0.5%` | 接受，L3 实验后微调 |

---

## 9. 明确不做的事

- 通用约束求解器、物理、碰撞避让：仍是“每个物体一条主关系 + 相对锚点”；真实模型里相交 / 嵌入的物体用 `at=B[u,v,w]` 表达，已够用。
- 纹理、UV、法线贴图、动画、骨骼的还原：语言只管外包络与关系；材质只到基础色 / 金属 / 粗糙。
- 基于学习的 L2 分割或 Python 工具链：先靠 mesh 兜底、分数指引与人的决定层；PLAN.md 里“允许 Python 预处理器”的决定推迟到 M5 之后再议。
- 多用户实时协作、账号、云端：工程是本地目录，协作是人与 AI。
- 把提议做成通用 diff/merge 系统：提议只追加语句或撤销语句，依靠“后写覆盖先写”；折叠冗余 `over` 的 `compact` 工具不做。
- 为某类资产（房屋、树、车）写专用识别器：一切通过几何 + 语义库概念 + 人定义的 concept。
- 为了 AI 阅读而改语言语法（例如 JSON 化）：AI 读 outline / inspect 的 JSON，写的仍是 SVG3D。

---

## 审阅意见（主会话）

已核实计划开头列出的新事实：`primitiveOf` 把倾斜盒子规范成“局部 y = 最长边”（rotation 逆向结果里光伏板确实写成 `size=2.8,5,0.1`），以及拟合失败时的 mesh 兜底要求部件有名字（reverse.mjs 第 289 行 `fit.e > TOL && part.name`）。两条都属实。

总体同意。调整与补充：

1. **差距 11 的修复提到 M0 之前单独做。** 它是一个小的规范化缺陷，却影响 rotation 的全部关系指标；分数校准（3.3）里“rotation 修复前后分数应下降”也依赖它先有一个干净的基线。
2. **M0 分成两半。** M0a：工程布局、`score`、`raster`、`inspect/outline/select/similar/render`，先把“看”和“评”跑通、校准分数；M0b：提议机制（propose/preview/accept/reject/inbox）、`docs/agent.md`、E1。分数常数没校准之前跑 E1，实验结论不可信。
3. **E1 的 agent 用多模态读图**：Claude Code 的 Read 工具能直接读 PNG，所以 E1 可以由本会话派出的子 agent 执行，不需要额外接入。
4. **残差计算的成本**要在 M0a 测量：600 点 × 部件数 × BVH 查询，spaceport 应在秒级；若真实模型过慢，残差改为按 `worst` 与改动对象增量计算。
5. **决定层里 `def house ~src=[…]` 这种不带体的写法不是合法语句**（def 需要体）。实现时要么允许决定层的特殊形式（只在 reverse 读取，不进 scene，不经编译器），要么改成 `~decide=type ~src=[…]` 一类的元数据写法。M1 开工前定下来，作为第 11 个待决事项。
6. 第 8 节的 10 个决定，推荐选项我都同意；需要用户确认的是 #8（下载外部模型，每次单独批准）和 #5（离屏渲染方案）。
