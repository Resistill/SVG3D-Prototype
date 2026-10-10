// 并行拟合（规模，docs/PLAN2.md 4.5）：部件很多时把 fitPart 分给几个 worker 线程算，逆向时直接取用。
// 结果与单线程完全一样：同样的部件、同样的序号（采样种子）、同样的档位与单位。
// 共享同一个网格的部件会走享元类型（类型只拟合一次），不预先拟合。部件不多时不值得起线程，返回 null
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';

const WORKER = new URL('./fitworker.mjs', import.meta.url);

export async function prefit(parts, { fidelity = 'detail', unit = 1, threads = Math.min(8, cpus().length - 1), min = 1500 } = {}) {
  if (parts.length < min || threads < 2) return null;
  const meshUse = new Map();
  for (const p of parts) if (p.mesh != null) meshUse.set(p.mesh, (meshUse.get(p.mesh) ?? 0) + 1);
  const todo = parts.map((p, i) => i).filter((i) => !(parts[i].mesh != null && meshUse.get(parts[i].mesh) > 1));
  if (todo.length < min) return null;
  const chunks = Array.from({ length: threads }, (_, k) => todo.filter((_, j) => j % threads === k)).filter((c) => c.length);
  const results = await Promise.all(chunks.map((idx) => new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { workerData: { fidelity, unit, items: idx.map((i) => ({ i, tris: parts[i].tris })) } });
    w.once('message', (m) => { resolve(m); w.terminate(); });
    w.once('error', reject);
  })));
  const fits = new Map();
  for (const r of results) for (const { i, fit } of r) fits.set(i, fit);
  // 只有同一个部件对象在同一个序号上才能取用（决定层可能换掉、删掉部件，序号会变）
  return { fitOf: (p, i) => (parts[i] === p ? fits.get(i) : undefined), count: fits.size };
}
