// 语义命名：源模型没有名字时（L1 / L2），逆向结果里的名字只是形状编号（box46、cyls_2、cyl_）。
// 这里把描述连同通用语义库一起编译，按每个物体识别出的概念改名：box46 → terrain，cyls_2 → columns，……
// 只改自动生成的名字；源模型自带的名字保持不变。改名是纯文本的：声明处的名字与所有引用（on= at= of= across= about=）一起改。
// 稳定命名：传入上一次的逆向结果（previous），几何上对得上的物体沿用上一次的名字，
// 这样源模型改动后重跑逆向，写在编辑层里的 over / drop 路径仍然命中。
import { compile } from '../src/s3d.js';
import { SEMANTICS } from './eval.mjs';

// 越靠前越具体：一个物体同时属于多个概念时取最前面的
const PRIORITY = ['terrain', 'step', 'roof', 'platform', 'slab', 'wall', 'tank', 'column', 'beam', 'member', 'volume', 'prop'];
const SHAPES = 'box|cyl|cone|sphere|wedge|mesh|revolve|sweep|span|pipe';
const AUTO_TOP = new RegExp(`^(${SHAPES})\\d+(_\\d+)?$`);
const AUTO_UNIT = new RegExp(`^(${SHAPES})s(_\\d+)?$`);
const AUTO_CHILD = new RegExp(`^(${SHAPES})_*$`);

// 读出声明结构：顶层声明、容器的子物体、副本来源
function parseDecls(lines) {
  const decls = [];
  const stack = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)([\p{L}_][\p{L}\p{N}_]*)\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(line);
    if (/^\s*\}/.test(line)) { stack.pop(); return; }
    if (!m || ['material', 'def', 'let', 'concept', 'import', 'drop', 'over'].includes(m[2])) return;
    const d = { i, kind: m[2], name: m[3], parent: stack.at(-1) ?? null, of: (/\sof=([\p{L}_][\p{L}\p{N}_]*)/u.exec(line) ?? [])[1] ?? null, children: [] };
    decls.push(d);
    if (d.parent) d.parent.children.push(d);
    if (/\{\s*$/.test(line)) stack.push(d);
  });
  return decls;
}

const iou = (a, b) => {
  if (!a || !b) return 0;
  const ov = [0, 1, 2].map((k) => Math.max(0, Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k])));
  const v = (x) => [0, 1, 2].reduce((s, k) => s * Math.max(1e-9, x.max[k] - x.min[k]), 1);
  const inter = ov[0] * ov[1] * ov[2];
  return inter / (v(a) + v(b) - inter);
};

