// `yamlet impact` — the reverse dependency index: who consumes this spec?
//
// `composite.ts` resolves *forward* (a composite reads its members' contracts).
// This command answers the opposite question — given a spec, which composites
// declare it as a member, under which alias, and which of its sockets do they
// actually use. Nothing else in the tool can answer that, and two things need it:
//
//   1. **Editing a contract.** `exposes` is total (E609: every member input must
//      be bound), so adding an input leaves *every* parent with an unbound member
//      input, and removing an output breaks every parent that sourced it. Knowing
//      which files those are is the difference between an informed change and a
//      surprise.
//   2. **Refusing well.** A refusal that names the blocking file and the command
//      that fixes it is actionable; one that emits a rule id is not.
//
// Read-only: it never writes. Exit codes: 0 ok · 2 usage/path error.

import type { CmdResult, Command, FlatRecord } from "./types.ts";
import { flatten } from "./flatten.ts";
import { type Contract, contractOf, listSpecs } from "./systems.ts";
import { resolveComposite } from "./composite.ts";

const die = (msg: string): CmdResult => ({ exitCode: 2, stdout: "", stderr: `error: ${msg}\n` });

/** One composite that declares the target as a member. */
export interface Consumer {
  file: string;
  alias: string;
  /** Target inputs this composite binds — connection sinks under its alias group. */
  boundInputs: string[];
  /** Target outputs this composite consumes — connection sources of the form `alias.socket`. */
  usedOutputs: string[];
  /** Sockets named as `{alias.socket}` in this composite's criteria (E604 references). */
  referencedSockets: string[];
}

export interface ImpactReport {
  file: string;
  root: string;
  /** How many spec files were scanned — the search scope, stated rather than implied. */
  scanned: number;
  /** The target's own contract; `null` when it exposes none (so it cannot be wired). */
  contract: Contract | null;
  consumers: Consumer[];
}

/**
 * Canonical form of a path, for comparing a `components:` entry against the
 * target. `resolveComposite` joins the member path onto the composite's
 * directory without normalizing, so `specs/../specs/a.yamlet.yaml` and
 * `specs/a.yamlet.yaml` are the same file spelled two ways. `realPath` settles
 * it (and follows symlinks); a path that cannot be resolved falls back to itself,
 * which simply won't match — a missing member is already E603's business.
 */
function canonical(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

const sorted = (s: Iterable<string>): string[] => [...new Set(s)].sort();

/** The sockets of `alias` that `records` bind, consume, or name in prose. */
function socketUse(
  records: readonly FlatRecord[],
  alias: string,
): { bound: string[]; used: string[]; referenced: string[] } {
  const bound: string[] = [];
  const used: string[] = [];
  const referenced: string[] = [];
  const sinkPrefix = `connections.${alias}.`;
  const sourceRe = new RegExp(`^${alias}\\.([a-z][a-z0-9_]*)$`);
  const tokenRe = new RegExp(`\\{${alias}\\.([a-z][a-z0-9_]*)\\}`, "g");

  for (const r of records) {
    // A sink under this alias's group is one of the member's inputs.
    if (r.path.startsWith(sinkPrefix)) bound.push(r.path.slice(sinkPrefix.length));
    // Any connection whose source is `alias.socket` consumes one of its outputs.
    if (r.path.startsWith("connections.")) {
      const m = r.value.match(sourceRe);
      if (m) used.push(m[1]!);
    }
    // `{alias.socket}` in criterion prose — a reference, not a wire.
    for (const m of r.value.matchAll(tokenRe)) referenced.push(m[1]!);
  }
  return { bound: sorted(bound), used: sorted(used), referenced: sorted(referenced) };
}

/** Every composite under `root` that declares `target` as a member. */
export function collectImpact(target: string, root: string): ImpactReport {
  const targetKey = canonical(target);
  const targetRecords = flatten(Deno.readTextFileSync(target)).records;

  const specs = listSpecs(root);
  const consumers: Consumer[] = [];

  for (const f of specs) {
    if (canonical(f) === targetKey) continue; // a spec never consumes itself
    let text: string;
    try {
      text = Deno.readTextFileSync(f);
    } catch {
      continue;
    }
    const records = flatten(text).records;
    const comp = resolveComposite(f, text, records);
    if (!comp.isComposite) continue;

    for (const [alias, mpath] of comp.memberPath) {
      if (canonical(mpath) !== targetKey) continue;
      const use = socketUse(records, alias);
      consumers.push({
        file: f,
        alias,
        boundInputs: use.bound,
        usedOutputs: use.used,
        referencedSockets: use.referenced,
      });
    }
  }

  consumers.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0
  );

  return {
    file: target,
    root,
    scanned: specs.length,
    contract: contractOf(targetRecords),
    consumers,
  };
}

