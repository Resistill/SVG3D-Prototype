# SVG3D 工具手册（给 AI agent，也给人）

目标：把一个源模型（GLB）压缩成高度可编辑的 SVG3D 工程——把重复的东西写成阵列、镜像、类型，把位置写成关系，把解释不了的部分诚实地保留为网格引用。**分数越低越好**。

所有命令：`node bin/s3d-tool.mjs <命令> [参数] --project=<工程目录>`，输出一律是 JSON。`node bin/s3d-tool.mjs help` 列出全部命令与参数。

## 工程

```
init <源模型.glb> [--fidelity=semantic|structure|detail] [--unit=米] --project=dir   新建工程：按档位跑一次逆向，生成 scene.s3d 与各层
reverse [--fidelity=…] [--unit=…] [--fresh]                               重跑逆向（可以换档位、改场景单位）
```

**档位**：逆向不要求 100% 复原，保留语义就够，剩下的由人细化。档位 = 容差，一个参数同时决定逆向的拟合门槛、数字位数、角度取整、阵列与校验的容差，以及分数的 δ：

| 档位 | 容差 | 复杂形状 | 用途 |
|---|---|---|---|
| `semantic` | 25 cm | 一律用最接近的基本体当语义代理（灰盒） | 只要语义；最适合风格化 |
| `structure`（默认） | 5 cm | 明显不是基本体时才保留网格 | 结构清楚，细节交给人 |
| `detail` | 5 mm | 误差稍大就保留网格引用 | 尽量复原 |

**场景单位**：表里的容差、分数的 δ 与 `dMax`、`score` 输出的误差都按米。源模型不是按米建的（厘米 0.01、stud 0.28），工程的 `unit` 记每个场景单位多少米，计算前换算。`init` 不给 `--unit` 时按部件尺寸猜，结果里的 `unitNote` 要人确认；猜错了用 `reverse --unit=… --fresh` 改。

| 文件 | 内容 | 谁改 |
|---|---|---|
| `base.s3d` | 逆向结果（机器层）；超过 `splitLines`（默认 400）行时只是索引，内容拆在 `base/types.s3d`（材质与类型）和 `base/NN-名字.s3d`（按水平位置分区的物体）里 | 只由 `reverse` 重写；**不要手改** |
| `edits.s3d` | 修改层：`over` / `drop` / `copy` / 新物体 / `def` 扩展 | 人；AI 经提议 |
| `semantics.s3d` | 语义层：`concept` / `pattern` / `check`（已 import 通用语义库） | 人；AI 经提议 |
| `style.s3d` | 风格层：只改外观 | 人；AI 经提议 |
| `decisions.s3d` | 决定层：对逆向的约束（M1 实现） | 人；AI 经提议 |
| `scene.s3d` | 组合根（按序 import 各层），工具只编译它 | 不改 |
| `state/selection.json` | 人在界面里选中的物体 `{paths, camera}` | 界面写，AI 读 |
| `score.json` | 最近一次评分 | `score` 写 |
| `renders/` | 渲染图 | `render` 写 |

重跑逆向（`reverse`）时，上一次的 `base.s3d` 是名字记忆：几何上对得上的物体沿用原来的名字，所以 `edits.s3d` 里的路径不会失效。

## 看

```
render [--view=iso|iso2|top|front|back|left|right] [--mode=labels|color|id|error] [--focus=<路径>|selection] [--size=1024] [--source] [--box=…] [--ortho]
```

