const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
);

const commands = manifest.contributes.commands;

test("extension runs in the workspace extension host", () => {
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
});

test("extension commands use category for the shared prefix", () => {
  const extensionCommands = commands.filter((command) =>
    command.command.startsWith("codex-account-switch.")
  );

  assert.ok(extensionCommands.length > 0);

  for (const command of extensionCommands) {
    assert.equal(command.category, "Codex Account Switch");
    assert.match(command.title, /^(?!Codex Account Switch: ).+/);
  }
});

test("account item context actions keep concise titles", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-account-switch.reloginAccount")?.title,
    "Re-login Account"
  );
  assert.equal(
    byId.get("codex-account-switch.renameAccount")?.title,
    "Rename Account"
  );
  assert.equal(
    byId.get("codex-account-switch.removeAccount")?.title,
    "Remove Account"
  );
  assert.equal(
    byId.get("codex-account-switch.refreshToken")?.title,
    "Refresh Token"
  );
});

test("device auth login setting is opt-in", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-account-switch.useDeviceAuthForLogin"
    ];

  assert.equal(setting?.type, "boolean");
  assert.equal(setting?.default, false);
  assert.match(setting?.description ?? "", /device code authorization/i);
});

test("storage password commands are contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-account-switch.unlockStorage")?.title,
    "Unlock Storage"
  );
  assert.equal(
    byId.get("codex-account-switch.setStoragePassword")?.title,
    "Set Storage Password"
  );
  assert.equal(
    byId.get("codex-account-switch.changeStoragePassword")?.title,
    "Change Storage Password"
  );
  assert.equal(
    byId.get("codex-account-switch.forgetStoragePassword")?.title,
    "Forget Local Storage Password"
  );
});

test("storage target settings are contributed", () => {
  const properties = manifest.contributes.configuration.properties;

  assert.equal(
    properties["codex-account-switch.defaultSaveTarget"]?.default,
    "local"
  );
  assert.deepEqual(
    properties["codex-account-switch.defaultSaveTarget"]?.enum,
    ["local", "cloud"]
  );
  assert.equal(
    properties["codex-account-switch.syncedStorage"]?.type,
    "object"
  );
  assert.match(
    properties["codex-account-switch.defaultSaveTarget"]?.enumDescriptions?.[1] ?? "",
    /synced extension storage/i
  );
  assert.match(
    properties["codex-account-switch.syncedStorage"]?.markdownDeprecationMessage ?? "",
    /legacy migration-only setting/i
  );
  assert.equal(
    properties["codex-account-switch.detailedPerformanceLogging"]?.type,
    "boolean"
  );
  assert.equal(
    properties["codex-account-switch.detailedPerformanceLogging"]?.default,
    false
  );
  assert.match(
    properties["codex-account-switch.detailedPerformanceLogging"]?.description ?? "",
    /debug-only/i
  );
});

test("quota refresh setting defaults to 30 seconds for rotating background refresh", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-account-switch.quotaRefreshInterval"
    ];

  assert.equal(setting?.type, "number");
  assert.equal(setting?.default, 30);
  assert.equal(setting?.minimum, 5);
  assert.match(setting?.description ?? "", /background/i);
  assert.match(setting?.description ?? "", /one saved account/i);
  assert.match(setting?.description ?? "", /rotation/i);
});

test("token auto update setting defaults to enabled", () => {
  const setting =
    manifest.contributes.configuration.properties[
      "codex-account-switch.tokenAutoUpdate"
    ];

  assert.equal(setting?.type, "boolean");
  assert.equal(setting?.default, true);
  assert.match(setting?.description ?? "", /automatically refresh saved account tokens/i);
  assert.match(setting?.description ?? "", /background timer/i);
});

test("auto-switch settings are contributed with conservative defaults", () => {
  const properties = manifest.contributes.configuration.properties;
  const enabledSetting = properties["codex-account-switch.autoSwitchOnZeroQuota"];
  const cooldownSetting = properties["codex-account-switch.autoSwitchCooldownSeconds"];

  assert.equal(enabledSetting?.type, "boolean");
  assert.equal(enabledSetting?.default, false);
  assert.match(enabledSetting?.description ?? "", /5-hour quota reaches 0%/i);

  assert.equal(cooldownSetting?.type, "number");
  assert.equal(cooldownSetting?.default, 90);
  assert.equal(cooldownSetting?.minimum, 15);
  assert.match(cooldownSetting?.description ?? "", /retrying automatic switching/i);
});

