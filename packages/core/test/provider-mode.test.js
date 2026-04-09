const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const https = require("node:https");
const { EventEmitter } = require("node:events");

const core = require("../dist");

const originalCodexHome = process.env.CODEX_HOME;
const originalNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

function createTempCodexHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codex-account-switch-"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf-8");
}

function writeText(filePath, value) {
  fs.writeFileSync(filePath, value, "utf-8");
}

function jwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function makeAccountAuth(accountId, refreshToken, accessToken = `access-${accountId}`) {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: accountId,
      access_token: accessToken,
      refresh_token: refreshToken,
    },
  };
}

function withMockedHttpsRequest(mockImpl, fn) {
  const original = https.request;
  https.request = mockImpl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      https.request = original;
    });
}

function createQueuedHttpsMock(responses) {
  return (options, handler) => {
    const next = responses.shift();
    assert.ok(next, "Unexpected https.request call");

    const response = new EventEmitter();
    response.statusCode = next.statusCode;

    const request = new EventEmitter();
    let writtenBody = "";
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = (chunk) => {
      writtenBody += chunk;
    };
    request.end = () => {
      if (typeof next.assertRequest === "function") {
        next.assertRequest(options, writtenBody);
      }
      handler(response);
      if (next.body != null) {
        response.emit("data", next.body);
      }
      response.emit("end");
    };

    return request;
  };
}

function restoreEnv() {
  if (originalCodexHome == null) {
    delete process.env.CODEX_HOME;
  } else {
    process.env.CODEX_HOME = originalCodexHome;
  }

  if (originalNamedAuthDir == null) {
    delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  } else {
    process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR = originalNamedAuthDir;
  }

  core.setNamedAuthDir(undefined);
}

test.afterEach(() => {
  restoreEnv();
});

test("refresh token status reports available when a refresh token exists", () => {
  const auth = {
    tokens: {
      refresh_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3 * 24 * 3600 }),
    },
  };

  assert.equal(core.getRefreshTokenStatus(auth), "available");
  assert.equal(core.formatRefreshTokenStatus(auth), "available");
});

test("refresh token status reports missing when the refresh token is absent", () => {
  const auth = {
    tokens: {
      refresh_token: "",
    },
  };

  assert.equal(core.getRefreshTokenStatus(auth), "missing");
  assert.equal(core.formatRefreshTokenStatus(auth), "missing");
});

test("refresh token status ignores legacy refresh expiry fields", () => {
  const auth = {
    refresh_token_expires_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
    tokens: {
      refresh_token: "rt-opaque-token",
    },
  };

  assert.equal(core.getRefreshTokenStatus(auth), "available");
  assert.equal(core.formatRefreshTokenStatus(auth), "available");
});

test("deserializeSavedValue accepts encrypted envelopes with visible sync metadata", () => {
  core.setSavedAuthPassphrase("sync-metadata-passphrase");
  const envelope = core.serializeSavedValue(
    "saved_auth",
    makeAccountAuth("acct-sync", "refresh-sync"),
    { requireEncryption: true }
  );
  envelope.entryVersion = 7;
  envelope.updatedAt = "2026-04-09T00:00:00.000Z";

  const result = core.deserializeSavedValue(envelope, "saved_auth");

  assert.equal(result.status, "ok");
  assert.equal(result.encrypted, true);
  assert.equal(result.value.tokens.account_id, "acct-sync");
  core.setSavedAuthPassphrase(null);
});

test("listModes returns only account when no provider files exist", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  assert.deepEqual(core.listModes(), ["account"]);
  assert.equal(core.getModeDisplayName("cliproxyapi"), "cliproxyapi");
  assert.equal(core.getModeDisplayName("my-proxy"), "my-proxy");
});

test("listModes includes provider files from disk", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: { OPENAI_API_KEY: "sk-test" },
    config: { name: "cliproxyapi", base_url: "http://127.0.0.1:34046/v1", wire_api: "responses" },
  });

  writeJson(path.join(codexHome, "provider_my-proxy.json"), {
    kind: "provider",
    name: "my-proxy",
    auth: { OPENAI_API_KEY: "sk-other" },
    config: { name: "my-proxy", base_url: "http://example.com/v1", wire_api: "responses" },
  });

  const modes = core.listModes();
  assert.ok(modes.includes("account"));
  assert.ok(modes.includes("cliproxyapi"));
  assert.ok(modes.includes("my-proxy"));
});

