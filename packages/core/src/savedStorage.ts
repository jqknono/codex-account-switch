import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getNamedAuthDir } from "./paths";

export type SavedStorageKind = "saved_auth" | "saved_provider";
export type SavedStorageLockReason = "missing_passphrase" | "incorrect_passphrase";
export type SavedStorageReadResult<T> =
  | {
      status: "ok";
      value: T;
      encrypted: boolean;
    }
  | {
      status: "missing";
      encrypted: false;
    }
  | {
      status: "locked";
      encrypted: true;
      reason: SavedStorageLockReason;
      message: string;
    }
  | {
      status: "invalid";
      encrypted: boolean;
      message: string;
    };

interface SavedStorageEnvelope {
  version: 1;
  kind: SavedStorageKind;
  cipher: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  ciphertext: string;
}

let savedAuthPassphrase: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toBase64(bytes: Buffer): string {
  return bytes.toString("base64");
}

function fromBase64(value: unknown, field: string): Buffer {
  if (typeof value !== "string" || !value) {
    throw new Error(`Encrypted saved storage is invalid: missing ${field}.`);
  }
  try {
    return Buffer.from(value, "base64");
  } catch {
    throw new Error(`Encrypted saved storage is invalid: bad ${field}.`);
  }
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32);
}

function isEnvelope(value: unknown): value is SavedStorageEnvelope {
  return (
    isRecord(value) &&
    value.version === 1 &&
    (value.kind === "saved_auth" || value.kind === "saved_provider") &&
    value.cipher === "aes-256-gcm" &&
    value.kdf === "scrypt" &&
    typeof value.salt === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string"
  );
}

function getSavedFileKindFromName(name: string): SavedStorageKind | null {
  if (/^auth_.+\.json$/.test(name)) {
    return "saved_auth";
  }
  if (/^provider_.+\.json$/.test(name)) {
    return "saved_provider";
  }
  return null;
}

function parseSavedStorageEnvelope(raw: string): SavedStorageEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isEnvelope(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cloneJsonObject<T extends Record<string, unknown>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildLockedResult(reason: SavedStorageLockReason): SavedStorageReadResult<never> {
  const message =
    reason === "missing_passphrase"
      ? "Saved auth storage is locked. Set the storage password in VS Code to continue."
      : "Saved auth storage is locked. The local storage password is missing or incorrect.";
  return {
    status: "locked",
    encrypted: true,
    reason,
    message,
  };
}

function encryptSavedValue(kind: SavedStorageKind, value: Record<string, unknown>, passphrase: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value, null, 2), "utf-8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const envelope: SavedStorageEnvelope = {
    version: 1,
    kind,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(Buffer.concat([ciphertext, authTag])),
  };

  return JSON.stringify(envelope, null, 2);
}

function encryptSavedEnvelope(kind: SavedStorageKind, value: Record<string, unknown>, passphrase: string): SavedStorageEnvelope {
  return JSON.parse(encryptSavedValue(kind, value, passphrase)) as SavedStorageEnvelope;
}

function decryptSavedEnvelope<T>(
  envelope: SavedStorageEnvelope,
  expectedKind: SavedStorageKind
): SavedStorageReadResult<T> {
  if (envelope.kind !== expectedKind) {
    return {
      status: "invalid",
      encrypted: true,
      message: `Encrypted saved storage has kind "${envelope.kind}" but "${expectedKind}" was expected.`,
    };
  }

  if (!savedAuthPassphrase) {
    return buildLockedResult("missing_passphrase");
  }

  try {
    const salt = fromBase64(envelope.salt, "salt");
    const iv = fromBase64(envelope.iv, "iv");
    const combined = fromBase64(envelope.ciphertext, "ciphertext");
    if (combined.length <= 16) {
      return {
        status: "invalid",
        encrypted: true,
        message: "Encrypted saved storage is invalid: ciphertext is too short.",
      };
    }

    const ciphertext = combined.subarray(0, combined.length - 16);
    const authTag = combined.subarray(combined.length - 16);
    const key = deriveKey(savedAuthPassphrase, salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!isRecord(parsed)) {
      return {
        status: "invalid",
        encrypted: true,
        message: "Encrypted saved storage does not contain a JSON object.",
      };
    }
    return {
      status: "ok",
      value: parsed as T,
      encrypted: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Unsupported state|authentication failed|unable to authenticate data/i.test(message)) {
      return buildLockedResult("incorrect_passphrase");
    }
    return {
      status: "invalid",
      encrypted: true,
      message: `Encrypted saved storage is invalid: ${message}`,
    };
  }
}

