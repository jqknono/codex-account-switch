const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const core = require("@codex-account-switch/core");

const STORAGE_SECRET_KEY = "codex-account-switch.savedAuthPassphrase";
const SYNCED_CLOUD_STATE_KEY = "codex-account-switch.syncedCloudState.v1";

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function makeAuthFile(accountId, options = {}) {
  const email = options.email ?? `${accountId}@example.com`;
  const name = options.name ?? accountId;
  const plan = options.plan ?? "plus";
  return {
    ...(options.extraFields ?? {}),
    ...(options.lastRefresh ? { last_refresh: options.lastRefresh } : {}),
    ...((options.lastTokenAutoUpdate ?? options.lastCloudTokenSync)
      ? { last_token_auto_update: options.lastTokenAutoUpdate ?? options.lastCloudTokenSync }
      : {}),
    tokens: {
      access_token: options.accessToken ?? "access-token",
      refresh_token: options.refreshToken ?? "refresh-token",
      account_id: accountId,
      id_token: makeJwt({
        email,
        name,
        "https://api.openai.com/auth": {
          chatgpt_plan_type: plan,
        },
      }),
    },
  };
}

function readCloudAccount(config, name, passphrase) {
  core.setSavedAuthPassphrase(passphrase);
  const result = core.deserializeSavedValue(
    config.syncedStorage.accounts[name],
    "saved_auth"
  );
  core.setSavedAuthPassphrase(null);
  assert.equal(result.status, "ok");
  return result.value;
}

function readCloudProvider(config, name, passphrase) {
  core.setSavedAuthPassphrase(passphrase);
  const result = core.deserializeSavedValue(
    config.syncedStorage.providers[name],
    "saved_provider"
  );
  core.setSavedAuthPassphrase(null);
  assert.equal(result.status, "ok");
  return result.value;
}

function getCloudEnvelope(config, kind, name) {
  const entry =
    kind === "account"
      ? config.syncedStorage.accounts[name]
      : config.syncedStorage.providers[name];
  assert.equal(typeof entry, "object");
  assert.notEqual(entry, null);
  return entry;
}

async function withMockedHostname(hostname, fn) {
  const originalHostname = os.hostname;
  os.hostname = () => hostname;
  try {
    return await fn();
  } finally {
    os.hostname = originalHostname;
  }
}

function getAccountTreeRootItems(treeDataProvider) {
  return treeDataProvider.getChildren();
}

function getAccountTreeItems(treeDataProvider) {
  const items = [];
  const visit = (node) => {
    for (const child of treeDataProvider.getChildren(node)) {
      if (child?.account) {
        items.push(child);
      } else {
        visit(child);
      }
    }
  };
  visit(undefined);
  return items;
}

function getAccountDetailItems(treeDataProvider, accountItem) {
  return treeDataProvider.getChildren(accountItem);
}

function countOperationLogs(lines, operation) {
  return lines.filter((line) => line.includes("perf-start") && line.includes(`"operation":"${operation}"`)).length;
}

function createDisposable(fn = () => {}) {
  return {
    dispose: fn,
  };
}

