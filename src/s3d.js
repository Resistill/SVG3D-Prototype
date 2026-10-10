// SVG3D 核心：源码 → 解析 → 展开（模板/阵列）→ 复制关系（镜像/旋转）→ 关系求解 → 几何条目 + 空间事实
// 纯 JS，无依赖，浏览器与 Node 通用。
//
// 坐标约定：单位米，Y 朝上；+X = right/east，+Z = front/south。
// 每个物体有自己的局部坐标系：绕 Y 轴旋转（turn），以及可能的镜像（只由 mirror 产生）。
// 基本体的原点在其底面中心，所以“没有任何关系”的物体默认立在父坐标系原点上。

// ───────────────────────── 常量 ─────────────────────────

export const DIRS = {
  top: [0, 1, 0], up: [0, 1, 0], bottom: [0, -1, 0], down: [0, -1, 0],
  left: [-1, 0, 0], west: [-1, 0, 0], right: [1, 0, 0], east: [1, 0, 0],
  front: [0, 0, 1], south: [0, 0, 1], back: [0, 0, -1], north: [0, 0, -1],
  center: [0, 0, 0],
};
const FACES = ['left', 'right', 'front', 'back', 'top', 'bottom'];
const MEASURES = new Set(['w', 'h', 'd']);
const CURVE_POINTS = { start: 0, mid: 0.5, end: 1 };
const AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

const PLACEMENT = new Set(['at', 'pin', 'on', 'under', 'against', 'inside', 'gap', 'offset', 'align', 'alignto',
  'turn', 'tilt', 'roll', 'rot', 'aim', 'aimwith', 'mat', 'color']);
const KIND_PROPS = {
  box: ['size'], wedge: ['size'], cyl: ['r', 'h', 'axis'], cone: ['r', 'r2', 'h', 'axis'], sphere: ['r'],
  revolve: ['profile', 'angle', 'smooth'],
  span: ['from', 'to', 'drop', 'dir', 'section', 'r', 'steps'],
  sweep: ['path', 'profile', 'r', 'section', 'smooth'], pipe: ['path', 'r', 'smooth'],
  line: ['path'], bezier: ['path'], spline: ['path', 'closed'],
  arc: ['r', 'angle', 'rise', 'plane'], helix: ['r', 'pitch', 'turns'],
  group: [], union: [], subtract: [], intersect: [],
  repeat: ['n', 'step', 'turn', 'center', 'along', 'orient', 'over'],
  mirror: ['of', 'across', 'axis'], rotate: ['of', 'about', 'axis', 'angle', 'n'],
};
const LEAVES = new Set(['box', 'wedge', 'cyl', 'cone', 'sphere', 'revolve', 'span', 'sweep', 'pipe']);
const CURVES = new Set(['line', 'bezier', 'spline', 'arc', 'helix']);
const PATH_CURVES = new Set(['line', 'bezier', 'spline']); // 由父框架中的点定义，自身不再定位
const LINKS = new Set(['span', 'sweep', 'pipe']);
const CSG = new Set(['union', 'subtract', 'intersect']);
const COPIES = new Set(['mirror', 'rotate']);
const K = (n) => n.asKind ?? n.kind;

// ───────────────────────── 错误 ─────────────────────────

export class S3DError extends Error {
  constructor(msg, line, node) { super(msg); this.line = line; this.node = node; }
}
class Cycle extends Error {
  constructor(node, key) { super('cycle'); this.node = node; this.key = key; }
}

// ───────────────────────── 向量与变换 ─────────────────────────

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a, b, s) => add(a, scl(sub(b, a), s));
const rad = (d) => (d * Math.PI) / 180;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => scl(a, 1 / (len(a) || 1));

// ── 3×3 矩阵（行优先）──
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mv = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const mm = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const tr = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]]);
const det3 = (A) => dot(A[0], cross(A[1], A[2]));
const cols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
// turn：绕 Y（俯视逆时针，与 three.js 的 rotation.y 一致）
const Ry = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };
// tilt：绕 X，顶部倒向 front(+z)
const Rx = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
// roll：顶部倒向 right(+x)
const Rroll = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, s, 0], [-s, c, 0], [0, 0, 1]]; };
// 绕任意轴（右手）
const axisAngle = (axis, a) => {
  const [x, y, z] = unit(axis), c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
};
// 任取一个与 v 垂直的单位向量
const perpTo = (v) => unit(cross(v, Math.abs(v[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
// 使局部 a→d、b→e 的旋转（要求 a⊥b；e 会先被正交化到 d 的垂面上）
function alignAxes(a, b, d, e) {
  d = unit(d);
  e = sub(e, scl(d, dot(e, d)));
  e = len(e) < 1e-6 ? perpTo(d) : unit(e);
  return mm(cols(d, e, cross(d, e)), tr(cols(a, b, cross(a, b))));
}
const isAxisAligned = (M) => M.every((r) => r.every((x) => Math.abs(x) < 1e-6 || Math.abs(Math.abs(x) - 1) < 1e-6));

// 变换 = 正交矩阵 R（det=-1 即镜像）+ 平移 t：p ↦ R·p + t。对复合与求逆封闭。
const IDENT = { R: I3, t: [0, 0, 0] };
const T3 = (R, t = [0, 0, 0]) => ({ R, t });
const apply = (T, p) => add(mv(T.R, p), T.t);
const applyDir = (T, d) => mv(T.R, d);
const compose = (A, B) => ({ R: mm(A.R, B.R), t: apply(A, B.t) });
const invT = (A) => { const Rt = tr(A.R); return { R: Rt, t: scl(mv(Rt, A.t), -1) }; };
// 关于平面（过点 q、单位法线 n）的反射
const reflectAcross = (q, n) => {
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => (i === j ? 1 : 0) - 2 * n[i] * n[j]));
  return { R: M, t: scl(n, 2 * dot(q, n)) };
};
// 绕过点 q、方向为 axis 的轴旋转
const rotateAbout = (q, axis, a) => { const M = axisAngle(axis, a); return { R: M, t: sub(q, mv(M, q)) }; };

const ZERO_BOX = { min: [0, 0, 0], max: [0, 0, 0] };
function boxCorners(b) {
  const out = [];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]);
  return out;
}
function boundsOf(points) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  return points.length ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}
const transformBox = (T, b) => boundsOf(boxCorners(b).map((p) => apply(T, p)));

// 锚点向量的主方向，作为该锚点的法线（棱/角优先取竖直方向）
function dominant(a) {
  const ax = [Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2])];
  const m = Math.max(...ax);
  if (m < 1e-9) return [0, 0, 0];
  if (ax[1] === m) return [0, Math.sign(a[1]), 0];
  if (ax[0] === m) return [Math.sign(a[0]), 0, 0];
  return [0, 0, Math.sign(a[2])];
}

export function dirWord(word) {
  let v = [0, 0, 0];
  for (const p of word.split('-')) {
    if (!(p in DIRS)) return null;
    v = add(v, DIRS[p]);
  }
  return v;
}

// ───────────────────────── 曲线工具 ─────────────────────────

function bezierPts(ctrl, n = 64) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    let pts = ctrl, s = i / n;
    while (pts.length > 1) pts = pts.slice(1).map((p, k) => lerp(pts[k], p, s));
    out.push(pts[0]);
  }
  return out;
}
// 均匀 Catmull-Rom，经过每个控制点
function catmullRom(ctrl, closed, per = 12) {
  const n = ctrl.length;
  if (n < 3 && !closed) return ctrl;
  const get = (i) => (closed ? ctrl[(i + n) % n] : ctrl[Math.max(0, Math.min(n - 1, i))]);
  const out = [], segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let j = 0; j < per; j++) {
      const t = j / per, t2 = t * t, t3 = t2 * t;
      out.push(p1.map((_, k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
    }
  }
  if (!closed) out.push(ctrl[n - 1]);
  return out;
}
// 扫掠的截面框架：side 保持水平、up 尽量朝上（道路、栏杆不会侧翻）
function sweepFrames(pts, closed, tans = null) {
  const n = pts.length;
  let prev = [0, 0, 1];
  return pts.map((p, i) => {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const T = tans ? tans[i] : unit(sub(b, a));
    let side = cross(T, [0, 1, 0]);
    side = len(side) < 1e-4 ? prev : unit(side);
    prev = side;
    return { p, side, up: unit(cross(side, T)) };
  });
}
// 多边形统一成逆时针（保证扫掠出的面朝外）
function ccw(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a < 0 ? [...poly].reverse() : poly;
}
function sweepProfile(profile, r, w, t, pin) {
  if (profile === 'circle') return Array.from({ length: 20 }, (_, k) => [r * Math.cos((k / 20) * 2 * Math.PI), r * Math.sin((k / 20) * 2 * Math.PI)]);
  const dv = pin === 'bottom' ? t / 2 : pin === 'top' ? -t / 2 : 0;
  return [[w / 2, -t / 2 + dv], [w / 2, t / 2 + dv], [-w / 2, t / 2 + dv], [-w / 2, -t / 2 + dv]];
}

// 折线拐角倒圆（管线、道路的自然弯头）
function roundCorners(ctrl, radius) {
  if (ctrl.length < 3 || radius <= 0) return ctrl;
  const out = [ctrl[0]];
  for (let i = 1; i < ctrl.length - 1; i++) {
    const a = ctrl[i - 1], b = ctrl[i], c = ctrl[i + 1];
    const la = len(sub(a, b)), lc = len(sub(c, b));
    const d = Math.min(radius, la * 0.45, lc * 0.45);
    if (d < 1e-6) { out.push(b); continue; }
    const p1 = add(b, scl(sub(a, b), d / la)), p2 = add(b, scl(sub(c, b), d / lc));
    out.push(...bezierPts([p1, b, p2], 8));
  }
  out.push(ctrl[ctrl.length - 1]);
  return out;
}
// fn：可选的解析式（圆弧、螺旋的弧长与角度成正比，可以精确取点）
function measureCurve(pts, closed, fn = null) {
  const seq = closed ? [...pts, pts[0]] : pts;
  const cum = [0];
  for (let i = 1; i < seq.length; i++) cum.push(cum[i - 1] + len(sub(seq[i], seq[i - 1])));
  return { pts, seq, cum, total: cum[cum.length - 1], closed, fn };
}
// 按弧长取参数 t ∈ [0,1] 处的点与切线
function curveAt(c, t) {
  if (c.closed) t = ((t % 1) + 1) % 1; else t = Math.max(0, Math.min(1, t));
  if (c.fn) return c.fn(t);
  const L = t * c.total, { seq, cum } = c;
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= L) lo = mid; else hi = mid; }
  const segLen = cum[hi] - cum[lo] || 1;
  const d = sub(seq[hi], seq[lo]), l = len(d) || 1;
  return { p: lerp(seq[lo], seq[hi], (L - cum[lo]) / segLen), tan: scl(d, 1 / l) };
}

// ───────────────────────── 词法：语句级 ─────────────────────────
// 语句 = 一行中的若干“词”；括号内的空白与换行不切分。

function lexStatements(src) {
  const toks = [];
  let cur = '', curLine = 1, line = 1, depth = 0, inQ = false;
  const push = () => { if (cur) { toks.push({ t: 'word', v: cur, line: curLine }); cur = ''; } };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' && c !== '\n') inQ = !inQ;
    if (inQ && c !== '\n') { if (!cur) curLine = line; cur += c; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; i--; continue; }
    if (c === '\n') {
      if (depth === 0) { push(); toks.push({ t: 'nl', line }); } else cur += ' ';
      line++; continue;
    }
    if (depth === 0 && (c === ' ' || c === '\t' || c === '\r')) { push(); continue; }
    if (depth === 0 && (c === '{' || c === '}' || c === ';')) { push(); toks.push({ t: c === ';' ? 'nl' : c, line }); continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    if (!cur) curLine = line;
    cur += c;
  }
  push();
  toks.push({ t: 'nl', line });
  return toks;
}

// ───────────────────────── 词法与语法：表达式 ─────────────────────────

const ID_START = /[\p{L}_]/u, ID_CHAR = /[\p{L}\p{N}_]/u;
const RANDOM_FNS = new Set(['rand', 'uniform', 'choose']);

function exprTokens(s, line) {
  const out = [];
  let i = 0;
  const readIdent = () => { let j = i; while (j < s.length && ID_CHAR.test(s[j])) j++; const w = s.slice(i, j); i = j; return w; };
  // 把 top-left-front 这类方向组合词合成一个段
  const mergeDirs = (seg) => {
    while (s[i] === '-' && ID_START.test(s[i + 1] || '')) {
      let j = i + 1; while (j < s.length && ID_CHAR.test(s[j])) j++;
      const w = s.slice(i + 1, j);
      if (!(w in DIRS) || !(seg.split('-')[0] in DIRS)) break;
      seg += '-' + w; i = j;
    }
    return seg;
  };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (c === '#') {
      // #名字：在需要集合的地方是“带这个标签的对象”，在需要颜色的地方是十六进制颜色
      const m = /^#[\p{L}\p{N}_]+/u.exec(s.slice(i));
      if (m) { out.push({ t: 'hash', v: m[0].slice(1) }); i += m[0].length; continue; }
    }
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1);
      if (j < 0) throw new S3DError('字符串缺少结束引号', line);
      out.push({ t: 'str', v: s.slice(i + 1, j) }); i = j + 1; continue;
    }
    if (ID_START.test(c)) {
      const segs = [mergeDirs(readIdent())];
      while (s[i] === '.' && (ID_CHAR.test(s[i + 1] || '') || s[i + 1] === '*')) {
        i++;
        if (s[i] === '*') { segs.push('*'); i++; } else segs.push(mergeDirs(readIdent()));
      }
      out.push({ t: 'path', segs, glued: s[i] === '[', call: s[i] === '(' });
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['>=', '<=', '==', '!='].includes(two)) { out.push({ t: two }); i += 2; continue; }
    if ('+-*/%(),;[]<>|&'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new S3DError(`无法识别的字符 “${c}”`, line);
  }
  return out;
}

