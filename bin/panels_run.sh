#!/bin/sh
# 用法（在仓库根目录）: sh bin/panels_run.sh <标签>；在 work/panels/<标签>/ 下用结构档新建三个工程并评分
set -e
T=work/panels/$1
rm -rf $T; mkdir -p $T
SC=../SpaceCenter_Rebuild/blockout/layout.csv
run() { name=$1; shift; s=$(date +%s); node bin/s3d-tool.mjs init "$@" --fidelity=structure --project=$T/$name > $T/$name.init.json; e=$(date +%s); node bin/s3d-tool.mjs score --project=$T/$name > $T/$name.score.json; echo "$name init $((e-s))s"; }
run sp out/spaceport.L2.glb --unit=1
run dorm work/dorm/dorm.glb --unit=0.28 --sidecar=$SC
run h1 work/h1/h1.glb --unit=0.28 --sidecar=$SC
