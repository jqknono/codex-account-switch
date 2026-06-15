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
const SYNCED_CLOUD_ACCOUNT_KEY_PREFIX = "codex-account-switch.syncedCloudAccount.v1.";
const SYNCED_CLOUD_PROVIDER_KEY_PREFIX = "codex-account-switch.syncedCloudProvider.v1.";
const AUTH_UPDATED_AT_FIELD = "codex_account_switch_auth_updated_at";

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

function getSyncedCloudAccountKey(name) {
  return `${SYNCED_CLOUD_ACCOUNT_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function getSyncedCloudProviderKey(name) {
  return `${SYNCED_CLOUD_PROVIDER_KEY_PREFIX}${encodeURIComponent(name)}`;
}

function getProtectedCloudAccountBackupPath(mocked, name) {
  return path.join(
    mocked.globalStoragePath,
    "cloud-account-recovery",
    "accounts",
    `${encodeURIComponent(name)}.json`
  );
}

function readMockSyncedStorage(globalStateValues, legacySyncedStorage) {
  const raw = globalStateValues.get(SYNCED_CLOUD_STATE_KEY) ?? legacySyncedStorage;
  const accounts = { ...(raw?.accounts ?? {}) };
  const providers = { ...(raw?.providers ?? {}) };
  const accountNames = new Set([
    ...Object.keys(accounts),
    ...(
      Array.isArray(raw?.accountNames)
        ? raw.accountNames.filter((name) => typeof name === "string")
        : []
    ),
  ]);
  const providerNames = new Set([
    ...Object.keys(providers),
    ...(
      Array.isArray(raw?.providerNames)
        ? raw.providerNames.filter((name) => typeof name === "string")
        : []
    ),
  ]);
  for (const name of accountNames) {
    const value = globalStateValues.get(getSyncedCloudAccountKey(name));
    if (value !== undefined) {
      accounts[name] = value;
    }
  }
  for (const name of providerNames) {
    const value = globalStateValues.get(getSyncedCloudProviderKey(name));
    if (value !== undefined) {
      providers[name] = value;
    }
  }
  const syncEntryNames = () => {
    const state = globalStateValues.get(SYNCED_CLOUD_STATE_KEY);
    if (state) {
      state.accountNames = Object.keys(accounts).sort();
      state.accounts = {};
      state.providerNames = Object.keys(providers).sort();
      state.providers = {};
    }
  };
  return {
    version: 1,
    accounts: new Proxy(accounts, {
      set(target, property, value) {
        if (typeof property !== "string") {
          return false;
        }
        target[property] = value;
        globalStateValues.set(getSyncedCloudAccountKey(property), value);
        syncEntryNames();
        return true;
      },
      deleteProperty(target, property) {
        if (typeof property !== "string") {
          return false;
        }
        delete target[property];
        globalStateValues.delete(getSyncedCloudAccountKey(property));
        syncEntryNames();
        return true;
      },
    }),
    accountNames: [...accountNames].sort(),
    providers: new Proxy(providers, {
      set(target, property, value) {
        if (typeof property !== "string") {
          return false;
        }
        target[property] = value;
        globalStateValues.set(getSyncedCloudProviderKey(property), value);
        syncEntryNames();
        return true;
      },
      deleteProperty(target, property) {
        if (typeof property !== "string") {
          return false;
        }
        delete target[property];
        globalStateValues.delete(getSyncedCloudProviderKey(property));
        syncEntryNames();
        return true;
      },
    }),
    providerNames: [...providerNames].sort(),
    devices: raw?.devices ?? [],
    autoRefreshDeviceName: raw?.autoRefreshDeviceName ?? null,
  };
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
  const createdTerminals = [];
  const warningMessages = [];
  const informationMessages = [];
  const errorMessages = [];
  const inputBoxCalls = [];
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
  const syncedGlobalStateValues = new Map(Object.entries(options.syncedGlobalStateValues ?? {}));
  const globalStoragePath = options.globalStoragePath
    ?? fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-global-storage-"));
  fs.mkdirSync(globalStoragePath, { recursive: true });
  const syncedStorage = options.syncedStorage
    ? {
        version: options.syncedStorage.version ?? 1,
        accounts: options.syncedStorage.accounts ?? {},
        providers: options.syncedStorage.providers ?? {},
        accountNames: options.syncedStorage.accountNames ?? Object.keys(options.syncedStorage.accounts ?? {}),
        providerNames: options.syncedStorage.providerNames ?? Object.keys(options.syncedStorage.providers ?? {}),
        devices: options.syncedStorage.devices ?? [],
        autoRefreshDeviceName: options.syncedStorage.autoRefreshDeviceName ?? null,
      }
    : {
        version: 1,
        accounts: {},
        accountNames: [],
        providers: {},
        providerNames: [],
        devices: [],
        autoRefreshDeviceName: null,
      };
  let legacySyncedStorage = JSON.parse(JSON.stringify(syncedStorage));

  const config = {
    authDirectory: options.authDirectory,
    reloadWindowAfterSwitch: "never",
    useDeviceAuthForLogin: options.useDeviceAuthForLogin ?? false,
    quotaRefreshInterval: 30,
    tokenAutoUpdate: options.tokenAutoUpdate ?? options.cloudTokenAutoUpdate ?? true,
    tokenAutoUpdateIntervalHours:
      options.tokenAutoUpdateIntervalHours ?? options.cloudTokenAutoUpdateIntervalHours ?? 24,
    showStatusBar: options.showStatusBar ?? false,
    detailedPerformanceLogging: options.detailedPerformanceLogging ?? false,
    defaultSaveTarget: options.defaultSaveTarget ?? "local",
  };
  Object.defineProperty(config, "syncedStorage", {
    enumerable: true,
    get() {
      return readMockSyncedStorage(globalStateValues, legacySyncedStorage);
    },
    set(value) {
      legacySyncedStorage = value;
    },
  });

  if (options.syncedStorage && !globalStateValues.has(SYNCED_CLOUD_STATE_KEY)) {
    for (const [name, account] of Object.entries(syncedStorage.accounts)) {
      globalStateValues.set(getSyncedCloudAccountKey(name), JSON.parse(JSON.stringify(account)));
    }
    for (const [name, provider] of Object.entries(syncedStorage.providers)) {
      globalStateValues.set(getSyncedCloudProviderKey(name), JSON.parse(JSON.stringify(provider)));
    }
    globalStateValues.set(SYNCED_CLOUD_STATE_KEY, {
      version: 1,
      accounts: {},
      accountNames: syncedStorage.accountNames.sort(),
      providers: {},
      providerNames: syncedStorage.providerNames.sort(),
      devices: [...syncedStorage.devices],
      autoRefreshDeviceName: syncedStorage.autoRefreshDeviceName,
    });
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
      createTerminal(options) {
        const terminal = {
          options,
          show() {},
          sendText(text) {
            sentTerminalCommands.push(text);
          },
        };
        createdTerminals.push(terminal);
        return terminal;
      },
      async showInputBox(inputOptions) {
        inputBoxCalls.push(inputOptions);
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
            if (key === "syncedStorage" && options.legacyConfigurationSyncedStorage) {
              return legacySyncedStorage;
            }
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
    createdTerminals,
    warningMessages,
    informationMessages,
    errorMessages,
    inputBoxCalls,
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
        if (options.afterGlobalStateUpdate) {
          await options.afterGlobalStateUpdate(key, value, {
            globalStateValues,
            syncedGlobalStateValues,
          });
        }
        if (options.captureSyncedGlobalStateWrites && this.syncedKeys?.includes(key)) {
          if (value === undefined) {
            syncedGlobalStateValues.delete(key);
          } else {
            syncedGlobalStateValues.set(key, JSON.parse(JSON.stringify(value)));
          }
        }
      },
    },
    globalStateValues,
    syncedGlobalStateValues,
    globalStoragePath,
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
    globalStorageUri: {
      fsPath: mocked.globalStoragePath,
    },
  };
}

async function withDisabledIntervals(fn) {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const zeroTimeouts = [];
  global.setInterval = () => ({ __mockInterval: true });
  global.clearInterval = () => {};
  global.setTimeout = (callback, delay, ...args) => {
    if (delay === 0) {
      const handle = {
        __mockTimeout: true,
        callback,
        args,
        cleared: false,
      };
      zeroTimeouts.push(handle);
      return handle;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle?.__mockTimeout) {
      handle.cleared = true;
      return;
    }
    return originalClearTimeout(handle);
  };

  const flushTimers = async () => {
    while (true) {
      const handle = zeroTimeouts.find((timer) => !timer.cleared);
      if (!handle) {
        return;
      }
      handle.cleared = true;
      handle.callback(...handle.args);
      await Promise.resolve();
    }
  };

  try {
    return await fn({ flushTimers });
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
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

async function withFailingHttps(fn, mockOptions = {}) {
  const originalRequest = https.request;
  https.request = (requestOptions) => {
    mockOptions?.requestLog?.push?.({
      hostname: requestOptions?.hostname,
      path: requestOptions?.path ?? "",
      method: requestOptions?.method ?? "GET",
    });
    const listeners = new Map();
    const request = {
      on(event, listener) {
        listeners.set(event, listener);
        return request;
      },
      setTimeout() {
        return request;
      },
      destroy() {},
      write() {},
      end() {
        setImmediate(() => listeners.get("error")?.(new Error("quota network failed")));
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

async function withQuotaRejectedHttps(fn, mockOptions = {}) {
  const originalRequest = https.request;
  const statusCode = mockOptions.statusCode ?? 401;
  const rejectionBody = mockOptions.body ?? {
    detail: "authentication token expired",
  };
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
    const isQuotaRequest = hostname === "chatgpt.com";
    const body = isQuotaRequest
      ? JSON.stringify(rejectionBody)
      : JSON.stringify({
          access_token: "access-rotated",
          refresh_token: "refresh-rotated",
          id_token: makeJwt({
            email: "restored@example.com",
            name: "restored",
            "https://api.openai.com/auth": {
              chatgpt_plan_type: "plus",
            },
          }),
        });
    const response = {
      statusCode: isQuotaRequest ? statusCode : 200,
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

async function withRefreshTokenReusedHttps(fn, failure = {}) {
  const originalRequest = https.request;
  const failureMessage = failure.message
    ?? "Your refresh token has already been used to generate a new access token. Please try signing in again.";
  const failureCode = failure.code ?? "refresh_token_reused";
  https.request = (requestOptions, handler) => {
    const hostname = requestOptions?.hostname;
    const isTokenRequest = hostname === "auth.openai.com";
    const body = isTokenRequest
      ? JSON.stringify({
          error: {
            message: failureMessage,
            type: "invalid_request_error",
            param: null,
            code: failureCode,
          },
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
      statusCode: isTokenRequest ? 401 : 200,
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

async function waitForRefreshCoordinatorIdle(context) {
  const refreshCoordinator = getRefreshCoordinator(context);
  assert.ok(refreshCoordinator);
  await refreshCoordinator.whenIdle();
}

function countUsageRequests(requestLog) {
  return requestLog.filter((request) => request.hostname === "chatgpt.com").length;
}

function countAuthRefreshRequests(requestLog) {
  return requestLog.filter((request) => request.hostname === "auth.openai.com").length;
}

function writeLastTerminalAuth(mocked, auth) {
  const terminal = mocked.createdTerminals.at(-1);
  const codexHome = terminal?.options?.env?.CODEX_HOME;
  assert.equal(typeof codexHome, "string");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(auth, null, 2), "utf-8");
}

function getRefreshCoordinator(context) {
  return context.subscriptions.find(
    (item) =>
      item
      && typeof item.scheduleQuotaRefresh === "function"
      && typeof item.refreshViews === "function"
  );
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
    infoResponses: [
      () => {
        writeLastTerminalAuth(mocked, makeAuthFile("acct-device"));
        return "Done";
      },
      "Later",
    ],
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
        await waitForRefreshCoordinatorIdle(context);

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

test("addAccount saves a new local account without switching away from the active account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-add-local-preserve-active-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const activeAuth = makeAuthFile("acct-active", {
    accessToken: "access-active-current",
    refreshToken: "refresh-active-current",
  });
  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), makeAuthFile("acct-active", {
    accessToken: "access-active-saved",
    refreshToken: "refresh-active-saved",
  }));
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(activeAuth, null, 2), "utf-8");

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  const requestLog = [];
  const mocked = createVscodeMock({
    authDirectory: authDir,
    inputBoxResponses: ["new-user"],
    warningResponses: ["Login"],
    infoResponses: [
      () => {
        writeLastTerminalAuth(
          mocked,
          makeAuthFile("acct-new", {
            accessToken: "access-new",
            refreshToken: "refresh-new",
          }),
        );
        return "Done";
      },
      "Later",
    ],
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        await mocked.registeredCommands.get("codex-account-switch.addAccount")();
        await waitForRefreshCoordinatorIdle(context);

        const savedNew = JSON.parse(fs.readFileSync(path.join(authDir, "auth_new-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        const savedActive = JSON.parse(fs.readFileSync(path.join(authDir, "auth_active.json"), "utf-8"));
        assert.equal(savedNew.tokens.account_id, "acct-new");
        assert.equal(savedNew.tokens.access_token, "access-new");
        assert.equal(currentAuth.tokens.account_id, "acct-active");
        assert.equal(currentAuth.tokens.access_token, "access-active-current");
        assert.equal(savedActive.tokens.account_id, "acct-active");
        assert.equal(savedActive.tokens.access_token, "access-active-saved");
        const marker = mocked.globalStateValues.get("codex-account-switch.currentSavedSelection");
        assert.equal(marker?.kind, "account");
        assert.equal(marker?.name, "active");
        assert.equal(marker?.source, "local");
        assert.equal(countAuthRefreshRequests(requestLog), 0);
        const savedMessage = mocked.informationMessages.find(({ message }) =>
          message.includes('Account "new-user" was saved')
        );
        assert.ok(savedMessage);
        assert.equal(savedMessage.actions.includes("Reload"), false);
        assert.equal(savedMessage.actions.includes("Later"), false);
        assert.match(savedMessage.message, /not active/i);
        assert.match(savedMessage.message, /Switch Account/i);
        assert.doesNotMatch(savedMessage.message, /Reload/i);

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

test("addAccount saves bob1990 without replacing the active cloud google1 auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-add-local-preserve-cloud-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const googleAuth = makeAuthFile("acct-google1", {
    email: "google1@example.com",
    accessToken: "access-google1-current",
    refreshToken: "refresh-google1-current",
  });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("cloud-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", googleAuth, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    fs.writeFileSync(path.join(codexHome, "auth.json"), JSON.stringify(googleAuth, null, 2), "utf-8");

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cloud-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          google1: cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "account",
          name: "google1",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      },
      inputBoxResponses: ["bob1990"],
      warningResponses: ["Login"],
      infoResponses: [
        () => {
          writeLastTerminalAuth(
            mocked,
            makeAuthFile("acct-bob", {
              email: "bob1990@example.com",
              accessToken: "access-bob-login",
              refreshToken: "refresh-bob-login",
            }),
          );
          return "Done";
        },
        "Later",
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        await mocked.registeredCommands.get("codex-account-switch.addAccount")();
        await waitForRefreshCoordinatorIdle(context);

        core.setSavedAuthPassphrase("cloud-passphrase");
        const savedBobResult = core.readSavedAuthFileResult(path.join(authDir, "auth_bob1990.json"));
        core.setSavedAuthPassphrase(null);
        assert.equal(savedBobResult.status, "ok");
        const savedBob = savedBobResult.value;
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        const cloudAuth = readCloudAccount(mocked.config, "google1", "cloud-passphrase");
        assert.equal(savedBob.tokens.account_id, "acct-bob");
        assert.equal(savedBob.tokens.access_token, "access-bob-login");
        assert.equal(currentAuth.tokens.account_id, "acct-google1");
        assert.equal(currentAuth.tokens.access_token, "access-google1-current");
        assert.equal(cloudAuth.tokens.account_id, "acct-google1");
        assert.equal(cloudAuth.tokens.access_token, "access-google1-current");
        assert.equal(getCloudEnvelope(mocked.config, "account", "google1").entryVersion, 2);
        assert.deepEqual(mocked.globalStateValues.get("codex-account-switch.currentSavedSelection"), {
          kind: "account",
          name: "google1",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-05-01T00:00:00.000Z",
        });
        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(
          requestLog.some((request) => request.authorization === "Bearer access-google1-current"),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
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

test("addAccount restores the active account when a duplicate local login is rejected", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-add-local-duplicate-restore-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  core.setNamedAuthDir(authDir);
  core.writeSavedAuthFile(path.join(authDir, "auth_active.json"), makeAuthFile("acct-active", {
    accessToken: "access-active-current",
    refreshToken: "refresh-active-current",
  }));
  core.writeSavedAuthFile(path.join(authDir, "auth_bob1990.json"), makeAuthFile("acct-bob", {
    email: "bob1990@jqknono.com",
    accessToken: "access-bob-saved",
    refreshToken: "refresh-bob-saved",
  }));
  core.setNamedAuthDir(undefined);
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-active", {
      accessToken: "access-active-current",
      refreshToken: "refresh-active-current",
    }), null, 2),
    "utf-8",
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  const mocked = createVscodeMock({
    authDirectory: authDir,
    inputBoxResponses: ["microsoft2"],
    warningResponses: ["Login"],
    infoResponses: [
      () => {
        writeLastTerminalAuth(
          mocked,
          makeAuthFile("acct-bob", {
            email: "bob1990@jqknono.com",
            accessToken: "access-bob-login",
            refreshToken: "refresh-bob-login",
          }),
        );
        return "Done";
      },
    ],
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        await mocked.registeredCommands.get("codex-account-switch.addAccount")();
        await waitForRefreshCoordinatorIdle(context);

        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        const savedBob = JSON.parse(fs.readFileSync(path.join(authDir, "auth_bob1990.json"), "utf-8"));
        assert.equal(fs.existsSync(path.join(authDir, "auth_microsoft2.json")), false);
        assert.equal(currentAuth.tokens.account_id, "acct-active");
        assert.equal(currentAuth.tokens.access_token, "access-active-current");
        assert.equal(savedBob.tokens.account_id, "acct-bob");
        assert.equal(savedBob.tokens.access_token, "access-bob-saved");
        const marker = mocked.globalStateValues.get("codex-account-switch.currentSavedSelection");
        assert.equal(marker?.kind, "account");
        assert.equal(marker?.name, "active");
        assert.equal(marker?.source, "local");
        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /Duplicate add was rejected/i);

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
        await waitForRefreshCoordinatorIdle(context);
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

      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("migrated"),
      ]);
      assert.deepEqual(mocked.config.syncedStorage.accounts, syncedStorage.accounts);
      assert.equal(mocked.legacySyncedStorage(), undefined);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
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
    accountNames: ["blocked"],
    providers: {},
    providerNames: [],
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

      assert.equal(mocked.config.syncedStorage.accounts.blocked.email, "acct-blocked@example.com");
      assert.equal(mocked.config.syncedStorage.accounts.blocked.entryVersion, syncedStorage.accounts.blocked.entryVersion);
      assert.equal(mocked.config.syncedStorage.accounts.blocked.updatedAt, syncedStorage.accounts.blocked.updatedAt);
      assert.deepEqual(mocked.legacySyncedStorage(), syncedStorage);
      assert.equal(
        mocked.warningMessages.some((entry) => /migrated to extension state/i.test(entry.message)),
        true
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate materializes aggregate cloud accounts and providers into per-entry synced keys", async () => {
  const accountEntry = makeAuthFile("acct-aggregate", { email: "aggregate@example.com" });
  const providerEntry = {
    kind: "provider",
    name: "proxy",
    auth: { OPENAI_API_KEY: "sk-proxy" },
    config: {
      name: "proxy",
      base_url: "https://proxy.example.com/v1",
      wire_api: "responses",
    },
  };
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          aggregate: accountEntry,
        },
        accountNames: ["aggregate"],
        providers: {
          proxy: providerEntry,
        },
        providerNames: ["proxy"],
        devices: ["device-a"],
        autoRefreshDeviceName: "device-a",
      },
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providers, {});
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["aggregate"]);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["proxy"]);
      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudAccountKey("aggregate")), {
        ...accountEntry,
        email: "aggregate@example.com",
      });
      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudProviderKey("proxy")), providerEntry);
      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("aggregate"),
        getSyncedCloudProviderKey("proxy"),
      ]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate preserves names-only cloud account and provider index entries", async () => {
  const accountEntry = makeAuthFile("acct-present", { email: "present@example.com" });
  const providerEntry = {
    kind: "provider",
    name: "present-proxy",
    auth: { OPENAI_API_KEY: "sk-present" },
    config: {
      name: "present-proxy",
      base_url: "https://present.example.com/v1",
      wire_api: "responses",
    },
  };
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          present: accountEntry,
        },
        accountNames: ["missing", "present"],
        providers: {
          "present-proxy": providerEntry,
        },
        providerNames: ["missing-proxy", "present-proxy"],
        devices: ["device-a"],
        autoRefreshDeviceName: "device-a",
      },
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["missing", "present"]);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["missing-proxy", "present-proxy"]);
      assert.equal(mocked.globalStateValues.has(getSyncedCloudAccountKey("missing")), false);
      assert.equal(mocked.globalStateValues.has(getSyncedCloudProviderKey("missing-proxy")), false);
      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("missing"),
        getSyncedCloudAccountKey("present"),
        getSyncedCloudProviderKey("missing-proxy"),
        getSyncedCloudProviderKey("present-proxy"),
      ]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("delayed synced cloud account payload becomes available after refresh", async () => {
  core.setSavedAuthPassphrase("delayed-passphrase");
  const delayedAccount = core.serializeSavedValue(
    "saved_auth",
    makeAuthFile("acct-apple1", { email: "apple1@example.com" }),
    {
      requireEncryption: true,
    }
  );
  delayedAccount.entryVersion = 1;
  delayedAccount.updatedAt = "2026-05-25T00:00:00.000Z";
  core.setSavedAuthPassphrase(null);

  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {},
        accountNames: ["apple1"],
        providers: {},
        providerNames: [],
      },
    },
    secretValues: {
      [STORAGE_SECRET_KEY]: "delayed-passphrase",
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
      let [appleItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

      assert.equal(appleItem.account.storageState, "pending");
      assert.match(appleItem.account.storageMessage, /payload has not synced/);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["apple1"]);
      assert.deepEqual(mocked.globalState.syncedKeys, [
        SYNCED_CLOUD_STATE_KEY,
        getSyncedCloudAccountKey("apple1"),
      ]);

      await mocked.globalState.update(getSyncedCloudAccountKey("apple1"), delayedAccount);
      await mocked.registeredCommands.get("codex-account-switch.refreshList")();

      [appleItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

      assert.equal(appleItem.account.storageState, "ready");
      assert.equal(appleItem.account.meta.email, "apple1@example.com");
      assert.equal(appleItem.account.syncVersion, 1);
      assert.equal(appleItem.account.syncUpdatedAt, "2026-05-25T00:00:00.000Z");

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("remove account deletes a names-only cloud account index entry", async () => {
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {},
        accountNames: ["apple1"],
        providers: {},
        providerNames: [],
      },
    },
    secretValues: {
      [STORAGE_SECRET_KEY]: "unused-passphrase",
    },
    warningResponses: ["Remove"],
  });
  const backupPath = getProtectedCloudAccountBackupPath(mocked, "apple1");
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.writeFileSync(
    backupPath,
    JSON.stringify({
      version: 1,
      kind: "cloud_account_payload_backup",
      name: "apple1",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
      syncVersion: null,
      syncUpdatedAt: null,
      payload: {
        ciphertext: "protected",
      },
    }),
    "utf-8"
  );

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
      const [appleItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
        .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

      assert.ok(appleItem);
      assert.equal(fs.existsSync(backupPath), true);
      await mocked.registeredCommands.get("codex-account-switch.removeAccount")(appleItem);

      assert.deepEqual(mocked.errorMessages, []);
      assert.deepEqual(mocked.warningMessages.map((message) => message.message), [
        'Remove account "apple1" from cloud storage?',
      ]);
      assert.equal(mocked.informationMessages.length, 1);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, []);
      assert.equal(mocked.globalStateValues.has(getSyncedCloudAccountKey("apple1")), false);
      assert.equal(fs.existsSync(backupPath), false);
      assert.match(mocked.informationMessages[0]?.message ?? "", /Account "apple1" was removed/);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate keeps the highest-version payload when materializing cloud entries", async () => {
  const staleAccount = makeAuthFile("acct-stale", { email: "stale@example.com" });
  staleAccount.entryVersion = 3;
  staleAccount.updatedAt = "2026-05-01T00:00:00.000Z";
  const freshAccount = makeAuthFile("acct-fresh", { email: "fresh@example.com" });
  freshAccount.entryVersion = 7;
  freshAccount.updatedAt = "2026-05-02T00:00:00.000Z";
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          sync: freshAccount,
        },
        accountNames: ["sync"],
        providers: {},
        providerNames: [],
        devices: [],
        autoRefreshDeviceName: null,
      },
      [getSyncedCloudAccountKey("sync")]: staleAccount,
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("sync")).entryVersion, 7);
      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("sync")).email, "fresh@example.com");
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["sync"]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate restores names-only cloud entries from legacy payloads when available", async () => {
  const legacyAccount = makeAuthFile("acct-legacy", { email: "legacy@example.com" });
  legacyAccount.entryVersion = 4;
  legacyAccount.updatedAt = "2026-05-01T00:00:00.000Z";
  const legacyProvider = {
    kind: "provider",
    name: "legacy-proxy",
    auth: { OPENAI_API_KEY: "sk-legacy" },
    config: {
      name: "legacy-proxy",
      base_url: "https://legacy.example.com/v1",
      wire_api: "responses",
    },
    entryVersion: 5,
    updatedAt: "2026-05-02T00:00:00.000Z",
  };
  const mocked = createVscodeMock({
    legacyConfigurationSyncedStorage: true,
    syncedStorage: {
      version: 1,
      accounts: {
        legacy: legacyAccount,
      },
      providers: {
        "legacy-proxy": legacyProvider,
      },
      devices: [],
      autoRefreshDeviceName: null,
    },
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {},
        accountNames: ["legacy"],
        providers: {},
        providerNames: ["legacy-proxy"],
        devices: [],
        autoRefreshDeviceName: null,
      },
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("legacy")).entryVersion, 4);
      assert.equal(mocked.globalStateValues.get(getSyncedCloudAccountKey("legacy")).email, "legacy@example.com");
      assert.equal(mocked.globalStateValues.get(getSyncedCloudProviderKey("legacy-proxy")).entryVersion, 5);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames, ["legacy"]);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["legacy-proxy"]);

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
    })
  );
});

test("activate does not overwrite existing per-entry keys with aggregate legacy payloads", async () => {
  const staleAccount = makeAuthFile("acct-stale", { email: "stale@example.com" });
  const freshAccount = makeAuthFile("acct-fresh", { email: "fresh@example.com" });
  const staleProvider = {
    kind: "provider",
    name: "proxy",
    auth: { OPENAI_API_KEY: "sk-stale" },
    config: {
      name: "proxy",
      base_url: "https://stale.example.com/v1",
      wire_api: "responses",
    },
  };
  const freshProvider = {
    ...staleProvider,
    auth: { OPENAI_API_KEY: "sk-fresh" },
    config: {
      ...staleProvider.config,
      base_url: "https://fresh.example.com/v1",
    },
  };
  const mocked = createVscodeMock({
    globalStateValues: {
      [SYNCED_CLOUD_STATE_KEY]: {
        version: 1,
        accounts: {
          sync: staleAccount,
        },
        accountNames: ["sync"],
        providers: {
          proxy: staleProvider,
        },
        providerNames: ["proxy"],
        devices: [],
        autoRefreshDeviceName: null,
      },
      [getSyncedCloudAccountKey("sync")]: freshAccount,
      [getSyncedCloudProviderKey("proxy")]: freshProvider,
    },
  });

  await withDisabledIntervals(() =>
    withSuccessfulHttps(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudAccountKey("sync")), {
        ...freshAccount,
        email: "fresh@example.com",
      });
      assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudProviderKey("proxy")), freshProvider);
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
      assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providers, {});

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
      await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
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

test("locked cloud account uses public email from the account entry", async () => {
  try {
    core.setSavedAuthPassphrase("public-email-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-public", {
      email: "public@example.com",
    }), {
      requireEncryption: true,
    });
    cloudEntry.email = "public@example.com";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
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
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");
        const emailItem = getAccountDetailItems(accountTreeView.treeDataProvider, cloudItem)
          .find((item) => item.label === "Email");

        assert.equal(cloudItem.account.storageState, "locked");
        assert.equal(cloudItem.account.publicEmail, "public@example.com");
        assert.equal(emailItem?.description, "public@example.com");
        assert.match(cloudItem.tooltip, /Email: public@example\.com/);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
  }
});

test("unlocked legacy cloud account backfills public email without changing sync metadata", async () => {
  try {
    core.setSavedAuthPassphrase("backfill-email-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-backfill", {
      email: "backfill@example.com",
    }), {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 7;
    cloudEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "backfill-email-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const storedEntry = mocked.globalStateValues.get(getSyncedCloudAccountKey("sync-user"));
        assert.equal(storedEntry.email, "backfill@example.com");
        assert.equal(storedEntry.entryVersion, 7);
        assert.equal(storedEntry.updatedAt, "2026-05-01T00:00:00.000Z");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );
  } finally {
    core.setSavedAuthPassphrase(null);
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
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
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
      infoResponses: [
        () => {
          writeLastTerminalAuth(mocked, makeAuthFile("acct-cloud"));
          return "Done";
        },
        "Later",
      ],
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
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);

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
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
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
    const siblingEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-sibling", {
        accessToken: "access-sibling-old",
        refreshToken: "refresh-sibling-old",
      }),
      {
        requireEncryption: true,
      }
    );
    siblingEntry.entryVersion = 5;
    siblingEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": syncedEntry,
          sibling: siblingEntry,
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
        const nextSibling = getCloudEnvelope(mocked.config, "account", "sibling");
        assert.equal(nextSibling.entryVersion, 5);
        assert.equal(nextSibling.updatedAt, "2026-04-02T00:00:00.000Z");
        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sync-user"))?.ciphertext, "string");
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sibling"))?.ciphertext, "string");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("syncing stale active cloud auth does not overwrite newer cloud auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-auth-newer-wins-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR = authDir;

  try {
    const staleAuthTime = "2026-06-01T09:00:00.000Z";
    const freshAuthTime = "2026-06-01T10:00:00.000Z";
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-apple1", {
        accessToken: "access-apple-stale",
        refreshToken: "refresh-apple-stale",
        extraFields: {
          [AUTH_UPDATED_AT_FIELD]: staleAuthTime,
        },
      }), null, 2),
      "utf-8"
    );
    core.writeSavedAuthFile(path.join(authDir, "auth_local.json"), makeAuthFile("acct-local"));

    core.setSavedAuthPassphrase("newer-wins-passphrase");
    const freshCloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-apple1", {
        accessToken: "access-apple-fresh",
        refreshToken: "refresh-apple-fresh",
        extraFields: {
          [AUTH_UPDATED_AT_FIELD]: freshAuthTime,
        },
      }),
      {
        requireEncryption: true,
      }
    );
    freshCloudEntry.entryVersion = 2;
    freshCloudEntry.updatedAt = freshAuthTime;
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {
          apple1: freshCloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "account",
          name: "apple1",
          source: "cloud",
          entryVersion: 1,
          updatedAt: staleAuthTime,
        },
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "newer-wins-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(localItem);

        const cloudAuth = readCloudAccount(mocked.config, "apple1", "newer-wins-passphrase");
        assert.equal(cloudAuth.tokens.access_token, "access-apple-fresh");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-apple-fresh");
        assert.equal(cloudAuth[AUTH_UPDATED_AT_FIELD], freshAuthTime);

        const cloudEntry = getCloudEnvelope(mocked.config, "account", "apple1");
        assert.equal(cloudEntry.entryVersion, 2);
        assert.equal(cloudEntry.updatedAt, freshAuthTime);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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


test("aggregate globalState cloud accounts materialize before single-account refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-aggregate-materialize-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("aggregate-passphrase");
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
    const siblingEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-sibling", {
        accessToken: "access-sibling-old",
        refreshToken: "refresh-sibling-old",
      }),
      {
        requireEncryption: true,
      }
    );
    siblingEntry.entryVersion = 5;
    siblingEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      globalStateValues: {
        [SYNCED_CLOUD_STATE_KEY]: {
          version: 1,
          accounts: {
            "sync-user": syncedEntry,
            sibling: siblingEntry,
          },
          accountNames: ["sibling", "sync-user"],
          providers: {},
          devices: [],
          autoRefreshDeviceName: null,
        },
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "aggregate-passphrase",
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

        const nextSibling = getCloudEnvelope(mocked.config, "account", "sibling");
        assert.equal(nextSibling.entryVersion, 5);
        assert.equal(nextSibling.updatedAt, "2026-04-02T00:00:00.000Z");

        const siblingAuth = readCloudAccount(mocked.config, "sibling", "aggregate-passphrase");
        assert.equal(siblingAuth.tokens.access_token, "access-sibling-old");
        assert.equal(siblingAuth.tokens.refresh_token, "refresh-sibling-old");

        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accounts, {});
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sync-user"))?.ciphertext, "string");
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("sibling"))?.ciphertext, "string");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Source:/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Current device:/);
          assert.doesNotMatch(String(cloudItem.tooltip ?? ""), /Auto-refresh/);
          assert.equal(details.some((item) => item.label === "Source"), false);
          assert.equal(details.some((item) => item.label === "Current device"), false);
          assert.equal(details.some((item) => item.label.startsWith("Auto-refresh")), false);
          assert.equal(details.some((item) => item.label === "Sync version"), true);
          assert.equal(details.some((item) => item.label === "Updated"), true);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);

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
      await waitForRefreshCoordinatorIdle(context);

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
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")();
        await waitForRefreshCoordinatorIdle(context);

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
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

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
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });
    const requestLog = [];

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

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
    const stableAccessAlpha = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600,
    });
    const stableAccessBeta = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600,
    });
    const stableAccessGamma = makeJwt({
      exp: Math.floor(Date.now() / 1000) + 10 * 24 * 3600,
    });
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(
      path.join(authDir, "auth_alpha.json"),
      makeAuthFile("acct-alpha", { accessToken: stableAccessAlpha })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_beta.json"),
      makeAuthFile("acct-beta", { accessToken: stableAccessBeta })
    );
    core.writeSavedAuthFile(
      path.join(authDir, "auth_gamma.json"),
      makeAuthFile("acct-gamma", { accessToken: stableAccessGamma })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-beta", { accessToken: stableAccessBeta }), null, 2),
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
      await waitForRefreshCoordinatorIdle(context);

      const usageRequests = requestLog.filter((request) => request.hostname === "chatgpt.com");
      assert.equal(intervalHandles.length, 1);
      assert.equal(intervalHandles[0].ms, 30000);
      assert.equal(usageRequests.length, 1);
      assert.equal(usageRequests[0].authorization, `Bearer ${stableAccessBeta}`);

      await mocked.vscode.workspace
        .getConfiguration("codex-account-switch")
        .update("quotaRefreshInterval", 5);

      assert.equal(clearedIntervals.length >= 1, true);
      assert.equal(clearedIntervals[0], intervalHandles[0]);
      assert.equal(intervalHandles.length, 2);
      assert.equal(intervalHandles[1].ms, 5000);

      await mocked.vscode.workspace
        .getConfiguration("codex-account-switch")
        .update("quotaRefreshInterval", 1);

      assert.equal(clearedIntervals.length >= 2, true);
      assert.equal(clearedIntervals[1], intervalHandles[1]);
      assert.equal(intervalHandles.length, 3);
      assert.equal(intervalHandles[2].ms, 5000);

      intervalHandles[2].callback();
      await waitForRefreshCoordinatorIdle(context);

      assert.equal(countUsageRequests(requestLog), 2);
      assert.equal(
        requestLog.filter((request) => request.hostname === "chatgpt.com")[1]?.authorization,
        `Bearer ${stableAccessGamma}`
      );

      intervalHandles[2].callback();
      await waitForRefreshCoordinatorIdle(context);

      assert.equal(countUsageRequests(requestLog), 3);
      assert.equal(
        requestLog.filter((request) => request.hostname === "chatgpt.com")[2]?.authorization,
        `Bearer ${stableAccessAlpha}`
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
        await waitForRefreshCoordinatorIdle(context);

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
        await waitForRefreshCoordinatorIdle(context);

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
        assert.equal(cacheItem.iconPath?.id, "pass-filled");
        assert.equal(cacheItem.iconPath?.color?.id, "editorWarning.foreground");
        const cacheDetails = getAccountDetailItems(accountTreeView.treeDataProvider, cacheItem);
        const freshnessItem = cacheDetails.find((item) => item.label === "Quota freshness");
        assert.equal(freshnessItem?.description, "Cached");
        assert.equal(freshnessItem?.iconPath?.color?.id, "editorWarning.foreground");

        await waitForRefreshCoordinatorIdle(context);
        assert.equal(countUsageRequests(secondRequestLog), 0);
        const cachedQuotaLogEvents = secondWindow.createdChannels
          .flatMap((channel) => channel.entries)
          .filter((entry) =>
            /hydrate-quota-state-from-cache|use-fresh-cache|reuse-stale-cache-while-locked|use-cache-after-wait|fallback-to-cache-after/.test(entry.line)
          );
        assert.ok(cachedQuotaLogEvents.some((entry) => entry.level === "warn" && /cache-user/.test(entry.line)));
        assert.equal(cachedQuotaLogEvents.filter((entry) => entry.level !== "warn").length, 0);

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

test("current account uses yellow icon when quota refresh falls back to cache", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-quota-cache-fallback-"));
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
      path.join(authDir, "auth_apple1.json"),
      makeAuthFile("acct-apple1", { accessToken: "access-apple1" })
    );
    core.setNamedAuthDir(undefined);
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-apple1", { accessToken: "access-apple1" }), null, 2),
      "utf-8",
    );

    const firstWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: false,
      cloudTokenAutoUpdate: false,
    });
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(firstWindow.vscode);
        const context = createExtensionContext(firstWindow);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
      })
    );

    const secondWindow = createVscodeMock({
      authDirectory: authDir,
      showStatusBar: false,
      cloudTokenAutoUpdate: false,
    });
    await withDisabledIntervals(() =>
      withQuotaRejectedHttps(async () => {
        const extension = loadExtensionWithMockedVscode(secondWindow.vscode);
        const context = createExtensionContext(secondWindow);
        await extension.activate(context);

        const accountTreeView = secondWindow.treeViews.get("codexAccountSwitchAccounts");
        const provider = accountTreeView.treeDataProvider;
        await provider.refreshQuota(["local:apple1"], { reason: "manual", concurrency: 1 });
        const appleItem = getAccountTreeItems(provider)
          .find((item) => item.account.name === "apple1");
        assert.ok(appleItem);
        assert.match(String(appleItem.description ?? ""), /Quota 90%/);
        assert.equal(appleItem.iconPath?.id, "pass-filled");
        assert.equal(appleItem.iconPath?.color?.id, "editorWarning.foreground");
        assert.match(String(appleItem.tooltip ?? ""), /Showing cached data/);
        assert.match(String(appleItem.tooltip ?? ""), /HTTP 401/);

        const details = getAccountDetailItems(provider, appleItem);
        const freshnessItem = details.find((item) => item.label === "Quota freshness");
        assert.equal(freshnessItem?.description, "Cached (HTTP 401)");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
      detailedPerformanceLogging: true,
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
        await waitForRefreshCoordinatorIdle(context);

        requestLog.length = 0;
        await mocked.registeredCommands.get("codex-account-switch.switchProvider")();
        await waitForRefreshCoordinatorIdle(context);

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

test("creating a provider keeps each input box open across focus changes", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-input-focus-"));
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
      quickPickResponses: [
        (items) => items.find((item) => item.action === "create" && item.source === "local"),
      ],
      inputBoxResponses: [
        "my-proxy",
        "sk-test-provider",
        "https://proxy.example.com/v1",
        "responses",
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);

      await mocked.registeredCommands.get("codex-account-switch.switchMode")();

      assert.equal(mocked.inputBoxCalls.length, 4);
      assert.deepEqual(
        mocked.inputBoxCalls.map((options) => options?.ignoreFocusOut),
        [true, true, true, true],
      );

      core.setNamedAuthDir(authDir);
      const providerResult = core.readProviderProfileResult("my-proxy");
      core.setNamedAuthDir(undefined);
      assert.equal(providerResult.status, "ok");
      assert.equal(providerResult.value.config.base_url, "https://proxy.example.com/v1");
      assert.equal(providerResult.value.config.wire_api, "responses");
      assert.equal(providerResult.value.auth.OPENAI_API_KEY, "sk-test-provider");

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
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
      detailedPerformanceLogging: true,
      cloudTokenAutoUpdate: false,
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        mocked.createdChannels.forEach((channel) => {
          channel.entries.length = 0;
        });

        await mocked.registeredCommands.get("codex-account-switch.refreshQuota")();
        await waitForRefreshCoordinatorIdle(context);

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

test("account tree keeps quota failures inside their source group", async (t) => {
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
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-local-fail"), null, 2),
      "utf-8"
    );

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
          "Local Accounts",
          "Cloud Accounts",
        ]);
        assert.deepEqual(
          provider.getChildren(groups[0]).map((item) => item.account.name).sort(),
          ["local-fail", "local-ok"]
        );
        const failedLocalItem = provider.getChildren(groups[0]).find((item) => item.account.name === "local-fail");
        assert.equal(failedLocalItem?.iconPath?.id, "pass-filled");
        assert.equal(failedLocalItem?.iconPath?.color?.id, "errorForeground");
        assert.deepEqual(provider.getChildren(groups[1]).map((item) => item.account.name), ["cloud-ok"]);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("account tree shows relogin required only after manual token refresh fails", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-tree-relogin-required-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("relogin-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-google1"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          google1: cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "relogin-passphrase",
      },
      cloudTokenAutoUpdate: true,
    });

    await withDisabledIntervals(() =>
      withRefreshTokenReusedHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const provider = accountTreeView.treeDataProvider;
        await provider.refreshQuota(["cloud:google1"], {
          reason: "timer",
          concurrency: 1,
        });

        const [googleItem] = getAccountTreeItems(provider)
          .filter((item) => item.account.name === "google1" && item.account.source === "cloud");
        assert.doesNotMatch(String(googleItem.description ?? ""), /Relogin required/);

        provider.quotaState.delete("cloud:google1");
        provider.refresh();
        const [resetGoogleItem] = getAccountTreeItems(provider)
          .filter((item) => item.account.name === "google1" && item.account.source === "cloud");
        assert.doesNotMatch(String(resetGoogleItem.description ?? ""), /Relogin required/);

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")(resetGoogleItem);
        const [manualGoogleItem] = getAccountTreeItems(provider)
          .filter((item) => item.account.name === "google1" && item.account.source === "cloud");
        assert.match(String(manualGoogleItem.description ?? ""), /Relogin required/);
        assert.match(String(manualGoogleItem.tooltip ?? ""), /Re-login this account/);

        const details = getAccountDetailItems(provider, manualGoogleItem);
        const authDetail = details.find((item) => item.label === "Auth");
        assert.equal(authDetail?.description, "Relogin required");
        assert.match(String(authDetail?.tooltip ?? ""), /Refresh token cannot be recovered automatically/);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("account tree resolves stale source group children from latest root state", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-tree-stale-source-group-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("stale-group-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-cloud-fail"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "cloud-fail": cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "stale-group-passphrase",
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
        provider.quotaState.set("cloud:cloud-fail", {
          info: null,
          loading: false,
          error: true,
          updatedAt: null,
        });
        provider.refresh();

        const firstGroups = getAccountTreeRootItems(provider);
        const staleCloudGroup = firstGroups[0];
        assert.equal(staleCloudGroup.label, "Cloud Accounts");
        assert.deepEqual(provider.getChildren(staleCloudGroup).map((item) => item.account.name), ["cloud-fail"]);

        provider.quotaState.set("cloud:cloud-fail", {
          info: {
            plan: "plus",
            primaryWindow: {
              usedPercent: 10,
              resetsAt: null,
              windowSeconds: 18000,
            },
            secondaryWindow: null,
            additional: [],
            codeReview: null,
            credits: null,
            email: "acct-cloud-fail@example.com",
            tokenExpired: false,
            unavailableReason: null,
          },
          loading: false,
          error: false,
          updatedAt: Date.now(),
        });
        provider.refresh();

        const secondGroups = getAccountTreeRootItems(provider);
        assert.deepEqual(secondGroups.map((item) => item.label), ["Cloud Accounts"]);
        assert.deepEqual(provider.getChildren(secondGroups[0]).map((item) => item.account.name), ["cloud-fail"]);
        assert.deepEqual(provider.getChildren(staleCloudGroup).map((item) => item.account.name), ["cloud-fail"]);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
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

test("versioned cloud account snapshots recreate missing synced payloads on refresh", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-account-missing-recreate-"));
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

        assert.equal(mocked.config.syncedStorage.accounts.stale.entryVersion, 2);
        assert.equal(mocked.config.syncedStorage.accounts.stale.email, "restored@example.com");
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson"),
          false
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
        bumpedEntry.lastWriterAction = "save_provider_profile";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.providers.proxy = bumpedEntry;

        await mocked.registeredCommands.get("codex-account-switch.moveProviderToLocal")(providerItem);

        assert.equal(fs.existsSync(path.join(authDir, "provider_proxy.json")), false);
        assert.equal(mocked.config.syncedStorage.providers.proxy.entryVersion, 2);
        assert.equal(mocked.errorMessages.length, 0);
        assert.match(mocked.warningMessages[0]?.message ?? "", /conflict/i);
        assert.match(mocked.warningMessages[0]?.message ?? "", /current version 2/i);
        assert.match(mocked.warningMessages[0]?.message ?? "", /last writer action save_provider_profile/i);
        assert.ok(
          mocked.executedCommands.some((command) => command.name === "workbench.action.openSettingsJson")
        );

        const savedProvider = readCloudProvider(mocked.config, "proxy", "provider-conflict-passphrase");
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-new");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
  const currentDeviceName = "device-current";
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
        devices: [currentDeviceName],
        autoRefreshDeviceName: currentDeviceName,
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
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
          await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
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

test("moving one local provider to cloud does not rewrite sibling cloud provider key", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-per-entry-write-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const localProfile = {
      kind: "provider",
      name: "local-proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "local-proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    };
    const siblingProfile = {
      kind: "provider",
      name: "sibling",
      auth: { OPENAI_API_KEY: "sk-sibling" },
      config: {
        name: "sibling",
        base_url: "https://sibling.example.com/v1",
        wire_api: "responses",
      },
    };

    core.setNamedAuthDir(authDir);
    core.writeProviderProfile(localProfile);
    core.setNamedAuthDir(undefined);

    core.setSavedAuthPassphrase("provider-entry-passphrase");
    const siblingEntry = core.serializeSavedValue("saved_provider", siblingProfile, {
      requireEncryption: true,
    });
    siblingEntry.entryVersion = 3;
    siblingEntry.updatedAt = "2026-04-03T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          sibling: siblingEntry,
        },
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-entry-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = mocked.treeViews.get("codexAccountSwitchProviders");
        const [localItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === "local-proxy" && item.provider.source === "local");
        const siblingBefore = JSON.parse(JSON.stringify(mocked.globalStateValues.get(getSyncedCloudProviderKey("sibling"))));

        await mocked.registeredCommands.get("codex-account-switch.moveProviderToCloud")(localItem);

        assert.deepEqual(mocked.globalStateValues.get(getSyncedCloudProviderKey("sibling")), siblingBefore);
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudProviderKey("local-proxy"))?.ciphertext, "string");
        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providers, {});
        assert.deepEqual(mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).providerNames, ["local-proxy", "sibling"]);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("addProvider saves a new local provider without switching mode", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-add-provider-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify(makeAuthFile("acct-active"), null, 2),
    "utf-8",
  );

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: [
        "proxy",
        "sk-proxy",
        "https://proxy.example.com/v1",
        "responses",
      ],
    });

    await withDisabledIntervals(async () => {
      const extension = loadExtensionWithMockedVscode(mocked.vscode);
      const context = createExtensionContext(mocked);
      await extension.activate(context);
      await waitForRefreshCoordinatorIdle(context);

      await mocked.registeredCommands.get("codex-account-switch.addProvider")();
      await waitForRefreshCoordinatorIdle(context);

      core.setNamedAuthDir(authDir);
      const savedProvider = core.readProviderProfile("proxy");

      assert.deepEqual(savedProvider, {
        kind: "provider",
        name: "proxy",
        auth: {
          OPENAI_API_KEY: "sk-proxy",
        },
        config: {
          name: "proxy",
          base_url: "https://proxy.example.com/v1",
          wire_api: "responses",
        },
      });
      assert.equal(core.getActiveModelProvider(), null);

      const providerTreeView = mocked.treeViews.get("codexAccountSwitchProviders");
      const providerItems = providerTreeView.treeDataProvider.getChildren();
      assert.equal(providerItems.some((item) => item.provider?.name === "proxy"), true);
      core.setNamedAuthDir(undefined);
      assert.equal(
        mocked.informationMessages.some((entry) =>
          entry.message.includes('Created provider profile for "proxy" in local storage.')
        ),
        true,
      );

      for (const subscription of context.subscriptions.reverse()) {
        subscription?.dispose?.();
      }
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
  }

  await t.test("cleanup", () => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

test("manual token refresh marks invalidated refresh token as relogin required", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-tree-refresh-invalidated-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("invalidated-passphrase");
    const cloudEntry = core.serializeSavedValue("saved_auth", makeAuthFile("acct-microsoft1"), {
      requireEncryption: true,
    });
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          microsoft1: cloudEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "invalidated-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withRefreshTokenReusedHttps(
        async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const provider = accountTreeView.treeDataProvider;
          const [accountItem] = getAccountTreeItems(provider)
            .filter((item) => item.account.name === "microsoft1" && item.account.source === "cloud");

          await mocked.registeredCommands.get("codex-account-switch.refreshToken")(accountItem);

          const [manualItem] = getAccountTreeItems(provider)
            .filter((item) => item.account.name === "microsoft1" && item.account.source === "cloud");
          assert.match(String(manualItem.description ?? ""), /Relogin required/);
          assert.match(String(manualItem.tooltip ?? ""), /Re-login this account/);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        },
        {
          code: "refresh_token_invalidated",
          message: "Your refresh token has been invalidated. Please try signing in again.",
        },
      )
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

test("remove provider asks for confirmation before deleting a local provider", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-remove-local-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const providerPath = path.join(authDir, "provider_proxy.json");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      warningResponses: ["Remove"],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const providerTreeView = mocked.treeViews.get("codexAccountSwitchProviders");
        const [providerItem] = providerTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.provider.name === "proxy" && item.provider.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.removeProvider")(providerItem);

        assert.equal(fs.existsSync(providerPath), false);
        assert.equal(mocked.warningMessages.length, 1);
        assert.equal(
          mocked.warningMessages[0].message,
          'Remove provider "proxy" from local storage?'
        );
        assert.deepEqual(mocked.warningMessages[0].actions, ["Remove", "Cancel"]);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(mocked.informationMessages[0]?.message, '✓ Removed provider "proxy"');

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
    syncedEntry.lastWriterAction = "sync_current_provider_auth";
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
        const details = providerTreeView.treeDataProvider.getChildren(providerItem);

        assert.match(String(providerItem.tooltip ?? ""), /Sync version: 4/);
        assert.match(String(providerItem.tooltip ?? ""), /Updated: 2026-04-06T07:08:09.000Z/);
        assert.doesNotMatch(String(providerItem.tooltip ?? ""), /Last writer device/);
        assert.match(String(providerItem.tooltip ?? ""), /Last writer action: sync_current_provider_auth/);
        assert.equal(details.some((item) => item.label === "Last writer device"), false);
        assert.equal(
          details.some((item) => item.label === "Last writer action" && item.description === "sync_current_provider_auth"),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("moving a local provider to cloud records provider audit metadata", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-audit-move-cloud-"));
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
    core.writeProviderProfile({
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    });
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-audit-passphrase",
      },
    });

    await withMockedHostname("AuditDevice", async () =>
      withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const providerTreeView = mocked.treeViews.get("codexAccountSwitchProviders");
          const [providerItem] = providerTreeView.treeDataProvider
            .getChildren()
            .filter((item) => item.provider.name === "proxy" && item.provider.source === "local");

          await mocked.registeredCommands.get("codex-account-switch.moveProviderToCloud")(providerItem);

          const envelope = getCloudEnvelope(mocked.config, "provider", "proxy");
          assert.equal(envelope.entryVersion, 1);
          assert.equal("lastWriterDeviceName" in envelope, false);
          assert.equal(envelope.lastWriterAction, "move_provider_to_cloud");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        })
      )
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
        await waitForRefreshCoordinatorIdle(context);
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
  const currentDeviceName = "device-current";
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
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
        devices: [currentDeviceName],
        autoRefreshDeviceName: currentDeviceName,
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "work" && item.account.source === "local");

          await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);

          const backupPath = getProtectedCloudAccountBackupPath(mocked, "work");
          assert.equal(fs.existsSync(backupPath), true);
          const backup = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
          assert.equal(backup.name, "work");
          assert.equal(typeof backup.payload?.ciphertext, "string");
          assert.equal(JSON.stringify(backup).includes("access-token"), false);
          assert.equal(fs.existsSync(path.join(authDir, "auth_work.json")), false);
          assert.equal(typeof mocked.config.syncedStorage.accounts.work?.ciphertext, "string");

          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "work" && item.account.source === "cloud");

          await mocked.registeredCommands.get("codex-account-switch.moveAccountToLocal")(cloudItem);

          assert.equal(fs.existsSync(path.join(authDir, "auth_work.json")), true);
          assert.equal(mocked.config.syncedStorage.accounts.work, undefined);
          assert.equal(fs.existsSync(backupPath), false);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
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

test("renaming a cloud account moves its protected backup", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-rename-backup-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_work.json"), makeAuthFile("acct-work", {
      email: "work@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      inputBoxResponses: ["renamed-work"],
      secretValues: {
        [STORAGE_SECRET_KEY]: "rename-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
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

        const oldBackupPath = getProtectedCloudAccountBackupPath(mocked, "work");
        const newBackupPath = getProtectedCloudAccountBackupPath(mocked, "renamed-work");
        assert.equal(fs.existsSync(oldBackupPath), true);
        assert.equal(fs.existsSync(newBackupPath), false);

        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.renameAccount")(cloudItem);

        assert.equal(fs.existsSync(oldBackupPath), false);
        assert.equal(fs.existsSync(newBackupPath), true);
        const backup = JSON.parse(fs.readFileSync(newBackupPath, "utf-8"));
        assert.equal(backup.name, "renamed-work");
        assert.equal(typeof backup.payload?.ciphertext, "string");
        assert.equal(JSON.stringify(backup).includes("access-token"), false);
        assert.equal(mocked.globalStateValues.has(getSyncedCloudAccountKey("work")), false);
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("renamed-work"))?.ciphertext, "string");
        assert.deepEqual(
          mocked.globalStateValues.get(SYNCED_CLOUD_STATE_KEY).accountNames,
          ["renamed-work"]
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("moveAccountToCloud syncs the payload together with the cloud index for another device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-migration-cross-device-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_apple1.json"), makeAuthFile("acct-apple1", {
      email: "apple1@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const source = createVscodeMock({
      authDirectory: authDir,
      captureSyncedGlobalStateWrites: true,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cross-device-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(source.vscode);
        const context = createExtensionContext(source);
        await extension.activate(context);

        const accountTreeView = source.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "apple1" && item.account.source === "local");

        await source.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      })
    );

    const replicatedState = Object.fromEntries(source.syncedGlobalStateValues.entries());
    const target = createVscodeMock({
      globalStateValues: replicatedState,
      secretValues: {
        [STORAGE_SECRET_KEY]: "cross-device-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(target.vscode);
        const context = createExtensionContext(target);
        await extension.activate(context);

        const accountTreeView = target.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "apple1" && item.account.source === "cloud");

        assert.equal(cloudItem.account.storageState, "ready");
        assert.equal(cloudItem.account.meta.email, "apple1@example.com");
        assert.equal(cloudItem.account.meta.plan, "pro");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("restoreCloudAccountPayload restores an index-only cloud account from protected backup", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-payload-restore-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_bob1990.json"), makeAuthFile("acct-bob1990", {
      email: "bob1990@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "restore-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "bob1990" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_bob1990.json")), false);
        assert.equal(fs.existsSync(getProtectedCloudAccountBackupPath(mocked, "bob1990")), true);
        mocked.globalStateValues.delete(getSyncedCloudAccountKey("bob1990"));
        await mocked.registeredCommands.get("codex-account-switch.refreshList")();

        let [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "bob1990" && item.account.source === "cloud");

        assert.equal(cloudItem.account.storageState, "pending");
        assert.equal(cloudItem.account.recoveryAvailable, true);
        assert.equal(cloudItem.contextValue, "accountCloudRecoverable");
        assert.match(cloudItem.account.storageMessage, /protected local backup/i);

        await mocked.registeredCommands.get("codex-account-switch.restoreCloudAccountPayload")(cloudItem);

        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("bob1990"))?.ciphertext, "string");
        [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "bob1990" && item.account.source === "cloud");
        assert.equal(cloudItem.account.storageState, "ready");
        assert.equal(cloudItem.account.meta.email, "bob1990@example.com");
        assert.equal(cloudItem.account.meta.plan, "pro");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("moveAccountToCloud keeps local auth when cloud payload cannot be read back", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-migration-readback-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_apple1.json"), makeAuthFile("acct-apple1", {
      email: "apple1@example.com",
      plan: "pro",
    }));
    core.setNamedAuthDir(undefined);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "readback-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
      afterGlobalStateUpdate(key, value, state) {
        if (key === getSyncedCloudAccountKey("apple1") && value !== undefined) {
          state.globalStateValues.delete(key);
        }
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "apple1" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_apple1.json")), true);
        assert.equal(mocked.globalStateValues.has(getSyncedCloudAccountKey("apple1")), false);
        assert.match(mocked.errorMessages.at(-1).message, /could not be verified/i);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(cloudItem);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 1);
        assert.equal(countAuthRefreshRequests(requestLog), 0);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "work" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 0);

        requestLog.length = 0;
        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "hidden" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(cloudItem);
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countUsageRequests(requestLog), 1);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
  const currentDeviceName = "device-current";
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
      devices: [currentDeviceName],
      autoRefreshDeviceName: currentDeviceName,
    },
  });

  try {
    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "work" && item.account.source === "cloud");

          await mocked.registeredCommands.get("codex-account-switch.moveAccountToLocal")(cloudItem);
          await waitForRefreshCoordinatorIdle(context);

          assert.equal(countUsageRequests(requestLog), 1);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
        }, { requestLog })
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

test("switching away from a cloud account syncs the current auth back to cloud storage", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-manual-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

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
            accessToken: savedCloudAccessToken,
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
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-current");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-current");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("switching away from a cloud account ignores legacy device authority and updates cloud storage", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-switch-legacy-device-"));
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
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-saved",
        refreshToken: "refresh-cloud-saved",
      }),
      {
        requireEncryption: true,
      }
    );
    cloudEntry.entryVersion = 6;
    cloudEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": cloudEntry,
      },
      providers: {},
      devices: ["authorized-device"],
      autoRefreshDeviceName: "authorized-device",
    };
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-cloud", {
          accessToken: "access-cloud-current",
          refreshToken: "refresh-cloud-current",
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
          entryVersion: 6,
          updatedAt: "2026-05-01T00:00:00.000Z",
        },
      },
    });

    await withMockedHostname("legacy-other-device", async () => {
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
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-current");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-current");
          assert.equal(mocked.config.syncedStorage.accounts["sync-user"].entryVersion, 7);
          assert.notEqual(mocked.config.syncedStorage.accounts["sync-user"].updatedAt, "2026-05-01T00:00:00.000Z");

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
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

test("stale cloud provider marker self-heals before switching account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-marker-heal-account-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("provider-heal-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    const cloudProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-old" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    const cloudEntry = core.serializeSavedValue("saved_provider", cloudProvider, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-current-provider" }, null, 2),
      "utf-8",
    );
    core.activateProviderConfig("proxy", cloudProvider.config);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-heal-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: cloudEntry,
        },
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "provider",
          name: "proxy",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
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

        const savedProvider = readCloudProvider(mocked.config, "proxy", "provider-heal-passphrase");
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-current-provider");
        assert.equal(getCloudEnvelope(mocked.config, "provider", "proxy").entryVersion, 3);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) =>
            entry.message.includes('Detected newer synced cloud provider metadata for "proxy"')
            && entry.message.includes("from version 1 to 2")
          ),
          true,
        );
        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("reconcile-current-cloud-marker")
            && line.includes("\"kind\":\"provider\"")
            && line.includes("\"name\":\"proxy\"")
            && line.includes("\"previousEntryVersion\":1")
            && line.includes("\"currentEntryVersion\":2")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("stale cloud provider marker self-heals before switching to another provider", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-provider-marker-heal-provider-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("provider-heal-switch-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeProviderProfile({
      kind: "provider",
      name: "local-proxy",
      auth: { OPENAI_API_KEY: "sk-local" },
      config: {
        name: "local-proxy",
        base_url: "https://local.example.com/v1",
        wire_api: "responses",
      },
    });
    const cloudProvider = {
      kind: "provider",
      name: "proxy",
      auth: { OPENAI_API_KEY: "sk-cloud-old" },
      config: {
        name: "proxy",
        base_url: "https://proxy.example.com/v1",
        wire_api: "responses",
      },
    };
    const cloudEntry = core.serializeSavedValue("saved_provider", cloudProvider, {
      requireEncryption: true,
    });
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "sk-current-provider" }, null, 2),
      "utf-8",
    );
    core.activateProviderConfig("proxy", cloudProvider.config);

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "provider-heal-switch-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {
          proxy: cloudEntry,
        },
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "provider",
          name: "proxy",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
        },
      },
      quickPickResponses: [
        (items) => items.find((item) => item.provider?.name === "local-proxy"),
      ],
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        await mocked.registeredCommands.get("codex-account-switch.switchMode")();

        const savedProvider = readCloudProvider(mocked.config, "proxy", "provider-heal-switch-passphrase");
        assert.equal(savedProvider.auth.OPENAI_API_KEY, "sk-current-provider");
        assert.equal(getCloudEnvelope(mocked.config, "provider", "proxy").entryVersion, 3);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) =>
            entry.message.includes('Detected newer synced cloud provider metadata for "proxy"')
            && entry.message.includes("from version 1 to 2")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("stale cloud account marker self-heals before switching account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-marker-heal-account-switch-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("account-heal-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      {
        requireEncryption: true,
      },
    );
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
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
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "account-heal-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
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

        const cloudAuth = readCloudAccount(mocked.config, "sync-user", "account-heal-passphrase");
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-current");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-current");
        assert.equal(getCloudEnvelope(mocked.config, "account", "sync-user").entryVersion, 3);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) =>
            entry.message.includes('Detected newer synced cloud account metadata for "sync-user"')
            && entry.message.includes("from version 1 to 2")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("versioned cloud account marker recreates missing synced payload before switching account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-marker-recreate-missing-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
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
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "deleted-account-heal-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
          entryVersion: 1,
          updatedAt: "2026-04-01T00:00:00.000Z",
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

        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.config.syncedStorage.accounts["sync-user"].entryVersion, 2);
        assert.equal(
          mocked.informationMessages.some((entry) => entry.message.includes("Detected newer synced cloud account metadata")),
          false,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("current cloud marker does not prompt when already up to date", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-marker-no-heal-current-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("account-current-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_local-user.json"), makeAuthFile("acct-local"));
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      {
        requireEncryption: true,
      },
    );
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
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
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "account-current-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "account",
          name: "sync-user",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-04-02T00:00:00.000Z",
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

        assert.equal(mocked.warningMessages.length, 0);
        assert.equal(mocked.errorMessages.length, 0);
        assert.equal(
          mocked.informationMessages.some((entry) => entry.message.includes("Detected newer synced cloud account metadata")),
          false,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("stale cloud account marker does not overwrite a different current account", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-marker-identity-guard-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("account-marker-guard-passphrase");
    core.setNamedAuthDir(authDir);
    core.writeSavedAuthFile(path.join(authDir, "auth_current-user.json"), makeAuthFile("acct-current"));
    core.writeSavedAuthFile(path.join(authDir, "auth_target-user.json"), makeAuthFile("acct-target"));
    const cloudEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      {
        requireEncryption: true,
      },
    );
    cloudEntry.entryVersion = 2;
    cloudEntry.updatedAt = "2026-04-02T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(
        makeAuthFile("acct-current", {
          accessToken: "access-current",
          refreshToken: "refresh-current",
        }),
        null,
        2,
      ),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "account-marker-guard-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {
          "cloud-user": cloudEntry,
        },
        providers: {},
      },
      globalStateValues: {
        "codex-account-switch.currentSavedSelection": {
          kind: "account",
          name: "cloud-user",
          source: "cloud",
          entryVersion: 2,
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [targetItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "target-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.useAccount")(targetItem);

        const cloudAuth = readCloudAccount(mocked.config, "cloud-user", "account-marker-guard-passphrase");
        assert.equal(cloudAuth.tokens.account_id, "acct-cloud");
        assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
        assert.equal(getCloudEnvelope(mocked.config, "account", "cloud-user").entryVersion, 2);
        assert.deepEqual(mocked.globalStateValues.get("codex-account-switch.currentSavedSelection"), {
          kind: "account",
          name: "target-user",
          source: "local",
        });

        const lines = mocked.createdChannels.flatMap((channel) => channel.entries.map((entry) => entry.line));
        assert.equal(
          lines.some((line) =>
            line.includes("skip-cloud-account-sync-identity-mismatch")
            && line.includes("\"markerAccount\":\"cloud-user\"")
          ),
          true,
        );

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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

test("moving the current local account to cloud updates the current marker", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-account-move-current-marker-"));
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
    core.writeSavedAuthFile(path.join(authDir, "auth_moving-user.json"), makeAuthFile("acct-moving"));
    core.setNamedAuthDir(undefined);

    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify(makeAuthFile("acct-moving"), null, 2),
      "utf-8",
    );

    const mocked = createVscodeMock({
      authDirectory: authDir,
      secretValues: {
        [STORAGE_SECRET_KEY]: "move-current-passphrase",
      },
      syncedStorage: {
        version: 1,
        accounts: {},
        providers: {},
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [movingItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "moving-user" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(movingItem);

        const marker = mocked.globalStateValues.get("codex-account-switch.currentSavedSelection");
        assert.equal(marker.kind, "account");
        assert.equal(marker.name, "moving-user");
        assert.equal(marker.source, "cloud");
        assert.equal(marker.entryVersion, 1);
        assert.equal(typeof marker.updatedAt, "string");
        assert.equal(typeof mocked.globalStateValues.get(getSyncedCloudAccountKey("moving-user"))?.ciphertext, "string");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
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
        await waitForRefreshCoordinatorIdle(context);
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

test("manual cloud token refresh reloads newer synced tokens before consuming refresh token", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-manual-refresh-reload-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("refresh-reload-passphrase");
    const initialEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      { requireEncryption: true }
    );
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": initialEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "refresh-reload-passphrase",
      },
    });

    const authRequestBodies = [];
    const originalRequest = https.request;
    https.request = (requestOptions, handler) => {
      const hostname = requestOptions?.hostname;
      let requestBody = "";
      const responseBody =
        hostname === "auth.openai.com"
          ? JSON.stringify({
              access_token: "access-rotated",
              refresh_token: "refresh-rotated",
              id_token: makeJwt({
                email: "rotated@example.com",
                name: "rotated",
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
            setImmediate(() => listener(responseBody));
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
        write(chunk) {
          requestBody += String(chunk);
          return request;
        },
        end() {
          if (hostname === "auth.openai.com") {
            authRequestBodies.push(requestBody);
            if (requestBody.includes("refresh-cloud-old")) {
              response.statusCode = 401;
            }
          }
          handler(response);
        },
      };

      return request;
    };

    await withDisabledIntervals(async () => {
      try {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [staleCloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        core.setSavedAuthPassphrase("refresh-reload-passphrase");
        const newerEntry = core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: "access-cloud-newer",
            refreshToken: "refresh-cloud-newer",
          }),
          { requireEncryption: true }
        );
        newerEntry.entryVersion = 2;
        newerEntry.updatedAt = "2026-05-02T00:00:00.000Z";
        core.setSavedAuthPassphrase(null);
        mocked.config.syncedStorage.accounts["sync-user"] = newerEntry;

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")(staleCloudItem);

        assert.equal(authRequestBodies.length, 1);
        assert.match(authRequestBodies[0], /refresh_token=refresh-cloud-newer/);
        assert.doesNotMatch(authRequestBodies[0], /refresh-cloud-old/);

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "refresh-reload-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(getCloudEnvelope(mocked.config, "account", "sync-user").entryVersion, 3);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      } finally {
        https.request = originalRequest;
      }
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

test("manual cloud token refresh persists rotated tokens after metadata conflict with same refresh token", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-manual-refresh-conflict-retry-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("refresh-conflict-passphrase");
    const initialEntry = core.serializeSavedValue(
      "saved_auth",
      makeAuthFile("acct-cloud", {
        accessToken: "access-cloud-old",
        refreshToken: "refresh-cloud-old",
      }),
      { requireEncryption: true }
    );
    initialEntry.entryVersion = 1;
    initialEntry.updatedAt = "2026-05-01T00:00:00.000Z";
    core.setSavedAuthPassphrase(null);

    const mocked = createVscodeMock({
      syncedStorage: {
        version: 1,
        accounts: {
          "sync-user": initialEntry,
        },
        providers: {},
      },
      secretValues: {
        [STORAGE_SECRET_KEY]: "refresh-conflict-passphrase",
      },
    });

    let conflictInjected = false;
    const originalRequest = https.request;
    https.request = (requestOptions, handler) => {
      const hostname = requestOptions?.hostname;
      const responseBody =
        hostname === "auth.openai.com"
          ? JSON.stringify({
              access_token: "access-rotated",
              refresh_token: "refresh-rotated",
              id_token: makeJwt({
                email: "rotated@example.com",
                name: "rotated",
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
            setImmediate(() => listener(responseBody));
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
        write() {
          return request;
        },
        end() {
          if (hostname === "auth.openai.com" && !conflictInjected) {
            conflictInjected = true;
            core.setSavedAuthPassphrase("refresh-conflict-passphrase");
            const conflictedEntry = core.serializeSavedValue(
              "saved_auth",
              makeAuthFile("acct-cloud", {
                accessToken: "access-cloud-metadata-only",
                refreshToken: "refresh-cloud-old",
              }),
              { requireEncryption: true }
            );
            conflictedEntry.entryVersion = 2;
            conflictedEntry.updatedAt = "2026-05-02T00:00:00.000Z";
            core.setSavedAuthPassphrase(null);
            mocked.config.syncedStorage.accounts["sync-user"] = conflictedEntry;
          }
          handler(response);
        },
      };

      return request;
    };

    await withDisabledIntervals(async () => {
      try {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await mocked.registeredCommands.get("codex-account-switch.refreshToken")(cloudItem);

        assert.equal(conflictInjected, true);
        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "refresh-conflict-passphrase"
        );
        assert.equal(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");
        assert.equal(getCloudEnvelope(mocked.config, "account", "sync-user").entryVersion, 3);
        assert.equal(mocked.warningMessages.some((message) => /conflict/i.test(message.message ?? "")), false);

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
        await waitForRefreshCoordinatorIdle(context);
      } finally {
        https.request = originalRequest;
      }
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

test("timer maintenance refreshes local tokens when remaining validity is below 120 hours", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-local-token-maintenance-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: nearExpiryAccessToken,
    refreshToken: "refresh-local-old",
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
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const refreshCoordinator = getRefreshCoordinator(context);
        assert.ok(refreshCoordinator);

        refreshCoordinator.scheduleQuotaRefresh({
          reason: "timer",
        });
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countAuthRefreshRequests(requestLog), 1);

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

test("timer maintenance skips token refresh when token auto update is disabled", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-token-maintenance-disabled-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: nearExpiryAccessToken,
    refreshToken: "refresh-local-old",
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
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const refreshCoordinator = getRefreshCoordinator(context);
        assert.ok(refreshCoordinator);

        refreshCoordinator.scheduleQuotaRefresh({
          reason: "timer",
        });
        await waitForRefreshCoordinatorIdle(context);

        assert.equal(countAuthRefreshRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(savedAuth.tokens.refresh_token, "refresh-local-old");
        assert.equal(currentAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(currentAuth.tokens.refresh_token, "refresh-local-old");

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

test("timer maintenance refreshes cloud tokens while ignoring legacy auto-refresh device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-token-maintenance-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;

  try {
    core.setSavedAuthPassphrase("maintenance-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
            refreshToken: "refresh-cloud-old",
          }),
          {
            requireEncryption: true,
          }
        ),
      },
      providers: {},
      devices: ["device-other", "device-current"],
      autoRefreshDeviceName: "device-current",
    };
    core.setSavedAuthPassphrase(null);

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "maintenance-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname("device-current", async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const refreshCoordinator = getRefreshCoordinator(context);
          assert.ok(refreshCoordinator);

          refreshCoordinator.scheduleQuotaRefresh({
            reason: "timer",
          });
          await waitForRefreshCoordinatorIdle(context);

          assert.equal(countAuthRefreshRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "maintenance-passphrase"
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

test("timer maintenance refreshes cloud tokens even when legacy auto-refresh device differs", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-token-maintenance-legacy-device-"));
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
    core.setSavedAuthPassphrase("maintenance-skip-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
            refreshToken: "refresh-cloud-old",
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

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "maintenance-skip-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const refreshCoordinator = getRefreshCoordinator(context);
          assert.ok(refreshCoordinator);

          refreshCoordinator.scheduleQuotaRefresh({
            reason: "timer",
          });
          await waitForRefreshCoordinatorIdle(context);

          assert.equal(countAuthRefreshRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "maintenance-skip-passphrase"
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

test("timer quota refresh leaves local tokens unchanged when the refresh token expires within five days", async (t) => {
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
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await accountTreeView.treeDataProvider.refreshQuota([localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-local-old");
        assert.equal(savedAuth.tokens.refresh_token, nearExpiryRefreshToken);
        assert.equal(currentAuth.tokens.access_token, "access-local-old");
        assert.equal(currentAuth.tokens.refresh_token, nearExpiryRefreshToken);

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

test("timer quota refresh leaves local tokens unchanged when the access token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-local-near-expiry-access-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const nearExpiryAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: nearExpiryAccessToken,
    refreshToken: "refresh-local-stable",
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
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await accountTreeView.treeDataProvider.refreshQuota([localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(savedAuth.tokens.refresh_token, "refresh-local-stable");
        assert.equal(currentAuth.tokens.access_token, nearExpiryAccessToken);
        assert.equal(currentAuth.tokens.refresh_token, "refresh-local-stable");

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

test("timer quota refresh leaves local tokens unchanged when the access token is expired", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-local-expired-access-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });

  const expiredAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) - 60,
  });
  const localAuth = makeAuthFile("acct-local", {
    accessToken: expiredAccessToken,
    refreshToken: "refresh-local-stable",
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
  });

  try {
    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await accountTreeView.treeDataProvider.refreshQuota([localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, expiredAccessToken);
        assert.equal(savedAuth.tokens.refresh_token, "refresh-local-stable");
        assert.equal(currentAuth.tokens.access_token, expiredAccessToken);
        assert.equal(currentAuth.tokens.refresh_token, "refresh-local-stable");

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

test("timer quota refresh keeps the local account unchanged", async (t) => {
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
        await waitForRefreshCoordinatorIdle(context);
        requestLog.length = 0;

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [localItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "local-user" && item.account.source === "local");

        await accountTreeView.treeDataProvider.refreshQuota([localItem.account.id], {
          reason: "timer",
        });

        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.equal(countUsageRequests(requestLog), 0);

        const savedAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth_local-user.json"), "utf-8"));
        const currentAuth = JSON.parse(fs.readFileSync(path.join(codexHome, "auth.json"), "utf-8"));
        assert.equal(savedAuth.tokens.access_token, "access-local-old");
        assert.equal(savedAuth.tokens.refresh_token, nearExpiryRefreshToken);
        assert.equal(currentAuth.tokens.access_token, "access-local-old");
        assert.equal(currentAuth.tokens.refresh_token, nearExpiryRefreshToken);

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

test("timer quota refresh leaves cloud tokens unchanged when the refresh token expires within five days", async (t) => {
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
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await accountTreeView.treeDataProvider.refreshQuota([cloudItem.account.id], {
            reason: "timer",
          });

          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.equal(countUsageRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "timer-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-cloud-old");
          assert.notEqual(cloudAuth.tokens.refresh_token, "refresh-rotated");

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

test("timer quota refresh leaves cloud tokens unchanged when the access token expires within five days", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-near-expiry-access-refresh-"));
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
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) + 4 * 24 * 3600,
            }),
            refreshToken: "refresh-cloud-stable",
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
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await accountTreeView.treeDataProvider.refreshQuota([cloudItem.account.id], {
            reason: "timer",
          });

          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.equal(countUsageRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "timer-passphrase"
          );
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-stable");

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

test("timer quota refresh leaves cloud tokens unchanged when the access token is expired", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-cloud-expired-access-refresh-"));
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
    core.setSavedAuthPassphrase("expired-access-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
            refreshToken: "refresh-cloud-stable",
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
        [STORAGE_SECRET_KEY]: "expired-access-passphrase",
      },
      showStatusBar: false,
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);
          requestLog.length = 0;

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await accountTreeView.treeDataProvider.refreshQuota([cloudItem.account.id], {
            reason: "timer",
          });

          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.equal(countUsageRequests(requestLog), 1);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "expired-access-passphrase"
          );
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-stable");

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

test("quota refresh does not refresh expired cloud access tokens", async (t) => {
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
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
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

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "auto-passphrase",
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await accountTreeView.treeDataProvider.refreshQuota([cloudItem.account.id], {
            reason: "timer",
          });

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "auto-passphrase"
          );
          assert.notEqual(countUsageRequests(requestLog), 0);
          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

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

test("quota refresh does not update cloud auth even when sync metadata already exists", async (t) => {
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
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
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

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "throttle-passphrase",
      },
    });

    await withDisabledIntervals(() =>
      withSuccessfulHttps(async () => {
        const extension = loadExtensionWithMockedVscode(mocked.vscode);
        const context = createExtensionContext(mocked);
        await extension.activate(context);
        await waitForRefreshCoordinatorIdle(context);

        const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
        const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
          .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

        await accountTreeView.treeDataProvider.refreshQuota([cloudItem.account.id], {
          reason: "timer",
        });

        const cloudAuth = readCloudAccount(
          mocked.config,
          "sync-user",
          "throttle-passphrase"
        );
        assert.notEqual(countUsageRequests(requestLog), 0);
        assert.equal(countAuthRefreshRequests(requestLog), 0);
        assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
        assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

        for (const subscription of context.subscriptions.reverse()) {
          subscription?.dispose?.();
        }
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

test("activate does not register devices when synced cloud state exists", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-no-device-register-"));
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
          await waitForRefreshCoordinatorIdle(context);

          assert.deepEqual(mocked.config.syncedStorage.devices, []);
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }

          const extensionAgain = loadExtensionWithMockedVscode(mocked.vscode);
          const contextAgain = createExtensionContext(mocked);
          await extensionAgain.activate(contextAgain);
          await waitForRefreshCoordinatorIdle(contextAgain);

          assert.deepEqual(mocked.config.syncedStorage.devices, []);

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
        await waitForRefreshCoordinatorIdle(context);

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

test("activate ignores legacy synced devices without mutating cloud auth", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-legacy-devices-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

  try {
    core.setSavedAuthPassphrase("default-first-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: savedCloudAccessToken,
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
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "default-first-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, savedCloudAccessToken);
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.deepEqual(mocked.config.syncedStorage.devices, []);

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

test("quota refresh preserves cloud auth while ignoring legacy selected device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-legacy-device-quota-"));
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
            accessToken: makeJwt({
              exp: Math.floor(Date.now() / 1000) - 60,
            }),
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

    const requestLog = [];
    const mocked = createVscodeMock({
      authDirectory: authDir,
      syncedStorage,
      secretValues: {
        [STORAGE_SECRET_KEY]: "explicit-select-passphrase",
      },
    });

    await withMockedHostname(currentDeviceName, async () => {
      await withDisabledIntervals(() =>
        withSuccessfulHttps(async () => {
          const extension = loadExtensionWithMockedVscode(mocked.vscode);
          const context = createExtensionContext(mocked);
          await extension.activate(context);
          await waitForRefreshCoordinatorIdle(context);

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          await accountTreeView.treeDataProvider.refreshQuota([cloudItem.account.id], {
            reason: "timer",
          });

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "explicit-select-passphrase"
          );
          assert.notEqual(countUsageRequests(requestLog), 0);
          assert.equal(countAuthRefreshRequests(requestLog), 0);
          assert.notEqual(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

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

test("manual cloud token refresh ignores legacy selected device", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-legacy-device-manual-refresh-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

  try {
    core.setSavedAuthPassphrase("manual-override-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: savedCloudAccessToken,
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
          await waitForRefreshCoordinatorIdle(context);

          let cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "manual-override-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, savedCloudAccessToken);
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");

          const accountTreeView = mocked.treeViews.get("codexAccountSwitchAccounts");
          const [cloudItem] = getAccountTreeItems(accountTreeView.treeDataProvider)
            .filter((item) => item.account.name === "sync-user" && item.account.source === "cloud");

          assert.equal(cloudItem.contextValue, "accountCloud");

          await mocked.registeredCommands.get("codex-account-switch.refreshToken")(cloudItem);

          cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "manual-override-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, "access-rotated");
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-rotated");
          assert.equal(mocked.warningMessages.length, 0);
          assert.equal(mocked.errorMessages.length, 0);

          for (const subscription of context.subscriptions.reverse()) {
            subscription?.dispose?.();
          }
          await waitForRefreshCoordinatorIdle(context);
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

test("legacy invalid selected auto-refresh device is ignored when quota refresh does not persist tokens", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-legacy-device-ignored-"));
  const codexHome = path.join(tempRoot, ".codex");
  const authDir = path.join(tempRoot, "saved-auth");
  const currentDeviceName = "device-current";
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(authDir, { recursive: true });

  const previousCodexHome = process.env.CODEX_HOME;
  const previousNamedAuthDir = process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  process.env.CODEX_HOME = codexHome;
  delete process.env.CODEX_ACCOUNT_SWITCH_AUTH_DIR;
  const savedCloudAccessToken = makeJwt({
    exp: Math.floor(Date.now() / 1000) + 24 * 3600,
  });

  try {
    core.setSavedAuthPassphrase("prompt-select-passphrase");
    const syncedStorage = {
      version: 1,
      accounts: {
        "sync-user": core.serializeSavedValue(
          "saved_auth",
          makeAuthFile("acct-cloud", {
            accessToken: savedCloudAccessToken,
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
          await waitForRefreshCoordinatorIdle(context);

          const cloudAuth = readCloudAccount(
            mocked.config,
            "sync-user",
            "prompt-select-passphrase"
          );
          assert.equal(cloudAuth.tokens.access_token, savedCloudAccessToken);
          assert.equal(cloudAuth.tokens.refresh_token, "refresh-cloud-old");
          assert.deepEqual(mocked.config.syncedStorage.devices, []);
          assert.equal(mocked.config.syncedStorage.autoRefreshDeviceName, null);

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

test("select auto-refresh device command is not registered", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cas-vscode-no-device-command-"));
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

        assert.equal(mocked.registeredCommands.has("codex-account-switch.selectAutoRefreshDevice"), false);

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
