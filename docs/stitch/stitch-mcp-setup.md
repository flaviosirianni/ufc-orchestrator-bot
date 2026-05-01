# Stitch MCP Setup

This repo does not store Stitch credentials. The local proxy reads `STITCH_API_KEY` from the environment.

## 1. Get the API Key

1. Open `https://stitch.withgoogle.com/settings`.
2. Create/copy an API key.
3. Export it in the shell that launches Codex:

```bash
export STITCH_API_KEY="YOUR_STITCH_API_KEY"
```

For VS Code/Codex extension sessions, make sure the extension process can see that variable. If it cannot, add it to your shell profile and restart VS Code.

## 2. Install the Official SDK

The proxy script uses the official Google Labs SDK:

```bash
npm install --save-dev @google/stitch-sdk @modelcontextprotocol/sdk
```

This updates `package.json` and `package-lock.json`. Do not commit any `.env` file or API key.

## 3. Register Stitch in Codex

After `STITCH_API_KEY` is available and dependencies are installed:

```bash
codex mcp add stitch -- node scripts/stitch-mcp-proxy.mjs
```

Then verify:

```bash
codex mcp list
```

Expected: a `stitch` MCP server appears in the list.

## 4. Use After Designing in Stitch

Once Stitch has generated screens:

1. Use the prompt in `docs/stitch/medical-nutrition-mobile-app-prompt.md`.
2. Save or note the Stitch project ID.
3. Ask Codex to list Stitch projects/screens via MCP and import the selected screens or HTML into the app implementation.

## Notes

- Codex HTTP MCP registration currently supports bearer-token env vars but not arbitrary `X-Goog-Api-Key` headers, so this repo uses a stdio proxy.
- The proxy intentionally fails fast when `STITCH_API_KEY` is missing.
- If your Stitch account requires OAuth instead of API key, use the official Stitch SDK/OAuth path and set the relevant environment variables before starting the proxy.
- If `npm install` fails with `EACCES` inside `node_modules`, the local dependency tree is owned by another user. Fix ownership or reinstall dependencies before installing the Stitch SDK.
