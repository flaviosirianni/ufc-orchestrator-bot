#!/usr/bin/env node

const apiKey = String(process.env.STITCH_API_KEY || '').trim();
const accessToken = String(process.env.STITCH_ACCESS_TOKEN || '').trim();
const projectId = String(process.env.GOOGLE_CLOUD_PROJECT || '').trim();
const baseUrl = String(process.env.STITCH_HOST || '').trim() || undefined;

if (!apiKey && !(accessToken && projectId)) {
  console.error(
    [
      '[stitch-mcp-proxy] Missing Stitch credentials.',
      'Set STITCH_API_KEY, or set STITCH_ACCESS_TOKEN plus GOOGLE_CLOUD_PROJECT.',
    ].join('\n')
  );
  process.exit(1);
}

let StitchProxy;
let StdioServerTransport;

try {
  ({ StitchProxy } = await import('@google/stitch-sdk'));
  ({ StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js'));
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      [
        '[stitch-mcp-proxy] Missing Stitch MCP dependencies.',
        'Install them with:',
        'npm install --save-dev @google/stitch-sdk @modelcontextprotocol/sdk',
      ].join('\n')
    );
    process.exit(1);
  }
  throw error;
}

const proxy = new StitchProxy({
  apiKey: apiKey || undefined,
  accessToken: accessToken || undefined,
  projectId: projectId || undefined,
  baseUrl,
});

const transport = new StdioServerTransport();
await proxy.start(transport);
