# 给 Claude 的工作约定

- 用中文回复。仓库里的文档、代码注释用中文；提交信息用英文。
- 每完成一项就提交一次（用户一直同意这样做）。
- 进度与待办：`docs/PLAN2.md` 末尾（“2026-10-10 无人值守一轮的结果（收尾）”、“第二轮待办” D1–D7）。工具手册：`docs/agent.md`。
- 测试：`npm test`。改动性能相关代码时，按 `docs/PLAN2.md`「性能」一节的清单与改动前的输出逐字节对比。

## 数据与目录

- `work/`、`out/`、`experiments/*/scratch/` 被 git 忽略，换机器要单独拷。`out/` 可以重新生成（如 `node bin/export.mjs examples/spaceport.s3d out/spaceport.L2.glb --level=L2`）；`work/` 不能。
- 实战工程：`work/dorm/final`、`work/h1/final`（stud 单位 0.28，语义档逆向 + `refine --auto --to=structure --budget=10`）。源模型 `work/<区域>/<区域>.glb` 由 `bin/crop.mjs` 从同级目录 `../SpaceCenter_Rebuild` 裁出；旁路表 `--sidecar=../SpaceCenter_Rebuild/blockout/layout.csv`（工程里存的是相对路径，两个目录必须同级）。
- 比较逆向改动：`sh bin/panels_run.sh <标签>` 在 `work/panels/<标签>/` 下用结构档新建 spaceport L2 / 宿舍区 / H1 三个工程并评分，比较各自 `score.json` 的 S。

## 坑

- Windows 上 worktree 里的子 agent 会写出 CRLF；仓库有 `.gitattributes`（eol=lf），合并后检查一下。
- Git Bash 里 `node -` 加 heredoc 会吃掉反斜杠——编辑脚本写成文件再跑。
