/**
 * Helpers for formatting Redis mutation commands for preview and clipboard copy
 * in DangerConfirmDialog and related confirmation prompts.
 */

export interface RedisBlobLike {
  raw_base64: string;
  encoding?: string;
}

export type RedisValuePendingDelete = { kind: "key" } | { kind: "hash"; field: unknown } | { kind: "list"; index: number } | { kind: "set"; member: unknown } | { kind: "zset"; member: unknown };

export interface RedisDeleteKeysOptions {
  database?: string | number | null;
  isCluster?: boolean;
  chunkSize?: number;
  /**
   * If true, string keys are treated as base64-encoded `key_raw`.
   * Otherwise, string keys are treated as regular UTF-8 key strings.
   */
  raw?: boolean;
}

export interface RedisDeleteGroupOptions {
  database?: string | number | null;
  isCluster?: boolean;
}

export interface RedisDeleteValueItemOptions {
  database?: string | number | null;
  isCluster?: boolean;
  /**
   * If true, string `key` is treated as base64-encoded `key_raw`.
   */
  raw?: boolean;
}

/**
 * Decodes a Base64 string into raw bytes.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Serializes raw byte buffer into an executable Redis argument token.
 * Safe ASCII characters (alphanumeric, `:`, `_`, `-`, `.`, `/`, etc.) are emitted unquoted.
 * Arguments containing whitespace, quotes, backslashes, or control/binary bytes are wrapped
 * in double quotes with standard Redis escaping (`\"`, `\\`, `\n`, `\r`, `\t`, `\xHH`).
 */
export function quoteRedisBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return '""';

  let canBeUnquoted = true;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    const isSafe =
      (b >= 48 && b <= 57) || // 0-9
      (b >= 65 && b <= 90) || // A-Z
      (b >= 97 && b <= 122) || // a-z
      b === 95 || // _
      b === 45 || // -
      b === 58 || // :
      b === 46 || // .
      b === 47 || // /
      b === 64 || // @
      b === 43 || // +
      b === 126 || // ~
      b === 37; // %
    if (!isSafe) {
      canBeUnquoted = false;
      break;
    }
  }

  if (canBeUnquoted) {
    return new TextDecoder().decode(bytes);
  }

  let result = '"';
  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;

    if (b === 0x22) {
      result += '\\"';
    } else if (b === 0x5c) {
      result += "\\\\";
    } else if (b === 0x0a) {
      result += "\\n";
    } else if (b === 0x0d) {
      result += "\\r";
    } else if (b === 0x09) {
      result += "\\t";
    } else if (b === 0x07) {
      result += "\\a";
    } else if (b === 0x08) {
      result += "\\b";
    } else if (b >= 0x20 && b <= 0x7e) {
      result += String.fromCharCode(b);
    } else if (b >= 0x80) {
      // Check if this byte starts a valid UTF-8 character sequence
      let decodedChar: string | null = null;
      let matchedLen = 0;
      for (let len = 4; len >= 2; len--) {
        if (i + len <= bytes.length) {
          try {
            const candidate = utf8Decoder.decode(bytes.subarray(i, i + len));
            // Ensure no C1 control characters (U+0080 to U+009F)
            if (!/[\u0080-\u009f]/.test(candidate)) {
              decodedChar = candidate;
              matchedLen = len;
              break;
            }
          } catch {
            // Not a valid UTF-8 sequence of this length
          }
        }
      }

      if (decodedChar !== null && matchedLen > 0) {
        result += decodedChar;
        i += matchedLen - 1;
      } else {
        result += "\\x" + b.toString(16).padStart(2, "0");
      }
    } else {
      // Control character < 0x20 or 0x7f
      result += "\\x" + b.toString(16).padStart(2, "0");
    }
  }

  result += '"';
  return result;
}

/**
 * Quotes a key given by its base64 `key_raw` string representation.
 */
export function quoteRedisKeyRaw(keyRaw: string): string {
  try {
    const bytes = base64ToBytes(keyRaw);
    return quoteRedisBytes(bytes);
  } catch {
    return quoteRedisArg(keyRaw);
  }
}

/**
 * Quotes an arbitrary Redis command argument (string, Uint8Array, RedisBlob, number).
 */
export function quoteRedisArg(arg: unknown): string {
  if (arg == null) return '""';
  if (arg instanceof Uint8Array) {
    return quoteRedisBytes(arg);
  }
  if (typeof arg === "object" && "raw_base64" in arg && typeof (arg as RedisBlobLike).raw_base64 === "string") {
    return quoteRedisKeyRaw((arg as RedisBlobLike).raw_base64);
  }
  if (typeof arg === "number") {
    return String(arg);
  }
  const str = String(arg);
  const bytes = new TextEncoder().encode(str);
  return quoteRedisBytes(bytes);
}

/**
 * Returns the command preview for flushing a Redis database.
 * If database is provided and not Cluster mode, prefixes with `SELECT <db>`.
 * In Cluster mode, `SELECT` is not supported and is omitted.
 */
export function redisFlushDbPreview(database?: string | number | null, isCluster = false): string {
  if (isCluster) {
    return "FLUSHDB";
  }
  if (database != null && String(database).trim() !== "") {
    const dbIndex = String(database).trim().replace(/^db/i, "");
    return `SELECT ${dbIndex}\nFLUSHDB`;
  }
  return "FLUSHDB";
}

