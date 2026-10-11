// 并行拟合（规模，docs/PLAN2.md 4.5）：部件很多时把 fitPart 分给几个 worker 线程算，逆向时直接取用。
// 结果与单线程完全一样：同样的部件、同样的序号（采样种子）、同样的档位与单位。
// 共享同一个网格的部件会走享元类型（类型只拟合一次），不预先拟合。部件不多时不值得起线程，返回 null
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { assignRoles } from './roles.mjs';
import { typeKey } from './reverse.mjs';

const WORKER = new URL('./fitworker.mjs', import.meta.url);

// 拟合的门槛按部件的角色与网格的价钱（score.mjs 的 meshPrice）：角色取部件上的（工程挂的），没有时按默认规则判；meshPrice 同 reverse 的选项。
// composite：同时算组合写法（板件、外壳、并、小场景），要给 reverse 会用的 srcFile、partsFile 与开关（panels、shells、unions、subs，默认都开）；
// 逆向时只有这些都一样才取用
export async function prefit(parts, { fidelity = 'detail', unit = 1, threads = Math.min(8, cpus().length - 1), min = 300, roles = null, meshPrice = null, composite = null } = {}) {
  if (parts.length < min || threads < 2) return null;
  const rs = parts.every((p) => p.role) ? parts.map((p) => p.role) : assignRoles(parts, roles ?? []);
  const meshUse = new Map();
  for (const p of parts) if (p.mesh != null) meshUse.set(p.mesh, (meshUse.get(p.mesh) ?? 0) + 1);
  // 只拟合：不共用网格的部件。组合写法：所有不会成为享元类型实例的部件（同一个网格、同样缩放与镜像的至少两个才成类型），
  // 同一个网格的分到同一个 worker、按序号依次算（见 reverse.mjs 的 prefitComposite）；组合写法很费时，部件不多也值得起线程
  let todo, groupOf;
  if (composite) {
    const keyCount = new Map(), keys = parts.map((p, i) => typeKey(p, rs[i])?.key ?? null);
    for (const k of keys) if (k) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    todo = parts.map((p, i) => i).filter((i) => rs[i] !== 'helper' && !(keys[i] && keyCount.get(keys[i]) > 1));
    groupOf = (i) => (parts[i].mesh != null ? `m${parts[i].mesh}` : `i${i}`);
  } else {
    todo = parts.map((p, i) => i).filter((i) => !(parts[i].mesh != null && meshUse.get(parts[i].mesh) > 1));
    groupOf = (i) => `i${i}`;
  }
  if (todo.length < (composite ? Math.min(min, 16) : min)) return null;
  // 动态分配：按组（同一个网格的部件，组内按序号）排成一个队列，三角形多的组先发；哪个 worker 空了就给它下一组。
  // 各组的缓存键（网格）互不相同，所以哪个 worker 算哪一组不影响结果。组合写法的耗时与三角形数关系不大，静态分配时最慢的 worker 拖住了整体
  const groups = new Map();
  for (const i of todo) { const g = groupOf(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); }
  const triCount = (g) => g.reduce((a, i) => a + parts[i].tris.length, 0);
  const queue = [...groups.values()].sort((a, b) => triCount(b) - triCount(a));
  const C = composite && { panels: true, shells: true, unions: true, subs: true, partsFile: null, ...composite };
  const item = (i) => { const p = parts[i]; return C ? { i, role: rs[i], tris: p.tris, name: p.name ?? null, uid: p.uid, from: p.from, mesh: p.mesh, material: p.material, matrix: p.matrix, force: p.force } : { i, tris: p.tris, role: rs[i] }; };
  const results = await Promise.all(Array.from({ length: Math.min(threads, queue.length) }, () => new Promise((resolve, reject) => {
    const out = [];
    const w = new Worker(WORKER, { workerData: { fidelity, unit, meshPrice, composite: C, meshUse: C ? [...meshUse] : null } });
    const next = () => { const g = queue.shift(); if (g) w.postMessage(g.map(item)); else { w.terminate(); resolve(out); } };
    w.on('message', (m) => { out.push(...m); next(); });
    w.once('error', reject);
    next();
  })));
  const fits = new Map(), unions = new Map(), comps = new Map();
  for (const r of results) for (const { i, fit, union, comp } of r) { fits.set(i, fit); if (union !== undefined) unions.set(i, union); if (comp) comps.set(i, comp); }
  const same = (o) => C && ['srcFile', 'partsFile', 'panels', 'shells', 'unions', 'subs'].every((k) => (o[k] ?? null) === (C[k] ?? null));
  // 只有同一个部件对象在同一个序号上才能取用（决定层可能换掉、删掉部件，序号会变）
  // unionOf：拟合差的部件预先算好的“基本体之并”的几何（null 表示拼不成；undefined 表示没算）
  // compOf：预先算好的组合写法 { out, sc }（out 为 null：没有更好的组合写法）；opts 与预先算时不同、或没算过时返回 undefined
  return { fitOf: (p, i) => (parts[i] === p ? fits.get(i) : undefined), unionOf: (p, i) => (parts[i] === p ? unions.get(i) : undefined), compOf: (p, i, opts) => (parts[i] === p && same(opts) ? comps.get(i) : undefined), count: fits.size };
}
