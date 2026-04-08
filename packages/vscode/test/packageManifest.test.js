const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
);

const commands = manifest.contributes.commands;

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
});

test("storage migration commands are contributed", () => {
  const byId = new Map(commands.map((command) => [command.command, command]));

  assert.equal(
    byId.get("codex-account-switch.moveAccountToCloud")?.title,
    "Move Account To Cloud"
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
});