export function parseValue(str, line) {
  const toks = exprTokens(str, line);
  let p = 0, randOrd = 0;
  const err = (m) => new S3DError(`${m}：${str}`, line);
  const eat = (t) => (toks[p] && toks[p].t === t ? (p++, true) : false);
  const expect = (t) => { if (!eat(t)) throw err(`缺少 “${t}”`); };
  const KW = new Set(['where', 'and', 'or', 'not']);
  const isKw = (w) => toks[p] && toks[p].t === 'path' && toks[p].segs.length === 1 && toks[p].segs[0] === w && !toks[p].glued && !toks[p].call;
  const tuple = () => {
    const items = [item()];
    while (eat(',')) items.push(item());
    return items.length === 1 ? items[0] : { k: 'vec', items };
  };
  // 优先级（低→高）：where < or/| < and/& < not < 比较 < 加减 < 乘除 < 一元 < 基本项
  const item = () => {
    let a = orE();
    if (isKw('where')) { p++; a = { k: 'where', a, pred: orE() }; }
    return a;
  };
  const orE = () => {
    let a = andE();
    while (eat('|') || (isKw('or') && ++p)) a = { k: 'or', a, b: andE() };
    return a;
  };
  const andE = () => {
    let a = notE();
    while (eat('&') || (isKw('and') && ++p)) a = { k: 'and', a, b: notE() };
    return a;
  };
  const notE = () => (isKw('not') && ++p ? { k: 'not', a: notE() } : cmpE());
  const cmpE = () => {
    const a = expr();
    for (const op of ['>=', '<=', '==', '!=', '>', '<']) if (eat(op)) return { k: 'cmp', op, a, b: expr() };
    return a;
  };
  const expr = () => {
    let a = term();
    for (;;) {
      if (eat('+')) a = { k: 'bin', op: '+', a, b: term() };
      else if (eat('-')) a = { k: 'bin', op: '-', a, b: term() };
      else return a;
    }
  };
  const term = () => {
    let a = unary();
    for (;;) {
      if (eat('*')) a = { k: 'bin', op: '*', a, b: unary() };
      else if (eat('/')) a = { k: 'bin', op: '/', a, b: unary() };
      else if (eat('%')) a = { k: 'bin', op: '%', a, b: unary() };
      else return a;
    }
  };
  const unary = () => (eat('-') ? { k: 'neg', a: unary() } : eat('+') ? unary() : primary());
  const primary = () => {
    const t = toks[p++];
    if (!t) throw err('表达式不完整');
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'hash') return { k: 'hash', v: t.v };
    if (t.t === 'path') {
      if (t.segs.length === 1 && KW.has(t.segs[0])) throw err(`关键字 ${t.segs[0]} 用错了位置`);
      if (t.call) {
        if (t.segs.length !== 1) throw err('函数名不能带路径');
        p++;
        const args = [];
        if (!eat(')')) { args.push(item()); while (eat(',')) args.push(item()); expect(')'); }
        return { k: 'call', name: t.segs[0], args, ord: RANDOM_FNS.has(t.segs[0]) ? randOrd++ : 0 };
      }
      const node = { k: 'path', segs: t.segs };
      if (t.glued) { p++; node.coords = tuple(); expect(']'); }
      return node;
    }
    if (t.t === '(') { const v = tuple(); expect(')'); return v; }
    if (t.t === '[') {
      const items = [tuple()];
      while (eat(';')) items.push(tuple());
      expect(']');
      return { k: 'list', items };
    }
    throw err(`意外的 “${t.t}”`);
  };
  const v = tuple();
  if (p < toks.length) throw err('多余的内容');
  return v;
}

// 顶层逗号切分（用于 def 参数表）
function splitTop(s, sep) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of s) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function splitProp(word) {
  let depth = 0;
  for (let i = 0; i < word.length; i++) {
    const c = word[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === '=' && depth === 0) return [word.slice(0, i), word.slice(i + 1)];
  }
  return null;
}

// ───────────────────────── 语法：语句树 ─────────────────────────

function parseProgram(src, errors) {
  const toks = lexStatements(src);
  let p = 0;
  const block = (closing) => {
    const stmts = [];
    while (p < toks.length) {
      const t = toks[p];
      if (t.t === 'nl') { p++; continue; }
      if (t.t === '}') {
        p++;
        if (closing) return stmts;
        errors.push(new S3DError('多余的 “}”', t.line));
        continue;
      }
      if (t.t === '{') { errors.push(new S3DError('“{” 前缺少语句', t.line)); p++; continue; }
      const words = [];
      while (p < toks.length && toks[p].t === 'word') words.push(toks[p++]);
      // pattern 的块里是约束，不是语句：按行原样收集
      if (words[0] && words[0].v === 'pattern' && toks[p] && toks[p].t === '{') {
        p++;
        const lines = [];
        let cur = [];
        const flush = () => { if (cur.length) lines.push({ text: cur.map((w) => w.v).join(' '), line: cur[0].line }); cur = []; };
        while (p < toks.length && toks[p].t !== '}') { const t = toks[p++]; if (t.t === 'nl') flush(); else if (t.t === 'word') cur.push(t); }
        flush();
        if (toks[p] && toks[p].t === '}') p++; else errors.push(new S3DError('pattern 缺少 “}”', words[0].line));
        try { stmts.push(makePattern(words, lines)); } catch (e) { errors.push(e); }
        continue;
      }
      let children = [];
      if (toks[p] && toks[p].t === '{') { p++; children = block(true); }
      try {
        const st = makeStmt(words, children);
        if (st.kind === 'else') {
          // 接到前一个 if（或 else if 链的末端）上
          let target = stmts[stmts.length - 1];
          if (!target || target.kind !== 'if') throw new S3DError('else 前面要有 if', st.line);
          while (target.elseBody && target.elseBody.length === 1 && target.elseBody[0].kind === 'if' && target.elseBody[0].chained) target = target.elseBody[0];
          if (target.elseBody) throw new S3DError('一个 if 只能有一个 else', st.line);
          target.elseBody = st.body;
        } else stmts.push(st);
      } catch (e) { errors.push(e); }
    }
    if (closing) errors.push(new S3DError('缺少 “}”', toks[toks.length - 1].line));
    return stmts;
  };
  return block(false);
}

function makeStmt(words, children) {
  const line = words[0].line;
  const kind = words[0].v;
  if (kind === 'def') {
    const sig = words.slice(1).map((w) => w.v).join('');
    const m = /^([\p{L}_][\p{L}\p{N}_]*)(?:\((.*)\))?$/u.exec(sig);
    if (!m) throw new S3DError(`def 语法应为 def 名字(参数=默认值, ...) { ... }`, line);
    const params = new Map();
    for (const part of splitTop(m[2] || '', ',')) {
      const kv = splitProp(part);
      if (kv) params.set(kv[0].trim(), parseValue(kv[1], line));
      else params.set(part, null);
    }
    return { kind: 'def', name: m[1], params, body: children, line };
  }
  if (kind === 'if') {
    if (words.length < 2) throw new S3DError('if 写成：if 条件 { … } else { … }', line);
    return { kind, cond: parseValue(words.slice(1).map((w) => w.v).join(' '), line), children, line };
  }
  if (kind === 'else') {
    if (words.length > 1) {
      if (words[1].v !== 'if' || words.length < 3) throw new S3DError('写成 else { … } 或 else if 条件 { … }', line);
      return { kind, line, body: [{ kind: 'if', chained: true, cond: parseValue(words.slice(2).map((w) => w.v).join(' '), line), children, line }] };
    }
    return { kind, line, body: children };
  }
  if (kind === 'variant') {
    // variant 集合 use=模板 参数=…：把集合里每个对象的外观换成这个模板，外包络不变
    if (words.length < 3) throw new S3DError('variant 写成：variant 集合 use=模板 参数=…', line);
    const params = new Map();
    let use = null;
    for (const w of words.slice(2)) {
      const kv = splitProp(w.v);
      if (!kv) throw new S3DError(`variant 只接受 key=value，看不懂 “${w.v}”`, w.line);
      if (kv[0] === 'use') use = kv[1]; else params.set(kv[0], parseValue(kv[1], w.line));
    }
    if (!use) throw new S3DError('variant 需要 use=模板名', line);
    return { kind, sel: parseValue(words[1].v, line), src: words[1].v, use, params, line };
  }
  if (kind === 'let' || kind === 'concept') {
    const text = words.slice(1).map((w) => w.v).join(' ');
    const m = /^([\p{L}_][\p{L}\p{N}_]*)\s*=\s*([\s\S]+)$/u.exec(text);
    if (!m) throw new S3DError(`${kind} 写成：${kind} 名字 = 表达式`, line);
    if (children.length) throw new S3DError(`${kind} 不能带 { }`, line);
    return { kind, name: m[1], ast: parseValue(m[2], line), src: m[2], line };
  }
  if (kind === 'check') {
    let text = words.slice(1).map((w) => w.v).join(' ');
    const q = /^"([^"]*)"\s*/.exec(text);
    const msg = q ? q[1] : null;
    if (q) text = text.slice(q[0].length);
    if (!text.trim()) throw new S3DError('check 写成：check "说明" 表达式（集合为空或条件为真即通过）', line);
    return { kind, msg, ast: parseValue(text, line), src: text, line };
  }
  if (kind === 'style') {
    if (words.length < 3) throw new S3DError('style 写成：style 集合 mat=… / color=…', line);
    const props = new Map();
    for (const w of words.slice(2)) {
      const kv = splitProp(w.v);
      if (!kv) throw new S3DError(`style 只接受 key=value，看不懂 “${w.v}”`, w.line);
      props.set(kv[0], parseValue(kv[1], w.line));
    }
    return { kind, sel: parseValue(words[1].v, line), src: words[1].v, props, line };
  }
  const st = { kind, id: null, props: new Map(), tags: [], children, line };
  for (const w of words.slice(1)) {
    const kv = splitProp(w.v);
    if (kv) {
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(kv[0])) throw new S3DError(`属性名不合法：${kv[0]}`, w.line);
      st.props.set(kv[0], parseValue(kv[1], w.line));
    } else if (w.v.startsWith('#')) st.tags.push(w.v.slice(1));
    else if (!st.id) {
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(w.v)) throw new S3DError(`名字不合法：${w.v}`, w.line);
      st.id = w.v;
    } else throw new S3DError(`无法理解 “${w.v}”（属性要写成 key=value）`, w.line);
  }
  return st;
}

// pattern 名字(角色, 集合角色*, …) { 角色 in 集合 / 甲 关系 乙 / 布尔表达式 }
function makePattern(words, lines) {
  const line = words[0].line;
  const sig = words.slice(1).map((w) => w.v).join('');
  const m = /^([\p{L}_][\p{L}\p{N}_]*)\((.*)\)$/u.exec(sig);
  if (!m) throw new S3DError('pattern 写成：pattern 名字(角色, 集合角色*, …) { 约束 }', line);
  const roles = splitTop(m[2], ',').map((r) => {
    const mm = /^([\p{L}_][\p{L}\p{N}_]*)(\*)?$/u.exec(r);
    if (!mm) throw new S3DError(`角色名不合法：${r}`, line);
    return { name: mm[1], set: !!mm[2] };
  });
  if (!roles.length) throw new S3DError('pattern 至少要有一个角色', line);
  const names = new Set(roles.map((r) => r.name));
  const constraints = lines.map(({ text, line: ln }) => {
    let mm = /^([\p{L}_][\p{L}\p{N}_]*)\s+in\s+([\s\S]+)$/u.exec(text);
    if (mm) {
      if (!names.has(mm[1])) throw new S3DError(`${mm[1]} 不是这个 pattern 的角色`, ln);
      return { k: 'in', role: mm[1], ast: parseValue(mm[2], ln), line: ln };
    }
    mm = new RegExp(`^(\\S+)\\s+(${['on', 'supports', 'against', 'inside', 'contains', 'touching'].join('|')})\\s+(\\S+)$`).exec(text);
    if (mm) return { k: 'rel', a: parseValue(mm[1], ln), rel: mm[2], b: parseValue(mm[3], ln), line: ln };
    return { k: 'expr', ast: parseValue(text, ln), line: ln };
  });
  return { kind: 'pattern', name: m[1], roles, constraints, line };
}

// ───────────────────────── 作用域 ─────────────────────────

class Env {
  constructor(parent, vars = {}) {
    this.parent = parent;
    this.vars = new Map(Object.entries(vars).map(([k, v]) => [k, { v }]));
  }
  // scope：名字查找从哪个节点的子物体开始；frame：坐标分量在哪个坐标系里取
  setThunk(name, ast, env, node, scope = null, frame = null) { this.vars.set(name, { ast, env, node, scope, frame }); }
  setLazy(name, fn) { this.vars.set(name, { fn }); }
  lookup(name, S) {
    for (let e = this; e; e = e.parent) {
      const slot = e.vars.get(name);
      if (!slot) continue;
      if ('v' in slot) return slot;
      if (slot.fn) {
        if (slot.busy) throw new S3DError(`${name} 循环引用了自己`);
        slot.busy = true;
        try { slot.v = slot.fn(); } finally { slot.busy = false; }
        return slot;
      }
      if (slot.busy) throw new S3DError(`${name} 循环引用了自己`);
      slot.busy = true;
      let v;
      try { v = evalAst(slot.ast, { env: slot.env, node: slot.node, scope: slot.scope, frame: slot.frame, prop: name, S }); }
      finally { slot.busy = false; }
      // 展开阶段（S 为空）无法解析对象引用，结果不缓存
      if (S) slot.v = v;
      return { v };
    }
    return null;
  }
}

// ───────────────────────── 节点 ─────────────────────────

class Node {
  constructor(kind, id, props, tags, line, env, parent) {
    Object.assign(this, { kind, id, props, tags, line, env, parent, children: [] });
    if (parent) {
      parent.children.push(this);
      const idx = parent.children.length - 1;
      const seg = id ?? `${kind}#${idx}`;
      this.path = parent.kind === 'root' ? seg : `${parent.path}.${seg}`;
    } else this.path = '';
  }
  childById(id) {
    for (const c of this.children) if (c.id === id) return c;
    for (const c of this.children) if (!c.id && c.children.length) { const r = c.childById(id); if (r) return r; }
    return null;
  }
  isAncestorOf(n) { for (let a = n.parent; a; a = a.parent) if (a === this) return true; return false; }
}

// ───────────────────────── 求值 ─────────────────────────

const isRef = (v) => v && typeof v === 'object' && v.ref === true;
// 集合：一组对象（有序、不重复）。它是逻辑上的归类，不像 group 那样带坐标系
class NodeSet { constructor(nodes) { this.nodes = [...new Set(nodes)]; } }
const isSet = (v) => v instanceof NodeSet;
function asSet(v) {
  if (isSet(v)) return v;
  if (v instanceof PatternValue) return v.all();
  if (isRef(v)) return new NodeSet(v.node.isSet ? v.node.members : [v.node]);
  if (v && v.list) return new NodeSet(v.list.flatMap((x) => asSet(x).nodes));
  throw new S3DError(`需要集合（对象、#标签、kind(…)、列表…），得到 ${show(v)}`);
}
class PatternValue {
  constructor(name, roles, matches) { Object.assign(this, { name, roles, matches }); }
  role(r) { return new NodeSet(this.matches.flatMap((m) => { const v = m.get(r); return isSet(v) ? v.nodes : [v]; })); }
  all() { return new NodeSet(this.roles.flatMap((r) => this.role(r.name).nodes)); }
}
const setLike = (v) => isSet(v) || isRef(v) || (v && v.list) || v instanceof PatternValue;
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (setLike(v)) return asSet(v).nodes.length > 0;
  if (v === 'true' || v === 'false') return v === 'true';
  throw new S3DError(`需要真假值，得到 ${show(v)}`);
}
const mkRef = (node, anchor = null, offset = [0, 0, 0]) => ({ ref: true, node, anchor, offset });
const truthy = (v) => v === true || v === 'true' || v === 1;

