// `yamlet techspec` — the mutating commands for a tech spec (`*.techspec.yaml`).
//
//   yamlet techspec init       SPEC... [--scope SPEC#AC-N|SPEC#RQ-N ...] [--out FILE]
//   yamlet techspec analysis   FILE --commit SHA [--deep DIR ...] [--skimmed DIR ...]
//   yamlet techspec criterion  FILE --ac SPEC#AC-N --met true|false [--evidence PATH:LINE ...] [--note "..."]
//   yamlet techspec obligation FILE --of ADR-nnnn#R-n --met true|false [--evidence PATH:LINE ...] [--note "..."]
//   yamlet techspec task       FILE --title "..." [--covers SPEC#AC-N|ADR-nnnn#R-n ...] [--depends-on T-N ...] [--why "..."]
//
// Same contract as the spec author: the caller supplies semantics, the tool owns
// every byte, and after each mutation the verifier runs as the commit gate. Two
// things differ, both because a tech spec is a disposable derivation rather than
// a source of truth:
//
//   - The whole file is re-serialized on every call from a parsed model, instead
//     of splicing lines. Nothing hand-written lives in it, so there is nothing to
//     preserve, and the canonical ordering (spec order for criteria, numeric for
//     tasks) comes for free.
//   - Only tasks get ids minted here (`T-N`). Every `RQ-N`/`AC-N` is a spec's,
//     and is checked against it on the way in: a verdict for a criterion the
//     spec does not have is a usage error, not a new id.
//
// A spec is named on the command line either as the tech spec lists it or by
// any path that reaches the same file; it is always written as listed. With a
// single spec, a bare `AC-N` names its criterion.
//
// Order of use is enforced by construction: a task may only cover a criterion
// or obligation whose verdict is already recorded as unmet, and may only depend
// on a task that already exists — so the dependency graph can never contain a
// cycle, and `verify`'s E712/E714 are there for hand-edited files, not
// tool-written ones.
//
// One plan per system: `init` refuses when a tech spec of the same system
// already sits in the output directory. Two plans over one codebase are what
// duplicate its foundations.
//
// Exit codes: 0 applied · 2 usage/validation error (nothing written) · 3 the
// mutation produced an unexpected finding and was not written.

import type { CmdResult, Command, Finding } from "./types.ts";
import { flatten } from "./flatten.ts";
import { verifyFile } from "./verify.ts";
import { compareFindings } from "./render.ts";
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
} from "./cmd.ts";
import {
  COMMIT_RE,
  criteriaInScope,
  CRITERION_REF_RE,
  decidedBy,
  fileKey,
  indexSpec,
  linkedAdrs,
  parseTechspec,
  reachedObligations,
  type ResolvedSpec,
  serializeTechspec,
  SPEC_EXT,
  type SpecIndex,
  TASK_ID_RE,
  type Techspec,
  TECHSPEC_EXT,
  type TsVerdict,
  validateTechspec,
} from "./techspec.ts";
import { OBLIGATION_RE } from "./adr.ts";
import { recordAt } from "./records.ts";

const USAGE = `Usage:
  yamlet techspec init       SPEC... [--scope SPEC#AC-N|SPEC#RQ-N ...] [--out FILE]
  yamlet techspec analysis   FILE --commit SHA [--deep DIR ...] [--skimmed DIR ...]
  yamlet techspec criterion  FILE --ac SPEC#AC-N --met true|false \\
                             [--evidence PATH:LINE ...] [--note "..."]
  yamlet techspec obligation FILE --of ADR-nnnn#R-n --met true|false \\
                             [--evidence PATH:LINE ...] [--note "..."]
  yamlet techspec task       FILE --title "..." [--covers SPEC#AC-N|ADR-nnnn#R-n ...] \\
                             [--depends-on T-N ...] [--why "..."]
`;
const usageResult = (): CmdResult => ({ exitCode: 2, stdout: "", stderr: USAGE });

/**
 * Findings a tech spec carries while it is being built: no analysis yet (E701
 * on that key alone), criteria and owed obligations without a verdict yet
 * (E706, E716), unmet ones not yet covered (E715). Everything else is a hard
 * error — and since every mutation checks its input against the specs, a hard
 * error means the file was edited by hand.
 */