test("switchMode writes provider auth and config while preserving unrelated config", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: {
      OPENAI_API_KEY: "sk-qtdev",
    },
    config: {
      name: "cliproxyapi",
      base_url: "http://127.0.0.1:34046/v1",
      wire_api: "responses",
    },
  });

  writeText(
    path.join(codexHome, "config.toml"),
    [
      'model = "gpt-5.4"',
      "",
      "[features]",
      "unified_exec = true",
      "",
      "[model_providers.other]",
      'name = "other"',
      'base_url = "https://example.com/v1"',
    ].join("\n")
  );

  const result = core.switchMode("cliproxyapi");
  assert.equal(result.success, true);
  assert.equal(result.message, 'Switched to mode "cliproxyapi"');

  const auth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.deepEqual(auth, { OPENAI_API_KEY: "sk-qtdev" });

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "cliproxyapi"/m);
  assert.match(config, /\[features\][\s\S]*unified_exec = true/m);
  assert.match(config, /\[model_providers\.other\][\s\S]*base_url = "https:\/\/example\.com\/v1"/m);
  assert.match(config, /\[model_providers\.cliproxyapi\]/m);
  assert.match(config, /wire_api = "responses"/m);

  assert.deepEqual(core.getCurrentSelection(), { kind: "provider", name: "cliproxyapi" });
});

test("switchMode works with custom-named providers", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_my-local.json"), {
    kind: "provider",
    name: "my-local",
    auth: { OPENAI_API_KEY: "sk-local" },
    config: { name: "my-local", base_url: "http://localhost:8080/v1", wire_api: "chat" },
  });

  const result = core.switchMode("my-local");
  assert.equal(result.success, true);
  assert.equal(result.message, 'Switched to mode "my-local"');

  const auth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(auth.OPENAI_API_KEY, "sk-local");

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "my-local"/m);
  assert.match(config, /\[model_providers\.my-local\]/m);

  assert.deepEqual(core.getCurrentSelection(), { kind: "provider", name: "my-local" });
});

test("useAccount clears the active provider and restores account auth", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth_work.json"), {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: "acct-work",
      access_token: "access-token",
      refresh_token: "refresh-token",
    },
  });

  writeJson(path.join(codexHome, "auth.json"), {
    OPENAI_API_KEY: "sk-qtdev",
  });

  writeText(
    path.join(codexHome, "config.toml"),
    [
      'model_provider = "cliproxyapi"',
      "",
      "[model_providers.cliproxyapi]",
      'name = "cliproxyapi"',
      'base_url = "http://127.0.0.1:34046/v1"',
      'wire_api = "responses"',
    ].join("\n")
  );

  const result = core.useAccount("work");
  assert.equal(result.success, true);

  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(currentAuth.tokens.account_id, "acct-work");
  assert.equal(core.getActiveModelProvider(), null);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.doesNotMatch(config, /^model_provider =/m);
  assert.match(config, /\[model_providers\.cliproxyapi\]/m);
  assert.deepEqual(core.getCurrentSelection(), {
    kind: "account",
    name: "work",
    meta: { email: "unknown", name: "unknown", plan: "unknown" },
  });
});

test("useAccount syncs the latest current auth back to the saved account before switching", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth_work.json"), makeAccountAuth("acct-work", "rt-stale", "access-stale"));
  writeJson(path.join(codexHome, "auth_other.json"), makeAccountAuth("acct-other", "rt-other", "access-other"));
  writeJson(path.join(codexHome, "auth.json"), makeAccountAuth("acct-work", "rt-fresh", "access-fresh"));

  const result = core.useAccount("other");
  assert.equal(result.success, true);

  const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
  assert.equal(savedWork.tokens.refresh_token, "rt-fresh");
  assert.equal(savedWork.tokens.access_token, "access-fresh");

  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(currentAuth.tokens.account_id, "acct-other");
  assert.equal(currentAuth.tokens.refresh_token, "rt-other");
});

test("addAccountFromAuth rejects provider auth payloads", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth.json"), {
    OPENAI_API_KEY: "sk-qtdev",
  });

  const result = core.addAccountFromAuth("bad");
  assert.equal(result.success, false);
  assert.match(result.message, /not a valid account login result/i);
  assert.equal(fs.existsSync(path.join(codexHome, "auth_bad.json")), false);
});

test("addAccountFromAuth rejects overwriting an existing account with a different identity", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth_work.json"), makeAccountAuth("acct-work", "rt-work", "access-work"));
  writeJson(path.join(codexHome, "auth.json"), makeAccountAuth("acct-other", "rt-other", "access-other"));

  const result = core.addAccountFromAuth("work");
  assert.equal(result.success, false);
  assert.match(result.message, /belongs to a different account/i);

  const saved = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
  assert.equal(saved.tokens.account_id, "acct-work");
});