function arith(op, a, b) {
  const isV = Array.isArray;
  if (isRef(a) && isV(b) && (op === '+' || op === '-')) return mkRef(a.node, a.anchor, op === '+' ? add(a.offset, b) : sub(a.offset, b));
  if (typeof a === 'number' && typeof b === 'number') {
    switch (op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return a / b; case '%': return ((a % b) + b) % b; }
  }
  if (isV(a) && isV(b) && a.length === b.length && (op === '+' || op === '-')) return a.map((x, k) => (op === '+' ? x + b[k] : x - b[k]));
  if (op === '-' && setLike(a) && setLike(b)) { const drop = new Set(asSet(b).nodes); return new NodeSet(asSet(a).nodes.filter((n) => !drop.has(n))); }
  if (isV(a) && typeof b === 'number' && (op === '*' || op === '/')) return a.map((x) => (op === '*' ? x * b : x / b));
  if (typeof a === 'number' && isV(b) && op === '*') return b.map((x) => x * a);
  throw new S3DError(`无法计算 ${show(a)} ${op} ${show(b)}`);
}
const show = (v) => (isSet(v) ? `{${v.nodes.length} 个对象}` : isRef(v) ? v.node.path : Array.isArray(v) ? `(${v.join(',')})` : String(v));

function evalAst(ast, ctx) {
  switch (ast.k) {
    case 'num': return ast.v;
    case 'str': return ast.v;
    case 'neg': { const v = evalAst(ast.a, ctx); return typeof v === 'number' ? -v : Array.isArray(v) ? v.map((x) => -x) : arith('*', -1, v); }
    case 'bin': return arith(ast.op, evalAst(ast.a, ctx), evalAst(ast.b, ctx));
    case 'vec': return ast.items.map((x) => {
      const v = evalAst(x, ctx);
      if (typeof v !== 'number') throw new S3DError(`向量分量必须是数字，得到 ${show(v)}`);
      return v;
    });
    case 'list': return { list: ast.items.map((x) => evalAst(x, ctx)) };
    case 'path': return evalPath(ast, ctx);
    case 'hash': {
      if (!ctx.S) return '#' + ast.v;
      const idx = ctx.S.tagIndex();
      if (idx.has(ast.v)) return new NodeSet(idx.get(ast.v));
      if (/^[0-9a-f]+$/i.test(ast.v) && [3, 4, 6, 8].includes(ast.v.length)) return '#' + ast.v;
      return new NodeSet([]);
    }
    case 'or': case 'and': {
      const a = evalAst(ast.a, ctx), b = evalAst(ast.b, ctx);
      if (setLike(a) || setLike(b)) {
        const A = asSet(a).nodes, B = asSet(b).nodes;
        if (ast.k === 'or') return new NodeSet([...A, ...B]);
        const keep = new Set(B);
        return new NodeSet(A.filter((n) => keep.has(n)));
      }
      return ast.k === 'or' ? asBool(a) || asBool(b) : asBool(a) && asBool(b);
    }
    case 'not': return !asBool(evalAst(ast.a, ctx));
    case 'cmp': {
      const a = evalAst(ast.a, ctx), b = evalAst(ast.b, ctx);
      if (ast.op === '==') return same(a, b);
      if (ast.op === '!=') return !same(a, b);
      if (typeof a !== 'number' || typeof b !== 'number') throw new S3DError(`${ast.op} 两边需要数字，得到 ${show(a)} 和 ${show(b)}`);
      return { '>': a > b, '<': a < b, '>=': a >= b, '<=': a <= b }[ast.op];
    }
    case 'where': {
      // 对集合里的每个成员求条件；条件里可以用 w h d（自身尺寸）、x y z（世界中心）、kind、name、it
      const base = asSet(evalAst(ast.a, ctx));
      if (!ctx.S) throw new S3DError('where 只能在求解阶段使用');
      return new NodeSet(base.nodes.filter((m) => {
        const env = new Env(ctx.env);
        const size = () => { const b = ctx.S.box(m); return sub(b.max, b.min); };
        const ctr = () => { const b = ctx.S.worldBox(m); return scl(add(b.min, b.max), 0.5); };
        ['w', 'h', 'd'].forEach((k, i) => env.setLazy(k, () => size()[i]));
        ['x', 'y', 'z'].forEach((k, i) => env.setLazy(k, () => ctr()[i]));
        env.setLazy('kind', () => m.template ?? K(m));
        env.setLazy('name', () => m.id ?? '');
        env.setLazy('it', () => mkRef(m));
        return asBool(evalAst(ast.pred, { ...ctx, env }));
      }));
    }
    case 'call': return evalCall(ast, ctx);
  }
  throw new S3DError('未知表达式');
}

// 相等：对象比的是指向哪个对象，集合比的是成员
function same(a, b) {
  if (isRef(a) && isRef(b)) return a.node === b.node;
  if (setLike(a) && setLike(b)) { const A = asSet(a).nodes, B = new Set(asSet(b).nodes); return A.length === B.size && A.every((n) => B.has(n)); }
  return a === b;
}

// 确定性随机数：rand = hash(种子, 调用位置, 键)。没有时间和状态，同样的源码永远得到同样的场景
function hash01(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0) * 2 ** 21 + (h1 >>> 11)) / 2 ** 53;
}
function randomOf(ast, ctx, keys) {
  const seedSlot = ctx.env.lookup('seed', ctx.S);
  const seed = seedSlot ? seedSlot.v : 0;
  // 调用位置 = 所在对象的路径 + 属性名 + 这是该表达式里第几个随机调用，所以同一行的两个 rand() 互不相同
  const site = `${ctx.node ? ctx.node.path : ''}|${ctx.prop ?? ''}|${ast.ord}`;
  return hash01(`${seed}|${site}|${keys.map((k) => (isRef(k) ? k.node.path : String(k))).join(',')}`);
}

const MATH = {
  sin: (a) => Math.sin(rad(a)), cos: (a) => Math.cos(rad(a)), tan: (a) => Math.tan(rad(a)),
  asin: (x) => (Math.asin(x) * 180) / Math.PI, acos: (x) => (Math.acos(x) * 180) / Math.PI, atan: (x) => (Math.atan(x) * 180) / Math.PI,
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, pow: Math.pow,
};
// 由求解后的空间事实定义的集合：on(S) = 立在 S 上的；supports(S) = 承托着 S 的；……
const RELATIONS = ['on', 'supports', 'against', 'inside', 'contains', 'touching', 'intersects'];

function evalCall(ast, ctx) {
  const { name, args } = ast;
  const S = ctx.S;
  const val = (i) => evalAst(args[i], ctx);
  // kind(box) / tag(wall) 的参数是名字本身，不当对象解析
  const names = () => args.map((a) => {
    if (a.k === 'path' && a.segs.length === 1) return a.segs[0];
    if (a.k === 'str') return a.v;
    throw new S3DError(`${name}() 的参数要写名字，如 ${name}(box)`);
  });
  if (name === 'if') {
    // 编译期的选择：只求值被选中的那个分支
    if (args.length !== 3) throw new S3DError('if 写成 if(条件, 是, 否)');
    return asBool(val(0)) ? val(1) : val(2);
  }
  if (name === 'rand') return randomOf(ast, ctx, args.map((_, i) => val(i)));
  if (name === 'uniform') {
    if (args.length < 2) throw new S3DError('uniform 写成 uniform(最小, 最大, 可选的键…)');
    const lo = val(0), hi = val(1);
    return lo + (hi - lo) * randomOf(ast, ctx, args.slice(2).map((_, i) => val(i + 2)));
  }
  if (name === 'choose') {
    if (!args.length) throw new S3DError('choose 写成 choose(甲, 乙, 丙…)');
    return val(Math.floor(randomOf(ast, ctx, []) * args.length));
  }
  if (name in MATH) {
    const xs = args.map((_, i) => val(i));
    if (xs.some((x) => typeof x !== 'number')) throw new S3DError(`${name}() 需要数字参数`);
    return MATH[name](...xs);
  }
  if (name === 'count') { const v = val(0); return v instanceof PatternValue ? v.matches.length : asSet(v).nodes.length; }
  if (!S) throw new S3DError(`${name}() 只能在求解阶段使用`);
  switch (name) {
    case 'all': return new NodeSet(S.allNodes());
    case 'kind': { const ks = new Set(names()); return new NodeSet(S.allNodes().filter((n) => ks.has(K(n)) || ks.has(n.template))); }
    case 'tag': { const idx = S.tagIndex(); return new NodeSet(names().flatMap((t) => idx.get(t) ?? [])); }
    case 'children': return new NodeSet(asSet(val(0)).nodes.flatMap((n) => n.children));
    case 'descendants': {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
      asSet(val(0)).nodes.forEach(walk);
      return new NodeSet(out);
    }
  }
  if (RELATIONS.includes(name)) {
    if (!args.length) throw new S3DError(`${name}() 需要参照集合，如 ${name}(ground)`);
    const k = args.length > 1 ? val(1) : 1;
    if (typeof k !== 'number') throw new S3DError(`${name}() 的第二个参数是数量`);
    return S.relSet(name, asSet(val(0)), k);
  }
  throw new S3DError(`未知函数 ${name}()`);
}

function coord(ref, axis, ctx) {
  if (!ctx.S) throw new S3DError('坐标分量只能在求解阶段使用');
  const F = ctx.frame ?? ctx.node.parent ?? ctx.node;
  return ctx.S.anchorIn(ref, F, DIRS.center).q['xyz'.indexOf(axis)];
}

function evalPath(ast, ctx) {
  const [first, ...rest] = ast.segs;
  let base, restSegs;
  const slot = ctx.env.lookup(first, ctx.S);
  if (ast.segs.includes('*')) {
    // 路径通配：tanks.*.tank → 集合
    if (ast.coords) throw new S3DError('通配路径后面不能取锚点');
    let cur;
    if (slot) cur = asSet(slot.v).nodes;
    else {
      const r = ctx.S && ctx.S.find([first], ctx.node, ctx.scope);
      if (!r) throw new S3DError(`找不到对象 ${first}`);
      cur = [r.node];
    }
    for (const seg of rest) cur = seg === '*' ? cur.flatMap((n) => n.children) : cur.map((n) => n.childById(seg)).filter(Boolean);
    return new NodeSet(cur);
  }
  if (slot) {
    const v = slot.v;
    if (!rest.length && !ast.coords) return v;
    if (v instanceof PatternValue) {
      if (rest.length === 1 && v.roles.some((r) => r.name === rest[0])) return v.role(rest[0]);
      throw new S3DError(`模式 ${first} 没有角色 ${rest.join('.')}（有：${v.roles.map((r) => r.name).join('、')}）`);
    }
    if (isSet(v)) { base = ctx.S.setNode(v); restSegs = rest; } // 集合的锚点 = 成员总包围盒的锚点
    else {
      if (!isRef(v)) throw new S3DError(`${first} 不是对象，不能取 .${rest.join('.')}`);
      base = v.node; restSegs = rest;
      while (restSegs.length) { const c = base.childById(restSegs[0]); if (!c) break; base = c; restSegs = restSegs.slice(1); }
    }
  } else {
    const r = ctx.S ? ctx.S.find(ast.segs, ctx.node, ctx.scope) : null;
    if (!r) {
      if (ast.segs.length === 1 && !ast.coords) return first; // 符号：left / steel / x / true ...
      throw new S3DError(`找不到对象 ${ast.segs.join('.')}`);
    }
    base = r.node; restSegs = r.rest;
  }
  if (ast.coords) {
    if (restSegs.length) throw new S3DError(`${base.path} 中没有 “${restSegs.join('.')}”`);
    const c = evalAst(ast.coords, ctx);
    if (typeof c === 'number') return mkRef(base, { t: c }); // 曲线上按弧长的参数位置
    if (!Array.isArray(c) || c.length !== 3) throw new S3DError('锚点写成 名字[u,v,w]（包围盒内 -1..1），曲线上的点写成 名字[t]（0..1）');
    return mkRef(base, c);
  }
  if (!restSegs.length) return mkRef(base);
  if (restSegs.length === 1) {
    const s = restSegs[0];
    if (MEASURES.has(s)) {
      const b = ctx.S.box(base);
      return { w: b.max[0] - b.min[0], h: b.max[1] - b.min[1], d: b.max[2] - b.min[2] }[s];
    }
    if (s === 'origin') return mkRef(base, 'origin');
    if (s in CURVE_POINTS && CURVES.has(K(base))) return mkRef(base, { t: CURVE_POINTS[s] });
    if (s in AXES) return coord(mkRef(base, DIRS.center), s, ctx);
    const dv = dirWord(s);
    if (dv) return mkRef(base, dv);
  }
  // B.top.y：锚点在“当前物体的父坐标系”中的某个坐标分量
  if (restSegs.length === 2 && restSegs[1] in AXES) {
    const [a] = restSegs;
    const anchor = a === 'origin' ? 'origin' : a in CURVE_POINTS && CURVES.has(K(base)) ? { t: CURVE_POINTS[a] } : dirWord(a);
    if (anchor) return coord(mkRef(base, anchor), restSegs[1], ctx);
  }
  throw new S3DError(`${base.path || '场景'} 中没有子对象或锚点 “${restSegs.join('.')}”`);
}

// ───────────────────────── 展开：模板与阵列 ─────────────────────────

