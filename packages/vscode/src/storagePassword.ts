import * as vscode from "vscode";
import { changeSavedAuthPassphrase, getSavedAuthPassphrase, hasEncryptedSavedFiles, setSavedAuthPassphrase } from "@codex-account-switch/core";

export const STORAGE_PASSWORD_SECRET_KEY = "codex-account-switch.savedAuthPassphrase";

async function promptForPassword(prompt: string, placeHolder: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt,
    placeHolder,
    password: true,
    validateInput: (value) => (value ? null : "Password is required"),
  });
}

export async function restoreSavedAuthPassphrase(
  context: vscode.ExtensionContext,
  options?: { promptIfMissing?: boolean; promptForLockedStorage?: boolean }
): Promise<boolean> {
  const stored = await context.secrets.get(STORAGE_PASSWORD_SECRET_KEY);
  if (stored) {
    setSavedAuthPassphrase(stored);
    return true;
  }

  setSavedAuthPassphrase(null);
  if (!options?.promptIfMissing || (!hasEncryptedSavedFiles() && !options.promptForLockedStorage)) {
    return false;
  }

  const entered = await promptForPassword(
    "Enter the local storage password to unlock saved accounts and providers",
    "Local storage password"
  );
  if (!entered) {
    vscode.window.showWarningMessage("Saved auth storage remains locked until you enter the local storage password.");
    return false;
  }

  await context.secrets.store(STORAGE_PASSWORD_SECRET_KEY, entered);
  setSavedAuthPassphrase(entered);
  return true;
}

export async function ensureSavedAuthPassphrase(context: vscode.ExtensionContext): Promise<boolean> {
  if (getSavedAuthPassphrase()) {
    return true;
  }

  const result = await promptAndStoreSavedAuthPassphrase(context, "set");
  return result.stored;
}

export async function promptAndStoreSavedAuthPassphrase(
  context: vscode.ExtensionContext,
  mode: "set" | "change"
): Promise<{ stored: boolean; rewritten: number; skipped: number }> {
  const next = await promptForPassword(
    mode === "set" ? "Set a local storage password for saved accounts and providers" : "Enter the new local storage password",
    "Local storage password"
  );
  if (!next) {
    return { stored: false, rewritten: 0, skipped: 0 };
  }

  const confirmation = await promptForPassword("Confirm the local storage password", "Confirm password");
  if (!confirmation) {
    return { stored: false, rewritten: 0, skipped: 0 };
  }

  if (next !== confirmation) {
    vscode.window.showErrorMessage("Storage passwords did not match.");
    return { stored: false, rewritten: 0, skipped: 0 };
  }

  const rewriteResult =
    mode === "change" ? changeSavedAuthPassphrase(next) : ({ rewritten: 0, skipped: 0 } as const);
  await context.secrets.store(STORAGE_PASSWORD_SECRET_KEY, next);
  setSavedAuthPassphrase(next);
  return {
    stored: true,
    rewritten: rewriteResult.rewritten,
    skipped: rewriteResult.skipped,
  };
}

export async function forgetSavedAuthPassphrase(context: vscode.ExtensionContext): Promise<void> {
  await context.secrets.delete(STORAGE_PASSWORD_SECRET_KEY);
  setSavedAuthPassphrase(null);
}
