# plugin-stats-worker

Cloudflare Worker that counts plugin marketplace traffic. Deployed on the same
Cloudflare account as the dbxio.com site (`pnpm dlx wrangler deploy` from this
directory; OAuth login required).

## Routes

- `dl.dbxio.com/plugins/*` — counts every `GET` of a marketplace artifact, then
  passes the request through to the R2 custom domain. Artifact bytes, headers,
  and Range semantics are untouched; the route sits in front of the origin only.
- `dbxio.com/api/plugins/*` —
  `POST /api/plugins/install` is the fire-and-forget beacon the desktop app
  sends after a successful marketplace install;
  `GET /api/plugins/stats` returns the current counters
  (`{ downloads: {key: n}, installs: {key: n} }`) and is how counters should be
  read (the wrangler CLI can show a stale/split view of a fresh namespace).

## Storage

Single KV namespace `plugin_stats` (binding `PLUGIN_STATS`):

- `dl:{pluginId}:{version}` — passive artifact download count
- `inst:{pluginId}:{version}` — client-reported install count

Counters are best-effort (KV read-modify-write can drop counts under same-key
concurrency; acceptable for decorative stats). Inspect values with:

```sh
pnpm dlx wrangler kv key list --namespace-id 483dcc36cd3c4da5af5cdbb4532166f2 --prefix "dl:io.dbx.ssh"
pnpm dlx wrangler kv key get --namespace-id 483dcc36cd3c4da5af5cdbb4532166f2 "dl:io.dbx.ssh:0.4.73"
```

No display in the app yet; counts accrue until the marketplace UI surfaces them.