function elaborate(program, errors) {
  const defs = new Map(), materials = new Map();
  const globals = new Env(null);
  // 语义作用域：概念只在 concept / style / check 里可见，不会和几何里的对象名冲突
  const semantic = new Env(globals);
  const root = new Node('root', null, new Map(), [], 0, globals, null);
  const flat = [];
  const evalStatic = (ast, env, node) => evalAst(ast, { env, node, S: null });
  const concepts = [], checks = [], styles = [], pending = [], patterns = [], variants = [];

  for (const s of program) {
    if (s.kind === 'def') defs.set(s.name, s);
    else if (s.kind === 'concept') {
      // 概念就是一个全局命名的集合，通常依赖空间事实，所以在求解之后才求值
      semantic.setThunk(s.name, s.ast, semantic, root, root, root);
      concepts.push(s);
    } else if (s.kind === 'pattern') patterns.push(s);
    else if (s.kind === 'variant') variants.push(s);
    else if (s.kind === 'check') checks.push(s);
    else if (s.kind === 'style') styles.push(s);
    else if (s.kind === 'material') {
      if (!s.id) { errors.push(new S3DError('material 需要名字', s.line)); continue; }
      const m = {};
      for (const [k, ast] of s.props) {
        try { m[k] = evalStatic(ast, globals, root); } catch (e) { e.line ??= s.line; errors.push(e); }
      }
      materials.set(s.id, m);
    }
  }

  const walk = (stmts, parent, env, depth) => {
    // let 在所在块内整体可见（惰性求值，与书写顺序无关）
    const lets = stmts.filter((s) => s.kind === 'let');
    if (lets.length) {
      // 最外层的 let 放进全局作用域，模板体里也能用；其余的块各有自己的作用域
      if (parent.kind !== 'root') env = new Env(env);
      for (const s of lets) env.setThunk(s.name, s.ast, env, parent, parent, parent);
    }
    for (const s of stmts) {
      try { one(s, parent, env, depth); } catch (e) { e.line ??= s.line; errors.push(e); }
    }
  };
  const one = (s, parent, env, depth) => {
    if (s.kind === 'material' || s.kind === 'let') return;
    if (s.kind === 'if') {
      // 编译期分支：条件必须在展开时就能确定（参数、变量、下标、随机数）
      let c;
      try { c = asBool(evalStatic(s.cond, env, parent)); }
      catch (e) { throw new S3DError(`if 的条件要在展开时就能确定（参数、let、阵列下标、随机数），${e.message}`, s.line); }
      walk(c ? s.children : s.elseBody ?? [], parent, env, depth);
      return;
    }
    if (['def', 'concept', 'check', 'style', 'pattern', 'variant'].includes(s.kind)) {
      if (parent.kind !== 'root') throw new S3DError(`${s.kind} 只能写在最外层`, s.line);
      return;
    }
    if (KIND_PROPS[s.kind]) {
      const allowed = new Set([...KIND_PROPS[s.kind], ...PLACEMENT]);
      for (const k of s.props.keys()) if (!allowed.has(k)) errors.push(new S3DError(`${s.kind} 没有属性 ${k}`, s.line));
      const n = new Node(s.kind, s.id, s.props, s.tags, s.line, env, parent);
      flat.push(n);
      if ((LEAVES.has(s.kind) || CURVES.has(s.kind)) && s.children.length) throw new S3DError(`${s.kind} 不能有子语句`, s.line);
      if (COPIES.has(s.kind) && s.props.has('of') && s.children.length) throw new S3DError(`${s.kind} 写了 of= 就是复制已有对象，不能再有子语句`, s.line);
      if (s.kind === 'repeat' && s.props.has('over')) {
        // 对集合的每个成员各做一次：要等整棵树建好、知道有哪些成员之后才能展开
        pending.push({ n, s, env, depth });
        return;
      }
      if (s.kind === 'repeat') {
        const cnt = s.props.has('n') ? evalStatic(s.props.get('n'), env, n) : 1;
        const dims = Array.isArray(cnt) ? cnt.map((x) => Math.max(0, Math.round(x))) : [Math.max(0, Math.round(cnt))];
        if (dims.some((x) => !Number.isFinite(x))) throw new S3DError('repeat 的 n 必须是常量', s.line);
        const total = dims.reduce((a, b) => a * b, 1);
        if (total > 5000) throw new S3DError(`repeat 数量过多（${total}）`, s.line);
        const [ni, nj = 1, nk = 1] = dims;
        let flatIdx = 0;
        for (let k = 0; k < nk; k++) for (let j = 0; j < nj; j++) for (let i = 0; i < ni; i++) {
          const inst = new Node('group', String(flatIdx), new Map(), [], s.line, env, n);
          inst.inst = { index: [i, j, k], flat: flatIdx, grid: dims.length > 1 };
          flat.push(inst);
          walk(s.children, inst, new Env(env, { i, j, k, idx: flatIdx }), depth);
          flatIdx++;
        }
        n.counts = dims;
        n.total = total;
      } else walk(s.children, n, env, depth);
      return;
    }
    const def = defs.get(s.kind);
    if (!def) throw new S3DError(`未知的类型 “${s.kind}”`, s.line);
    if (depth > 32) throw new S3DError(`模板 ${s.kind} 递归过深`, s.line);
    // 模板自己声明了的参数优先于同名的定位关键字（例如模板可以有自己的 gap、turn 参数）
    const isPlacement = (k) => PLACEMENT.has(k) && !def.params.has(k);
    const own = new Map([...s.props].filter(([k]) => isPlacement(k)));
    const n = new Node('group', s.id, own, s.tags, s.line, env, parent);
    n.template = s.kind;
    flat.push(n);
    const body = new Env(globals);
    for (const [k, ast] of s.props) {
      if (isPlacement(k)) continue;
      if (!def.params.has(k)) errors.push(new S3DError(`模板 ${s.kind} 没有参数 ${k}`, s.line));
      body.setThunk(k, ast, env, n);
    }
    for (const [k, ast] of def.params) {
      if (body.vars.has(k)) continue;
      if (!ast) throw new S3DError(`模板 ${s.kind} 缺少参数 ${k}`, s.line);
      body.setThunk(k, ast, body, n);
    }
    walk(def.body, n, body, depth + 1);
  };
  walk(program, root, globals, 0);
  return { root, flat, defs, materials, globals, semantic, concepts, checks, styles, pending, patterns, variants, walk };
}

// ───────────────────────── 复制关系：镜像与旋转 ─────────────────────────
// 副本是“影子节点”：结构与原物体相同、名字相同（可以用路径引用），
// 局部变换与包围盒直接取自原物体，所以原物体怎么变，副本就怎么变。

function buildCopies(root, flat, S, errors) {
  const shadow = (src, parent) => {
    const g = new Node(K(src), src.id, new Map(), src.tags, src.line, src.env, parent);
    g.ghostOf = src;
    flat.push(g);
    for (const c of src.children) shadow(c, g);
    return g;
  };
  const state = new Map();
  const ensure = (n) => {
    if (state.get(n) === 'done') return;
    if (state.get(n) === 'busy') throw new S3DError(`复制关系形成循环：${n.path}`, n.line, n);
    state.set(n, 'busy');
    for (const c of [...n.children]) ensure(c);
    if (COPIES.has(n.kind) && !n.ghostOf) {
      if (n.props.has('of')) {
        const ast = n.props.get('of');
        if (ast.k !== 'path' || ast.coords) throw new S3DError(`${n.path}：of 需要写一个对象名`, n.line, n);
        const r = S.find(ast.segs, n);
        if (!r || r.rest.length) throw new S3DError(`${n.path}：找不到要复制的对象 ${ast.segs.join('.')}`, n.line, n);
        const src = r.node;
        if (src === n || src.isAncestorOf(n)) throw new S3DError(`${n.path} 不能复制包含自己的对象`, n.line, n);
        ensure(src);
        n.src = src;
        n.asKind = K(src);
        for (const c of src.children) shadow(c, n);
      } else {
        const originals = [...n.children];
        let count = 1;
        if (n.kind === 'rotate') count = Math.round(S.num(n, 'n', 1));
        if (!(count >= 1 && count <= 360)) throw new S3DError(`${n.path}：rotate 的 n 需要 1..360`, n.line, n);
        for (let k = 1; k <= count; k++) {
          const G = new Node('group', n.kind === 'mirror' ? 'mirrored' : `r${k}`, new Map(), [], n.line, n.env, n);
          G.copyOf = { container: n, k };
          flat.push(G);
          for (const c of originals) shadow(c, G);
        }
      }
    }
    state.set(n, 'done');
  };
  try { ensure(root); } catch (e) { errors.push(e); }
}

// ───────────────────────── 求解 ─────────────────────────

// 集合作为参照物时的“虚拟对象”：坐标系与世界对齐，包围盒是所有成员的总包围盒
class SetNode {
  constructor(members, root) {
    Object.assign(this, { kind: 'set', isSet: true, members, parent: root, children: [], props: new Map(), tags: [], id: null, line: 0 });
    this.path = `{${members.slice(0, 3).map((m) => m.path).join(', ')}${members.length > 3 ? ` …共 ${members.length} 个` : ''}}`;
  }
  childById() { return null; }
  isAncestorOf() { return false; }
}

class Solver {
  constructor(root, flat) {
    this.root = root;
    this.flat = flat;
    this.sets = new Map();
    this.index = new Map();
    for (const n of flat) if (n.id && !n.inst) {
      if (!this.index.has(n.id)) this.index.set(n.id, []);
      this.index.get(n.id).push(n);
    }
  }

  // 语义层看到的对象：变体（skin）只是外观，不参与集合、概念、模式与检查
  allNodes() { return this.flat.filter((n) => !n.skin); }
  tagIndex() {
    if (this._tags && this._tagsAt === this.flat.length) return this._tags;
    const idx = new Map();
    for (const n of this.flat) if (!n.skin) for (const t of n.tags) { if (!idx.has(t)) idx.set(t, []); idx.get(t).push(n); }
    this._tagsAt = this.flat.length;
    return (this._tags = idx);
  }
  setNode(set) {
    if (!set.nodes.length) throw new S3DError('集合是空的，不能当参照物');
    const key = set.nodes.map((n) => n.path).join('|');
    if (!this.sets.has(key)) this.sets.set(key, new SetNode(set.nodes, this.root));
    return this.sets.get(key);
  }
  // 由空间事实建立关系索引；组也参与：组里任何一个物体满足关系，组就满足
  buildRelations(facts) {
    const byPath = new Map(this.flat.map((n) => [n.path, n]));
    const chain = (n) => { const out = []; for (let a = n; a && a.kind !== 'root'; a = a.parent) out.push(a); return out; };
    const R = Object.fromEntries(RELATIONS.map((r) => [r, new Map()]));
    const put = (rel, x, y) => { if (!R[rel].has(x)) R[rel].set(x, new Set()); R[rel].get(x).add(y); };
    for (const f of facts) {
      const A = byPath.get(f.a), B = byPath.get(f.b);
      if (!A || !B) continue;
      const ca = chain(A), cb = chain(B), common = new Set(ca.filter((x) => cb.includes(x)));
      for (const x of ca) for (const y of cb) {
        if (common.has(x) || common.has(y)) continue;
        if (f.rel === 'on') { put('on', x, y); put('supports', y, x); put('touching', x, y); put('touching', y, x); }
        if (f.rel === 'against') { put('against', x, y); put('against', y, x); put('touching', x, y); put('touching', y, x); }
        if (f.rel === 'inside') { put('inside', x, y); put('contains', y, x); }
        if (f.rel === 'touching') { put('touching', x, y); put('touching', y, x); }
        if (f.rel === 'intersects') { put('intersects', x, y); put('intersects', y, x); put('touching', x, y); put('touching', y, x); }
      }
    }
    this.rel = R;
  }
  relSet(name, set, k = 1) {
    if (!this.rel) throw new S3DError(`${name}() 依赖求解后的空间事实，只能用在 concept / style / check 里，不能用来决定位置`);
    const members = new Set(set.nodes), out = [];
    for (const [x, ys] of this.rel[name]) {
      let c = 0;
      for (const y of ys) if (members.has(y)) c++;
      if (c >= k) out.push(x);
    }
    return new NodeSet(out);
  }

  // 名字查找：从 scope（缺省为当前节点的父级）逐层向外；最后按全局唯一名查找
  find(segs, from, scope = null) {
    const descend = (start, i) => {
      let cur = start, k = i;
      while (k < segs.length) { const c = cur.childById(segs[k]); if (!c) break; cur = c; k++; }
      return { node: cur, rest: segs.slice(k) };
    };
    for (let sc = scope ?? from.parent; sc; sc = sc.parent) {
      const c = sc.childById(segs[0]);
      if (c) return descend(c, 1);
    }
    const cands = this.index.get(segs[0]);
    if (cands && cands.length === 1) return descend(cands[0], 1);
    if (cands && cands.length > 1) throw new S3DError(`名字 ${segs[0]} 不唯一，请写完整路径（${cands.map((c) => c.path).join(' / ')}）`);
    return null;
  }

  memo(n, key, fn) {
    const slot = '_' + key, busy = key + 'Busy';
    if (n[slot] !== undefined) return n[slot];
    if (n[busy]) throw new Cycle(n, key);
    n[busy] = true;
    try { return (n[slot] = fn()); } finally { n[busy] = false; }
  }

  eval(n, key, dflt) {
    if (!n.props.has(key)) return dflt;
    try { return evalAst(n.props.get(key), { env: n.env, node: n, prop: key, S: this }); }
    catch (e) { if (e instanceof S3DError) { e.line ??= n.line; e.node ??= n; e.message = `${n.path} 的 ${key}：${e.message}`; } throw e; }
  }
  num(n, key, dflt) {
    const v = this.eval(n, key, dflt);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new S3DError(`${n.path} 的 ${key} 需要数字`, n.line, n);
    return v;
  }
  vec(n, key, dflt) {
    let v = this.eval(n, key, dflt);
    if (typeof v === 'number') v = [v, v, v];
    if (!Array.isArray(v) || v.length !== 3) throw new S3DError(`${n.path} 的 ${key} 需要三维向量 x,y,z`, n.line, n);
    return v;
  }
  vec2(n, key, dflt) {
    const v = this.eval(n, key, dflt);
    if (!Array.isArray(v) || v.length !== 2) throw new S3DError(`${n.path} 的 ${key} 需要两个数：宽,厚`, n.line, n);
    return v;
  }
  ref(n, key) {
    let v = this.eval(n, key);
    if (typeof v === 'string') throw new S3DError(`${n.path} 的 ${key}：找不到对象 ${v}`, n.line, n);
    if (isSet(v) || (v && v.list && v.list.every(isRef))) {
      const set = asSet(v);
      if (set.nodes.some((m) => m === n || m.isAncestorOf(n) || n.isAncestorOf(m))) throw new S3DError(`${n.path} 的 ${key}：集合里包含它自己或它的上下级`, n.line, n);
      v = mkRef(this.setNode(set));
    }
    if (!isRef(v)) throw new S3DError(`${n.path} 的 ${key} 需要引用一个对象，得到 ${show(v)}`, n.line, n);
    if (v.node === n || n.isAncestorOf(v.node)) throw new S3DError(`${n.path} 不能相对自己定位`, n.line, n);
    return v;
  }
  curveRef(n, key) {
    const r = this.ref(n, key);
    if (!CURVES.has(K(r.node))) throw new S3DError(`${n.path} 的 ${key} 需要一条曲线（line / bezier / spline / arc / helix）`, n.line, n);
    return r;
  }
  sym(n, key, dflt) { const v = this.eval(n, key, dflt); return typeof v === 'string' ? v : dflt; }
  names(n, key) {
    const ast = n.props.get(key);
    const items = ast.k === 'vec' ? ast.items : [ast];
    return items.map((a) => {
      if (a.k !== 'path' || a.segs.length !== 1) throw new S3DError(`${key} 只接受面名，如 left,back`, n.line, n);
      return a.segs[0];
    });
  }
  anchorSpec(n, key) {
    const ast = n.props.get(key);
    if (ast.k === 'path' && ast.segs.length === 1) {
      if (ast.segs[0] === 'origin') return 'origin';
      const d = dirWord(ast.segs[0]);
      if (d) return d;
    }
    return this.vec(n, key);
  }
  points(n, key, F) {
    const v = this.eval(n, key);
    if (!v || !v.list || v.list.length < 2) throw new S3DError(`${n.path} 的 ${key} 至少需要两个点，如 ${key}=[A.top; B.top]`, n.line, n);
    return v.list.map((x) => this.pointOf(x, F, `${n.path} 的 ${key}`));
  }

