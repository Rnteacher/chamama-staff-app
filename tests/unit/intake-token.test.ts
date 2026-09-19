import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  hashIntakeToken,
  resolveIntakeState,
  buildIntakeUrl,
} from "@/lib/intake-token";

describe("hashIntakeToken — canonical token hash", () => {
  it("matches the database-side expression exactly (known vector)", () => {
    // known SHA-256 test vector: sha256('abc')
    expect(hashIntakeToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("is lowercase hex, 64 chars (matches SQL encode(sha256(convert_to(t,'UTF8')),'hex'))", () => {
    const token = "kX9_qW-ertyuiopasdfghjklzxcvbnm1234567890QWERTYU"; // base64url-shaped
    const h = hashIntakeToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // same value the SQL side computes (verified live against Postgres):
    expect(h).toBe(
      createHash("sha256").update(token, "utf8").digest("hex")
    );
  });

  it("is deterministic and whitespace-sensitive", () => {
    expect(hashIntakeToken("tok")).toBe(hashIntakeToken("tok"));
    expect(hashIntakeToken("tok")).not.toBe(hashIntakeToken(" tok"));
    expect(hashIntakeToken("tok")).not.toBe(hashIntakeToken("Tok"));
  });
});

describe("buildIntakeUrl", () => {
  it("embeds the FULL raw base64url token without truncation or encoding", () => {
    const token = "AbC123-_x_y_z456";
    expect(buildIntakeUrl("https://staff.example.com", token)).toBe(
      "https://staff.example.com/intake/AbC123-_x_y_z456"
    );
  });
});

describe("resolveIntakeState — never collapses backend failures into 'invalid'", () => {
  it("maps a null RPC result (RPC threw) to 'error', not 'invalid'", () => {
    expect(resolveIntakeState(null).status).toBe("error");
    expect(resolveIntakeState(undefined).status).toBe("error");
  });

  it("maps an explicit invalid status to 'invalid'", () => {
    expect(resolveIntakeState({ status: "invalid" }).status).toBe("invalid");
  });

  it("maps not_open / closed / open correctly with metadata", () => {
    const notOpen = resolveIntakeState({
      status: "not_open",
      title: "t",
      opens_at: "2026-01-01T00:00:00+00:00",
    });
    expect(notOpen.status).toBe("not_open");
    expect(notOpen.title).toBe("t");

    expect(resolveIntakeState({ status: "closed" }).status).toBe("closed");

    const open = resolveIntakeState({
      status: "open",
      title: "t",
      groups: [{ id: "g", name: "קבוצה" }],
    });
    expect(open.status).toBe("open");
    expect(open.groups).toEqual([{ id: "g", name: "קבוצה" }]);
  });

  it("maps an explicit error status to 'error'", () => {
    expect(resolveIntakeState({ status: "error" }).status).toBe("error");
  });

  it("treats unknown statuses as technical errors", () => {
    expect(resolveIntakeState({ status: "weird" }).status).toBe("error");
  });
});
