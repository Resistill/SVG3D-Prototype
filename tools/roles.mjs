// 角色：每个源部件是什么——结构（楼的墙、楼梯、平台、围栏、门）、装饰（家具、灯具、标牌、植被、车……）、地形（地面、路面）、
// 贴花（贴在别的表面上的薄片）、碰撞（隐形挡墙、空气墙：看不见，但决定人能走到哪里）、辅助（白模体积、雾、触发区：不是场景里的东西）。
// 逆向按角色取舍写法（装饰写成基本体代理或网格引用，不做板件这类花时间的拆解；贴花保留网格引用、不当别人的参照物；
// 碰撞照常拟合成基本体、但不当别人的参照物，辅助不写进几何），写成 ~role= 元数据；界面、渲染可以只显示某几种角色
// （碰撞默认画成半透明红色，可以关掉；比对模糊图只比看得见的），评分分角色报。
//
// 判定顺序：工程目录里的 roles.json（规则数组，先匹配先生效）→ 名字里的词 → 几何。
//   roles.json 的规则：{ role, name?: 正则（完整节点名，含分组路径）, material?: 正则, meta?: { 旁路表的列: 正则 } }
//   名字里的词：节点名的最后一段按下划线、数字、大小写切成词（WallLamp → wall lamp）。出现贴花、辅助的词就是贴花、辅助；
//   否则取最后一个有归属的词——英文复合名词的中心词在后面：WallLamp 是灯，ConcreteWall 是墙，Road_FlowerBed 是花坛
export const ROLES = ['structure', 'decor', 'terrain', 'decal', 'collision', 'helper'];

export const VOCAB = {
  decal: ['decal', 'decals', 'sticker'],
  // 碰撞：节点名里的词，或分组路径里的一段（关卡导出常把挡墙放在 Blocker 组里）；还有“block + wall / plane / volume”这种连写（BlockWallCube、SM_EFX_BlockPlane）
  collision: ['blocker', 'blockers', 'collision', 'collider', 'colliders', 'playerclip', 'clip', 'invisiblewall', 'airwall', 'blockvolume'],
  helper: ['fog', 'blockout', 'trigger', 'occluder', 'navmesh', 'killzone', 'spawn'],
  terrain: ['terrain', 'landscape', 'ground', 'road', 'street', 'pavement', 'sidewalk', 'asphalt', 'sand', 'soil', 'dirt'],
  structure: ['building', 'wall', 'exterwall', 'interwall', 'stair', 'stairs', 'staircase', 'step', 'steps', 'terrace', 'pillar', 'column', 'beam', 'roof', 'floor',
    'ceiling', 'slab', 'fence', 'railing', 'guardrail', 'handrail', 'rail', 'walkway', 'bridge', 'support', 'hsupport', 'frame', 'door', 'interdoor', 'gate',
    'window', 'platform', 'ramp', 'tower', 'facade', 'corridor', 'passage', 'arch', 'canopy', 'shed', 'hangar', 'balcony', 'parapet', 'escalator', 'lift', 'elevator'],
  decor: ['furniture', 'lighting', 'light', 'lamp', 'walllamp', 'chandelier', 'spotlight', 'chair', 'table', 'sofa', 'bed', 'cabinet', 'cupboard', 'shelf', 'desk',
    'computer', 'monitor', 'monitors', 'screen', 'keyboard', 'machine', 'machinery', 'server', 'container', 'crate', 'box', 'boxlid', 'basket', 'bin', 'dustbin',
    'trash', 'bag', 'barrel', 'tool', 'tools', 'vehicle', 'car', 'van', 'vans', 'truck', 'bike', 'plant', 'tree', 'flower', 'flowerpot', 'flowerbed', 'pot', 'bush',
    'shrub', 'grass', 'ivy', 'vine', 'leaf', 'moss', 'rock', 'stone', 'sign', 'signage', 'branding', 'poster', 'board', 'doorplate', 'trademark', 'logo', 'trophy',
    'cup', 'cups', 'bottle', 'book', 'folder', 'paper', 'newspaper', 'kitchen', 'microwave', 'coffee', 'dispenser', 'extinguisher', 'firebox', 'prop', 'props',
    'emissive', 'ornament', 'decoration', 'statue', 'cart', 'carts', 'bench', 'umbrella', 'awning', 'antenna', 'conditioner', 'conditioners', 'airconditioning',
    'pipe', 'pipeline', 'cable', 'safe', 'curtain', 'blind', 'rug', 'carpet', 'cushion', 'pillow', 'lid', 'parts', 'clock', 'fan', 'speaker', 'camera', 'mailbox',
    'leuchtstabe', 'exit', 'packingbox', 'supplybox', 'plasticbox', 'bucket', 'mop', 'sunshade', 'stand', 'blinds', 'instrument', 'cloth', 'footcloth',
    'suit', 'spacesuit', 'dryer', 'litter', 'cover', 'equipment', 'engine', 'centrifuge', 'charger', 'armor'],
};
const ROLE_OF = new Map();
for (const r of ['structure', 'decor', 'terrain']) for (const w of VOCAB[r]) ROLE_OF.set(w, r);

// 节点名的最后一段 → 词（小写）：下划线、数字、空格、点分开，驼峰拆开（HLight → h light，WallLamp → wall lamp）
export function nameWords(name) {
  const leaf = String(name ?? '').split('/').pop().replace(/@\d+$/, '');
  return leaf.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z]+/).filter(Boolean).map((w) => w.toLowerCase());
}