test("storage migration commands are contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-account-switch.moveAccountToCloud")?.title,
    "Move Account To Cloud"
  );
  assert.equal(
    byId.get("codex-account-switch.restoreCloudAccountPayload")?.title,
    "Restore Cloud Payload From Protected Backup"
  );
  assert.equal(
    byId.get("codex-account-switch.moveAccountToLocal")?.title,
    "Move Account To Local"
  );
  assert.equal(
    byId.get("codex-account-switch.moveProviderToCloud")?.title,
    "Move Provider To Cloud"
  );
  assert.equal(
    byId.get("codex-account-switch.moveProviderToLocal")?.title,
    "Move Provider To Local"
  );
  assert.equal(
    byId.get("codex-account-switch.removeProvider")?.title,
    "Remove Provider"
  );
  assert.equal(
    byId.get("codex-account-switch.enableAutoSwitch")?.title,
    "Enable Auto-Switch"
  );
  assert.equal(
    byId.get("codex-account-switch.disableAutoSwitch")?.title,
    "Disable Auto-Switch"
  );
  assert.equal(
    byId.get("codex-account-switch.configureAutoSwitch")?.title,
    "Auto-Switch Settings"
  );
});

test("account inline actions do not include remove", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const inlineAccountActions = contextMenus.filter(
    (item) =>
      item.when ===
        "view == codexAccountSwitchAccounts && (viewItem == accountLocal || viewItem == accountCloud)" &&
      typeof item.group === "string" &&
      item.group.startsWith("inline@")
  );

  assert.deepEqual(
    inlineAccountActions.map((item) => item.command).sort(),
    ["codex-account-switch.useAccount"]
  );
});

test("refreshable account item context menu exposes refresh actions", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const refreshAccountActions = contextMenus.filter((item) =>
    typeof item.when === "string"
    && item.when.includes("view == codexAccountSwitchAccounts")
    && item.when.includes("accountLocal")
    && item.when.includes("accountCloud")
    && typeof item.group === "string"
    && item.group.startsWith("refresh@")
  );

  assert.deepEqual(
    refreshAccountActions.map((item) => item.command).sort(),
    [
      "codex-account-switch.refreshList",
      "codex-account-switch.refreshQuota",
      "codex-account-switch.refreshToken",
    ]
  );
});

test("cloud account context menu exposes refresh token", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const refreshAccountActions = contextMenus.filter(
    (item) =>
      item.when ===
        "view == codexAccountSwitchAccounts && (viewItem == accountLocal || viewItem == accountCloud)" &&
      typeof item.group === "string" &&
      item.group.startsWith("refresh@")
  );

  assert.deepEqual(
    refreshAccountActions.map((item) => item.command).sort(),
    [
      "codex-account-switch.refreshList",
      "codex-account-switch.refreshQuota",
      "codex-account-switch.refreshToken",
    ]
  );
});

test("cloud account context menu exposes move account to local", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const moveAccountToLocal = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.moveAccountToLocal"
      && item.when === "view == codexAccountSwitchAccounts && viewItem == accountCloud"
  );

  assert.equal(moveAccountToLocal?.group, "context@4");
});

test("recoverable cloud account context menu exposes explicit restore", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const restore = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.restoreCloudAccountPayload"
      && item.when === "view == codexAccountSwitchAccounts && viewItem == accountCloudRecoverable"
  );
  const remove = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.removeAccount"
      && item.when ===
        "view == codexAccountSwitchAccounts && (viewItem == accountLocal || viewItem == accountCloud || viewItem == accountCloudRecoverable)"
  );

  assert.equal(restore?.group, "context@1");
  assert.equal(remove?.group, "context@3");
});

test("account group context menu exposes refresh quota for local and cloud groups", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const localGroupRefresh = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.refreshQuota"
      && item.when ===
        "view == codexAccountSwitchAccounts && viewItem == accountGroupLocal"
  );
  const cloudGroupRefresh = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.refreshQuota"
      && item.when ===
        "view == codexAccountSwitchAccounts && viewItem == accountGroupCloud"
  );

  assert.equal(localGroupRefresh?.group, "refresh@1");
  assert.equal(cloudGroupRefresh?.group, "refresh@1");
});

test("provider context menu exposes remove for local and cloud providers", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const removeProvider = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.removeProvider" &&
      item.when ===
        "view == codexAccountSwitchProviders && (viewItem == providerLocal || viewItem == providerCloud)"
  );

  assert.equal(removeProvider?.group, "context@3");
});

test("provider context menu exposes switch provider inline action", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const switchProvider = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.switchProvider" &&
      item.when ===
        "view == codexAccountSwitchProviders && (viewItem == providerLocal || viewItem == providerCloud)"
  );

  assert.equal(
    byId.get("codex-account-switch.switchProvider")?.title,
    "Switch Provider"
  );
  assert.equal(switchProvider?.group, "inline@1");
});

