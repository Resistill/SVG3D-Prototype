// 离屏渲染（零依赖）：给多模态模型“看”场景，也给人和 AI 一个共同的参照图。
// 纯 JS 的 z-buffer 光栅化 + 自写的 PNG 编码器。相机预设与预览器（src/render.js 的 frame）一致，
// 人在界面里看到的与 AI 看到的是同一个视角。
//   模式 color：按材质颜色平头着色；id：每个物体一种颜色（图例给出颜色 → 路径）；
//        labels：color 图上在每个物体可见部分的中心标出编号（图例给出编号 → 路径）
import { deflateSync } from 'node:zlib';

export const VIEWS = {
  iso: [0.75, 0.55, 0.9], iso2: [-0.75, 0.55, -0.9], top: [0, 1, 0.0001], front: [0, 0.25, 1], back: [0, 0.25, -1], left: [-1, 0.25, 0], right: [1, 0.25, 0],
};

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const hexRGB = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h)); const n = m ? parseInt(m[1], 16) : 0xc9c9c9; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// 包围盒取景：与预览器相同（整体 1.6 倍半径，聚焦 2.4 倍）；正交相机按包围球取景
export function camera(box, view = 'iso', focus = false) {
  const d = unit(VIEWS[view] ?? VIEWS.iso);
  const c = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2);
  const r = Math.max(Math.hypot(...sub(box.max, box.min)) / 2, 2);
  const eye = c.map((x, k) => x + d[k] * r * (focus ? 2.4 : 1.6));
  return { eye, target: c, fov: 45, near: 0.1, r };
}

// 误差 → 颜色（0 绿 → 0.5 黄 → 1 红）
export const heatColor = (t) => { t = Math.max(0, Math.min(1, t)); return t < 0.5 ? [Math.round(60 + 390 * t), 190, 70] : [235, Math.round(190 - 300 * (t - 0.5)), 60]; };

