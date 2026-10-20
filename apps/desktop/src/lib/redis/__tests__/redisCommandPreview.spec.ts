import { describe, expect, it } from "vitest";
import { quoteRedisArg, redisFlushDbPreview, redisDeleteKeysPreview, redisDeleteGroupPreview, redisDeleteValueItemPreview } from "../redisCommandPreview";

describe("quoteRedisArg", () => {
  it("quotes empty string", () => {
    expect(quoteRedisArg("")).toBe('""');
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

  it("quotes keys with quotes or backslashes", () => {
    expect(quoteRedisArg('key"with"doublequote')).toBe('"key\\"with\\"doublequote"');
    expect(quoteRedisArg("key'with'singlequote")).toBe("\"key'with'singlequote\"");
    expect(quoteRedisArg("key\\with\\backslash")).toBe('"key\\\\with\\\\backslash"');
  });
});

describe("redisFlushDbPreview", () => {
  it("prefixes with SELECT when database is provided", () => {
    expect(redisFlushDbPreview(6)).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview("6")).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview("db6")).toBe("SELECT 6\nFLUSHDB");
    expect(redisFlushDbPreview(0)).toBe("SELECT 0\nFLUSHDB");
    expect(redisFlushDbPreview("0")).toBe("SELECT 0\nFLUSHDB");
    expect(redisFlushDbPreview("db0")).toBe("SELECT 0\nFLUSHDB");
  });

  it("returns FLUSHDB when database is absent or empty", () => {
    expect(redisFlushDbPreview(undefined)).toBe("FLUSHDB");
    expect(redisFlushDbPreview(null)).toBe("FLUSHDB");
    expect(redisFlushDbPreview("")).toBe("FLUSHDB");
    expect(redisFlushDbPreview("  ")).toBe("FLUSHDB");
  });
});

describe("redisDeleteKeysPreview", () => {
  it("returns empty string when key list is empty", () => {
    expect(redisDeleteKeysPreview([])).toBe("");
  });

  it("formats single key deletion", () => {
    expect(redisDeleteKeysPreview(["user:1"])).toBe("DEL user:1");
    expect(redisDeleteKeysPreview(["key with space"])).toBe('DEL "key with space"');
  });

  it("formats multiple key deletions on a single line within chunkSize", () => {
    const keys = ["k1", "k2", "k3", "k4 with space"];
    expect(redisDeleteKeysPreview(keys)).toBe('DEL k1 k2 k3 "k4 with space"');
  });

  it("chunks large key lists across multiple DEL lines", () => {
    const keys = Array.from({ length: 7 }, (_, i) => `key:${i + 1}`);
    const preview = redisDeleteKeysPreview(keys, 3);
    expect(preview).toBe("DEL key:1 key:2 key:3\nDEL key:4 key:5 key:6\nDEL key:7");
  });
});

describe("redisDeleteGroupPreview", () => {
  it("formats EVAL command with pattern parameter", () => {
    expect(redisDeleteGroupPreview("user:*")).toBe("EVAL \"local keys = redis.call('keys', ARGV[1]) for _, k in ipairs(keys) do redis.call('del', k) end return #keys\" 0 user:*");
  });

  it("quotes pattern if it contains whitespace", () => {
    expect(redisDeleteGroupPreview("group with space:*")).toBe("EVAL \"local keys = redis.call('keys', ARGV[1]) for _, k in ipairs(keys) do redis.call('del', k) end return #keys\" 0 \"group with space:*\"");
  });
});

describe("redisDeleteValueItemPreview", () => {
  it("formats key deletion", () => {
    expect(redisDeleteValueItemPreview("user:100", { kind: "key" })).toBe("DEL user:100");
    expect(redisDeleteValueItemPreview("key with space", { kind: "key" })).toBe('DEL "key with space"');
  });

  it("formats hash field deletion", () => {
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: "email" })).toBe("HDEL user:100 email");
    expect(redisDeleteValueItemPreview("user:100", { kind: "hash", field: "full name" })).toBe('HDEL user:100 "full name"');
  });

  it("formats set member deletion", () => {
    expect(redisDeleteValueItemPreview("tags", { kind: "set", member: "vip" })).toBe("SREM tags vip");
    expect(redisDeleteValueItemPreview("tags", { kind: "set", member: "top customer" })).toBe('SREM tags "top customer"');
  });

  it("formats zset member deletion", () => {
    expect(redisDeleteValueItemPreview("leaderboard", { kind: "zset", member: "player1" })).toBe("ZREM leaderboard player1");
  });

  it("formats list index removal", () => {
    expect(redisDeleteValueItemPreview("queue", { kind: "list", index: 2 })).toBe('LSET queue 2 "__DELETED_PLACEHOLDER__"\nLREM queue 1 "__DELETED_PLACEHOLDER__"');
  });
});
