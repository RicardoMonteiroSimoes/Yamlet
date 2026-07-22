// Correct-by-construction appender for .yamlet.yaml specs — a port of author.sh.
//
// The caller supplies semantic inputs (flags); this module owns all
// serialization, so indentation, quoting, the pattern->clause mapping, and — most
// importantly — ID allocation are guaranteed correct. IDs are generated here and
// echoed back on stdout; they are never an input.
//
// After every mutation the written file is run through the verifier as a silent
// commit gate: if a finding appears that is NOT an expected "still-in-progress"
// one, the change is rolled back (exit 3). This is the same safety net author.sh
// enforced with verify.sh.
//
// Exit codes: 0 applied · 2 usage/validation error (nothing written) · 3 the
// mutation produced an unexpected finding and was rolled back.

import type { CmdResult, Command, Finding } from "./types.ts";
import { flatten } from "./flatten.ts";
import { verifyText } from "./verify.ts";
import { type Contract, contractOf } from "./systems.ts";
import { type CompositeInfo, resolveComposite, socketKey } from "./composite.ts";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME = /^[a-z][a-z0-9_]*$/;

// ── control-flow helper: a thrown CmdError short-circuits a runner ──
class CmdError {
  constructor(public result: CmdResult) {}
}
const die = (msg: string): CmdResult => ({ exitCode: 2, stdout: "", stderr: `error: ${msg}\n` });
const fail = (msg: string): never => {
  throw new CmdError(die(msg));
};

const USAGE = `Usage:
  yamlet init FILE --system s --topic t --summary s --description d \\
                   --blast-radius low|medium|high --front internal|external
  yamlet add-component   FILE ALIAS PATH
  yamlet add-connection  FILE GROUP SOCKET=SOURCE [SOCKET=SOURCE ...]
  yamlet add-requirement FILE --description "..."
  yamlet add-criterion   FILE --rq RQ-N --pattern ubiquitous|state|event|optional|unwanted|complex \\
                   [--when ...|--if ...|--while ... (repeatable)|--where ...] \\
                   --shall "..." [--shall "..." ...] [--example "k=v;k=v" ...]
`;
const usageResult = (): CmdResult => ({ exitCode: 2, stdout: "", stderr: USAGE });

// ── serialization primitives (byte-faithful to author.sh) ──

/**
 * Quote a scalar only when the constrained YAML subset requires it: a leading
 * `{`/`[`/`"` (flow collection or quoted-scalar trigger) or an embedded ` #`
 * (would read as a trailing comment). Wrapping round-trips exactly because the
 * verifier's unquote just strips the outer pair.
 */
function q(s: string): string {
  if (s[0] === "{" || s[0] === "[" || s[0] === '"' || s.includes(" #")) return `"${s}"`;
  return s;
}

/** One `    - <item>` line per non-empty item (4-space indent, value quoted). */
function emitListItems(items: string[]): string {
  let out = "";
  for (const item of items) {
    if (item === "") continue;
    out += "    - " + q(item) + "\n";
  }
  return out;
}

/** A block-sequence mapping row from "k=v;k=v" — first pair dashed, rest aligned. */
function emitExampleRow(row: string): string {
  let out = "";
  const fields = row.split(";");
  fields.forEach((field, i) => {
    const n = field.indexOf("=");
    let k: string;
    let v: string;
    if (n >= 0) {
      k = field.slice(0, n);
      v = field.slice(n + 1);
    } else {
      k = "";
      v = field;
    }
    k = k.replace(/^ +| +$/g, "");
    v = v.replace(/^ +| +$/g, "");
    if (/^["{[]/.test(v) || / #/.test(v)) v = `"${v}"`;
    out += (i === 0 ? "    - " : "      ") + k + ": " + v + "\n";
  });
  return out;
}

// ── filesystem helpers ──
function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}
function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}
function basename(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? p : p.slice(slash + 1);
}
function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