export function semanticNames(text, { library = SEMANTICS, previous = null } = {}) {
  const r = compile(`${text}\n${library}`);
  if (r.errors.length) return { text, map: {}, renamed: 0 };
  const byPath = new Map(r.nodes.map((n) => [n.path, n]));
  const conceptOf = (n) => {
    const cs = new Set(n?.concepts ?? []);
    return PRIORITY.find((c) => cs.has(c)) ?? null;
  };
  const lines = text.split('\n');
  const decls = parseDecls(lines);
  const top = new Map(decls.filter((d) => !d.parent).map((d) => [d.name, d]));
  const unitOf = (d, seen = new Set()) => {
    if (!d || seen.has(d)) return null;
    seen.add(d);
    if (d.children.length) return d;
    return d.of ? unitOf(top.get(d.of), seen) : null;
  };
  // 一个容器里某个子物体的编译结果：阵列取第 0 个实例，旋转组取原件
  const childNode = (unit, child) => byPath.get(`${unit.name}.0.${child.name}`) ?? byPath.get(`${unit.name}.${child.name}`) ?? r.nodes.find((n) => n.path.startsWith(unit.name + '.') && n.path.endsWith('.' + child.name));
  // 第二遍：起名
  const childMaps = new Map();
  const baseOf = new Map();
  for (const d of decls.filter((x) => !x.parent)) {
    const u = unitOf(d);
    if (u && u === d) {
      const used = new Map();
      const cm = new Map();
      for (const c of d.children) {
        if (!AUTO_CHILD.test(c.name)) { cm.set(c.name, c.name); continue; }
        let b = conceptOf(childNode(d, c)) ?? c.kind;
        const k = (used.get(b) ?? 0) + 1;
        used.set(b, k);
        cm.set(c.name, k > 1 ? `${b}_${k}` : b);
      }
      childMaps.set(d, cm);
      if (AUTO_UNIT.test(d.name)) baseOf.set(d, `${cm.get(d.children[0].name)}s`);
    } else if (u) {
      // 阵列的副本（mirror X of=阵列）：沿用阵列的名字
      if (AUTO_TOP.test(d.name) || AUTO_UNIT.test(d.name)) baseOf.set(d, null);
    } else if (AUTO_TOP.test(d.name)) baseOf.set(d, conceptOf(byPath.get(d.name)) ?? d.name.replace(/\d+(_\d+)?$/, ''));
  }
  // 副本的名字跟着来源走（来源可能在后面才起好名）
  for (const d of decls.filter((x) => !x.parent && baseOf.get(x) === null)) {
    const src = top.get(d.of);
    baseOf.set(d, baseOf.get(src) ?? (src ? src.name : d.name));
  }
  // 沿用上一次的名字：同种声明、包围盒 IoU 最高的一对先配（贪心），容器的子物体按顺序对应
  const fixed = new Map();
  if (previous) {
    const P = compile(previous);
    const pLines = previous.split('\n');
    const pTop = parseDecls(pLines).filter((d) => !d.parent);
    const pBy = new Map(P.nodes.map((n) => [n.path, n]));
    const sig = (m, name) => { const n = m.get(name); return n?.tight ?? n?.box; };
    const pairs = [];
    for (const d of baseOf.keys()) for (const q of pTop) {
      if (q.kind !== d.kind) continue;
      const s = iou(sig(byPath, d.name), sig(pBy, q.name));
      if (s > 0.5) pairs.push([s, d, q]);
    }
    pairs.sort((a, b) => b[0] - a[0]);
    const taken = new Set();
    for (const [, d, q] of pairs) {
      if (fixed.has(d) || taken.has(q)) continue;
      fixed.set(d, q.name);
      taken.add(q);
      const cm = childMaps.get(d);
      if (cm && q.children.length === d.children.length && q.children.every((c, k) => c.kind === d.children[k].kind)) d.children.forEach((c, k) => cm.set(c.name, q.children[k].name));
    }
  }
  // 编号：同名的按出现顺序加 _1 _2 …；不与保留下来的、沿用的名字冲突
  const keep = new Set([...top.keys()].filter((n) => ![...baseOf.keys()].some((d) => d.name === n)));
  for (const n of fixed.values()) keep.add(n);
  const count = new Map();
  for (const [d, b] of baseOf) if (!fixed.has(d)) count.set(b, (count.get(b) ?? 0) + 1);
  const seen = new Map();
  const rename = new Map();
  for (const [d, b] of baseOf) {
    if (fixed.has(d)) { rename.set(d.name, fixed.get(d)); continue; }
    let name = b;
    if (count.get(b) > 1 || keep.has(b)) {
      let k = seen.get(b) ?? 0;
      do { k++; name = `${b}_${k}`; } while (keep.has(name));
      seen.set(b, k);
    }
    rename.set(d.name, name);
  }
  // 第三遍：改写声明与引用
  const ref = (path, scope) => {
    const segs = path.split('.');
    let cur;
    if (scope && childMaps.get(scope)?.has(segs[0])) { cur = null; segs[0] = childMaps.get(scope).get(segs[0]); return segs.join('.'); }
    const head = top.get(segs[0]);
    if (!head) return path;
    segs[0] = rename.get(segs[0]) ?? segs[0];
    cur = unitOf(head);
    for (let k = 1; k < segs.length; k++) {
      if (/^(\d+|r\d+)$/.test(segs[k])) continue;
      const cm = cur && childMaps.get(cur);
      if (cm?.has(segs[k])) segs[k] = cm.get(segs[k]);
    }
    return segs.join('.');
  };
  const byLine = new Map(decls.map((d) => [d.i, d]));
  const out = lines.map((line, i) => {
    const d = byLine.get(i);
    // drop / over 后面的路径（例如有缺位的阵列：drop columns.3）
    const dm = /^(\s*(?:drop|over)\s+)([\p{L}_][\p{L}\p{N}_.]*)(.*)$/u.exec(line);
    if (!d && dm) return dm[1] + ref(dm[2], null) + dm[3];
    if (!d) return line;
    const scope = d.parent;
    let s = line;
    const newName = scope ? childMaps.get(scope)?.get(d.name) ?? d.name : rename.get(d.name) ?? d.name;
    s = s.replace(/^(\s*\S+\s+)(\S+)/, (m, a) => a + newName);
    // 属性值里的引用：on=… at=… of=… across=… about=… against=…（字符串里的不动）
    return s.replace(/(\s(?:on|at|of|across|about|against|align|gap|offset)=)([\p{L}_][\p{L}\p{N}_.]*)/gu, (m, k, p) => k + ref(p, scope));
  });
  return { text: out.join('\n'), map: Object.fromEntries(rename), renamed: rename.size + [...childMaps.values()].reduce((s, m) => s + [...m].filter(([a, b]) => a !== b).length, 0) };
}
