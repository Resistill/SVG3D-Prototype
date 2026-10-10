# SVG3D 工具手册（给 AI agent，也给人）

目标：把一个源模型（GLB）压缩成高度可编辑的 SVG3D 工程——把重复的东西写成阵列、镜像、类型，把位置写成关系，把解释不了的部分诚实地保留为网格引用。**分数越低越好**。

所有命令：`node bin/s3d-tool.mjs <命令> [参数] --project=<工程目录>`，输出一律是 JSON。`node bin/s3d-tool.mjs help` 列出全部命令与参数。

## 工程

```
init <源模型.glb> --project=dir   新建工程：跑一次逆向，生成 scene.s3d 与各层
```

| 文件 | 内容 | 谁改 |
|---|---|---|
| `base.s3d` | 逆向结果（机器层） | 只由 `reverse` 重写；**不要手改** |
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
render [--view=iso|iso2|top|front|back|left|right] [--mode=labels|color|id] [--focus=<路径>|selection] [--size=1024] [--source]
```

- `labels`（默认）：在每个物体的可见部分标编号，返回的 `legend` 给出编号 → 路径。用来把图上的东西和代码对应起来。
- `--focus`：只标注被聚焦的物体，并且把它画在最上层（不会被挡住），其余物体变淡作为参照。
- `--source`：渲染**源模型**而不是重建结果。同一视角、同一 `--focus` 各渲一张，对照着看最能发现问题（例如源模型里是弯管，重建成了直梁）。源部件的名字来自 `score` 的 `worstSources`。
- 相机预设与界面预览一致：人说“iso 视角左上角那个”，和你看到的是同一张图。

## 查

```
outline [--depth=2] [--path=前缀]   分层概要：阵列、副本折叠成一行；类型、尺寸、实体数、主要关系、概念
inspect <路径…> | --selection         源语句与行号、属性、包围盒、空间事实、所属阵列/镜像/类型与同类数、副本来源、概念、元数据、逐物体分数
select "<集合表达式>"                 例如 "kind(cyl) where h > 5 and top > 30"、"on(ground) - #road"
similar <路径> [--tol=0.01]           全场景里同形同尺寸同材质的物体及其相对位置——类型（def）与阵列的候选
```

## 评

```
score [--objects]
```

`S = L_stmt + L_mesh + R_src + R_recon`：

- `L_stmt` 描述长度：名字、关键字、引用各 1；数字 `1 + 0.5 × (小数位 − 1)`（`26`→1、`38.2711`→2.5）；注释与 `~元数据` 不计；语义层、风格层不计。
- `L_mesh` 网格引用：`10 × log2(1 + 三角形数)`——一个 500 三角形的网格约 90，一个合格的 box 约 8。
- `R_src` 源模型的每个部件表面采样到重建表面的距离 `d`，代价 `log2(1 + d/5mm)`，按部件复杂度加权：解释错了、漏掉了都很贵。
- `R_recon` 重建物体表面到源表面的距离：凭空多出来的东西很贵。
- `explain = 1 − S / S_mesh`：相对“全部写成网格引用”的基线解释了多少，是进度条。
- `worst`：代价最高的重建物体；`worstSources`：解释得最差的源部件（`explainedBy` 是它被归到的重建物体）。

几条从分数本身推出来的经验：

- **压缩来自规律**：阵列、镜像、类型（一个 `def` 加若干实例）让描述变短。关系（`on=` / `against=`）在长度上和坐标差不多（多一个参照物名字），它的价值是可编辑——参照物动了它跟着动。
- **短数字**：能写 `6.1` 就不要写 `6.0996`；精度只需达到几何误差的要求。
- **误差大于约 2 厘米的拟合不如诚实地保留网格**：网格引用的代价相当于平均误差约 2.3 cm 的拟合。

## 做：提议

AI 的修改不直接写进层文件，而是提议，人（或按约定的 agent）预览后接受或否决：

```
propose --text="over shed color=#aa3333" --why="一句话理由" [--layer=edits|semantics|style|decisions] [--title=…] [--retract=12,13]
proposals                 列出待处理的提议
preview <编号>            叠加编译：新出现的编译错误、分数变化 delta、受影响的物体（不改文件）
accept <编号>             追加进目标层（有编译错误时拒绝，除非 --force）
reject <编号> --why=…     否决；理由进收件箱
note --text=…             人给 AI 留言（附当前选中的物体）
inbox                     读留言与否决理由
```

提议文件在 `proposals/NNN-标题.s3d`：首行 `// layer=edits why=…`，`// retract <行号>` 撤销目标层的某一行，其余是追加的语句。每次工具调用都记在 `state/log.jsonl`。

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
