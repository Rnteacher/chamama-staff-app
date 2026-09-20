import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_NAME = "INTAKE_TOKEN_ENCRYPTION_KEY";

function getKey(): Buffer {
  const hex = process.env[KEY_NAME];
  if (!hex || hex.length !== 64) {
    throw new Error(
      `${KEY_NAME} must be a 64-character hex string (32 bytes). ` +
        `Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
    );
  }
  return Buffer.from(hex, "hex");
}

export interface EncryptedToken {
  encrypted: string; // hex ciphertext
  iv: string; // hex nonce
  tag: string; // hex auth tag
}

/** AES-256-GCM authenticated encryption. */
export function encryptToken(plaintext: string): EncryptedToken {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    encrypted: encrypted.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

/** Returns null on tamper detection or wrong key. */
export function decryptToken(encrypted: string, iv: string, tag: string): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
