#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

let accessToken = String(process.env.STITCH_ACCESS_TOKEN || '').trim();
const useGcloudAuth = TRUE_VALUES.has(String(process.env.STITCH_USE_GCLOUD_AUTH || '').trim().toLowerCase());
const quotaProjectId =
  String(process.env.STITCH_PROJECT_ID || '').trim() ||
  String(process.env.GOOGLE_CLOUD_PROJECT || '').trim() ||
  (useGcloudAuth ? runGcloud(['config', 'get-value', 'project'], { optional: true }) : '');

if (!accessToken && useGcloudAuth) {
  accessToken = runGcloud(['auth', 'print-access-token']);
}

const apiKey = accessToken ? '' : String(process.env.STITCH_API_KEY || '').trim();
const baseUrl = String(process.env.STITCH_HOST || '').trim() || undefined;

if (!apiKey && !accessToken) {
  console.error(
    [
      '[stitch-mcp-proxy] Missing Stitch credentials.',
      'Set STITCH_API_KEY, set STITCH_ACCESS_TOKEN, or set STITCH_USE_GCLOUD_AUTH=true.',
      'Project/screen reads require OAuth; API keys may only work for limited operations.',
    ].join('\n')
  );
  process.exit(1);
}

function runGcloud(args, options = {}) {
  const result = spawnSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status === 0) {
    return String(result.stdout || '').trim();
  }

  if (options.optional) {
    return '';
  }

  const stderr = String(result.stderr || '').trim();
  console.error(
    [
      `[stitch-mcp-proxy] Failed to run gcloud ${args.join(' ')}.`,
      stderr || 'No stderr output.',
      'Install Google Cloud CLI and run `gcloud auth login` before starting Codex.',
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
  quotaProjectId: quotaProjectId || undefined,
  url: baseUrl,
});

const transport = new StdioServerTransport();
await proxy.start(transport);