  // —— 框架变换 ——
  lca(a, b) {
    const seen = new Set();
    for (let x = a; x; x = x.parent) seen.add(x);
    for (let y = b; y; y = y.parent) if (seen.has(y)) return y;
    return this.root;
  }
  toAncestor(n, L) { let T = IDENT; for (let a = n; a !== L; a = a.parent) T = compose(this.local(a), T); return T; }
  // T 的框架相对 F 的框架
  relTo(T, F) { const L = this.lca(T, F); return compose(invT(this.toAncestor(F, L)), this.toAncestor(T, L)); }
  pointIn(T, p, F) { return apply(this.relTo(T, F), p); }
  dirIn(T, d, F) { return applyDir(this.relTo(T, F), d); }
  world(n) { return this.memo(n, 'world', () => (n.parent ? compose(this.world(n.parent), this.local(n)) : IDENT)); }

  anchorLocal(n, a) {
    if (a === 'origin') return { p: [0, 0, 0], nrm: [0, 0, 0] };
    if (a && a.t !== undefined) {
      if (!CURVES.has(K(n))) throw new S3DError(`${n.path} 不是曲线，不能用 [t] 取点`, n.line, n);
      const c = curveAt(this.curve(n), a.t);
      return { p: c.p, nrm: [0, 0, 0], tan: c.tan };
    }
    const b = this.box(n);
    const c = scl(add(b.min, b.max), 0.5), h = scl(sub(b.max, b.min), 0.5);
    return { p: [c[0] + h[0] * a[0], c[1] + h[1] * a[1], c[2] + h[2] * a[2]], nrm: dominant(a) };
  }
  anchorIn(ref, F, dflt) {
    const a = this.anchorLocal(ref.node, ref.anchor ?? dflt);
    const R = this.relTo(ref.node, F);
    return { q: add(apply(R, a.p), ref.offset), nrm: applyDir(R, a.nrm), tan: a.tan && applyDir(R, a.tan) };
  }
  pointOf(v, F, what) {
    if (Array.isArray(v) && v.length === 3) return v;
    if (isSet(v)) v = mkRef(this.setNode(v));
    if (isRef(v)) return this.anchorIn(v, F, DIRS.center).q;
    throw new S3DError(`${what} 需要点坐标或锚点`);
  }

  // —— 关系 → 定位 ——
  relation(n, Rm) {
    const P = n.parent;
    const pin = n.props.has('pin') ? this.anchorSpec(n, 'pin') : null;
    const pinP = (dflt) => this.anchorLocal(n, pin ?? dflt).p;
    if (n.props.has('on')) {
      const r = this.ref(n, 'on'), a = this.anchorIn(r, P, DIRS.top);
      return { ref: r, q: a.q, nrm: this.dirIn(r.node, DIRS.top, P), pin: pinP(DIRS.bottom) };
    }
    if (n.props.has('under')) {
      const r = this.ref(n, 'under'), a = this.anchorIn(r, P, DIRS.bottom);
      return { ref: r, q: a.q, nrm: this.dirIn(r.node, DIRS.bottom, P), pin: pinP(DIRS.top) };
    }
    if (n.props.has('against')) {
      const r = this.ref(n, 'against');
      if (!Array.isArray(r.anchor)) throw new S3DError(`${n.path}：against 要指明贴哪个面，如 ${r.node.id ?? 'B'}.left`, n.line, n);
      const a = this.anchorIn(r, P);
      let face = pin;
      if (!face) {
        let best = Infinity;
        for (const f of FACES) { const s = dot(mv(Rm, DIRS[f]), a.nrm); if (s < best) { best = s; face = DIRS[f]; } }
      }
      return { ref: r, q: a.q, nrm: a.nrm, pin: this.anchorLocal(n, face).p };
    }
    if (n.props.has('inside')) {
      const r = this.ref(n, 'inside'), a = this.anchorIn(r, P, DIRS.center);
      return { ref: r, q: a.q, nrm: [0, 0, 0], pin: pinP(DIRS.center) };
    }
    if (n.props.has('at')) {
      const v = this.eval(n, 'at');
      if (isRef(v)) {
        if (v.node === n || n.isAncestorOf(v.node)) throw new S3DError(`${n.path} 不能相对自己定位`, n.line, n);
        const a = this.anchorIn(v, P, DIRS.center);
        return { ref: v, q: a.q, nrm: a.nrm, pin: pinP(DIRS.bottom) };
      }
      return { ref: null, q: this.pointOf(v, P, `${n.path} 的 at`), nrm: [0, 0, 0], pin: pinP(DIRS.bottom) };
    }
    if (pin) return { ref: null, q: [0, 0, 0], nrm: [0, 0, 0], pin: pinP(pin) };
    return null;
  }

  local(n) {
    return this.memo(n, 'local', () => {
      if (!n.parent || n.isSet) return IDENT;
      if (n.ghostOf) return this.local(n.ghostOf);
      if (n.src) return this.copyLocal(n);
      if (n.copyOf) return this.containerCopyLocal(n);
      if (LINKS.has(n.kind)) return this.link(n).local;
      if (PATH_CURVES.has(n.kind)) return IDENT;
      if (n.inst) return this.instLocal(n);
      const Rm = this.orientation(n);
      let t = [0, 0, 0];
      const r = this.relation(n, Rm);
      if (r) {
        t = sub(r.q, mv(Rm, r.pin));
        const gap = this.num(n, 'gap', 0);
        if (gap) t = add(t, scl(r.nrm, gap));
      }
      if (n.props.has('align')) {
        const tgt = n.props.has('alignto') ? this.ref(n, 'alignto') : r && r.ref;
        if (!tgt) throw new S3DError(`${n.path}：align 需要参照（on/under/against/inside/at=对象 或 alignto=对象）`, n.line, n);
        const P = n.parent;
        for (const f of this.names(n, 'align')) {
          const T0 = T3(Rm, t);
          const ax = { x: 0, y: 1, z: 2 }[f];
          if (ax !== undefined) {
            const q = this.anchorIn({ ...tgt, anchor: DIRS.center, offset: [0, 0, 0] }, P).q;
            const p = apply(T0, this.anchorLocal(n, DIRS.center).p);
            t = [...t]; t[ax] += q[ax] - p[ax];
            continue;
          }
          const dv = dirWord(f);
          if (!dv || f.includes('-') || f === 'center') throw new S3DError(`${n.path}：align 不认识 “${f}”（可用面名或 x/y/z）`, n.line, n);
          const a = this.anchorIn({ ...tgt, anchor: dv, offset: [0, 0, 0] }, P);
          let mine = dv, best = -Infinity;
          for (const g of FACES) { const s = dot(mv(Rm, DIRS[g]), a.nrm); if (s > best) { best = s; mine = DIRS[g]; } }
          const p = apply(T0, this.anchorLocal(n, mine).p);
          t = add(t, scl(a.nrm, dot(sub(a.q, p), a.nrm)));
        }
      }
      if (n.props.has('offset')) t = add(t, this.vec(n, 'offset'));
      return T3(Rm, t);
    });
  }

  // 朝向 = 基准 · turn · tilt · roll · rot
  //   基准：on/under/against/inside 继承参照物的朝向；有 aim 时改为“让自己的某个面指向目标”
  orientation(n) {
    const P = n.parent;
    let base = I3;
    const rk = ['on', 'under', 'against', 'inside'].find((k) => n.props.has(k));
    if (rk) {
      base = this.relTo(this.ref(n, rk).node, P).R;
      if (det3(base) < 0) base = mm(base, [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]); // 参照物是镜像时，只继承朝向不继承手性
    }
    // repeat 也继承参照物的朝向，但它的 turn 是每个实例的递增角，不旋转阵列本身
    if (n.kind === 'repeat') return base;
    let Rm = mm(base, Ry(rad(this.num(n, 'turn', 0))));
    if (n.props.has('aim')) {
      const tgt = this.pointOf(this.eval(n, 'aim'), P, `${n.path} 的 aim`);
      const r0 = this.relation(n, Rm);
      const from = r0 ? r0.q : n.props.has('offset') ? this.vec(n, 'offset') : [0, 0, 0];
      const d = sub(tgt, from);
      if (len(d) < 1e-9) throw new S3DError(`${n.path}：aim 的目标与自身重合`, n.line, n);
      const wName = this.sym(n, 'aimwith', 'front');
      const a = dirWord(wName);
      if (!a || len(a) < 1e-9) throw new S3DError(`${n.path} 的 aimwith 需要方向词，如 front / top / right`, n.line, n);
      const au = unit(a);
      // 次轴：尽量保持原来的“上”（若主轴本身是上下，则保持原来的“前”）
      const b = Math.abs(au[1]) < 0.99 ? [0, 1, 0] : [0, 0, 1];
      Rm = alignAxes(au, unit(sub(b, scl(au, dot(b, au)))), d, mv(Rm, b));
    }
    Rm = mm(Rm, mm(Rx(rad(this.num(n, 'tilt', 0))), Rroll(rad(this.num(n, 'roll', 0)))));
    if (n.props.has('rot')) {
      const v = this.eval(n, 'rot');
      if (!Array.isArray(v) || v.length !== 4) throw new S3DError(`${n.path} 的 rot 写成 (轴x,轴y,轴z,角度)`, n.line, n);
      Rm = mm(Rm, axisAngle(v.slice(0, 3), rad(v[3])));
    }
    return Rm;
  }

  instLocal(n) {
    if (n.inst.over) return IDENT;
    const R = n.parent;
    const turn = rad(this.num(R, 'turn', 0));
    const { index, flat, grid } = n.inst;
    if (R.props.has('along')) {
      // 沿曲线等弧长分布；默认朝向跟随切线
      const c = this.curveRef(R, 'along');
      const cv = this.curve(c.node);
      const N = R.total;
      const s = cv.closed ? flat / N : N > 1 ? flat / (N - 1) : 0;
      const a = this.anchorIn({ ...c, anchor: { t: s } }, R);
      // orient=yaw（默认）：只转向不倾斜，保持竖直；full：x 沿切线、z 水平朝外侧、y 为法向；none：不转
      const o = this.eval(R, 'orient', 'yaw');
      const mode = o === true || o === 'true' ? 'yaw' : o === false || o === 'false' ? 'none' : o;
      if (!['yaw', 'full', 'none'].includes(mode)) throw new S3DError(`${R.path} 的 orient 只能是 yaw / full / none`, R.line, R);
      let M = I3;
      if (mode === 'yaw' && Math.hypot(a.tan[0], a.tan[2]) > 1e-9) M = Ry(Math.atan2(-a.tan[2], a.tan[0]));
      if (mode === 'full') { const side = len(cross(a.tan, [0, 1, 0])) > 1e-6 ? unit(cross(a.tan, [0, 1, 0])) : [0, 0, 1]; M = cols(unit(a.tan), cross(side, unit(a.tan)), side); }
      return T3(mm(M, Ry(turn * flat)), a.q);
    }
    const step = this.vec(R, 'step', [0, 0, 0]);
    const centered = truthy(this.eval(R, 'center', false));
    let t;
    if (grid) t = index.map((x, k) => (x - (centered ? ((R.counts[k] ?? 1) - 1) / 2 : 0)) * step[k]);
    else t = scl(step, flat - (centered ? (R.counts[0] - 1) / 2 : 0));
    return T3(Ry(turn * flat), t);
  }

  // —— 镜像面 / 旋转轴（在框架 F 中表达）——
  mirrorIn(n, F) {
    const v = this.eval(n, 'across', 'x');
    let q, nrm;
    if (typeof v === 'string') {
      if (!(v in AXES)) throw new S3DError(`${n.path}：across 写成 x / y / z、点坐标，或对象/锚点（如 B、B.right、B.top）`, n.line, n);
      q = [0, 0, 0]; nrm = AXES[v];
    } else if (Array.isArray(v)) {
      q = v; nrm = this.dirSpec(n, 'axis', F, null, [1, 0, 0]);
    } else if (isRef(v)) {
      if (Array.isArray(v.anchor) && !n.props.has('axis') && len(v.anchor) > 0) {
        const a = this.anchorIn(v, F); q = a.q; nrm = a.nrm; // 过某个面
      } else {
        q = this.anchorIn(v, F, DIRS.center).q;
        nrm = this.dirSpec(n, 'axis', F, v.node, [1, 0, 0]); // 轴名按参照物自己的坐标轴理解
      }
    } else throw new S3DError(`${n.path}：无法理解 across`, n.line, n);
    if (len(nrm) < 1e-9) throw new S3DError(`${n.path}：镜像面的法线为零`, n.line, n);
    return reflectAcross(q, unit(nrm));
  }
  // 方向：x/y/z 或方向词（在 frameOf 的坐标系里，缺省为 F）、向量、或锚点（取其法线 / 曲线切线）
  dirSpec(n, key, F, frameOf, dflt) {
    const v = n.props.has(key) ? this.eval(n, key) : null;
    const inFrame = (d) => (frameOf ? this.dirIn(frameOf, d, F) : d);
    if (v == null) return inFrame(dflt);
    if (typeof v === 'string') {
      const d = AXES[v] ?? dirWord(v);
      if (!d || len(d) < 1e-9) throw new S3DError(`${n.path} 的 ${key}：不认识方向 “${v}”`, n.line, n);
      return unit(inFrame(d));
    }
    if (Array.isArray(v) && v.length === 3) return unit(v);
    if (isRef(v)) {
      if (v.anchor && v.anchor.t !== undefined) return unit(this.anchorIn(v, F).tan);
      if (Array.isArray(v.anchor) && len(v.anchor) > 0) return unit(this.dirIn(v.node, v.anchor, F));
    }
    throw new S3DError(`${n.path} 的 ${key} 需要方向：x / y / z、向量，或锚点如 B.front`, n.line, n);
  }
  rotationIn(n, F, k) {
    const count = n.src ? 1 : Math.round(this.num(n, 'n', 1));
    const angle = this.num(n, 'angle', 360 / (count + 1));
    const v = this.eval(n, 'about', null);
    const q = v == null ? [0, 0, 0] : this.pointOf(v, F, `${n.path} 的 about`);
    return rotateAbout(q, this.dirSpec(n, 'axis', F, null, [0, 1, 0]), rad(angle * k));
  }
  // of= 复制：副本的框架 = 关系变换 ∘ 原物体的框架（在父框架中计算）
  copyLocal(n) {
    const P = n.parent;
    const M = n.kind === 'mirror' ? this.mirrorIn(n, P) : this.rotationIn(n, P, 1);
    return compose(M, this.relTo(n.src, P));
  }
  // 容器式：生成的副本组相对容器本身
  containerCopyLocal(G) {
    const { container: C, k } = G.copyOf;
    return C.kind === 'mirror' ? this.mirrorIn(C, C) : this.rotationIn(C, C, k);
  }

