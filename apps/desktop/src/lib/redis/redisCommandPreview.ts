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

export interface RedisConnectionContext {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  tls?: boolean;
}

export interface RedisDeleteGroupOptions {
  database?: string | number | null;
  isCluster?: boolean;
  connection?: RedisConnectionContext;
  chunkSize?: number;
  scanCount?: number;
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
 * Preserves raw bytes without xargs delimiter corruption and respects Cluster slot constraints.
 */
export function redisDeleteGroupPreview(pattern: string, options?: RedisDeleteGroupOptions): string {
  const isCluster = options?.isCluster ?? false;
  const dbIndex = !isCluster && options?.database != null && String(options.database).trim() !== "" ? Math.max(0, Number(String(options.database).trim().replace(/^db/i, ""))) : 0;
  const host = options?.connection?.host?.trim() || "127.0.0.1";
  const port = options?.connection?.port || 6379;
  const username = options?.connection?.username?.trim() || null;
  const password = options?.connection?.password != null && options.connection.password !== "" ? options.connection.password : null;
  const tls = options?.connection?.tls ?? false;
  const scanCount = options?.scanCount ?? 500;
  const batchSize = Math.max(1, options?.chunkSize ?? 512);

  const pyHost = JSON.stringify(host);
  const pyPort = port;
  const pyDb = dbIndex;
  const pyUser = username ? JSON.stringify(username) : "None";
  const pyPass = password ? JSON.stringify(password) : "None";
  const pyTls = tls ? "True" : "False";
  const pyCluster = isCluster ? "True" : "False";
  const pyPattern = JSON.stringify(pattern);
  const pyScanCount = scanCount;
  const pyBatchSize = batchSize;

  const headerComments = isCluster
    ? [
        "# Applicable: Redis Cluster (slot-routed multi-node execution)",
        `# Matches DBX delete_keys_by_pattern: SCAN COUNT ${scanCount}, bounded DEL <= ${batchSize} keys per slot batch`,
        "# Scans all master nodes via CLUSTER NODES, groups keys by CRC16 hash slot ({...} hash tags supported),",
        "# and executes DEL per slot batch to prevent CROSSSLOT errors while preserving raw bytes.",
      ]
    : [
        `# Applicable: Standalone Redis${dbIndex > 0 ? ` (db ${dbIndex})` : ""}`,
        `# Matches DBX delete_keys_by_pattern: SCAN COUNT ${scanCount}, bounded DEL <= ${batchSize} keys per batch`,
        "# Preserves raw byte fidelity (spaces, newlines, quotes, backslashes, binary) without argument splitting or delimiter corruption.",
      ];

  const script = [
    "python3 - << 'EOF'",
    "import sys, os, socket, ssl, binascii, subprocess, shlex",
    "",
    `HOST = ${pyHost}`,
    `PORT = ${pyPort}`,
    `DB = ${pyDb}`,
    `USERNAME = ${pyUser}`,
    `PASSWORD = ${pyPass}`,
    `TLS = ${pyTls}`,
    `IS_CLUSTER = ${pyCluster}`,
    `PATTERN = ${pyPattern}.encode("utf-8")`,
    `SCAN_COUNT = ${pyScanCount}`,
    `BATCH_SIZE = ${pyBatchSize}`,
    "",
    "def send_resp(f, args):",
    '    buf = bytearray(f"*{len(args)}\\r\\n".encode("utf-8"))',
    "    for a in args:",
    '        if isinstance(a, str): a = a.encode("utf-8")',
    '        buf.extend(f"${len(a)}\\r\\n".encode("utf-8") + a + b"\\r\\n")',
    "    f.write(buf)",
    "    f.flush()",
    "",
    "def read_resp(f):",
    "    line = f.readline()",
    "    if not line: return None",
    "    prefix = line[:1]",
    "    payload = line[1:-2]",
    '    if prefix == b"+": return payload',
    '    if prefix == b":": return int(payload)',
    '    if prefix == b"-": raise RuntimeError(payload.decode("utf-8", "replace"))',
    '    if prefix == b"$":',
    "        length = int(payload)",
    "        if length == -1: return None",
    "        data = f.read(length)",
    "        f.read(2)",
    "        return data",
    '    if prefix == b"*":',
    "        count = int(payload)",
    "        if count == -1: return None",
    "        return [read_resp(f) for _ in range(count)]",
    '    raise RuntimeError(f"Unknown RESP prefix: {prefix}")',
    "",
    "def get_crc16_slot(key: bytes) -> int:",
    '    s = key.find(b"{")',
    "    if s != -1:",
    '        e = key.find(b"}", s + 1)',
    "        if e != -1 and e > s + 1:",
    "            key = key[s + 1:e]",
    "    return binascii.crc_hqx(key, 0) & 0x3FFF",
    "",
    "def quote_redis_arg(b: bytes) -> str:",
    "    is_safe = True",
    "    for x in b:",
    '        if not (48 <= x <= 57 or 65 <= x <= 90 or 97 <= x <= 122 or x in b"_-:.@+~%"):',
    "            is_safe = False",
    "            break",
    '    if is_safe and len(b) > 0: return b.decode("ascii")',
    "    res = ['\"']",
    "    i = 0",
    "    while i < len(b):",
    "        x = b[i]",
    "        if x == 0x22: res.append('\\\\\"')",
    '        elif x == 0x5c: res.append("\\\\\\\\")',
    '        elif x == 0x0a: res.append("\\\\n")',
    '        elif x == 0x0d: res.append("\\\\r")',
    '        elif x == 0x09: res.append("\\\\t")',
    '        elif x == 0x07: res.append("\\\\a")',
    '        elif x == 0x08: res.append("\\\\b")',
    "        elif 0x20 <= x <= 0x7e: res.append(chr(x))",
    "        elif x >= 0x80:",
    "            matched = False",
    "            for length in (4, 3, 2):",
    "                if i + length <= len(b):",
    "                    try:",
    '                        ch = b[i:i+length].decode("utf-8")',
    "                        if not any(0x80 <= ord(c) <= 0x9f for c in ch):",
    "                            res.append(ch)",
    "                            i += length",
    "                            matched = True",
    "                            break",
    "                    except UnicodeDecodeError: pass",
    "            if not matched:",
    '                res.append(f"\\\\x{x:02x}")',
    "                i += 1",
    "            continue",
    "        else:",
    '            res.append(f"\\\\x{x:02x}")',
    "        i += 1",
    "    res.append('\"')",
    '    return "".join(res)',
    "",
    "def format_cli_arg(k: bytes) -> str:",
    '    if b"\\x00" in k:',
    "        return quote_redis_arg(k)",
    '    return k.decode("utf-8", "surrogateescape")',
    "",
    "def connect(host, port):",
    "    s = socket.create_connection((host, port), timeout=15)",
    "    if TLS:",
    "        ctx = ssl.create_default_context()",
    "        s = ctx.wrap_socket(s, server_hostname=host)",
    '    f = s.makefile("rwb")',
    "    if PASSWORD:",
    '        if USERNAME: send_resp(f, [b"AUTH", USERNAME.encode("utf-8"), PASSWORD.encode("utf-8")])',
    '        else: send_resp(f, [b"AUTH", PASSWORD.encode("utf-8")])',
    "        read_resp(f)",
    "    if not IS_CLUSTER and DB > 0:",
    '        send_resp(f, [b"SELECT", str(DB).encode("utf-8")])',
    "        read_resp(f)",
    "    return s, f",
    "",
    "def delete_batch(f, host, port, keys):",
    "    if not keys: return 0",
    '    receiver = os.environ.get("REDIS_CLI_RECEIVER") or os.environ.get("REDIS_CLI")',
    "    if receiver:",
    "        cmd = shlex.split(receiver)",
    '        if host: cmd.extend(["-h", host])',
    '        if port: cmd.extend(["-p", str(port)])',
    '        if not IS_CLUSTER and DB > 0: cmd.extend(["-n", str(DB)])',
    '        if USERNAME: cmd.extend(["--user", USERNAME])',
    '        if PASSWORD: cmd.extend(["-a", PASSWORD])',
    '        if TLS: cmd.append("--tls")',
    '        if IS_CLUSTER: cmd.append("-c")',
    '        cmd.append("DEL")',
    "        cmd.extend([format_cli_arg(k) if isinstance(k, bytes) else str(k) for k in keys])",
    "        subprocess.run(cmd, check=True)",
    "        return len(keys)",
    "    else:",
    '        send_resp(f, [b"DEL"] + list(keys))',
    "        res = read_resp(f)",
    "        return res if isinstance(res, int) else len(keys)",
    "",
    "def main():",
    "    s, f = connect(HOST, PORT)",
    "    nodes = [(HOST, PORT)]",
    "    if IS_CLUSTER:",
    "        try:",
    '            send_resp(f, [b"CLUSTER", b"NODES"])',
    "            raw = read_resp(f)",
    "            if isinstance(raw, bytes):",
    "                discovered = []",
    '                for line in raw.decode("utf-8", "replace").splitlines():',
    "                    p = line.split()",
    '                    if len(p) >= 3 and "master" in p[2] and "fail" not in p[2]:',
    '                        addr = p[1].split("@")[0]',
    '                        if ":" in addr:',
    '                            h, pt = addr.rsplit(":", 1)',
    "                            discovered.append((h, int(pt)))",
    "                if discovered: nodes = discovered",
    "        except Exception: pass",
    "",
    "    total_deleted = 0",
    "    for node_host, node_port in nodes:",
    "        node_s, node_f = (s, f) if (node_host == HOST and node_port == PORT) else connect(node_host, node_port)",
    "        try:",
    '            cursor = b"0"',
    "            if IS_CLUSTER:",
    "                slot_batches = {}",
    "                while True:",
    '                    send_resp(node_f, [b"SCAN", cursor, b"MATCH", PATTERN, b"COUNT", str(SCAN_COUNT).encode("utf-8")])',
    "                    resp = read_resp(node_f)",
    "                    cursor = resp[0]",
    "                    for k in resp[1]:",
    "                        slot = get_crc16_slot(k)",
    "                        batch = slot_batches.setdefault(slot, [])",
    "                        batch.append(k)",
    "                        if len(batch) >= BATCH_SIZE:",
    "                            total_deleted += delete_batch(node_f, node_host, node_port, batch)",
    "                            slot_batches[slot] = []",
    '                    if cursor == b"0": break',
    "                for slot, batch in slot_batches.items():",
    "                    if batch: total_deleted += delete_batch(node_f, node_host, node_port, batch)",
    "            else:",
    "                batch = []",
    "                while True:",
    '                    send_resp(node_f, [b"SCAN", cursor, b"MATCH", PATTERN, b"COUNT", str(SCAN_COUNT).encode("utf-8")])',
    "                    resp = read_resp(node_f)",
    "                    cursor = resp[0]",
    "                    for k in resp[1]:",
    "                        batch.append(k)",
    "                        if len(batch) >= BATCH_SIZE:",
    "                            total_deleted += delete_batch(node_f, node_host, node_port, batch)",
    "                            batch = []",
    '                    if cursor == b"0": break',
    "                if batch: total_deleted += delete_batch(node_f, node_host, node_port, batch)",
    "        finally:",
    "            if node_s is not s: node_s.close()",
    "    s.close()",
    '    print(f"Total deleted: {total_deleted}")',
    "",
    'if __name__ == "__main__":',
    "    main()",
    "EOF",
  ].join("\n");

  return [...headerComments, script].join("\n");
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
