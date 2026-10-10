#!/usr/bin/env node
// MCP 服务器入口：node bin/s3d-mcp.mjs --project=work/spaceport
// 在 Claude Code 里：claude mcp add svg3d -- node --import ./bin/node-hooks.mjs bin/s3d-mcp.mjs --project=work/spaceport
import '../bin/node-hooks.mjs';
const { serve } = await import('../tools/mcp.mjs');
const project = (process.argv.find((a) => a.startsWith('--project=')) ?? '--project=.').split('=')[1];
serve({ project });