// objects：[{ path, pos: Float32Array（每 9 个数一个三角形，世界坐标）, color }]
// objects 可以带 heat（0..1），mode=error 时按它上色（没有 heat 的物体画成浅灰）
// box：指定取景范围（不指定就按聚焦的物体或整个场景）；返回值里的 box 可以原样传给下一次渲染，两张图取景完全一致
// ortho：正交相机（尺寸不随深度变化，便于量）
export function rasterize(objects, { view = 'iso', size = 1024, focus = null, mode = 'color', highlight = null, box: frameBox = null, ortho = false } = {}) {
  const W = size, H = size;
  let box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const grow = (b, p) => { for (let k = 0; k < 3; k++) { b.min[k] = Math.min(b.min[k], p[k]); b.max[k] = Math.max(b.max[k], p[k]); } };
  const focusSet = focus ? new Set([].concat(focus)) : null;
  const inFocus = (path) => !focusSet || [...focusSet].some((f) => path === f || path.startsWith(f + '.'));
  for (const o of objects) if (inFocus(o.path)) for (let i = 0; i < o.pos.length; i += 3) grow(box, [o.pos[i], o.pos[i + 1], o.pos[i + 2]]);
  if (!Number.isFinite(box.min[0])) box = { min: [-1, -1, -1], max: [1, 1, 1] };
  if (frameBox) box = frameBox;
  const cam = camera(box, view, !!focus);
  const fwd = unit(sub(cam.target, cam.eye));
  const right = unit(cross(fwd, Math.abs(fwd[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0]));
  const up = cross(right, fwd);
  const f = 1 / Math.tan((cam.fov * Math.PI) / 360);
  const light = unit([0.4 * right[0] + 0.8 * up[0] - 0.5 * fwd[0], 0.4 * right[1] + 0.8 * up[1] - 0.5 * fwd[1], 0.4 * right[2] + 0.8 * up[2] - 0.5 * fwd[2]]);
  const zbuf = new Float32Array(W * H).fill(Infinity);
  const rgb = new Uint8Array(W * H * 3);
  const ids = new Int32Array(W * H).fill(-1);
  // 背景：浅灰渐变
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const g = 236 - Math.round((18 * y) / H); rgb.set([g, g, g + 3], (y * W + x) * 3); }
  const hl = highlight ? new Set([].concat(highlight)) : null;
  const isHl = (path) => hl && [...hl].some((h) => path === h || path.startsWith(h + '.'));
  const half = cam.r * 1.08; // 正交相机的半视野
  const proj = ortho
    ? (p) => { const v = sub(p, cam.eye); return [W / 2 + (dot(v, right) / half) * (W / 2), H / 2 - (dot(v, up) / half) * (H / 2), dot(v, fwd)]; }
    : (p) => { const v = sub(p, cam.eye), z = dot(v, fwd); return [W / 2 + (dot(v, right) * f * W) / (2 * z), H / 2 - (dot(v, up) * f * H) / (2 * z), z]; };
  // 聚焦时画两遍：先画背景（变淡），再用一个新的深度缓冲把被聚焦的物体画在最上面——不会被别的东西挡住
  const order = objects.map((o, id) => id);
  const passes = focusSet ? [order.filter((id) => !inFocus(objects[id].path)), order.filter((id) => inFocus(objects[id].path))] : [order];
  passes.forEach((pass, pi) => {
  if (pi > 0) zbuf.fill(Infinity);
  for (const id of pass) {
    const o = objects[id];
    const base = mode === 'id' ? idColor(id) : mode === 'error' ? (o.heat == null ? [205, 205, 205] : heatColor(o.heat)) : hexRGB(o.color);
    const dim = focusSet && !inFocus(o.path);
    for (let i = 0; i < o.pos.length; i += 9) {
      const a = [o.pos[i], o.pos[i + 1], o.pos[i + 2]], b = [o.pos[i + 3], o.pos[i + 4], o.pos[i + 5]], c = [o.pos[i + 6], o.pos[i + 7], o.pos[i + 8]];
      const P = [proj(a), proj(b), proj(c)];
      if (P.some((q) => q[2] < cam.near)) continue; // 跨过近平面的三角形直接丢弃（相机在场景外，影响很小）
      const n = unit(cross(sub(b, a), sub(c, a)));
      const shade = mode === 'id' ? 1 : 0.42 + 0.58 * Math.abs(dot(n, light));
      let col = base.map((x) => Math.min(255, Math.round(x * shade)));
      if (mode !== 'id' && isHl(o.path)) col = [Math.min(255, col[0] * 0.5 + 255 * 0.5), Math.min(255, col[1] * 0.5 + 170 * 0.5), col[2] * 0.4];
      if (mode !== 'id' && dim) col = col.map((x) => Math.round(x * 0.35 + 236 * 0.65));
      const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0]))), maxX = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
      const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1]))), maxY = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
      if (minX > maxX || minY > maxY) continue;
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-12) continue;
      // 透视正确的深度：对 1/z 做重心插值（正交相机直接插值 z）
      const iz = P.map((q) => (ortho ? q[2] : 1 / q[2]));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area;
        const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const zi = w0 * iz[0] + w1 * iz[1] + w2 * iz[2], z = ortho ? zi : 1 / zi;
        const k = y * W + x;
        if (z >= zbuf[k]) continue;
        zbuf[k] = z; ids[k] = id; rgb.set(col, k * 3);
      }
    }
  }
  });
  // 轮廓：相邻像素属于不同物体时描深一点，物体边界更清楚
  if (mode !== 'id') for (let y = 1; y < H; y++) for (let x = 1; x < W; x++) {
    const k = y * W + x;
    if (ids[k] >= 0 && (ids[k] !== ids[k - 1] || ids[k] !== ids[k - W])) for (let j = 0; j < 3; j++) rgb[k * 3 + j] = Math.round(rgb[k * 3 + j] * 0.6);
  }
  const legend = [];
  if (mode === 'id') objects.forEach((o, id) => legend.push({ color: '#' + idColor(id).map((x) => x.toString(16).padStart(2, '0')).join(''), path: o.path }));
  if (mode === 'labels') {
    // 每个物体可见像素的中心；可见像素太少的不标
    const acc = new Map();
    // 聚焦时只标被聚焦的物体（背景只作参照）
    for (let k = 0; k < W * H; k++) if (ids[k] >= 0 && inFocus(objects[ids[k]].path)) { const a = acc.get(ids[k]) ?? [0, 0, 0]; a[0] += k % W; a[1] += Math.floor(k / W); a[2]++; acc.set(ids[k], a); }
    // 标签去重叠：按可见面积从大到小放；和已放的标签重叠就在物体自己的像素里就近挪位，放不下就不标（图例里 labeled=false）
    let n = 0;
    const placed = [];
    const rectOf = (x, y, num) => { const w = String(num).length * 12 + 4, h = 18; return [x - w / 2 - 2, y - h / 2 - 2, x + w / 2 + 2, y + h / 2 + 2]; };
    const overlaps = (r) => placed.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
    for (const [id, [sx, sy, c]] of [...acc].sort((p, q) => q[1][2] - p[1][2])) {
      if (c < 40) continue;
      n++;
      const cx = Math.round(sx / c), cy = Math.round(sy / c);
      let spot = null;
      for (let rad = 0; rad <= 60 && !spot; rad += 6) for (let a = 0; a < (rad ? 16 : 1) && !spot; a++) {
        const x = Math.round(cx + rad * Math.cos((a * Math.PI) / 8)), y = Math.round(cy + rad * Math.sin((a * Math.PI) / 8));
        if (x < 0 || y < 0 || x >= W || y >= H || ids[y * W + x] !== id) continue;
        const r = rectOf(x, y, n);
        if (!overlaps(r)) spot = { x, y, r };
      }
      if (spot) { placed.push(spot.r); drawNumber(rgb, W, H, spot.x, spot.y, n); }
      legend.push({ n, path: objects[id].path, pixels: c, ...(spot ? {} : { labeled: false }) });
    }
  }
  return { png: encodePNG(rgb, W, H), legend, camera: cam, box: { min: box.min.map((v) => +v.toFixed(4)), max: box.max.map((v) => +v.toFixed(4)) } };
}

