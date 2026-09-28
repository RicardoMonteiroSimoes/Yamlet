// `yamlet adr` — the commands that write a decision record (`*.adr.yaml`).
//
//   yamlet adr init DIR --title T --kind K --question Q [--arises-from SPEC#ID ...] [--assumes ADR-nnnn ...]
//   yamlet adr add-force      FILE TEXT
//   yamlet adr add-basis      FILE --quantity Q --source S                      -> B-n
//   yamlet adr add-dimension  FILE --matters M [--unit U --source S [--basis B-n ...]] [--against OPT-n=TEXT ...]  -> D-n
//   yamlet adr add-option     FILE --summary S --reversibility R [--ref LABEL=LOCATOR ...] --against D-n=TEXT ...  -> OPT-n
//   yamlet adr decide         FILE OPT-n
//   yamlet adr add-obligation FILE TEXT                                         -> R-n
//   yamlet adr add-accept     FILE TEXT
//   yamlet adr add-revisit    FILE TEXT
//   yamlet adr remove         FILE B-n|D-n|OPT-n|R-n | --force N | --accept N | --revisit N
//   yamlet adr replace        FILE <id or --force/--accept/--revisit N> <the flags or TEXT its add-* takes>
//   yamlet adr accept         FILE [--date YYYY-MM-DD]
//   yamlet adr reject         FILE --reason TEXT [--date YYYY-MM-DD]
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
//   - Phase order. `basis` before `dimensions`, and no option before a
//     dimension: a basis added after a dimension would be unreferenced. A
//     dimension added after an option must judge every existing option in the
//     same call (`--against OPT-n=TEXT`), so the matrix never carries a hole.
//   - Revisable while proposed, frozen after acceptance. A proposed record is
//     a draft: `remove` drops an element, `replace` rewrites one in place
//     under the same id, so an objection is answered by revising the record,
//     not by rejecting it and starting over. Every add-*, `remove`, `replace`
//     and `decide` requires `proposed`. `accept` needs a decision and a clean
//     verify; `reject` leaves `proposed` and must say why; `supersede` leaves
//     `accepted`. Nothing else ever changes an accepted record — a decision is
//     revised by writing the next one.
//
// Ids in a proposed record are local to the draft: `replace` keeps an id, and
// `remove` leaves a gap. An obligation another record cites (`ADR-nnnn#R-n`)
// can be neither removed nor replaced — that would change what the citation
// means under its author.
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
  listAdrs,
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
  yamlet adr add-dimension  FILE --matters M [--unit U --source S [--basis B-n ...]] \\
                            [--against OPT-n=TEXT ...]
  yamlet adr add-option     FILE --summary S --reversibility reversible|costly|one-way \\
                            [--ref LABEL=LOCATOR ...] --against D-n=TEXT [--against D-n=TEXT ...]
  yamlet adr decide         FILE OPT-n
  yamlet adr add-obligation FILE TEXT
  yamlet adr add-accept     FILE TEXT
  yamlet adr add-revisit    FILE TEXT
  yamlet adr remove         FILE B-n|D-n|OPT-n|R-n
  yamlet adr remove         FILE --force N | --accept N | --revisit N
  yamlet adr replace        FILE B-n   --quantity Q --source S
  yamlet adr replace        FILE D-n   --matters M [--unit U --source S [--basis B-n ...]] \\
                                       [--against OPT-n=TEXT ...]
  yamlet adr replace        FILE OPT-n --summary S --reversibility R [--ref LABEL=LOCATOR ...] \\
                                       --against D-n=TEXT [--against D-n=TEXT ...]
  yamlet adr replace        FILE R-n TEXT
  yamlet adr replace        FILE --force N TEXT | --accept N TEXT | --revisit N TEXT
  yamlet adr accept         FILE [--date D]
  yamlet adr reject         FILE --reason TEXT [--date D]
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
      rejectedBecause: "",
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

// ── the elements, as the add-* and replace commands build them ──

type Dimension = Adr["dimensions"][number];
type Option = Adr["options"][number];

/**
 * Why one cell of an option's row may not stand, or null. `row` is the whole
 * row, so an `n/a` citing another dimension as excluding the option can be
 * checked against that dimension's cell.
 */
