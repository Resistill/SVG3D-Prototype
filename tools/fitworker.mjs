// 并行拟合的 worker（见 fitpool.mjs）：按主线程给的档位、单位与序号拟合一批部件；拟合差的顺带算“基本体之并”的几何
import { parentPort, workerData } from 'node:worker_threads';
import { prefitPart, prefitComposite, prefitCompositeInit, setFidelity } from './reverse.mjs';

// composite：拟合之后接着算组合写法（板件、外壳、并、小场景），见 reverse.mjs 的 prefitComposite
setFidelity(workerData.fidelity, workerData.unit);
// 主线程一次发一组部件，算完回一组结果，再要下一组（fitpool.mjs 的动态分配）
const c = workerData.composite;
if (c) prefitCompositeInit({ ...c, meshUse: workerData.meshUse, meshPrice: workerData.meshPrice });
parentPort.on('message', (items) => parentPort.postMessage(items.map(({ i, role, ...item }) => ({ i, ...(c ? prefitComposite(item, i, { role, srcFile: c.srcFile }) : prefitPart(item.tris, i, role, workerData.meshPrice)) }))));
