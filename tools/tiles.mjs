// 分块逆向（规模，docs/PLAN2.md 4.5 / D7）：部件很多（1e5）时，按部件中心在水平面上做平衡的 k-d 划分，
// 每块几千个部件，各块在 worker 线程里独立逆向，再合并成一份文本（工程照常按位置拆成 base/ 下的文件）。
//   各块一致的东西由选项保证：名字清理按全场的名字统计（nameStats）；享元类型的名字按全场第一个实例（typeName），
//   采样种子按网格（typeSeed: 'mesh'），所以各块写出的同一个类型逐字相同；默认材质取全场最多的那种。
//   合并：材质、类型按声明的原文去重（同名不同文的在那一块里改名）；物体重名的在那一块里改名（块之间没有引用，块内改名是安全的）。
//   没做：跨块的阵列、镜像（每块各自检测）；块边上的物体只能参照本块里的东西
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { reverse, nameCleanerOf } from './reverse.mjs';

const WORKER = new URL('./tileworker.mjs', import.meta.url);

// 平衡的 k-d 划分：按部件包围盒中心的 x、z 交替（取跨度大的那一轴）对半分，直到每块不超过 maxParts
export function splitTiles(parts, maxParts) {
  const centers = parts.map((p) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const t of p.tris) for (const v of t) { if (v[0] < x0) x0 = v[0]; if (v[0] > x1) x1 = v[0]; if (v[2] < z0) z0 = v[2]; if (v[2] > z1) z1 = v[2]; }
    return [(x0 + x1) / 2, (z0 + z1) / 2];
  });
  const out = [];
  const go = (ids) => {
    if (ids.length <= maxParts) { out.push(ids); return; }
    const span = (k) => { let lo = Infinity, hi = -Infinity; for (const i of ids) { lo = Math.min(lo, centers[i][k]); hi = Math.max(hi, centers[i][k]); } return hi - lo; };
    const k = span(0) >= span(1) ? 0 : 1;
    const sorted = [...ids].sort((a, b) => centers[a][k] - centers[b][k] || a - b), m = sorted.length >> 1;
    go(sorted.slice(0, m)); go(sorted.slice(m));
  };
  go(parts.map((_, i) => i));
  return out;
}

// 顶层语句（连同它的多行块）
function blocksOf(text) {
  const lines = text.split('\n'), out = [];
  let cur = null, depth = 0;
  for (const l of lines) {
    if (!cur) {
      if (!l.trim() || l.startsWith('//')) continue;
      cur = [l];
    } else cur.push(l);
    depth += (l.match(/\{/g) ?? []).length - (l.match(/\}/g) ?? []).length;
    if (depth <= 0) { out.push(cur.join('\n')); cur = null; depth = 0; }
  }
  if (cur) out.push(cur.join('\n'));
  return out;
}
// 声明的名字：material / def 的第二个词；其余“种类 名字 …”的第二个词（drop 没有）
const declOf = (b) => {
  const m = /^(\S+)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(b);
  if (!m || m[1] === 'drop' || m[1] === 'over') return null;
  return { kind: m[1] === 'material' ? 'material' : m[1] === 'def' ? 'def' : 'object', name: m[2] };
};
// 改名：只改引号外面的、完整的标识符（前面不是“.”：路径里的子物体名不动；后面不是“=”：那是属性名，如 steps=8）
function renameIn(text, map) {
  if (!map.size) return text;
  const re = new RegExp(`(?<![\\p{L}\\p{N}_.])(${[...map.keys()].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\p{L}\\p{N}_=])`, 'gu');
  // 取值是符号的属性（pin=bottom、axis=x、profile=rect …）后面的词不是名字
  const SYMBOLIC = /(?:^|[\s,])(?:pin|axis|profile|plane|align|aimwith|orient|smooth|closed|default)=$/;
  return text.split('\n').map((l) => l.split('"').map((seg, i) => (i % 2 ? seg : seg.replace(re, (m, _g, off, str) => (SYMBOLIC.test(str.slice(0, off)) ? m : map.get(m))))).join('"')).join('\n');
}