function cellError(d: Dimension, text: string, row: Map<string, string>): string | null {
  const na = text.match(NA_CELL);
  if (na) {
    const reason = (na[1] ?? "").trim();
    if (reason === "") return `${d.id}: a bare n/a says nothing; write "n/a — <reason>"`;
    for (const m of reason.matchAll(/\bD-[0-9]+\b/g)) {
      const other = row.get(m[0]);
      if (other === undefined || NA_CELL.test(other)) {
        return `${d.id}: cites ${m[0]} as excluding the option, but the ${
          m[0]
        } cell is not substantive`;
      }
    }
  } else if (d.unit !== "" && !/[0-9]/.test(stripIds(text))) {
    return `${d.id} is measured in ${d.unit}; the cell needs a numeral: ${text}`;
  }
  return null;
}

/** The first cell of the whole matrix that may not stand, named `OPT-n/D-n`; null when it holds. */
function matrixError(adr: Adr): string | null {
  for (const o of adr.options) {
    const row = new Map(o.against.map((c) => [c.dim, c.text]));
    for (const d of adr.dimensions) {
      const text = row.get(d.id);
      if (text === undefined) return `${o.id}: no cell for ${d.id}`;
      const e = cellError(d, text, row);
      if (e !== null) return `${o.id}/${e}`;
    }
  }
  return null;
}

/** `KEY=TEXT` pairs of `--against`, keyed by what `known` holds; each key at most once. */
function cellPairs(
  values: string[],
  known: string[],
  shape: string,
  what: string,
): Map<string, string> {
  const cells = new Map<string, string>();
  for (const c of values) {
    const eq = c.indexOf("=");
    if (eq < 0) fail(`malformed --against '${c}' (expected ${shape}=TEXT)`);
    const key = c.slice(0, eq);
    const text = oneLine(c.slice(eq + 1));
    if (!known.includes(key)) {
      fail(`no such ${what}: ${key} (this record has ${known.join(", ") || "none"})`);
    }
    if (cells.has(key)) fail(`--against ${key} given twice`);
    if (text === "") fail(`--against ${key} is empty`);
    cells.set(key, text);
  }
  return cells;
}

const BASIS_FLAGS = { "--quantity": "one", "--source": "one" } as const;
const DIMENSION_FLAGS = {
  "--matters": "one",
  "--unit": "one",
  "--source": "one",
  "--basis": "many",
  "--against": "many",
} as const;
const OPTION_FLAGS = {
  "--summary": "one",
  "--reversibility": "one",
  "--ref": "many",
  "--against": "many",
} as const;

/** A basis from its flags, before the record is read. */
function basisFlags(
  flags: Record<string, string[]>,
  cmd: string,
): { quantity: string; source: string } {
  const quantity = oneLine(one(flags, "--quantity"));
  const source = oneLine(one(flags, "--source"));
  if (quantity === "" || source === "") fail(`adr ${cmd} requires --quantity and --source`);
  if (!/[0-9]/.test(quantity)) fail(`--quantity must carry a numeral, got: ${quantity}`);
  return { quantity, source };
}

/** A dimension from its flags, checked against the record's basis. */
function dimensionFrom(
  adr: Adr,
  flags: Record<string, string[]>,
  id: string,
  cmd: string,
): Dimension {
  const matters = oneLine(one(flags, "--matters"));
  const unit = oneLine(one(flags, "--unit"));
  const source = oneLine(one(flags, "--source"));
  const basis = many(flags, "--basis");
  if (matters === "") fail(`adr ${cmd} requires --matters`);
  if (unit !== "" && source === "") {
    fail("--unit needs --source: the yardstick the measure is read from");
  }
  if (unit === "" && basis.length > 0) {
    fail("--basis needs --unit: a basis states the load a measure is taken under");
  }
  if (unit !== "" && adr.basis.length > 0 && basis.length === 0) {
    fail(
      `a measured dimension must name the basis it is stated under (--basis ${
        adr.basis.map((b) => b.id).join(" | ")
      })`,
    );
  }
  const seen = new Set<string>();
  for (const b of basis) {
    if (seen.has(b)) fail(`duplicate --basis: ${b}`);
    seen.add(b);
    if (!adr.basis.some((x) => x.id === b)) {
      fail(
        `no such basis: ${b} (this record has ${adr.basis.map((x) => x.id).join(", ") || "none"})`,
      );
    }
  }
  return { id, matters, unit, source, basis };
}

