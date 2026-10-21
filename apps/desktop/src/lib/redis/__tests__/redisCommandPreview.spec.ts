import { describe, expect, it } from "vitest";
import { base64ToBytes, quoteRedisArg, quoteRedisBytes, quoteRedisKeyRaw, redisDeleteGroupPreview, redisDeleteKeysPreview, redisDeleteValueItemPreview, redisFlushDbPreview } from "../redisCommandPreview";
import { redisKeyTextToRaw } from "../redisCommandSession";

describe("quoteRedisArg and quoteRedisBytes", () => {
  it("quotes empty string", () => {
    expect(quoteRedisArg("")).toBe('""');
    expect(quoteRedisBytes(new Uint8Array([]))).toBe('""');
  });

  it("leaves simple keys unquoted", () => {
    expect(quoteRedisArg("simple_key")).toBe("simple_key");
    expect(quoteRedisArg("user:123:profile")).toBe("user:123:profile");
    expect(quoteRedisArg("cache-key.v1")).toBe("cache-key.v1");
  });

  it("quotes keys with whitespace", () => {
    expect(quoteRedisArg("key with space")).toBe('"key with space"');
    expect(quoteRedisArg("key\twith\ttab")).toBe('"key\\twith\\ttab"');
    expect(quoteRedisArg("key\nwith\nnewline")).toBe('"key\\nwith\\nnewline"');
  });

  it("quotes keys with quotes or backslashes with exact single-escaping", () => {
    expect(quoteRedisArg('key"with"doublequote')).toBe('"key\\"with\\"doublequote"');
    expect(quoteRedisArg("key'with'singlequote")).toBe("\"key'with'singlequote\"");
    expect(quoteRedisArg("key\\with\\backslash")).toBe('"key\\\\with\\\\backslash"');
  });

  it("quotes binary bytes and control characters with \\xHH", () => {
    const binaryBytes = new Uint8Array([0x00, 0x01, 0x1f, 0x7f, 0xff]);
    expect(quoteRedisBytes(binaryBytes)).toBe('"\\x00\\x01\\x1f\\x7f\\xff"');
  });

  it("preserves valid UTF-8 sequences verbatim inside quotes", () => {
    expect(quoteRedisArg("用户:123:设置")).toBe('"用户:123:设置"');
  });

  it("quotes RedisBlob objects using raw_base64 bytes", () => {
    const utf8Blob = { raw_base64: btoa("hello world"), encoding: "utf8" };
    expect(quoteRedisArg(utf8Blob)).toBe('"hello world"');

    const binaryBlob = { raw_base64: btoa("\x00\xff"), encoding: "binary" };
    expect(quoteRedisArg(binaryBlob)).toBe('"\\x00\\xff"');
  });
});

describe("quoteRedisKeyRaw", () => {
  it("recovers exact bytes from key_raw without double backslash escaping", () => {
    const rawWithBackslash = redisKeyTextToRaw("cache\\session");
    expect(quoteRedisKeyRaw(rawWithBackslash)).toBe('"cache\\\\session"');
  });

  it("quotes binary key_raw containing null bytes and high bytes", () => {
    const binaryRaw = btoa("k\x00\xff");
    expect(quoteRedisKeyRaw(binaryRaw)).toBe('"k\\x00\\xff"');
  });
});

describe("redisFlushDbPreview", () => {
  it("prefixes with SELECT in standalone mode when database is provided", () => {
    expect(redisFlushDbPreview(6)).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview("6")).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview("db6")).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview(0)).toBe("SELECT 0\nFLUSHDB");
    expect(redisFlushDbPreview("0")).toBe("SELECT 0\nFLUSHDB");
  });

  it("returns FLUSHDB when database is absent or empty", () => {
    expect(redisFlushDbPreview(undefined)).toBe("FLUSHDB");
    expect(redisFlushDbPreview(null)).toBe("FLUSHDB");
    expect(redisFlushDbPreview("")).toBe("FLUSHDB");
  });

  it("omits SELECT in Cluster mode because Cluster does not allow SELECT", () => {
    expect(redisFlushDbPreview(6, true)).toBe("FLUSHDB");
    expect(redisFlushDbPreview("db3", true)).toBe("FLUSHDB");
  });
});

