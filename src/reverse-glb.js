// GLB 字节 → .s3d：与 bin/reverse.mjs 相同的读法与默认值（档位 detail、拆分 auto、level 取文件名里的 .L1. 一类），
// 浏览器的逆向 Worker（src/reverse-worker.js）与测试共用。NodeIO 读文件、WebIO 读字节，得到的是同一个 Document，结果逐字节相同
import { WebIO } from '@gltf-transform/core';
import { partsOfDocument, reverse } from '../tools/reverse.mjs';

export async function reverseGlb(bytes, { name = 'source.glb', srcFile = name, fidelity = 'detail', unit = 1, split = 'auto', previous = null } = {}) {
  const doc = await new WebIO().readBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const level = (/\.(L\d)\./.exec(name) ?? [])[1] ?? '?';
  const parts = partsOfDocument(doc, { split });
  return { ...reverse(parts, { srcFile, level, previous, fidelity, unit }), parts: parts.length };
}
