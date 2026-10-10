// 决定层 decisions.s3d（docs/PLAN2.md 4.6）：人或 AI 对逆向的约束，用语言本身写，重跑逆向时必须满足。不进 scene、不计描述长度。
//   drop ~src="X"                          这些源部件是噪声、碎片，忽略
//   box hangar ~src=["a#1","a#7"]          这些源部件是一个物体，叫 hangar，写成盒子（cyl / cone / sphere / wedge 同理）
//   mesh road ~src="X"                     保留为网格引用（只能是一个部件：网格引用指向源文件里的一个节点）
//   def house ~src=["p1","p2","p3"]        这几个部件是同一个类型，类型叫 house（目前要求它们共享同一个网格——引擎的享元）
//   over bunker ~lock=place|shape|all      这个物体沿用上一次基础层里的定位 / 形状 / 整行（人改过、不要再动）
// 满足不了的写进报告 unsatisfied（带原因），找不到源部件的列为 dangling；逆向照常进行。
export const PRIMS = new Set(['box', 'cyl', 'cone', 'sphere', 'wedge']);

// 一行的 ~键=值（值是字符串、数组或裸词）
function metaOf(line) {
  const out = {};
  for (const m of line.matchAll(/~([\p{L}_][\p{L}\p{N}_]*)=("(?:[^"\\]|\\.)*"|\[[^\]]*\]|\S+)/gu)) {
    let v = m[2];
    try { v = JSON.parse(v); } catch { /* 裸词 */ }
    out[m[1]] = v;
  }
  return out;
}

export function parseDecisions(text) {
  const out = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line || /^import\s/.test(line)) return;
    const m = /^([\p{L}_][\p{L}\p{N}_]*)(?:\s+([\p{L}_][\p{L}\p{N}_.]*))?/u.exec(line);
    if (!m) return;
    const meta = metaOf(line);
    const src = meta.src == null ? [] : [].concat(meta.src).map(String);
    out.push({ line: i + 1, kind: m[1], name: m[2] && !m[2].startsWith('~') ? m[2] : null, src, lock: meta.lock ?? null, text: raw.trim() });
  });
  return out;
}

// 作用到源部件上（拟合之前）：返回新的部件列表；部件上可能带 force（指定形状或 mesh）、forceName（指定名字）、typeName（类型名）
export function applyDecisions(parts, decs) {
  const idOf = (p) => [p.uid, p.name, p.from].filter(Boolean);
  const byId = new Map();
  for (const p of parts) for (const id of idOf(p)) if (!byId.has(id)) byId.set(id, p);
  const report = { applied: [], unsatisfied: [], dangling: [] };
  const dropped = new Set(), replaced = new Map(), locks = [];
  const find = (d) => {
    const ps = d.src.map((s) => byId.get(s));
    const miss = d.src.filter((_, k) => !ps[k]);
    if (miss.length) report.dangling.push({ line: d.line, text: d.text, missing: miss });
    return ps.filter(Boolean);
  };
  for (const d of decs) {
    if (d.kind === 'over') {
      if (!d.name || !['place', 'shape', 'all'].includes(d.lock)) report.unsatisfied.push({ line: d.line, text: d.text, why: 'over 决定要写物体名和 ~lock=place|shape|all' });
      else locks.push(d);
      continue;
    }
    if (!d.src.length) { report.unsatisfied.push({ line: d.line, text: d.text, why: '没有 ~src（要约束哪些源部件）' }); continue; }
    const ps = find(d);
    if (!ps.length) continue;
    if (d.kind === 'drop') { ps.forEach((p) => dropped.add(p)); report.applied.push({ line: d.line, text: d.text }); continue; }
    if (d.kind === 'def') {
      const mesh = new Set(ps.map((p) => p.mesh));
      if (ps.length < 2 || mesh.size !== 1 || ps[0].mesh == null) { report.unsatisfied.push({ line: d.line, text: d.text, why: '目前只支持共享同一个网格的部件（引擎的享元）；几何同形、各自一份网格的还不能认成类型' }); continue; }
      ps.forEach((p) => replaced.set(p, { ...(replaced.get(p) ?? p), typeName: d.name }));
      report.applied.push({ line: d.line, text: d.text });
      continue;
    }
    if (d.kind === 'mesh') {
      if (ps.length !== 1) { report.unsatisfied.push({ line: d.line, text: d.text, why: '网格引用只能指向一个源部件' }); continue; }
      replaced.set(ps[0], { ...ps[0], force: 'mesh', forceName: d.name, mesh: null, matrix: null });
      report.applied.push({ line: d.line, text: d.text });
      continue;
    }
    if (PRIMS.has(d.kind)) {
      // 一个或多个部件合成一个物体：三角形合在一起拟合指定的形状；来源记第一个部件
      const merged = ps.length === 1 ? { ...ps[0] } : { ...ps[0], tris: ps.flatMap((p) => p.tris), meta: { ...(ps[0].meta ?? {}), merged: ps.length } };
      Object.assign(merged, { force: d.kind, forceName: d.name, mesh: null, matrix: null });
      replaced.set(ps[0], merged);
      ps.slice(1).forEach((p) => dropped.add(p));
      report.applied.push({ line: d.line, text: d.text });
      continue;
    }
    report.unsatisfied.push({ line: d.line, text: d.text, why: `还不支持 ${d.kind} 决定（阵列、镜像要由检测器认出来）` });
  }
  const out = parts.filter((p) => !dropped.has(p)).map((p) => replaced.get(p) ?? p);
  return { parts: out, report, locks };
}

