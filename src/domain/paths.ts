function withoutMacosPrivatePrefix(value: string): string {
  return value.startsWith("/private/") ? value.slice("/private".length) : value;
}

function sameOrDescendantPath(root: string, value: string): boolean {
  return value === root || (value.startsWith(root) && value.slice(root.length).startsWith("/"));
}

/** Mirrors the registered checkout and worktree path comparison used by Rust. */
export function pathIsWithin(rootValue: string, pathValue: string, machineHome: string): boolean {
  const root = withoutMacosPrivatePrefix(rootValue).replace(/\/$/, "");
  const value = withoutMacosPrivatePrefix(pathValue);
  if (root === "/") return true;
  if (root === "~" || root.startsWith("~/")) {
    if (sameOrDescendantPath(root, value)) return true;
    const home = withoutMacosPrivatePrefix(machineHome).replace(/\/$/, "");
    if (!home) return false;
    if (!value.startsWith(home)) return false;
    const relative = value.slice(home.length);
    if (relative && !relative.startsWith("/")) return false;
    return sameOrDescendantPath(root, `~${relative}`);
  }
  return sameOrDescendantPath(root, value);
}
