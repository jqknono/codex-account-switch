#!/usr/bin/env node

import { Command } from "commander";
import { setNamedAuthDir } from "@codex-account-switch/core";
import {
  cmdList,
  cmdAdd,
  cmdRemove,
  cmdUse,
  cmdQuota,
  cmdCurrent,
  cmdRefresh,
  cmdExport,
  cmdImport,
  cmdMode,
} from "./commands";

const program = new Command();

program
  .name("codex-account-switch")
  .description("Quickly switch between multiple Codex accounts")
  .version("1.0.1");

program
  .option("--auth-dir <path>", "Directory for saving and loading auth_{name}.json files; defaults to the Codex config directory");

program.hook("preAction", () => {
  const opts = program.opts<{ authDir?: string }>();
  setNamedAuthDir(opts.authDir);
});

program
  .command("list")
  .aliases(["ls"])
  .description("List all saved accounts")
  .action(() => cmdList());

program
  .command("add <name>")
  .description("Run codex login and save the account")
  .option("--device-auth", "Use codex login --device-auth. Requires enabling device code authorization in ChatGPT Security Settings.", false)
  .action(async (name: string, opts?: { deviceAuth?: boolean }) => cmdAdd(name, opts));

program
  .command("remove <name>")
  .aliases(["rm", "del"])
  .description("Remove a saved account")
  .action((name: string) => cmdRemove(name));

program
  .command("use <name>")
  .aliases(["switch"])
  .description("Switch to a saved account")
  .action((name: string) => cmdUse(name));

program
  .command("mode [name]")
  .description("Show or switch the active mode")
  .action(async (name?: string) => cmdMode(name));

program
  .command("quota [name]")
  .aliases(["info", "status"])
  .description("Show account quota usage")
  .action(async (name?: string) => cmdQuota(name));

program
  .command("current")
  .description("Show the current active account or mode")
  .action(() => cmdCurrent());

program
  .command("refresh [name]")
  .description("Refresh the account access token")
  .action(async (name?: string) => cmdRefresh(name));

program
  .command("export [file]")
  .description("Export accounts to a JSON file")
  .option("-n, --names <names...>", "Export only the specified accounts")
  .action((file?: string, opts?: { names?: string[] }) => cmdExport(file, opts?.names));

program
  .command("import <file>")
  .description("Import accounts from a JSON file")
  .option("--overwrite", "Overwrite existing accounts with the same name", false)
  .action(async (file: string, opts?: { overwrite?: boolean }) => cmdImport(file, opts?.overwrite));

program.parseAsync().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