test("queryQuota and refreshAccount report unsupported for provider mode without an account name", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeText(
    path.join(codexHome, "config.toml"),
    [
      'model_provider = "cliproxyapi"',
      "",
      "[model_providers.cliproxyapi]",
      'name = "cliproxyapi"',
      'base_url = "http://127.0.0.1:34046/v1"',
      'wire_api = "responses"',
    ].join("\n")
  );
  writeJson(path.join(codexHome, "auth.json"), { OPENAI_API_KEY: "sk-qtdev" });

  const quotaResult = await core.queryQuota();
  assert.equal(quotaResult.kind, "unsupported");
  assert.match(quotaResult.message, /provider mode "cliproxyapi"/i);

  const refreshResult = await core.refreshAccount();
  assert.equal(refreshResult.success, false);
  assert.equal(refreshResult.unsupported, true);
  assert.match(refreshResult.message, /provider mode "cliproxyapi"/i);
});

test("switchMode syncs the latest current account auth before writing provider auth", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth_work.json"), makeAccountAuth("acct-work", "rt-stale", "access-stale"));
  writeJson(path.join(codexHome, "auth.json"), makeAccountAuth("acct-work", "rt-fresh", "access-fresh"));
  writeJson(path.join(codexHome, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: { OPENAI_API_KEY: "sk-qtdev" },
    config: {
      name: "cliproxyapi",
      base_url: "http://127.0.0.1:34046/v1",
      wire_api: "responses",
    },
  });

  const result = core.switchMode("cliproxyapi");
  assert.equal(result.success, true);

  const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
  assert.equal(savedWork.tokens.refresh_token, "rt-fresh");
  assert.equal(savedWork.tokens.access_token, "access-fresh");

  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.deepEqual(currentAuth, { OPENAI_API_KEY: "sk-qtdev" });
});

test("refreshAccount syncs the current auth before refreshing and writes the rotated token back to both files", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth_work.json"), {
    ...makeAccountAuth("acct-work", "rt-stale", "access-stale"),
    refresh_token_expires_at: "2099-01-01T00:00:00.000Z",
  });
  writeJson(path.join(codexHome, "auth.json"), {
    ...makeAccountAuth("acct-work", "rt-current", "access-current"),
    refresh_token_expires_at: "2099-01-01T00:00:00.000Z",
  });

  const responses = [
    {
      statusCode: 200,
      body: JSON.stringify({
        access_token: "access-rotated",
        refresh_token: "rt-rotated",
        id_token: "id-rotated",
      }),
      assertRequest: (options, body) => {
        assert.equal(options.hostname, "auth.openai.com");
        assert.match(body, /refresh_token=rt-current/);
      },
    },
  ];

  await withMockedHttpsRequest(createQueuedHttpsMock(responses), async () => {
    const result = await core.refreshAccount("work");
    assert.equal(result.success, true);
  });

  const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
  assert.equal(savedWork.tokens.refresh_token, "rt-rotated");
  assert.equal(savedWork.tokens.access_token, "access-rotated");
  assert.equal(savedWork.tokens.id_token, "id-rotated");
  assert.ok(typeof savedWork.last_refresh === "string");
  assert.equal("refresh_token_expires_at" in savedWork, false);
  assert.equal(core.formatRefreshTokenStatus(savedWork), "available");

  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(currentAuth.tokens.refresh_token, "rt-rotated");
  assert.equal(currentAuth.tokens.access_token, "access-rotated");
  assert.equal(currentAuth.tokens.id_token, "id-rotated");
  assert.equal("refresh_token_expires_at" in currentAuth, false);
});

test("queryQuota proactively refreshes when last_refresh is missing", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth_work.json"), makeAccountAuth("acct-work", "rt-stale", "access-stale"));
  writeJson(path.join(codexHome, "auth.json"), makeAccountAuth("acct-work", "rt-current", "access-current"));

  const responses = [
    {
      statusCode: 200,
      body: JSON.stringify({
        access_token: "access-rotated",
        refresh_token: "rt-rotated",
        id_token: "id-rotated",
      }),
      assertRequest: (options, body) => {
        assert.equal(options.hostname, "auth.openai.com");
        assert.match(body, /refresh_token=rt-current/);
      },
    },
    {
      statusCode: 200,
      body: JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 10,
            reset_at: null,
          },
        },
      }),
      assertRequest: (options) => {
        assert.equal(options.hostname, "chatgpt.com");
        assert.equal(options.headers.Authorization, "Bearer access-rotated");
        const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedWork.tokens.refresh_token, "rt-rotated");
        assert.equal(currentAuth.tokens.refresh_token, "rt-rotated");
      },
    },
  ];

  await withMockedHttpsRequest(createQueuedHttpsMock(responses), async () => {
    const result = await core.queryQuota("work");
    assert.equal(result.kind, "ok");
    assert.equal(result.info.plan, "plus");
  });

  const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
  assert.equal(savedWork.tokens.refresh_token, "rt-rotated");
  assert.equal(savedWork.tokens.access_token, "access-rotated");
  assert.equal(savedWork.tokens.id_token, "id-rotated");
  assert.ok(typeof savedWork.last_refresh === "string");
  assert.equal("refresh_token_expires_at" in savedWork, false);

  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(currentAuth.tokens.refresh_token, "rt-rotated");
  assert.equal(currentAuth.tokens.access_token, "access-rotated");
  assert.equal(currentAuth.tokens.id_token, "id-rotated");
  assert.equal("refresh_token_expires_at" in currentAuth, false);
});

