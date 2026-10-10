// 界面用的 HTTP 接口（tools/api.mjs）：工程信息、选中状态、命令、同源与目录检查
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../tools/api.mjs';

test('接口：工程信息、选中状态读写、命令、同源与目录检查', async () => {
  const root = mkdtempSync(join(tmpdir(), 's3d-api-'));
  const dir = join(root, 'p');
  mkdirSync(join(dir, 'base'), { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ version: 1, source: 'none.glb', unit: 0.28 }));
  writeFileSync(join(dir, 'scene.s3d'), 'import "base.s3d"\nimport "edits.s3d"\n');
  writeFileSync(join(dir, 'base.s3d'), 'import "base/a.s3d"\n');
  writeFileSync(join(dir, 'base/a.s3d'), 'box a size=1,1,1\n');
  writeFileSync(join(dir, 'edits.s3d'), 'box b size=1,1,1 on=a\n');
  const handle = createApi(root);
  const server = createServer((req, res) => handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = { 'Content-Type': 'application/json' };
  try {
    assert.equal((await (await fetch(`${base}/api/ping`)).json()).ok, true);
    const pr = await (await fetch(`${base}/api/project?dir=p`)).json();
    assert.equal(pr.project.unit, 0.28);
    assert.deepEqual(pr.files.map((f) => [f.path, f.readonly]), [['base/a.s3d', true], ['base.s3d', true], ['edits.s3d', false], ['scene.s3d', false]]);
    assert.equal((await fetch(`${base}/api/project?dir=..`)).status, 403, 'dir 不能逃出根目录');

    // 选中状态
    assert.deepEqual((await (await fetch(`${base}/api/selection?dir=p`)).json()).paths, []);
    const put = await fetch(`${base}/api/selection?dir=p`, { method: 'PUT', headers: J, body: JSON.stringify({ paths: ['a', 'b'] }) });
    assert.equal(put.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state/selection.json'), 'utf8')).paths, ['a', 'b']);
    assert.equal((await fetch(`${base}/api/selection?dir=p`, { method: 'PUT', headers: { ...J, Origin: 'http://evil.example' }, body: '{"paths":[]}' })).status, 403, '跨域写被拒绝');
    assert.equal((await fetch(`${base}/api/selection?dir=p`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{"paths":[]}' })).status, 415, '不是 JSON 被拒绝（简单请求不用预检）');

    // 命令：与命令行同一张表；inspect --selection 读的就是刚写的选中状态
    const run = async (cmd, args) => { const r = await fetch(`${base}/api/run`, { method: 'POST', headers: J, body: JSON.stringify({ dir: 'p', cmd, args }) }); return { status: r.status, json: await r.json() }; };
    const ins = await run('inspect', { selection: true });
    assert.equal(ins.status, 200);
    assert.deepEqual(ins.json.map((x) => x.path), ['a', 'b']);
    assert.equal(ins.json[1].facts[0].rel, 'on');
    const note = await run('note', { text: '这里不对' });
    assert.deepEqual(note.json.paths, ['a', 'b'], 'note 默认带上当前选中');
    assert.equal((await run('nosuch', {})).status, 400);
    assert.equal((await run('render', { out: '../../x.png' })).status, 403, 'render 的输出不能逃出工程目录');
  } finally {
    server.close();
  }
});
