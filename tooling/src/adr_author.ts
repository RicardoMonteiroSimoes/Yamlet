// `yamlet adr` — the commands that write a decision record (`*.adr.yaml`).
//
//   yamlet adr init DIR --title T --kind K --question Q [--arises-from SPEC#ID ...] [--assumes ADR-nnnn ...]
//   yamlet adr add-force      FILE TEXT
//   yamlet adr add-basis      FILE --quantity Q --source S                      -> B-n
//   yamlet adr add-dimension  FILE --matters M [--unit U --source S [--basis B-n ...]]   -> D-n
//   yamlet adr add-option     FILE --summary S --reversibility R [--ref LABEL=LOCATOR ...] --against D-n=TEXT ...  -> OPT-n
//   yamlet adr decide         FILE OPT-n
//   yamlet adr add-obligation FILE TEXT                                         -> R-n
//   yamlet adr add-accept     FILE TEXT
//   yamlet adr add-revisit    FILE TEXT
//   yamlet adr accept | reject FILE [--date YYYY-MM-DD]
//   yamlet adr supersede      FILE --by ADR-nnnn [--date YYYY-MM-DD]
//
// Same contract as the other authors: the caller supplies semantics, the tool
// owns every byte and mints every id, and the verifier runs as the commit gate.
// The record is rewritten whole from a parsed model on every call (canonical
// section order, prose as folded blocks), so nothing hand-written is preserved
// and nothing needs to be.
//
// Two rules of the format are enforced here rather than by `verify`, because
// they are about *history*, which a frozen file cannot show:
//
//   - Phase order. `basis` before `dimensions` before `options`: a basis added
//     after a dimension would be unreferenced, a dimension added after an
//     option would leave a hole in that option's matrix. Each is refused.
//   - Frozen after acceptance. Every add-* and `decide` requires `proposed`.
//     `accept` needs a decision and a clean verify; `reject` leaves `proposed`;
//     `supersede` leaves `accepted`. Nothing else ever changes an accepted
//     record — a decision is revised by writing the next one.
//
// Exit codes: 0 applied · 2 usage/validation error (nothing written) · 3 the
// mutation produced an unexpected finding and was not written.

import type { CmdResult, Command, Finding } from "./types.ts";
import { flatten } from "./flatten.ts";
import { compareFindings } from "./render.ts";
import { blocksOf } from "./blocks.ts";
import {
  argVal,
  basename,
  CmdError,
  die,
  dirname,
  exists,
  fail,
  isDir,
  isFile,
  renderFindings,
  resolveFrom,
} from "./cmd.ts";
import {
  type Adr,
  ADR_EXT,
  ADR_ID_RE,
  adrId,
  adrNum,
  DATE_RE,
  isLocator,
  KIND,
  maxAdrNum,
  OBLIGATION_RE,
  parseAdr,
  resolveAdr,
  REVERSIBILITY,
  serializeAdr,
  SPEC_REF_RE,
  stripIds,
  validateAdr,
} from "./adr.ts";
import { QUANTITY_WORD } from "./validate.ts";

const USAGE = `Usage:
  yamlet adr init DIR --title T --kind K --question Q \\
                  [--arises-from SPEC.yamlet.yaml#AC-n ...] [--assumes ADR-nnnn ...] [--date D]
  yamlet adr add-force      FILE TEXT
  yamlet adr add-basis      FILE --quantity Q --source S
  yamlet adr add-dimension  FILE --matters M [--unit U --source S [--basis B-n ...]]
  yamlet adr add-option     FILE --summary S --reversibility reversible|costly|one-way \\
                            [--ref LABEL=LOCATOR ...] --against D-n=TEXT [--against D-n=TEXT ...]
  yamlet adr decide         FILE OPT-n
  yamlet adr add-obligation FILE TEXT
  yamlet adr add-accept     FILE TEXT
  yamlet adr add-revisit    FILE TEXT
  yamlet adr accept         FILE [--date D]
  yamlet adr reject         FILE [--date D]
  yamlet adr supersede      FILE --by ADR-nnnn [--date D]
`;
const usageResult = (): CmdResult => ({ exitCode: 2, stdout: "", stderr: USAGE });

const LABEL_RE = /^[a-z][a-z0-9_-]*$/;
const NA_CELL = /^n\/a(?:\s*[—–-]\s*(.*))?$/;

