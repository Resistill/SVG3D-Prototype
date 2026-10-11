// 点到三角形集合的最近距离（评分的残差查询，docs/PLAN2.md 3.1）。
// 树仍由 three-mesh-bvh 建（MeshBVH，见 score.mjs 的 bvhOf），这里只把查询换成专用的循环：不经过回调、Box3、Triangle 对象，
// 三角形顶点按树的叶子顺序预先排成连续的 Float64Array。遍历顺序、剪枝条件、点到三角形的算法与
// MeshBVH.closestPointToPoint 逐步相同（Ericson 的 Voronoi 区域法，与 three 的 Triangle.closestPointToPoint 同样的运算顺序），
// 所以距离逐位相同，距离相等时取到的也是同一个三角形。
// 大批量的查询（closestMany）分给 worker 线程：score() 是同步的，主线程也领一份活干，干完用 Atomics 等其余的；
// 每个点的结果与单线程完全一样，写回各自的位置。浏览器里（没有 worker_threads）一律在当前线程算。
// 这个文件不 import 任何东西：worker 只加载它（nearworker.mjs），不必加载 three

const UINT32_PER_NODE = 8, IS_LEAF = 0xffff;

// Node 里才有 worker 线程与 SharedArrayBuffer（浏览器里没有跨源隔离时也没有 SharedArrayBuffer）
const WT = globalThis.process?.getBuiltinModule?.('node:worker_threads') ?? null;
const SHARE = !!WT && typeof SharedArrayBuffer === 'function';
const alloc = (Type, n) => new Type(SHARE ? new SharedArrayBuffer(n * Type.BYTES_PER_ELEMENT) : new ArrayBuffer(n * Type.BYTES_PER_ELEMENT));

// MeshBVH（不分组）→ 查询用的数据 { nodes, tp, tri }：节点缓冲区原样复制，三角形顶点按树序排好（double，取值就是 float32 的值）
//   pos：建树用的三角形汤（每 9 个数一个三角形）；index：建树后重排过的索引（geometry.index.array）
export function nearestData(bvh, index, pos) {
  if (bvh._roots.length !== 1) throw new Error('nearestData: 只支持没有分组的几何');
  const root = bvh._roots[0], nodes = alloc(Uint8Array, root.byteLength);
  nodes.set(new Uint8Array(root));
  const n = index.length / 3, tp = alloc(Float64Array, n * 9), tri = alloc(Int32Array, n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) { const v = index[3 * i + c] * 3; tp[9 * i + 3 * c] = pos[v]; tp[9 * i + 3 * c + 1] = pos[v + 1]; tp[9 * i + 3 * c + 2] = pos[v + 2]; }
    tri[i] = Math.floor(index[3 * i] / 3);
  }
  return { nodes: nodes.buffer, tp, tri };
}

// 查询对象：closest(x, y, z, max) 返回原来的三角形序号，距离在 .distance；
// 剪枝后一个三角形也没碰到时返回 −1（与 MeshBVH 返回 null 相同）。注意：找到的三角形可能比 max 远（与 MeshBVH 相同）
export function nearestQuery(data) {
  const { tp, tri } = data, f32 = new Float32Array(data.nodes), u32 = new Uint32Array(data.nodes), u16 = new Uint16Array(data.nodes);
  // 节点到点的距离平方（three：点 clamp 到盒子里再求距离）
  const boxD2 = (n32, px, py, pz) => {
    const qx = Math.max(f32[n32], Math.min(f32[n32 + 3], px)) - px;
    const qy = Math.max(f32[n32 + 1], Math.min(f32[n32 + 4], py)) - py;
    const qz = Math.max(f32[n32 + 2], Math.min(f32[n32 + 5], pz)) - pz;
    return qx * qx + qy * qy + qz * qz;
  };
  const stackN = new Int32Array(256), stackS = new Float64Array(256);
  const out = {
    data,
    distance: Infinity,
    closest(px, py, pz, max = Infinity) {
      const maxSq = max * max;
      let best = Infinity, bestTri = -1, sp = 0;
      // 栈里放（节点, 分数）：先压第二个孩子再压第一个，第二个孩子的剪枝在第一个孩子的整棵子树之后判断（与递归相同）
      // 根节点不判断包围盒（MeshBVH 也不判断）
      stackN[sp] = 0; stackS[sp] = -1; sp++;
      while (sp > 0) {
        sp--;
        const n32 = stackN[sp], s = stackS[sp];
        if (s >= 0 && !(s < best && s < maxSq)) continue;
        const n16 = n32 * 2;
        if (u16[n16 + 15] === IS_LEAF) {
          const off = u32[n32 + 6], cnt = u16[n16 + 14];
          for (let i = off, end = off + cnt; i < end; i++) {
            const o = 9 * i;
            const ax = tp[o], ay = tp[o + 1], az = tp[o + 2];
            const abx = tp[o + 3] - ax, aby = tp[o + 4] - ay, abz = tp[o + 5] - az;
            const acx = tp[o + 6] - ax, acy = tp[o + 7] - ay, acz = tp[o + 8] - az;
            const apx = px - ax, apy = py - ay, apz = pz - az;
            const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
            let cx, cy, cz;
            if (d1 <= 0 && d2 <= 0) { cx = ax; cy = ay; cz = az; }
            else {
              const bx = tp[o + 3], by = tp[o + 4], bz = tp[o + 5];
              const bpx = px - bx, bpy = py - by, bpz = pz - bz;
              const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
              if (d3 >= 0 && d4 <= d3) { cx = bx; cy = by; cz = bz; }
              else {
                const vc = d1 * d4 - d3 * d2;
                if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); cx = ax + abx * v; cy = ay + aby * v; cz = az + abz * v; }
                else {
                  const qx = tp[o + 6], qy = tp[o + 7], qz = tp[o + 8];
                  const cpx = px - qx, cpy = py - qy, cpz = pz - qz;
                  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
                  if (d6 >= 0 && d5 <= d6) { cx = qx; cy = qy; cz = qz; }
                  else {
                    const vb = d5 * d2 - d1 * d6;
                    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); cx = ax + acx * w; cy = ay + acy * w; cz = az + acz * w; }
                    else {
                      const va = d3 * d6 - d5 * d4;
                      if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                        const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                        cx = bx + (qx - bx) * w; cy = by + (qy - by) * w; cz = bz + (qz - bz) * w;
                      } else {
                        const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
                        // three：a + ab·v，再 + ac·w（两次累加，顺序不能合并）
                        cx = ax + abx * v; cy = ay + aby * v; cz = az + abz * v;
                        cx += acx * w; cy += acy * w; cz += acz * w;
                      }
                    }
                  }
                }
              }
            }
            const dx = px - cx, dy = py - cy, dz = pz - cz, d = dx * dx + dy * dy + dz * dz;
            if (d < best) { best = d; bestTri = i; }
          }
          continue;
        }
        const c1 = n32 + UINT32_PER_NODE, c2 = n32 + u32[n32 + 6] * UINT32_PER_NODE;
        const s1 = boxD2(c1, px, py, pz), s2 = boxD2(c2, px, py, pz);
        if (sp + 2 > stackN.length) throw new Error('nearestQuery: 树太深');
        if (s2 < s1) { stackN[sp] = c1; stackS[sp] = s1; sp++; stackN[sp] = c2; stackS[sp] = s2; sp++; }
        else { stackN[sp] = c2; stackS[sp] = s2; sp++; stackN[sp] = c1; stackS[sp] = s1; sp++; }
      }
      if (bestTri < 0) { out.distance = Infinity; return -1; }
      out.distance = Math.sqrt(best);
      return tri[bestTri];
    },
  };
  return out;
}