const inProgress = (f: Finding): boolean =>
  (f.rule === "E701" && f.path === "analysis") || f.rule === "E706" || f.rule === "E715" ||
  f.rule === "E716";

/** Newlines have no representation in a one-line scalar; fold them, as prose. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

interface Loaded {
  ts: Techspec;
  specs: ResolvedSpec[];
}

const indexesOf = (specs: readonly ResolvedSpec[]): Map<string, SpecIndex> =>
  new Map(specs.map((s) => [s.path, s.index]));

/** Read a tech spec for mutation: it must parse, and carry only in-progress findings. */
function load(file: string): Loaded {
  if (!isFile(file)) fail(`file not found: ${file} (run 'techspec init' first)`);
  if (!basename(file).endsWith(TECHSPEC_EXT)) {
    fail(`file must use the ${TECHSPEC_EXT} extension: ${file}`);
  }
  const text = Deno.readTextFileSync(file);
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) {
    fail(
      `${file} does not parse; delete it and start over:\n` +
        parseErrors.map((e) => `${e.rule} LINE ${e.line}: ${e.message}`).join("\n"),
    );
  }
  const v = validateTechspec(file, records);
  const hard = v.findings.filter((f) => !inProgress(f)).sort(compareFindings);
  if (hard.length > 0 || !v.complete) {
    throw new CmdError(die(
      `${file} has errors; a tech spec is disposable, so delete it and start over:\n` +
        renderFindings(hard),
    ));
  }
  return { ts: parseTechspec(records), specs: v.specs };
}

/** Serialize, gate, write. The gate cannot normally fire (inputs were checked), but it stays. */
function commit(file: string, what: string, ts: Techspec, specs: ResolvedSpec[]): CmdResult {
  const next = serializeTechspec(ts, indexesOf(specs));
  const v = validateTechspec(file, flatten(next).records);
  const unexpected = v.findings.filter((f) => !inProgress(f)).sort(compareFindings);
  if (unexpected.length > 0) {
    return {
      exitCode: 3,
      stdout: "",
      stderr: `error: ${what} produced an unexpected finding (nothing written):\n${
        renderFindings(unexpected)
      }\n`,
    };
  }
  Deno.writeTextFileSync(file, next);
  return { exitCode: 0, stdout: "", stderr: "" };
}

/** `target` as a path relative to `fromDir`, both resolved on disk. */
function relativePath(fromDir: string, target: string): string {
  const from = Deno.realPathSync(fromDir === "" ? "." : fromDir).split("/");
  const to = Deno.realPathSync(target).split("/");
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => ".."), ...to.slice(i)].join("/");
}

/** The listed spec `name` means: as listed, or any path reaching the same file. */
function specNamed(specs: readonly ResolvedSpec[], name: string): ResolvedSpec {
  const hit = specs.find((s) => s.path === name) ??
    specs.find((s) => isFile(name) && fileKey(s.file) === fileKey(name));
  if (hit === undefined) {
    fail(`${name} is not a spec this tech spec lists (it lists ${listed(specs)})`);
  }
  return hit!;
}
const listed = (specs: readonly ResolvedSpec[]): string => specs.map((s) => s.path).join(", ");

/**
 * A criterion named on the command line: `SPEC#AC-N`, or a bare `AC-N` when the
 * tech spec lists one spec. Returns the spec and the criterion id.
 */
function criterionNamed(
  specs: readonly ResolvedSpec[],
  ref: string,
  flag: string,
): { spec: ResolvedSpec; ac: string } {
  const m = ref.match(CRITERION_REF_RE);
  if (m !== null) return { spec: specNamed(specs, m[1]!), ac: m[2]! };
  if (/^AC-[0-9]+[a-z]?$/.test(ref)) {
    if (specs.length === 1) return { spec: specs[0]!, ac: ref };
    fail(`${flag} ${ref} is ambiguous: this tech spec lists ${listed(specs)}; write SPEC#${ref}`);
  }
  return fail(`invalid ${flag} value: ${ref} (expected SPEC#AC-N)`);
}