/** Summary and reversibility, checked before the record is read. */
function optionHead(
  flags: Record<string, string[]>,
  cmd: string,
): { summary: string; reversibility: string } {
  const summary = oneLine(one(flags, "--summary"));
  const reversibility = one(flags, "--reversibility");
  if (summary === "") fail(`adr ${cmd} requires --summary`);
  if (!(REVERSIBILITY as readonly string[]).includes(reversibility)) {
    fail(`--reversibility must be one of: ${REVERSIBILITY.join(" ")}`);
  }
  return { summary, reversibility };
}

/** An option from its flags, judged against every declared dimension (atomic: no hole). */
function optionFrom(adr: Adr, flags: Record<string, string[]>, id: string, cmd: string): Option {
  const { summary, reversibility } = optionHead(flags, cmd);
  if (adr.dimensions.length === 0) {
    fail("declare the dimensions before the options judged against them (none exist yet)");
  }
  const refs: { label: string; locator: string }[] = [];
  for (const r of many(flags, "--ref")) {
    const eq = r.indexOf("=");
    if (eq < 0) fail(`malformed --ref '${r}' (expected LABEL=LOCATOR)`);
    const label = r.slice(0, eq);
    const locator = r.slice(eq + 1).trim();
    if (!LABEL_RE.test(label)) fail(`invalid ref label '${label}' (must match ^[a-z][a-z0-9_-]*$)`);
    if (refs.some((x) => x.label === label)) fail(`duplicate --ref label: ${label}`);
    if (!isLocator(locator)) {
      fail(`--ref ${label} must be a locator (URL, path or short citation), not prose: ${locator}`);
    }
    refs.push({ label, locator });
  }
  if (adr.kind === "selection" && refs.length === 0) {
    fail("a selection names products, so every option needs at least one --ref LABEL=LOCATOR");
  }
  const dims = adr.dimensions.map((d) => d.id);
  const cells = cellPairs(many(flags, "--against"), dims, "D-n", "dimension");
  const missing = dims.filter((d) => !cells.has(d));
  if (missing.length > 0) {
    fail(`judge the option against every dimension in one call; missing: ${missing.join(", ")}`);
  }
  for (const d of adr.dimensions) {
    const e = cellError(d, cells.get(d.id)!, cells);
    if (e !== null) fail(e);
  }
  const against = adr.dimensions.map((d) => ({ dim: d.id, text: cells.get(d.id)! }));
  return { id, summary, refs, reversibility, against };
}

/** Records in `dir`, other than `self`, whose forces cite `self#rid`. */
function citersOf(dir: string, self: string, rid: string): string[] {
  const cite = new RegExp(`\\b${self}#${rid}\\b`);
  return listAdrs(dir)
    .filter((l) => l.adr.id !== self && l.adr.forces.some((f) => cite.test(f)))
    .map((l) => l.adr.id);
}
function mustBeUncited(dir: string, adr: Adr, rid: string, what: string): void {
  const by = citersOf(dir, adr.id, rid);
  if (by.length > 0) {
    fail(
      `${adr.id}#${rid} is cited by ${by.join(", ")}; ${what} it would change what that citation ` +
        `means. Remove the citation first, or add a new obligation instead.`,
    );
  }
}