describe("redisDeleteKeysPreview", () => {
  it("returns empty string when key list is empty", () => {
    expect(redisDeleteKeysPreview([])).toBe("");
  });

  it("formats single and multiple keys", () => {
    expect(redisDeleteKeysPreview(["user:1"])).toBe("DEL user:1");
    expect(redisDeleteKeysPreview(["user:1", "user:2", "cache:session with space"])).toBe('DEL user:1 user:2 "cache:session with space"');
  });

  it("chunks large key lists across multiple DEL lines", () => {
    const keys = Array.from({ length: 7 }, (_, i) => `key:${i + 1}`);
    const preview = redisDeleteKeysPreview(keys, 3);
    expect(preview).toBe("DEL key:1 key:2 key:3\nDEL key:4 key:5 key:6\nDEL key:7");
  });

  it("handles base64 key_raw directly with raw: true", () => {
    const keyRaws = [redisKeyTextToRaw("user:1"), redisKeyTextToRaw("path\\to\\key"), btoa("bin\x00key")];
    const preview = redisDeleteKeysPreview(keyRaws, { raw: true });
    expect(preview).toBe('DEL user:1 "path\\\\to\\\\key" "bin\\x00key"');
  });

  it("prefixes SELECT for non-zero database in standalone mode", () => {
    const keys = ["k1", "k2"];
    expect(redisDeleteKeysPreview(keys, { database: 3 })).toBe("SELECT 3\nDEL k1 k2");
    expect(redisDeleteKeysPreview(keys, { database: 0 })).toBe("DEL k1 k2");
    expect(redisDeleteKeysPreview(keys, { database: 3, isCluster: true })).toBe("DEL k1 k2");
  });
});

describe("redisDeleteGroupPreview", () => {
  it("formats bounded standalone scan-and-delete command with batch limit 512", () => {
    const preview = redisDeleteGroupPreview("user:*");
    expect(preview).toContain("# Applicable: Standalone Redis");
    expect(preview).toContain("SCAN COUNT 500, DEL in batches of up to 512 keys");
    expect(preview).toContain('redis-cli --scan --pattern "user:*" | xargs -L 512 redis-cli DEL');
    expect(preview).not.toContain("EVAL");
  });

  it("includes -n <db> for non-zero database in standalone mode", () => {
    const preview = redisDeleteGroupPreview("user:*", { database: 2 });
    expect(preview).toContain("# Applicable: Standalone Redis (db 2)");
    expect(preview).toContain('redis-cli -n 2 --scan --pattern "user:*" | xargs -L 512 redis-cli -n 2 DEL');
  });

  it("formats cluster preview with per-node execution documentation and avoids cross-slot EVAL", () => {
    const preview = redisDeleteGroupPreview("cache:*", { isCluster: true });
    expect(preview).toContain("# Applicable: Redis Cluster (per-node execution)");
    expect(preview).toContain("Cross-slot");
    expect(preview).toContain('redis-cli -h <node-host> -p <node-port> --scan --pattern "cache:*" | xargs -L 512 redis-cli -h <node-host> -p <node-port> DEL');
    expect(preview).not.toContain("EVAL");
  });
});

describe("redisDeleteValueItemPreview", () => {
  it("formats key deletion", () => {
    expect(redisDeleteValueItemPreview("user:100", { kind: "key" })).toBe("DEL user:100");
  });

  it("formats hash field deletion with raw bytes and special characters", () => {
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: "email" })).toBe("HDEL user:100 email");
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: "path\\field" })).toBe('HDEL user:100 "path\\\\field"');

    const binaryBlob = { raw_base64: btoa("\x00\x01\xff"), encoding: "binary" };
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: binaryBlob })).toBe('HDEL user:100 "\\x00\\x01\\xff"');
  });

  it("formats set member deletion with raw bytes and special characters", () => {
    expect(redisDeleteValueItemPreview("tags", { kind: "set", member: "vip" })).toBe("SREM tags vip");

    const binaryBlob = { raw_base64: btoa("sub\x00member"), encoding: "binary" };
    expect(redisDeleteValueItemPreview("tags", { kind: "set", member: binaryBlob })).toBe('SREM tags "sub\\x00member"');
  });

  it("formats zset member deletion", () => {
    expect(redisDeleteValueItemPreview("leaderboard", { kind: "zset", member: "player1" })).toBe("ZREM leaderboard player1");
  });

  it("formats list index removal", () => {
    expect(redisDeleteValueItemPreview("queue", { kind: "list", index: 2 })).toBe('LSET queue 2 "__DELETED_PLACEHOLDER__"\nLREM queue 1 "__DELETED_PLACEHOLDER__"');
  });

  it("respects raw key and non-zero database options", () => {
    const rawKey = redisKeyTextToRaw("user\\name");
    const preview = redisDeleteValueItemPreview(rawKey, { kind: "hash", field: "attr" }, { raw: true, database: 4 });
    expect(preview).toBe('SELECT 4\nHDEL "user\\\\name" attr');
  });

  it("omits SELECT in Cluster mode", () => {
    const rawKey = redisKeyTextToRaw("user\\name");
    const preview = redisDeleteValueItemPreview(rawKey, { kind: "hash", field: "attr" }, { raw: true, database: 4, isCluster: true });
    expect(preview).toBe('HDEL "user\\\\name" attr');
  });
});
