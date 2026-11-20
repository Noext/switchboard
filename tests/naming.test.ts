import { describe, expect, it } from "vitest";
import {
  buildPublicName,
  buildResourceUri,
  isValidPublicName,
  isValidSlug,
  parseResourceUri,
  sanitizeSegment,
  shortHash,
  slugify,
  splitPublicName,
} from "../lib/catalog/naming";

describe("buildPublicName", () => {
  it("joins slug and name", () => {
    expect(buildPublicName("gh", "create_issue")).toEqual({ publicName: "gh__create_issue", truncated: false });
  });

  it("sanitizes illegal characters", () => {
    expect(buildPublicName("gh", "create issue!").publicName).toBe("gh__create_issue_");
  });

  it("truncates and hashes above the soft limit", () => {
    const long = "a".repeat(120);
    const r = buildPublicName("gh", long);
    expect(r.truncated).toBe(true);
    expect(r.publicName.length).toBeLessThanOrEqual(46);
    expect(r.publicName.startsWith("gh__")).toBe(true);
  });

  it("keeps every generated name valid and unique-ish", () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = buildPublicName("srv", "tool" + "x".repeat(i) + i);
      expect(isValidPublicName(r.publicName)).toBe(true);
      expect(r.publicName.length).toBeLessThanOrEqual(46);
      names.add(r.publicName);
    }
    expect(names.size).toBe(50);
  });

  it("respects the hard maximum of 64", () => {
    const r = buildPublicName("averylongslug", "b".repeat(200));
    expect(r.publicName.length).toBeLessThanOrEqual(64);
    expect(isValidPublicName(r.publicName)).toBe(true);
  });
});

describe("splitPublicName", () => {
  it("splits on the first __", () => {
    expect(splitPublicName("gh__create_issue")).toEqual(["gh", "create_issue"]);
    expect(splitPublicName("gh__a__b")).toEqual(["gh", "a__b"]);
  });
  it("returns null without a prefix", () => {
    expect(splitPublicName("report_feedback")).toBeNull();
  });
});

describe("slugs", () => {
  it("validates and slugifies", () => {
    expect(isValidSlug("gh")).toBe(true);
    expect(isValidSlug("GitHub")).toBe(false);
    expect(isValidSlug("a".repeat(13))).toBe(false);
    expect(slugify("My Server!!")).toBe("myserver");
    expect(slugify("x".repeat(30)).length).toBe(12);
  });
});

describe("shortHash", () => {
  it("is deterministic and 4 chars", () => {
    expect(shortHash("hello")).toBe(shortHash("hello"));
    expect(shortHash("hello")).toHaveLength(4);
    expect(shortHash("hello")).not.toBe(shortHash("hellp"));
  });
});

describe("sanitizeSegment", () => {
  it("replaces illegal characters", () => {
    expect(sanitizeSegment("a b.c/d")).toBe("a_b_c_d");
  });
});

describe("resource uris", () => {
  it("forwards raw uris when there is no collision", () => {
    expect(buildResourceUri("gh", "file:///a", false)).toBe("file:///a");
  });
  it("rewrites collisions", () => {
    expect(buildResourceUri("gh", "file:///a b", true)).toBe("switchboard://gh/file%3A%2F%2F%2Fa%20b");
  });
  it("round-trips rewritten uris", () => {
    const rewritten = buildResourceUri("gh", "file:///a", true);
    expect(parseResourceUri(rewritten)).toEqual({ kind: "switchboard", slug: "gh", uri: "file:///a" });
    expect(parseResourceUri("file:///a")).toEqual({ kind: "raw", uri: "file:///a" });
  });
});
