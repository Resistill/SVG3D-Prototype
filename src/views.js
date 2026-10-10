// 相机预设：离屏渲染（tools/raster.mjs）与预览器（src/render.js 的 setView / snapshot）共用同一份，
// 人在界面里切到 iso 看到的，与 AI 用 render --view=iso 看到的是同一个视角（正方形画面时逐像素同一个取景）。
// 方向是“从目标指向相机”的向量；top 带一点 z，屏幕上方是 −z（与 raster 的做法一致，three.js 的 lookAt 也得到同样的朝向）
export const VIEWS = {
  iso: [0.75, 0.55, 0.9], iso2: [-0.75, 0.55, -0.9], top: [0, 1, 0.0001], front: [0, 0.25, 1], back: [0, 0.25, -1], left: [-1, 0.25, 0], right: [1, 0.25, 0],
};

const unit = (a) => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// 包围盒取景：与预览器的 frame 相同（整体 1.6 倍半径，聚焦 2.4 倍）；正交相机按包围球取景
export function camera(box, view = 'iso', focus = false) {
  const d = unit(VIEWS[view] ?? VIEWS.iso);
  const c = [0, 1, 2].map((k) => (box.min[k] + box.max[k]) / 2);
  const r = Math.max(Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2, 2);
  const eye = c.map((x, k) => x + d[k] * r * (focus ? 2.4 : 1.6));
  return { eye, target: c, fov: 45, near: 0.1, r };
}