- `labels`（默认）：在每个物体的可见部分标编号，返回的 `legend` 给出编号 → 路径。用来把图上的东西和代码对应起来。
- `--focus`：只标注被聚焦的物体，并且把它画在最上层（不会被挡住），其余物体变淡作为参照。
- `--source`：渲染**源模型**而不是重建结果。同一视角、同一 `--focus` 各渲一张，对照着看最能发现问题（例如源模型里是弯管，重建成了直梁）。源部件的名字来自 `score` 的 `worstSources`。
- `--mode=error`：按 `score.json` 的平均误差从绿到红上色（先跑 `score`）；加 `--source` 时给源部件上色。
- **源与重建逐像素对比**：渲染的返回值里有 `box`（本次取景范围），把它原样传给另一次渲染的 `--box=`，两张图取景完全一致；`--ortho` 用正交相机，尺寸不随深度变化，便于量。
- 相机预设与界面预览一致：人说“iso 视角左上角那个”，和你看到的是同一张图。
- labels 会避开重叠：放不下的标签不画，图例里标 `labeled: false`。

## 查

```
outline [--depth=2] [--path=前缀]   分层概要：阵列、副本折叠成一行；类型、尺寸、实体数、主要关系、概念
inspect <路径…> | --selection         源语句与行号、属性、包围盒、空间事实、所属阵列/镜像/类型与同类数、副本来源、概念、元数据、逐物体分数
inspect --source <源部件…>           源模型的部件：包络、三角形数、表面积、主轴方向与沿主轴的尺寸、材质、分数，以及把它单独逆向得到的建议语句（量尺寸用这个，不要数像素）
check [--text=…] [--layer=edits]      空跑：把语句临时叠加编译，报告新错误；语句没有任何效果时警告（不生成提议、不消耗预算）
select "<集合表达式>"                 例如 "kind(cyl) where h > 5 and top > 30"、"on(ground) - #road"
similar <路径> [--tol=0.01]           全场景里同形同尺寸同材质的物体及其相对位置——类型（def）与阵列的候选
```

## 评

```
score [--objects]
```

`S = L_stmt + L_mesh + R_src + R_recon`：

- `L_stmt` 描述长度：名字、关键字、引用各 1；数字 `1 + 0.5 × (小数位 − 1)`（`26`→1、`38.2711`→2.5）；注释与 `~元数据` 不计；语义层、风格层不计。**只计有效描述**：基础层里声明的物体被你 drop 了，那一行不计——替换一个物体不会付两份钱。
- `L_mesh` 网格引用：`10 × log2(1 + 三角形数)`——一个 500 三角形的网格约 90，一个合格的 box 约 8。
- `R_src` 源模型的每个部件表面采样到重建表面的距离 `d`，代价 `log2(1 + max(0, d − δ)/δ)`，按部件复杂度加权：解释错了、漏掉了都很贵。δ 由档位决定（structure 5 cm）；**误差在 δ 以内不计代价**，不用去猜作者的精确数值。距离优先量到**同材质**的重建表面（沥青路面只能由沥青的物体解释，不能拿地面凑数）；没有同材质的表面时多计一个 δ。
- `R_recon` 重建物体表面到源表面的距离：凭空多出来的东西很贵。
- 换形状不用改名：`over 物体 : 种类 新参数…`（例如 `over hall : subtract { box outer … ; box door … }`、`over road : pipe path=[…] r=…`），名字与引用都不变。改阵列的模板：`over 阵列 { drop 部件 ; 新语句 }` 作用到每个实例。
- `explain = 1 − S / S_mesh`：相对“全部写成网格引用”的基线解释了多少，是进度条。
- `worst`：代价最高的重建物体；`worstSources`：解释得最差的源部件（`explainedBy` 是它被归到的重建物体）。
- 同一个进程里（MCP 服务、`refine --auto`、`preview` / `accept`）的评分是增量的：第一次全量，之后只重算改动影响到的部分，分数与全量一致。命令行每次是新进程，每次都是全量。`S3D_TIMING=1` 把各阶段耗时和重算了多少打到 stderr。

几条从分数本身推出来的经验：

- **压缩来自规律**：阵列、镜像、类型（一个 `def` 加若干实例）让描述变短。关系（`on=` / `against=`）在长度上和坐标差不多（多一个参照物名字），它的价值是可编辑——参照物动了它跟着动。
- **短数字**：能写 `6.1` 就不要写 `6.0996`；精度只需达到几何误差的要求。
- **误差大于约 2 厘米的拟合不如诚实地保留网格**：网格引用的代价相当于平均误差约 2.3 cm 的拟合。