// 物体编号 → 互相区分度高的颜色（黄金角色相）
function idColor(i) {
  const h = (i * 137.508) % 360, s = 0.65, l = 0.5 + 0.12 * ((i % 3) - 1);
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
}

// 5×7 点阵数字（放大 2 倍），白底黑字，便于模型读
const DIGITS = ['01110100011001110101110011000101110', '00100011000010000100001000010001110', '01110100010000100010001000100011111', '11111000100010000010000011000101110', '00010001100101010010111110001000010', '11111100001111000001000011000101110', '00110010001000011110100011000101110', '11111000010001000100010000100001000', '01110100011000101110100011000101110', '01110100011000101111000010001001100'];
function drawNumber(rgb, W, H, cx, cy, n) {
  const s = String(n), sc = 2, cw = 6 * sc, w = s.length * cw + 2 * sc, h = 7 * sc + 4 * sc;
  const x0 = Math.round(cx - w / 2), y0 = Math.round(cy - h / 2);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) rgb.set(c, (y * W + x) * 3); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) put(x0 + x, y0 + y, y === 0 || x === 0 || y === h - 1 || x === w - 1 ? [30, 30, 30] : [255, 255, 255]);
  [...s].forEach((ch, i) => {
    const bits = DIGITS[+ch];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (bits[r * 5 + c] === '1')
      for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) put(x0 + 2 * sc + i * cw + c * sc + dx, y0 + 2 * sc + r * sc + dy, [20, 20, 20]);
  });
}

// PNG（8 位 RGB，无滤波）
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function encodePNG(rgb, W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