function renderHumanImpact(rep: ImpactReport): string {
  let s = `${rep.file}\n`;

  if (rep.contract === null) {
    s += "  exposes no contract — it cannot be wired as a member\n";
  } else {
    const ins = rep.contract.inputs.length > 0 ? rep.contract.inputs.join(", ") : "(none)";
    const outs = rep.contract.outputs.length > 0 ? rep.contract.outputs.join(", ") : "(none)";
    s += `  exposes ${rep.contract.name}\n    in:  ${ins}\n    out: ${outs}\n`;
  }

  const n = rep.consumers.length;
  s += `\n  scanned ${rep.scanned} spec${rep.scanned === 1 ? "" : "s"} under ${rep.root}\n\n`;

  if (n === 0) {
    s += "  no composite declares this spec as a member — its contract can change freely\n";
    return s;
  }

  s += `  ${n} composite${n === 1 ? "" : "s"} declare${
    n === 1 ? "s" : ""
  } this spec as a member:\n`;
  const width = Math.max(...rep.consumers.map((c) => c.file.length));
  for (const c of rep.consumers) {
    s += `\n    ${c.file.padEnd(width)}  as '${c.alias}'\n`;
    const row = (label: string, vals: string[]): string =>
      vals.length === 0 ? "" : `      ${label.padEnd(14)}${vals.join(", ")}\n`;
    s += row("binds inputs:", c.boundInputs);
    s += row("uses outputs:", c.usedOutputs);
    s += row("references:", c.referencedSockets.map((sk) => `{${c.alias}.${sk}}`));
  }

  // What the list means for a contract change — the reason anyone runs this.
  s += `\n  changing this contract reaches ${n} file${n === 1 ? "" : "s"}:\n` +
    "    · adding an input leaves every one of them with an unbound member input (E609)\n" +
    "    · removing an input or output breaks each consumer that binds or uses it\n" +
    "    · renaming is both at once\n";
  return s;
}

export function runImpact(args: string[]): CmdResult {
  let format: "human" | "json" = "human";
  let file = "";
  let root = "";

  for (const a of args) {
    if (a === "--format=json") format = "json";
    else if (a === "--format=human") format = "human";
    else if (a.startsWith("--")) return die(`unknown flag for impact: ${a}`);
    else if (file === "") file = a;
    else if (root === "") root = a;
    else return die(`too many arguments: ${a}`);
  }

  if (file === "") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: "Usage:\n  yamlet impact FILE [DIR] [--format=human|json]\n",
    };
  }
  try {
    if (!Deno.statSync(file).isFile) return die(`not a file: ${file}`);
  } catch {
    return die(`file not found: ${file}`);
  }
  if (root === "") root = ".";
  try {
    if (!Deno.statSync(root).isDirectory) return die(`not a directory: ${root}`);
  } catch {
    return die(`directory not found: ${root}`);
  }

  const report = collectImpact(file, root);
  const stdout = format === "json"
    ? JSON.stringify(report, null, 2) + "\n"
    : renderHumanImpact(report);
  return { exitCode: 0, stdout, stderr: "" };
}

export const impactCommand: Command = {
  name: "impact",
  summary: "list the composites that consume a spec (reverse dependency index)",
  help: `yamlet impact — who consumes this spec?

Usage:
  yamlet impact FILE [DIR] [--format=human|json]

Arguments:
  FILE                  the spec whose consumers you want
  DIR                   directory to scan for composites (default: .)

Options:
  --format=human|json   output shape (default: human)

Every 'exposes' contract is total — a composite must bind every input of every
member (E609) — so widening a contract reaches every file listed here, and
narrowing one breaks each consumer that binds or uses the socket removed. Run
this before changing an 'exposes' block, or before removing a spec.

DIR defaults to the working directory, matching 'yamlet systems'. The scanned
count is always reported: a consumer outside the scanned tree is one this
cannot see, and a list that silently missed a file would be worse than none.

Read-only. Exit: 0 always (an empty result is an answer, not an error).
`,
  run: runImpact,
};