## 做：提议

AI 的修改不直接写进层文件，而是提议，人（或按约定的 agent）预览后接受或否决：

```
propose --text="over shed color=#aa3333" --why="一句话理由" [--layer=edits|semantics|style|decisions] [--title=…] [--retract=12,13]
proposals                 列出待处理的提议
preview <编号> [--render] 叠加编译：新出现的编译错误、分数变化 delta、逐物体的分数变化 changed（只列 ≥ 0.5 的）、新增 / 删除的物体；--render 渲染应用提议之后的场景（不改文件）
accept <编号>             追加进目标层（有编译错误时拒绝，除非 --force）
reject <编号> --why=…     否决；理由进收件箱
note --text=…             人给 AI 留言（附当前选中的物体）
inbox                     读留言与否决理由
```

提议文件在 `proposals/NNN-标题.s3d`：首行 `// layer=edits why=…`，`// retract <行号>` 撤销目标层的某一行，其余是追加的语句。每次工具调用都记在 `state/log.jsonl`。

## 做：细化

```
refine <路径…> | --worst=N [--to=structure|detail] [--apply]
refine --auto [--to=…] [--budget=10] [--target=解释率]
```

把物体对应的源网格按更细的档位（默认比工程档位细一档）重新描述，名字与引用不变：类型实例 → `def T : T { drop body; group body envelope=… { … } }`（所有实例一起变）；普通物体 → `over x : group envelope=… { … }`。名义外包络 `envelope` 保证挂在它上面的物体不动。

- **候选**：全部分量（在物体坐标系里再逆向一次：逐块拟合、关系、阵列、镜像）/ 按面积只留前 99% · 97% · 90% 的分量 / 上面每种再把“面积大、拟合差”的分量换成体素盒子 / 整体体素（三种粒度）。
- **局部分数**（邻域评分）：全场分数在这个物体附近的变化——描述长度 + 它自己和离它不超过 `dMax` 的源部件到“候选几何 + 附近其他重建物体”的残差 + 候选几何到源的残差，同材质规则、采样方式与全场评分相同，δ 取目标档位；类型的残差按实例数计。普通物体的局部分数变化与全场分数的变化基本相同。返回值里的 `candidates` 列出每个候选的分数，`local.current` 是现在写法的局部分数，`chosen` 是被选中的候选。粗档位下窗框、饰条这类小构件“写出来的代价 > 省掉的误差”，自然被舍弃。
- 细化出来的子块带 `~src="部件#分量"`（分量按世界坐标拆，编号稳定），可以对子块再 `refine`；类型内部的子块暂不支持再细化。
- `--auto`：从残差最大的物体开始；局部分数没变好的直接跳过（日志里 `skipped: 局部分数没有变好`），其余按目标档位全场评分，变好才写进 `edits.s3d`。

## MCP

```
claude mcp add svg3d -- node --import ./bin/node-hooks.mjs bin/s3d-mcp.mjs --project=<工程目录>
```

工具名是 `s3d_<命令>`，参数与命令行相同；`s3d_render` 除了 JSON 还直接返回 PNG 图像。

## 一轮工作的建议顺序

1. `score` → 看 `worst` 与 `worstSources`。
2. 对最贵的那个：`inspect <路径>`，`render --focus=<路径>` 和 `render --source --focus=<源部件>` 对照着看。
3. 决定动作：换形状、写成阵列 / 镜像 / 类型、改定位、保留为网格、删掉碎片。
4. `propose` 提交修改，看 `delta`：分数下降、没有新错误才 `accept`，否则 `reject --why=…` 并换个做法。
5. 人在界面里选中了东西、留了话：`inspect --selection`、`render --focus=selection`。
