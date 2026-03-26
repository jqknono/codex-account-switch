const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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