/** Findings a proposed record carries while it is being built. */
const inProgress = (f: Finding): boolean =>
  (f.rule === "E801" && (f.path === "dimensions" || f.path === "options")) ||
  (f.rule === "E811" && f.path === "options" && f.line === 0) ||
  (f.rule === "E809" && f.path === "basis");

const today = (): string => new Date().toISOString().slice(0, 10);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
    .replace(/-+$/, "");
}

/** The next free id with the given prefix in a list of ids. */
function nextId(prefix: string, ids: string[]): string {
  let max = 0;
  for (const id of ids) {
    const n = Number(id.slice(prefix.length + 1));
    if (n > max) max = n;
  }
  return `${prefix}-${max + 1}`;
}

interface Loaded {
  adr: Adr;
  dir: string;
}

/** Read a record for mutation: it must parse and carry only in-progress findings. */
function load(file: string): Loaded {
  if (!isFile(file)) fail(`file not found: ${file} (run 'adr init' first)`);
  if (!basename(file).endsWith(ADR_EXT)) fail(`file must use the ${ADR_EXT} extension: ${file}`);
  const text = Deno.readTextFileSync(file);
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) {
    fail(
      `${file} does not parse:\n` +
        parseErrors.map((e) => `${e.rule} LINE ${e.line}: ${e.message}`).join("\n"),
    );
  }
  const v = validateAdr(file, records);
  const hard = v.findings.filter((f) => !inProgress(f)).sort(compareFindings);
  if (hard.length > 0) {
    fail(`${file} has errors; fix them before changing it:\n${renderFindings(hard)}`);
  }
  return { adr: parseAdr(records), dir: dirname(file) };
}

/** A mutation of content requires a proposed record; an accepted one is frozen. */
function mustBeProposed(adr: Adr, what: string): void {
  if (adr.status !== "proposed") {
    fail(
      `${adr.id} is ${adr.status}; ${what} is only possible while proposed. ` +
        `A decision is revised by superseding it with a new record.`,
    );
  }
}

/** Serialize, gate (tolerating in-progress findings unless `strict`), write. */
function commit(file: string, what: string, adr: Adr, strict = false): CmdResult {
  const next = serializeAdr(adr);
  const v = validateAdr(file, flatten(next).records);
  const unexpected = v.findings.filter((f) => strict || !inProgress(f)).sort(compareFindings);
  if (unexpected.length > 0) {
    return {
      exitCode: strict ? 2 : 3,
      stdout: "",
      stderr: `error: ${what} ${
        strict ? "refused" : "produced an unexpected finding"
      } (nothing written):\n${renderFindings(unexpected)}\n`,
    };
  }
  Deno.writeTextFileSync(file, next);
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** Parse `FILE` plus flags; positionals collected in order. */
function parseArgs(
  args: string[],
  spec: Record<string, "one" | "many">,
  cmd: string,
): { file: string; flags: Record<string, string[]>; positionals: string[] } {
  const file = args[0] ?? "";
  const flags: Record<string, string[]> = {};
  const positionals: string[] = [];
  let i = 1;
  while (i < args.length) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const kind = spec[a];
      if (kind === undefined) fail(`unknown flag for adr ${cmd}: ${a}`);
      const v = argVal(args, i, a);
      const list = flags[a] ?? [];
      if (kind === "one" && list.length > 0) fail(`${a} given twice`);
      list.push(v);
      flags[a] = list;
      i += 2;
    } else {
      positionals.push(a);
      i++;
    }
  }
  return { file, flags, positionals };
}
const one = (flags: Record<string, string[]>, k: string): string => flags[k]?.[0] ?? "";
const many = (flags: Record<string, string[]>, k: string): string[] => flags[k] ?? [];

