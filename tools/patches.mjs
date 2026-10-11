// 面片：把一个部件的三角形按“流形边”连通拆开。几个基本体的网格直接拼在一起（合批、或者共用顶点焊在一起）时，
// 它们相交的那圈边上挂着三个以上的三角形（非流形边）——在这些边上断开，每个基本体的网格就落成一块或几块面片
// （罐：圆柱的侧面连底面、圆柱的顶盖、球的上半、球的下半）。只看拓扑，不认具体的形状；把面片重新拼成基本体由调用方按拟合误差做。
//   tris：[[a, b, c], …]；scale：顶点焊接的取整倍数（坐标 × scale 取整相同的顶点算一个）
// 返回 { patches: [[三角形编号…]…]（按面积从大到小）, adj: [Set(相邻面片编号)…]（共用一个顶点就算相邻）, closed: [是否封闭…] }
// 封闭：面片里每条边都正好挂两个三角形（一个完整的实体，不必再和别的面片拼）
export function patchesOf(tris, scale = 1e4) {
  // 焊接：取整后的三个整数按开放寻址的哈希表查（比字符串键快得多）
  const n = tris.length, ids = new Int32Array(3 * n);
  let cap = 16;
  while (cap < 6 * n) cap *= 2;
  const table = new Int32Array(cap).fill(-1), keys = new Float64Array(9 * n);
  let V = 0;
  for (let t = 0; t < n; t++) for (let i = 0; i < 3; i++) {
    const v = tris[t][i], x = Math.round(v[0] * scale) + 0, y = Math.round(v[1] * scale) + 0, z = Math.round(v[2] * scale) + 0;
    let h = ((Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) >>> 0) & (cap - 1), id = -1;
    for (let j; (j = table[h]) >= 0; h = (h + 1) & (cap - 1)) if (keys[3 * j] === x && keys[3 * j + 1] === y && keys[3 * j + 2] === z) { id = j; break; }
    if (id < 0) { id = V++; table[h] = id; keys[3 * id] = x; keys[3 * id + 1] = y; keys[3 * id + 2] = z; }
    ids[3 * t + i] = id;
  }
  // 重合的三角形（两个基本体共用的一块面：上一级的顶盖与下一级的底盖）只按第一个算边，其余跟着它归进同一块面片
  // 退化的三角形（两个顶点焊成一个：合批时被压扁的端盖）不算边、不成面片，只把它碰到的面片连成相邻
  const edges = new Map(), dupOf = new Int32Array(n).fill(-1), seen = new Map();
  const degen = (t) => ids[3 * t] === ids[3 * t + 1] || ids[3 * t + 1] === ids[3 * t + 2] || ids[3 * t] === ids[3 * t + 2];
  for (let t = 0; t < n; t++) {
    if (degen(t)) { dupOf[t] = -2; continue; }
    const k = [ids[3 * t], ids[3 * t + 1], ids[3 * t + 2]].sort((x, y) => x - y).join();
    if (seen.has(k)) dupOf[t] = seen.get(k); else seen.set(k, t);
  }
  for (let t = 0; t < n; t++) if (dupOf[t] < 0) for (let i = 0; i < 3; i++) {
    const a = ids[3 * t + i], b = ids[3 * t + (i + 1) % 3];
    if (a === b) continue;
    const k = a < b ? a * V + b : b * V + a;
    const l = edges.get(k);
    if (l) l.push(t); else edges.set(k, [t]);
  }
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  for (const l of edges.values()) if (l.length === 2) { const a = find(l[0]), b = find(l[1]); if (a !== b) parent[a] = b; }
  const byRoot = new Map();
  for (let t = 0; t < n; t++) if (dupOf[t] >= 0) parent[t] = dupOf[t];
  for (let t = 0; t < n; t++) { if (dupOf[t] === -2) continue; const r = find(t); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(t); }
  const area = (t) => { const [a, b, c] = tris[t], u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2; };
  const patches = [...byRoot.values()].map((ts) => ({ ts, a: ts.reduce((s, t) => s + area(t), 0) })).sort((x, y) => y.a - x.a || x.ts[0] - y.ts[0]).map((p) => p.ts);
  const of = new Int32Array(n).fill(-1);
  patches.forEach((ts, k) => { for (const t of ts) of[t] = k; });
  // 相邻：共用一个顶点
  const byV = new Map(), adj = patches.map(() => new Set());
  for (let t = 0; t < n; t++) for (let i = 0; i < 3; i++) {
    const v = ids[3 * t + i], k = of[t], s = byV.get(v);
    if (k < 0) continue;
    if (!s) byV.set(v, new Set([k])); else s.add(k);
  }
  const link = (s) => { if (s.size > 1) for (const a of s) for (const b of s) if (a !== b) adj[a].add(b); };
  for (const s of byV.values()) link(s);
  for (let t = 0; t < n; t++) if (of[t] < 0) link(new Set([0, 1, 2].flatMap((i) => [...(byV.get(ids[3 * t + i]) ?? [])])));
  const open = new Uint8Array(patches.length);
  for (const l of edges.values()) if (l.length !== 2) for (const t of l) open[of[t]] = 1;
  return { patches, adj, closed: patches.map((_, k) => !open[k]) };
}
