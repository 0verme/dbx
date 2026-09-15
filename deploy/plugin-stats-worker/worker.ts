// Counts plugin marketplace traffic on Cloudflare without touching artifact bytes.
//
// Routes (see wrangler.json):
// - dl.dbxio.com/plugins/*: counts each GET of a marketplace artifact, then passes
//   the request through to the R2 custom domain origin. Same-zone subrequests do not
//   re-enter Workers, so the pass-through cannot loop.
// - dbxio.com/api/plugins/install: beacon endpoint the desktop app calls after a
//   successful marketplace install. Decorative statistics only: no auth, no PII,
//   failures are silently ignored by clients.
// - dbxio.com/api/plugins/stats: read view of the counters, for later display in
//   the marketplace UI and for ops checks.
//
// Counters live in KV under `dl:{pluginId}:{version}` (passive downloads) and
// `inst:{pluginId}:{version}` (client beacons). KV read-modify-write can drop
// counts under same-key concurrency; acceptable for decorative stats. NOTE: the
// wrangler CLI/API view of a freshly created namespace can lag or split from the
// runtime view for a long time — always read counters through the stats endpoint,
// not `wrangler kv key get`.

type KvNamespaceBinding = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[] }>;
};

type Env = {
  PLUGIN_STATS: KvNamespaceBinding;
};

const DOWNLOAD_PATTERN = /^\/plugins\/([A-Za-z0-9._-]{1,64})\/([0-9A-Za-z.+-]{1,32})\//;
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;
const INSTALL_BODY_LIMIT_BYTES = 512;
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

async function increment(env: Env, key: string): Promise<void> {
  try {
    const current = await env.PLUGIN_STATS.get(key);
    const next = Number.parseInt(current ?? "0", 10) || 0;
    await env.PLUGIN_STATS.put(key, String(next + 1));
  } catch (error) {
    console.error(`plugin-stats increment failed for ${key}`, error);
  }
}

async function readCounters(env: Env, prefix: string): Promise<Record<string, number>> {
  const listing = await env.PLUGIN_STATS.list({ prefix });
  const counters: Record<string, number> = {};
  await Promise.all(
    listing.keys.map(async (entry) => {
      try {
        counters[entry.name] = Number.parseInt((await env.PLUGIN_STATS.get(entry.name)) ?? "0", 10) || 0;
      } catch {
        counters[entry.name] = 0;
      }
    }),
  );
  return counters;
}

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: CORS_HEADERS });
}

async function handleInstallBeacon(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return emptyResponse(204);

  const url = new URL(request.url);
  if (url.pathname === "/api/plugins/stats") {
    if (request.method !== "GET") return emptyResponse(405);
    const [downloads, installs] = await Promise.all([readCounters(env, "dl:"), readCounters(env, "inst:")]);
    return Response.json({ downloads, installs }, { headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
  }

  if (request.method !== "POST") return emptyResponse(405);
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (contentLength > INSTALL_BODY_LIMIT_BYTES) return emptyResponse(413);

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text()) as unknown;
  } catch {
    return emptyResponse(400);
  }
  const { id, version } = (payload ?? {}) as Record<string, unknown>;
  if (typeof id !== "string" || !PLUGIN_ID_PATTERN.test(id)) return emptyResponse(400);
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return emptyResponse(400);

  await increment(env, `inst:${id}:${version}`);
  return emptyResponse(204);
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === "dl.dbxio.com") {
      if (request.method === "GET") {
        const download = url.pathname.match(DOWNLOAD_PATTERN);
        if (download) ctx.waitUntil(increment(env, `dl:${download[1]}:${download[2]}`));
      }
      return fetch(request);
    }
    return handleInstallBeacon(request, env);
  },
};