function createVscodeMock(options) {
  const registeredCommands = new Map();
  const executedCommands = [];
  const clipboardWrites = [];
  const sentTerminalCommands = [];
  const warningMessages = [];
  const informationMessages = [];
  const errorMessages = [];
  const inputBoxResponses = [...(options.inputBoxResponses ?? [])];
  const warningResponses = [...(options.warningResponses ?? [])];
  const infoResponses = [...(options.infoResponses ?? [])];
  const quickPickResponses = [...(options.quickPickResponses ?? [])];
  const secretState = new Map(Object.entries(options.secretValues ?? {}));
  const configurationUpdateErrors = new Map(Object.entries(options.configurationUpdateErrors ?? {}));
  const configurationListeners = new Set();
  const treeViews = new Map();
  const createdChannels = [];
  const globalStateValues = new Map(Object.entries(options.globalStateValues ?? {}));
  const syncedStorage = options.syncedStorage
    ? {
        version: options.syncedStorage.version ?? 1,
        accounts: options.syncedStorage.accounts ?? {},
        providers: options.syncedStorage.providers ?? {},
        devices: options.syncedStorage.devices ?? [],
        autoRefreshDeviceName: options.syncedStorage.autoRefreshDeviceName ?? null,
      }
    : {
        version: 1,
        accounts: {},
        providers: {},
        devices: [],
        autoRefreshDeviceName: null,
      };
  let legacySyncedStorage = JSON.parse(JSON.stringify(syncedStorage));

  const config = {
    authDirectory: options.authDirectory,
    reloadWindowAfterSwitch: "never",
    useDeviceAuthForLogin: options.useDeviceAuthForLogin ?? false,
    quotaRefreshInterval: 300,
    tokenAutoUpdate: options.tokenAutoUpdate ?? options.cloudTokenAutoUpdate ?? false,
    tokenAutoUpdateIntervalHours:
      options.tokenAutoUpdateIntervalHours ?? options.cloudTokenAutoUpdateIntervalHours ?? 24,
    showStatusBar: options.showStatusBar ?? false,
    detailedPerformanceLogging: options.detailedPerformanceLogging ?? false,
    defaultSaveTarget: options.defaultSaveTarget ?? "local",
  };
  Object.defineProperty(config, "syncedStorage", {
    enumerable: true,
    get() {
      return globalStateValues.get(SYNCED_CLOUD_STATE_KEY) ?? legacySyncedStorage;
    },
    set(value) {
      legacySyncedStorage = value;
    },
  });

  if (options.syncedStorage && !globalStateValues.has(SYNCED_CLOUD_STATE_KEY)) {
    globalStateValues.set(SYNCED_CLOUD_STATE_KEY, JSON.parse(JSON.stringify(syncedStorage)));
  }

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
      createTreeView(id, viewOptions) {
        const treeView = createDisposable();
        treeView.id = id;
        treeView.treeDataProvider = viewOptions.treeDataProvider;
        treeView.reveal = async () => {};
        treeViews.set(id, treeView);
        return treeView;
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
        const channel = {
          name,
          options,
          entries,
          info() {},
          warn() {},
          error() {},
          appendLine() {},
          show() {},
          dispose() {},
        };
        channel.info = (line) => {
          entries.push({ level: "info", line });
        };
        channel.warn = (line) => {
          entries.push({ level: "warn", line });
        };
        channel.error = (line) => {
          entries.push({ level: "error", line });
        };
        createdChannels.push(channel);
        return channel;
      },
      createTerminal() {
        return {
          show() {},
          sendText(text) {
            sentTerminalCommands.push(text);
          },
        };
      },
      async showInputBox() {
        return inputBoxResponses.shift();
      },
      async showWarningMessage(message, ...actions) {
        warningMessages.push({ message, actions });
        return warningResponses.shift();
      },
      async showInformationMessage(message, ...actions) {
        informationMessages.push({ message, actions });
        const next = infoResponses.shift();
        if (typeof next === "function") {
          return next(message, actions);
        }
        return next;
      },
      async showErrorMessage(message, ...actions) {
        errorMessages.push({ message, actions });
        return undefined;
      },
      async showQuickPick(items) {
        const next = quickPickResponses.shift();
        if (typeof next === "function") {
          return next(items);
        }
        return next;
      },
      async withProgress(_options, task) {
        return task();
      },
    },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, "codex-account-switch");
        return {
          get(key, defaultValue) {
            return config[key] ?? defaultValue;
          },
          async update(key, value) {
            const configuredError = configurationUpdateErrors.get(key);
            if (configuredError) {
              throw configuredError instanceof Error ? configuredError : new Error(String(configuredError));
            }
            config[key] = value;
            const event = {
              affectsConfiguration(target) {
                return target === `codex-account-switch.${key}`;
              },
            };
            for (const listener of configurationListeners) {
              listener(event);
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
        executedCommands.push({ name, args });
        if (name === "workbench.action.reloadWindow") {
          return undefined;
        }
        const command = registeredCommands.get(name);
        return command ? command(...args) : undefined;
      },
    },
    env: {
      clipboard: {
        async writeText(value) {
          clipboardWrites.push(value);
        },
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
    executedCommands,
    clipboardWrites,
    sentTerminalCommands,
    warningMessages,
    informationMessages,
    errorMessages,
    treeViews,
    createdChannels,
    config,
    secrets: {
      async get(key) {
        return secretState.get(key);
      },
      async store(key, value) {
        secretState.set(key, value);
      },
      async delete(key) {
        secretState.delete(key);
      },
    },
    secretState,
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
    globalStateValues,
    legacySyncedStorage: () => legacySyncedStorage,
  };
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

async function withSuccessfulHttps(fn, mockOptions = {}) {
  const originalRequest = https.request;
  https.request = (requestOptions, handler) => {
    const hostname = requestOptions?.hostname;
    mockOptions?.requestLog?.push?.({
      hostname,
      path: requestOptions?.path ?? "",
      method: requestOptions?.method ?? "GET",
      authorization:
        requestOptions?.headers?.Authorization
        ?? requestOptions?.headers?.authorization
        ?? null,
    });
    const body =
      hostname === "auth.openai.com"
        ? JSON.stringify({
            access_token: "access-rotated",
            refresh_token: "refresh-rotated",
            id_token: makeJwt({
              email: "restored@example.com",
              name: "restored",
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

async function waitForBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 1700));
}

function countUsageRequests(requestLog) {
  return requestLog.filter((request) => request.hostname === "chatgpt.com").length;
}

function countAuthRefreshRequests(requestLog) {
  return requestLog.filter((request) => request.hostname === "auth.openai.com").length;
}

test("addAccount can use device auth for a new account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-add-account-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-device"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  const mocked = createVscodeMock({
    authDirectory: authDir,
    inputBoxResponses: ["device-user"],
    warningResponses: ["Use Device Auth"],
    infoResponses: ["Done", "Later"],
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.addAccount")();

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();

        assert.deepEqual(mocked.sentTerminalCommands, ["codex login --device-auth"]);
        assert.match(
          mocked.warningMessages[0]?.message ?? "",
          /device auth/i
        );
        const savedAuthPath = path.join(authDir, "auth_device-user.json");
        assert.equal(fs.existsSync(savedAuthPath), true);
      })
    );
  } finally {
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate restores the saved storage password from SecretStorage", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-storage-secret-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("secret-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "secret-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.useAccount")({
          account: { name: "work" },
        });

        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(currentAuth.tokens.account_id, "acct-work");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }
});

test("activate migrates legacy synced storage into synced globalState and registers the sync key", async () => {
  core.setSavedAuthPassphrase("migrate-passphrase");
  const syncedStorage = {
    version: 1,
    accounts: {
      migrated: core.serializeSavedValue("saved_auth", makeAuthFile("acct-migrated"), {
        requireEncryption: true,
      }),
    },
    providers: {},
    devices: ["device-a"],
    autoRefreshDeviceName: "device-a",
  };
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    syncedStorage,
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: undefined,
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalState.syncedKeys, [SYNCED_CLOUD_STATE_KEY]);
      assert.deepEqual(mocked.config.syncedStorage.accounts, syncedStorage.accounts);
      assert.equal(mocked.legacySyncedStorage(), undefined);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForBackgroundWork();
    })
  );
});

test("activation keeps migrated globalState data active when clearing legacy synced settings fails", async () => {
  core.setSavedAuthPassphrase("legacy-failure-passphrase");
  const syncedStorage = {
    version: 1,
    accounts: {
      blocked: core.serializeSavedValue("saved_auth", makeAuthFile("acct-blocked"), {
        requireEncryption: true,
      }),
    },
    providers: {},
    devices: ["device-a"],
    autoRefreshDeviceName: "device-a",
  };
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    syncedStorage,
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: undefined,
    },
    inputBoxResponses: ["legacy-failure-passphrase"],
    configurationUpdateErrors: {
      syncedStorage: new Error("EPERM legacy cleanup failed"),
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.config.syncedStorage.accounts, syncedStorage.accounts);
      assert.deepEqual(mocked.legacySyncedStorage(), syncedStorage);
      assert.equal(
        mocked.warningMessages.some((entry) => /migrated to extension state/i.test(entry.message)),
        true
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForBackgroundWork();
    })
  );
});

