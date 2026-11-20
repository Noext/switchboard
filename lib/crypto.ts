import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { config, ensureDataDir } from "./config";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const VERSION = 1;

let cachedKey: Buffer | null = null;

/**
 * Master key resolution order:
 *  1. SWITCHBOARD_MASTER_KEY (base64, 32 bytes)
 *  2. data/master.key (base64, generated on first run)
 */
export function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.SWITCHBOARD_MASTER_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, "base64");
    if (buf.length !== 32) {
      throw new Error("SWITCHBOARD_MASTER_KEY must be base64 of exactly 32 bytes");
    }
    cachedKey = buf;
    return buf;
  }

  ensureDataDir();
  const keyPath = config.masterKeyPath;
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) throw new Error(`Invalid master key in ${keyPath}`);
    cachedKey = buf;
    return buf;
  }

  const fresh = randomBytes(32);
  writeFileSync(keyPath, fresh.toString("base64") + "\n", { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best effort */
  }
  cachedKey = fresh;
  return fresh;
}

export function isMasterKeyFromFile(): boolean {
  return !process.env.SWITCHBOARD_MASTER_KEY && existsSync(config.masterKeyPath);
}

export function masterKeyExists(): boolean {
  return Boolean(process.env.SWITCHBOARD_MASTER_KEY) || existsSync(config.masterKeyPath);
}

/** Encrypts a JS value as JSON. Returns a self-describing buffer: [version|iv|tag|ciphertext]. */
export function encryptJson(value: unknown): Buffer {
  return encryptString(JSON.stringify(value));
}

export function encryptString(plaintext: string): Buffer {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

export function decryptString(payload: Buffer | Uint8Array | null | undefined): string {
  if (!payload || payload.length === 0) throw new Error("empty ciphertext");
  const buf = Buffer.from(payload);
  if (buf[0] !== VERSION) throw new Error("unsupported ciphertext version");
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function decryptJson<T = unknown>(payload: Buffer | Uint8Array | null | undefined): T | null {
  if (!payload || payload.length === 0) return null;
  return JSON.parse(decryptString(payload)) as T;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) {
    // still perform a comparison to keep timing uniform
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function randomBase62(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += BASE62[bytes[i] % 62];
  return out;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hmac(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}
