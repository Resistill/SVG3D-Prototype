// 编译 Worker：编辑器的重新编译放到这里，几千个物体的工程（宿舍区编译几百毫秒）打字时界面也不卡。
// s3d.js 不 import 任何东西，普通的模块 Worker 就能加载（不需要 import map）。
// 消息：{ id, src, opts: { file, files: {路径: 文本}, factProviders, factEps, … } } → { id, ok, result, ms } 或 { id, ok: false, error }
// 结果是普通对象（数组、数字、字符串），结构化克隆回主线程；渲染仍在主线程
import { compile } from './s3d.js';

self.onmessage = ({ data }) => {
  const { id, src, opts = {} } = data;
  const t0 = performance.now();
  try {
    const { files = {}, ...rest } = opts;
    const result = compile(src, { ...rest, resolve: (p) => files[p] });
    postMessage({ id, ok: true, result, ms: performance.now() - t0 });
  } catch (e) {
    postMessage({ id, ok: false, error: String(e?.stack ?? e) });
  }
};
