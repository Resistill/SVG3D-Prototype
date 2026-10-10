// 文件拆分：把逆向生成的一整份大文本拆成若干小文件，便于人看、便于 AI 按区域读
//   base.s3d            索引：只 import 下面这些文件
//   base/types.s3d      材质与类型（def）
//   base/NN-名字.s3d    物体：先按挂靠关系聚成组（一栋楼和立在它上面、靠着它的东西），再按水平位置做 k-d 分区，
//                       每个文件不超过 maxLines 行（一组太大时组内再按位置拆）；名字取分区里最大的物体
// 引用是全局的（名字跨文件可见），拆分只改变语句所在的文件，不改变编译结果
import { compile } from '../src/s3d.js';

const DECL = /^([\p{L}_][\p{L}\p{N}_]*)\s+([\p{L}_][\p{L}\p{N}_]*)/u;

// 顶层语句切成单元：块语句（def / repeat / group …{ … }）整体一个单元；注释、spline 并入下一个单元，drop 并入上一个
export function units(text) {
  const lines = text.split('\n'), out = [];
  let pending = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) { if (pending.length) pending.push(l); continue; }
    if (/^\s*\/\//.test(l) || /^spline\s/.test(l)) { pending.push(l); continue; }
    if (/^drop\s/.test(l) && out.length) { out[out.length - 1].lines.push(l); continue; }
    const block = [l];
    let depth = 0;
    const count = (s) => { const t = s.replace(/"[^"]*"/g, '').replace(/\/\/.*$/, ''); for (const c of t) depth += c === '{' ? 1 : c === '}' ? -1 : 0; };
    count(l);
    while (depth > 0 && i + 1 < lines.length) { const n = lines[++i]; block.push(n); count(n); }
    const m = DECL.exec(l);
    out.push({ kind: m?.[1] ?? null, name: m?.[1] === 'def' || m?.[1] === 'material' ? null : m?.[2] ?? null, lines: [...pending, ...block] });
    pending = [];
  }
  if (pending.length) out.push({ kind: null, name: null, lines: pending });
  return out;
}

export const safe = (s) => String(s).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 48);
// 支撑关系：立在它上面（on=）、靠着它（against=）。锚点（at=B[u,v,w]）只是就近取的参照，语义上弱，不用来聚组
const REF = /\b(?:on|against)=([\p{L}_][\p{L}\p{N}_]*)/gu;