// 各块的逆向结果 → 一份文本：材质与类型在前（去重），然后各块的物体
export function mergeTiles(texts) {
  const declText = new Map(), used = new Set(), shared = [], body = [];
  const unique = (n) => { let k = 2, x = `${n}_${k}`; while (used.has(x)) x = `${n}_${++k}`; return x; };
  let header = null;
  texts.forEach((text0) => {
    if (header === null) header = text0.split('\n').find((l) => l.startsWith('//')) ?? '';
    let text = text0;
    // 依次处理材质、类型、物体：前一步的改名会改变后一步的原文（类型体里的 mat=）
    for (const kind of ['material', 'def', 'object']) {
      const map = new Map();
      for (const b of blocksOf(text)) {
        const d = declOf(b);
        if (!d || d.kind !== kind) continue;
        if (!used.has(d.name)) continue;
        if (kind !== 'object' && declText.get(d.name) === b) continue; // 同名同文：共用
        map.set(d.name, unique(d.name));
      }
      text = renameIn(text, map);
      for (const b of blocksOf(text)) { const d = declOf(b); if (d && d.kind === kind) used.add(d.name); }
    }
    for (const b of blocksOf(text)) {
      const d = declOf(b);
      if (d && (d.kind === 'material' || d.kind === 'def')) {
        if (declText.has(d.name)) continue;
        declText.set(d.name, b);
        shared.push(b);
      } else body.push(b);
    }
  });
  return [header, '', ...shared, '', ...body, ''].join('\n');
}

// 分块逆向：parts 全部源部件，opts 同 reverse()（不支持决定层），maxParts 每块的上限，threads 并行的线程数
export async function reverseTiled(parts, opts = {}, { maxParts = 4000, threads = Math.min(8, Math.max(1, cpus().length - 1)) } = {}) {
  const tiles = splitTiles(parts, maxParts);
  // 全场一致的东西：名字统计、类型名（同一个网格的全场第一个实例清理后的名字）、默认材质
  const nameStats = parts.map((p) => p.name);
  const clean = nameCleanerOf(nameStats), typeName = new Map(), matCount = new Map();
  for (const p of parts) {
    if (p.mesh != null && !typeName.has(p.mesh)) typeName.set(p.mesh, clean(p.name));
    const k = JSON.stringify(p.material);
    matCount.set(k, (matCount.get(k) ?? 0) + 1);
  }
  const [defKey, defN] = [...matCount].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  const tileOpts = { ...opts, nameStats, typeSeed: 'mesh', defaultMaterial: opts.defaultMaterial !== false && defN * 2 >= parts.length ? defKey : false };
  const tileParts = tiles.map((ids) => ids.map((i) => ({ ...parts[i], typeName: parts[i].mesh != null ? typeName.get(parts[i].mesh) ?? undefined : undefined })));
  let results;
  if (threads <= 1) results = tileParts.map((ps) => slim(reverse(ps, tileOpts)));
  else {
    // 一个线程一次领一块，做完再领
    results = new Array(tiles.length);
    let next = 0;
    const runOne = () => new Promise((resolve, reject) => {
      const w = new Worker(WORKER);
      const take = () => {
        if (next >= tiles.length) { w.terminate(); resolve(); return; }
        const k = next++;
        w.once('message', (m) => { if (m.error) { w.terminate(); reject(new Error(m.error)); return; } results[k] = m; take(); });
        w.postMessage({ parts: tileParts[k], opts: tileOpts });
      };
      w.once('error', reject);
      take();
    });
    await Promise.all(Array.from({ length: Math.min(threads, tiles.length) }, runOne));
  }
  const src = mergeTiles(results.map((r) => r.src));
  const sum = (f) => results.flatMap((r) => r.report[f] ?? []);
  const placement = {};
  for (const r of results) for (const [k, v] of Object.entries(r.report.placement ?? {})) placement[k] = (placement[k] ?? 0) + v;
  const report = {
    source: opts.srcFile, level: opts.level, parts: parts.length, tiles: tiles.map((t) => t.length),
    arrays: sum('arrays'), mirrors: sum('mirrors'), budget: sum('budget'), panels: sum('panels'), unions: sum('unions'), shells: sum('shells'),
    fallback: sum('fallback'), dissolved: sum('dissolved'), placement, renamed: results.reduce((a, r) => a + (r.report.renamed ?? 0), 0),
  };
  return { src, report, objs: results.flatMap((r) => r.objs) };
}
// worker 只回传合并要用的：文本、报告、网格引用（工程要写部件文件）
export function slim(out) {
  return { src: out.src, report: out.report, objs: out.objs.filter((o) => o.kind === 'mesh').map((o) => ({ kind: 'mesh', props: { src: o.props.src } })) };
}