test("queryQuota proactively refreshes when last_refresh is older than one day", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const staleRefresh = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  writeJson(path.join(codexHome, "auth_work.json"), {
    ...makeAccountAuth("acct-work", "rt-stale", "access-stale"),
    last_refresh: staleRefresh,
  });
  writeJson(path.join(codexHome, "auth.json"), {
    ...makeAccountAuth("acct-work", "rt-current", "access-current"),
    last_refresh: staleRefresh,
  });

  const responses = [
    {
      statusCode: 200,
      body: JSON.stringify({
        access_token: "access-rotated",
        refresh_token: "rt-rotated",
      }),
      assertRequest: (options, body) => {
        assert.equal(options.hostname, "auth.openai.com");
        assert.match(body, /refresh_token=rt-current/);
      },
    },
    {
      statusCode: 200,
      body: JSON.stringify({
        plan_type: "plus",
      }),
      assertRequest: (options) => {
        assert.equal(options.hostname, "chatgpt.com");
        assert.equal(options.headers.Authorization, "Bearer access-rotated");
      },
    },
  ];

  await withMockedHttpsRequest(createQueuedHttpsMock(responses), async () => {
    const result = await core.queryQuota("work");
    assert.equal(result.kind, "ok");
  });
});

test("queryQuota skips proactive refresh when last_refresh is recent", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const freshRefresh = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  writeJson(path.join(codexHome, "auth_work.json"), {
    ...makeAccountAuth("acct-work", "rt-work", "access-current"),
    last_refresh: freshRefresh,
  });
  writeJson(path.join(codexHome, "auth.json"), {
    ...makeAccountAuth("acct-work", "rt-work", "access-current"),
    last_refresh: freshRefresh,
  });

  const responses = [
    {
      statusCode: 200,
      body: JSON.stringify({
        plan_type: "plus",
      }),
      assertRequest: (options) => {
        assert.equal(options.hostname, "chatgpt.com");
        assert.equal(options.headers.Authorization, "Bearer access-current");
      },
    },
  ];

  await withMockedHttpsRequest(createQueuedHttpsMock(responses), async () => {
    const result = await core.queryQuota("work");
    assert.equal(result.kind, "ok");
  });
});

test("queryQuota refreshes on 401 and retries once when last_refresh is recent", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const freshRefresh = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  writeJson(path.join(codexHome, "auth_work.json"), {
    ...makeAccountAuth("acct-work", "rt-stale", "access-stale"),
    last_refresh: freshRefresh,
  });
  writeJson(path.join(codexHome, "auth.json"), {
    ...makeAccountAuth("acct-work", "rt-current", "access-current"),
    last_refresh: freshRefresh,
  });

  const responses = [
    {
      statusCode: 401,
      body: JSON.stringify({ detail: "expired access token" }),
      assertRequest: (options) => {
        assert.equal(options.hostname, "chatgpt.com");
        assert.equal(options.headers.Authorization, "Bearer access-current");
      },
    },
    {
      statusCode: 200,
      body: JSON.stringify({
        access_token: "access-rotated",
        refresh_token: "rt-rotated",
        id_token: "id-rotated",
      }),
      assertRequest: (options, body) => {
        assert.equal(options.hostname, "auth.openai.com");
        assert.match(body, /refresh_token=rt-current/);
      },
    },
    {
      statusCode: 200,
      body: JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: {
            used_percent: 10,
            reset_at: null,
          },
        },
      }),
      assertRequest: (options) => {
        assert.equal(options.hostname, "chatgpt.com");
        assert.equal(options.headers.Authorization, "Bearer access-rotated");
        const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedWork.tokens.refresh_token, "rt-rotated");
        assert.equal(currentAuth.tokens.refresh_token, "rt-rotated");
      },
    },
  ];

  await withMockedHttpsRequest(createQueuedHttpsMock(responses), async () => {
    const result = await core.queryQuota("work");
    assert.equal(result.kind, "ok");
    assert.equal(result.info.plan, "plus");
  });

  const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
  assert.equal(savedWork.tokens.refresh_token, "rt-rotated");
  assert.equal(savedWork.tokens.access_token, "access-rotated");
  assert.equal(savedWork.tokens.id_token, "id-rotated");
  assert.ok(typeof savedWork.last_refresh === "string");
  assert.equal("refresh_token_expires_at" in savedWork, false);

  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(currentAuth.tokens.refresh_token, "rt-rotated");
  assert.equal(currentAuth.tokens.access_token, "access-rotated");
  assert.equal(currentAuth.tokens.id_token, "id-rotated");
  assert.equal("refresh_token_expires_at" in currentAuth, false);
});

