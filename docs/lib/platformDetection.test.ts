import assert from "node:assert/strict";
import { test } from "vitest";

import { detectPlatformId } from "./platformDetection";

const macUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";

test("detects an Intel Mac from Chromium architecture hints", async () => {
  const platformId = await detectPlatformId({
    userAgent: macUserAgent,
    userAgentData: {
      platform: "macOS",
      getHighEntropyValues: async () => ({ architecture: "x86" }),
    },
  });

  assert.equal(platformId, "macos-intel");
});

test("does not trust the Intel token in an Apple Silicon Mac user agent", async () => {
  const platformId = await detectPlatformId({
    userAgent: macUserAgent,
    userAgentData: {
      platform: "macOS",
      getHighEntropyValues: async () => ({ architecture: "arm" }),
    },
  });

  assert.equal(platformId, "macos-arm");
});

test("keeps the Apple Silicon fallback when architecture hints are unavailable", async () => {
  assert.equal(await detectPlatformId({ userAgent: macUserAgent }), "macos-arm");
});

test("keeps existing Windows and Linux detection", async () => {
  assert.equal(await detectPlatformId({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }), "windows");
  assert.equal(await detectPlatformId({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }), "linux");
  assert.equal(await detectPlatformId({ userAgent: "Mozilla/5.0 (X11; Linux aarch64)" }), "linux-arm");
});
