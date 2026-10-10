// Node 下加载共享几何模块的准备：three-bvh-csg 的默认入口是 CommonJS 构建，在 Node 里会触发
// three-mesh-bvh 的循环依赖问题；改用它的 ES 模块源码（浏览器端由 import map 指向 ES 构建）。
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'three-bvh-csg') return next('three-bvh-csg/src/index.js', context);
    return next(specifier, context);
  },
});
