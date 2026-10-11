// 角色（tools/roles.mjs）在编译结果上的读法：物体的 ~role 元数据，沿路径向上继承（阵列成员、组里的块跟着容器），没有就是结构。
// 界面的显示开关、离屏渲染的 --only 共用
export const ROLE_LABELS = { structure: '结构', decor: '装饰', terrain: '地形', decal: '贴花', helper: '辅助' };
export const ROLE_ORDER = ['structure', 'terrain', 'decor', 'decal', 'helper'];

export function nodeRoles(result) {
  const m = new Map(result.nodes.map((n) => [n.path, n.meta?.role]));
  const memo = new Map();
  return (path) => {
    if (memo.has(path)) return memo.get(path);
    let r = null;
    for (let p = path; p && !r; p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : '') r = m.get(p) ?? null;
    r = r ?? 'structure';
    memo.set(path, r);
    return r;
  };
}
