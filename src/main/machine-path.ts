import path from "node:path";

export function normalizeMachinePath(value: string, home: string): string {
  const input = value.trim().replace(/\/+$/, "");
  if (!input) throw new Error("a Repository checkout path cannot be blank");
  if (input === "~" || input.startsWith("~/")) return input;
  const normalizedHome = home.trim().replace(/\/+$/, "");
  if (normalizedHome && (input === normalizedHome || input.startsWith(`${normalizedHome}/`))) {
    const relative = input.slice(normalizedHome.length).replace(/^\/+/, "");
    return relative ? `~/${relative}` : "~";
  }
  return input.startsWith("/") ? input : `~/${input}`;
}

export function resolveMachinePath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.posix.join(home, value.slice(2));
  return path.posix.isAbsolute(value) ? value : path.posix.join(home, value);
}

export function worktreePath(
  root: string,
  workspaceId: number,
  branch: string,
  repositoryName: string,
): string {
  let result = "";
  let separator = false;
  for (const character of branch.trim()) {
    if (/^[A-Za-z0-9_.-]$/.test(character)) {
      result += character;
      separator = false;
    } else if (!separator) {
      result += "-";
      separator = true;
    }
  }
  result = result.replace(/^[.-]+|[.-]+$/g, "") || "branch";
  return path.posix.join(root, `workspace-${workspaceId}`, result, repositoryName);
}