test("queryQuota serializes concurrent refreshes for the same account", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "auth_work.json"), makeAccountAuth("acct-work", "rt-current", "access-current"));
  writeJson(path.join(codexHome, "auth.json"), makeAccountAuth("acct-work", "rt-current", "access-current"));

  const responses = [
    {
      statusCode: 200,
      body: JSON.stringify({
        access_token: "access-rotated",
        refresh_token: "rt-rotated",
        id_token: "id-rotated",
      }),
      assertRequest: (options, body) => {
        assert.equal(options.hostname, "auth.openai.com");
        assert.match(body, /refresh_token=rt-current/);
      },
    },
    {
      statusCode: 200,
      body: JSON.stringify({
        plan_type: "plus",
      }),
      assertRequest: (options) => {
        assert.equal(options.hostname, "chatgpt.com");
        assert.equal(options.headers.Authorization, "Bearer access-rotated");
      },
    },
    {
      statusCode: 200,
      body: JSON.stringify({
        plan_type: "plus",
      }),
      assertRequest: (options) => {
        assert.equal(options.hostname, "chatgpt.com");
        assert.equal(options.headers.Authorization, "Bearer access-rotated");
      },
    },
  ];

  await withMockedHttpsRequest(createQueuedHttpsMock(responses), async () => {
    const [first, second] = await Promise.all([core.queryQuota("work"), core.queryQuota("work")]);
    assert.equal(first.kind, "ok");
    assert.equal(second.kind, "ok");
  });

  const savedWork = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_work.json"), "utf-8"));
  assert.equal(savedWork.tokens.refresh_token, "rt-rotated");
  assert.equal(savedWork.tokens.access_token, "access-rotated");
});

test("queryQuota coalesces concurrent lookups for the same account", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const freshRefresh = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  writeJson(path.join(codexHome, "auth_work.json"), {
    ...makeAccountAuth("acct-work", "rt-work", "access-current"),
    last_refresh: freshRefresh,
  });
  writeJson(path.join(codexHome, "auth.json"), {
    ...makeAccountAuth("acct-work", "rt-work", "access-current"),
    last_refresh: freshRefresh,
  });

  let usageRequestCount = 0;
  let releaseUsageResponse;

  await withMockedHttpsRequest((options, handler) => {
    assert.equal(options.hostname, "chatgpt.com");
    usageRequestCount += 1;
    assert.equal(usageRequestCount, 1, "concurrent quota lookups should share one usage request");

    const response = new EventEmitter();
    response.statusCode = 200;

    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => {};
    request.write = () => {};
    request.end = () => {
      releaseUsageResponse = () => {
        handler(response);
        response.emit("data", JSON.stringify({ plan_type: "plus" }));
        response.emit("end");
      };
    };

    return request;
  }, async () => {
    const first = core.queryQuota("work");
    const second = core.queryQuota("work");

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof releaseUsageResponse, "function");

    releaseUsageResponse();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.kind, "ok");
    assert.equal(secondResult.kind, "ok");
  });

  assert.equal(usageRequestCount, 1);
});

test("queryQuota removes a stale lock left by a dead process", async () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const freshRefresh = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  writeJson(path.join(codexHome, "auth_work.json"), {
    ...makeAccountAuth("acct-work", "rt-work", "access-current"),
    last_refresh: freshRefresh,
  });
  writeJson(path.join(codexHome, "auth.json"), {
    ...makeAccountAuth("acct-work", "rt-work", "access-current"),
    last_refresh: freshRefresh,
  });

  const locksDir = path.join(codexHome, ".locks");
  fs.mkdirSync(locksDir, { recursive: true });
  const staleLockPath = path.join(locksDir, "account-315faf43d55d5eea80186bb8a33c4abe6e2e05bd.lock");
  writeJson(staleLockPath, {
    pid: 999999,
    startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  });

  await withMockedHttpsRequest(
    createQueuedHttpsMock([
      {
        statusCode: 200,
        body: JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 25,
              reset_at: null,
            },
          },
        }),
        assertRequest: (options) => {
          assert.equal(options.hostname, "chatgpt.com");
          assert.equal(options.headers.Authorization, "Bearer access-current");
        },
      },
    ]),
    async () => {
      const result = await core.queryQuota("work");
      assert.equal(result.kind, "ok");
      assert.equal(result.info.plan, "plus");
    }
  );

  assert.equal(fs.existsSync(staleLockPath), false);
});