// ── 批量查询 ──
// 一批活：qs（查询数据）、jobs [{ q（qs 里的序号）, pts, max, d, t }]、chunks（每 3 个数一段：job, start, end）、
// ctrl [下一段, 做完的段数]。主线程与 worker 从同一个计数器领段，谁领到谁算
export function runChunks(task, queries = task.qs.map(nearestQuery)) {
  const { ctrl, chunks, jobs } = task, n = chunks.length / 3;
  for (;;) {
    const c = Atomics.add(ctrl, 0, 1);
    if (c >= n) return;
    const job = jobs[chunks[3 * c]], q = queries[job.q], { pts, d, t, max } = job;
    for (let i = chunks[3 * c + 1], end = chunks[3 * c + 2]; i < end; i++) {
      const k = q.closest(pts[3 * i], pts[3 * i + 1], pts[3 * i + 2], max);
      t[i] = k; d[i] = k >= 0 ? q.distance : Infinity;
    }
    Atomics.add(ctrl, 1, 1);
    Atomics.notify(ctrl, 1);
  }
}

const CHUNK = 4096, PARALLEL_MIN = 100000;
let pool = null;
function workers() {
  if (pool) return pool;
  const os = globalThis.process.getBuiltinModule('node:os');
  const n = Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1);
  pool = [];
  for (let i = 0; i < n; i++) {
    const w = new WT.Worker(new URL('./nearworker.mjs', import.meta.url));
    w.unref(); // 不拖住进程退出
    pool.push(w);
  }
  return pool;
}

// 点的扁平数组（每 3 个数一个点）；需要并行时放在共享内存里
export const pointArray = (n) => alloc(Float64Array, 3 * n);

// items：[{ q（nearestQuery 的结果）, pts（pointArray）, max }] → 每项 { d（距离，没找到为 Infinity）, t（三角形序号或 −1） }
export function closestMany(items) {
  const qs = [], qIndex = new Map();
  const jobs = items.map(({ q, pts, max }) => {
    if (!qIndex.has(q)) { qIndex.set(q, qs.length); qs.push(q); }
    const n = pts.length / 3;
    return { q: qIndex.get(q), pts, max, d: alloc(Float64Array, n), t: alloc(Int32Array, n) };
  });
  const segs = [];
  let total = 0;
  jobs.forEach((j, k) => { const n = j.pts.length / 3; total += n; for (let s = 0; s < n; s += CHUNK) segs.push(k, s, Math.min(n, s + CHUNK)); });
  const chunks = alloc(Int32Array, segs.length);
  chunks.set(segs);
  const ctrl = alloc(Int32Array, 2), n = segs.length / 3;
  const task = { ctrl, chunks, jobs };
  const parallel = SHARE && total >= PARALLEL_MIN && qs.every((q) => q.data.nodes instanceof SharedArrayBuffer);
  if (parallel) {
    const msg = { ...task, qs: qs.map((q) => q.data) };
    for (const w of workers()) w.postMessage(msg);
  }
  runChunks(task, qs);
  // 等 worker 把领走的段做完；长时间没有进展（worker 出错退出了）就报错，而不是一直等下去
  let last = -1, since = Date.now();
  for (let done; (done = Atomics.load(ctrl, 1)) < n;) {
    if (done !== last) { last = done; since = Date.now(); } else if (Date.now() - since > 60000) throw new Error('closestMany: worker 没有响应');
    Atomics.wait(ctrl, 1, done, 1000);
  }
  return jobs.map(({ d, t }) => ({ d, t }));
}