// ── ID allocation (max existing number for a prefix; caller adds 1) ──
function maxRqNum(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/^- id: RQ-([0-9]+)/gm)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}
function maxAcNum(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/id: AC-([0-9]+)/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

// Declared exposes inputs/outputs, read back from the file the tool itself wrote,
// via the same flattener the verifier uses (so declarations resolve identically).
function declaredList(text: string, key: "inputs" | "outputs"): string[] {
  const re = new RegExp(`^exposes\\.${key}\\[[0-9]+\\]$`);
  const out: string[] = [];
  for (const rec of flatten(text).records) {
    if (re.test(rec.path)) out.push(rec.value);
  }
  return out;
}

// ── verify guard: expected "work-in-progress" findings are tolerated ──
function guardCheck(file: string, text: string): { ok: boolean; unexpected: Finding[] } {
  const { result } = verifyText(file, text);
  const unexpected = result.errors.filter((e) =>
    e.rule !== "E106" && e.rule !== "E108" && e.rule !== "E506" && e.rule !== "E511" &&
    // Composite wiring-in-progress: a just-declared member has unbound inputs (E609)
    // and a declared composite output is unfed (E610) until connections are added.
    // The final `verify` (the author skill's closing gate) is what catches a
    // genuinely under-wired composite; the mutation guard only rejects hard errors.
    e.rule !== "E609" && e.rule !== "E610" &&
    !e.message.includes("missing required top-level key: requirements") &&
    !e.message.includes("missing required field: acceptance-criteria")
  );
  return { ok: unexpected.length === 0, unexpected };
}

function renderUnexpected(findings: Finding[]): string {
  return findings.map((f) =>
    f.line > 0
      ? `${f.rule} LINE ${f.line} ${f.path}: ${f.message}`
      : `${f.rule} ${f.path}: ${f.message}`
  ).join("\n");
}

// ── argument-value getter ──
function argVal(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) fail(`${flag} needs a value`);
  return v!;
}

