// 源模型一侧的磁盘缓存（工程的 state/cache/）：读入的源部件、源表面的最近距离树、源部件的采样点。
// 它们只取决于源文件（与旁路表）和少数几个很少改动的模块；每个进程（每次命令行调用）不必重算。
// 键 = 源文件内容的哈希 + 拆分方式与旁路表 + 产生这份数据的模块文件的内容哈希 + 参数：
// 任何一项变了就当作没有缓存、重算并覆盖——改了代码不会读到旧结果。缓存只是加速，读不到、写不了都照常算。
//
// 文件格式：'S3DC' + 版本(u32) + 头长度(u32) + 头（JSON：{ key, meta, blobs:[{name, type, offset, length}] }）+ 8 字节对齐的二进制块
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = 0x43443353, VERSION = 1; // 'S3DC'
const TYPES = { Float64Array, Float32Array, Int32Array, Uint32Array, Uint8Array };

export const sha1 = (data) => createHash('sha1').update(data).digest('hex');

// 模块文件的内容哈希（相对 tools/ 的文件名；另加 package-lock.json：依赖的版本）
const codeHashes = new Map();
export function codeHash(files) {
  const id = files.join('|');
  if (!codeHashes.has(id)) {
    const h = createHash('sha1');
    for (const f of [...files, '../package-lock.json']) { h.update(f); try { h.update(readFileSync(fileURLToPath(new URL(f, import.meta.url)))); } catch { h.update('missing'); } }
    codeHashes.set(id, h.digest('hex'));
  }
  return codeHashes.get(id);
}

// blobs：{ 名字: 类型化数组 }
export function writeCache(path, key, meta, blobs) {
  try {
    const list = [];
    let off = 0;
    for (const [name, a] of Object.entries(blobs)) {
      const type = Object.keys(TYPES).find((t) => a instanceof TYPES[t]);
      if (!type) throw new Error(`srccache: 不支持的类型 ${name}`);
      list.push({ name, type, offset: off, length: a.length });
      off += Math.ceil(a.byteLength / 8) * 8;
    }
    const head = Buffer.from(JSON.stringify({ key, meta, blobs: list }), 'utf8');
    const start = Math.ceil((12 + head.length) / 8) * 8, out = Buffer.alloc(start + off);
    out.writeUInt32LE(MAGIC, 0); out.writeUInt32LE(VERSION, 4); out.writeUInt32LE(head.length, 8); head.copy(out, 12);
    list.forEach((b, j) => { const a = Object.values(blobs)[j]; Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(out, start + b.offset); });
    mkdirSync(dirname(path), { recursive: true });
    // 缓存不进版本库（工程目录可能在 git 里）
    if (!existsSync(join(dirname(path), '.gitignore'))) writeFileSync(join(dirname(path), '.gitignore'), '*\n');
    // 先写临时文件再改名：另一个进程同时读到的要么是旧文件、要么是完整的新文件
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, out);
    try { renameSync(tmp, path); } catch { rmSync(tmp, { force: true }); }
  } catch { /* 写不了就算了 */ }
}

// 键对得上时返回 { meta, blobs }；alloc(类型, 长度) 决定块放在哪里（并行查询要共享内存），默认普通数组
export function readCache(path, key, alloc = (T, n) => new T(n)) {
  let buf;
  try { buf = readFileSync(path); } catch { return null; }
  try {
    if (buf.readUInt32LE(0) !== MAGIC || buf.readUInt32LE(4) !== VERSION) return null;
    const hl = buf.readUInt32LE(8), head = JSON.parse(buf.toString('utf8', 12, 12 + hl));
    if (head.key !== key) return null;
    const start = Math.ceil((12 + hl) / 8) * 8, blobs = {};
    for (const b of head.blobs) {
      const T = TYPES[b.type], a = alloc(T, b.length);
      new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(buf.subarray(start + b.offset, start + b.offset + b.length * T.BYTES_PER_ELEMENT));
      blobs[b.name] = a;
    }
    return { meta: head.meta, blobs };
  } catch { return null; }
}
