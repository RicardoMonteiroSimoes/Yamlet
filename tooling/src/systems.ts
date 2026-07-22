// `yamlet systems` — discover existing system definitions.
//
// A *system* is the service a spec belongs to; multiple `.yamlet.yaml` files may
// share one `system:` slug, each describing a different functionality *scope* of
// that service (e.g. a send-with-attachment scope, a send-plain scope, and a
// connection scope all under `e-mail-sending-service`). This command walks a
// directory for spec files, reads each one's `system`/`topic`/`summary` (and, with
// `--contracts`, its exposed contract with labelled inputs and outputs) through the same
// flattener the verifier uses, and groups them by system so an author can decide
// whether a new spec is a new scope of an existing system or a new one — and, when
// composing, which scope's contract to wire as a member.
//
// Read-only: it never writes. Exit codes: 0 ok · 2 usage/path error.

import type { CmdResult, Command } from "./types.ts";
import { flatten } from "./flatten.ts";

/** The exposed contract of a scope: its signature, not a schema. */
export interface Contract {
  name: string;
  inputs: string[];
  outputs: string[];
}
export interface Scope {
  file: string;
  topic: string;
  summary: string;
  // Present only when contracts were requested; `null` means the scope exposes none.
  contract?: Contract | null;
}
export interface SystemGroup {
  system: string;
  scopes: Scope[];
}

const die = (msg: string): CmdResult => ({ exitCode: 2, stdout: "", stderr: `error: ${msg}\n` });

// Recursively collect *.yamlet.yaml paths, skipping dotfiles and build dirs.
function walk(dir: string, acc: string[]): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = dir === "." ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, acc);
    } else if (e.isFile && e.name.endsWith(".yamlet.yaml")) {
      acc.push(p);
    }
  }
}

/** Every `*.yamlet.yaml` path under `root` (pre-order, deterministic). Shared with `yamlet graph`. */
export function listSpecs(root: string): string[] {
  const files: string[] = [];
  walk(root, files);
  return files;
}

// Ordered values of an indexed exposes list (`exposes.inputs[0]`, `[1]`, …).
function exposesList(
  records: readonly { path: string; value: string }[],
  key: "inputs" | "outputs",
): string[] {
  const re = new RegExp(`^exposes\\.${key}\\[(\\d+)\\]$`);
  const rows: { i: number; v: string }[] = [];
  for (const r of records) {
    const m = r.path.match(re);
    if (m) rows.push({ i: Number(m[1]), v: r.value });
  }
  rows.sort((a, b) => a.i - b.i);
  return rows.map((x) => x.v);
}

/**
 * The exposed contract of a spec, read from its flattened records, or `null` when
 * it exposes none. Shared so `systems --contracts` and the `add-component` echo
 * resolve a member's signature identically.
 */
export function contractOf(records: readonly { path: string; value: string }[]): Contract | null {
  const name = records.find((r) => r.path === "exposes.name")?.value ?? "";
  if (name === "") return null;
  return { name, inputs: exposesList(records, "inputs"), outputs: exposesList(records, "outputs") };
}

/** Group every spec file under `root` by its `system:` slug (sorted, deterministic). */
export function collectSystems(root: string, opts: { contracts?: boolean } = {}): SystemGroup[] {
  const files = listSpecs(root);

  const bySystem = new Map<string, Scope[]>();
  for (const f of files) {
    let text: string;
    try {
      text = Deno.readTextFileSync(f);
    } catch {
      continue;
    }
    const { records } = flatten(text);
    const get = (path: string): string => records.find((r) => r.path === path)?.value ?? "";
    const system = get("system");
    if (system === "") continue; // no system key → not part of any group
    const scope: Scope = { file: f, topic: get("topic"), summary: get("summary") };
    if (opts.contracts) scope.contract = contractOf(records);
    const arr = bySystem.get(system) ?? [];
    arr.push(scope);
    bySystem.set(system, arr);
  }

  const groups = [...bySystem.entries()].map(([system, scopes]) => ({
    system,
    scopes: scopes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
  }));
  groups.sort((a, b) => (a.system < b.system ? -1 : a.system > b.system ? 1 : 0));
  return groups;
}

// The contract under a scope, on its own labelled lines, or "" when not requested.
// Inputs and outputs sit on separate `in:`/`out:` lines (aligned) so even a wide,
// many-socket contract stays readable and a sink reads clearly as `out: (none)`.
function contractLine(c: Contract | null | undefined): string {
  if (c === undefined) return "";
  if (c === null) return "    (no exposed contract)\n";
  const ins = c.inputs.length > 0 ? c.inputs.join(", ") : "(none)";
  const outs = c.outputs.length > 0 ? c.outputs.join(", ") : "(none)";
  return `    exposes ${c.name}\n      in:  ${ins}\n      out: ${outs}\n`;
}

function renderHumanSystems(root: string, groups: SystemGroup[]): string {
  if (groups.length === 0) return `no systems found under ${root}\n`;

  const scopeCount = groups.reduce((n, g) => n + g.scopes.length, 0);
  let s = `${groups.length} system${groups.length === 1 ? "" : "s"} across ` +
    `${scopeCount} scope file${scopeCount === 1 ? "" : "s"} under ${root}\n`;

  for (const g of groups) {
    s += `\n${g.system}  (${g.scopes.length} scope${g.scopes.length === 1 ? "" : "s"})\n`;
    const width = Math.max(...g.scopes.map((sc) => sc.file.length));
    for (const sc of g.scopes) {
      s += `  ${sc.file.padEnd(width)}  ${sc.topic}\n`;
      s += contractLine(sc.contract);
    }
  }
  return s;
}

export function runSystems(args: string[]): CmdResult {
  let format: "human" | "json" = "human";
  let root = "";
  let contracts = false;
  let system = "";
  for (const a of args) {
    if (a === "--format=json") format = "json";
    else if (a === "--format=human") format = "human";
    else if (a === "--contracts") contracts = true;
    else if (a.startsWith("--system=")) system = a.slice("--system=".length);
    else if (a.startsWith("--")) return die(`unknown flag for systems: ${a}`);
    else if (root !== "") return die(`too many arguments: ${a}`);
    else root = a;
  }
  if (root === "") root = ".";

  try {
    if (!Deno.statSync(root).isDirectory) return die(`not a directory: ${root}`);
  } catch {
    return die(`directory not found: ${root}`);
  }

  let groups = collectSystems(root, { contracts });
  if (system !== "") groups = groups.filter((g) => g.system === system);

  let stdout: string;
  if (format === "json") {
    stdout = JSON.stringify({ root, systems: groups }, null, 2) + "\n";
  } else if (system !== "" && groups.length === 0) {
    stdout = `no system '${system}' found under ${root}\n`;
  } else {
    stdout = renderHumanSystems(root, groups);
  }
  return { exitCode: 0, stdout, stderr: "" };
}

export const systemsCommand: Command = {
  name: "systems",
  summary: "list existing systems grouped by their scope files",
  help: `yamlet systems — list systems grouped by their scope files

Usage:
  yamlet systems [DIR] [--system=SLUG] [--contracts] [--format=human|json]

Arguments:
  DIR                   directory to scan for *.yamlet.yaml (default: .)

Options:
  --system=SLUG         show only the system with this slug
  --contracts           include each scope's exposed contract signature
  --format=human|json   output shape (default: human)
`,
  run: runSystems,
};