  // —— 曲线（自身框架中的密集采样）——
  curve(n) {
    return this.memo(n, 'curve', () => {
      if (n.ghostOf) return this.curve(n.ghostOf);
      if (n.src) return this.curve(n.src);
      const k = n.kind;
      if (k === 'arc' || k === 'helix') {
        const r = this.num(n, 'r', 5);
        let a0, a1, rise, plane = 'xz';
        if (k === 'helix') {
          const pitch = this.num(n, 'pitch', 3), turns = this.num(n, 'turns', 1);
          a0 = 0; a1 = 360 * turns; rise = pitch * Math.abs(turns);
        } else {
          let ang = this.eval(n, 'angle', [0, 360]);
          if (typeof ang === 'number') ang = [0, ang];
          if (!Array.isArray(ang) || ang.length !== 2) throw new S3DError(`${n.path} 的 angle 写成 起,止（度）`, n.line, n);
          [a0, a1] = ang;
          rise = this.num(n, 'rise', 0);
          plane = this.sym(n, 'plane', 'xz');
          if (!['xz', 'xy', 'zy'].includes(plane)) throw new S3DError(`${n.path} 的 plane 只能是 xz / xy / zy`, n.line, n);
        }
        const sweep = a1 - a0, segs = Math.max(8, Math.ceil(Math.abs(sweep) / 4)), dth = rad(sweep);
        const closed = Math.abs(sweep) >= 360 - 1e-9 && rise === 0;
        const fn = (s) => {
          const th = rad(a0 + sweep * s), c = r * Math.cos(th), sn = r * Math.sin(th);
          const p = plane === 'xz' ? [c, rise * s, -sn] : plane === 'xy' ? [c, sn, rise * s] : [rise * s, sn, c];
          const d = plane === 'xz' ? [-sn * dth, rise, -c * dth] : plane === 'xy' ? [-sn * dth, c * dth, rise] : [rise, c * dth, -sn * dth];
          return { p, tan: scl(d, 1 / (len(d) || 1)) };
        };
        const pts = [];
        for (let i = 0; i <= segs; i++) { if (closed && i === segs) break; pts.push(fn(i / segs).p); }
        return measureCurve(pts, closed, fn);
      }
      const ctrl = this.points(n, 'path', n.parent);
      if (k === 'line') return measureCurve(ctrl, false);
      if (k === 'bezier') return measureCurve(bezierPts(ctrl), false);
      const closed = truthy(this.eval(n, 'closed', false));
      return measureCurve(catmullRom(ctrl, closed), closed);
    });
  }

  // —— span / sweep / pipe：由两端或路径在父框架中直接确定自身 ——
  link(n) {
    return this.memo(n, 'link', () => {
      const P = n.parent;
      if (n.kind === 'sweep' || n.kind === 'pipe') {
        const v = this.eval(n, 'path');
        let pts, tans = null, closed = false;
        const pv = n.kind === 'pipe' ? 'circle' : this.eval(n, 'profile', n.props.has('section') ? 'rect' : 'circle');
        let profile = pv, poly = null;
        if (pv && pv.list) {
          // 自定义截面：截面平面里的多边形 [(u,v); …]，u 沿水平侧向、v 沿“上”
          if (pv.list.length < 3 || pv.list.some((q) => !Array.isArray(q) || q.length !== 2)) throw new S3DError(`${n.path} 的 profile 多边形写成 [(u,v); (u,v); …]，至少 3 个点`, n.line, n);
          profile = 'poly'; poly = pv.list;
        } else if (!['circle', 'rect'].includes(profile)) throw new S3DError(`${n.path} 的 profile 只能是 circle / rect / 多边形列表`, n.line, n);
        const r = this.num(n, 'r', 0.3);
        const [w, th] = this.vec2(n, 'section', [1, 0.2]);
        if (isRef(v)) {
          const C = v.node;
          if (!CURVES.has(K(C))) throw new S3DError(`${n.path} 的 path 需要曲线或点列表`, n.line, n);
          const cv = this.curve(C), R = this.relTo(C, P);
          pts = cv.pts.map((p) => apply(R, p));
          closed = cv.closed;
          // 有解析式的曲线（圆弧、螺旋）用精确切线，端点截面不会歪
          if (cv.fn) tans = cv.pts.map((_, i) => applyDir(R, cv.fn(closed ? i / pts.length : i / (pts.length - 1)).tan));
        } else {
          const ctrl = this.points(n, 'path', P);
          pts = truthy(this.eval(n, 'smooth', false)) ? catmullRom(ctrl, false, 10) : roundCorners(ctrl, profile === 'circle' ? Math.max(3 * r, 0.6) : Math.max(w, 1));
        }
        const pin = this.sym(n, 'pin', 'center');
        const frames = sweepFrames(pts, closed, tans), prof = poly ? ccw(poly) : sweepProfile(profile, r, w, th, pin);
        const ring = (f) => prof.map(([u, v]) => add(f.p, add(scl(f.side, u), scl(f.up, v))));
        return { local: IDENT, box: boundsOf(frames.flatMap(ring)), geom: { type: 'sweep', frames, prof, closed, smooth: profile === 'circle' } };
      }
      const A = this.pointOf(this.eval(n, 'from'), P, `${n.path} 的 from`);
      let B;
      if (n.props.has('drop')) {
        // 从 A 沿 dir（默认竖直向下）一直延伸，直到碰到参照物的面（默认是它的顶面所在平面）
        const r = this.ref(n, 'drop'), dir = this.dirSpec(n, 'dir', P, null, [0, -1, 0]);
        const face = this.anchorIn(r, P, DIRS.top);
        const nrm = len(face.nrm) > 0 ? face.nrm : this.dirIn(r.node, DIRS.top, P);
        const den = dot(dir, nrm);
        if (Math.abs(den) < 1e-9) throw new S3DError(`${n.path}：drop 的方向与 ${r.node.path} 的面平行，碰不到`, n.line, n);
        const s = dot(sub(face.q, A), nrm) / den;
        if (s < 0) throw new S3DError(`${n.path}：沿 dir 方向碰不到 ${r.node.path}（它在反方向）`, n.line, n);
        B = add(A, scl(dir, s));
      } else B = this.pointOf(this.eval(n, 'to'), P, `${n.path} 的 to`);
      const d = sub(B, A), H = Math.hypot(d[0], d[2]), L = len(d);
      if (L < 1e-9) throw new S3DError(`${n.path}：from 与 to 重合`, n.line, n);
      const mid = scl(add(A, B), 0.5);
      const steps = Math.round(this.num(n, 'steps', 0));
      if (steps > 0) {
        // 台阶：框架只绕竖直轴转，踏面保持水平
        const [w, th] = this.vec2(n, 'section', [1.2, 0.2]);
        const treads = [];
        for (let i = 0; i < steps; i++) {
          const top = -d[1] / 2 + (d[1] * (i + 1)) / steps;
          treads.push({ c: [-H / 2 + (H * (i + 0.5)) / steps, top - th / 2, 0], s: [H / steps, th, w] });
        }
        const corners = treads.flatMap((tr) => boxCorners({ min: sub(tr.c, scl(tr.s, 0.5)), max: add(tr.c, scl(tr.s, 0.5)) }));
        return { local: T3(Ry(H < 1e-9 ? 0 : Math.atan2(-d[2], d[0])), mid), box: boundsOf(corners), geom: { type: 'steps', treads } };
      }
      // 梁 / 杆：局部 x 沿 A→B，y 尽量朝上，z 水平；顶面就是梁真正的顶面
      const Rm = alignAxes([1, 0, 0], [0, 1, 0], d, [0, 1, 0]);
      if (n.props.has('r')) {
        const r = this.num(n, 'r');
        return { local: T3(Rm, mid), box: { min: [-L / 2, -r, -r], max: [L / 2, r, r] }, geom: { type: 'rod', L, r } };
      }
      const [w, th] = this.vec2(n, 'section', [1, 0.3]);
      const mode = this.sym(n, 'pin', 'center');
      const dy = mode === 'bottom' ? th / 2 : mode === 'top' ? -th / 2 : 0;
      return { local: T3(Rm, mid), box: { min: [-L / 2, dy - th / 2, -w / 2], max: [L / 2, dy + th / 2, w / 2] }, geom: { type: 'beam', L, w, t: th, dy } };
    });
  }

  // 自身框架中的包围盒
  box(n) {
    return this.memo(n, 'box', () => {
      if (n.isSet) return boundsOf(n.members.flatMap((m) => boxCorners(this.worldBox(m))));
      const src = n.ghostOf ?? n.src;
      if (src) { const b = this.box(src); n.geom = src.geom; return b; }
      switch (n.kind) {
        case 'box': case 'wedge': {
          const [w, h, d] = this.vec(n, 'size', [1, 1, 1]);
          n.geom = { type: n.kind, w, h, d };
          return { min: [-w / 2, 0, -d / 2], max: [w / 2, h, d / 2] };
        }
        case 'cyl': case 'cone': {
          const r = this.num(n, 'r', 0.5), h = this.num(n, 'h', 1);
          const r2 = n.kind === 'cone' ? this.num(n, 'r2', 0) : r;
          const axis = this.sym(n, 'axis', 'y');
          if (!(axis in AXES)) throw new S3DError(`${n.path} 的 axis 只能是 x / y / z`, n.line, n);
          const R = Math.max(r, r2);
          n.geom = { type: 'cyl', r1: r, r2, h, axis };
          if (axis === 'y') return { min: [-R, 0, -R], max: [R, h, R] };
          if (axis === 'x') return { min: [-h / 2, 0, -R], max: [h / 2, 2 * R, R] };
          return { min: [-R, 0, -h / 2], max: [R, 2 * R, h / 2] };
        }
        case 'sphere': {
          const r = this.num(n, 'r', 0.5);
          n.geom = { type: 'sphere', r };
          return { min: [-r, 0, -r], max: [r, 2 * r, r] };
        }
        case 'revolve': {
          const v = this.eval(n, 'profile');
          if (!v || !v.list || v.list.length < 2 || v.list.some((p) => !Array.isArray(p) || p.length !== 2))
            throw new S3DError(`${n.path}：revolve 的 profile 写成 [(半径,高); (半径,高); …]`, n.line, n);
          let prof = v.list.map(([r, y]) => [Math.abs(r), y, 0]);
          if (truthy(this.eval(n, 'smooth', false))) prof = catmullRom(prof, false, 10);
          prof = prof.map(([r, y]) => [r, y]);
          // 自动在轴上封口，使其成为封闭实体
          if (prof[0][0] > 1e-6) prof.unshift([0, prof[0][1]]);
          if (prof[prof.length - 1][0] > 1e-6) prof.push([0, prof[prof.length - 1][1]]);
          const angle = this.num(n, 'angle', 360);
          n.geom = { type: 'revolve', prof, angle };
          const R = Math.max(...prof.map((p) => p[0])), ys = prof.map((p) => p[1]);
          return { min: [-R, Math.min(...ys), -R], max: [R, Math.max(...ys), R] };
        }
        case 'span': case 'sweep': case 'pipe': {
          const k = this.link(n);
          n.geom = k.geom;
          return k.box;
        }
      }
      if (CURVES.has(n.kind)) return boundsOf(this.curve(n).pts);
      // 容器：子物体包围盒之并（subtract 只取被减体）
      const kids = n.kind === 'subtract' ? n.children.slice(0, 1) : n.children;
      const pts = [];
      for (const c of kids) {
        if (c.late) continue;
        if (c.localBusy) { c.late = true; continue; }
        try {
          pts.push(...boxCorners(transformBox(this.local(c), this.box(c))));
        } catch (e) {
          // 子物体的位置依赖于本容器自身的位置 → 它是“后置”物体，不参与容器尺寸
          if (e instanceof Cycle && e.node === n) { c.late = true; continue; }
          throw e;
        }
      }
      return pts.length ? boundsOf(pts) : ZERO_BOX;
    });
  }

  worldBox(n) { return transformBox(this.world(n), this.box(n)); }
}

// ───────────────────────── 多对象模式 ─────────────────────────
// 在场景里搜索所有满足约束的角色组合。单个角色逐个枚举（回溯），集合角色（名字带 *）
// 绑定为“满足全部约束的所有成员”。同一组对象换个顺序算同一个匹配。

