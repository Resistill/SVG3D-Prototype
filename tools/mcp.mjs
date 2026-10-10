// MCP 服务器（stdio，按行分隔的 JSON-RPC 2.0，零依赖）：工具表由 tools/agent.mjs 的命令表生成，
// 所以 CLI、MCP、界面永远一致。render 的结果除了 JSON 还附上 PNG 图像，多模态模型可以直接看。
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { COMMANDS, runCommand } from './agent.mjs';

const tools = () => Object.entries(COMMANDS).map(([name, c]) => ({
  name: `s3d_${name}`,
  description: c.desc,
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: '工程目录（不填用服务器启动时的 --project）' },
      ...Object.fromEntries(Object.entries(c.args).map(([k, d]) => [k, k === 'paths' ? { type: 'array', items: { type: 'string' }, description: d } : { type: 'string', description: d }])),
    },
  },
}));

export function serve({ project = '.', input = process.stdin, output = process.stdout } = {}) {
  const send = (msg) => output.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const rl = createInterface({ input });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try { req = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'parse error' } }); }
    const { id, method, params = {} } = req;
    try {
      if (method === 'initialize') return send({ id, result: { protocolVersion: params.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'svg3d', version: '0.2.0' } } });
      if (method === 'notifications/initialized' || id === undefined) return;
      if (method === 'ping') return send({ id, result: {} });
      if (method === 'tools/list') return send({ id, result: { tools: tools() } });
      if (method === 'tools/call') {
        const name = String(params.name ?? '').replace(/^s3d_/, '');
        const args = { ...(params.arguments ?? {}) };
        const dir = args.project ?? project;
        delete args.project;
        try {
          const out = await runCommand(name, dir, args);
          const content = [{ type: 'text', text: JSON.stringify(out, null, 2) }];
          if (name === 'render' && out?.file) content.push({ type: 'image', data: readFileSync(out.file).toString('base64'), mimeType: 'image/png' });
          return send({ id, result: { content } });
        } catch (e) {
          return send({ id, result: { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }], isError: true } });
        }
      }
      send({ id, error: { code: -32601, message: `未知方法 ${method}` } });
    } catch (e) { send({ id, error: { code: -32603, message: e.message } }); }
  });
  return rl;
}
