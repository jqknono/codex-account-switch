import * as vscode from "vscode";
import {
  getCurrentSelection,
  getNamedProviderPath,
  listProviderModes,
  readProviderProfile,
} from "@codex-account-switch/core";
import {
  formatProviderFieldValue,
  readProviderProfileDraft,
} from "./providerProfile";

interface ProviderSnapshot {
  name: string;
  isCurrent: boolean;
  invalid: boolean;
  auth: Record<string, unknown>;
  config: Record<string, unknown>;
}

export type ProviderTreeNode = ProviderTreeItem | ProviderDetailItem;

function getProviderSnapshots(): ProviderSnapshot[] {
  const selection = getCurrentSelection();
  return listProviderModes().map((name) => {
    const profile = readProviderProfile(name);
    const draft = readProviderProfileDraft(getNamedProviderPath(name), name);
    return {
      name,
      isCurrent: selection.kind === "provider" && selection.name === name,
      invalid: draft.invalid || !profile,
      auth: profile?.auth ?? draft.auth,
      config: profile ? { ...profile.config } : draft.config,
    };
  });
}

function describeProvider(snapshot: ProviderSnapshot): string {
  if (snapshot.invalid) {
    return "Invalid profile";
  }

  const parts: string[] = [];
  const authKeys = Object.keys(snapshot.auth).filter((key) => {
    const value = snapshot.auth[key];
    return value != null && String(value).trim() !== "";
  });
  parts.push(authKeys.length > 0 ? `${authKeys.length} auth field${authKeys.length === 1 ? "" : "s"}` : "No auth");

  const wireApi =
    typeof snapshot.config.wire_api === "string" && snapshot.config.wire_api.trim()
      ? snapshot.config.wire_api.trim()
      : null;
  if (wireApi) {
    parts.push(wireApi);
  }

  if (snapshot.isCurrent) {
    parts.push("Active");
  }

  return parts.join(" · ");
}

function compareEntries([leftKey]: [string, unknown], [rightKey]: [string, unknown]): number {
  if (leftKey === "OPENAI_API_KEY") return -1;
  if (rightKey === "OPENAI_API_KEY") return 1;
  return leftKey.localeCompare(rightKey);
}

export class ProviderDetailItem extends vscode.TreeItem {
  constructor(
    label: string,
    description?: string,
    tooltip?: string,
    public readonly parent?: ProviderTreeItem,
    public readonly rawValue?: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.tooltip = tooltip;
    this.contextValue = "providerDetail";
  }
}

export class ProviderTreeItem extends vscode.TreeItem {
  constructor(public readonly provider: ProviderSnapshot) {
    super(provider.name, vscode.TreeItemCollapsibleState.Expanded);

    this.description = describeProvider(provider);
    this.contextValue = "provider";

    if (provider.invalid) {
      this.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"));
    } else if (provider.isCurrent) {
      this.iconPath = new vscode.ThemeIcon("plug", new vscode.ThemeColor("charts.green"));
    } else {
      this.iconPath = new vscode.ThemeIcon("plug");
    }

    const tooltipLines = [`Provider: ${provider.name}`];
    tooltipLines.push(provider.invalid ? "Status: Invalid provider profile" : "Status: Ready");
    if (provider.isCurrent) {
      tooltipLines.push("Active: Yes");
    }

    const baseUrl =
      typeof provider.config.base_url === "string" && provider.config.base_url.trim()
        ? provider.config.base_url.trim()
        : null;
    const wireApi =
      typeof provider.config.wire_api === "string" && provider.config.wire_api.trim()
        ? provider.config.wire_api.trim()
        : null;
    if (baseUrl) {
      tooltipLines.push(`base_url: ${baseUrl}`);
    }
    if (wireApi) {
      tooltipLines.push(`wire_api: ${wireApi}`);
    }

    const authKeys = Object.keys(provider.auth).sort();
    if (authKeys.length > 0) {
      tooltipLines.push(`Auth fields: ${authKeys.join(", ")}`);
    }

    this.tooltip = tooltipLines.join("\n");
  }
}

export class ProviderTreeProvider implements vscode.TreeDataProvider<ProviderTreeNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<ProviderTreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private rootItems: ProviderTreeItem[] = [];

  refresh(): void {
    this.rootItems = [];
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: ProviderTreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ProviderTreeNode): ProviderTreeNode[] {
    if (!element) {
      return this.getRootItems();
    }

    if (element instanceof ProviderDetailItem) {
      return [];
    }

    return this.getProviderDetails(element);
  }

  getParent(element: ProviderTreeNode): ProviderTreeNode | undefined {
    if (element instanceof ProviderDetailItem) {
      return element.parent;
    }
    return undefined;
  }

  getRootItems(): ProviderTreeItem[] {
    if (this.rootItems.length === 0) {
      this.rootItems = getProviderSnapshots().map((provider) => new ProviderTreeItem(provider));
    }
    return this.rootItems;
  }

  dispose(): void {
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private getProviderDetails(parent: ProviderTreeItem): ProviderDetailItem[] {
    const { provider } = parent;
    const items: ProviderDetailItem[] = [];

    const statusItem = new ProviderDetailItem(
      "Status",
      provider.invalid ? "Invalid" : provider.isCurrent ? "Active" : "Saved",
      provider.invalid ? "Provider profile is invalid or incomplete" : undefined,
      parent
    );
    statusItem.iconPath = provider.invalid
      ? new vscode.ThemeIcon("warning", new vscode.ThemeColor("errorForeground"))
      : provider.isCurrent
        ? new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.green"))
        : new vscode.ThemeIcon("circle-large-outline");
    items.push(statusItem);

    const configEntries = Object.entries(provider.config)
      .filter(([key]) => key !== "name")
      .sort(compareEntries);
    for (const [key, value] of configEntries) {
      const isCopyable = key === "base_url";
      const rawValue = typeof value === "string" ? value : undefined;
      const item = new ProviderDetailItem(
        key,
        formatProviderFieldValue(key, value),
        undefined,
        parent,
        rawValue
      );
      if (isCopyable && rawValue) {
        item.contextValue = "providerCopyableField";
      }
      item.iconPath =
        key === "base_url"
          ? new vscode.ThemeIcon("link")
          : new vscode.ThemeIcon("settings-gear");
      items.push(item);
    }

    const authEntries = Object.entries(provider.auth).sort(compareEntries);
    for (const [key, value] of authEntries) {
      const isCopyable = key === "OPENAI_API_KEY";
      const rawValue = typeof value === "string" ? value : undefined;
      const item = new ProviderDetailItem(
        key,
        formatProviderFieldValue(key, value, { revealSecrets: isCopyable }),
        undefined,
        parent,
        rawValue
      );
      if (isCopyable && rawValue) {
        item.contextValue = "providerCopyableField";
      }
      item.iconPath =
        key === "OPENAI_API_KEY"
          ? new vscode.ThemeIcon("key")
          : new vscode.ThemeIcon("shield");
      items.push(item);
    }

    if (items.length === 1) {
      const emptyItem = new ProviderDetailItem(
        "Profile",
        "No saved fields",
        "This provider profile does not contain config or auth data yet",
        parent
      );
      emptyItem.iconPath = new vscode.ThemeIcon("circle-slash");
      items.push(emptyItem);
    }

    return items;
  }
}
