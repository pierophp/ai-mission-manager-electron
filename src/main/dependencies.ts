import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { DependencyState, DependencyStatus } from "../domain/types";

export function resolveExecutable(name: string, storedPath: string | null): string | null {
  if (storedPath && path.isAbsolute(storedPath) && isExecutable(storedPath))
    return canonicalPath(storedPath);

  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (isExecutable(candidate)) return canonicalPath(candidate);
  }
  return null;
}

export function checkCommand(
  executable: string,
  args: string[],
  commandName = "command",
): string | null {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.error) {
    const detail = rustIoError(result.error);
    return commandName === "tmux" ? `could not run tmux: ${detail}` : detail;
  }
  if (result.status === 0) return null;
  const detail = result.stderr.trim();
  if (detail) return detail;
  const signalNumber = result.signal
    ? Object.entries(osConstants.signals).find(([name]) => name === result.signal)?.[1]
    : undefined;
  const failure = result.signal
    ? `signal: ${signalNumber ?? "?"} (${result.signal})`
    : `exit status: ${result.status ?? 1}`;
  return `${commandName} exited with ${failure}`;
}

function rustIoError(error: Error): string {
  const systemError = error as NodeJS.ErrnoException;
  const detailByCode: Record<string, string> = {
    E2BIG: "Argument list too long",
    EACCES: "Permission denied",
    EAGAIN: "Resource temporarily unavailable",
    EBADF: "Bad file descriptor",
    EEXIST: "File exists",
    EFAULT: "Bad address",
    EFBIG: "File too large",
    EINTR: "Interrupted system call",
    EINVAL: "Invalid argument",
    EIO: "Input/output error",
    EISDIR: "Is a directory",
    EMFILE: "Too many open files",
    ENAMETOOLONG: "File name too long",
    ENFILE: "Too many open files in system",
    ENOENT: "No such file or directory",
    ENOEXEC: "Exec format error",
    ENOMEM: "Cannot allocate memory",
    ENOTDIR: "Not a directory",
    ETXTBSY: "Text file busy",
  };
  const detail = systemError.code ? detailByCode[systemError.code] : undefined;
  return detail && typeof systemError.errno === "number"
    ? `${detail} (os error ${Math.abs(systemError.errno)})`
    : error.message;
}

function isExecutable(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function canonicalPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

export function dependencyStatus(
  key: string,
  label: string,
  state: DependencyState,
  executablePath: string | null,
  message: string,
  action: string | null,
): DependencyStatus {
  return { key, label, state, executablePath, message, action };
}
