// 从一个大场景（glTF / GLB）里切出一块：按世界坐标范围（节点原点）与节点名的规则筛选，保留实例共享网格的结构。
// 用于实战：大地图放不进一次逆向，先按区域切开。
export function cropDocument(doc, { box = null, include = null, exclude = null } = {}) {
  const root = doc.getRoot();
  const inBox = (t) => !box || (t[0] >= box.min[0] && t[0] <= box.max[0] && t[1] >= box.min[1] && t[1] <= box.max[1] && t[2] >= box.min[2] && t[2] <= box.max[2]);
  let kept = 0, dropped = 0;
  for (const n of root.listNodes()) {
    if (!n.getMesh()) continue;
    const name = n.getName() ?? '';
    const ok = inBox(n.getWorldTranslation()) && (!include || include.test(name)) && !(exclude && exclude.test(name));
    if (ok) kept++; else { n.dispose(); dropped++; }
  }
  // 没人用的网格、访问器、缓冲一并删掉
  for (const m of root.listMeshes()) if (!m.listParents().some((p) => p.propertyType === 'Node')) { for (const pr of m.listPrimitives()) pr.dispose(); m.dispose(); }
  for (const a of root.listAccessors()) if (!a.listParents().some((p) => p.propertyType === 'Primitive')) a.dispose();
  return { kept, dropped, meshes: root.listMeshes().length };
}
