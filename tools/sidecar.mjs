// 旁路信息：源模型之外的表（例如关卡导出的 layout.csv：类别、碰撞盒、碰撞类型），按节点名对上源部件，写成物体的 ~元数据。
// ~元数据不计描述长度，可以在 where 里读（all() where collision_profile == "NoCollision"），也可以给决定层、语义层当线索。
// 不认具体的表：project.json 的 sidecar 可以写明，没写的部分自动推断——
//   match     节点名的哪几段（按 / 拆开，去掉 @k）分别等于表里的哪几列，例如 ["category", "level", "mesh"]；
//   position  同名的多个实例按位置区分：三列 [x, y, z]，取与部件中心最近的那一行（每行只用一次）；
//   fields    写进元数据的列：取值种类少（≤ 32）、并且不是全场都一样的分类列。
import { readFileSync } from 'node:fs';

export function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    rows.push(out);
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, k) => [h.trim(), r[k] ?? ''])));
}

const segsOf = (name) => String(name ?? '').replace(/@\d+$/, '').split('/');
const centerOf = (tris) => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const v of t) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
  return lo.map((v, k) => (v + hi[k]) / 2);
};

// 自动推断 match：哪些列的值在节点名的固定位置上出现（抽样里 90% 以上对得上）
function inferMatch(parts, rows) {
  const cols = Object.keys(rows[0] ?? {});
  const sample = parts.filter((p) => p.name).slice(0, 200);
  const values = new Map(cols.map((c) => [c, new Set(rows.map((r) => r[c]))]));
  const match = [];
  const nSeg = Math.max(0, ...sample.map((p) => segsOf(p.name).length));
  for (let s = 0; s < nSeg; s++) {
    let best = null;
    for (const c of cols) {
      if (match.some((m) => m.col === c)) continue;
      const hit = sample.filter((p) => values.get(c).has(segsOf(p.name)[s])).length;
      if (hit >= 0.9 * sample.length && (!best || hit > best.hit)) best = { col: c, seg: s, hit };
    }
    if (best) match.push(best);
  }
  return match;
}

// 自动推断 position：形如 前缀_x / 前缀_y / 前缀_z 的数值列里，与部件中心距离的中位数最小的一组
function inferPosition(cands, cols) {
  const triples = cols.filter((c) => /_x$/i.test(c)).map((c) => [c, c.replace(/_x$/i, '_y'), c.replace(/_x$/i, '_z')]).filter((t) => t.every((c) => cols.includes(c)));
  let best = null;
  for (const t of triples) {
    const ds = cands.slice(0, 300).map(({ part, rows }) => Math.min(...rows.map((r) => Math.hypot(...t.map((c, k) => +r[c] - part.c[k]))))).filter(Number.isFinite).sort((a, b) => a - b);
    const med = ds[ds.length >> 1];
    if (med != null && (!best || med < best.med)) best = { t, med };
  }
  return best?.t ?? null;
}

// 把表挂到源部件上：part.meta = { 列: 值 }；返回匹配统计
export function attachSidecar(parts, rows, spec = {}) {
  if (!rows.length) return { matched: 0, parts: parts.length };
  const cols = Object.keys(rows[0]);
  const match = spec.match ? spec.match.map((col, seg) => ({ col, seg })) : inferMatch(parts, rows);
  if (!match.length) return { matched: 0, parts: parts.length, error: '节点名里找不到与表里的列对得上的段' };
  const key = (vals) => vals.join('\u0001');
  const index = new Map();
  for (const r of rows) { const k = key(match.map((m) => r[m.col])); if (!index.has(k)) index.set(k, []); index.get(k).push(r); }
  const cands = [];
  for (const p of parts) {
    const segs = segsOf(p.name), rs = index.get(key(match.map((m) => segs[m.seg])));
    if (rs) cands.push({ part: { p, c: centerOf(p.tris) }, rows: rs });
  }
  const position = spec.position ?? inferPosition(cands, cols);
  const fields = spec.fields ?? cols.filter((c) => {
    if (match.some((m) => m.col === c) || position?.includes(c)) return false;
    const vs = new Set(rows.map((r) => r[c]));
    return vs.size > 1 && vs.size <= 32;
  });
  // 同名的多个实例：按位置一一对应（近的先配）
  const used = new Set();
  const pairs = [];
  for (const { part, rows: rs } of cands) for (const r of rs) pairs.push({ part, r, d: position ? Math.hypot(...position.map((c, k) => +r[c] - part.c[k])) : 0 });
  pairs.sort((a, b) => a.d - b.d);
  const done = new Set();
  for (const { part, r } of pairs) {
    if (done.has(part.p) || used.has(r)) continue;
    done.add(part.p); used.add(r);
    part.p.meta = Object.fromEntries(fields.map((f) => [f.replace(/[^\p{L}\p{N}_]/gu, '_'), r[f]]));
  }
  return { matched: done.size, parts: parts.length, match: match.map((m) => m.col), position, fields };
}

export function loadSidecar(path) { return parseCSV(readFileSync(path, 'utf8')); }
