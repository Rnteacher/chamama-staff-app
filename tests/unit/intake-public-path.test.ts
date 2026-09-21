import { describe, it, expect } from "vitest";
import { buildIntakePublicUrl, INTAKE_PUBLIC_ROUTE } from "@/lib/intake-public-path";

/**
 * Regression tests: "העתקת קישור" must copy a COMPLETE ABSOLUTE URL —
 * never the bare token, never a relative path. One canonical builder is
 * shared by creation, "יצירת קישור נוסף" and "העתקת קישור".
 */

describe("buildIntakePublicUrl (canonical public intake link)", () => {
  it("copies an absolute URL on the given origin for token abc123", () => {
    const url = buildIntakePublicUrl("abc123", "https://staff.example.org");
    expect(url).toMatch(/^https:\/\/staff\.example\.org\//);
    expect(url).toBe("https://staff.example.org/intake/abc123");
  });

  it("contains the public intake route and the token", () => {
    const url = buildIntakePublicUrl("abc123", "https://staff.example.org");
    expect(url).toContain(`${INTAKE_PUBLIC_ROUTE}/abc123`);
    expect(url).toContain("/intake/");
  });

  it("is NEVER just the token or a relative path", () => {
    const url = buildIntakePublicUrl("abc123", "https://staff.example.org");
    expect(url).not.toBe("abc123");
    expect(url).not.toBe("/intake/abc123");
    expect(url.startsWith("https://")).toBe(true);
  });

  it("repeated construction returns exactly the same complete URL", () => {
    const a = buildIntakePublicUrl("abc123", "https://staff.example.org");
    const b = buildIntakePublicUrl("abc123", "https://staff.example.org");
    expect(a).toBe(b);
  });

  it("same helper serves creation/reissue and later Copy Link — identical URL", () => {
    // flow A: additional link generated now
    const reissueUrl = buildIntakePublicUrl("tok_xyz", "https://staff.example.org");
    // flow B: the same token copied later via Copy Link
    const copyUrl = buildIntakePublicUrl("tok_xyz", "https://staff.example.org");
    expect(reissueUrl).toBe(copyUrl);
    expect(reissueUrl).toBe("https://staff.example.org/intake/tok_xyz");
  });

  it("follows the CURRENT origin — production/preview/local each copy themselves", () => {
    expect(buildIntakePublicUrl("abc123", "https://app.example.com").startsWith("https://app.example.com/")).toBe(true);
    expect(buildIntakePublicUrl("abc123", "https://preview-abc.vercel.app").startsWith("https://preview-abc.vercel.app/")).toBe(true);
    expect(buildIntakePublicUrl("abc123", "http://localhost:3000").startsWith("http://localhost:3000/")).toBe(true);
  });

  it("URL-encodes the token path segment", () => {
    const url = buildIntakePublicUrl("a/b+c", "https://staff.example.org");
    expect(url).toBe("https://staff.example.org/intake/a%2Fb%2Bc");
  });
});