/**
 * Formats a list of Redis keys into `DEL` commands.
 * If keys exceed chunkSize, chunks them across multiple `DEL` lines.
 * In standalone mode with a non-zero database, prefixes with `SELECT <db>`.
 */
export function redisDeleteKeysPreview(keys: readonly (string | Uint8Array)[], options?: RedisDeleteKeysOptions | number): string {
  if (keys.length === 0) return "";

  const opts: RedisDeleteKeysOptions = typeof options === "number" ? { chunkSize: options } : (options ?? {});
  const chunkSize = Math.max(1, opts.chunkSize ?? 512);
  const isCluster = opts.isCluster ?? false;
  const isRaw = opts.raw ?? false;

  const quoted = keys.map((key) => {
    if (key instanceof Uint8Array) return quoteRedisBytes(key);
    if (isRaw) return quoteRedisKeyRaw(key);
    return quoteRedisArg(key);
  });

  const lines: string[] = [];
  if (!isCluster && opts.database != null && String(opts.database).trim() !== "") {
    const dbIndex = Number(String(opts.database).trim().replace(/^db/i, ""));
    if (Number.isFinite(dbIndex) && dbIndex > 0) {
      lines.push(`SELECT ${dbIndex}`);
    }
  }

  for (let i = 0; i < quoted.length; i += chunkSize) {
    lines.push(`DEL ${quoted.slice(i, i + chunkSize).join(" ")}`);
  }

  return lines.join("\n");
}

/**
 * Formats a pattern deletion preview into a bounded, non-blocking command scheme
 * matching the backend `delete_keys_by_pattern` executor (SCAN COUNT 500, DEL in batches <= 512).
 * Clarifies execution context between Standalone Redis and Redis Cluster.
 */
export function redisDeleteGroupPreview(pattern: string, options?: RedisDeleteGroupOptions): string {
  const isCluster = options?.isCluster ?? false;
  const quotedPattern = quoteRedisArg(pattern);
  const patternArg = quotedPattern.startsWith('"') ? quotedPattern : `"${pattern}"`;

  if (isCluster) {
    return [
      "# Applicable: Redis Cluster (per-node execution)",
      "# Keys matching pattern are partitioned across hash slots on different master nodes.",
      "# Cross-slot multi-key operations (CROSSSLOT) and global scripts are rejected in Cluster mode.",
      "# DBX executes delete_keys_by_pattern by scanning each master node (SCAN COUNT 500) and deleting keys in batches of up to 512 keys.",
      "# To execute manually, run against each master node:",
      `# redis-cli -h <node-host> -p <node-port> --scan --pattern ${patternArg} | xargs -L 512 redis-cli -h <node-host> -p <node-port> DEL`,
    ].join("\n");
  }

  let dbFlag = "";
  let dbLabel = "Standalone Redis";
  if (options?.database != null && String(options.database).trim() !== "") {
    const dbIndex = Number(String(options.database).trim().replace(/^db/i, ""));
    if (Number.isFinite(dbIndex) && dbIndex > 0) {
      dbFlag = ` -n ${dbIndex}`;
      dbLabel = `Standalone Redis (db ${dbIndex})`;
    }
  }

  return [`# Applicable: ${dbLabel}`, "# Matches DBX delete_keys_by_pattern: SCAN COUNT 500, DEL in batches of up to 512 keys", `redis-cli${dbFlag} --scan --pattern ${patternArg} | xargs -L 512 redis-cli${dbFlag} DEL`].join("\n");
}

/**
 * Formats a single item or key deletion within RedisValueViewer into an executable command.
 * Faithfully serializes raw bytes of keys and collection fields/members.
 * In standalone mode with a non-zero database, prefixes with `SELECT <db>`.
 */
export function redisDeleteValueItemPreview(key: string | Uint8Array, pending: RedisValuePendingDelete, options?: RedisDeleteValueItemOptions): string {
  const isCluster = options?.isCluster ?? false;
  const isRaw = options?.raw ?? false;

  let quotedKey: string;
  if (key instanceof Uint8Array) {
    quotedKey = quoteRedisBytes(key);
  } else if (isRaw) {
    quotedKey = quoteRedisKeyRaw(key);
  } else {
    quotedKey = quoteRedisArg(key);
  }

  const lines: string[] = [];
  if (!isCluster && options?.database != null && String(options.database).trim() !== "") {
    const dbIndex = Number(String(options.database).trim().replace(/^db/i, ""));
    if (Number.isFinite(dbIndex) && dbIndex > 0) {
      lines.push(`SELECT ${dbIndex}`);
    }
  }

  if (pending.kind === "key") {
    lines.push(`DEL ${quotedKey}`);
  } else if (pending.kind === "hash") {
    lines.push(`HDEL ${quotedKey} ${quoteRedisArg(pending.field)}`);
  } else if (pending.kind === "list") {
    lines.push(`LSET ${quotedKey} ${pending.index} "__DELETED_PLACEHOLDER__"\nLREM ${quotedKey} 1 "__DELETED_PLACEHOLDER__"`);
  } else if (pending.kind === "zset") {
    lines.push(`ZREM ${quotedKey} ${quoteRedisArg(pending.member)}`);
  } else {
    lines.push(`SREM ${quotedKey} ${quoteRedisArg(pending.member)}`);
  }

  return lines.join("\n");
}