function matchPattern(p, env0, root, S) {
  const roleMap = new Map(p.roles.map((r) => [r.name, r]));
  const scalars = p.roles.filter((r) => !r.set).map((r) => r.name);
  const sets = p.roles.filter((r) => r.set).map((r) => r.name);
  const envWith = (bind) => {
    const env = new Env(env0);
    for (const [k, v] of bind) env.vars.set(k, { v: isSet(v) ? v : mkRef(v) });
    return env;
  };
  const evalIn = (ast, bind) => evalAst(ast, { env: envWith(bind), node: root, scope: root, frame: root, S });
  const roleOf = (ast) => (ast.k === 'path' && ast.segs.length === 1 && !ast.coords && roleMap.has(ast.segs[0]) ? ast.segs[0] : null);
  const refsIn = (ast, out = new Set()) => {
    if (!ast || typeof ast !== 'object') return out;
    if (ast.k === 'path' && roleMap.has(ast.segs[0])) out.add(ast.segs[0]);
    for (const k of ['a', 'b', 'pred', 'coords']) if (ast[k]) refsIn(ast[k], out);
    for (const k of ['items', 'args']) if (ast[k]) ast[k].forEach((x) => refsIn(x, out));
    return out;
  };
  const domains = new Map();
  const cons = [];
  for (const c of p.constraints) {
    if (c.k === 'in') { domains.set(c.role, c.ast); continue; }
    const deps = c.k === 'rel' ? new Set([...refsIn(c.a), ...refsIn(c.b)]) : refsIn(c.ast);
    const setDeps = [...deps].filter((r) => roleMap.get(r).set);
    if (c.k === 'rel') {
      const aRole = roleOf(c.a), bRole = roleOf(c.b);
      if (setDeps.length > 1 || (setDeps.length === 1 && setDeps[0] !== aRole && setDeps[0] !== bRole))
        throw new S3DError(`第 ${c.line} 行：一条关系约束里最多一个集合角色，且它要单独站在关系的一边`, c.line);
      cons.push({ ...c, aRole, bRole, deps, setRole: setDeps[0] ?? null });
    } else cons.push({ ...c, deps, setRole: setDeps.length ? setDeps[0] : null, late: setDeps.length > 0 });
  }
  // 每条只涉及单个角色的约束，在它最后一个依赖被绑定时检查
  const pos = new Map(scalars.map((r, i) => [r, i]));
  const at = (c) => (c.setRole || c.late ? -1 : Math.max(-1, ...[...c.deps].map((r) => pos.get(r))));
  const byDepth = scalars.map((_, i) => cons.filter((c) => at(c) === i));
  const final = cons.filter((c) => at(c) === -1);
  const has = (rel, x, y) => !!(S.rel[rel].get(x) && S.rel[rel].get(x).has(y));
  const domain = (r, bind) => (domains.has(r) ? asSet(evalIn(domains.get(r), bind)).nodes : S.allNodes());
  const relOk = (c, bind, override) => {
    const side = (role, ast) => (role ? [override && role === override[0] ? override[1] : bind.get(role)] : asSet(evalIn(ast, bind)).nodes);
    const xs = side(c.aRole, c.a), ys = side(c.bRole, c.b);
    return xs.some((x) => ys.some((y) => has(c.rel, x, y)));
  };
  const ok = (c, bind) => (c.k === 'rel' ? relOk(c, bind) : asBool(evalIn(c.ast, bind)));

  const matches = [], seen = new Set();
  let steps = 0;
  const finish = (bind) => {
    const used = new Set(bind.values());
    const full = new Map(bind);
    for (const T of sets) {
      const rules = cons.filter((c) => c.k === 'rel' && c.setRole === T);
      full.set(T, new NodeSet(domain(T, bind).filter((t) => !used.has(t) && rules.every((c) => relOk(c, bind, [T, t])))));
    }
    for (const c of final) if (!(c.k === 'rel' && c.setRole) && !ok(c, full)) return;
    const key = [...full.values()].flatMap((v) => (isSet(v) ? v.nodes : [v])).map((n) => n.path).sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    matches.push(full);
  };
  const dfs = (i, bind) => {
    if (++steps > 200000) throw new S3DError(`模式 ${p.name} 的搜索空间太大，请用 in 缩小各角色的范围`, p.line);
    if (matches.length >= 500) return;
    if (i === scalars.length) return finish(bind);
    const r = scalars[i], used = new Set(bind.values());
    for (const cand of domain(r, bind)) {
      if (used.has(cand)) continue; // 一个对象不能同时扮演两个角色
      bind.set(r, cand);
      if (byDepth[i].every((c) => ok(c, bind))) dfs(i + 1, bind);
      bind.delete(r);
    }
  };
  dfs(0, new Map());
  return new PatternValue(p.name, p.roles, matches);
}

// ───────────────────────── 输出 ─────────────────────────

function materialOf(n, S, materials) {
  for (let a = n; a; a = a.parent) {
    const st = S.styleMap && S.styleMap.get(a);
    if (st) return st;
    if (a.ghostOf) return materialOf(a.ghostOf, S, materials); // 副本沿用原物体的材质
    if (a.props.has('color')) return { color: String(S.eval(a, 'color')) };
    if (a.props.has('mat')) {
      // 材质名是符号，不当作对象引用解析（场景里可以同时有叫 ground 的物体和材质）
      const ast = a.props.get('mat');
      const name = ast.k === 'path' && ast.segs.length === 1 ? ast.segs[0] : ast.k === 'str' ? ast.v : null;
      const m = materials.get(name);
      if (m) return { name, ...m };
      throw new S3DError(`未定义的材质 ${name ?? '(无效写法)'}`, a.line, a);
    }
    if (a.src) return materialOf(a.src, S, materials);
  }
  return { color: '#c9c9c9' };
}

function buildItems(root, S, materials) {
  const leaf = (n) => ({
    kind: 'solid', path: n.path, tags: n.tags, geom: n.geom, world: S.world(n), material: materialOf(n, S, materials),
  });
  const single = (n) => {
    const k = K(n);
    if (LEAVES.has(k)) return n.geom ? leaf(n) : null;
    if (CURVES.has(k)) return null;
    const op = CSG.has(k) ? k : 'union';
    const children = n.children.filter((c) => !c.skin).map(single).filter(Boolean);
    if (!children.length) return null;
    if (op === 'union' && children.length === 1 && !CSG.has(k)) return children[0];
    return { kind: 'csg', op, path: n.path, tags: n.tags, children, material: materialOf(n, S, materials) };
  };
  const out = [], curves = [];
  const walk = (n) => {
    const k = K(n);
    if (n.hidden) { n.children.forEach(walk); return; } // 被变体替换的原物体：只找它下面的变体
    if (LEAVES.has(k)) { if (n.geom) out.push(leaf(n)); n.children.forEach(walk); return; }
    if (CURVES.has(k)) {
      if (n._world) { const c = S.curve(n), W = S.world(n); curves.push({ path: n.path, closed: c.closed, pts: c.pts.map((p) => apply(W, p)) }); }
      return;
    }
    if (CSG.has(k)) { const s = single(n); if (s) out.push(s); return; }
    n.children.forEach(walk);
  };
  walk(root);
  return { items: out, curves };
}

// 反向：从求解后的几何中读出客观空间事实，用同一套词汇表达。
// 每一对物体只输出最强的一条关系：on > against > inside > touching（接触）> intersects（相交）。
// on / against 在参照物 B 自己的坐标系里判断，所以 “A against B.left” 指的是 B 自身的左面；
// 接触与相交用有向包围盒的分离轴测试，对任意朝向都精确（不再用世界包围盒近似）。
export const FACT_EPS = 0.02;

// ── 碰撞代理：每个物体 → 若干凸块（凸多面体或球），用于判断接触、相交、包含 ──
// 盒子、楔形、梁是精确的多面体；圆柱、圆锥是 12 边棱柱；球是精确的；扫掠沿路径分段；
// revolve 暂用外接圆柱（标为近似）。

// 由顶点和面（顶点索引环）构造凸多面体：面法线用 Newell 法，对退化（如圆锥顶点重合）稳健
function polyFrom(verts, faces) {
  const normals = [], edges = [];
  const addDir = (list, d) => {
    const l = len(d);
    if (l < 1e-9) return;
    d = scl(d, 1 / l);
    if (!list.some((e) => Math.abs(Math.abs(dot(e, d)) - 1) < 1e-6)) list.push(d);
  };
  for (const f of faces) {
    let nrm = [0, 0, 0];
    for (let i = 0; i < f.length; i++) {
      const a = verts[f[i]], b = verts[f[(i + 1) % f.length]];
      nrm = add(nrm, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
      addDir(edges, sub(b, a));
    }
    addDir(normals, nrm);
  }
  return { verts, normals, edges };
}
const BOX_FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
const boxPoly = (b) => polyFrom(boxCorners(b), BOX_FACES);
// 沿 y 轴的棱台（底半径 r1、顶半径 r2、y 从 y0 到 y1），再由 map 变换到所需方向
function frustumPoly(r1, r2, y0, y1, map = (p) => p, sides = 12) {
  const verts = [];
  for (let i = 0; i < sides; i++) { const a = (i / sides) * 2 * Math.PI; verts.push(map([r1 * Math.cos(a), y0, r1 * Math.sin(a)])); }
  for (let i = 0; i < sides; i++) { const a = (i / sides) * 2 * Math.PI; verts.push(map([Math.max(r2, 1e-4) * Math.cos(a), y1, Math.max(r2, 1e-4) * Math.sin(a)])); }
  const faces = [[...Array(sides).keys()].reverse(), [...Array(sides).keys()].map((i) => i + sides)];
  for (let i = 0; i < sides; i++) faces.push([i, (i + 1) % sides, sides + ((i + 1) % sides), sides + i]);
  return polyFrom(verts, faces);
}
// 局部坐标系里的凸块
function localParts(n) {
  const g = n.geom, b = n._box;
  if (!g) return { parts: [boxPoly(b)], approx: false };
  switch (g.type) {
    case 'box': case 'beam': return { parts: [boxPoly(b)], approx: false };
    case 'wedge': {
      const { w, h, d } = g;
      const v = [[-w / 2, 0, -d / 2], [w / 2, 0, -d / 2], [w / 2, h, -d / 2], [-w / 2, 0, d / 2], [w / 2, 0, d / 2], [w / 2, h, d / 2]];
      return { parts: [polyFrom(v, [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [0, 2, 5, 3]])], approx: false };
    }
    case 'cyl': {
      const R = Math.max(g.r1, g.r2);
      const map = g.axis === 'y' ? (p) => p : g.axis === 'x' ? (p) => [p[1] - g.h / 2, R + p[0], p[2]] : (p) => [p[0], R + p[2], p[1] - g.h / 2];
      return { parts: [frustumPoly(g.r1, g.r2, 0, g.h, map)], approx: false };
    }
    case 'rod': return { parts: [frustumPoly(g.r, g.r, -g.L / 2, g.L / 2, (p) => [p[1], p[0], p[2]])], approx: false };
    case 'sphere': return { parts: [{ sphere: true, c: [0, g.r, 0], r: g.r }], approx: false };
    case 'revolve': return { parts: [frustumPoly(b.max[0], b.max[0], b.min[1], b.max[1])], approx: true };
    case 'steps': return { parts: g.treads.map((t) => boxPoly({ min: sub(t.c, scl(t.s, 0.5)), max: add(t.c, scl(t.s, 0.5)) })), approx: false };
    case 'sweep': {
      // 每一段取相邻两个截面环的凸包（截面是凸的时候精确）；圆截面用 8 边形代替
      const F = g.frames, segs = g.closed ? F.length : F.length - 1;
      const prof = g.prof.length > 8 ? Array.from({ length: 8 }, (_, i) => g.prof[Math.floor((i * g.prof.length) / 8)]) : g.prof;
      const m = prof.length, ring = (f) => prof.map(([u, v]) => add(f.p, add(scl(f.side, u), scl(f.up, v))));
      const faces = [[...Array(m).keys()].reverse(), [...Array(m).keys()].map((i) => i + m)];
      for (let i = 0; i < m; i++) faces.push([i, (i + 1) % m, m + ((i + 1) % m), m + i]);
      const parts = [];
      for (let i = 0; i < segs; i++) parts.push(polyFrom([...ring(F[i]), ...ring(F[(i + 1) % F.length])], faces));
      return { parts, approx: false };
    }
  }
  return { parts: [boxPoly(b)], approx: true };
}
const worldPart = (W, P) => (P.sphere ? { sphere: true, c: apply(W, P.c), r: P.r }
  : { verts: P.verts.map((v) => apply(W, v)), normals: P.normals.map((d) => applyDir(W, d)), edges: P.edges.map((d) => applyDir(W, d)) });
const projOf = (P, L) => {
  if (P.sphere) { const c = dot(P.c, L); return [c - P.r, c + P.r]; }
  let lo = Infinity, hi = -Infinity;
  for (const v of P.verts) { const x = dot(v, L); if (x < lo) lo = x; if (x > hi) hi = x; }
  return [lo, hi];
};
const partBox = (P) => (P.sphere ? { min: sub(P.c, [P.r, P.r, P.r]), max: add(P.c, [P.r, P.r, P.r]) } : boundsOf(P.verts));
// 两个凸块在候选分离轴上的最大间隙：> 0 分离，≈ 0 接触，< 0 相交
function partGap(A, B) {
  const axes = [];
  if (!A.sphere) axes.push(...A.normals);
  if (!B.sphere) axes.push(...B.normals);
  if (!A.sphere && !B.sphere) for (const a of A.edges) for (const b of B.edges) axes.push(cross(a, b));
  if (A.sphere && B.sphere) axes.push(sub(B.c, A.c));
  else if (A.sphere || B.sphere) { const [S0, P] = A.sphere ? [A, B] : [B, A]; for (const v of P.verts) axes.push(sub(v, S0.c)); }
  let best = -Infinity;
  for (let L of axes) {
    const l = len(L);
    if (l < 1e-9) continue;
    L = scl(L, 1 / l);
    const [a0, a1] = projOf(A, L), [b0, b1] = projOf(B, L);
    best = Math.max(best, b0 - a1, a0 - b1);
  }
  return best;
}

function deriveFacts(root, S) {
  const eps = FACT_EPS;
  const objs = [];
  const walk = (n, inCsg) => {
    const k = K(n);
    if (n.skin) return; // 变体只是外观，空间事实按原来的外包络算
    if (n.kind !== 'root' && !inCsg && (LEAVES.has(k) || CSG.has(k)) && n._box && n._world) {
      const b = n._box;
      if (b.max[0] - b.min[0] + b.max[1] - b.min[1] + b.max[2] - b.min[2] > 1e-9) objs.push(n);
    }
    n.children.forEach((c) => walk(c, inCsg || CSG.has(k)));
  };
  walk(root, false);
  const ov = (a, b, k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
  const ovI = (a, b) => Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
  const vol = (x) => (x.max[0] - x.min[0]) * (x.max[1] - x.min[1]) * (x.max[2] - x.min[2]);
  const info = objs.map((n) => {
    const W = S.world(n);
    const lp = localParts(n);
    const parts = lp.parts.map((P) => worldPart(W, P));
    const k = K(n.ghostOf ?? n);
    return {
      n, W, box: n._box, parts, pboxes: parts.map(partBox), approx: lp.approx, wb: boundsOf(parts.flatMap((P) => boxCorners(partBox(P)))),
      // 单块、可以当作“实心盒子”看待的物体，才做贴面判断
      boxy: lp.parts.length === 1 && !lp.approx && ['box', 'beam', 'wedge'].includes(n.geom?.type ?? 'box') && !CURVES.has(k),
      convex: lp.parts.length === 1 && !lp.approx,
    };
  });

  // 粗筛：按世界包围盒的 x 起点排序扫描，只留下三个方向都靠得足够近的对
  const order = [...info].sort((p, q) => p.wb.min[0] - q.wb.min[0]);
  const active = [], cands = [];
  for (const P of order) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i].wb.max[0] < P.wb.min[0] - eps) active.splice(i, 1);
    for (const Q of active) if (ov(P.wb, Q.wb, 1) > -eps && ov(P.wb, Q.wb, 2) > -eps) cands.push([P, Q]);
    active.push(P);
  }
  // 两个物体的最小间隙，以及哪些块彼此接触
  const gapOf = (P, Q) => {
    let best = Infinity;
    const touching = [];
    for (let i = 0; i < P.parts.length; i++) for (let j = 0; j < Q.parts.length; j++) {
      const a = P.pboxes[i], b = Q.pboxes[j];
      if (ov(a, b, 0) < -eps || ov(a, b, 1) < -eps || ov(a, b, 2) < -eps) continue;
      const g = partGap(P.parts[i], Q.parts[j]);
      if (g < best) best = g;
      if (g <= eps) touching.push([i, j]);
    }
    return { gap: best, touching };
  };
  // A 立在 B 上：A 与 B 的竖直轴平行；A 的最低处贴着与它接触的那块 B 的最高处；两者在水平方向上有重叠
  const onTest = (A, B, touching, flip) => {
    const rel = compose(invT(B.W), A.W);
    if (Math.abs(Math.abs(rel.R[1][1]) - 1) > 1e-6) return null;
    const up = applyDir(B.W, [0, 1, 0]), bx = applyDir(B.W, [1, 0, 0]), bz = applyDir(B.W, [0, 0, 1]);
    const span = (O, L) => { const iv = O.parts.map((P) => projOf(P, L)); return [Math.min(...iv.map((x) => x[0])), Math.max(...iv.map((x) => x[1]))]; };
    const bottom = span(A, up)[0];
    for (const [i, j] of touching) {
      const [ia, jb] = flip ? [j, i] : [i, j];
      const top = projOf(B.parts[jb], up)[1];
      if (Math.abs(bottom - top) >= eps) continue;
      if (ovI(projOf(A.parts[ia], bx), projOf(B.parts[jb], bx)) > eps && ovI(projOf(A.parts[ia], bz), projOf(B.parts[jb], bz)) > eps) return bottom - top;
    }
    return null;
  };
  // A 在 B 里：B 是单个凸块，A 的每一块在 B 的每个面法线方向上都不超出
  const insideTest = (A, B) => {
    if (!B.convex || vol(A.box) >= vol(B.box) * 0.9) return false;
    const PB = B.parts[0];
    if (PB.sphere) return A.parts.every((P) => (P.sphere ? len(sub(P.c, PB.c)) + P.r : Math.max(...P.verts.map((v) => len(sub(v, PB.c))))) <= PB.r + eps);
    return PB.normals.every((nrm) => {
      const hb = projOf(PB, nrm), nb = projOf(PB, scl(nrm, -1));
      return A.parts.every((P) => projOf(P, nrm)[1] <= hb[1] + eps && projOf(P, scl(nrm, -1))[1] <= nb[1] + eps);
    });
  };
  const facts = [];
  const push = (rel, A, B, text, gap, approx) => facts.push({ rel, a: A.n.path, b: B.n.path, text, gap: +gap.toFixed(4), eps, ...(approx ? { approx: true } : {}) });
  for (const [P, Q] of cands) {
    if (P.n.isAncestorOf(Q.n) || Q.n.isAncestorOf(P.n)) continue;
    const { gap, touching } = gapOf(P, Q);
    if (gap > eps) continue;
    const approx = P.approx || Q.approx;
    let g;
    if ((g = onTest(P, Q, touching, false)) !== null) { push('on', P, Q, `${P.n.path} on ${Q.n.path}`, g, approx); continue; }
    if ((g = onTest(Q, P, touching, true)) !== null) { push('on', Q, P, `${Q.n.path} on ${P.n.path}`, g, approx); continue; }
    // 贴面：两个都是实心盒子、坐标轴平行；在体积较大的那个的坐标系里判断，报“小的贴着大的”
    const [A, B] = vol(P.box) <= vol(Q.box) ? [P, Q] : [Q, P];
    if (A.boxy && B.boxy) {
      const rel = compose(invT(B.W), A.W);
      if (isAxisAligned(rel.R)) {
        const a = transformBox(rel, A.box), b = B.box;
        const [ox, oy, oz] = [0, 1, 2].map((k) => ov(a, b, k));
        let face = null;
        if (oy > eps) {
          if (Math.abs(a.max[0] - b.min[0]) < eps && oz > eps) face = 'left';
          else if (Math.abs(a.min[0] - b.max[0]) < eps && oz > eps) face = 'right';
          else if (Math.abs(a.max[2] - b.min[2]) < eps && ox > eps) face = 'back';
          else if (Math.abs(a.min[2] - b.max[2]) < eps && ox > eps) face = 'front';
        }
        if (face) { push('against', A, B, `${A.n.path} against ${B.n.path}.${face}`, gap, false); continue; }
      }
    }
    if (insideTest(A, B)) { push('inside', A, B, `${A.n.path} inside ${B.n.path}`, gap, approx); continue; }
    if (gap >= -eps) push('touching', A, B, `${A.n.path} touching ${B.n.path}`, gap, approx);
    else push('intersects', A, B, `${A.n.path} intersects ${B.n.path}`, gap, approx);
  }
  return facts;
}

