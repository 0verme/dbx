/**
 * Helpers for formatting Redis mutation commands for preview and clipboard copy
 * in DangerConfirmDialog and related confirmation prompts.
 */

export type RedisValuePendingDelete = { kind: "key" } | { kind: "hash"; field: unknown } | { kind: "list"; index: number } | { kind: "set"; member: unknown } | { kind: "zset"; member: unknown };

/**
 * Quotes an argument for Redis command execution if it contains spaces,
 * quotes, backslashes, control characters, or is empty.
 */
export function quoteRedisArg(arg: string): string {
  if (arg.length === 0) return '""';
  if (/[\s"'\\]/.test(arg)) {
    return JSON.stringify(arg);
  }
  return arg;
}

/**
 * Returns the command preview for flushing a Redis database.
 * If database is provided, prefixes with `SELECT <db>`.
 */
export function redisFlushDbPreview(database?: string | number | null): string {
  if (database != null && String(database).trim() !== "") {
    const dbIndex = String(database).trim().replace(/^db/i, "");
    return `SELECT ${dbIndex}\nFLUSHDB`;
  }
  return "FLUSHDB";
}

/**
 * Formats a list of Redis keys into `DEL` commands.
 * If keys exceed chunkSize, chunks them across multiple `DEL` lines.
 */
export function redisDeleteKeysPreview(keys: readonly string[], chunkSize = 50): string {
  if (keys.length === 0) return "";
  const quoted = keys.map(quoteRedisArg);
  const lines: string[] = [];
  const size = Math.max(1, chunkSize);
  for (let i = 0; i < quoted.length; i += size) {
    lines.push(`DEL ${quoted.slice(i, i + size).join(" ")}`);
  }
  return lines.join("\n");
}

/**
 * Formats a pattern deletion preview into the standard server-side Lua EVAL command.
 */
export function redisDeleteGroupPreview(pattern: string): string {
  const quoted = quoteRedisArg(pattern);
  return `EVAL "local keys = redis.call('keys', ARGV[1]) for _, k in ipairs(keys) do redis.call('del', k) end return #keys" 0 ${quoted}`;
}

/**
 * Formats a single item or key deletion within RedisValueViewer into an executable command.
 */
export function redisDeleteValueItemPreview(keyName: string, pending: RedisValuePendingDelete): string {
  const key = quoteRedisArg(keyName);
  if (pending.kind === "key") return `DEL ${key}`;
  if (pending.kind === "hash") return `HDEL ${key} ${quoteRedisArg(String(pending.field ?? ""))}`;
  if (pending.kind === "list") return `LSET ${key} ${pending.index} "__DELETED_PLACEHOLDER__"\nLREM ${key} 1 "__DELETED_PLACEHOLDER__"`;
  if (pending.kind === "zset") return `ZREM ${key} ${quoteRedisArg(String(pending.member ?? ""))}`;
  return `SREM ${key} ${quoteRedisArg(String(pending.member ?? ""))}`;
}
