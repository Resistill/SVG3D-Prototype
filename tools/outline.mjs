// 分层概要：给 AI 阅读大场景的入口。按结构（组、模板、阵列、镜像）分层，每行给出：
// 名字、类型、尺寸、包含多少实体、识别出的概念、主要关系（它立在什么上面 / 贴着什么）。
// 阵列与镜像折叠成一行，所以概要的长度随结构复杂度增长，而不是随物体数量增长。
const r1 = (x) => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(1)).replace(/\.0$/, '');

export function outline(result, { depth = 2 } = {}) {
  const nodes = result.nodes;
  const byPath = new Map(nodes.map((n) => [n.path, n]));
  const children = new Map();
  for (const n of nodes) {
    const parent = n.path.includes('.') ? n.path.slice(0, n.path.lastIndexOf('.')) : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(n);
  }
  const leafKinds = new Set(['box', 'cyl', 'cone', 'sphere', 'wedge', 'revolve', 'span', 'sweep', 'pipe', 'mesh', 'union', 'subtract', 'intersect']);
  const items = new Set(result.items.map((i) => i.path));
  const under = (p) => result.items.filter((i) => i.path === p || i.path.startsWith(p + '.')).length;
  // 主要关系：这个节点（或它里面的物体）与外部物体之间最强的一条
  const rank = { on: 0, against: 1, inside: 2, touching: 3, intersects: 4 };
  const relOf = (p) => {
    const inside = (x) => x === p || x.startsWith(p + '.');
    const fs = result.facts.filter((f) => inside(f.a) && !inside(f.b) && f.rel !== 'intersects').sort((a, b) => rank[a.rel] - rank[b.rel]);
    if (!fs.length) return '';
    const f = fs[0];
    const tail = f.text.slice(f.text.indexOf(' ' + f.rel + ' ') + f.rel.length + 2);
    return `${f.rel} ${tail}`;
  };
  const size = (n) => {
    const b = n.tight ?? n.box;
    return b ? `${r1(b.max[0] - b.min[0])}×${r1(b.max[1] - b.min[1])}×${r1(b.max[2] - b.min[2])}` : '';
  };
  const lines = [];
  const walk = (parent, d) => {
    for (const n of children.get(parent) ?? []) {
      if (n.kind === 'instance') continue;
      const name = n.path.split('.').pop();
      const kids = (children.get(n.path) ?? []).filter((c) => c.kind !== 'instance');
      const inst = (children.get(n.path) ?? []).filter((c) => c.kind === 'instance');
      let desc = n.kind;
      const count = under(n.path);
      if (n.kind === 'repeat') {
        const first = inst[0];
        const parts = first ? (children.get(first.path) ?? []).map((c) => c.path.split('.').pop()) : [];
        desc = `repeat ×${inst.length} [${parts.join(', ')}]`;
      } else if (/^mirror→|^rotate→/.test(n.kind)) desc = `${n.kind.split('→')[0]} 副本（${n.kind.split('→')[1]}）`;
      else if (n.kind === 'rotate' || n.kind === 'mirror') desc = `${n.kind} 对称组`;
      else if (n.types && n.types.length) desc = n.types.join(' : ');
      const tags = [...(n.tags ?? []).map((t) => '#' + t), ...(n.concepts ?? [])].join(' ');
      const rel = relOf(n.path);
      const isLeaf = leafKinds.has(n.kind) || items.has(n.path);
      lines.push(`${'  '.repeat(d)}${name}  ${desc}  ${size(n)}${!isLeaf && count ? `  ${count} 个实体` : ''}${rel ? `  · ${rel}` : ''}${tags ? `  〔${tags}〕` : ''}`);
      // 阵列与副本折叠：不展开实例；其余容器按深度展开
      const collapse = n.kind === 'repeat' || n.ghost || /→/.test(n.kind);
      if (!collapse && kids.length && d + 1 < depth) walk(n.path, d + 1);
      else if (!collapse && kids.length) lines.push(`${'  '.repeat(d + 1)}…（${kids.length} 个下级）`);
    }
  };
  walk('', 0);
  return lines.join('\n');
}
