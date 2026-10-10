// 浏览器里的 node:module 替身：bin/node-hooks.mjs 的解析钩子只在 Node 里有意义（浏览器由 import map 指到 three-bvh-csg 的 ES 构建）
export function registerHooks() {}
export default { registerHooks };
