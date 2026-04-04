const test = require("node:test");
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.resolve(__dirname, "..", "dist", "index.js");

// ─── Helpers ─────────────────────────────────────────────────

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cas-cli-test-"));
}

function writeJson(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf-8");
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf-8"));
}

function jwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${b}.fakesig`;
}

function makeAuth(email, plan, { expired = false, acctId, refreshToken = `rt-${email}` } = {}) {
  const exp = expired
    ? Math.floor(Date.now() / 1000) - 3600
    : Math.floor(Date.now() / 1000) + 3600;
  const auth = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({
        email,
        name: email.split("@")[0],
        sub: `sub-${email}`,
        exp,
        "https://api.openai.com/auth": { chatgpt_plan_type: plan },
      }),
      access_token: jwt({ exp }),
      refresh_token: refreshToken,
      account_id: acctId ?? `acct-${email.replace(/[@.]/g, "-")}`,
    },
  };

  return auth;
}

function providerTableHeader(providerName) {
  return /^[A-Za-z0-9_-]+$/.test(providerName)
    ? `[model_providers.${providerName}]`
    : `[model_providers.${JSON.stringify(providerName)}]`;
}

function makeProviderConfig(providerName = "cliproxyapi") {
  return `model_provider = "${providerName}"\n\n${providerTableHeader(providerName)}\nname = "${providerName}"\nbase_url = "http://127.0.0.1:34046/v1"\nwire_api = "responses"\n`;
}

function makeProviderProfile(providerName = "cliproxyapi") {
  return {
    kind: "provider",
    name: providerName,
    auth: { OPENAI_API_KEY: "sk-test" },
    config: {
      name: providerName,
      base_url: "http://127.0.0.1:34046/v1",
      wire_api: "responses",
    },
  };
}

function cli(args, home, opts = {}) {
  const env = {
    ...process.env,
    ...opts.env,
    CODEX_HOME: home,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  delete env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      env,
      encoding: "utf-8",
      input: opts.input ?? "",
      timeout: 15000,
      cwd: opts.cwd ?? home,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

function writeFakeCodexCommand(binDir, { auth, logPath }) {
  const authJson = JSON.stringify(auth);
  const script = [
    "@echo off",
    "setlocal",
    `echo %*>\"${logPath}\"`,
    `echo ${authJson}>\"%CODEX_HOME%\\auth.json\"`,
    "exit /b 0",
    "",
  ].join("\r\n");

  fs.writeFileSync(path.join(binDir, "codex.cmd"), script, "utf-8");
}

// ─── Meta ────────────────────────────────────────────────────

