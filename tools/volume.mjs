// 体积误差（R_vol）：重建物体的实体里、源模型的实体外面的部分——实心的体块填满了空心楼的内部、坡道下面的空间。
// 表面误差（R_src、R_recon）看不见它：体块的外表面可以正好贴着楼的外墙，楼里的空气却被填实了（人、AI 都会以为那里走不进去）。
//
// 做法：在重建物体（封闭的三角形网格）的内部撒点；离源表面不到 δ 的点不计（贴着墙的那一层是表面误差的事），
// 在源模型实体里的点不计；其余的点按与表面误差相同的 log2(1 + (d − δ)/δ) 计价（d 封顶 dMax：越深入空处越贵）。
// 在不在源模型的实体里：从这一点沿 6 个轴向打射线，数每条射线穿出（背面）与穿入（正面）的次数，至少 5 条穿出得多
// （封闭网格法线朝外；几个封闭网格互相穿插——游戏模型里墙角常常这样——也对）。
// 只有一层、不封闭的源表面（单面的立面）从里面看也是背面，会被当成实体——宁可漏判，不冤枉。
// 薄的物体（体积 / 表面积 < δ：墙板、楼板）内部都离它自己的表面不到 δ，不撒点；网格引用（就是源网格本身）不算
import { rng } from './parts.mjs';

const RAYS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
// 轴向的射线恰好擦过三角形的边会算错奇偶：方向稍微歪一点
const TILT = [1, 1.3e-4, 2.7e-4];

// 封闭网格（三角形汤，每 9 个数一个三角形）的体积（散度定理，取绝对值）、表面积与包围盒
export function solidStats(pos) {
  let vol = 0, area = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let o = 0; o < pos.length; o += 9) {
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2], bx = pos[o + 3], by = pos[o + 4], bz = pos[o + 5], cx = pos[o + 6], cy = pos[o + 7], cz = pos[o + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    for (let j = 0; j < 9; j++) { const k = j % 3, x = pos[o + j]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
  }
  return { vol: Math.abs(vol), area, lo, hi };
}

// 点在不在封闭网格里：沿（稍歪的）+x 方向的射线与三角形相交的次数是奇数
function insideMesh(pos, x, y, z) {
  const [dx, dy, dz] = TILT;
  let n = 0;
  for (let o = 0; o < pos.length; o += 9) {
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const e1x = pos[o + 3] - ax, e1y = pos[o + 4] - ay, e1z = pos[o + 5] - az, e2x = pos[o + 6] - ax, e2y = pos[o + 7] - ay, e2z = pos[o + 8] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det, sx = x - ax, sy = y - ay, sz = z - az, u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0) n++;
  }
  return n % 2 === 1;
}

// 一个重建物体的内部采样：{ vol, pts（扁平）}；薄的、不封闭（体积几乎为零）的返回 null。
// 包围盒里均匀撒点、留下在网格里的，最多 n 个、最多撒 8n 个；种子由调用方给（评分按路径取，与表面采样一样）
export function interiorSamples(pos, k, seed, n = 24) {
  if (pos.length < 36) return null;
  const { vol, area, lo, hi } = solidStats(pos);
  if (!(vol > 0) || vol / area < k.delta) return null;
  const r = rng(seed), out = [];
  for (let m = 0; m < 8 * n && out.length < 3 * n; m++) {
    const x = lo[0] + r() * (hi[0] - lo[0]), y = lo[1] + r() * (hi[1] - lo[1]), z = lo[2] + r() * (hi[2] - lo[2]);
    if (insideMesh(pos, x, y, z)) out.push(x, y, z);
  }
  return out.length ? { vol, pts: Float64Array.from(out) } : null;
}

// 在不在源模型的实体里（q：源表面的查询对象，nearest.mjs 的 nearestQuery）
export function insideSource(q, x, y, z) {
  let other = 0;
  for (const [a, b, c] of RAYS) {
    // 同 insideMesh：方向稍微歪一点，免得恰好擦过边
    if (q.crossings(x, y, z, a || TILT[1], b || TILT[2], c || TILT[1]) <= 0) other++;
    if (other > 1) return false; // 已经有两条不是穿出得多
  }
  return true;
}

// 一组内部点的平均代价（k 已换算成场景单位：delta、dMax）
export const volumeResidual = (pts, q, k) => volumeStats(pts, q, k).r;
// 同上，另给错填的比例 wrong（离源表面超过 δ、又不在源模型实体里的点占多少）：逆向判“实心体块把空的地方填实了”用
export function volumeStats(pts, q, k) {
  const n = pts.length / 3;
  if (!n || !q) return { r: 0, wrong: 0 };
  let sum = 0, bad = 0;
  for (let j = 0; j < n; j++) {
    const x = pts[3 * j], y = pts[3 * j + 1], z = pts[3 * j + 2];
    q.closest(x, y, z, k.dMax);
    const d = Math.min(q.distance, k.dMax);
    if (d <= k.delta || insideSource(q, x, y, z)) continue;
    sum += Math.log2(1 + (d - k.delta) / k.delta);
    bad++;
  }
  return { r: sum / n, wrong: bad / n };
}
