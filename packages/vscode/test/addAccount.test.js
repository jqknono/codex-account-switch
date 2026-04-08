const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const core = require("@codex-account-switch/core");

const STORAGE_SECRET_KEY = "codex-account-switch.savedAuthPassphrase";

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.`;
}

function makeAuthFile(accountId) {
  return {
    tokens: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      account_id: accountId,
      id_token: makeJwt({
        email: `${accountId}@example.com`,
        name: accountId,
        "https://api.openai.com/auth": {
          chatgpt_plan_type: "plus",
        },
      }),
    },
  };
}

function createDisposable(fn = () => {}) {
  return {
    dispose: fn,
  };
}

function createVscodeMock(options) {
  const registeredCommands = new Map();
  const sentTerminalCommands = [];
  const warningMessages = [];
  const informationMessages = [];
  const errorMessages = [];
  const inputBoxResponses = [...(options.inputBoxResponses ?? [])];
  const warningResponses = [...(options.warningResponses ?? [])];
  const infoResponses = [...(options.infoResponses ?? [])];
  const quickPickResponses = [...(options.quickPickResponses ?? [])];
  const secretState = new Map(Object.entries(options.secretValues ?? {}));
  const configurationListeners = new Set();
  const treeViews = new Map();
  const globalStateValues = new Map(Object.entries(options.globalStateValues ?? {}));
  const config = {
    authDirectory: options.authDirectory,
    reloadWindowAfterSwitch: "never",
    useDeviceAuthForLogin: options.useDeviceAuthForLogin ?? false,
    quotaRefreshInterval: 300,
    showStatusBar: false,
    defaultSaveTarget: options.defaultSaveTarget ?? "local",
    syncedStorage: options.syncedStorage ?? { version: 1, accounts: {}, providers: {} },
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
      createOutputChannel() {
        return {
          appendLine() {},
          show() {},
          dispose() {},
        };
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
        return infoResponses.shift();
      },
      async showErrorMessage(message, ...actions) {
        errorMessages.push({ message, actions });
        return undefined;
      },
      async showQuickPick() {
        return quickPickResponses.shift();
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
        if (name === "workbench.action.reloadWindow") {
          return undefined;
        }
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
    sentTerminalCommands,
    warningMessages,
    informationMessages,
    errorMessages,
    treeViews,
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

async function withSuccessfulHttps(fn) {
  const originalRequest = https.request;
  https.request = (options, handler) => {
    const hostname = options?.hostname;
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

        assert.match(mocked.errorMessages.at(-1)?.message ?? "", /saved auth storage is locked/i);
        assert.equal(mocked.secretState.has(STORAGE_SECRET_KEY), false);

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
        const items = accountTreeView.treeDataProvider.getChildren();
        const matching = items.filter((item) => item.account.name === "work");

        assert.equal(matching.length, 2);
        assert.deepEqual(
          matching.map((item) => item.account.source).sort(),
          ["cloud", "local"]
        );
        for (const item of matching) {
          assert.match(item.description ?? "", /local|cloud/i);
          assert.match(String(item.tooltip ?? ""), /Source:/i);
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
        const [localItem] = accountTreeView.treeDataProvider
          .getChildren()
          .filter((item) => item.account.name === "work" && item.account.source === "local");

        await mocked.registeredCommands.get("codex-account-switch.moveAccountToCloud")(localItem);

        assert.equal(fs.existsSync(path.join(authDir, "auth_work.json")), false);
        assert.equal(typeof mocked.config.syncedStorage.accounts.work?.ciphertext, "string");

        const [cloudItem] = accountTreeView.treeDataProvider
          .getChildren()
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
