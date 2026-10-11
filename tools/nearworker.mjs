// 最近距离批量查询的 worker（见 nearest.mjs 的 closestMany）：收到一批活就从共享计数器领段来算
import { parentPort } from 'node:worker_threads';
import { runChunks } from './nearest.mjs';

parentPort.on('message', (task) => runChunks(task));
