import { describe, it, expect } from "vitest";
import { buildCsv, csvWithBom } from "@/lib/csv-export";

describe("buildCsv", () => {
  it("produces correct CSV with headers and rows", () => {
    const csv = buildCsv(["שם", "קבוצה"], [["נועם", "זית"]]);
    expect(csv).toBe("שם,קבוצה\r\nנועם,זית");
  });

  it("escapes values containing commas", () => {
    const csv = buildCsv(["a"], [['has,comma']]);
    expect(csv).toContain('"has,comma"');
  });

  it("escapes values containing double quotes", () => {
    const csv = buildCsv(["a"], [['has"quote']]);
    expect(csv).toContain('"has""quote"');
  });

  it("protects against formula injection with = prefix", () => {
    const csv = buildCsv(["a"], [["=SUM(A1)"]]);
    expect(csv).toContain("'=SUM(A1)");
  });

  it("protects against formula injection with + prefix", () => {
    const csv = buildCsv(["a"], [["+cmd"]]);
    expect(csv).toContain("'+cmd");
  });

  it("protects against formula injection with - prefix", () => {
    const csv = buildCsv(["a"], [["-danger"]]);
    expect(csv).toContain("'-danger");
  });

  it("protects against formula injection with @ prefix", () => {
    const csv = buildCsv(["a"], [["@import"]]);
    expect(csv).toContain("'@import");
  });

  it("does not modify values without special prefixes", () => {
    const csv = buildCsv(["a"], [["normal text"]]);
    expect(csv).toContain("normal text");
  });
});

describe("csvWithBom", () => {
  it("prepends UTF-8 BOM bytes", () => {
    const buf = csvWithBom("test");
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
    // rest is the UTF-8 content
    expect(buf.slice(3).toString("utf8")).toBe("test");
  });
});
