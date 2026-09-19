import { describe, it, expect } from "vitest";
import { verifyCronAuth } from "@/lib/cron-auth";

function req(headers: Record<string, string>): Request {
  return new Request("https://app.example.com/api/cron/meeting-reminders", {
    headers,
  });
}

describe("verifyCronAuth (meeting-reminders scheduler)", () => {
  it("rejects a missing Authorization header", () => {
    expect(verifyCronAuth(req({}), "s3cret")).toEqual({
      ok: false,
      status: 401,
    });
  });

  it("rejects a wrong token", () => {
    expect(
      verifyCronAuth(req({ Authorization: "Bearer wrong" }), "s3cret")
    ).toEqual({ ok: false, status: 401 });
  });

  it("rejects a non-Bearer scheme", () => {
    expect(
      verifyCronAuth(req({ Authorization: "Basic s3cret" }), "s3cret")
    ).toEqual({ ok: false, status: 401 });
  });

  it("rejects a token with wrong casing of the scheme prefix", () => {
    expect(
      verifyCronAuth(req({ Authorization: "bearer s3cret" }), "s3cret")
    ).toEqual({ ok: false, status: 401 });
  });

  it("accepts the correct Bearer token", () => {
    expect(
      verifyCronAuth(req({ Authorization: "Bearer s3cret" }), "s3cret")
    ).toEqual({ ok: true, status: 200 });
  });

  it("rejects when the secret is not configured (server misconfig)", () => {
    expect(verifyCronAuth(req({ Authorization: "Bearer anything" }), undefined)).toEqual(
      { ok: false, status: 500 }
    );
    expect(verifyCronAuth(req({}), "")).toEqual({ ok: false, status: 500 });
  });
});
