const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

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
  const inputBoxResponses = [...(options.inputBoxResponses ?? [])];
  const warningResponses = [...(options.warningResponses ?? [])];
  const infoResponses = [...(options.infoResponses ?? [])];
  const config = {
    authDirectory: options.authDirectory,
    reloadWindowAfterSwitch: "never",
    useDeviceAuthForLogin: options.useDeviceAuthForLogin ?? false,
    quotaRefreshInterval: 300,
    showStatusBar: false,
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
          get(key, defaultValue) {
            return config[key] ?? defaultValue;
          },
        };
      },
      onDidChangeConfiguration() {
        return createDisposable();
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
    const extension = loadExtensionWithMockedVscode(mocked.vscode);
    const context = { subscriptions: [] };
    extension.activate(context);

    await mocked.registeredCommands.get("codex-account-switch.addAccount")();

    for (const subscription of context.subscriptions.reverse()) {
      subscription?.dispose?.();
    }

    assert.deepEqual(mocked.sentTerminalCommands, ["codex login --device-auth"]);
    assert.match(
      mocked.warningMessages[0]?.message ?? "",
      /device auth/i
    );
    const savedAuthPath = path.join(authDir, "auth_device-user.json");
    assert.equal(fs.existsSync(savedAuthPath), true);
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
