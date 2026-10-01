import { describe, expect, it } from "vitest";
import { pathIsWithin } from "./paths";

describe("registered checkout path matching", () => {
  it("matches exact and descendant paths without prefix collisions", () => {
    expect(pathIsWithin("/repo/app", "/repo/app/src", "/home/user")).toBe(true);
    expect(pathIsWithin("/repo/app", "/repo/application", "/home/user")).toBe(false);
    expect(pathIsWithin("/", "/anywhere", "/home/user")).toBe(true);
  });

  it("resolves home-relative and macOS private paths like the Rust projection", () => {
    expect(pathIsWithin("~/projects/app", "/Users/piero/projects/app/src", "/Users/piero")).toBe(
      true,
    );
    expect(pathIsWithin("~", "/Users/piero", "/Users/piero")).toBe(true);
    expect(pathIsWithin("/private/Users/piero/repo", "/Users/piero/repo/src", "/Users/piero")).toBe(
      true,
    );
    expect(pathIsWithin("~/project", "/Users/pierof/project", "/Users/piero")).toBe(false);
  });
});