/** Read `--evidence` and check `--met` against it: met needs at least one. */
function checkEvidence(evidence: string[], met: string, what: string): void {
  const seen = new Set<string>();
  for (const e of evidence) {
    if (e.trim() === "") fail("an --evidence entry cannot be empty");
    if (seen.has(e)) fail(`duplicate --evidence: ${e}`);
    seen.add(e);
  }
  if (met === "true" && evidence.length === 0) {
    fail(`--met true needs at least one --evidence PATH:LINE showing where ${what} is satisfied`);
  }
}

/** The flags `criterion` and `obligation` share. */
interface VerdictArgs {
  id: string;
  met: string;
  evidence: string[];
  note: string;
}
function verdictArgs(args: string[], idFlag: string, sub: string): VerdictArgs {
  const out: VerdictArgs = { id: "", met: "", evidence: [], note: "" };
  let i = 1;
  while (i < args.length) {
    const a = args[i]!;
    if (a === idFlag) out.id = argVal(args, i, a);
    else if (a === "--met") out.met = argVal(args, i, a);
    else if (a === "--evidence") out.evidence.push(argVal(args, i, a));
    else if (a === "--note") out.note = argVal(args, i, a);
    else fail(`unknown flag for techspec ${sub}: ${a}`);
    i += 2;
  }
  if (out.met !== "true" && out.met !== "false") fail(`techspec ${sub} requires --met true|false`);
  out.note = oneLine(out.note);
  return out;
}

// ── decided behaviour ──
// A link in the spec means: this behaviour was decided, read the record before
// deciding how to meet it. The tech spec cannot hold "I read it" (a flag proves
// nothing), so the reminder is printed where the how is being written down —
// on the verdict and on the task — and the skill relays it. stderr, exit 0.

/** The notice printed when a verdict is recorded on decided behaviour. */
function decidedVerdictNotice(ts: Techspec, spec: ResolvedSpec, acId: string, met: string): string {
  const d = decidedBy(spec.index, acId);
  if (d.adrs.length === 0) return "";
  const ref = `${spec.path}#${acId}`;
  let s = `DECIDED: ${ref} is decided by an ADR (via ${d.via.join(" and ")}).\n`;
  for (const a of d.adrs) s += `  ${a}\n`;
  s += met === "true"
    ? `The evidence for ${acId} must fit these decisions.\n`
    : `The task covering ${acId} must fit these decisions, or state that one no longer holds.\n`;
  const recorded = new Set(ts.obligations.map((o) => o.id));
  const open = linkedAdrs(spec.file, d.adrs)
    .filter((l) => l.status === "accepted")
    .flatMap((l) => l.obligations)
    .filter((o) => !recorded.has(o));
  if (open.length > 0) {
    s += `Obligations without a verdict (techspec obligation): ${open.join(", ")}\n`;
  }
  return s;
}

/** The notice printed when a task covers decided behaviour: one line per decided criterion. */
function decidedTaskNotice(specs: ResolvedSpec[], taskId: string, covers: string[]): string {
  const lines: string[] = [];
  for (const c of covers) {
    const m = c.match(CRITERION_REF_RE);
    const spec = m === null ? undefined : specs.find((s) => s.path === m[1]);
    if (spec === undefined) continue;
    const d = decidedBy(spec.index, m![2]!);
    if (d.adrs.length > 0) lines.push(`  ${c}: ${d.adrs.join(", ")}`);
  }
  if (lines.length === 0) return "";
  return `DECIDED: ${taskId} covers behaviour an ADR decides.\n${lines.join("\n")}\n`;
}

// ── init ──