test("providers view title menu exposes add provider", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const addProvider = titleMenus.find(
    (item) =>
      item.command === "codex-account-switch.addProvider" &&
      item.when === "view == codexAccountSwitchProviders"
  );
  const providerWelcome = manifest.contributes.viewsWelcome.find(
    (item) => item.view === "codexAccountSwitchProviders"
  );

  assert.equal(
    byId.get("codex-account-switch.addProvider")?.title,
    "Add Provider"
  );
  assert.equal(addProvider?.group, "navigation@3");
  assert.equal(
    providerWelcome?.contents.includes("command:codex-account-switch.addProvider"),
    true
  );
});

test("accounts view title menu exposes a single refresh entrypoint", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const accountViewCommands = titleMenus
    .filter((item) => item.when === "view == codexAccountSwitchAccounts")
    .map((item) => item.command);

  const manualRefreshCommands = [
    "codex-account-switch.refresh",
    "codex-account-switch.refreshList",
    "codex-account-switch.refreshQuota",
    "codex-account-switch.refreshToken",
  ];
  const present = manualRefreshCommands.filter((command) =>
    accountViewCommands.includes(command)
  );

  assert.deepEqual(present, ["codex-account-switch.refresh"]);
});

test("accounts view title menu is ordered by semantic groups", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const accountTitleItems = titleMenus
    .filter((item) => item.when?.startsWith("view == codexAccountSwitchAccounts"))
    .sort((left, right) => {
      const leftOrder = Number(left.group?.match(/@(\d+)$/)?.[1] ?? 0);
      const rightOrder = Number(right.group?.match(/@(\d+)$/)?.[1] ?? 0);

      return leftOrder - rightOrder;
    });

  assert.deepEqual(
    accountTitleItems.map((item) => item.command),
    [
      "codex-account-switch.refresh",
      "codex-account-switch.expandAllAccounts",
      "codex-account-switch.addAccount",
      "codex-account-switch.importAccounts",
      "codex-account-switch.reloadWindow",
      "codex-account-switch.enableAutoSwitch",
      "codex-account-switch.disableAutoSwitch",
    ]
  );
  assert.deepEqual(
    accountTitleItems.map((item) => item.group),
    [
      "navigation@1",
      "navigation@2",
      "navigation@3",
      "navigation@4",
      "navigation@6",
      "navigation@8",
      "navigation@8",
    ]
  );
});

test("accounts view title menu hides switch mode and auto-switch settings", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const enabledItem = titleMenus.find(
    (item) =>
      item.command === "codex-account-switch.enableAutoSwitch" &&
      item.when ===
        "view == codexAccountSwitchAccounts && !codexAccountSwitch.autoSwitchEnabled"
  );
  const disabledItem = titleMenus.find(
    (item) =>
      item.command === "codex-account-switch.disableAutoSwitch" &&
      item.when ===
        "view == codexAccountSwitchAccounts && codexAccountSwitch.autoSwitchEnabled"
  );
  const settingsItem = titleMenus.find(
    (item) =>
      item.command === "codex-account-switch.configureAutoSwitch" &&
      item.when === "view == codexAccountSwitchAccounts"
  );
  const switchModeItem = titleMenus.find(
    (item) =>
      item.command === "codex-account-switch.switchMode" &&
      item.when === "view == codexAccountSwitchAccounts"
  );

  assert.equal(enabledItem?.group, "navigation@8");
  assert.equal(disabledItem?.group, "navigation@8");
  assert.equal(settingsItem, undefined);
  assert.equal(switchModeItem, undefined);
});

test("providers view hides switch mode title and welcome entrypoints", () => {
  const titleMenus = manifest.contributes.menus["view/title"] ?? [];
  const providerSwitchModeItem = titleMenus.find(
    (item) =>
      item.command === "codex-account-switch.switchMode" &&
      item.when === "view == codexAccountSwitchProviders"
  );
  const providerWelcome = manifest.contributes.viewsWelcome.find(
    (item) => item.view === "codexAccountSwitchProviders"
  );

  assert.equal(providerSwitchModeItem, undefined);
  assert.equal(providerWelcome?.contents.includes("Switch mode"), false);
});

test("locked cloud accounts expose unlock in the context menu", () => {
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];
  const unlockMenuItem = contextMenus.find(
    (item) =>
      item.command === "codex-account-switch.unlockStorage" &&
      item.when ===
        "view == codexAccountSwitchAccounts && viewItem == accountCloudLocked"
  );

  assert.equal(unlockMenuItem?.group, "context@1");
});

test("account email copy command is contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));
  const contextMenus = manifest.contributes.menus["view/item/context"] ?? [];

  assert.equal(
    byId.get("codex-account-switch.copyAccountField")?.title,
    "Copy Account Value"
  );
  assert.equal(
    contextMenus.find(
      (item) =>
        item.command === "codex-account-switch.copyAccountField" &&
        item.when ===
          "view == codexAccountSwitchAccounts && viewItem == accountCopyableField"
    )?.group,
    "context@1"
  );
});