test("writeAuthFile strips legacy refresh_token_expires_at fields", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const authPath = path.join(codexHome, "auth_work.json");
  core.writeAuthFile(authPath, {
    ...makeAccountAuth("acct-work", "rt-work", "access-work"),
    refresh_token_expires_at: "2099-01-01T00:00:00.000Z",
    ignored_field: "ignored",
  });

  const saved = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  assert.equal(saved.refresh_token_expires_at, undefined);
  assert.equal(saved.ignored_field, undefined);
});

test("saved auth files can be encrypted and later unlocked with a passphrase", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const authPath = path.join(codexHome, "auth_work.json");
  core.setSavedAuthPassphrase("test-passphrase");
  core.writeSavedAuthFile(authPath, makeAccountAuth("acct-work", "rt-work", "access-work"));

  const raw = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  assert.equal(raw.kind, "saved_auth");
  assert.equal(core.hasEncryptedSavedFiles(), true);

  core.setSavedAuthPassphrase(null);
  const locked = core.readSavedAuthFileResult(authPath);
  assert.equal(locked.status, "locked");

  core.setSavedAuthPassphrase("test-passphrase");
  const reopened = core.readSavedAuthFileResult(authPath);
  assert.equal(reopened.status, "ok");
  assert.equal(reopened.value.tokens.account_id, "acct-work");
});

test("useAccount reports locked storage when the saved account is encrypted but no passphrase is loaded", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const authPath = path.join(codexHome, "auth_work.json");
  core.setSavedAuthPassphrase("test-passphrase");
  core.writeSavedAuthFile(authPath, makeAccountAuth("acct-work", "rt-work", "access-work"));
  core.setSavedAuthPassphrase(null);

  const accounts = core.listAccounts();
  assert.equal(accounts[0].storageState, "locked");

  const result = core.useAccount("work");
  assert.equal(result.success, false);
  assert.match(result.message, /saved auth storage is locked/i);
  assert.equal(fs.existsSync(path.join(codexHome, "auth.json")), false);
});

test("useAccount decrypts encrypted saved auth while keeping the current auth file plaintext", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const authPath = path.join(codexHome, "auth_work.json");
  core.setSavedAuthPassphrase("test-passphrase");
  core.writeSavedAuthFile(authPath, makeAccountAuth("acct-work", "rt-work", "access-work"));

  const result = core.useAccount("work");
  assert.equal(result.success, true);

  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(currentAuth.tokens.account_id, "acct-work");

  const rawSaved = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  assert.equal(rawSaved.kind, "saved_auth");
});

test("provider profiles can be encrypted and report locked storage without a passphrase", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  core.setSavedAuthPassphrase("test-passphrase");
  core.writeProviderProfile({
    kind: "provider",
    name: "corp",
    auth: { OPENAI_API_KEY: "sk-corp" },
    config: { name: "corp", base_url: "http://corp.local/v1", wire_api: "responses" },
  });

  const providerPath = path.join(codexHome, "provider_corp.json");
  const raw = JSON.parse(fs.readFileSync(providerPath, "utf-8"));
  assert.equal(raw.kind, "saved_provider");

  core.setSavedAuthPassphrase(null);
  const locked = core.readProviderProfileResult("corp");
  assert.equal(locked.status, "locked");

  const switchLocked = core.switchMode("corp");
  assert.equal(switchLocked.success, false);
  assert.match(switchLocked.message, /saved auth storage is locked/i);

  core.setSavedAuthPassphrase("test-passphrase");
  const switchUnlocked = core.switchMode("corp");
  assert.equal(switchUnlocked.success, true);
  const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(currentAuth.OPENAI_API_KEY, "sk-corp");
});