// ── add-basis ──
export function runAdrAddBasis(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(args, BASIS_FLAGS, "add-basis");
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const { quantity, source } = basisFlags(flags, "add-basis");
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
// Before any option, a dimension is just declared. After one, it is atomic
// like an option: every existing option is judged against it in the same call
// (`--against OPT-n=TEXT`), so a late dimension never leaves a hole.
export function runAdrAddDimension(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(args, DIMENSION_FLAGS, "add-dimension");
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    if (oneLine(one(flags, "--matters")) === "") return die("adr add-dimension requires --matters");
    const { adr } = load(file);
    mustBeProposed(adr, "adding a dimension");
    const id = nextId("D", adr.dimensions.map((d) => d.id));
    const dim = dimensionFrom(adr, flags, id, "add-dimension");
    const opts = adr.options.map((o) => o.id);
    const cells = cellPairs(many(flags, "--against"), opts, "OPT-n", "option");
    const missing = opts.filter((o) => !cells.has(o));
    if (missing.length > 0) {
      return die(
        `options already exist; judge every one against the new dimension in this call ` +
          `(--against OPT-n=TEXT); missing: ${missing.join(", ")}`,
      );
    }
    const next: Adr = {
      ...adr,
      dimensions: [...adr.dimensions, dim],
      options: adr.options.map((o) => ({
        ...o,
        against: [...o.against, { dim: id, text: cells.get(o.id)! }],
      })),
    };
    const bad = matrixError(next);
    if (bad !== null) return die(bad);
    const r = commit(file, "adr add-dimension", next);
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
    const { file, flags, positionals } = parseArgs(args, OPTION_FLAGS, "add-option");
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    optionHead(flags, "add-option");
    const { adr } = load(file);
    mustBeProposed(adr, "adding an option");
    const id = nextId("OPT", adr.options.map((o) => o.id));
    const opt = optionFrom(adr, flags, id, "add-option");
    const r = commit(file, "adr add-option", { ...adr, options: [...adr.options, opt] });
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

// ── remove / replace ──
// A proposed record is a draft, and a draft is revised in place: an objection
// to one dimension should cost that dimension, not the record.

const LIST_FLAGS = { "--force": "forces", "--accept": "accepts", "--revisit": "revisit" } as const;
type ListFlag = keyof typeof LIST_FLAGS;
type ListKey = (typeof LIST_FLAGS)[ListFlag];
type Target = { id: string } | { flag: ListFlag; key: ListKey; index: number };

/** What `remove`/`replace` act on: an id, or the Nth entry (1-based) of an id-less list. */
function targetOf(flags: Record<string, string[]>, positionals: string[], cmd: string): Target {
  const given = (Object.keys(LIST_FLAGS) as ListFlag[]).filter((f) => flags[f] !== undefined);
  if (given.length > 1) fail(`adr ${cmd} takes one of ${given.join(", ")}, not several`);
  const flag = given[0];
  if (flag === undefined) {
    const id = positionals.shift() ?? "";
    if (!/^(?:B|D|OPT|R)-[0-9]+$/.test(id)) {
      fail(
        `adr ${cmd} needs an id (B-n, D-n, OPT-n, R-n) or one of --force N, --accept N, --revisit N; got: ${
          id || "(nothing)"
        }`,
      );
    }
    return { id };
  }
  const n = one(flags, flag);
  if (!/^[1-9][0-9]*$/.test(n)) fail(`${flag} must be a position counted from 1, got: ${n}`);
  return { flag, key: LIST_FLAGS[flag], index: Number(n) - 1 };
}

/** The entry `t` names in its id-less list, or a refusal naming what exists. */
function listEntry(adr: Adr, t: { flag: ListFlag; key: ListKey; index: number }): void {
  const n = adr[t.key].length;
  if (t.index >= n) {
    fail(`no such entry: ${t.flag} ${t.index + 1} (this record has ${n} under ${t.key})`);
  }
}

function noSuch(kind: string, id: string, ids: string[]): never {
  return fail(`no such ${kind}: ${id} (this record has ${ids.join(", ") || "none"})`);
}

export function runAdrRemove(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(
      args,
      { "--force": "one", "--accept": "one", "--revisit": "one" },
      "remove",
    );
    if (file === "") return usageResult();
    const t = targetOf(flags, positionals, "remove");
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const { adr, dir } = load(file);
    mustBeProposed(adr, "removing");

    let next: Adr;
    if ("key" in t) {
      listEntry(adr, t);
      next = { ...adr, [t.key]: adr[t.key].filter((_, i) => i !== t.index) };
    } else if (t.id.startsWith("B-")) {
      if (!adr.basis.some((b) => b.id === t.id)) noSuch("basis", t.id, adr.basis.map((b) => b.id));
      const users = adr.dimensions.filter((d) => d.basis.includes(t.id)).map((d) => d.id);
      if (users.length > 0) {
        return die(
          `${t.id} is the basis of ${users.join(", ")}; replace ${
            users.length > 1 ? "those dimensions" : "that dimension"
          } first`,
        );
      }
      next = { ...adr, basis: adr.basis.filter((b) => b.id !== t.id) };
    } else if (t.id.startsWith("D-")) {
      if (!adr.dimensions.some((d) => d.id === t.id)) {
        noSuch("dimension", t.id, adr.dimensions.map((d) => d.id));
      }
      next = {
        ...adr,
        dimensions: adr.dimensions.filter((d) => d.id !== t.id),
        options: adr.options.map((o) => ({
          ...o,
          against: o.against.filter((c) => c.dim !== t.id),
        })),
      };
      const bad = matrixError(next);
      if (bad !== null) {
        return die(`removing ${t.id} would leave ${bad}; replace that option's cell first`);
      }
    } else if (t.id.startsWith("OPT-")) {
      if (!adr.options.some((o) => o.id === t.id)) {
        noSuch("option", t.id, adr.options.map((o) => o.id));
      }
      if (adr.decision === t.id) {
        return die(`${t.id} is the decision; decide on another option first`);
      }
      next = { ...adr, options: adr.options.filter((o) => o.id !== t.id) };
    } else {
      if (!adr.requires.some((r) => r.id === t.id)) {
        noSuch("obligation", t.id, adr.requires.map((r) => r.id));
      }
      mustBeUncited(dir, adr, t.id, "removing");
      next = { ...adr, requires: adr.requires.filter((r) => r.id !== t.id) };
    }
    return commit(file, "adr remove", next);
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// `replace` takes exactly what the element's add-* takes and rewrites it whole
// under the same id and in the same place, so `decision` and every cell keyed
// by it keep pointing at it.
export function runAdrReplace(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(args, {
      "--force": "one",
      "--accept": "one",
      "--revisit": "one",
      ...BASIS_FLAGS,
      ...DIMENSION_FLAGS,
      ...OPTION_FLAGS,
    }, "replace");
    if (file === "") return usageResult();
    const t = targetOf(flags, positionals, "replace");
    const kind = "key" in t ? "text" : t.id.replace(/-.*/, "");
    const allowed: Record<string, readonly string[]> = {
      text: ["--force", "--accept", "--revisit"],
      R: [],
      B: Object.keys(BASIS_FLAGS),
      D: Object.keys(DIMENSION_FLAGS),
      OPT: Object.keys(OPTION_FLAGS),
    };
    for (const f of Object.keys(flags)) {
      if (!allowed[kind]!.includes(f)) {
        fail(
          `${f} does not apply to replacing ${"key" in t ? `a ${t.flag.slice(2)} entry` : t.id}`,
        );
      }
    }
    const text = oneLine(positionals.join(" "));
    if (kind === "text" || kind === "R") {
      if (text === "") fail("adr replace requires TEXT");
    } else if (positionals.length > 0) fail(`too many arguments: ${positionals[0]}`);
    if (kind === "B") basisFlags(flags, "replace");
    if (kind === "OPT") optionHead(flags, "replace");
    if (kind === "text" && "key" in t && t.key === "revisit") {
      if (QUANTITY_WORD.test(text) && !/[0-9]/.test(stripIds(text))) {
        fail(`a condition naming a threshold must quantify it: ${text}`);
      }
    }
    const { adr, dir } = load(file);
    mustBeProposed(adr, "replacing");

    let next: Adr;
    if ("key" in t) {
      listEntry(adr, t);
      if (t.key === "forces") checkCitations(dir, text);
      next = { ...adr, [t.key]: adr[t.key].map((s, i) => (i === t.index ? text : s)) };
    } else if (kind === "B") {
      if (!adr.basis.some((b) => b.id === t.id)) noSuch("basis", t.id, adr.basis.map((b) => b.id));
      const b = { id: t.id, ...basisFlags(flags, "replace") };
      next = { ...adr, basis: adr.basis.map((x) => (x.id === t.id ? b : x)) };
    } else if (kind === "D") {
      if (!adr.dimensions.some((d) => d.id === t.id)) {
        noSuch("dimension", t.id, adr.dimensions.map((d) => d.id));
      }
      const dim = dimensionFrom(adr, flags, t.id, "replace");
      const cells = cellPairs(
        many(flags, "--against"),
        adr.options.map((o) => o.id),
        "OPT-n",
        "option",
      );
      next = {
        ...adr,
        dimensions: adr.dimensions.map((d) => (d.id === t.id ? dim : d)),
        options: adr.options.map((o) =>
          cells.has(o.id)
            ? {
              ...o,
              against: o.against.map((
                c,
              ) => (c.dim === t.id ? { dim: c.dim, text: cells.get(o.id)! } : c)),
            }
            : o
        ),
      };
      const bad = matrixError(next);
      if (bad !== null) {
        return die(`${bad}; re-judge that cell in the same call (--against OPT-n=TEXT)`);
      }
    } else if (kind === "OPT") {
      if (!adr.options.some((o) => o.id === t.id)) {
        noSuch("option", t.id, adr.options.map((o) => o.id));
      }
      const opt = optionFrom(adr, flags, t.id, "replace");
      next = { ...adr, options: adr.options.map((o) => (o.id === t.id ? opt : o)) };
    } else {
      if (!adr.requires.some((r) => r.id === t.id)) {
        noSuch("obligation", t.id, adr.requires.map((r) => r.id));
      }
      mustBeUncited(dir, adr, t.id, "replacing");
      next = {
        ...adr,
        requires: adr.requires.map((r) => (r.id === t.id ? { id: r.id, must: text } : r)),
      };
    }
    return commit(file, "adr replace", next);
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
// A rejected record keeps its file (the directory is the id namespace, so
// moving it out would free its id), and so it must say why it was abandoned.
export function runAdrReject(args: string[]): CmdResult {
  try {
    const { file, flags, positionals } = parseArgs(
      args,
      { "--reason": "one", "--date": "one" },
      "reject",
    );
    if (file === "") return usageResult();
    if (positionals.length > 0) return die(`too many arguments: ${positionals[0]}`);
    const reason = oneLine(one(flags, "--reason"));
    if (reason === "") return die("adr reject requires --reason: why the record was abandoned");
    const { adr } = load(file);
    mustBeProposed(adr, "rejecting");
    return commit(file, "adr reject", {
      ...adr,
      status: "rejected",
      rejectedBecause: reason,
      date: withDate(flags),
    });
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
    case "remove":
      return runAdrRemove(rest);
    case "replace":
      return runAdrReplace(rest);
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
  summary: "write or revise a decision record (.adr.yaml), correct by construction",
  help: `yamlet adr — write an architecture decision record; the tool owns every byte and id

Usage:
  yamlet adr init DIR --title T --kind K --question Q \\
                  [--arises-from SPEC.yamlet.yaml#AC-n ...] [--assumes ADR-nnnn ...] [--date D]
  yamlet adr add-force      FILE TEXT
  yamlet adr add-basis      FILE --quantity Q --source S                   -> B-n
  yamlet adr add-dimension  FILE --matters M [--unit U --source S [--basis B-n ...]] \\
                            [--against OPT-n=TEXT ...]                     -> D-n
  yamlet adr add-option     FILE --summary S --reversibility reversible|costly|one-way \\
                            [--ref LABEL=LOCATOR ...] --against D-n=TEXT ...   -> OPT-n
  yamlet adr decide         FILE OPT-n
  yamlet adr add-obligation FILE TEXT                                      -> R-n
  yamlet adr add-accept     FILE TEXT
  yamlet adr add-revisit    FILE TEXT
  yamlet adr remove         FILE B-n|D-n|OPT-n|R-n | --force N | --accept N | --revisit N
  yamlet adr replace        FILE B-n|D-n|OPT-n  <the flags its add-* takes>
  yamlet adr replace        FILE R-n TEXT | --force N TEXT | --accept N TEXT | --revisit N TEXT
  yamlet adr accept         FILE [--date D]
  yamlet adr reject         FILE --reason TEXT [--date D]
  yamlet adr supersede      FILE --by ADR-nnnn [--date D]
  yamlet verify FILE.adr.yaml

init writes DIR/ADR-nnnn-<slug>.adr.yaml (the next id in DIR) as proposed and prints
its path. A record must arise from a spec criterion or requirement, or assume a
prior record; every reference is resolved before anything is written.

Build it in phase order — forces any time; basis, then dimensions, then options
(an option is judged against every dimension in one call); then decide, and the
obligations, accepted costs and revisit conditions. --kind selection requires a
--ref on every option. A cell on a measured dimension needs a numeral; "n/a — <why>"
is allowed, a bare n/a is not. A dimension added once options exist must judge
every one of them in the same call (--against OPT-n=TEXT).

While proposed, a record is revised in place rather than rejected and restarted.
remove drops an element (a dimension takes its cells with it; the decided option,
a basis a dimension uses, and an obligation another record cites are refused).
replace rewrites one whole under the same id, taking what its add-* takes; a
replaced dimension may re-judge cells with --against OPT-n=TEXT, and must when its
new unit leaves a cell without a numeral. Entries without ids (forces, accepted
costs, revisit conditions) are addressed by position, counted from 1.

accept needs a decision and a clean verify, and freezes the record: afterwards
only supersede and its date change. reject abandons a proposed record and requires
--reason; the record stays in DIR (it holds its id) and says why.
Obligations are addressable as ADR-nnnn#R-n. A tech spec records a verdict on each
exactly as on a criterion (met with evidence, or unmet and covered by a task);
verify reports an accepted record's obligation without a verdict (E716) and an
unmet one no task covers (E715).
`,
  run: runAdr,
};
