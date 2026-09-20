import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

const VALID_KEY = "a".repeat(64); // 32 bytes hex
const TEST_TOKEN = "my-secret-intake-token-43chars-base64url_";

describe("intake token encryption (AES-256-GCM)", () => {
  beforeEach(() => {
    vi.stubEnv("INTAKE_TOKEN_ENCRYPTION_KEY", VALID_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("roundtrip: encrypt then decrypt returns original token", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/intake-crypto");
    const enc = encryptToken(TEST_TOKEN);
    const decrypted = decryptToken(enc.encrypted, enc.iv, enc.tag);
    expect(decrypted).toBe(TEST_TOKEN);
  });

  it("ciphertext differs from plaintext", async () => {
    const { encryptToken } = await import("@/lib/intake-crypto");
    const enc = encryptToken(TEST_TOKEN);
    expect(enc.encrypted).not.toBe(TEST_TOKEN);
    expect(enc.encrypted).toMatch(/^[0-9a-f]+$/);
  });

  it("two encryptions of same token produce different ciphertexts (random IV)", async () => {
    const { encryptToken } = await import("@/lib/intake-crypto");
    const e1 = encryptToken(TEST_TOKEN);
    const e2 = encryptToken(TEST_TOKEN);
    expect(e1.encrypted).not.toBe(e2.encrypted);
    expect(e1.iv).not.toBe(e2.iv);
  });

  it("tampered ciphertext fails closed (returns null)", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/intake-crypto");
    const enc = encryptToken(TEST_TOKEN);
    // tamper: flip a bit in the ciphertext
    const tampered = enc.encrypted.startsWith("ff")
      ? "00" + enc.encrypted.slice(2)
      : "ff" + enc.encrypted.slice(2);
    const result = decryptToken(tampered, enc.iv, enc.tag);
    expect(result).toBeNull();
  });

  it("tampered auth tag fails closed", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/intake-crypto");
    const enc = encryptToken(TEST_TOKEN);
    const badTag = "0".repeat(32);
    const result = decryptToken(enc.encrypted, enc.iv, badTag);
    expect(result).toBeNull();
  });

  it("missing key → encryptToken throws", async () => {
    vi.stubEnv("INTAKE_TOKEN_ENCRYPTION_KEY", "");
    vi.resetModules();
    const { encryptToken } = await import("@/lib/intake-crypto");
    expect(() => encryptToken(TEST_TOKEN)).toThrow("INTAKE_TOKEN_ENCRYPTION_KEY");
  });

  it("malformed key (wrong length) → encryptToken throws", async () => {
    vi.stubEnv("INTAKE_TOKEN_ENCRYPTION_KEY", "tooshort");
    vi.resetModules();
    const { encryptToken } = await import("@/lib/intake-crypto");
    expect(() => encryptToken(TEST_TOKEN)).toThrow("INTAKE_TOKEN_ENCRYPTION_KEY");
  });

  it("wrong key → decryptToken returns null (fail closed)", async () => {
    const { encryptToken, decryptToken } = await import("@/lib/intake-crypto");
    const enc = encryptToken(TEST_TOKEN);
    // switch to a different key
    vi.stubEnv("INTAKE_TOKEN_ENCRYPTION_KEY", "b".repeat(64));
    vi.resetModules();
    const { decryptToken: decryptWithWrongKey } = await import("@/lib/intake-crypto");
    const result = decryptWithWrongKey(enc.encrypted, enc.iv, enc.tag);
    expect(result).toBeNull();
  });
});
