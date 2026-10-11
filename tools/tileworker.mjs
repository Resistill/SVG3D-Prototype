// 分块逆向的 worker（见 tiles.mjs）：一次收一块部件，逆向，回传文本、报告与网格引用
import { parentPort } from 'node:worker_threads';
import { reverse } from './reverse.mjs';
import { slim } from './tiles.mjs';

parentPort.on('message', ({ parts, opts }) => {
  try { parentPort.postMessage(slim(reverse(parts, opts))); } catch (e) { parentPort.postMessage({ error: String(e?.stack ?? e) }); }
});
