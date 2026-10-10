// 浏览器内逆向（docs/PLAN2.md 4.8）：在 Worker 里读 GLB、跑 reverse()，界面不卡。
// 由 src/shim-worker.js 经 es-module-shims 加载（模块 Worker 不认页面的 import map，tools/*.mjs 里有 'three'、'node:fs' 这类裸名字）
// 消息：{ id, buffer, name, fidelity, unit, split } → { id, ok, src, report, parts, ms } 或 { id, ok: false, error }
import { reverseGlb } from './reverse-glb.js';

self.onmessage = async ({ data }) => {
  const { id, buffer, ...opts } = data;
  const t0 = performance.now();
  try {
    const { src, report, parts } = await reverseGlb(new Uint8Array(buffer), opts);
    postMessage({ id, ok: true, src, report, parts, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    postMessage({ id, ok: false, error: String(e?.stack ?? e) });
  }
};
postMessage({ type: 'ready' });