// ── init ──
export function runInit(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();

    let system = "";
    let topic = "";
    let summary = "";
    let description = "";
    let blast = "";
    let front = "";
    let exposeName = "";
    let exposeIntent = "";
    const inputs: string[] = [];
    const outputs: string[] = [];

    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      switch (a) {
        case "--system":
          system = argVal(args, i, a);
          i += 2;
          break;
        case "--topic":
          topic = argVal(args, i, a);
          i += 2;
          break;
        case "--summary":
          summary = argVal(args, i, a);
          i += 2;
          break;
        case "--description":
          description = argVal(args, i, a);
          i += 2;
          break;
        case "--blast-radius":
          blast = argVal(args, i, a);
          i += 2;
          break;
        case "--front":
          front = argVal(args, i, a);
          i += 2;
          break;
        case "--expose-name":
          exposeName = argVal(args, i, a);
          i += 2;
          break;
        case "--expose-intent":
          exposeIntent = argVal(args, i, a);
          i += 2;
          break;
        case "--input":
          inputs.push(argVal(args, i, a));
          i += 2;
          break;
        case "--output":
          outputs.push(argVal(args, i, a));
          i += 2;
          break;
        default:
          return die(`unknown flag for init: ${a}`);
      }
    }

    if (!basename(file).endsWith(".yamlet.yaml")) {
      return die(`file must use the .yamlet.yaml extension: ${file}`);
    }
    if (exists(file)) return die(`refusing to overwrite existing file: ${file}`);
    if (!(system && topic && summary && description && blast && front)) {
      return die("init requires --system --topic --summary --description --blast-radius --front");
    }
    if (!["low", "medium", "high"].includes(blast)) {
      return die("--blast-radius must be one of: low medium high");
    }
    if (!["internal", "external"].includes(front)) {
      return die("--front must be one of: internal external");
    }

    if (exposeName) {
      if (!exposeIntent) return die("--expose-name requires --expose-intent");
      if (!SLUG.test(exposeName)) {
        return die(
          `--expose-name must be a slug matching ^[a-z0-9]+(-[a-z0-9]+)*$: ${exposeName}`,
        );
      }
      const seenIn = new Set<string>();
      for (const inp of inputs) {
        if (!NAME.test(inp)) {
          return die(`invalid --input name '${inp}' (must match ^[a-z][a-z0-9_]*$)`);
        }
        if (seenIn.has(inp)) return die(`duplicate --input: ${inp}`);
        seenIn.add(inp);
      }
      const seenOut = new Set<string>();
      for (const out of outputs) {
        if (!NAME.test(out)) {
          return die(`invalid --output name '${out}' (must match ^[a-z][a-z0-9_]*$)`);
        }
        if (seenOut.has(out)) return die(`duplicate --output: ${out}`);
        seenOut.add(out);
      }
    } else {
      if (exposeIntent) return die("--expose-intent requires --expose-name");
      if (inputs.length > 0) return die("--input requires --expose-name");
      if (outputs.length > 0) return die("--output requires --expose-name");
    }

    let body = "";
    body += `system: ${system}\n`;
    body += `topic: ${q(topic)}\n`;
    body += `summary: ${q(summary)}\n`;
    body += "description: >-\n";
    body += `  ${description}\n`;
    body += `blast_radius: ${blast}\n`;
    body += `front: ${front}\n`;
    if (exposeName) {
      body += "exposes:\n";
      body += `  name: ${exposeName}\n`;
      body += `  intent: ${q(exposeIntent)}\n`;
      if (inputs.length > 0) {
        body += "  inputs:\n";
        for (const inp of inputs) body += `  - ${inp}\n`;
      }
      if (outputs.length > 0) {
        body += "  outputs:\n";
        for (const out of outputs) body += `  - ${out}\n`;
      }
    }
    body += "\n";
    body += "requirements:\n";

    Deno.writeTextFileSync(file, body);

    const guard = guardCheck(file, body);
    if (!guard.ok) {
      try {
        Deno.removeSync(file);
      } catch { /* best effort */ }
      return {
        exitCode: 3,
        stdout: "",
        stderr: `error: init produced an unexpected validation error (nothing written):\n${
          renderUnexpected(guard.unexpected)
        }\n`,
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-component ──

// Confirmation echo: what the just-added member obligates (all inputs must be
// wired) and offers (outputs are consumed à la carte). Same socket data as
// `systems --contracts`, so discovery and confirmation read alike.
function echoContract(alias: string, path: string, c: Contract): string {
  const ins = c.inputs.length > 0 ? c.inputs.join(", ") : "(none)";
  const outs = c.outputs.length > 0 ? c.outputs.join(", ") : "(none)";
  return `${alias}: ${path}\n` +
    `  inputs  (must all be wired): ${ins}\n` +
    `  outputs (consume as needed): ${outs}\n`;
}

// Declare a member of a composite: `- alias: path` under `components:`. Members
// come before connections and requirements (kept in that order), so the entry is
// inserted into the components block — created just before `requirements:` on the
// first member, appended to otherwise — never blindly at end of file.
export function runAddComponent(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();

    const positionals: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("--")) return die(`unknown flag for add-component: ${a}`);
      positionals.push(a);
    }
    const alias = positionals[0] ?? "";
    const path = positionals[1] ?? "";
    if (alias === "" || path === "") return die("add-component requires ALIAS and PATH");
    if (positionals.length > 2) return die(`too many arguments: ${positionals[2]}`);

    if (!isFile(file)) return die(`file not found: ${file} (run 'init' first)`);
    if (!NAME.test(alias)) {
      return die(`invalid component alias '${alias}' (must match ^[a-z][a-z0-9_]*$)`);
    }
    if (alias === "input" || alias === "output") {
      return die(`'${alias}' is a reserved connection group and cannot be a component alias`);
    }

    const backup = Deno.readTextFileSync(file);

    // Phase guard: all components precede any connection and any requirement.
    if (/^connections:/m.test(backup)) {
      return die("declare all components before connections (a connection block already exists)");
    }
    if (maxRqNum(backup) > 0) {
      return die("declare all components before requirements (a requirement already exists)");
    }

    // Duplicate alias — scoped to the components block so `- id:` rows can't collide.
    const cb = backup.match(/^components:\n((?:- .*\n)+)/m);
    const existing = cb ? [...cb[1]!.matchAll(/^- ([a-z][a-z0-9_]*):/gm)].map((m) => m[1]!) : [];
    if (existing.includes(alias)) return die(`duplicate component alias: ${alias}`);

    // The member must exist and expose a contract to be wireable.
    const dir = dirname(file);
    const resolved = path.startsWith("/") ? path : dir === "" ? path : `${dir}/${path}`;
    if (!isFile(resolved)) {
      return die(`component path does not resolve to a file: ${path} (looked at ${resolved})`);
    }
    const contract = contractOf(flatten(Deno.readTextFileSync(resolved)).records);
    if (contract === null) {
      return die(
        `component ${alias} (${path}) exposes no contract; only specs with an exposes block can be wired`,
      );
    }

    const entry = `- ${alias}: ${q(path)}\n`;
    let next: string;
    if (cb) {
      const at = cb.index! + cb[0]!.length;
      next = backup.slice(0, at) + entry + backup.slice(at);
    } else {
      const req = backup.search(/^requirements:/m);
      const anchor = req < 0 ? backup.length : req;
      next = backup.slice(0, anchor) + `components:\n${entry}\n` + backup.slice(anchor);
    }

    Deno.writeTextFileSync(file, next);
    const guard = guardCheck(file, next);
    if (!guard.ok) {
      Deno.writeTextFileSync(file, backup);
      return {
        exitCode: 3,
        stdout: "",
        stderr: `error: add-component produced an unexpected finding and was rolled back:\n${
          renderUnexpected(guard.unexpected)
        }\n`,
      };
    }
    return { exitCode: 0, stdout: echoContract(alias, path, contract), stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-connection ──

// A connection source must be a composite input (`input.NAME`) or a member OUTPUT
// (`alias.NAME`). A member input or `output.NAME` is a sink, never a source — that
// asymmetry is what fixes dataflow direction. Returns an error string, or null.
function validateSource(src: string, ownInputs: Set<string>, comp: CompositeInfo): string | null {
  const im = src.match(/^input\.([a-z][a-z0-9_]*)$/);
  if (im) {
    return ownInputs.has(im[1]!) ? null : `source input.${im[1]} is not a declared composite input`;
  }
  const am = src.match(/^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/);
  if (am) {
    const al = am[1]!, sk = am[2]!;
    if (al === "output") return `source ${src} is invalid: output.* is a sink, not a source`;
    if (!comp.memberDeclared.has(al)) return `source ${src} names unknown component alias: ${al}`;
    if (comp.memberStatus.get(al) !== "ok") {
      return `source ${src}: component ${al} exposes no usable contract`;
    }
    if (!comp.memberOutputs.get(al)?.has(sk)) {
      return `source ${src} is not a declared output of ${al} (only outputs can be sources)`;
    }
    return null;
  }
  return `source ${src} does not resolve to a composite input or a component output`;
}

// Wire a group in one shot: `<group>: { socket: source, … }` under `connections:`.
// The group is a member alias (its sockets are that member's INPUTS) or the reserved
// `output` (its sockets are declared composite outputs). A member group must bind ALL
// of that member's inputs, and the `output` group must feed ALL declared composite
// outputs, so E609/E610 can't slip past — the block is written once, atomically.
export function runAddConnection(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();

    const rest: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("--")) return die(`unknown flag for add-connection: ${a}`);
      rest.push(a);
    }
    const group = rest[0] ?? "";
    const pairArgs = rest.slice(1);
    if (group === "") return die("add-connection requires GROUP and one or more SOCKET=SOURCE");
    if (pairArgs.length === 0) {
      return die("add-connection requires at least one SOCKET=SOURCE pair");
    }

    if (!isFile(file)) return die(`file not found: ${file} (run 'init' first)`);

    const backup = Deno.readTextFileSync(file);

    // Phase guard: connections come after all components, before any requirement.
    if (maxRqNum(backup) > 0) {
      return die("add all connections before requirements (a requirement already exists)");
    }

    const { records } = flatten(backup);
    const comp = resolveComposite(file, backup, records);
    if (!comp.isComposite) {
      return die("connections require components; add-component first (a leaf cannot wire)");
    }

    // Composite's own boundary contract: valid `input.X` sources and `output` sinks.
    const own = contractOf(records) ?? { name: "", inputs: [], outputs: [] };
    const ownInputs = new Set(own.inputs);
    const ownOutputs = new Set(own.outputs);

    const isOutputGroup = group === "output";
    if (!isOutputGroup) {
      if (!comp.memberDeclared.has(group)) {
        return die(`connection group '${group}' is not a component alias or 'output'`);
      }
      if (comp.memberStatus.get(group) !== "ok") {
        return die(`component ${group} exposes no usable contract`);
      }
    }

    // Atomic per group: a group is wired in a single call.
    if (new RegExp(`^ {2}${group}:$`, "m").test(backup)) {
      return die(`connections for '${group}' already exist; wire a group in one call`);
    }

    const memberInputs = comp.memberInputs.get(group) ?? new Set<string>();
    const seen = new Set<string>();
    const wires: { socket: string; source: string }[] = [];
    for (const p of pairArgs) {
      const eq = p.indexOf("=");
      if (eq < 0) return die(`malformed pair '${p}' (expected SOCKET=SOURCE)`);
      const socket = p.slice(0, eq);
      const source = p.slice(eq + 1);
      if (!NAME.test(socket)) {
        return die(`invalid sink socket '${socket}' (must match ^[a-z][a-z0-9_]*$)`);
      }
      if (seen.has(socket)) return die(`duplicate sink socket in this call: ${socket}`);
      seen.add(socket);

      if (isOutputGroup) {
        if (!ownOutputs.has(socket)) {
          return die(`sink output.${socket} is not a declared composite output`);
        }
      } else if (!memberInputs.has(socket)) {
        return die(`sink ${group}.${socket} is not a declared input of ${group}`);
      }

      const srcErr = validateSource(source, ownInputs, comp);
      if (srcErr) return die(srcErr);
      wires.push({ socket, source });
    }

    // Completeness — bind every member input / feed every composite output, here.
    if (isOutputGroup) {
      if (ownOutputs.size === 0) return die("the composite declares no outputs to feed");
      const missing = [...ownOutputs].filter((o) => !seen.has(o)).sort();
      if (missing.length > 0) {
        return die(`feed every composite output in one call; missing: ${missing.join(", ")}`);
      }
    } else {
      const missing = [...memberInputs].filter((s) => !seen.has(s)).sort();
      if (missing.length > 0) {
        return die(`bind every input of ${group} in one call; missing: ${missing.join(", ")}`);
      }
    }

    let block = `  ${group}:\n`;
    for (const w of wires) block += `    ${w.socket}: ${w.source}\n`;

    let next: string;
    const cb = backup.match(/^connections:\n((?: {2}.*\n)+)/m);
    if (cb) {
      const at = cb.index! + cb[0]!.length;
      next = backup.slice(0, at) + block + backup.slice(at);
    } else {
      const req = backup.search(/^requirements:/m);
      const anchor = req < 0 ? backup.length : req;
      next = backup.slice(0, anchor) + `connections:\n${block}\n` + backup.slice(anchor);
    }

    Deno.writeTextFileSync(file, next);
    const guard = guardCheck(file, next);
    if (!guard.ok) {
      Deno.writeTextFileSync(file, backup);
      return {
        exitCode: 3,
        stdout: "",
        stderr: `error: add-connection produced an unexpected finding and was rolled back:\n${
          renderUnexpected(guard.unexpected)
        }\n`,
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-requirement ──
export function runAddRequirement(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();

    let description = "";
    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      if (a === "--description") {
        description = argVal(args, i, a);
        i += 2;
      } else {
        return die(`unknown flag for add-requirement: ${a}`);
      }
    }

    if (!isFile(file)) return die(`file not found: ${file} (run 'init' first)`);
    if (!description) return die("add-requirement requires --description");

    const backup = Deno.readTextFileSync(file);

    // Phase guard (composite): a composite must be fully wired before it enters
    // the requirements phase. Once any requirement exists, add-component and
    // add-connection are both refused, so an unbound member input (E609) or an
    // unfed composite output (E610) left now would be *permanently* unfixable
    // through the tool. Refuse here — mirroring the symmetric guards elsewhere —
    // rather than trapping the file. Nothing is written.
    const { records } = flatten(backup);
    if (resolveComposite(file, backup, records).isComposite) {
      const wiring = verifyText(file, backup).result.errors.filter(
        (e) => e.rule === "E609" || e.rule === "E610",
      );
      if (wiring.length > 0) {
        return die(
          "finish wiring the composite before adding requirements — unbound member " +
            "inputs / unfed outputs cannot be fixed once a requirement exists:\n" +
            renderUnexpected(wiring),
        );
      }
    }

    const rqid = `RQ-${maxRqNum(backup) + 1}`;

    let block = "";
    block += `- id: ${rqid}\n`;
    block += "  description: >-\n";
    block += `    ${description}\n`;
    block += "  acceptance-criteria:\n";

    const next = backup + block;
    Deno.writeTextFileSync(file, next);

    const guard = guardCheck(file, next);
    if (!guard.ok) {
      Deno.writeTextFileSync(file, backup);
      return {
        exitCode: 3,
        stdout: "",
        stderr: `error: add-requirement produced an unexpected finding and was rolled back:\n${
          renderUnexpected(guard.unexpected)
        }\n`,
      };
    }
    return { exitCode: 0, stdout: `${rqid}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-criterion ──
export function runAddCriterion(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();

    let rq = "";
    let pattern = "";
    let when = "";
    let ifClause = "";
    let where = "";
    const whiles: string[] = [];
    const shalls: string[] = [];
    const examples: string[] = [];

    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      switch (a) {
        case "--rq":
          rq = argVal(args, i, a);
          i += 2;
          break;
        case "--pattern":
          pattern = argVal(args, i, a);
          i += 2;
          break;
        case "--when":
          when = argVal(args, i, a);
          i += 2;
          break;
        case "--if":
          ifClause = argVal(args, i, a);
          i += 2;
          break;
        case "--where":
          where = argVal(args, i, a);
          i += 2;
          break;
        case "--while":
          whiles.push(argVal(args, i, a));
          i += 2;
          break;
        case "--shall":
          shalls.push(argVal(args, i, a));
          i += 2;
          break;
        case "--example":
          examples.push(argVal(args, i, a));
          i += 2;
          break;
        default:
          return die(`unknown flag for add-criterion: ${a}`);
      }
    }

    if (!isFile(file)) return die(`file not found: ${file} (run 'init' first)`);
    if (!rq) return die("add-criterion requires --rq RQ-N");
    if (!pattern) return die("add-criterion requires --pattern");
    if (shalls.length === 0) return die("add-criterion requires at least one --shall");

    const text = Deno.readTextFileSync(file);

    // --rq must be the most recently added requirement.
    const wantMatch = rq.match(/([0-9]+)$/);
    const want = wantMatch ? wantMatch[1]! : "";
    const last = maxRqNum(text);
    if (last === 0) return die("no requirements yet; add a requirement before its criteria");
    if (!want) return die(`invalid --rq value: ${rq} (expected RQ-N)`);
    if (Number(want) !== last) {
      return die(
        `criteria can only be added to the most recent requirement (RQ-${last}).\n` +
          `Attaching to an earlier requirement (${rq}) is not supported in this version:\n` +
          `that would require EDITING an existing block, which is out of scope for now.`,
      );
    }

    const hasWhile = whiles.length > 0;
    const hasWhen = when !== "";
    const hasIf = ifClause !== "";
    const hasWhere = where !== "";

    // Pattern -> clause rules (mirrors the verifier; rejects at construction time).
    switch (pattern) {
      case "ubiquitous":
        if (hasWhile || hasWhen || hasIf || hasWhere) {
          return die(
            "pattern=ubiquitous allows no trigger/condition clause (no --while/--when/--if/--where)",
          );
        }
        break;
      case "state":
        if (!hasWhile) return die("pattern=state requires --while");
        if (hasWhen || hasIf || hasWhere) return die("pattern=state allows only --while");
        break;
      case "event":
        if (!hasWhen) return die("pattern=event requires --when");
        if (hasWhile || hasIf || hasWhere) return die("pattern=event allows only --when");
        break;
      case "optional":
        if (!hasWhere) return die("pattern=optional requires --where");
        if (hasWhile || hasWhen || hasIf) return die("pattern=optional allows only --where");
        break;
      case "unwanted":
        if (!hasIf) return die("pattern=unwanted requires --if");
        if (hasWhile || hasWhen || hasWhere) return die("pattern=unwanted allows only --if");
        break;
      case "complex":
        if (!hasWhile) return die("pattern=complex requires --while");
        if (hasWhere) return die("pattern=complex does not allow --where");
        if (hasWhen && hasIf) {
          return die("pattern=complex needs exactly one of --when/--if, not both");
        }
        if (!hasWhen && !hasIf) return die("pattern=complex needs exactly one of --when/--if");
        break;
      default:
        return die("pattern must be one of: ubiquitous state event optional unwanted complex");
    }

    // Classify every {token} across clause/shall text.
    const tokenSources = [...whiles, ...shalls, when, ifClause, where];
    const tokens = new Set<string>();
    for (const src of tokenSources) {
      for (const m of src.matchAll(/\{[^}]*\}/g)) {
        tokens.add(m[0].slice(1, -1));
      }
    }
    const placeholders: string[] = [];
    const inputRefs: string[] = [];
    const outputRefs: string[] = [];
    const memberRefs: string[] = []; // {alias.socket} — composite member references
    for (const tok of [...tokens].sort()) {
      if (tok === "") continue;
      if (tok.startsWith("input.")) {
        const nm = tok.slice("input.".length);
        if (!NAME.test(nm)) {
          return die(`invalid input reference {input.${nm}} (name must match ^[a-z][a-z0-9_]*$)`);
        }
        if (!inputRefs.includes(nm)) inputRefs.push(nm);
      } else if (tok.startsWith("output.")) {
        const nm = tok.slice("output.".length);
        if (!NAME.test(nm)) {
          return die(
            `invalid output reference {output.${nm}} (name must match ^[a-z][a-z0-9_]*$)`,
          );
        }
        if (!outputRefs.includes(nm)) outputRefs.push(nm);
      } else if (/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(tok)) {
        // A dotted token whose prefix is not `input`/`output` is a member
        // reference {alias.socket}; it resolves against a member's contract
        // (validated below) and — like input/output refs — needs no examples row.
        if (!memberRefs.includes(tok)) memberRefs.push(tok);
      } else {
        if (!NAME.test(tok)) {
          return die(`invalid placeholder {${tok}} (must match ^[a-z][a-z0-9_]*$)`);
        }
        if (!placeholders.includes(tok)) placeholders.push(tok);
      }
    }

    // Every {input.X} / {output.X} must reference something declared at init.
    if (inputRefs.length > 0) {
      const declared = declaredList(text, "inputs");
      for (const nm of inputRefs) {
        if (!declared.includes(nm)) {
          return die(
            `criterion references {input.${nm}} but '${nm}' is not a declared exposes input.\n` +
              `Declare it at init (--input ${nm}); adding inputs to an existing contract is out of scope for now.`,
          );
        }
      }
    }
    if (outputRefs.length > 0) {
      const declared = declaredList(text, "outputs");
      for (const nm of outputRefs) {
        if (!declared.includes(nm)) {
          return die(
            `criterion references {output.${nm}} but '${nm}' is not a declared exposes output.\n` +
              `Declare it at init (--output ${nm}); adding outputs to an existing contract is out of scope for now.`,
          );
        }
      }
    }

    // Every {alias.socket} must resolve to a real socket of a declared member
    // (mirrors the verifier's E604). Only composites have members, so a member
    // reference on a leaf is a construction error, not a hard rollback.
    if (memberRefs.length > 0) {
      const comp = resolveComposite(file, text, flatten(text).records);
      if (!comp.isComposite) {
        return die(
          `criterion references {${memberRefs[0]}} but this spec declares no components; ` +
            `member references are only valid on a composite`,
        );
      }
      for (const ref of memberRefs) {
        const dot = ref.indexOf(".");
        const al = ref.slice(0, dot);
        const sk = ref.slice(dot + 1);
        if (!comp.memberDeclared.has(al)) {
          return die(`criterion references {${ref}} but '${al}' is not a declared component alias`);
        }
        if (comp.memberStatus.get(al) !== "ok") {
          return die(
            `criterion references {${ref}} but component '${al}' exposes no usable contract`,
          );
        }
        if (!comp.sockets.has(socketKey(al, sk))) {
          return die(
            `criterion references {${ref}} but '${sk}' is not a declared input or output of '${al}'`,
          );
        }
      }
    }

    // Placeholder/examples consistency (mirrors E401/E402).
    if (examples.length > 0) {
      if (placeholders.length === 0 && inputRefs.length === 0) {
        return die(
          "--example rows were given but no {placeholder} or {input.X} appears in any clause or shall",
        );
      }
      const msg = validateExamples(examples, placeholders, inputRefs);
      if (msg !== "") return die(msg);
    } else if (placeholders.length > 0) {
      return die(
        `criterion uses placeholders (${placeholders.join(" ")}) but no --example rows were given`,
      );
    }

    const backup = text;
    const acid = `AC-${maxAcNum(text) + 1}`;

    let block = "";
    block += `  - id: ${acid}\n`;
    block += `    pattern: ${pattern}\n`;
    switch (pattern) {
      case "state":
        block += "    while:\n";
        block += emitListItems(whiles);
        break;
      case "event":
        block += `    when: ${q(when)}\n`;
        break;
      case "unwanted":
        block += `    if: ${q(ifClause)}\n`;
        break;
      case "optional":
        block += `    where: ${q(where)}\n`;
        break;
      case "complex":
        block += "    while:\n";
        block += emitListItems(whiles);
        block += hasWhen ? `    when: ${q(when)}\n` : `    if: ${q(ifClause)}\n`;
        break;
    }
    block += "    shall:\n";
    block += emitListItems(shalls);
    if (examples.length > 0) {
      block += "    examples:\n";
      for (const row of examples) {
        if (row === "") continue;
        block += emitExampleRow(row);
      }
    }

    const next = backup + block;
    Deno.writeTextFileSync(file, next);

    const guard = guardCheck(file, next);
    if (!guard.ok) {
      Deno.writeTextFileSync(file, backup);
      return {
        exitCode: 3,
        stdout: "",
        stderr: `error: add-criterion produced an unexpected finding and was rolled back:\n${
          renderUnexpected(guard.unexpected)
        }\n`,
      };
    }
    return { exitCode: 0, stdout: `${acid}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

/**
 * Validate example rows against the criterion's placeholders and input refs.
 * Returns "" when consistent, or a (possibly multi-line) human message. Mirrors
 * author.sh's validate_examples awk.
 */
function validateExamples(
  examples: string[],
  placeholders: string[],
  inputRefs: string[],
): string {
  const ph = new Set(placeholders);
  const ir = new Set(inputRefs);
  const rows = examples.filter((r) => r !== "");
  const present = new Set<string>(); // `${rowIndex}\0${key}`
  const allKeys = new Set<string>();
  const msgs: string[] = [];

  rows.forEach((row, r) => {
    const rowNum = r + 1;
    for (const pair of row.split(";")) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const key = pair.slice(0, eq).replace(/^ +| +$/g, "");
      if (key === "") continue;
      present.add(`${rowNum}\0${key}`);
      allKeys.add(key);
      if (key.startsWith("input.")) {
        const nm = key.slice("input.".length);
        if (!ir.has(nm)) {
          msgs.push(
            `example column input.${nm} is not referenced as {input.${nm}} in the criterion`,
          );
        }
      } else if (!ph.has(key)) {
        msgs.push(`example column ${key} is not a {${key}} placeholder used in the criterion`);
      }
    }
  });

  for (const k of [...ph].sort()) {
    for (let r = 1; r <= rows.length; r++) {
      if (!present.has(`${r}\0${k}`)) msgs.push(`example row ${r} is missing a binding for {${k}}`);
    }
  }
  for (const k of [...allKeys].sort()) {
    if (!k.startsWith("input.")) continue;
    for (let r = 1; r <= rows.length; r++) {
      if (!present.has(`${r}\0${k}`)) msgs.push(`example row ${r} is missing a binding for {${k}}`);
    }
  }

  return msgs.join("\n");
}

// ── command descriptors (name, one-line summary, full --help, runner) ──

export const initCommand: Command = {
  name: "init",
  summary: "create a new spec, correct by construction",
  help: `yamlet init — create a new spec, correct by construction

Usage:
  yamlet init FILE --system s --topic t --summary s --description d \\
              --blast-radius low|medium|high --front internal|external \\
              [--expose-name n --expose-intent i --input NAME... --output NAME...]

The tool allocates IDs; it never accepts them as input.
`,
  run: runInit,
};

export const addComponentCommand: Command = {
  name: "add-component",
  summary: "declare a composite member (echoes its contract)",
  help: `yamlet add-component — declare a member of a composite

Usage:
  yamlet add-component FILE ALIAS PATH

ALIAS   a token (^[a-z][a-z0-9_]*$) naming this member in connections;
        'input' and 'output' are reserved and rejected.
PATH    the member spec, relative to FILE's directory; it must exist and
        expose a contract (only specs with an exposes block can be wired).

Declare every component before adding connections or requirements. On success it
echoes the member's contract: all inputs must be wired; outputs are consumed as
needed. The member turns FILE into a composite — its inputs stay unbound (a
verify-time E609) until you wire them with add-connection.
`,
  run: runAddComponent,
};

export const addConnectionCommand: Command = {
  name: "add-connection",
  summary: "wire a composite member's inputs (or the composite outputs)",
  help: `yamlet add-connection — wire a group of a composite in one call

Usage:
  yamlet add-connection FILE GROUP SOCKET=SOURCE [SOCKET=SOURCE ...]

GROUP    a component alias, or the reserved 'output'.
SOCKET   the sink being fed: a member INPUT (for an alias group) or a declared
         composite output (for 'output').
SOURCE   what feeds it: 'input.NAME' (a composite input) or 'alias.NAME' (a
         member OUTPUT). A member input or 'output.NAME' is never a source.

A group is wired atomically: an alias group must bind ALL of that member's inputs
in the one call; the 'output' group must feed ALL declared composite outputs.
Wire every component before adding requirements. Member outputs are consumed à la
carte — reference the ones you want as a SOURCE; leave the rest unwired.
`,
  run: runAddConnection,
};

export const addRequirementCommand: Command = {
  name: "add-requirement",
  summary: "append a requirement to a spec (prints RQ-N)",
  help: `yamlet add-requirement — append a requirement; prints the new RQ-N

Usage:
  yamlet add-requirement FILE --description "..."
`,
  run: runAddRequirement,
};

export const addCriterionCommand: Command = {
  name: "add-criterion",
  summary: "append an acceptance criterion (prints AC-N)",
  help: `yamlet add-criterion — append an acceptance criterion; prints the new AC-N

Usage:
  yamlet add-criterion FILE --rq RQ-N --pattern P \\
    [--when ...|--if ...|--while ... (repeatable)|--where ...] \\
    --shall "..." [--shall ...] [--example "k=v;k=v" ...]
`,
  run: runAddCriterion,
};
