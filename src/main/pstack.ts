import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pstackManifest } from "./generated-resources";
import { shellQuote, type MachineAccess } from "./machine-access";
import type { Machine } from "../domain/types";

export const PSTACK_VERSION = pstackManifest.version;
export const PSTACK_UPSTREAM_COMMIT = pstackManifest.upstreamCommit;
export const PSTACK_TREE_HASH = pstackManifest.treeHash;
export const PSTACK_TREE = pstackManifest.files;
export function pstackTreeDirectory(home: string) {
  return path.join(home, ".local/share/ai-mission-manager/pstack", PSTACK_TREE_HASH);
}
export function pstackSkillSnapshot() {
  return (
    "pstack version " +
    PSTACK_VERSION +
    "; upstream commit " +
    PSTACK_UPSTREAM_COMMIT +
    "; tree hash " +
    PSTACK_TREE_HASH
  );
}
export function pstackTreePayload() {
  return (
    PSTACK_TREE.map(
      (file) => file.path + "\n" + (file.executable ? "1" : "0") + "\n" + file.base64 + "\n",
    ).join("") + "\n"
  );
}
export function writeLocalPstackTree(target: string) {
  if (fs.existsSync(target)) {
    if (fs.statSync(target).isDirectory()) return;
    throw new Error("pstack target exists but is not a directory: " + target);
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = path.join(parent, ".pstack-" + PSTACK_TREE_HASH + "-" + process.pid);
  fs.rmSync(temporary, { recursive: true, force: true });
  try {
    for (const file of PSTACK_TREE) {
      if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes(".."))
        throw new Error("Invalid embedded pstack path: " + file.path);
      const destination = path.join(temporary, file.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(file.base64, "base64"));
      fs.chmodSync(destination, file.executable ? 0o755 : 0o644);
    }
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        fs.rmSync(temporary, { recursive: true, force: true });
        return;
      }
      throw error;
    }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
export function buildRemotePstackTreeCommand(target: string) {
  const quoted = shellQuote(target);
  return (
    "set -eu; target=" +
    quoted +
    '; if [ -d "$target" ]; then exit 0; fi; parent=${target%/*}; mkdir -p "$parent"; temporary="$target.tmp.$$"; trap \'rm -rf "$temporary"\' EXIT HUP INT TERM; mkdir -p "$temporary"; while IFS= read -r relative && [ -n "$relative" ]; do IFS= read -r executable || exit 1; IFS= read -r contents || exit 1; case "$relative" in /*|*..*) exit 1;; esac; file="$temporary/$relative"; mkdir -p "${file%/*}"; printf \'%s\' "$contents" | base64 -d > "$file"; if [ "$executable" = 1 ]; then chmod 755 "$file"; else chmod 644 "$file"; fi; done; if [ -d "$target" ]; then exit 0; fi; mv "$temporary" "$target"; trap - EXIT HUP INT TERM'
  );
}
export async function provisionPstackTree(machine: Machine, access: MachineAccess, home: string) {
  const target = pstackTreeDirectory(home);
  if (machine.transport.kind === "local") writeLocalPstackTree(target);
  else
    await access.runShell(
      machine,
      buildRemotePstackTreeCommand(target),
      Buffer.from(pstackTreePayload()),
    );
  return target;
}
export function buildPstackTreeHash(
  files: readonly { path: string; base64: string; executable: boolean }[],
) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const contents = Buffer.from(file.base64, "base64");
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(contents.length));
    hash.update(Buffer.from(file.path));
    hash.update(Buffer.from([0]));
    hash.update(size);
    hash.update(contents);
    hash.update(Buffer.from([file.executable ? 1 : 0]));
  }
  return hash.digest("hex");
}