export function setSavedAuthPassphrase(passphrase: string | null): void {
  savedAuthPassphrase = typeof passphrase === "string" && passphrase.length > 0 ? passphrase : null;
}

export function getSavedAuthPassphrase(): string | null {
  return savedAuthPassphrase;
}

export function serializeSavedValue(
  kind: SavedStorageKind,
  value: Record<string, unknown>,
  options?: { requireEncryption?: boolean }
): Record<string, unknown> {
  if (options?.requireEncryption) {
    if (!savedAuthPassphrase) {
      throw new Error("Saved auth storage is locked. Set the storage password in VS Code to continue.");
    }
    return encryptSavedEnvelope(kind, value, savedAuthPassphrase) as unknown as Record<string, unknown>;
  }

  if (savedAuthPassphrase) {
    return encryptSavedEnvelope(kind, value, savedAuthPassphrase) as unknown as Record<string, unknown>;
  }

  return cloneJsonObject(value);
}

export function deserializeSavedValue<T>(value: unknown, expectedKind: SavedStorageKind): SavedStorageReadResult<T> {
  if (value == null) {
    return { status: "missing", encrypted: false };
  }

  if (isEnvelope(value)) {
    return decryptSavedEnvelope<T>(value, expectedKind);
  }

  if (!isRecord(value)) {
    return {
      status: "invalid",
      encrypted: false,
      message: "Saved storage does not contain a JSON object.",
    };
  }

  return {
    status: "ok",
    value: cloneJsonObject(value) as T,
    encrypted: false,
  };
}

export function isSerializedSavedValueEncrypted(value: unknown): boolean {
  return isEnvelope(value);
}

export function writeSavedJsonFile(
  filePath: string,
  kind: SavedStorageKind,
  value: Record<string, unknown>
): void {
  const payload = JSON.stringify(serializeSavedValue(kind, value), null, 2);
  fs.writeFileSync(filePath, payload, "utf-8");
}

export function readSavedJsonFile<T>(
  filePath: string,
  expectedKind: SavedStorageKind
): SavedStorageReadResult<T> {
  if (!fs.existsSync(filePath)) {
    return { status: "missing", encrypted: false };
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const envelope = parseSavedStorageEnvelope(raw);
  if (envelope) {
    return decryptSavedEnvelope<T>(envelope, expectedKind);
  }

  try {
    return deserializeSavedValue<T>(JSON.parse(raw) as unknown, expectedKind);
  } catch {
    return {
      status: "invalid",
      encrypted: false,
      message: "Saved storage is not valid JSON.",
    };
  }
}

export function hasEncryptedSavedFiles(): boolean {
  const dir = getNamedAuthDir();
  if (!fs.existsSync(dir)) {
    return false;
  }

  for (const name of fs.readdirSync(dir)) {
    if (!getSavedFileKindFromName(name)) {
      continue;
    }
    const envelope = parseSavedStorageEnvelope(fs.readFileSync(path.join(dir, name), "utf-8"));
    if (envelope) {
      return true;
    }
  }

  return false;
}

export function changeSavedAuthPassphrase(nextPassphrase: string): { rewritten: number; skipped: number } {
  if (!savedAuthPassphrase) {
    throw new Error("Saved auth storage is locked. Load the current local storage password before changing it.");
  }

  if (!nextPassphrase) {
    throw new Error("A new local storage password is required.");
  }

  const dir = getNamedAuthDir();
  if (!fs.existsSync(dir)) {
    savedAuthPassphrase = nextPassphrase;
    return { rewritten: 0, skipped: 0 };
  }

  const previousPassphrase = savedAuthPassphrase;
  const rewrites: Array<{ filePath: string; kind: SavedStorageKind; value: Record<string, unknown> }> = [];
  let skipped = 0;

  for (const name of fs.readdirSync(dir)) {
    const kind = getSavedFileKindFromName(name);
    if (!kind) {
      continue;
    }

    const filePath = path.join(dir, name);
    const result = readSavedJsonFile<Record<string, unknown>>(filePath, kind);
    if (result.status === "ok") {
      if (result.encrypted) {
        rewrites.push({ filePath, kind, value: result.value });
      } else {
        skipped += 1;
      }
      continue;
    }

    if (result.status === "missing") {
      continue;
    }

    throw new Error(result.message);
  }

  savedAuthPassphrase = nextPassphrase;
  try {
    for (const item of rewrites) {
      writeSavedJsonFile(item.filePath, item.kind, item.value);
    }
  } catch (error) {
    savedAuthPassphrase = previousPassphrase;
    throw error;
  }

  return {
    rewritten: rewrites.length,
    skipped,
  };
}