const re = (s) => new RegExp(s, 'i');
// “Block” 打头的连写（BlockWallCube、SM_EFX_BlockPlane）；StoneBlock_Wall 这种前面还连着别的词的不算
const BLOCK_RE = /(?:^|[^A-Za-z])block[_ ]?(?:wall|plane|volume)/i;
function isCollision(name, words) {
  if (words.some((w) => VOCAB.collision.includes(w))) return true;
  if (BLOCK_RE.test(String(name ?? '').split('/').pop())) return true;
  // 分组路径（最后一段之前）里有一段整个就是碰撞的词
  const segs = String(name ?? '').split('/').slice(0, -1).map((x) => x.toLowerCase());
  return segs.some((x) => VOCAB.collision.includes(x));
}
// 一个部件的角色（不看上下文）；extra：工程的规则
export function roleClassifier(extra = []) {
  const rules = (extra ?? []).map((r) => ({ ...r, nameRe: r.name ? re(r.name) : null, matRe: r.material ? re(r.material) : null, metaRe: r.meta ? Object.entries(r.meta).map(([k, v]) => [k, re(v)]) : null }));
  return (part) => {
    const name = String(part.name ?? ''), mat = String(part.material?.name ?? '');
    for (const r of rules) {
      if (!r.nameRe && !r.matRe && !r.metaRe) continue;
      if (r.nameRe && !(name && r.nameRe.test(name))) continue;
      if (r.matRe && !r.matRe.test(mat)) continue;
      if (r.metaRe && !r.metaRe.every(([k, x]) => part.meta?.[k] != null && x.test(String(part.meta[k])))) continue;
      return r.role;
    }
    const words = nameWords(name);
    if (isCollision(name, words)) return 'collision';
    if (words.some((w) => VOCAB.decal.includes(w))) return 'decal';
    if (words.some((w) => VOCAB.helper.includes(w))) return 'helper';
    for (let k = words.length - 1; k >= 0; k--) { const r = ROLE_OF.get(words[k]); if (r) return r; }
    return geometricRole(part);
  };
}

// 整个场景一起判：先逐个按规则，再找白模体积——名字是建模软件的默认名（Cube、Box…）、三角形很少的简单体，
// 却把至少 10 个别的部件整个包在里面（一栋楼的内部空间、关卡的占位块）。材质不能当线索：真实地图常常全场一种白模材质
const GENERIC = /^(cube|box|cylinder|sphere|plane|object|mesh|node|default|geometry)(_?\d+)*(@\d+)?$/i;
export function assignRoles(parts, extra = []) {
  const one = roleClassifier(extra), roles = parts.map(one);
  const boxes = parts.map((p) => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (const t of p.tris) for (const v of t) for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; } return { lo, hi }; });
  parts.forEach((p, i) => {
    const leaf = String(p.name ?? '').split('/').pop();
    if (roles[i] === 'helper' || !leaf || !GENERIC.test(leaf) || p.tris.length > 200) return;
    const B = boxes[i];
    let n = 0;
    for (let j = 0; j < parts.length && n < 10; j++) if (j !== i && [0, 1, 2].every((k) => boxes[j].lo[k] >= B.lo[k] && boxes[j].hi[k] <= B.hi[k])) n++;
    if (n >= 10) roles[i] = 'helper';
  });
  return roles;
}

// 没有名字、或名字里没有线索：按几何。很薄、散成很多块的是贴花；又大又扁的是地形；其余当结构（逆向照常拆解，宁可多做）
export function geometricRole(part) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of part.tris) for (const v of t) for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; }
  const sz = [0, 1, 2].map((k) => hi[k] - lo[k]);
  if (scatterOf(part).scattered && Math.min(...sz) < 0.02 * Math.max(...sz)) return 'decal';
  return 'structure';
}

// 分散：一个模型里装着很多互不相连的块，各块包围盒体积之和远小于整体包围盒（贴花、几片外墙、楼梯的零件）。
// 返回 { scattered, comps: 分量（三角形编号的数组）, ratio }
export function scatterOf(part, { minComps = 3, maxRatio = 0.1 } = {}) {
  const tris = part.tris, n = tris.length;
  if (n < 2 * minComps) return { scattered: false, comps: null, ratio: 1 };
  const key = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
  const parent = new Int32Array(n).map((_, i) => i), find = (i) => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const owner = new Map();
  tris.forEach((t, i) => t.forEach((v) => { const k = key(v), o = owner.get(k); if (o === undefined) owner.set(k, i); else { const a = find(i), b = find(o); if (a !== b) parent[a] = b; } }));
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const comps = [...groups.values()];
  if (comps.length < minComps) return { scattered: false, comps, ratio: 1 };
  const vol = (ids) => { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (const i of ids) for (const v of tris[i]) for (let k = 0; k < 3; k++) { if (v[k] < lo[k]) lo[k] = v[k]; if (v[k] > hi[k]) hi[k] = v[k]; } const s = [0, 1, 2].map((k) => Math.max(hi[k] - lo[k], 1e-6)); return s[0] * s[1] * s[2]; };
  const ratio = comps.reduce((s, c) => s + vol(c), 0) / vol(tris.map((_, i) => i));
  return { scattered: ratio < maxRatio, comps, ratio };
}