// result 可选：compile(text) 的结果（取物体位置）；没给就自己编译一次
export function splitSource(text, { maxLines = 400, dir = 'base', result = null } = {}) {
  const us = units(text);
  const header = [];
  // 开头的说明注释（到第一个空行为止）留在索引里
  if (us[0]) { const k = us[0].lines.findIndex((l) => !/^\s*\/\//.test(l)); if (k > 0) header.push(...us[0].lines.splice(0, k)); }
  const types = [], objs = [];
  for (const u of us) {
    if (u.kind === 'def' || u.kind === 'material') types.push(u);
    else if (!u.name) (objs.length || types.length ? (objs.at(-1) ?? types.at(-1)).lines : header).push(...u.lines);
    else objs.push(u);
  }
  const lineCount = text.split('\n').length;
  if (lineCount <= maxLines) return null;
  result ??= compile(text);
  const top = new Map(result.nodes.filter((n) => n.depth === 0 && n.box).map((n) => [n.path, n]));
  for (const u of objs) {
    const n = top.get(u.name);
    u.c = n ? [(n.box.min[0] + n.box.max[0]) / 2, (n.box.min[2] + n.box.max[2]) / 2] : null;
    u.vol = n ? n.box.max.reduce((v, x, k) => v * Math.max(0.01, x - n.box.min[k]), 1) : 0;
  }
  // 没有位置的（例如被 drop 的）跟着前一个单元
  let prev = null;
  for (const u of objs) { if (!u.c) u.c = prev?.c ?? [0, 0]; prev = u; }
  // 聚组：每个物体跟着支撑它的物体走（立在上面、靠着）；没有支撑关系的，跟着水平投影包含它中心、占地至少是它两倍的最大物体
  // （楼栋的外壳、院墙）。连成的一棵树是一组（一栋楼和楼里、楼上的东西）。只往不比自己小的物体合并；
  // 覆盖全场景四分之一以上的物体（地面、路面）不当组的根，否则所有东西都挂在地面下成了一组
  const xz = [...top.values()].map((n) => n.box);
  const sceneArea = xz.length ? (Math.max(...xz.map((b) => b.max[0])) - Math.min(...xz.map((b) => b.min[0]))) * (Math.max(...xz.map((b) => b.max[2])) - Math.min(...xz.map((b) => b.min[2]))) : 0;
  const foot = (u) => { const b = top.get(u.name)?.box; return b ? (b.max[0] - b.min[0]) * (b.max[2] - b.min[2]) : Infinity; };
  const tooBig = (u) => foot(u) > 0.25 * sceneArea;
  const byName = new Map(objs.map((u) => [u.name, u]));
  const parent = new Map();
  for (const u of objs) {
    const head = u.lines.find((l) => DECL.test(l)) ?? '';
    for (const m of head.matchAll(REF)) { const p = byName.get(m[1]); if (p && p !== u && !tooBig(p) && foot(p) >= foot(u)) { parent.set(u, p); break; } }
  }
  const holders = objs.filter((u) => top.get(u.name)?.box && !tooBig(u)).sort((a, b) => foot(b) - foot(a));
  const holds = (h, u) => { const b = top.get(h.name).box; return u.c[0] >= b.min[0] && u.c[0] <= b.max[0] && u.c[1] >= b.min[2] && u.c[1] <= b.max[2]; };
  for (const u of objs) if (!parent.has(u)) { const h = holders.find((h) => h !== u && foot(h) >= 2 * foot(u) && holds(h, u)); if (h) parent.set(u, h); }
  const rootOf = (u) => { const seen = new Set(); while (parent.has(u) && !seen.has(u)) { seen.add(u); u = parent.get(u); } return u; };
  const groups = new Map();
  for (const u of objs) { const r = rootOf(u); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(u); }
  for (const u of objs) u.w = u.lines.length;
  const zones = [...groups].map(([r, us]) => ({ c: r.c, w: us.reduce((s, u) => s + u.w, 0), units: us }));
  const weight = (g) => g.reduce((s, u) => s + u.w, 0);
  const kd = (g, leaves) => {
    if (g.length <= 1 || weight(g) <= maxLines) { leaves.push(g); return; }
    const ext = [0, 1].map((k) => Math.max(...g.map((u) => u.c[k])) - Math.min(...g.map((u) => u.c[k])));
    const k = ext[0] >= ext[1] ? 0 : 1;
    const s = [...g].sort((a, b) => a.c[k] - b.c[k]);
    // 按行数取中位：两边行数大致相等
    let acc = 0, cut = 1;
    const half = weight(s) / 2;
    for (let i = 0; i < s.length - 1; i++) { acc += s[i].w; if (acc >= half) { cut = i + 1; break; } cut = i + 1; }
    kd(s.slice(0, cut), leaves); kd(s.slice(cut), leaves);
  };
  // 先按位置打包整组；一组本身超过 maxLines 时组内再按位置拆
  const packed = [];
  kd(zones, packed);
  const leaves = packed.flatMap((g) => { if (g.length === 1 && g[0].w > maxLines) { const sub = []; kd(g[0].units, sub); return sub; } return [g.flatMap((z) => z.units)]; });
  const files = {};
  const typesPath = `${dir}/types.s3d`;
  if (types.length) files[typesPath] = ['// 材质与类型（def）', '', ...types.flatMap((u) => u.lines)].join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
  const order = new Map(objs.map((u, i) => [u, i]));
  const names = [];
  leaves.forEach((g, i) => {
    g.sort((a, b) => order.get(a) - order.get(b)); // 文件内保持原来的顺序
    const big = g.reduce((a, b) => (b.vol > a.vol ? b : a));
    const xs = g.map((u) => u.c[0]), zs = g.map((u) => u.c[1]);
    const r = (v) => Math.round(v);
    const path = `${dir}/${String(i + 1).padStart(2, '0')}-${safe(big.name)}.s3d`;
    names.push({ path, n: g.length, x: [r(Math.min(...xs)), r(Math.max(...xs))], z: [r(Math.min(...zs)), r(Math.max(...zs))] });
    const gs = new Set(g.map(rootOf)).size;
    files[path] = [`// 分区 ${i + 1}/${leaves.length}：${g.length} 个物体（${gs} 组），x ${r(Math.min(...xs))}…${r(Math.max(...xs))}，z ${r(Math.min(...zs))}…${r(Math.max(...zs))}`, '', ...g.flatMap((u) => u.lines)].join('\n') + '\n';
  });
  const index = [...header.filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())),
    '', '// 拆分成多个文件：类型一个文件，物体按挂靠关系聚组、再按水平位置分区（名字跨文件可见；重跑逆向会整体重写这些文件）',
    ...Object.keys(files).map((p) => `import "${p}"`)].join('\n').replace(/^\n+/, '') + '\n';
  return { index, files, zones: names };
}

// 把索引及其 import 的文件拼回一整份文本（去掉 import 行）：稳定命名、旧工具用
export function joinSource(read, main = 'base.s3d') {
  const seen = new Set(), out = [];
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text;
    try { text = read(file); } catch { return; }
    const base = file.replace(/[^/]*$/, '');
    for (const l of text.split('\n')) {
      const m = /^\s*import\s+"([^"]+)"/.exec(l);
      if (m && !m[1].startsWith('.') && !m[1].startsWith('/')) walk(base + m[1]);
      else if (!m) out.push(l);
    }
  };
  walk(main);
  return out.join('\n');
}

// 索引文件 import 的文件（只认相对路径，不跨出工程）
export function importedFiles(read, main = 'base.s3d') {
  const out = [];
  const walk = (file) => {
    if (out.includes(file)) return;
    let text;
    try { text = read(file); } catch { return; }
    out.push(file);
    const base = file.replace(/[^/]*$/, '');
    for (const m of text.matchAll(/^\s*import\s+"([^"]+)"/gm)) if (!m[1].startsWith('.') && !m[1].startsWith('/')) walk(base + m[1]);
  };
  walk(main);
  return out;
}