test("--version prints version number", () => {
  const home = tmpHome();
  const r = cli("--version", home);
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("--help prints usage information", () => {
  const home = tmpHome();
  const r = cli("--help", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("codex-account-switch"));
  assert.ok(r.stdout.includes("list"));
  assert.ok(r.stdout.includes("add"));
  assert.ok(r.stdout.includes("remove"));
  assert.ok(r.stdout.includes("use"));
  assert.ok(r.stdout.includes("mode"));
  assert.ok(r.stdout.includes("quota"));
  assert.ok(r.stdout.includes("current"));
  assert.ok(r.stdout.includes("refresh"));
  assert.ok(r.stdout.includes("export"));
  assert.ok(r.stdout.includes("import"));
});

test("unknown command shows error", () => {
  const home = tmpHome();
  const r = cli("nonexistent", home);
  assert.notEqual(r.code, 0);
});

// ─── add ─────────────────────────────────────────────────────

test("add: uses browser login by default", () => {
  const home = tmpHome();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-cli-bin-"));
  const logPath = path.join(home, "codex-login-args.txt");
  const auth = makeAuth("device@example.com", "plus");
  writeFakeCodexCommand(binDir, { auth, logPath });

  const r = cli("add device", home, {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Account "device" was saved'));
  assert.equal(fs.readFileSync(logPath, "utf-8").trim(), "login");

  const saved = readJson(path.join(home, "auth_device.json"));
  assert.equal(saved.tokens.refresh_token, auth.tokens.refresh_token);
});

test("add: uses device auth only when explicitly enabled", () => {
  const home = tmpHome();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-cli-bin-"));
  const logPath = path.join(home, "codex-login-args.txt");
  const auth = makeAuth("device@example.com", "plus");
  writeFakeCodexCommand(binDir, { auth, logPath });

  const r = cli("add device --device-auth", home, {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Account "device" was saved'));
  assert.equal(fs.readFileSync(logPath, "utf-8").trim(), "login --device-auth");
});

test("add: existing account only accepts relogin for the same identity", () => {
  const home = tmpHome();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-cli-bin-"));
  const logPath = path.join(home, "codex-login-args.txt");
  const original = {
    ...makeAuth("work@example.com", "plus"),
    tokens: {
      ...makeAuth("work@example.com", "plus").tokens,
      refresh_token: undefined,
    },
  };
  const different = makeAuth("personal@example.com", "pro");
  writeJson(path.join(home, "auth_work.json"), original);
  writeFakeCodexCommand(binDir, { auth: different, logPath });

  const r = cli("add work", home, {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("belongs to a different account"));
  assert.ok(r.stdout.includes("work@example.com"));
  assert.ok(r.stdout.includes("personal@example.com"));

  const saved = readJson(path.join(home, "auth_work.json"));
  assert.equal(saved.tokens.account_id, original.tokens.account_id);
});

test("add: existing account accepts relogin for the same identity", () => {
  const home = tmpHome();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cas-cli-bin-"));
  const logPath = path.join(home, "codex-login-args.txt");
  const original = {
    ...makeAuth("work@example.com", "plus"),
    tokens: {
      ...makeAuth("work@example.com", "plus").tokens,
      refresh_token: undefined,
    },
  };
  const refreshed = makeAuth("work@example.com", "plus", { acctId: original.tokens.account_id });
  writeJson(path.join(home, "auth_work.json"), original);
  writeFakeCodexCommand(binDir, { auth: refreshed, logPath });

  const r = cli("add work", home, {
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });

  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Account "work" was saved'));

  const saved = readJson(path.join(home, "auth_work.json"));
  assert.equal(saved.tokens.refresh_token, refreshed.tokens.refresh_token);
});

// ─── list ────────────────────────────────────────────────────

test("list: no accounts shows empty message", () => {
  const home = tmpHome();
  const r = cli("list", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("No saved accounts"));
});

test("list: single account shows name, email, plan", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_work.json"), makeAuth("work@example.com", "plus"));
  const r = cli("list", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("work"));
  assert.ok(r.stdout.includes("work@example.com"));
  assert.ok(r.stdout.includes("plus"));
});

test("list: multiple accounts with current marker", () => {
  const home = tmpHome();
  const workAuth = makeAuth("work@example.com", "plus", { acctId: "acct-work" });
  const personalAuth = makeAuth("personal@example.com", "pro", { acctId: "acct-personal" });
  writeJson(path.join(home, "auth_work.json"), workAuth);
  writeJson(path.join(home, "auth_personal.json"), personalAuth);
  writeJson(path.join(home, "auth.json"), workAuth);

  const r = cli("list", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("work"));
  assert.ok(r.stdout.includes("personal"));
  assert.ok(r.stdout.includes("[current]"));
});

test("list: expired token shows expired status", () => {
  const home = tmpHome();
  writeJson(
    path.join(home, "auth_expired.json"),
    makeAuth("exp@example.com", "plus", { expired: true })
  );
  const r = cli("list", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("access: expired"));
  assert.ok(r.stdout.includes("refresh: available"));
});

test("list: valid token shows expires info", () => {
  const home = tmpHome();
  writeJson(
    path.join(home, "auth_valid.json"),
    makeAuth("v@example.com", "plus", { expired: false })
  );
  const r = cli("list", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("access: expires in"));
  assert.ok(r.stdout.includes("refresh: available"));
});

test("list: missing refresh token shows missing status", () => {
  const home = tmpHome();
  writeJson(
    path.join(home, "auth_valid.json"),
    makeAuth("v@example.com", "plus", { refreshToken: "" })
  );
  const r = cli("list", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("access: expires in"));
  assert.ok(r.stdout.includes("refresh: missing"));
});

test("list: in provider mode no account is marked current", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_work.json"), makeAuth("w@e.com", "plus"));
  writeJson(path.join(home, "auth.json"), { OPENAI_API_KEY: "sk-test" });
  fs.writeFileSync(path.join(home, "config.toml"), makeProviderConfig(), "utf-8");

  const r = cli("list", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("work"));
  assert.ok(!r.stdout.includes("[current]"));
});

test("ls alias works for list", () => {
  const home = tmpHome();
  const r = cli("ls", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("No saved accounts"));
});

// ─── remove ──────────────────────────────────────────────────

test("remove: existing account succeeds", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_work.json"), makeAuth("w@e.com", "plus"));

  const r = cli("remove work", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("removed"));
  assert.ok(!fs.existsSync(path.join(home, "auth_work.json")));
});

test("remove: current account is rejected", () => {
  const home = tmpHome();
  const auth = makeAuth("w@e.com", "plus");
  writeJson(path.join(home, "auth_work.json"), auth);
  writeJson(path.join(home, "auth.json"), auth);

  const r = cli("remove work", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("currently in use"));
  assert.ok(fs.existsSync(path.join(home, "auth_work.json")));
});

test("remove: non-existing account fails", () => {
  const home = tmpHome();
  const r = cli("remove ghost", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
});

test("rm alias works for remove", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_x.json"), makeAuth("x@e.com", "plus"));
  const r = cli("rm x", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("removed"));
});

test("del alias works for remove", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_y.json"), makeAuth("y@e.com", "plus"));
  const r = cli("del y", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("removed"));
});

// ─── use ─────────────────────────────────────────────────────

test("use: switch to existing account succeeds", () => {
  const home = tmpHome();
  const auth = makeAuth("work@example.com", "plus");
  writeJson(path.join(home, "auth_work.json"), auth);
  writeJson(path.join(home, "auth.json"), {});

  const r = cli("use work", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Switched to account"));
  assert.ok(r.stdout.includes("work"));
  assert.ok(r.stdout.includes("work@example.com"));
  assert.ok(r.stdout.includes("plus"));

  const current = readJson(path.join(home, "auth.json"));
  assert.equal(current.tokens.account_id, auth.tokens.account_id);
});

test("use: non-existing account fails and lists available", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_real.json"), makeAuth("r@e.com", "plus"));

  const r = cli("use ghost", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
  assert.ok(r.stdout.includes("real"));
});

test("use: non-existing account with empty list shows (none)", () => {
  const home = tmpHome();
  const r = cli("use ghost", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
  assert.ok(r.stdout.includes("(none)"));
});

test("use: clears active provider mode", () => {
  const home = tmpHome();
  const auth = makeAuth("work@example.com", "plus");
  writeJson(path.join(home, "auth_work.json"), auth);
  writeJson(path.join(home, "auth.json"), { OPENAI_API_KEY: "sk-test" });
  fs.writeFileSync(path.join(home, "config.toml"), makeProviderConfig(), "utf-8");

  const r = cli("use work", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Switched to account"));

  const config = fs.readFileSync(path.join(home, "config.toml"), "utf-8");
  assert.doesNotMatch(config, /^model_provider =/m);
});

test("switch alias works for use", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_work.json"), makeAuth("w@e.com", "plus"));
  writeJson(path.join(home, "auth.json"), {});
  const r = cli("switch work", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Switched to account"));
});

// ─── mode ────────────────────────────────────────────────────

test("mode: no args in account mode shows current and available", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth.json"), makeAuth("w@e.com", "plus"));
  const r = cli("mode", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Current mode:"));
  assert.ok(r.stdout.includes("account"));
});

test("mode: no args in provider mode shows provider name as current", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth.json"), { OPENAI_API_KEY: "sk-test" });
  writeJson(path.join(home, "provider_cliproxyapi.json"), makeProviderProfile());
  fs.writeFileSync(path.join(home, "config.toml"), makeProviderConfig(), "utf-8");

  const r = cli("mode", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("cliproxyapi"));
  assert.ok(r.stdout.includes("[current]"));
});

test("mode: switch to account mode", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth.json"), { OPENAI_API_KEY: "sk-test" });
  fs.writeFileSync(path.join(home, "config.toml"), makeProviderConfig(), "utf-8");

  const r = cli("mode account", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Switched to account mode"));

  const config = fs.readFileSync(path.join(home, "config.toml"), "utf-8");
  assert.doesNotMatch(config, /^model_provider =/m);
});

test("mode: switch to pre-configured provider", () => {
  const home = tmpHome();
  writeJson(path.join(home, "provider_cliproxyapi.json"), makeProviderProfile());

  const r = cli("mode cliproxyapi", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Switched to mode"));
  assert.ok(r.stdout.includes("cliproxyapi"));

  assert.ok(fs.existsSync(path.join(home, "auth.json")));
  const config = fs.readFileSync(path.join(home, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "cliproxyapi"/m);
});

test("mode: new provider prompts and creates profile when missing", () => {
  const home = tmpHome();

  const r = cli("mode my-proxy", home, {
    input: ["sk-live-test", "http://my-proxy.local/v1", "responses"].join("\n"),
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Creating provider "my-proxy"'));

  const profile = readJson(path.join(home, "provider_my-proxy.json"));
  assert.equal(profile.auth.OPENAI_API_KEY, "sk-live-test");
  assert.equal(profile.config.name, "my-proxy");
  assert.equal(profile.config.base_url, "http://my-proxy.local/v1");
  assert.equal(profile.config.wire_api, "responses");

  const current = readJson(path.join(home, "auth.json"));
  assert.equal(current.OPENAI_API_KEY, "sk-live-test");

  const config = fs.readFileSync(path.join(home, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "my-proxy"/m);
});

test("mode: incomplete provider profile is completed from prompts", () => {
  const home = tmpHome();
  writeJson(path.join(home, "provider_cliproxyapi.json"), {
    kind: "provider",
    name: "cliproxyapi",
    auth: {
      OPENAI_API_KEY: "",
      extra_header: "x-test",
    },
    config: {
      name: "cliproxyapi",
      base_url: "http://example.local/v1",
    },
  });

  const r = cli("mode cliproxyapi", home, {
    input: ["sk-filled", "", ""].join("\n"),
  });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes('Completing provider "cliproxyapi"'));
  assert.ok(r.stdout.includes("incomplete or invalid"));

  const profile = readJson(path.join(home, "provider_cliproxyapi.json"));
  assert.equal(profile.auth.OPENAI_API_KEY, "sk-filled");
  assert.equal(profile.auth.extra_header, "x-test");
  assert.equal(profile.config.base_url, "http://example.local/v1");
  assert.equal(profile.config.wire_api, "responses");
});

test("mode: switch to custom-named provider", () => {
  const home = tmpHome();
  writeJson(path.join(home, "provider_my-api.json"), makeProviderProfile("my-api"));

  const r = cli("mode my-api", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Switched to mode"));
  assert.ok(r.stdout.includes("my-api"));

  const config = fs.readFileSync(path.join(home, "config.toml"), "utf-8");
  assert.match(config, /^model_provider = "my-api"/m);
});

// ─── current ─────────────────────────────────────────────────

test("current: shows matched account with email and plan", () => {
  const home = tmpHome();
  const auth = makeAuth("work@example.com", "plus", { acctId: "acct-work" });
  writeJson(path.join(home, "auth_work.json"), auth);
  writeJson(path.join(home, "auth.json"), auth);

  const r = cli("current", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Current account: work"));
  assert.ok(r.stdout.includes("work@example.com"));
  assert.ok(r.stdout.includes("plus"));
});

test("current: no auth shows no match message", () => {
  const home = tmpHome();
  const r = cli("current", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("No saved account matches"));
});

test("current: unsaved login shows no match with email hint", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth.json"), makeAuth("unsaved@example.com", "free"));
  const r = cli("current", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("No saved account matches"));
  assert.ok(r.stdout.includes("unsaved@example.com"));
});

test("current: provider mode shows mode name", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth.json"), { OPENAI_API_KEY: "sk-test" });
  fs.writeFileSync(path.join(home, "config.toml"), makeProviderConfig(), "utf-8");

  const r = cli("current", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("cliproxyapi"));
  assert.ok(r.stdout.includes("provider mode"));
});

// ─── quota ───────────────────────────────────────────────────

test("quota: unsupported in provider mode", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth.json"), { OPENAI_API_KEY: "sk-test" });
  fs.writeFileSync(path.join(home, "config.toml"), makeProviderConfig(), "utf-8");

  const r = cli("quota", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("unavailable") || r.stdout.includes("Unavailable"));
  assert.ok(r.stdout.includes("provider mode"));
});

test("quota: non-existing named account", () => {
  const home = tmpHome();
  const r = cli("quota ghost", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
});

test("info alias works for quota", () => {
  const home = tmpHome();
  const r = cli("info ghost", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
});

test("status alias works for quota", () => {
  const home = tmpHome();
  const r = cli("status ghost", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
});

test("quota: prints access and refresh token status lines", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_work.json"), {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    last_refresh: new Date().toISOString(),
    tokens: {
      id_token: jwt({
        email: "work@example.com",
        name: "work",
        sub: "sub-work@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      }),
      refresh_token: "rt-work@example.com",
      account_id: "acct-work",
    },
  });
  writeJson(path.join(home, "auth.json"), readJson(path.join(home, "auth_work.json")));

  const r = cli("quota", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Access token:  unknown"));
  assert.ok(r.stdout.includes("Refresh token: available"));
});

// ─── refresh ─────────────────────────────────────────────────

test("refresh: unsupported in provider mode", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth.json"), { OPENAI_API_KEY: "sk-test" });
  fs.writeFileSync(path.join(home, "config.toml"), makeProviderConfig(), "utf-8");

  const r = cli("refresh", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("provider mode") || r.stdout.includes("unavailable"));
});

test("refresh: non-existing named account", () => {
  const home = tmpHome();
  const r = cli("refresh ghost", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
});

// ─── export ──────────────────────────────────────────────────

test("export: all accounts to default file", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_a.json"), makeAuth("a@e.com", "plus"));
  writeJson(path.join(home, "auth_b.json"), makeAuth("b@e.com", "pro"));

  const r = cli("export", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Exported 2 account(s)"));

  const exportFile = path.join(home, "codex-accounts.json");
  assert.ok(fs.existsSync(exportFile));
  const data = readJson(exportFile);
  assert.equal(data.version, 1);
  assert.equal(data.accounts.length, 2);
  assert.ok(typeof data.exportedAt === "string");
});

test("export: to custom file path", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_x.json"), makeAuth("x@e.com", "free"));

  const r = cli("export my-accounts.json", home, { cwd: home });
  assert.equal(r.code, 0);

  const data = readJson(path.join(home, "my-accounts.json"));
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].name, "x");
});

test("export: specific accounts by name", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_a.json"), makeAuth("a@e.com", "plus"));
  writeJson(path.join(home, "auth_b.json"), makeAuth("b@e.com", "pro"));
  writeJson(path.join(home, "auth_c.json"), makeAuth("c@e.com", "free"));

  const r = cli("export partial.json -n a c", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Exported 2 account(s)"));

  const data = readJson(path.join(home, "partial.json"));
  const names = data.accounts.map((a) => a.name).sort();
  assert.deepEqual(names, ["a", "c"]);
});

test("export: no accounts shows empty message", () => {
  const home = tmpHome();
  const r = cli("export", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("No accounts available"));
});

// ─── import ──────────────────────────────────────────────────

test("import: accounts from file", () => {
  const home = tmpHome();
  const importData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: [
      { name: "imported1", auth: makeAuth("i1@e.com", "plus") },
      { name: "imported2", auth: makeAuth("i2@e.com", "pro") },
    ],
  };
  writeJson(path.join(home, "import.json"), importData);

  const r = cli("import import.json", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Imported 2 account(s)"));
  assert.ok(r.stdout.includes("imported1"));
  assert.ok(r.stdout.includes("imported2"));
  assert.ok(fs.existsSync(path.join(home, "auth_imported1.json")));
  assert.ok(fs.existsSync(path.join(home, "auth_imported2.json")));
});

test("import: skips existing accounts without --overwrite", () => {
  const home = tmpHome();
  const oldAuth = makeAuth("old@e.com", "free");
  writeJson(path.join(home, "auth_existing.json"), oldAuth);

  const importData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: [
      { name: "existing", auth: makeAuth("new@e.com", "plus") },
      { name: "fresh", auth: makeAuth("f@e.com", "pro") },
    ],
  };
  writeJson(path.join(home, "import.json"), importData);

  const r = cli("import import.json", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Imported 1 account(s)"));
  assert.ok(r.stdout.includes("Skipped 1 existing"));

  const existing = readJson(path.join(home, "auth_existing.json"));
  assert.equal(existing.tokens.refresh_token, oldAuth.tokens.refresh_token);
});

test("import: --overwrite replaces existing accounts", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_existing.json"), makeAuth("old@e.com", "free"));

  const newAuth = makeAuth("new@e.com", "plus");
  const importData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    accounts: [{ name: "existing", auth: newAuth }],
  };
  writeJson(path.join(home, "import.json"), importData);

  const r = cli("import import.json --overwrite", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Imported 1 account(s)"));

  const updated = readJson(path.join(home, "auth_existing.json"));
  assert.equal(updated.tokens.refresh_token, newAuth.tokens.refresh_token);
});

test("import: non-existing file shows error", () => {
  const home = tmpHome();
  const r = cli("import nope.json", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
});

test("import: invalid JSON shows parse error", () => {
  const home = tmpHome();
  fs.writeFileSync(path.join(home, "bad.json"), "not-valid-json{{{", "utf-8");

  const r = cli("import bad.json", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Invalid file format") || r.stdout.includes("unable to parse"));
});

test("import: wrong format version shows error", () => {
  const home = tmpHome();
  writeJson(path.join(home, "wrong.json"), { version: 99, accounts: [] });

  const r = cli("import wrong.json", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Unsupported export file format"));
});

test("import: missing accounts array shows error", () => {
  const home = tmpHome();
  writeJson(path.join(home, "bad-struct.json"), { version: 1 });

  const r = cli("import bad-struct.json", home, { cwd: home });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Unsupported export file format"));
});

// ─── --auth-dir ──────────────────────────────────────────────

test("--auth-dir redirects account storage", () => {
  const home = tmpHome();
  const altDir = tmpHome();
  writeJson(path.join(altDir, "auth_alt.json"), makeAuth("alt@example.com", "pro"));

  const r1 = cli("list", home);
  assert.ok(r1.stdout.includes("No saved accounts"));

  const r2 = cli(`--auth-dir "${altDir}" list`, home);
  assert.equal(r2.code, 0);
  assert.ok(r2.stdout.includes("alt"));
  assert.ok(r2.stdout.includes("alt@example.com"));
});

test("--auth-dir affects remove target", () => {
  const home = tmpHome();
  const altDir = tmpHome();
  writeJson(path.join(altDir, "auth_tmp.json"), makeAuth("t@e.com", "plus"));

  const r = cli(`--auth-dir "${altDir}" remove tmp`, home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("removed"));
  assert.ok(!fs.existsSync(path.join(altDir, "auth_tmp.json")));
});

// ─── end-to-end workflows ────────────────────────────────────

test("workflow: use then current shows correct account", () => {
  const home = tmpHome();
  const auth = makeAuth("work@example.com", "plus", { acctId: "acct-w" });
  writeJson(path.join(home, "auth_work.json"), auth);
  writeJson(path.join(home, "auth.json"), {});

  cli("use work", home);

  const r = cli("current", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Current account: work"));
});

test("workflow: switching away preserves an externally refreshed current account snapshot", () => {
  const home = tmpHome();
  const staleWork = makeAuth("work@example.com", "plus", { acctId: "acct-work" });
  const freshWork = {
    ...staleWork,
    tokens: {
      ...staleWork.tokens,
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
      refresh_token: "rt-work-fresh",
    },
  };
  const other = makeAuth("other@example.com", "pro", { acctId: "acct-other" });

  writeJson(path.join(home, "auth_work.json"), staleWork);
  writeJson(path.join(home, "auth_other.json"), other);
  writeJson(path.join(home, "auth.json"), freshWork);

  const switchAway = cli("use other", home);
  assert.equal(switchAway.code, 0);

  const savedWork = readJson(path.join(home, "auth_work.json"));
  assert.equal(savedWork.tokens.refresh_token, "rt-work-fresh");

  const switchBack = cli("use work", home);
  assert.equal(switchBack.code, 0);

  const current = readJson(path.join(home, "auth.json"));
  assert.equal(current.tokens.account_id, "acct-work");
  assert.equal(current.tokens.refresh_token, "rt-work-fresh");
});

test("workflow: switch mode then current shows provider name", () => {
  const home = tmpHome();
  writeJson(path.join(home, "provider_cliproxyapi.json"), makeProviderProfile());

  cli("mode cliproxyapi", home);

  const r = cli("current", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("cliproxyapi"));
  assert.ok(r.stdout.includes("provider mode"));
});

test("workflow: export then import roundtrip", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_alice.json"), makeAuth("alice@e.com", "plus"));
  writeJson(path.join(home, "auth_bob.json"), makeAuth("bob@e.com", "pro"));

  cli("export backup.json", home, { cwd: home });
  assert.ok(fs.existsSync(path.join(home, "backup.json")));

  const home2 = tmpHome();
  const backupSrc = path.join(home, "backup.json");
  fs.copyFileSync(backupSrc, path.join(home2, "backup.json"));

  const r = cli("import backup.json", home2, { cwd: home2 });
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("Imported 2 account(s)"));

  const r2 = cli("list", home2);
  assert.ok(r2.stdout.includes("alice"));
  assert.ok(r2.stdout.includes("bob"));
});

test("workflow: mode account after provider restores account listing", () => {
  const home = tmpHome();
  const auth = makeAuth("work@example.com", "plus", { acctId: "acct-w" });
  writeJson(path.join(home, "auth_work.json"), auth);
  writeJson(path.join(home, "auth.json"), auth);
  writeJson(path.join(home, "provider_cliproxyapi.json"), makeProviderProfile());

  cli("mode cliproxyapi", home);
  const r1 = cli("list", home);
  assert.ok(!r1.stdout.includes("[current]"));

  cli("mode account", home);

  cli("use work", home);
  const r2 = cli("list", home);
  assert.ok(r2.stdout.includes("[current]"));
});

test("workflow: remove then use shows does not exist", () => {
  const home = tmpHome();
  writeJson(path.join(home, "auth_temp.json"), makeAuth("t@e.com", "plus"));
  writeJson(path.join(home, "auth.json"), {});

  cli("remove temp", home);

  const r = cli("use temp", home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("does not exist"));
});

test("mode: dotted provider names write quoted TOML table headers", () => {
  const home = tmpHome();
  writeJson(path.join(home, "provider_corp.proxy.json"), makeProviderProfile("corp.proxy"));

  const r = cli('mode "corp.proxy"', home);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.includes("corp.proxy"));

  const config = fs.readFileSync(path.join(home, "config.toml"), "utf-8");
  assert.match(config, /\[model_providers\."corp\.proxy"\]/);
  assert.doesNotMatch(config, /\[model_providers\.corp\.proxy\]/);
});
