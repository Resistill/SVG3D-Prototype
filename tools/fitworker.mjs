// 并行拟合的 worker（见 fitpool.mjs）：按主线程给的档位、单位与序号拟合一批部件；拟合差的顺带算“基本体之并”的几何
import { parentPort, workerData } from 'node:worker_threads';
import { prefitPart, setFidelity } from './reverse.mjs';

setFidelity(workerData.fidelity, workerData.unit);
parentPort.postMessage(workerData.items.map(({ i, tris, role }) => ({ i, ...prefitPart(tris, i, role, workerData.meshPrice) })));
