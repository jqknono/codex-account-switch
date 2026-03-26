import * as fs from "fs";
import { getCodexConfigDir, getCodexConfigPath } from "./paths";
import { ProviderConfig } from "./types";

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function trimLeadingBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") {
    start += 1;
  }
  return lines.slice(start);
}

function ensureConfigDir(): void {
  fs.mkdirSync(getCodexConfigDir(), { recursive: true });
}

function readConfigText(): string {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) {
    return "";
  }
  return fs.readFileSync(configPath, "utf-8");
}

function writeConfigText(text: string): void {
  ensureConfigDir();
  fs.writeFileSync(getCodexConfigPath(), text, "utf-8");
}

function renderTablePathSegment(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

function getProviderTableHeaders(providerName: string): string[] {
  const safeHeader = `[model_providers.${renderTablePathSegment(providerName)}]`;
  const legacyHeader = `[model_providers.${providerName}]`;
  return safeHeader === legacyHeader ? [safeHeader] : [safeHeader, legacyHeader];
}

function findTableBlock(lines: string[], headers: string[]): { start: number; end: number } | null {
  const normalizedHeaders = new Set(headers);
  const start = lines.findIndex((line) => normalizedHeaders.has(line.trim()));
  if (start === -1) {
    return null;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function removeTopLevelModelProvider(lines: string[]): string[] {
  const nextLines: string[] = [];
  let currentTable: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentTable = trimmed;
      nextLines.push(line);
      continue;
    }

    if (currentTable == null && /^model_provider\s*=/.test(trimmed)) {
      continue;
    }

    nextLines.push(line);
  }

  return nextLines;
}

function upsertTopLevelModelProvider(lines: string[], providerName: string): string[] {
  const assignment = `model_provider = ${JSON.stringify(providerName)}`;
  const withoutAssignment = removeTopLevelModelProvider(lines);

  if (withoutAssignment.length === 0) {
    return [assignment, ""];
  }

  let insertAt = 0;
  while (insertAt < withoutAssignment.length) {
    const trimmed = withoutAssignment[insertAt].trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      insertAt += 1;
      continue;
    }
    break;
  }

  const nextLines = [...withoutAssignment];
  nextLines.splice(insertAt, 0, assignment);
  if (insertAt + 1 < nextLines.length && nextLines[insertAt + 1].trim() !== "") {
    nextLines.splice(insertAt + 1, 0, "");
  }
  return nextLines;
}

function upsertKey(lines: string[], key: string, value: string): string[] {
  const rendered = `${key} = ${JSON.stringify(value)}`;
  let replaced = false;
  const nextLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (match?.[1] === key) {
      replaced = true;
      return rendered;
    }
    return line;
  });

  if (!replaced) {
    nextLines.push(rendered);
  }
  return nextLines;
}

function upsertProviderTable(lines: string[], providerName: string, config: ProviderConfig): string[] {
  const [normalizedHeader] = getProviderTableHeaders(providerName);
  const block = findTableBlock(lines, getProviderTableHeaders(providerName));
  const payload = [
    `name = ${JSON.stringify(config.name)}`,
    `base_url = ${JSON.stringify(config.base_url)}`,
    `wire_api = ${JSON.stringify(config.wire_api)}`,
  ];

  if (!block) {
    const nextLines = [...lines];
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== "") {
      nextLines.push("");
    }
    nextLines.push(normalizedHeader);
    nextLines.push(...payload);
    return nextLines;
  }

  let sectionLines = lines.slice(block.start + 1, block.end);
  sectionLines = upsertKey(sectionLines, "name", config.name);
  sectionLines = upsertKey(sectionLines, "base_url", config.base_url);
  sectionLines = upsertKey(sectionLines, "wire_api", config.wire_api);

  return [
    ...lines.slice(0, block.start),
    normalizedHeader,
    ...sectionLines,
    ...lines.slice(block.end),
  ];
}

function removeProviderTable(lines: string[], providerName: string): string[] {
  const block = findTableBlock(lines, getProviderTableHeaders(providerName));
  if (!block) {
    return lines;
  }

  return [
    ...lines.slice(0, block.start),
    ...lines.slice(block.end),
  ];
}

export function getActiveModelProvider(): string | null {
  const text = readConfigText();
  if (!text) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  let currentTable: string | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentTable = trimmed;
      continue;
    }

    if (currentTable != null) {
      continue;
    }

    const match = trimmed.match(/^model_provider\s*=\s*(["'])(.+)\1\s*(#.*)?$/);
    if (match) {
      return match[2];
    }
  }

  return null;
}

export function activateProviderConfig(providerName: string, config: ProviderConfig): void {
  const currentText = readConfigText();
  const eol = detectEol(currentText);
  let lines = currentText ? currentText.split(/\r?\n/) : [];
  lines = upsertTopLevelModelProvider(lines, providerName);
  lines = upsertProviderTable(lines, providerName, config);
  lines = trimLeadingBlankLines(lines);
  writeConfigText(lines.join(eol).replace(/(?:\r?\n)+$/, "") + eol);
}

export function clearActiveModelProvider(): void {
  const currentText = readConfigText();
  const eol = detectEol(currentText);
  const lines = currentText ? currentText.split(/\r?\n/) : [];
  const nextLines = trimLeadingBlankLines(removeTopLevelModelProvider(lines));
  writeConfigText(nextLines.join(eol).replace(/(?:\r?\n)+$/, nextLines.length > 0 ? eol : ""));
}

export function removeProviderConfig(providerName: string): void {
  const currentText = readConfigText();
  const eol = detectEol(currentText);
  let lines = currentText ? currentText.split(/\r?\n/) : [];

  if (getActiveModelProvider() === providerName) {
    lines = removeTopLevelModelProvider(lines);
  }

  lines = removeProviderTable(lines, providerName);
  lines = trimLeadingBlankLines(lines);
  writeConfigText(lines.join(eol).replace(/(?:\r?\n)+$/, lines.length > 0 ? eol : ""));
}
