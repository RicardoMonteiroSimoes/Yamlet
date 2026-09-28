// `yamlet systems` — discover existing system definitions.
//
// A *system* is the service a spec belongs to; multiple `.yamlet.yaml` files may
// share one `system:` slug, each describing a different functionality *scope* of
// that service (e.g. a send-with-attachment scope, a send-plain scope, and a
// connection scope all under `e-mail-sending-service`). This command walks a
// directory for spec files, reads each one's `system`/`topic`/`summary` (with
// `--details`, the summary and description as prose; with `--contracts`, its exposed
// contract with labelled inputs and outputs) through the same flattener the verifier
// uses, and groups them by system so an author can decide whether a new spec is a new
// scope of an existing system or a new one — and, when composing, which scope's
// contract to wire as a member.
//
// `--details` exists for the reverse question: given a service, *which of its scopes
// did I mean?* Two scopes of one service routinely carry near-identical topics
// ("Send plain e-mail" / "Send e-mail with attachment"), so narrowing with
// `--system=SLUG --details` and reading the prose is how a human or an agent picks
// the right file to open before editing it.
//
// Read-only: it never writes. Exit codes: 0 ok · 2 usage/path error.

import type { CmdResult, Command } from "./types.ts";
import { flatten } from "./flatten.ts";
import { type CriterionState, criterionStates, mergeState, type SystemState } from "./state.ts";

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
  // Present only when details were requested (a topic alone rarely separates two
  // scopes of the same service; the prose is what tells them apart).
  description?: string;
  // Present only when contracts were requested; `null` means the scope exposes none.
  contract?: Contract | null;
}
export interface SystemGroup {
  system: string;
  scopes: Scope[];
  // Present only when state was requested: every stored field the system's criteria
  // read or write, and the scope pairs contending for one.
  state?: SystemState;
}

const die = (msg: string): CmdResult => ({ exitCode: 2, stdout: "", stderr: `error: ${msg}\n` });

// Recursively collect paths ending in `ext`, skipping dotfiles and build dirs.
function walk(dir: string, ext: string, acc: string[]): void {
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
      walk(p, ext, acc);
    } else if (e.isFile && e.name.endsWith(ext)) {
      acc.push(p);
    }
  }
}

/** Every path under `root` ending in `ext` (pre-order, deterministic). Shared with `yamlet trace`. */
export function listFiles(root: string, ext: string): string[] {
  const files: string[] = [];
  walk(root, ext, files);
  return files;
}

