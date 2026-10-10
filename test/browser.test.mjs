// 浏览器侧模块里能在 Node 下验证的部分：GLB 字节逆向（WebIO）与命令行（NodeIO 读文件）逐字节一致；Worker 加载时的自引用改写
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sceneToGLB } from '../tools/export.mjs';
import { readParts, reverse } from '../tools/reverse.mjs';
import { reverseGlb } from '../src/reverse-glb.js';
import { patchSelfImports } from '../src/shim-worker.js';

test('reverseGlb（浏览器 Worker 用的入口）与 bin/reverse.mjs 的读法结果逐字节相同', async () => {
  const src = readFileSync(new URL('../examples/spaceport.s3d', import.meta.url), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 's3d-'));
  try {
    for (const level of ['L1', 'L2']) {
      const { doc, io } = sceneToGLB(src, { level });
      const bytes = await io.writeBinary(doc);
      const file = join(dir, `spaceport.${level}.glb`);
      writeFileSync(file, bytes);
      for (const fidelity of ['detail', 'semantic']) {
        // 与 bin/reverse.mjs 相同：readParts（NodeIO 读文件）、level 取自文件名、srcFile 相对输出文件
        const cli = reverse(await readParts(file), { srcFile: `spaceport.${level}.glb`, level, previous: null, fidelity, unit: 1 });
        const web = await reverseGlb(bytes, { name: `spaceport.${level}.glb`, fidelity });
        assert.equal(web.src, cli.src, `${level} ${fidelity}`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('patchSelfImports：去掉“从自己导入”的语句，别名换回本地名字', () => {
  const code = `import { Box3 } from 'three';\nimport { BVH as BVH$1, INTERSECTED as INTERSECTED$1, Other } from 'three-mesh-bvh';\nclass BVH {}\nconst INTERSECTED = 1;\nclass ObjectBVH extends BVH$1 { f() { return INTERSECTED$1 + xBVH$1; } }\n`;
  const out = patchSelfImports(code, 'three-mesh-bvh');
  assert.ok(!/three-mesh-bvh/.test(out));
  assert.ok(/import \{ Box3 \} from 'three'/.test(out), '别的导入不动');
  assert.ok(/class ObjectBVH extends BVH \{ f\(\) \{ return INTERSECTED \+ xBVH\$1; \} \}/.test(out), '只换完整的标识符');
  assert.equal(patchSelfImports(code, 'three'), code.replace(`import { Box3 } from 'three';`, ''));
});