// ───────────────────────── 入口 ─────────────────────────

// 有 variant 时编译两遍：第一遍求解并识别语义，决定替换哪些对象；第二遍在这些对象的外包络里换上变体
export function compile(src) {
  const first = compileOnce(src, null);
  return first.plan ? compileOnce(src, first.plan).result : first.result;
}

function compileOnce(src, plan) {
  const errors = [];
  const program = parseProgram(src, errors);
  const elab = elaborate(program, errors);
  const { root, flat, materials, defs, semantic } = elab;
  const S = new Solver(root, flat);
  const fail = (e, n) => {
    if (e instanceof Cycle) return new S3DError(`循环依赖：${e.node.path} 的位置最终依赖于它自己`, e.node.line, e.node);
    if (e instanceof S3DError) { e.line ??= n.line; e.node ??= n; return e; }
    return new S3DError(String(e && e.stack || e), n.line, n);
  };

  // repeat over=集合：树建好后再展开（展开出的内容里可能还有 over，逐个处理）
  while (elab.pending.length) {
    const { n, s, env, depth } = elab.pending.shift();
    try {
      const v = evalAst(s.props.get('over'), { env, node: n, scope: n.parent, S });
      const members = asSet(v).nodes.filter((m) => m !== n && !n.isAncestorOf(m) && !m.isAncestorOf(n));
      members.forEach((m, idx) => {
        const inst = new Node('group', String(idx), new Map(), [], s.line, env, n);
        inst.inst = { over: true, flat: idx, member: m };
        flat.push(inst);
        elab.walk(s.children, inst, new Env(env, { it: mkRef(m), i: idx, idx }), depth);
      });
      n.counts = [members.length]; n.total = members.length;
    } catch (e) { errors.push(fail(e, n)); }
  }
  buildCopies(root, flat, S, errors);

  // 第二遍：把变体挂到被选中的对象上。原物体仍参与求解（外包络、锚点、关系都不变），只是不再渲染
  const variantSummary = [];
  if (plan) {
    const byPath = new Map(flat.map((n) => [n.path, n]));
    const paths = [...plan.keys()].sort();
    const applied = new Map();
    for (const path of paths) {
      if (paths.some((q) => q !== path && path.startsWith(q + '.'))) continue; // 上级已经整体替换
      const N = byPath.get(path), st = elab.variants[plan.get(path)];
      if (!N) continue;
      try {
        const def = defs.get(st.use);
        if (!def) throw new S3DError(`variant 的模板 ${st.use} 没有定义`, st.line);
        const hide = (n) => { n.hidden = true; n.children.forEach(hide); };
        hide(N);
        const env = new Env(elab.globals);
        env.setLazy('__self', () => mkRef(N, DIRS.bottom));
        ['w', 'h', 'd'].forEach((k, i) => env.setLazy('__' + k, () => { const b = S.box(N); return b.max[i] - b.min[i]; }));
        const props = new Map(st.params);
        // 模板若声明了 w / h / d，就把外包络的尺寸传进去
        for (const k of ['w', 'h', 'd']) if (def.params.has(k) && !props.has(k)) props.set(k, { k: 'path', segs: ['__' + k] });
        props.set('at', { k: 'path', segs: ['__self'] });
        props.set('pin', { k: 'path', segs: ['bottom'] });
        const before = N.children.length;
        elab.walk([{ kind: st.use, id: 'skin', props, tags: [], children: [], line: st.line }], N, env, 0);
        const mark = (n) => { n.skin = true; n.hidden = false; n.children.forEach(mark); };
        N.children.slice(before).forEach(mark);
        if (!applied.has(st)) applied.set(st, []);
        applied.get(st).push(path);
      } catch (e) { errors.push(fail(e, { line: st.line })); }
    }
    for (const st of elab.variants) variantSummary.push({ line: st.line, use: st.use, src: st.src, members: applied.get(st) ?? [] });
  }

  for (const n of flat) {
    for (let tries = 0; tries < 4; tries++) {
      try { S.world(n); S.box(n); break; } catch (e0) {
        const e = fail(e0, n);
        if (!errors.some((x) => x.message === e.message)) errors.push(e);
        const bad = e.node || n;
        bad._local ??= IDENT; bad._box ??= ZERO_BOX;
        bad._link ??= { local: IDENT, box: ZERO_BOX, geom: null };
        bad._curve ??= measureCurve([[0, 0, 0], [0, 0, 0]], false);
      }
    }
  }
  let items = [], curves = [], facts = [];
  try { facts = deriveFacts(root, S); } catch (e) { errors.push(fail(e, root)); }
  S.buildRelations(facts);

  // —— 语义层：概念 → 样式 → 检查（都在求解之后，可以使用空间事实）——
  const evalTop = (ast) => evalAst(ast, { env: semantic, node: root, scope: root, frame: root, S });
  for (const pt of elab.patterns) semantic.setLazy(pt.name, () => matchPattern(pt, semantic, root, S));
  const patterns = [];
  for (const pt of elab.patterns) {
    try {
      const v = semantic.lookup(pt.name, S).v;
      for (const m of v.matches) for (const [r, val] of m) for (const n of isSet(val) ? val.nodes : [val]) (n.concepts ??= []).push(`${pt.name}.${r}`);
      patterns.push({
        name: pt.name, line: pt.line, roles: pt.roles.map((r) => r.name + (r.set ? '*' : '')),
        matches: v.matches.map((m) => Object.fromEntries([...m].map(([r, val]) => [r, isSet(val) ? val.nodes.map((n) => n.path) : val.path]))),
      });
    } catch (e) { errors.push(fail(e, { line: pt.line })); patterns.push({ name: pt.name, line: pt.line, roles: [], matches: [], error: e.message }); }
  }
  const concepts = [];
  for (const c of elab.concepts) {
    try {
      const set = asSet(semantic.lookup(c.name, S).v);
      for (const m of set.nodes) (m.concepts ??= []).push(c.name);
      concepts.push({ name: c.name, line: c.line, src: c.src, members: set.nodes.map((m) => m.path) });
    } catch (e) { errors.push(fail(e, { line: c.line })); concepts.push({ name: c.name, line: c.line, src: c.src, members: [], error: e.message }); }
  }
  S.styleMap = new Map();
  for (const st of elab.styles) {
    try {
      const set = asSet(evalTop(st.sel));
      let m = null;
      for (const [k, ast] of st.props) {
        if (k === 'color') m = { ...m, color: String(evalTop(ast)) };
        else if (k === 'mat') {
          const name = ast.k === 'path' && ast.segs.length === 1 ? ast.segs[0] : null;
          if (!materials.has(name)) throw new S3DError(`未定义的材质 ${name}`);
          m = { name, ...materials.get(name) };
        } else throw new S3DError(`style 目前只支持 mat 和 color，不认识 ${k}`);
      }
      // 后写的样式覆盖先写的；作用于成员及其所有下级（变体自己写了材质的部分除外）
      const mark = (n) => { if (n.skin) return; S.styleMap.set(n, m); n.children.forEach(mark); };
      set.nodes.forEach(mark);
    } catch (e) { errors.push(fail(e, { line: st.line })); }
  }
  const checks = [];
  for (const c of elab.checks) {
    const label = c.msg ?? c.src;
    try {
      const v = evalTop(c.ast);
      if (setLike(v)) {
        const bad = asSet(v).nodes;
        checks.push({ line: c.line, message: label, ok: bad.length === 0, violators: bad.map((m) => m.path) });
      } else checks.push({ line: c.line, message: label, ok: asBool(v), violators: [] });
    } catch (e) { checks.push({ line: c.line, message: label, ok: false, violators: [], error: e.message }); }
  }

  // 第一遍：按语义决定哪些对象换成哪个变体（后写的覆盖先写的）
  let nextPlan = null;
  if (!plan && elab.variants.length) {
    nextPlan = new Map();
    elab.variants.forEach((st, i) => {
      try { for (const n of asSet(evalTop(st.sel)).nodes) nextPlan.set(n.path, i); }
      catch (e) { errors.push(fail(e, { line: st.line })); }
    });
    if (!nextPlan.size) nextPlan = null;
  }

  try { ({ items, curves } = buildItems(root, S, materials)); } catch (e) { errors.push(fail(e, root)); }
  const order = [];
  const dfs = (n) => { if (n !== root) order.push(n); n.children.forEach(dfs); };
  dfs(root);
  const nodes = order.map((n) => ({
    path: n.path,
    kind: n.template ? n.template : n.inst ? 'instance' : n.src ? `${n.kind}→${K(n)}` : n.copyOf ? n.copyOf.container.kind : K(n),
    id: n.id, tags: n.tags, concepts: n.concepts ?? [], line: n.line,
    depth: n.path.split('.').length - 1, late: !!n.late, ghost: !!n.ghostOf, curve: CURVES.has(K(n)), hidden: !!n.hidden, skin: !!n.skin,
    world: n._world ?? null, box: n._world && n._box ? transformBox(n._world, n._box) : null,
  }));
  errors.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  if (!plan && !nextPlan) for (const st of elab.variants) variantSummary.push({ line: st.line, use: st.use, src: st.src, members: [] });
  return {
    plan: nextPlan,
    result: {
      items, curves, facts, nodes, concepts, patterns, variants: variantSummary, checks, defs: [...defs.keys()], materials: Object.fromEntries(materials),
      errors: errors.map((e) => ({ line: e.line ?? null, message: e.message })),
    },
  };
}
