// 角色（tools/roles.mjs）在编译结果上的读法：物体的 ~role 元数据，沿路径向上继承（阵列成员、组里的块跟着容器），没有就是结构。
// 界面的显示开关、离屏渲染的 --only 共用
export const ROLE_LABELS = { structure: '结构', decor: '装饰', terrain: '地形', decal: '贴花', collision: '碰撞', helper: '辅助' };
export const ROLE_ORDER = ['structure', 'terrain', 'decor', 'decal', 'collision', 'helper'];
// 看得见的角色：比对模糊图、默认的离屏渲染只画这些（碰撞块、辅助部件是看不见的）
export const VISIBLE_ROLES = new Set(['structure', 'terrain', 'decor', 'decal']);
// 碰撞块在界面里的画法：半透明红色（同 SpaceCenter 白盒预览里的 Blocker）
export const COLLISION_MAT = { name: null, color: '#e0464b', opacity: 0.28, metal: 0, rough: 1 };

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