/** The system a tech spec in `dir` plans, keyed by its path — for the one-plan-per-system check. */
function plansIn(dir: string): { path: string; system: string }[] {
  const out: { path: string; system: string }[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir === "" ? "." : dir)];
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(TECHSPEC_EXT)) continue;
    const path = dir === "" ? e.name : `${dir}/${e.name}`;
    try {
      const system = recordAt(flatten(Deno.readTextFileSync(path)).records, "system")?.value ?? "";
      out.push({ path, system });
    } catch {
      // unreadable: not ours to judge here
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function runTechspecInit(args: string[]): CmdResult {
  try {
    const specArgs: string[] = [];
    const scopeArgs: string[] = [];
    let out = "";
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      if (a === "--out") {
        out = argVal(args, i, a);
        i += 2;
      } else if (a === "--scope") {
        scopeArgs.push(argVal(args, i, a));
        i += 2;
      } else if (a.startsWith("-")) {
        return die(`unknown flag for techspec init: ${a}`);
      } else {
        specArgs.push(a);
        i++;
      }
    }
    if (specArgs.length === 0) return usageResult();

    // Every spec is *finished* (verifies clean), declares criteria, and is listed once.
    const specs: { arg: string; index: SpecIndex; scope: string[] }[] = [];
    for (const spec of specArgs) {
      if (!isFile(spec)) return die(`spec not found: ${spec}`);
      if (!basename(spec).endsWith(SPEC_EXT)) {
        return die(`SPEC must be a ${SPEC_EXT} file: ${spec}`);
      }
      const dup = specs.find((s) => fileKey(s.arg) === fileKey(spec));
      if (dup !== undefined) return die(`${spec} is named twice (as ${dup.arg} before)`);
      const { result } = verifyFile(spec);
      if (!result.valid) {
        return die(
          `${spec} has verify errors; a tech spec is planned from finished specs:\n` +
            renderFindings(result.errors),
        );
      }
      const index = indexSpec(Deno.readTextFileSync(spec))!;
      if (index.criteria.length === 0) {
        return die(`${spec} declares no acceptance criteria; there is nothing to plan`);
      }
      specs.push({ arg: spec, index, scope: [] });
    }
    const system = specs[0]!.index.system;
    for (const s of specs) {
      if (s.index.system !== system) {
        return die(
          `one tech spec plans one system: ${
            specs[0]!.arg
          } is ${system}, ${s.arg} is ${s.index.system}`,
        );
      }
    }

    // --scope SPEC#AC-N adds a criterion, SPEC#RQ-N every criterion of that requirement.
    for (const ref of scopeArgs) {
      const hash = ref.lastIndexOf("#");
      const name = hash < 0 ? "" : ref.slice(0, hash);
      const block = hash < 0 ? ref : ref.slice(hash + 1);
      const s = name === ""
        ? (specs.length === 1 ? specs[0] : undefined)
        : specs.find((x) => x.arg === name) ??
          specs.find((x) => isFile(name) && fileKey(x.arg) === fileKey(name));
      if (s === undefined) {
        return die(
          `--scope ${ref} must name one of the specs being planned as SPEC#AC-N or SPEC#RQ-N`,
        );
      }
      let add: string[];
      if (s.index.criteria.includes(block)) add = [block];
      else if (s.index.requirements.includes(block)) {
        add = s.index.criteria.filter((c) => s.index.ownerOf.get(c) === block);
      } else {
        return die(`--scope ${ref}: ${s.arg} has no ${block}`);
      }
      for (const c of add) if (!s.scope.includes(c)) s.scope.push(c);
    }

    if (out === "") {
      const dir = dirname(specs[0]!.arg);
      out = (dir === "" ? "" : `${dir}/`) + system + TECHSPEC_EXT;
    }
    if (!basename(out).endsWith(TECHSPEC_EXT)) {
      return die(`--out must use the ${TECHSPEC_EXT} extension: ${out}`);
    }
    if (exists(out)) return die(`refusing to overwrite existing file: ${out}`);
    const outDir = dirname(out);
    if (outDir !== "" && !isDir(outDir)) return die(`directory does not exist: ${outDir}`);
    const other = plansIn(outDir).find((p) => p.system === system);
    if (other !== undefined) {
      return die(
        `${other.path} already plans ${system}; one tech spec per system — finish or delete it, ` +
          `and list every spec the change touches in one plan`,
      );
    }

    const listedSpecs = specs.map((s) => ({
      path: relativePath(outDir, s.arg),
      scope: criteriaInScope(s.index, s.scope).length === s.index.criteria.length ? [] : s.scope,
      requirements: [],
    }));
    const ts: Techspec = { system, analysis: null, specs: listedSpecs, obligations: [], tasks: [] };
    const resolved: ResolvedSpec[] = specs.map((s, k) => ({
      path: listedSpecs[k]!.path,
      file: s.arg,
      index: s.index,
      scope: listedSpecs[k]!.scope,
    }));
    const r = commit(out, "techspec init", ts, resolved);
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${out}\n`, stderr: "" };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── analysis ──
// Records what the verdicts are relative to: the commit the code was read at,
// and how much of it was read. The commit is fixed on the first call; the path
// lists accumulate, so a deepening read can be recorded as it happens.
export function runTechspecAnalysis(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();
    let commitSha = "";
    const deep: string[] = [];
    const skimmed: string[] = [];
    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      switch (a) {
        case "--commit":
          commitSha = argVal(args, i, a);
          i += 2;
          break;
        case "--deep":
          deep.push(argVal(args, i, a));
          i += 2;
          break;
        case "--skimmed":
          skimmed.push(argVal(args, i, a));
          i += 2;
          break;
        default:
          return die(`unknown flag for techspec analysis: ${a}`);
      }
    }

    const { ts, specs } = load(file);

    if (ts.analysis === null) {
      if (commitSha === "") return die("techspec analysis requires --commit on its first call");
    } else if (commitSha !== "" && commitSha !== ts.analysis.commit) {
      return die(
        `analysis is pinned to commit ${ts.analysis.commit}; a different commit means a different ` +
          `tech spec — delete this one and start over`,
      );
    }
    if (commitSha !== "" && !COMMIT_RE.test(commitSha)) {
      return die(`--commit must be 7–40 hex characters, got: ${commitSha}`);
    }
    for (const p of [...deep, ...skimmed]) {
      if (p.trim() === "") return die("an analysis path cannot be empty");
    }

    const next: Techspec = {
      ...ts,
      analysis: {
        commit: ts.analysis?.commit ?? commitSha,
        deep: [...(ts.analysis?.deep ?? [])],
        skimmed: [...(ts.analysis?.skimmed ?? [])],
      },
    };
    for (const p of deep) {
      if (next.analysis!.skimmed.includes(p)) {
        return die(`${p} is already recorded as skimmed; a path is deep or skimmed, not both`);
      }
      if (!next.analysis!.deep.includes(p)) next.analysis!.deep.push(p);
    }
    for (const p of skimmed) {
      if (next.analysis!.deep.includes(p)) {
        return die(`${p} is already recorded as deep; a path is deep or skimmed, not both`);
      }
      if (!next.analysis!.skimmed.includes(p)) next.analysis!.skimmed.push(p);
    }
    return commit(file, "techspec analysis", next, specs);
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── criterion ──
// One verdict per criterion in scope. The requirement it sits under is the
// spec's to say, so it is looked up, never passed.
export function runTechspecCriterion(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();
    const v = verdictArgs(args, "--ac", "criterion");
    if (v.id === "") return die("techspec criterion requires --ac SPEC#AC-N");

    const { ts, specs } = load(file);
    const { spec, ac } = criterionNamed(specs, v.id, "--ac");
    const owner = spec.index.ownerOf.get(ac);
    if (owner === undefined) {
      return die(
        `no such criterion in ${spec.path}: ${ac} (it has ${spec.index.criteria.join(", ")})`,
      );
    }
    const inScope = criteriaInScope(spec.index, spec.scope);
    if (!inScope.includes(ac)) {
      return die(`${spec.path}#${ac} is outside the scope (in scope: ${inScope.join(", ")})`);
    }
    const entry = ts.specs.find((s) => s.path === spec.path)!;
    if (entry.requirements.some((r) => r.criteria.some((c) => c.id === ac))) {
      return die(
        `${spec.path}#${ac} already has a verdict; a tech spec is disposable, so delete it and ` +
          `start over rather than revising a verdict in place`,
      );
    }
    checkEvidence(v.evidence, v.met, ac);

    const verdict: TsVerdict = { id: ac, met: v.met, evidence: v.evidence, note: v.note };
    const next: Techspec = {
      ...ts,
      specs: ts.specs.map((s) => {
        if (s.path !== spec.path) return s;
        const requirements = s.requirements.map((r) =>
          r.id === owner ? { ...r, criteria: [...r.criteria, verdict] } : r
        );
        if (!requirements.some((r) => r.id === owner)) {
          requirements.push({ id: owner, criteria: [verdict] });
        }
        return { ...s, requirements };
      }),
    };
    const r = commit(file, "techspec criterion", next, specs);
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: "", stderr: decidedVerdictNotice(next, spec, ac, v.met) };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── obligation ──
// One verdict per obligation the scope reaches. An obligation the code already
// discharges is met, with evidence — never a task written to say so.
export function runTechspecObligation(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();
    const v = verdictArgs(args, "--of", "obligation");
    if (v.id === "") return die("techspec obligation requires --of ADR-nnnn#R-n");
    if (!OBLIGATION_RE.test(v.id)) {
      return die(`invalid --of value: ${v.id} (expected ADR-nnnn#R-n)`);
    }

    const { ts, specs } = load(file);
    const reached = reachedObligations(specs).obligations;
    if (!reached.has(v.id)) {
      return die(
        `${v.id} is not an obligation of a record the scope links (known: ${
          [...reached.keys()].join(", ") || "none"
        })`,
      );
    }
    if (ts.obligations.some((o) => o.id === v.id)) {
      return die(
        `${v.id} already has a verdict; a tech spec is disposable, so delete it and start over ` +
          `rather than revising a verdict in place`,
      );
    }
    checkEvidence(v.evidence, v.met, v.id);

    const next: Techspec = {
      ...ts,
      obligations: [...ts.obligations, {
        id: v.id,
        met: v.met,
        evidence: v.evidence,
        note: v.note,
      }],
    };
    return commit(file, "techspec obligation", next, specs);
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── task ──
export function runTechspecTask(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();
    let title = "";
    let why = "";
    const coversArgs: string[] = [];
    const dependsOn: string[] = [];
    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      switch (a) {
        case "--title":
          title = argVal(args, i, a);
          i += 2;
          break;
        case "--covers":
          coversArgs.push(argVal(args, i, a));
          i += 2;
          break;
        case "--depends-on":
          dependsOn.push(argVal(args, i, a));
          i += 2;
          break;
        case "--why":
          why = argVal(args, i, a);
          i += 2;
          break;
        default:
          return die(`unknown flag for techspec task: ${a}`);
      }
    }
    title = oneLine(title);
    why = oneLine(why);
    if (title === "") return die("techspec task requires --title");

    const { ts, specs } = load(file);

    // Every covered id is written as the tech spec names it: SPEC#AC-N as listed, or ADR-nnnn#R-n.
    const covers: string[] = [];
    for (const c of coversArgs) {
      let ref: string;
      let verdict: string | undefined;
      if (OBLIGATION_RE.test(c)) {
        ref = c;
        verdict = ts.obligations.find((o) => o.id === c)?.met;
        if (verdict === undefined) {
          return die(
            `${c} has no verdict yet; record it with 'techspec obligation' before covering it`,
          );
        }
      } else {
        const { spec, ac } = criterionNamed(specs, c, "--covers");
        if (!spec.index.criteria.includes(ac)) {
          return die(
            `no such criterion in ${spec.path}: ${ac} (it has ${spec.index.criteria.join(", ")})`,
          );
        }
        ref = `${spec.path}#${ac}`;
        verdict = ts.specs.find((s) => s.path === spec.path)!.requirements
          .flatMap((r) => r.criteria).find((x) => x.id === ac)?.met;
        if (verdict === undefined) {
          return die(
            `${ref} has no verdict yet; record it with 'techspec criterion' before covering it`,
          );
        }
      }
      if (covers.includes(ref)) return die(`duplicate --covers: ${ref}`);
      if (verdict === "true") return die(`${ref} is already met; a task cannot cover it`);
      covers.push(ref);
    }
    if (covers.length === 0 && why === "") {
      return die("a task that covers nothing is an enabler and needs --why");
    }
    if (covers.length > 0 && why !== "") {
      return die("a task that covers criteria or obligations is justified by them; drop --why");
    }

    const known = new Set(ts.tasks.map((t) => t.id));
    const seenDep = new Set<string>();
    for (const d of dependsOn) {
      if (!TASK_ID_RE.test(d)) return die(`invalid --depends-on value: ${d} (expected T-N)`);
      if (seenDep.has(d)) return die(`duplicate --depends-on: ${d}`);
      seenDep.add(d);
      if (!known.has(d)) {
        const have = [...known].join(", ");
        return die(`no such task: ${d} (this tech spec has ${have || "none"}); add it first`);
      }
    }

    let max = 0;
    for (const t of ts.tasks) {
      const n = Number(t.id.match(/^T-([0-9]+)$/)?.[1] ?? 0);
      if (n > max) max = n;
    }
    const id = `T-${max + 1}`;
    const next: Techspec = {
      ...ts,
      tasks: [...ts.tasks, { id, title, covers, dependsOn, why }],
    };
    const r = commit(file, "techspec task", next, specs);
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${id}\n`, stderr: decidedTaskNotice(specs, id, covers) };
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── dispatch ──
export function runTechspec(args: string[]): CmdResult {
  const [sub, ...rest] = args;
  switch (sub) {
    case "init":
      return runTechspecInit(rest);
    case "analysis":
      return runTechspecAnalysis(rest);
    case "criterion":
      return runTechspecCriterion(rest);
    case "obligation":
      return runTechspecObligation(rest);
    case "task":
      return runTechspecTask(rest);
    case undefined:
      return usageResult();
    default:
      return { exitCode: 2, stdout: "", stderr: `Unknown techspec subcommand: ${sub}\n${USAGE}` };
  }
}

export const techspecCommand: Command = {
  name: "techspec",
  summary: "plan a change across a system's specs: gap analysis and task list (.techspec.yaml)",
  help: `yamlet techspec — build a tech spec: one change's gap analysis and task list

${USAGE}  yamlet verify FILE.techspec.yaml

A tech spec is derived from *finished* specs (ones that verify clean) and the
code that implements them: a verdict per acceptance criterion in scope and per
obligation the linked decisions place on it, then tasks covering every unmet
one. One tech spec plans one change across every spec it touches, all of one
system, so a shared foundation is planned once and any task can depend on any
other. It is disposable — plan from it, implement, discard; the specs and
their ADRs are what persist — so keep it out of version control.

init        lists SPEC... (one system) in <system>.techspec.yaml beside the first
            spec (or --out) and prints its path. Refuses when a tech spec of the
            same system already sits in that directory: one plan per system.
            --scope narrows a spec to the criteria a change touches (a diff of
            an existing spec): SPEC#AC-N, or SPEC#RQ-N for all its criteria. A
            spec with no --scope is in scope whole.
analysis    pins the commit the code was read at; --deep/--skimmed accumulate the
            paths read closely or only glanced at. Paths are recorded, not checked.
criterion   records SPEC#AC-N as met (needs --evidence PATH:LINE) or unmet; the
            owning requirement is looked up in the spec. SPEC is the path as the
            tech spec lists it, or any path to the same file; with one spec, a
            bare AC-N will do. One verdict per criterion; to change one, start
            the tech spec over.
obligation  records ADR-nnnn#R-n as met (needs --evidence) or unmet. The
            obligations owed are those of every accepted record linked on a
            criterion in scope or on its requirement (with no scope: anywhere in
            the spec). Already discharged in code is a met verdict, not a task.
task        appends a task and prints its T-N. --covers names unmet criteria or
            obligations whose verdicts are already recorded; a task covering
            nothing is an enabler and needs --why. --depends-on names tasks that
            already exist, so the graph is acyclic by construction.
decided     behaviour: where a spec links an ADR on a criterion or its
            requirement, criterion and task print a DECIDED notice on stderr
            naming the records. Read them; the tech spec is where a decision is
            met or declared no longer to hold.
verify      E701–E719: every criterion in scope and every owed obligation has one
            verdict, met ones cite evidence, every unmet one is covered,
            dependencies resolve. See --list-rules.
`,
  run: runTechspec,
};