test("forget storage password removes the local secret and locks encrypted saved auth again", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-storage-forget-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("secret-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "secret-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.forgetStoragePassword")();

        await mocked.registeredCommands.get("codex-account-switch.useAccount")({
          account: { name: "work" },
        });

        assert.match(mocked.warningMessages.at(-1)?.message ?? "", /remains locked/i);
        assert.equal(mocked.secretState.has(STORAGE_SECRET_KEY), false);
        assert.equal(fs.existsSync(path.join(codexHome, "auth.json")), false);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }
});

test("unlock command restores access to locked cloud accounts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-storage-unlock-command-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("unlock-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      inputBoxResponses: [undefined, "unlock-passphrase"],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [lockedItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user");

        assert.equal(lockedItem.account.storageState, "locked");
        assert.equal(lockedItem.contextValue, "accountCloudLocked");

        await mocked.registeredCommands.get("codex-account-switch.unlockStorage")();

        const [unlockedItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user");

        assert.equal(mocked.secretState.get(STORAGE_SECRET_KEY), "unlock-passphrase");
        assert.equal(unlockedItem.account.storageState, "ready");
        assert.match(
          mocked.informationMessages.at(-1)?.message ?? "",
          /saved auth storage is unlocked/i
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }
});

test("useAccount prompts again to unlock locked cloud auth after activation was skipped", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-storage-unlock-use-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("unlock-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      inputBoxResponses: [undefined, "unlock-passphrase"],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [lockedItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(lockedItem);

        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(currentAuth.tokens.account_id, "acct-sync");
        assert.equal(mocked.secretState.get(STORAGE_SECRET_KEY), "unlock-passphrase");
        assert.equal(mocked.errorMessages.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }
});

test("addAccount can save to synced settings when cloud storage is selected", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-add-cloud-account-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-cloud"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: ["sync-user", "cloud-passphrase", "cloud-passphrase"],
      warningResponses: ["Login"],
      infoResponses: ["Done", "Later"],
      defaultSaveTarget: "cloud",
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.addAccount")();

        const syncedEntry = mocked.config.syncedStorage.accounts["sync-user"];
        assert.equal(typeof syncedEntry, "object");
        assert.equal(typeof syncedEntry.ciphertext, "string");
        assert.equal(syncedEntry.entryVersion, 1);
        assert.match(syncedEntry.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(fs.existsSync(path.join(authDir, "auth_sync-user.json")), false);
        assert.equal(mocked.secretState.get(STORAGE_SECRET_KEY), "cloud-passphrase");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("reloginAccount updates the saved cloud auth without changing the active account or prompting reload", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-relogin-cloud-globalstate-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), makeAuthFile("acct-active", {
    accessToken: "access-active-saved",
    refreshToken: "refresh-active-saved",
  }));
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-active", {
      accessToken: "access-active-current",
      refreshToken: "refresh-active-current",
    }), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.setSavedAuthPassphrase("cloud-passphrase");
    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cloud-passphrase",
      },
      warningResponses: ["Re-login"],
      infoResponses: [
        () => {
          fs.writeFileSync(
            path.join(codexHome, "auth.json"),
            JSON.stringify(makeAuthFile("acct-cloud", {
              accessToken: "access-new",
              refreshToken: "refresh-new",
            }), null, 2),
            "utf-8"
          );
          return "Done";
        },
      ],
      syncedStorage: {
        version: 1,
        accounts: {
          cloud: core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud", {
            accessToken: "access-old",
            refreshToken: "refresh-old",
          }), {
            requireEncryption: true,
          }),
        },
        providers: {},
        devices: [],
        autoRefreshDeviceName: null,
      },
      configurationUpdateErrors: {
        syncedStorage: new Error("settings.json is locked"),
      },
    });
    core.setSavedAuthPassphrase(null);

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "cloud" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.reloginAccount")(cloudItem);
        await waitForBackgroundWork();

        const updated = readCloudAccount(mocked.config, "cloud", "cloud-passphrase");
        assert.equal(updated.tokens.access_token, "access-new");
        assert.equal(updated.tokens.refresh_token, "refresh-new");
        const activeAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(activeAuth.tokens.account_id, "acct-active");
        assert.equal(
          mocked.executedCommands.some((entry) => entry.name === "workbench.action.reloadWindow"),
          false,
        );
        assert.equal(
          mocked.informationMessages.some(({ actions }) => actions.includes("Reload") || actions.includes("Later")),
          false,
        );
        assert.equal(
          mocked.informationMessages.some(({ message }) =>
            message.includes("Account \"cloud\" was updated") && message.includes("Active selection stayed on \"active (local)\"")
          ),
          true,
        );
        assert.equal(mocked.errorMessages.length, 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setNamedAuthDir(undefined);
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("legacy cloud account upgrades with visible sync metadata on manual refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-legacy-upgrade-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("legacy-passphrase");
    const legacyEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
        lastRefresh: new Date().toISOString(),
      }),
      {
        requireEncryption: true,
      }
    );
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": legacyEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "legacy-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")(cloudItem);

        const syncedEntry = getCloudEnvelope(mocked.config, "account", "sync-user");
        assert.equal(syncedEntry.entryVersion, 1);
        assert.match(syncedEntry.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

        const cloudAuth = readCloudAccount(mocked.config, "sync-user", "legacy-passphrase");
        assert.equal(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual cloud refresh increments visible sync version metadata", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-version-increment-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("increment-passphrase");
    const syncedEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
        lastRefresh: new Date().toISOString(),
      }),
      {
        requireEncryption: true,
      }
    );
    syncedEntry.entryVersion = 1;
    syncedEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": syncedEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "increment-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")(cloudItem);

        const nextEntry = getCloudEnvelope(mocked.config, "account", "sync-user");
        assert.equal(nextEntry.entryVersion, 2);
        assert.notEqual(nextEntry.updatedAt, "2026-04-01T00:00:00.000Z");
        assert.match(nextEntry.updatedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("cloud account tooltip keeps sync metadata while hiding redundant detail fields", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-account-tooltip-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("tooltip-passphrase");
    const syncedEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-tooltip"), {
      requireEncryption: true,
    });
    syncedEntry.entryVersion = 3;
    syncedEntry.updatedAt = "2026-04-05T06:07:08.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      secretValues: {
        [STORAGE_SECRET_KEY]: "tooltip-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          tooltip: syncedEntry,
        },
        providers: {},
        devices: ["device-tooltip"],
        autoRefreshDeviceName: "device-tooltip",
      },
    });

    await withMockedHostname("device-tooltip", async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider);
          const details = getAccountDetailItems(accountTreeView.treeDataProvider, cloudItem);

          assert.match(String(cloudItem.tooltip ?? ""), /Sync version: 3/);
          assert.match(String(cloudItem.tooltip ?? ""), /Updated: 2026-04-05T06:07:08.000Z/);
          assert.match(String(cloudItem.tooltip ?? ""), /Auto-refresh device: device-tooltip/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Source:/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Current device:/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Auto-refresh here:/);
          assert.equal(details.some((item) => item.label === "Source"), false);
          assert.equal(details.some((item) => item.label === "Current device"), false);
          assert.equal(details.some((item) => item.label === "Auto-refresh here"), false);
          assert.equal(details.some((item) => item.label === "Sync version"), true);
          assert.equal(details.some((item) => item.label === "Updated"), true);
          assert.equal(details.some((item) => item.label === "Auto-refresh device"), true);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForBackgroundWork();
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account details hide last refresh and support copying email", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-detail-refresh-copy-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const lastRefresh = "2026-04-09T09:54:28.060Z";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_ryanwalker.json"),
      makeAuthFile("acct-ryanwalker", {
        email: "ryanwalker@jqknono.com",
        plan: "free",
        lastRefresh,
      })
    );
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [accountItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "ryanwalker" && item.account.source === "local");
        const details = getAccountDetailItems(accountTreeView.treeDataProvider, accountItem);
        const emailItem = details.find((item) => item.label === "Email");

        assert.equal(emailItem?.contextValue, "accountCopyableField");
        assert.equal(emailItem?.description, "ryanwalker@jqknono.com");
        assert.equal(details.some((item) => item.label === "Source"), false);
        assert.equal(details.some((item) => item.label === "Last refresh"), false);
        assert.doesNotMatch(String(accountItem.tooltip ?? ""), /Last refresh:/);
        assert.equal(details.some((item) => item.label === "Refresh token"), false);

        await mocked.registeredCommands.get("codex-account-switch.copyAccountField")(emailItem);

        assert.deepEqual(mocked.clipboardWrites, ["ryanwalker@jqknono.com"]);
        assert.match(mocked.informationMessages.at(-1)?.message ?? "", /copied email/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refresh quota command writes command, account tree, and status bar performance logs", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-refresh-quota-perf-"));
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
    core.writeSavedAuthFile(
      path.join(authDir, "auth_perf-user.json"),
      makeAuthFile("acct-perf-user", {
        email: "perf-user@example.com",
        plan: "plus",
        lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
      })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-perf-user", {
          email: "perf-user@example.com",
          plan: "plus",
        }),
        null,
        2
      ),
      "utf-8"
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.refreshQuota")();
        await waitForBackgroundWork();

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) => line.includes("\"operation\":\"command:refreshQuota\"") && line.includes("\"durationMs\":")),
          true
        );
        assert.equal(
          lines.some((line) => line.includes("[codex-account-switch:vscode:accountTree]") && line.includes("\"operation\":\"accountTree.refreshQuota\"")),
          true
        );
        assert.equal(
          lines.some((line) => line.includes("[codex-account-switch:vscode:statusBar]") && line.includes("\"operation\":\"statusBar.refreshNow\"")),
          true
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refresh command tolerates non-account context payloads", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-refresh-command-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: false,
      cloudTokenAutoUpdate: false,
      quickPickResponses: [
        (items) => {
          const refreshToken = items.find((item) => item.label === "Refresh Token");
          const refreshQuota = items.find((item) => item.label === "Refresh Quota");
          assert.equal(refreshToken?.description, "Select an account or All to refresh token and quota");
          assert.equal(refreshQuota?.description, "Refresh quota for all accounts");
          return items[0];
        },
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      await mocked.registeredCommands.get("codex-account-switch.refresh")({});
      await waitForBackgroundWork();

      assert.equal(mocked.errorMessages.length, 0);
      assert.equal(
        mocked.executedCommands.some((entry) => entry.name === "codex-account-switch.refreshList"),
        true,
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    });
  } finally {
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refreshToken command offers All and refreshes every saved account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-refresh-token-all-"));
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
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha", {
        accessToken: "access-alpha-old",
        refreshToken: "refresh-alpha-old",
      })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_beta.json"),
      makeAuthFile("acct-beta", {
        accessToken: "access-beta-old",
        refreshToken: "refresh-beta-old",
      })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-alpha", {
          accessToken: "access-alpha-old",
          refreshToken: "refresh-alpha-old",
        }),
        null,
        2
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
      quickPickResponses: [
        (items) => {
          const allItem = items.find((item) => item.label === "All");
          assert.ok(allItem);
          assert.equal(allItem.description, "Refresh token and quota for all accounts");
          return allItem;
        },
      ],
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();
        requestLog.length = 0;

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")();
        await waitForBackgroundWork();

        assert.equal(countAuthRefreshRequests(requestLog), 2);
        assert.equal(countUsageRequests(requestLog), 2);

        const alphaAuth = JSON.parse(fs.readFileSync(path.join(authDir, "auth_alpha.json"), "utf-8"));
        const betaAuth = JSON.parse(fs.readFileSync(path.join(authDir, "auth_beta.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(alphaAuth.tokens.access_token, "access-rotated");
        assert.equal(alphaAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(betaAuth.tokens.access_token, "access-rotated");
        assert.equal(betaAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(currentAuth.tokens.access_token, "access-rotated");
        assert.equal(currentAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(
          mocked.informationMessages.some((entry) => entry.message.includes("Refreshed token and quota for 2 accounts")),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate in provider mode skips quota refresh and logs zero effective targets", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-activate-provider-mode-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const providerProfile = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile(providerProfile);
    const switchResult = core.switchMode("proxy");
    assert.equal(switchResult.success, true);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        assert.equal(requestLog.length, 0);
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("\"operation\":\"refreshCoordinator.flushQuotaRefresh\"")
            && line.includes("\"reason\":\"activate\"")
            && line.includes("\"effectiveCount\":0")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate in account mode refreshes only the current account quota", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-activate-account-mode-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), makeAuthFile("acct-alpha"));
    core.writeSavedAuthFile(path.join(authDir, "auth_beta.json"), makeAuthFile("acct-beta"));
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-beta"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        assert.equal(requestLog.length, 1);
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("\"operation\":\"refreshCoordinator.flushQuotaRefresh\"")
            && line.includes("\"reason\":\"activate\"")
            && line.includes("\"effectiveCount\":1")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("background quota refresh rotates one saved account per interval without extra status bar requests", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-auto-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const intervalHandles = [];
  const clearedIntervals = [];
  global.setInterval = (callback, ms) => {
    const handle = {
      callback,
      ms,
    };
    intervalHandles.push(handle);
    return handle;
  };
  global.clearInterval = (handle) => {
    clearedIntervals.push(handle);
  };

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha", { accessToken: "access-alpha" })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_beta.json"),
      makeAuthFile("acct-beta", { accessToken: "access-beta" })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_gamma.json"),
      makeAuthFile("acct-gamma", { accessToken: "access-gamma" })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-beta", { accessToken: "access-beta" }), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForBackgroundWork();

      const usageRequests = requestLog.filter((request) => request.hostname === "chatgpt.com");
      assert.equal(intervalHandles.length, 1);
      assert.equal(intervalHandles[0].ms, 300000);
      assert.equal(usageRequests.length, 1);
      assert.equal(usageRequests[0].authorization, "Bearer access-beta");

      await mocked.vscode.workspace
        .getConfiguration("codex-account-switch")
        .update("quotaRefreshInterval", 180);

      assert.equal(clearedIntervals.length >= 1, true);
      assert.equal(clearedIntervals[0], intervalHandles[0]);
      assert.equal(intervalHandles.length, 2);
      assert.equal(intervalHandles[1].ms, 180000);

      intervalHandles[1].callback();
      await waitForBackgroundWork();

      assert.equal(countUsageRequests(requestLog), 2);
      assert.equal(
        requestLog.filter((request) => request.hostname === "chatgpt.com")[1]?.authorization,
        "Bearer access-gamma"
      );

      intervalHandles[1].callback();
      await waitForBackgroundWork();

      assert.equal(countUsageRequests(requestLog), 3);
      assert.equal(
        requestLog.filter((request) => request.hostname === "chatgpt.com")[2]?.authorization,
        "Bearer access-alpha"
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
    }, { requestLog });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refreshQuota command on Local Accounts group refreshes all local account quotas", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-local-group-refresh-"));
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
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha", { accessToken: "access-alpha" })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_beta.json"),
      makeAuthFile("acct-beta", { accessToken: "access-beta" })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-alpha", { accessToken: "access-alpha" }), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        requestLog.length = 0;
        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const localGroup = getAccountTreeRootItems(accountTreeView.treeDataProvider)
          .find((item) => item.contextValue === "accountGroupLocal");
        assert.ok(localGroup);

        await mocked.registeredCommands.get("codex-account-switch.refreshQuota")(localGroup);

        const usageRequests = requestLog.filter((request) => request.hostname === "chatgpt.com");
        assert.equal(usageRequests.length, 2);
        assert.deepEqual(
          usageRequests.map((request) => request.authorization).sort(),
          ["Bearer access-alpha", "Bearer access-beta"]
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("second VS Code window reuses cached quota data and skips a fresh network request", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-quota-cache-"));
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
    core.writeSavedAuthFile(
      path.join(authDir, "auth_cache-user.json"),
      makeAuthFile("acct-cache-user", { accessToken: "access-cache-user" })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-cache-user", { accessToken: "access-cache-user" }), null, 2),
      "utf-8",
    );

    const firstWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(firstWindow.vscode);
        const context = createExtensionContext(firstWindow);
        await extension.activate(context);
        await waitForBackgroundWork();

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );

    const secondWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });
    const secondRequestLog = [];
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(secondWindow.vscode);
        const context = createExtensionContext(secondWindow);
        await extension.activate(context);

        const accountTreeView = secondWindow.treeViews.get("codexAccountSwitchAccounts");
        const cacheItem = getAccountTreeItems(accountTreeView.treeDataProvider)
          .find((item) => item.account.name === "cache-user");
        assert.ok(cacheItem);
        assert.match(String(cacheItem.description ?? ""), /Quota 90%/);
        assert.doesNotMatch(String(cacheItem.description ?? ""), /No quota data/i);

        await waitForBackgroundWork();
        assert.equal(countUsageRequests(secondRequestLog), 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog: secondRequestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("provider switch refreshes views without triggering quota requests", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-switch-refresh-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), makeAuthFile("acct-alpha"));
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-proxy" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-alpha"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
      quickPickResponses: [
        (items) => items.find((item) => item.provider?.name === "proxy"),
      ],
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        requestLog.length = 0;
        await mocked.registeredCommands.get("codex-account-switch.switchMode")();
        await waitForBackgroundWork();

        assert.equal(requestLog.length, 0);
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("\"operation\":\"refreshCoordinator.flushQuotaRefresh\"")
            && line.includes("\"reason\":\"provider-switch\"")
            && line.includes("\"effectiveCount\":0")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("refresh quota command reuses one saved entries snapshot for tree and status bar", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-refresh-quota-snapshot-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_alpha.json"), makeAuthFile("acct-alpha"));
    core.writeSavedAuthFile(path.join(authDir, "auth_beta.json"), makeAuthFile("acct-beta"));
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-alpha"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: true,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        mocked.createdChannels.forEach((channel) => {
          channel.entries.length = 0;
        });

        await mocked.registeredCommands.get("codex-account-switch.refreshQuota")();
        await waitForBackgroundWork();

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(countOperationLogs(lines, "listSavedAccounts"), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account tree separates quota failures from local and cloud accounts", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-tree-groups-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_local-ok.json"), makeAuthFile("acct-local-ok"));
    core.writeSavedAuthFile(path.join(authDir, "auth_local-fail.json"), makeAuthFile("acct-local-fail"));
    core.setNamedAuthDir(undefined);

    core.setSavedAuthPassphrase("group-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud-ok"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          "cloud-ok": cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "group-passphrase",
      },
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const provider = accountTreeView.treeDataProvider;
        provider.quotaState.set("local:local-fail", {
          info: null,
          loading: false,
          error: true,
          updatedAt: null,
        });
        provider.refresh();

        const groups = getAccountTreeRootItems(provider);
        assert.deepEqual(groups.map((item) => item.label), [
          "Quota Failed",
          "Local Accounts",
          "Cloud Accounts",
        ]);
        assert.deepEqual(provider.getChildren(groups[0]).map((item) => item.account.name), ["local-fail"]);
        assert.deepEqual(provider.getChildren(groups[1]).map((item) => item.account.name), ["local-ok"]);
        assert.deepEqual(provider.getChildren(groups[2]).map((item) => item.account.name), ["cloud-ok"]);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud account mutations are blocked and can open settings json", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-account-conflict-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("conflict-passphrase");
    const initialEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud"), {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      warningResponses: ["Remove", "Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "conflict-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          stale: initialEntry,
        },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "stale" && item.account.source === "cloud");

        core.setSavedAuthPassphrase("conflict-passphrase");
        const bumpedEntry = core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", { accessToken: "access-newer" }),
          { requireEncryption: true }
        );
        bumpedEntry.entryVersion = 2;
        bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.accounts.stale = bumpedEntry;

        await mocked.registeredCommands.get("codex-account-switch.removeAccount")(cloudItem);

        assert.equal(mocked.config.syncedStorage.accounts.stale.entryVersion, 2);
        assert.equal(mocked.errorMessages.length, 0);
        assert.match(mocked.warningMessages[1]?.message ?? "", /conflict/i);
        assert.match(mocked.warningMessages[1]?.message ?? "", /expected version 1/i);
        assert.match(mocked.warningMessages[1]?.message ?? "", /current version 2/i);
        assert.ok(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson")
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("remotely deleted cloud accounts are treated as conflicts instead of being recreated", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-account-deleted-conflict-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("deleted-passphrase");
    const initialEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud"), {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "deleted-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          stale: initialEntry,
        },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "stale" && item.account.source === "cloud");

        delete mocked.config.syncedStorage.accounts.stale;

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")(cloudItem);

        assert.equal(mocked.config.syncedStorage.accounts.stale, undefined);
        assert.equal(mocked.errorMessages.length, 0);
        assert.match(mocked.warningMessages[0]?.message ?? "", /conflict/i);
        assert.match(mocked.warningMessages[0]?.message ?? "", /expected version 1/i);
        assert.match(mocked.warningMessages[0]?.message ?? "", /current version unknown/i);
        assert.ok(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson")
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("stale cloud provider mutations are blocked and keep the latest synced entry", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-provider-conflict-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const providerProfile = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-old" },
      config: {
        name: "proxy",
        base_url: "https://example.com/v1",
        wire_api: "responses",
      },
    };

    core.setSavedAuthPassphrase("provider-conflict-passphrase");
    const initialEntry = core.serializeSavedValue("saved_provider", providerProfile, {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-conflict-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: initialEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = mocked.treeViews.get("codexAccountSwitchProviders");
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === "proxy" && item.provider.source === "cloud");

        core.setSavedAuthPassphrase("provider-conflict-passphrase");
        const bumpedEntry = core.serializeSavedValue(
          "saved_provider",
          {
            ...providerProfile,
            auth: { OPENAI_API_KEY: "sk-new" },
          },
          { requireEncryption: true }
        );
        bumpedEntry.entryVersion = 2;
        bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.providers.proxy = bumpedEntry;

        await mocked.registeredCommands.get("codex-account-switch.moveProviderToLocal")(providerItem);

        assert.equal(fs.existsSync(path.join(authDir, "provider_proxy.json")), false);
        assert.equal(mocked.config.syncedStorage.providers.proxy.entryVersion, 2);
        assert.equal(mocked.errorMessages.length, 0);
        assert.match(mocked.warningMessages[0]?.message ?? "", /conflict/i);
        assert.match(mocked.warningMessages[0]?.message ?? "", /current version 2/i);
        assert.ok(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson")
        );

        const savedProvider = readCloudProvider(mocked.config, "proxy", "provider-conflict-passphrase");
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-new");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("move account to local keeps an existing local account when cloud removal conflicts", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-move-local-rollback-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const localAuthPath = path.join(authDir, "auth_work.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      localAuthPath,
      makeAuthFile("acct-local", {
        accessToken: "access-local-original",
        refreshToken: "refresh-local-original",
      })
    );
    core.setNamedAuthDir(undefined);

    core.setSavedAuthPassphrase("move-local-passphrase");
    const initialEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-original",
        refreshToken: "refresh-cloud-original",
      }),
      { requireEncryption: true }
    );
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "move-local-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          work: initialEntry,
        },
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "cloud");

        core.setSavedAuthPassphrase("move-local-passphrase");
        const bumpedEntry = core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-newer",
            refreshToken: "refresh-cloud-newer",
          }),
          { requireEncryption: true }
        );
        bumpedEntry.entryVersion = 2;
        bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.accounts.work = bumpedEntry;

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToLocal")(cloudItem);

        core.setNamedAuthDir(authDir);
        const localResult = core.readSavedAuthFileResult(localAuthPath);
        core.setNamedAuthDir(undefined);

        assert.equal(localResult.status, "ok");
        assert.equal(localResult.value.tokens.access_token, "access-local-original");
        assert.equal(localResult.value.tokens.refresh_token, "refresh-local-original");
        assert.equal(mocked.config.syncedStorage.accounts.work.entryVersion, 2);
        assert.match(mocked.warningMessages[0]?.message ?? "", /conflict/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("move provider to local keeps an existing local provider when cloud removal conflicts", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-move-local-rollback-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const localProviderName = "proxy";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const localProfile = {
      kind: "provider",
      name: localProviderName,
      auth: { OPENAI_API_KEY: "sk-local-original" },
      config: {
        name: localProviderName,
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    };
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile(localProfile);
    core.setNamedAuthDir(undefined);

    const cloudProfile = {
      kind: "provider",
      name: localProviderName,
      auth: { OPENAI_API_KEY: "sk-cloud-original" },
      config: {
        name: localProviderName,
        base_url: "https://cloud.example.com/v1",
        wire_api: "responses",
      },
    };

    core.setSavedAuthPassphrase("provider-move-passphrase");
    const initialEntry = core.serializeSavedValue("saved_provider", cloudProfile, {
      requireEncryption: true,
    });
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-04-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Open Settings JSON"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-move-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          [localProviderName]: initialEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = mocked.treeViews.get("codexAccountSwitchProviders");
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === localProviderName && item.provider.source === "cloud");

        core.setSavedAuthPassphrase("provider-move-passphrase");
        const bumpedEntry = core.serializeSavedValue(
          "saved_provider",
          {
            ...cloudProfile,
            auth: { OPENAI_API_KEY: "sk-cloud-newer" },
          },
          { requireEncryption: true }
        );
        bumpedEntry.entryVersion = 2;
        bumpedEntry.updatedAt = "2026-04-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.providers[localProviderName] = bumpedEntry;

        await mocked.registeredCommands.get("codex-account-switch.moveProviderToLocal")(providerItem);

        core.setNamedAuthDir(authDir);
        const localResult = core.readProviderProfileResult(localProviderName);
        core.setNamedAuthDir(undefined);

        assert.equal(localResult.status, "ok");
        assert.equal(localResult.value.auth.OPENAI_API_KEY, "sk-local-original");
        assert.equal(mocked.config.syncedStorage.providers[localProviderName].entryVersion, 2);
        assert.match(mocked.warningMessages[0]?.message ?? "", /conflict/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("cloud provider tooltip shows visible sync revision metadata", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-provider-tooltip-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("provider-tooltip-passphrase");
    const syncedEntry = core.serializeSavedValue(
      "saved_provider",
      {
        kind: "provider",
        name: "proxy",
        auth: { OPENAI_API_KEY: "sk-test" },
        config: {
          name: "proxy",
          base_url: "https://example.com/v1",
          wire_api: "responses",
        },
      },
      {
        requireEncryption: true,
      }
    );
    syncedEntry.entryVersion = 4;
    syncedEntry.updatedAt = "2026-04-06T07:08:09.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-tooltip-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: syncedEntry,
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = mocked.treeViews.get("codexAccountSwitchProviders");
        const [providerItem] = providerTreeView.treeDataProvider.getChildren();

        assert.match(String(providerItem.tooltip ?? ""), /Sync version: 4/);
        assert.match(String(providerItem.tooltip ?? ""), /Updated: 2026-04-06T07:08:09.000Z/);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account tree shows duplicate local and cloud accounts with source labels", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-tree-sources-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("tree-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    const syncedStorage = {
      version: 1,
      accounts: {
        work: core.serializeSavedValue("saved_auth", makeAuthFile("acct-work"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "tree-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const items = getAccountTreeItems(accountTreeView.treeDataProvider);
        const groupLabels = getAccountTreeRootItems(accountTreeView.treeDataProvider).map((item) => item.label);
        const matching = items.filter((item) => item.account.name === "work");

        assert.equal(matching.length, 2);
        assert.deepEqual(
          matching.map((item) => item.account.source).sort(),
          ["cloud", "local"]
        );
        assert.ok(groupLabels.includes("Local Accounts"));
        assert.ok(groupLabels.includes("Cloud Accounts"));
        for (const item of matching) {
          assert.match(item.description ?? "", /local|cloud/i);
          assert.doesNotMatch(String(item.tooltip ?? ""), /Source:/i);
        }

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("account migration moves saved auth between local and cloud storage", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-migration-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "move-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_work.json")), false);
        assert.equal(typeof mocked.config.syncedStorage.accounts.work?.ciphertext, "string");

        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToLocal")(cloudItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_work.json")), true);
        assert.equal(mocked.config.syncedStorage.accounts.work, undefined);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("useAccount shares one cloud quota request between tree and status bar", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-use-account-quota-dedupe-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  core.setSavedAuthPassphrase("cloud-passphrase");
  const requestLog = [];
  const mocked = createVscodeMock({
    secretValues: {
      [STORAGE_SECRET_KEY]: "cloud-passphrase",
    },
    showStatusBar: true,
    syncedStorage: {
      version: 1,
      accounts: {
        sync: core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    },
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(cloudItem);
        await waitForBackgroundWork();

        assert.equal(countUsageRequests(requestLog), 1);
        assert.equal(countAuthRefreshRequests(requestLog), 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moveAccountToCloud avoids duplicate quota refresh after synced storage update", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-move-account-cloud-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-work"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    authDirectory: authDir,
    secretValues: {
      [STORAGE_SECRET_KEY]: "move-passphrase",
    },
    showStatusBar: true,
  });

  try {
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work"));
    core.setNamedAuthDir(undefined);

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);
        await waitForBackgroundWork();

        assert.equal(countUsageRequests(requestLog), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("hidden status bar does not add extra quota requests on activate or switch", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-hidden-status-bar-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  core.setSavedAuthPassphrase("cloud-passphrase");
  const requestLog = [];
  const mocked = createVscodeMock({
    secretValues: {
      [STORAGE_SECRET_KEY]: "cloud-passphrase",
    },
    showStatusBar: false,
    syncedStorage: {
      version: 1,
      accounts: {
        hidden: core.serializeSavedValue("saved_auth", makeAuthFile("acct-hidden"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    },
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        assert.equal(countUsageRequests(requestLog), 0);

        requestLog.length = 0;
        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "hidden" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(cloudItem);
        await waitForBackgroundWork();

        assert.equal(countUsageRequests(requestLog), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("moveAccountToLocal refreshes only the affected account quota", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-move-account-local-targeted-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-work"), null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  core.setSavedAuthPassphrase("cloud-passphrase");
  const requestLog = [];
  const mocked = createVscodeMock({
    secretValues: {
      [STORAGE_SECRET_KEY]: "cloud-passphrase",
    },
    showStatusBar: true,
    syncedStorage: {
      version: 1,
      accounts: {
        work: core.serializeSavedValue("saved_auth", makeAuthFile("acct-work"), {
          requireEncryption: true,
        }),
        other: core.serializeSavedValue("saved_auth", makeAuthFile("acct-other"), {
          requireEncryption: true,
        }),
      },
      providers: {},
    },
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToLocal")(cloudItem);
        await waitForBackgroundWork();

        assert.equal(countUsageRequests(requestLog), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      }, { requestLog })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("switching away from a cloud account does not auto-sync tokens by default", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-manual-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("manual-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_local-user.json"),
      makeAuthFile("acct-local")
    );
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date().toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-cloud", {
          accessToken: "access-cloud-current",
          refreshToken: "refresh-cloud-current",
          lastRefresh: new Date().toISOString(),
        }),
        null,
        2
      ),
      "utf-8"
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "manual-passphrase",
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(localItem);

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "manual-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual refresh still updates cloud tokens when automatic sync is disabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-manual-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("refresh-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date().toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "refresh-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")(cloudItem);

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "refresh-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForBackgroundWork();
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer refreshes local tokens when the refresh token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-local-timer-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryRefreshToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: "access-local-old",
    refreshToken: nearExpiryRefreshToken,
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
    tokenAutoUpdate: true,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await accountTreeView.treeDataProvider.refreshQuota([localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 1);
        assert.equal(countUsageRequests(requestLog), 1);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-rotated");
        assert.equal(savedAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(currentAuth.tokens.access_token, "access-rotated");
        assert.equal(currentAuth.tokens.refresh_token, "refresh-rotated");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer refresh keeps the saved local account unchanged when automatic token updates are disabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-local-timer-refresh-disabled-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryRefreshToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: "access-local-old",
    refreshToken: nearExpiryRefreshToken,
  });
  fs.writeFileSync(
    path.join(codexHome, "auth_local-user.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(localAuth, null, 2),
    "utf-8"
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    showStatusBar: false,
    tokenAutoUpdate: false,
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await accountTreeView.treeDataProvider.refreshQuota([localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 1);
        assert.equal(countUsageRequests(requestLog), 1);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-local-old");
        assert.equal(savedAuth.tokens.refresh_token, nearExpiryRefreshToken);
        assert.equal(currentAuth.tokens.access_token, "access-rotated");
        assert.equal(currentAuth.tokens.refresh_token, "refresh-rotated");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      }, { requestLog })
    );
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("timer refreshes cloud tokens when the refresh token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-timer-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("timer-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: [currentDeviceName],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "timer-passphrase",
      },
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForBackgroundWork();
          requestLog.length = 0;

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await accountTreeView.treeDataProvider.refreshQuota([cloudItem.account.id], {
            reason: "timer",
          });

          assert.equal(countAuthRefreshRequests(requestLog), 1);
          assert.equal(countUsageRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "timer-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        }, { requestLog })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("automatic cloud token sync does not refresh tokens during quota refresh after the configured hour interval", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-auto-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("auto-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: [currentDeviceName],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "auto-passphrase",
      },
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForBackgroundWork();

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "auto-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("automatic cloud token sync skips writes before the configured hour interval elapses", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-auto-throttle-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("throttle-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
            lastCloudTokenSync: new Date().toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "throttle-passphrase",
      },
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "throttle-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate registers the current device once when synced cloud state exists", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-device-register-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("device-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        sync: core.serializeSavedValue("saved_auth", makeAuthFile("acct-sync", {
          lastRefresh: new Date().toISOString(),
          lastCloudTokenSync: new Date().toISOString(),
        }), {
          requireEncryption: true,
        }),
      },
      providers: {},
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "device-passphrase",
      },
      cloudTokenAutoUpdate: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForBackgroundWork();

          assert.deepEqual(mocked.config.syncedStorage.devices, [currentDeviceName]);
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }

          const extensionAgain = loadExtensionWithMockedVscode(mocked.vscode);
          const contextAgain = createExtensionContext(mocked);
          await extensionAgain.activate(contextAgain);
          await waitForBackgroundWork();

          assert.deepEqual(mocked.config.syncedStorage.devices, [currentDeviceName]);

          for (const subscription of contextAgain.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("activate does not create a synced device entry when synced cloud state is empty", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-device-register-empty-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForBackgroundWork();

        assert.deepEqual(mocked.config.syncedStorage.devices, []);
        assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      });
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("automatic cloud token sync uses the first synced device when no explicit device is selected", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-device-first-default-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("default-first-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other"],
      autoRefreshDeviceName: null,
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "default-first-passphrase",
      },
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForBackgroundWork();

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "default-first-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.deepEqual(mocked.config.syncedStorage.devices, ["device-other", currentDeviceName]);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("automatic cloud token sync respects the explicitly selected synced device without refreshing tokens during quota refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-device-explicit-select-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("explicit-select-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other", currentDeviceName],
      autoRefreshDeviceName: currentDeviceName,
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "explicit-select-passphrase",
      },
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForBackgroundWork();

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "explicit-select-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, currentDeviceName);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual cloud token refresh still works when this device is not selected for automatic refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-device-manual-override-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("manual-override-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other", currentDeviceName],
      autoRefreshDeviceName: "device-other",
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "manual-override-passphrase",
      },
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForBackgroundWork();

          let cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "manual-override-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await mocked.registeredCommands.get("codex-account-switch.refreshToken")(cloudItem);

          cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "manual-override-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForBackgroundWork();
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("invalid selected auto-refresh device is not replaced when quota refresh does not persist tokens", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-device-prompt-select-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("prompt-select-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-old",
            refreshToken: "refresh-cloud-old",
            lastRefresh: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other"],
      autoRefreshDeviceName: "device-missing",
    };
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "prompt-select-passphrase",
      },
      quickPickResponses: [
        (items) => items.find((item) => item.deviceName === currentDeviceName),
      ],
      cloudTokenAutoUpdate: true,
      cloudTokenAutoUpdateIntervalHours: 1,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForBackgroundWork();

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "prompt-select-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.deepEqual(mocked.config.syncedStorage.devices, ["device-other", currentDeviceName]);
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, "device-missing");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
        })
      );
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("select auto-refresh device command updates the synced selection", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-device-command-select-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
        devices: ["device-a", "device-b"],
        autoRefreshDeviceName: null,
      },
      quickPickResponses: [
        (items) => items.find((item) => item.deviceName === "device-b"),
      ],
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.selectAutoRefreshDevice")();

        assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, "device-b");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      });
    });
  } finally {
    core.setSavedAuthPassphrase(null);
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