// 一条语句拆成词：方括号、圆括号、引号里的空格不拆
function tokens(line) {
  const out = [];
  let cur = '', depth = 0, q = false;
  for (const ch of line) {
    if (q) { cur += ch; if (ch === '"') q = false; continue; }
    if (ch === '"') { q = true; cur += ch; continue; }
    if (ch === '[' || ch === '(') depth++;
    if (ch === ']' || ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const PLACE = new Set(['on', 'at', 'against', 'offset', 'pin', 'align', 'turn', 'rot', 'inside', 'gap', 'of', 'across', 'along', 'from', 'to', 'drop']);
const keyOf = (t) => /^([\p{L}_][\p{L}\p{N}_]*)=/u.exec(t)?.[1] ?? null;

// ~lock：用上一次的基础层（prev）里同名物体的那一行，替换这一次的定位 / 形状 / 整行。只支持顶层的单行语句
export function applyLocks(text, prev, locks) {
  const report = { applied: [], unsatisfied: [] };
  if (!locks.length) return { text, report };
  const lines = text.split('\n');
  // 物体声明的那一行（不是同名的 material、def、注释）
  const NOT_OBJ = /^(material|def|let|concept|pattern|check|style|variant|import|over|drop|\/\/)/;
  const find = (ls, name) => ls.findIndex((l) => { const t = tokens(l); return t[1] === name && !/^\s/.test(l) && !NOT_OBJ.test(t[0] ?? ''); });
  const pls = String(prev ?? '').split('\n');
  for (const d of locks) {
    const i = find(lines, d.name), j = find(pls, d.name);
    if (!prev || j < 0) { report.unsatisfied.push({ line: d.line, text: d.text, why: '上一次的基础层里没有这个物体' }); continue; }
    if (i < 0) { report.unsatisfied.push({ line: d.line, text: d.text, why: '这一次的逆向结果里没有这个顶层物体（可能并进了阵列）' }); continue; }
    if (/\{\s*$/.test(lines[i]) || /\{\s*$/.test(pls[j])) { report.unsatisfied.push({ line: d.line, text: d.text, why: '块语句（阵列、组）还不支持锁定' }); continue; }
    const now = tokens(lines[i]), was = tokens(pls[j]);
    let merged;
    if (d.lock === 'all') merged = was;
    else {
      const isPlace = (t) => PLACE.has(keyOf(t));
      const isMeta = (t) => t.startsWith('~');
      const body = (ts, place) => ts.slice(2).filter((t) => !isMeta(t) && (place ? isPlace(t) : !isPlace(t)));
      // place：形状用这一次的，定位用上一次的；shape：种类与形状用上一次的，定位用这一次的
      merged = d.lock === 'place'
        ? [now[0], now[1], ...body(now, false), ...body(was, true), ...now.filter((t) => t.startsWith('~'))]
        : [was[0], now[1], ...body(was, false), ...body(now, true), ...was.filter((t) => t.startsWith('~'))];
    }
    lines[i] = merged.join(' ');
    report.applied.push({ line: d.line, text: d.text });
  }
  return { text: lines.join('\n'), report };
}
