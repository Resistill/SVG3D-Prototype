// 浏览器（Worker）里的 node:fs 替身：工具模块加载时读的静态文件（tools/eval.mjs 读 lib/semantics.s3d）用同步 XHR 取回
// （Worker 里允许同步 XHR）；写文件没有意义，一律报错
const get = (path) => {
  const url = String(path instanceof URL ? path.href : path);
  const x = new XMLHttpRequest();
  x.open('GET', url, false);
  x.send();
  if (x.status !== 200) throw new Error(`ENOENT：读不到 ${url}（${x.status}）`);
  return x.responseText;
};
export function readFileSync(path) { return get(path); }
export function existsSync(path) { try { get(path); return true; } catch { return false; } }
const no = (name) => () => { throw new Error(`浏览器里不能 ${name}`); };
export const writeFileSync = no('writeFileSync'), mkdirSync = no('mkdirSync'), readdirSync = no('readdirSync');
export default { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync };
