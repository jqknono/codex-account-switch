const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const core = require("@codex-account-switch/core");
const SYNCED_CLOUD_STATE_KEY = "codex-account-switch.syncedCloudState.v1";

function createDisposable(fn = () => {}) {
  return {
    dispose: fn,
  };
}

function createVscodeMock() {
  const registeredCommands = new Map();
  const configurationListeners = new Set();
  const createdChannels = [];
  const globalStateValues = new Map([
    [SYNCED_CLOUD_STATE_KEY, {
      version: 1,
      accounts: {},
      providers: {},
      devices: [],
      autoRefreshDeviceName: null,
    }],
  ]);
  const config = {
    authDirectory: "",
    showStatusBar: false,
    quotaRefreshInterval: 30,
    detailedPerformanceLogging: false,
    syncedStorage: globalStateValues.get(SYNCED_CLOUD_STATE_KEY),
  };

  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return createDisposable(() => this.listeners.delete(listener));
      };
    }

    fire(value) {
      for (const listener of this.listeners) {
        listener(value);
      }
    }

    dispose() {
      this.listeners.clear();
    }
  }

  class TreeItem {
    constructor(label) {
      this.label = label;
    }
  }

  class ThemeIcon {
    constructor(id, color) {
      this.id = id;
      this.color = color;
    }
  }

  class ThemeColor {
    constructor(id) {
      this.id = id;
    }
  }

  const vscode = {
    EventEmitter,
    ThemeIcon,
    ThemeColor,
    TreeItem,
    TreeItemCollapsibleState: {
      None: 0,
      Collapsed: 1,
      Expanded: 2,
    },
    StatusBarAlignment: {
      Right: 2,
    },
    ProgressLocation: {
      Notification: 15,
    },
    ConfigurationTarget: {
      Global: 1,
    },
    window: {
      createTreeView() {
        return createDisposable();
      },
      createStatusBarItem() {
        return {
          show() {},
          hide() {},
          dispose() {},
          text: "",
          tooltip: "",
          command: undefined,
          name: "",
        };
      },
      createOutputChannel(name, options) {
        const entries = [];
        let showCount = 0;
        let disposed = false;
        const channel = {
          name,
          options,
          entries,
          info(line) {
            entries.push({ level: "info", line });
          },
          warn(line) {
            entries.push({ level: "warn", line });
          },
          error(line) {
            entries.push({ level: "error", line });
          },
          show() {
            showCount += 1;
          },
          dispose() {
            disposed = true;
          },
          get showCount() {
            return showCount;
          },
          get disposed() {
            return disposed;
          },
        };
        createdChannels.push(channel);
        return channel;
      },
      createTerminal() {
        return {
          show() {},
          sendText() {},
        };
      },
      async showInputBox() {
        return undefined;
      },
      async showWarningMessage() {
        return undefined;
      },
      async showInformationMessage() {
        return undefined;
      },
      async showErrorMessage() {
        return undefined;
      },
      async showQuickPick() {
        return undefined;
      },
      async withProgress(_options, task) {
        return task();
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, "codex-account-switch");
        return {
          get(_key, defaultValue) {
            return config[_key] ?? defaultValue;
          },
          async update(key, value) {
            config[key] = value;
            const event = {
              affectsConfiguration(target) {
                return target === `codex-account-switch.${key}`;
              },
            };
            for (const listener of configurationListeners) {
              listener(event, value);
            }
          },
        };
      },
      onDidChangeConfiguration(listener) {
        configurationListeners.add(listener);
        return createDisposable(() => configurationListeners.delete(listener));
      },
    },
    commands: {
      registerCommand(name, handler) {
        registeredCommands.set(name, handler);
        return createDisposable(() => registeredCommands.delete(name));
      },
      async executeCommand(name, ...args) {
        const command = registeredCommands.get(name);
        return command ? command(...args) : undefined;
      },
    },
    env: {
      clipboard: {
        async writeText() {},
      },
    },
    Uri: {
      file(filePath) {
        return { fsPath: filePath };
      },
    },
  };

  return {
    vscode,
    registeredCommands,
    createdChannels,
    config,
    secrets: {
      async get() {
        return undefined;
      },
      async store() {},
      async delete() {},
    },
    globalState: {
      get(key) {
        return globalStateValues.get(key);
      },
      setKeysForSync(keys) {
        this.syncedKeys = [...keys];
      },
      async update(key, value) {
        if (value === undefined) {
          globalStateValues.delete(key);
        } else {
          globalStateValues.set(key, value);
        }
      },
    },
  };
}

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function makeAuthFile(accountId, options = {}) {
  const email = options.email ?? `${accountId}@example.com`;
  const plan = options.plan ?? "plus";
  return {
    ...(options.lastRefresh ? { last_refresh: options.lastRefresh } : {}),
    tokens: {
      access_token: options.accessToken ?? "access-token",
      refresh_token: options.refreshToken ?? "refresh-token",
      account_id: accountId,
      id_token: makeJwt({
        email,
        name: options.name ?? accountId,
        "https://api.openai.com/auth": {
          chatgpt_plan_type: plan,
        },
      }),
    },
  };
}

async function withDisabledIntervals(fn) {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = () => ({ __mockInterval: true });
  global.clearInterval = () => {};

  try {
    return await fn();
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
}

async function withSuccessfulHttps(fn) {
  const originalRequest = https.request;
  https.request = (requestOptions, handler) => {
    const hostname = requestOptions?.hostname;
    const body =
      hostname === "auth.openai.com"
        ? JSON.stringify({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            id_token: makeJwt({
              email: "perf@example.com",
              name: "perf-user",
              "https://api.openai.com/auth": {
                chatgpt_plan_type: "plus",
              },
            }),
          })
        : JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                reset_at: null,
                limit_window_seconds: 18000,
              },
            },
          });
    const response = {
      statusCode: 200,
      on(event, listener) {
        if (event === "data") {
          setImmediate(() => listener(body));
        }
        if (event === "end") {
          setImmediate(listener);
        }
        return response;
      },
    };

    const request = {
      on() {
        return request;
      },
      setTimeout() {
        return request;
      },
      destroy() {},
      write() {},
      end() {
        handler(response);
      },
    };

    return request;
  };

  try {
    return await fn();
  } finally {
    https.request = originalRequest;
  }
}

function loadExtensionWithMockedVscode(vscodeMock) {
  const extensionPath = path.join(__dirname, "..", "dist", "extension.js");
  const originalLoad = Module._load;

  delete require.cache[extensionPath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") {
      return vscodeMock;
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    return require(extensionPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createExtensionContext(mocked) {
  return {
    subscriptions: [],
    secrets: mocked.secrets,
    globalState: mocked.globalState,
  };
}

test("activate creates a dedicated VS Code log channel and writes startup logs into it", async () => {
  const mocked = createVscodeMock();
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });

  assert.equal(mocked.createdChannels.length, 1);
  assert.equal(mocked.createdChannels[0].name, "Codex Account Switch");
  assert.deepEqual(mocked.createdChannels[0].options, { log: true });
  assert.ok(mocked.createdChannels[0].entries.length > 0);
  assert.ok(
    mocked.createdChannels[0].entries.some((entry) =>
      /\[codex-account-switch:vscode:(accountTree|statusBar)\]/.test(entry.line)
    )
  );

  extension.deactivate();
  assert.equal(mocked.createdChannels[0].disposed, true);
});

test("showLogs command reveals the dedicated VS Code log channel", async () => {
  const mocked = createVscodeMock();
  const extension = loadExtensionWithMockedVscode(mocked.vscode);
  const context = createExtensionContext(mocked);

  await withDisabledIntervals(async () => {
    await extension.activate(context);
  });

  await mocked.registeredCommands.get("codex-account-switch.showLogs")();

  assert.equal(mocked.createdChannels.length, 1);
  assert.equal(mocked.createdChannels[0].showCount, 1);

  extension.deactivate();
});

async function withAccountRefreshLoggingScenario(options, runAssertions) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-perf-logging-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_perf-user.json"), makeAuthFile("acct-perf", {
      lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      name: "perf-user",
    }));
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-perf", { name: "perf-user" }), null, 2),
      "utf-8"
    );

    const mocked = createVscodeMock();
    mocked.config.authDirectory = authDir;
    mocked.config.showStatusBar = true;
    mocked.config.detailedPerformanceLogging = options.detailedPerformanceLogging;

    await withDisabledIntervals(async () => {
      await withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.refreshQuota")();

        await runAssertions(mocked);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        extension.deactivate();
      });
    });
  } finally {
    core.setNamedAuthDir(undefined);
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }
    if (previousNamedAuthDir === undefined) {
      delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
    } else {
      process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR = previousNamedAuthDir;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("default performance logging keeps account refresh logs at summary level", async () => {
  await withAccountRefreshLoggingScenario({ detailedPerformanceLogging: false }, async (mocked) => {
    const lines = mocked.createdChannels[0].entries.map((entry) => entry.line);
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"durationMs\":")),
      true
    );
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"stage\":")),
      false
    );
  });
});

test("detailed performance logging emits account refresh stage timings to the output channel", async () => {
  await withAccountRefreshLoggingScenario({ detailedPerformanceLogging: true }, async (mocked) => {
    const lines = mocked.createdChannels[0].entries.map((entry) => entry.line);
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"durationMs\":")),
      true
    );
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"stage\":")),
      true
    );
    assert.equal(
      lines.some((line) => line.includes("\"operation\":\"querySavedAccountQuota\"") && line.includes("\"stage\":")),
      true
    );
  });
});