/** Every `*.yamlet.yaml` path under `root` (pre-order, deterministic). Shared with `yamlet graph`. */
export function listSpecs(root: string): string[] {
  return listFiles(root, ".yamlet.yaml");
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
export function collectSystems(
  root: string,
  opts: { contracts?: boolean; details?: boolean; state?: boolean } = {},
): SystemGroup[] {
  const files = listSpecs(root);

  const bySystem = new Map<string, Scope[]>();
  const stateBySystem = new Map<string, [string, CriterionState[]][]>();
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
    if (opts.details) scope.description = get("description");
    if (opts.contracts) scope.contract = contractOf(records);
    const arr = bySystem.get(system) ?? [];
    arr.push(scope);
    bySystem.set(system, arr);
    if (opts.state) {
      const st = stateBySystem.get(system) ?? [];
      st.push([f, criterionStates(records)]);
      stateBySystem.set(system, st);
    }
  }

  const groups: SystemGroup[] = [...bySystem.entries()].map(([system, scopes]) => {
    const g: SystemGroup = {
      system,
      scopes: scopes.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    };
    if (opts.state) {
      const st = mergeState(stateBySystem.get(system) ?? []);
      // The criterion text is the field's description; carried only under --details,
      // like a scope's prose.
      if (!opts.details) {
        for (const u of st.fields) {
          u.touches = u.touches.map(({ file, ac, access }) => ({ file, ac, access }));
        }
      }
      g.state = st;
    }
    return g;
  });
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

/** Break `text` into lines of at most `width` characters, on word boundaries. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return [];
  const lines: string[] = [];
  let line = words[0]!;
  for (const w of words.slice(1)) {
    if (line.length + 1 + w.length <= width) line += " " + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  lines.push(line);
  return lines;
}

// A labelled, wrapped prose block under a scope. Continuation lines align under
// the text rather than the label, so a multi-sentence description reads as one
// paragraph instead of a ragged list.
function prose(label: string, text: string, indent = 4): string {
  const pad = " ".repeat(label.length);
  const lead = " ".repeat(indent);
  return wrap(text, 72).map((l, i) => `${lead}${i === 0 ? label : pad}${l}\n`).join("");
}

// Summary and description under a scope, when `--details` asked for them. A topic
// is a title and two scopes of one service often have near-identical titles; the
// prose is what actually tells them apart, so anyone — or any agent — choosing
// *which* spec to open reads these rather than guessing from the filename.
// `description` is populated only under `--details`, so its presence is the flag —
// without it the default listing stays byte-for-byte what it always was.
function detailLines(sc: Scope): string {
  if (sc.description === undefined) return "";
  return prose("summary:     ", sc.summary) + prose("description: ", sc.description);
}

// The stored state of one system, when `--state` asked for it. Each field lists the
// scopes writing it (`w`) and only reading it (`r`), with their criteria. Under
// `--details` every criterion is shown with its condition and shall entries —
// the criteria are the field's description; nothing else describes it.
function stateLines(st: SystemState | undefined, details: boolean): string {
  if (st === undefined) return "";
  if (st.fields.length === 0) return "  stored state: none declared\n";
  let s = `  stored state (${st.fields.length} field${st.fields.length === 1 ? "" : "s"})\n`;
  const width = Math.max(...st.fields.map((u) => u.field.length));
  for (const u of st.fields) {
    if (details) {
      s += `    ${u.field}\n`;
      for (const t of u.touches) {
        s += `      ${t.access === "write" ? "w" : "r"}  ${t.file} ${t.ac}\n`;
        if (t.condition) s += prose("", t.condition, 9);
        for (const sh of t.shall ?? []) s += prose("shall ", sh, 9);
      }
      continue;
    }
    // One row per (access, file), its criteria joined.
    const rows: { access: string; file: string; acs: string[] }[] = [];
    for (const t of u.touches) {
      const last = rows[rows.length - 1];
      const a = t.access === "write" ? "w" : "r";
      if (last && last.access === a && last.file === t.file) last.acs.push(t.ac);
      else rows.push({ access: a, file: t.file, acs: [t.ac] });
    }
    rows.forEach((r, k) => {
      const head = k === 0 ? u.field.padEnd(width) : " ".repeat(width);
      s += `    ${head}  ${r.access}  ${r.file} ${r.acs.join(", ")}\n`;
    });
  }
  if (st.contended.length > 0) {
    s += "  contended (written by one scope, read or written by another)\n";
    st.contended.forEach((c, k) => {
      const head = k > 0 && st.contended[k - 1]!.field === c.field ? "" : c.field;
      s += `    ${head.padEnd(width)}  ${c.scopes[0]} <-> ${c.scopes[1]}\n`;
    });
  }
  return s;
}

function renderHumanSystems(root: string, groups: SystemGroup[], details: boolean): string {
  if (groups.length === 0) return `no systems found under ${root}\n`;

  const scopeCount = groups.reduce((n, g) => n + g.scopes.length, 0);
  let s = `${groups.length} system${groups.length === 1 ? "" : "s"} across ` +
    `${scopeCount} scope file${scopeCount === 1 ? "" : "s"} under ${root}\n`;

  for (const g of groups) {
    s += `\n${g.system}  (${g.scopes.length} scope${g.scopes.length === 1 ? "" : "s"})\n`;
    const width = Math.max(...g.scopes.map((sc) => sc.file.length));
    for (const sc of g.scopes) {
      s += `  ${sc.file.padEnd(width)}  ${sc.topic}\n`;
      s += detailLines(sc);
      s += contractLine(sc.contract);
    }
    s += stateLines(g.state, details);
  }
  return s;
}

export function runSystems(args: string[]): CmdResult {
  let format: "human" | "json" = "human";
  let root = "";
  let contracts = false;
  let details = false;
  let state = false;
  let system = "";
  for (const a of args) {
    if (a === "--format=json") format = "json";
    else if (a === "--format=human") format = "human";
    else if (a === "--contracts") contracts = true;
    else if (a === "--details") details = true;
    else if (a === "--state") state = true;
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

  let groups = collectSystems(root, { contracts, details, state });
  if (system !== "") groups = groups.filter((g) => g.system === system);

  let stdout: string;
  if (format === "json") {
    stdout = JSON.stringify({ root, systems: groups }, null, 2) + "\n";
  } else if (system !== "" && groups.length === 0) {
    stdout = `no system '${system}' found under ${root}\n`;
  } else {
    stdout = renderHumanSystems(root, groups, details);
  }
  return { exitCode: 0, stdout, stderr: "" };
}

export const systemsCommand: Command = {
  name: "systems",
  summary: "list existing systems grouped by their scope files",
  help: `yamlet systems — list systems grouped by their scope files

Usage:
  yamlet systems [DIR] [--system=SLUG] [--details] [--contracts] [--state]
                 [--format=human|json]

Arguments:
  DIR                   directory to scan for *.yamlet.yaml (default: .)

Options:
  --system=SLUG         show only the system with this slug
  --details             include each scope's summary and description
  --contracts           include each scope's exposed contract signature
  --state               include the stored fields the system's criteria read (r)
                        or write (w), and the contended scope pairs: two scopes
                        touching one field, at least one writing it. With
                        --details, each criterion's condition and shall entries
                        are shown: they are what the field means
  --format=human|json   output shape (default: human)

Narrowing then reading detail is the way to find a specific spec among several
scopes of one service — a topic alone rarely separates them:

  yamlet systems specs                                  # which systems exist?
  yamlet systems specs --system=e-mail-sending-service --details

Before naming a stored field in a criterion, list the ones the system already has:

  yamlet systems specs --system=lunch-poll --state
`,
  run: runSystems,
};
