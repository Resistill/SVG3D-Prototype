// 网格表面的高度：编译选项 heightAt(src, x, z) 的实现（B.top[u,w] 落在网格的真实表面上，而不是包围盒的顶面）。
// src 是 mesh 语句的 "文件#节点"，按节点名找源部件（与 worldtris.mjs 的 sceneObjects 同一套名字）；x、z 在源文件坐标里。
// 每个部件第一次被问到时，三角形按 xz 包围盒放进格网；竖直线穿过的三角形里取最高的交点，没有就 null
import { sourceIndex } from './worldtris.mjs';

export function heightField(sourceParts) {
  const byName = sourceIndex(sourceParts), grids = new Map();
  const gridOf = (part) => {
    let G = grids.get(part);
    if (G) return G;
    const T = part.tris, n = T.length;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const t of T) for (const v of t) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); z0 = Math.min(z0, v[2]); z1 = Math.max(z1, v[2]); }
    const N = Math.max(1, Math.ceil(Math.sqrt(n / 2))), cx = (x1 - x0) / N || 1, cz = (z1 - z0) / N || 1;
    const cells = new Map();
    T.forEach((t, k) => {
      const i0 = Math.floor((Math.min(t[0][0], t[1][0], t[2][0]) - x0) / cx), i1 = Math.floor((Math.max(t[0][0], t[1][0], t[2][0]) - x0) / cx);
      const j0 = Math.floor((Math.min(t[0][2], t[1][2], t[2][2]) - z0) / cz), j1 = Math.floor((Math.max(t[0][2], t[1][2], t[2][2]) - z0) / cz);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const key = i * 65536 + j; const l = cells.get(key); if (l) l.push(k); else cells.set(key, [k]); }
    });
    grids.set(part, (G = { T, x0, z0, cx, cz, cells }));
    return G;
  };
  return (src, x, z) => {
    const part = byName.get(String(src).split('#').pop());
    if (!part) return null;
    const G = gridOf(part), l = G.cells.get(Math.floor((x - G.x0) / G.cx) * 65536 + Math.floor((z - G.z0) / G.cz));
    if (!l) return null;
    let best = null;
    for (const k of l) {
      const [a, b, c] = G.T[k];
      // xz 平面里的重心坐标
      const den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
      if (Math.abs(den) < 1e-18) continue;
      const l1 = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den, l2 = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const y = l1 * a[1] + l2 * b[1] + l3 * c[1];
      if (best === null || y > best) best = y;
    }
    return best;
  };
}