test("changeSavedAuthPassphrase rewrites encrypted saved files to the new passphrase", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const authPath = path.join(codexHome, "auth_work.json");
  core.setSavedAuthPassphrase("old-passphrase");
  core.writeSavedAuthFile(authPath, makeAccountAuth("acct-work", "rt-work", "access-work"));

  const result = core.changeSavedAuthPassphrase("new-passphrase");
  assert.equal(result.rewritten, 1);

  core.setSavedAuthPassphrase("old-passphrase");
  const oldPassRead = core.readSavedAuthFileResult(authPath);
  assert.equal(oldPassRead.status, "locked");

  core.setSavedAuthPassphrase("new-passphrase");
  const newPassRead = core.readSavedAuthFileResult(authPath);
  assert.equal(newPassRead.status, "ok");
  assert.equal(newPassRead.value.tokens.account_id, "acct-work");
});

test("switchMode removes leading blank lines from config.toml", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: {
      OPENAI_API_KEY: "sk-qtdev",
    },
    config: {
      name: "cliproxyapi",
      base_url: "http://127.0.0.1:34046/v1",
      wire_api: "responses",
    },
  });

  writeText(
    path.join(codexHome, "config.toml"),
    [
      "",
      "",
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      "",
    ].join("\n")
  );

  const switchResult = core.switchMode("cliproxyapi");
  assert.equal(switchResult.success, true);

  let config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.doesNotMatch(config, /^\s*\r?\n/);
  assert.match(config, /^model_provider = "cliproxyapi"/m);

  const useResult = core.useAccount("missing");
  assert.equal(useResult.success, false);

  core.clearActiveModelProvider();
  config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.doesNotMatch(config, /^\s*\r?\n/);
  assert.match(config, /^sandbox_mode = "workspace-write"/m);
});

test("getDefaultProviderProfile returns template for any name", () => {
  const profile = core.getDefaultProviderProfile("my-custom");
  assert.equal(profile.kind, "provider");
  assert.equal(profile.name, "my-custom");
  assert.equal(profile.config.name, "my-custom");
  assert.equal(profile.config.wire_api, "responses");
  assert.equal(profile.config.base_url, "");
});

test("deleteProviderProfile removes a saved provider profile", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: { OPENAI_API_KEY: "sk-test" },
    config: { name: "cliproxyapi", base_url: "http://127.0.0.1:34046/v1", wire_api: "responses" },
  });
  writeText(
    path.join(codexHome, "config.toml"),
    [
      '[model_providers.cliproxyapi]',
      'name = "cliproxyapi"',
      'base_url = "http://127.0.0.1:34046/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.other]",
      'name = "other"',
      'base_url = "https://example.com/v1"',
      'wire_api = "responses"',
    ].join("\n")
  );

  const result = core.deleteProviderProfile("cliproxyapi");
  assert.equal(result.success, true);
  assert.equal(result.deactivated, false);
  assert.equal(result.message, 'Removed provider "cliproxyapi"');
  assert.equal(fs.existsSync(path.join(codexHome, "provider_cliproxyapi.json")), false);
  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.doesNotMatch(config, /\[model_providers\.cliproxyapi\]/);
  assert.match(config, /\[model_providers\.other\]/);
  assert.deepEqual(core.listModes(), ["account"]);
});

test("deleteProviderProfile rejects the current provider mode", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: { OPENAI_API_KEY: "sk-test" },
    config: { name: "cliproxyapi", base_url: "http://127.0.0.1:34046/v1", wire_api: "responses" },
  });

  const switched = core.switchMode("cliproxyapi");
  assert.equal(switched.success, true);
  assert.equal(core.getActiveModelProvider(), "cliproxyapi");

  const result = core.deleteProviderProfile("cliproxyapi");
  assert.equal(result.success, false);
  assert.equal(result.deactivated, false);
  assert.equal(result.message, 'Provider "cliproxyapi" is currently in use and cannot be removed.');
  assert.equal(core.getActiveModelProvider(), "cliproxyapi");
  assert.equal(fs.existsSync(path.join(codexHome, "provider_cliproxyapi.json")), true);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "cliproxyapi"/m);
  assert.match(config, /\[model_providers\.cliproxyapi\]/);
});

test("deleteProviderProfile removes quoted table headers for dotted provider names", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_corp.proxy.json"), {
    kind: "provider",
    name: "corp.proxy",
    auth: { OPENAI_API_KEY: "sk-corp" },
    config: { name: "corp.proxy", base_url: "http://corp.local/v1", wire_api: "responses" },
  });
  writeText(
    path.join(codexHome, "config.toml"),
    [
      'model_provider = "corp.proxy"',
      "",
      '[model_providers."corp.proxy"]',
      'name = "corp.proxy"',
      'base_url = "http://corp.local/v1"',
      'wire_api = "responses"',
      "",
      "[model_providers.other]",
      'name = "other"',
      'base_url = "https://example.com/v1"',
      'wire_api = "responses"',
    ].join("\n")
  );

  const result = core.deleteProviderProfile("corp.proxy");
  assert.equal(result.success, false);
  assert.equal(result.deactivated, false);
  assert.equal(result.message, 'Provider "corp.proxy" is currently in use and cannot be removed.');

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "corp.proxy"/m);
  assert.match(config, /\[model_providers\."corp\.proxy"\]/);
  assert.match(config, /\[model_providers\.other\]/);
});

