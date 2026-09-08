// Helpers every mutating command needs: the usage-error result, the thrown
// short-circuit, flag-value parsing, and the few path predicates. They were
// private to `author.ts` until the tech spec commands needed the same set.

import type { CmdResult, Finding } from "./types.ts";

/** A usage/validation error: exit 2, nothing written. */
export const die = (msg: string): CmdResult => ({
  exitCode: 2,
  stdout: "",
  stderr: `error: ${msg}\n`,
});

/** Thrown to short-circuit a runner with a ready `CmdResult`; runners catch it at their top. */
export class CmdError {
  constructor(public result: CmdResult) {}
}
export const fail = (msg: string): never => {
  throw new CmdError(die(msg));
};

/** The value following `args[i]` (the flag), or a usage error naming the flag. */
export function argVal(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) fail(`${flag} needs a value`);
  return v!;
}

export function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
export function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}
export function isDir(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}
export function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? p : p.slice(slash + 1);
}
export function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

/** `path` resolved against `dir` (a relative path in a file is relative to that file's directory). */
export function resolveFrom(dir: string, path: string): string {
  return path.startsWith("/") ? path : dir === "" ? path : `${dir}/${path}`;
}

/** One line per finding, the human verifier shape. */
export function renderFindings(findings: Finding[]): string {
  return findings.map((f) =>
    f.line > 0
      ? `${f.rule} LINE ${f.line} ${f.path}: ${f.message}`
      : `${f.rule} ${f.path}: ${f.message}`
  ).join("\n");
}
