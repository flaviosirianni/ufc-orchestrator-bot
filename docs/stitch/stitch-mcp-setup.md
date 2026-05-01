# Stitch MCP Setup

This repo does not store Stitch credentials. The local proxy can use either an API key or OAuth.

Project and screen reads require OAuth. The API key path can initialize the MCP tool list, but Stitch returns `401` for project data with API-key auth.

## 1. OAuth Setup for Project/Screen Export

Install Google Cloud CLI, then authenticate the same Google account that owns the Stitch project:

```bash
gcloud auth login
gcloud config set project YOUR_GOOGLE_CLOUD_PROJECT_ID
```

The local proxy can fetch a fresh OAuth access token on startup:

```bash
export STITCH_USE_GCLOUD_AUTH=true
export GOOGLE_CLOUD_PROJECT="YOUR_GOOGLE_CLOUD_PROJECT_ID"
```

Do not commit OAuth tokens, API keys, or `.env` files.

## 2. Install the Official SDK

The proxy script uses the official Google Labs SDK:

```bash
npm install --save-dev @google/stitch-sdk @modelcontextprotocol/sdk
```

This updates `package.json` and `package-lock.json`. Do not commit any `.env` file or API key.

## 3. Register Stitch in Codex

For OAuth via `gcloud`, register the stdio proxy with these local environment variables:

```bash
codex mcp remove stitch
codex mcp add stitch \
  --env STITCH_USE_GCLOUD_AUTH=true \
  --env GOOGLE_CLOUD_PROJECT="YOUR_GOOGLE_CLOUD_PROJECT_ID" \
  -- node scripts/stitch-mcp-proxy.mjs
```

Then verify:

```bash
codex mcp list
```

Expected: a `stitch` MCP server appears in the list.

If you only need API-key experiments, the proxy also supports:

```bash
codex mcp add stitch --env STITCH_API_KEY="YOUR_STITCH_API_KEY" -- node scripts/stitch-mcp-proxy.mjs
```

However, project and screen export currently require OAuth.

## 4. Use After Designing in Stitch

Once Stitch has generated screens:

1. Use the prompt in `docs/stitch/medical-nutrition-mobile-app-prompt.md`.
2. Save or note the Stitch project ID.
3. Ask Codex to list Stitch projects/screens via MCP and import the selected screens or HTML into the app implementation.

## Notes

- Codex HTTP MCP registration currently supports bearer-token env vars but not arbitrary `X-Goog-Api-Key` headers, so this repo uses a stdio proxy.
- The proxy intentionally fails fast when no API key, OAuth token, or `STITCH_USE_GCLOUD_AUTH=true` path is available.
- OAuth mode prefers `STITCH_ACCESS_TOKEN` when explicitly set; otherwise it can call `gcloud auth print-access-token`.
- If `npm install` fails with `EACCES` inside `node_modules`, the local dependency tree is owned by another user. Fix ownership or reinstall dependencies before installing the Stitch SDK.