test("removeAccount rejects the current account", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: "acct-work",
      access_token: "access-token",
      refresh_token: "refresh-token",
    },
  };
  writeJson(path.join(codexHome, "auth_work.json"), auth);
  writeJson(path.join(codexHome, "auth.json"), auth);

  const result = core.removeAccount("work");
  assert.equal(result.success, false);
  assert.equal(result.message, 'Account "work" is currently in use and cannot be removed.');
  assert.equal(fs.existsSync(path.join(codexHome, "auth_work.json")), true);
});

test("switching between multiple providers works", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_proxy-a.json"), {
    kind: "provider",
    name: "proxy-a",
    auth: { OPENAI_API_KEY: "sk-a" },
    config: { name: "proxy-a", base_url: "http://a.example.com/v1", wire_api: "responses" },
  });

  writeJson(path.join(codexHome, "provider_proxy-b.json"), {
    kind: "provider",
    name: "proxy-b",
    auth: { OPENAI_API_KEY: "sk-b" },
    config: { name: "proxy-b", base_url: "http://b.example.com/v1", wire_api: "chat" },
  });

  let result = core.switchMode("proxy-a");
  assert.equal(result.success, true);
  assert.deepEqual(core.getCurrentSelection(), { kind: "provider", name: "proxy-a" });

  let auth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(auth.OPENAI_API_KEY, "sk-a");

  result = core.switchMode("proxy-b");
  assert.equal(result.success, true);
  assert.deepEqual(core.getCurrentSelection(), { kind: "provider", name: "proxy-b" });

  auth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
  assert.equal(auth.OPENAI_API_KEY, "sk-b");

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "proxy-b"/m);
});

test("switchMode rewrites provider keys without duplicating assignments", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: { OPENAI_API_KEY: "sk-updated" },
    config: { name: "cliproxyapi", base_url: "http://updated.local/v1", wire_api: "responses" },
  });

  writeText(
    path.join(codexHome, "config.toml"),
    [
      "[model_providers.cliproxyapi]",
      'name="old-name"',
      "base_url='http://old.local/v1'",
      'wire_api = "chat"',
    ].join("\n")
  );

  const result = core.switchMode("cliproxyapi");
  assert.equal(result.success, true);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.equal((config.match(/^name\s*=/gm) ?? []).length, 1);
  assert.equal((config.match(/^base_url\s*=/gm) ?? []).length, 1);
  assert.equal((config.match(/^wire_api\s*=/gm) ?? []).length, 1);
  assert.match(config, /name = "cliproxyapi"/);
  assert.match(config, /base_url = "http:\/\/updated.local\/v1"/);
  assert.match(config, /wire_api = "responses"/);
});

test("switchMode quotes dotted provider names and updates legacy table headers", () => {
  const codexHome = createTempCodexHome();
  process.env.CODEX_HOME = codexHome;

  writeJson(path.join(codexHome, "provider_corp.proxy.json"), {
    kind: "provider",
    name: "corp.proxy",
    auth: { OPENAI_API_KEY: "sk-corp" },
    config: { name: "corp.proxy", base_url: "http://corp.local/v1", wire_api: "responses" },
  });

  writeText(
    path.join(codexHome, "config.toml"),
    [
      'model_provider = "corp.proxy"',
      "",
      "[model_providers.corp.proxy]",
      'name = "corp.proxy"',
      'base_url = "http://legacy.local/v1"',
      'wire_api = "chat"',
    ].join("\n")
  );

  const result = core.switchMode("corp.proxy");
  assert.equal(result.success, true);

  const config = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "corp.proxy"/m);
  assert.match(config, /\[model_providers\."corp\.proxy"\]/);
  assert.doesNotMatch(config, /\[model_providers\.corp\.proxy\]/);
  assert.equal((config.match(/\[model_providers\./g) ?? []).length, 1);
  assert.equal((config.match(/^base_url\s*=/gm) ?? []).length, 1);

  const second = core.switchMode("corp.proxy");
  assert.equal(second.success, true);
  const updatedAgain = fs.readFileSync(path.join(codexHome, "config.toml"), "utf-8");
  assert.equal((updatedAgain.match(/\[model_providers\./g) ?? []).length, 1);
  assert.equal((updatedAgain.match(/^base_url\s*=/gm) ?? []).length, 1);
});