/** Every `ADR-nnnn#R-n` cited in `text` must resolve in `dir`. */
function checkCitations(dir: string, text: string): void {
  for (const m of text.matchAll(/\b(ADR-[0-9]{4})#(R-[0-9]+)\b/g)) {
    const t = resolveAdr(dir, m[1]!);
    if (t === null) {
      throw new CmdError(
        die(`cites ${m[0]} but ${m[1]} does not resolve to a record in ${dir || "."}`),
      );
    }
    if (!t.adr.requires.some((o) => o.id === m[2])) {
      fail(`cites ${m[0]} but ${m[1]} declares no ${m[2]}`);
    }
  }
}

function withDate(flags: Record<string, string[]>): string {
  const d = one(flags, "--date");
  if (d === "") return today();
  if (!DATE_RE.test(d)) fail(`--date must be YYYY-MM-DD, got: ${d}`);
  return d;
}

// ── init ──
export function runAdrInit(args: string[]): CmdResult {
  try {
    const { file: dir, flags, positionals } = parseArgs(args, {
      "--title": "one",
      "--kind": "one",
      "--question": "one",
      "--arises-from": "many",
      "--assumes": "many",
      "--date": "one",
    }, "init");
    if (dir === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    if (!isDir(dir)) return die(`DIR must be an existing directory: ${dir}`);

    const title = oneLine(one(flags, "--title"));
    const kind = one(flags, "--kind");
    const question = oneLine(one(flags, "--question"));
    if (title === "" || kind === "" || question === "") {
      return die("adr init requires --title, --kind and --question");
    }
    if (!(KIND as readonly string[]).includes(kind)) {
      return die(`--kind must be one of: ${KIND.join(" ")}`);
    }
    const arisesFrom = many(flags, "--arises-from");
    const assumes = many(flags, "--assumes");
    if (arisesFrom.length + assumes.length === 0) {
      return die(
        "a record must arise from a spec (--arises-from SPEC.yamlet.yaml#AC-n) or a prior decision (--assumes ADR-nnnn)",
      );
    }
    for (const r of arisesFrom) {
      const m = r.match(SPEC_REF_RE);
      if (!m) return die(`--arises-from must be <spec>.yamlet.yaml#RQ-n|AC-n, got: ${r}`);
      const specPath = resolveFrom(dir, m[1]!);
      if (!isFile(specPath)) {
        return die(`--arises-from spec not found: ${m[1]} (looked at ${specPath})`);
      }
      const text = Deno.readTextFileSync(specPath);
      if (flatten(text).parseErrors.length > 0) {
        return die(`--arises-from spec does not parse: ${specPath}`);
      }
      if (!blocksOf(text).some((b) => b.id === m[2])) return die(`${m[1]} declares no ${m[2]}`);
    }
    const id = adrId(maxAdrNum(dir) + 1);
    for (const r of assumes) {
      if (!ADR_ID_RE.test(r)) return die(`--assumes must be an ADR id, got: ${r}`);
      if (resolveAdr(dir, r) === null) {
        return die(`--assumes ${r} does not resolve to a record in ${dir}`);
      }
    }

    const out = `${dir}/${id}-${slug(title) || "decision"}${ADR_EXT}`;
    if (exists(out)) return die(`refusing to overwrite existing file: ${out}`);

    const adr: Adr = {
      id,
      title,
      status: "proposed",
      date: withDate(flags),
      kind,
      arisesFrom,
      assumes,
      supersededBy: "",
      question,
      forces: [],
      basis: [],
      dimensions: [],
      options: [],
      decision: "",
      requires: [],
      accepts: [],
      revisit: [],
    };
    const r = commit(out, "adr init", adr);
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${out}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

/** The `FILE TEXT` shape shared by add-force / add-accept / add-revisit / add-obligation. */
function textArg(args: string[], cmd: string): { file: string; text: string } {
  const { file, flags: _f, positionals } = parseArgs(args, {}, cmd);
  if (file === "") throw new CmdError(usageResult());
  const text = oneLine(positionals.join(" "));
  if (text === "") fail(`adr ${cmd} requires TEXT`);
  return { file, text };
}

// ── add-force ──
export function runAdrAddForce(args: string[]): CmdResult {
  try {
    const { file, text } = textArg(args, "add-force");
    const { adr, dir } = load(file);
    mustBeProposed(adr, "adding a force");
    checkCitations(dir, text);
    return commit(file, "adr add-force", { ...adr, forces: [...adr.forces, text] });
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-basis ──
export function runAdrAddBasis(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(
      args,
      { "--quantity": "one", "--source": "one" },
      "add-basis",
    );
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const quantity = oneLine(one(flags, "--quantity"));
    const source = oneLine(one(flags, "--source"));
    if (quantity === "" || source === "") {
      return die("adr add-basis requires --quantity and --source");
    }
    if (!/[0-9]/.test(quantity)) return die(`--quantity must carry a numeral, got: ${quantity}`);
    const { adr } = load(file);
    mustBeProposed(adr, "adding a basis");
    if (adr.dimensions.length > 0) {
      return die(
        "declare every basis before the dimensions that are stated under it (a dimension already exists)",
      );
    }
    const id = nextId("B", adr.basis.map((b) => b.id));
    const r = commit(file, "adr add-basis", {
      ...adr,
      basis: [...adr.basis, { id, quantity, source }],
    });
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${id}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-dimension ──
export function runAdrAddDimension(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(args, {
      "--matters": "one",
      "--unit": "one",
      "--source": "one",
      "--basis": "many",
    }, "add-dimension");
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const matters = oneLine(one(flags, "--matters"));
    const unit = oneLine(one(flags, "--unit"));
    const source = oneLine(one(flags, "--source"));
    const basis = many(flags, "--basis");
    if (matters === "") return die("adr add-dimension requires --matters");
    const { adr } = load(file);
    mustBeProposed(adr, "adding a dimension");
    if (adr.options.length > 0) {
      return die(
        "declare every dimension before the options judged against them (an option already exists)",
      );
    }
    if (unit !== "" && source === "") {
      return die("--unit needs --source: the yardstick the measure is read from");
    }
    if (unit === "" && basis.length > 0) {
      return die("--basis needs --unit: a basis states the load a measure is taken under");
    }
    if (unit !== "" && adr.basis.length > 0 && basis.length === 0) {
      return die(
        `a measured dimension must name the basis it is stated under (--basis ${
          adr.basis.map((b) => b.id).join(" | ")
        })`,
      );
    }
    const seen = new Set<string>();
    for (const b of basis) {
      if (seen.has(b)) return die(`duplicate --basis: ${b}`);
      seen.add(b);
      if (!adr.basis.some((x) => x.id === b)) {
        return die(
          `no such basis: ${b} (this record has ${
            adr.basis.map((x) => x.id).join(", ") || "none"
          })`,
        );
      }
    }
    const id = nextId("D", adr.dimensions.map((d) => d.id));
    const r = commit(file, "adr add-dimension", {
      ...adr,
      dimensions: [...adr.dimensions, { id, matters, unit, source, basis }],
    });
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${id}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-option ──
// Atomic: an option is judged against every declared dimension in the one
// call, so the matrix can never carry a hole (E812) from a tool-written file.
export function runAdrAddOption(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(args, {
      "--summary": "one",
      "--reversibility": "one",
      "--ref": "many",
      "--against": "many",
    }, "add-option");
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const summary = oneLine(one(flags, "--summary"));
    const reversibility = one(flags, "--reversibility");
    if (summary === "") return die("adr add-option requires --summary");
    if (!(REVERSIBILITY as readonly string[]).includes(reversibility)) {
      return die(`--reversibility must be one of: ${REVERSIBILITY.join(" ")}`);
    }
    const { adr } = load(file);
    mustBeProposed(adr, "adding an option");
    if (adr.dimensions.length === 0) {
      return die("declare the dimensions before the options judged against them (none exist yet)");
    }

    const refs: { label: string; locator: string }[] = [];
    for (const r of many(flags, "--ref")) {
      const eq = r.indexOf("=");
      if (eq < 0) return die(`malformed --ref '${r}' (expected LABEL=LOCATOR)`);
      const label = r.slice(0, eq);
      const locator = r.slice(eq + 1).trim();
      if (!LABEL_RE.test(label)) {
        return die(`invalid ref label '${label}' (must match ^[a-z][a-z0-9_-]*$)`);
      }
      if (refs.some((x) => x.label === label)) return die(`duplicate --ref label: ${label}`);
      if (!isLocator(locator)) {
        return die(
          `--ref ${label} must be a locator (URL, path or short citation), not prose: ${locator}`,
        );
      }
      refs.push({ label, locator });
    }
    if (adr.kind === "selection" && refs.length === 0) {
      return die(
        "a selection names products, so every option needs at least one --ref LABEL=LOCATOR",
      );
    }

    const cells = new Map<string, string>();
    for (const c of many(flags, "--against")) {
      const eq = c.indexOf("=");
      if (eq < 0) return die(`malformed --against '${c}' (expected D-n=TEXT)`);
      const dim = c.slice(0, eq);
      const text = oneLine(c.slice(eq + 1));
      if (!adr.dimensions.some((d) => d.id === dim)) {
        return die(
          `no such dimension: ${dim} (this record has ${
            adr.dimensions.map((d) => d.id).join(", ")
          })`,
        );
      }
      if (cells.has(dim)) return die(`--against ${dim} given twice`);
      if (text === "") return die(`--against ${dim} is empty`);
      cells.set(dim, text);
    }
    const missing = adr.dimensions.map((d) => d.id).filter((d) => !cells.has(d));
    if (missing.length > 0) {
      return die(
        `judge the option against every dimension in one call; missing: ${missing.join(", ")}`,
      );
    }
    for (const d of adr.dimensions) {
      const text = cells.get(d.id)!;
      const na = text.match(NA_CELL);
      if (na) {
        const reason = (na[1] ?? "").trim();
        if (reason === "") return die(`${d.id}: a bare n/a says nothing; write "n/a — <reason>"`);
        for (const m of reason.matchAll(/\bD-[0-9]+\b/g)) {
          const other = cells.get(m[0]);
          if (other === undefined || NA_CELL.test(other)) {
            return die(
              `${d.id}: cites ${m[0]} as excluding the option, but the ${
                m[0]
              } cell is not substantive`,
            );
          }
        }
      } else if (d.unit !== "" && !/[0-9]/.test(stripIds(text))) {
        return die(`${d.id} is measured in ${d.unit}; the cell needs a numeral: ${text}`);
      }
    }

    const id = nextId("OPT", adr.options.map((o) => o.id));
    const against = adr.dimensions.map((d) => ({ dim: d.id, text: cells.get(d.id)! }));
    const r = commit(file, "adr add-option", {
      ...adr,
      options: [...adr.options, { id, summary, refs, reversibility, against }],
    });
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${id}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── decide ──
export function runAdrDecide(args: string[]): CmdResult {
  try {
    const { file, positionals } = parseArgs(args, {}, "decide");
    if (file === "") return usageResult();
    const opt = positionals[0] ?? "";
    if (opt === "") return die("adr decide requires OPT-n");
    if (positionals.length > 1) return die(`too many arguments: ${positionals[1]}`);
    const { adr } = load(file);
    mustBeProposed(adr, "deciding");
    if (!adr.options.some((o) => o.id === opt)) {
      return die(
        `no such option: ${opt} (this record has ${
          adr.options.map((o) => o.id).join(", ") || "none"
        })`,
      );
    }
    return commit(file, "adr decide", { ...adr, decision: opt });
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── add-obligation / add-accept / add-revisit ──
export function runAdrAddObligation(args: string[]): CmdResult {
  try {
    const { file, text } = textArg(args, "add-obligation");
    const { adr } = load(file);
    mustBeProposed(adr, "adding an obligation");
    const id = nextId("R", adr.requires.map((r) => r.id));
    const r = commit(file, "adr add-obligation", {
      ...adr,
      requires: [...adr.requires, { id, must: text }],
    });
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${id}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}
export function runAdrAddAccept(args: string[]): CmdResult {
  try {
    const { file, text } = textArg(args, "add-accept");
    const { adr } = load(file);
    mustBeProposed(adr, "adding an accepted cost");
    return commit(file, "adr add-accept", { ...adr, accepts: [...adr.accepts, text] });
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}
export function runAdrAddRevisit(args: string[]): CmdResult {
  try {
    const { file, text } = textArg(args, "add-revisit");
    if (QUANTITY_WORD.test(text) && !/[0-9]/.test(stripIds(text))) {
      return die(`a condition naming a threshold must quantify it: ${text}`);
    }
    const { adr } = load(file);
    mustBeProposed(adr, "adding a revisit condition");
    return commit(file, "adr add-revisit", { ...adr, revisit: [...adr.revisit, text] });
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── status transitions ──
export function runAdrAccept(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(args, { "--date": "one" }, "accept");
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const { adr } = load(file);
    mustBeProposed(adr, "accepting");
    if (adr.decision === "") return die(`${adr.id} names no decision; run 'adr decide' first`);
    // Strict: an accepted record tolerates nothing.
    return commit(file, "adr accept", { ...adr, status: "accepted", date: withDate(flags) }, true);
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}
export function runAdrReject(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(args, { "--date": "one" }, "reject");
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const { adr } = load(file);
    mustBeProposed(adr, "rejecting");
    return commit(file, "adr reject", { ...adr, status: "rejected", date: withDate(flags) });
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}
export function runAdrSupersede(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(
      args,
      { "--by": "one", "--date": "one" },
      "supersede",
    );
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const by = one(flags, "--by");
    if (!ADR_ID_RE.test(by)) return die("adr supersede requires --by ADR-nnnn");
    const { adr, dir } = load(file);
    if (adr.status !== "accepted") {
      return die(`${adr.id} is ${adr.status}; only an accepted record can be superseded`);
    }
    if (adrNum(by) <= adrNum(adr.id)) {
      return die(`--by must be a later record than ${adr.id}, got: ${by}`);
    }
    if (resolveAdr(dir, by) === null) {
      return die(`--by ${by} does not resolve to a record in ${dir || "."}`);
    }
    return commit(file, "adr supersede", {
      ...adr,
      status: "superseded",
      supersededBy: by,
      date: withDate(flags),
    }, true);
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── dispatch ──
export function runAdr(args: string[]): CmdResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case "init":
      return runAdrInit(rest);
    case "add-force":
      return runAdrAddForce(rest);
    case "add-basis":
      return runAdrAddBasis(rest);
    case "add-dimension":
      return runAdrAddDimension(rest);
    case "add-option":
      return runAdrAddOption(rest);
    case "decide":
      return runAdrDecide(rest);
    case "add-obligation":
      return runAdrAddObligation(rest);
    case "add-accept":
      return runAdrAddAccept(rest);
    case "add-revisit":
      return runAdrAddRevisit(rest);
    case "accept":
      return runAdrAccept(rest);
    case "reject":
      return runAdrReject(rest);
    case "supersede":
      return runAdrSupersede(rest);
    case undefined:
      return usageResult();
    default:
      return { exitCode: 2, stdout: "", stderr: `Unknown adr subcommand: ${sub}\n${USAGE}` };
  }
}

/** Referenced by the tech spec author to name obligations; re-exported for one import site. */
export { OBLIGATION_RE };

export const adrCommand: Command = {
  name: "adr",
  summary: "write a decision record (.adr.yaml), correct by construction",
  help: `yamlet adr — write an architecture decision record; the tool owns every byte and id

Usage:
  yamlet adr init DIR --title T --kind K --question Q \\
                  [--arises-from SPEC.yamlet.yaml#AC-n ...] [--assumes ADR-nnnn ...] [--date D]
  yamlet adr add-force      FILE TEXT
  yamlet adr add-basis      FILE --quantity Q --source S                   -> B-n
  yamlet adr add-dimension  FILE --matters M [--unit U --source S [--basis B-n ...]]   -> D-n
  yamlet adr add-option     FILE --summary S --reversibility reversible|costly|one-way \\
                            [--ref LABEL=LOCATOR ...] --against D-n=TEXT ...   -> OPT-n
  yamlet adr decide         FILE OPT-n
  yamlet adr add-obligation FILE TEXT                                      -> R-n
  yamlet adr add-accept     FILE TEXT
  yamlet adr add-revisit    FILE TEXT
  yamlet adr accept | reject FILE [--date D]
  yamlet adr supersede      FILE --by ADR-nnnn [--date D]
  yamlet verify FILE.adr.yaml

init writes DIR/ADR-nnnn-<slug>.adr.yaml (the next id in DIR) as proposed and prints
its path. A record must arise from a spec criterion or requirement, or assume a
prior record; every reference is resolved before anything is written.

Build it in phase order — forces any time; basis, then dimensions, then options
(an option is judged against every dimension in one call); then decide, and the
obligations, accepted costs and revisit conditions. --kind selection requires a
--ref on every option. A cell on a measured dimension needs a numeral; "n/a — <why>"
is allowed, a bare n/a is not.

accept needs a decision and a clean verify, and freezes the record: afterwards
only reject (from proposed), supersede (from accepted) and their dates change.
Obligations are addressable as ADR-nnnn#R-n; a tech spec task covers one exactly
as it covers a criterion, and verify reports an accepted record's uncovered ones.
`,
  run: runAdr,
};
