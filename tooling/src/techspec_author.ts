// `yamlet techspec` — the mutating commands for a tech spec (`*.techspec.yaml`).
//
//   yamlet techspec init      SPEC [--out FILE]
//   yamlet techspec analysis  FILE --commit SHA [--deep DIR ...] [--skimmed DIR ...]
//   yamlet techspec criterion FILE --ac AC-N --met true|false [--evidence PATH:LINE ...] [--note "..."]
//   yamlet techspec task      FILE --title "..." [--covers AC-N ...] [--depends-on T-N ...] [--why "..."]
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
//   - Only tasks get ids minted here (`T-N`). Every `RQ-N`/`AC-N` is the spec's,
//     and is checked against the spec on the way in: a verdict for a criterion
//     the spec does not have is a usage error, not a new id.
//
// Order of use is enforced by construction: a task may only cover a criterion
// whose verdict is already recorded as unmet, and may only depend on a task
// that already exists — so the dependency graph can never contain a cycle, and
// `verify`'s E712/E714 are there for hand-edited files, not tool-written ones.
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
  decidedBy,
  indexSpec,
  parseTechspec,
  serializeTechspec,
  SPEC_EXT,
  type SpecIndex,
  TASK_ID_RE,
  type Techspec,
  TECHSPEC_EXT,
  validateTechspec,
} from "./techspec.ts";

const USAGE = `Usage:
  yamlet techspec init      SPEC [--out FILE]
  yamlet techspec analysis  FILE --commit SHA [--deep DIR ...] [--skimmed DIR ...]
  yamlet techspec criterion FILE --ac AC-N --met true|false \\
                            [--evidence PATH:LINE ...] [--note "..."]
  yamlet techspec task      FILE --title "..." [--covers AC-N ...] \\
                            [--depends-on T-N ...] [--why "..."]
`;
const usageResult = (): CmdResult => ({ exitCode: 2, stdout: "", stderr: USAGE });

/**
 * Findings a tech spec carries while it is being built: no analysis yet (E701
 * on that key alone), criteria without a verdict yet (E706), unmet criteria not
 * yet covered (E715). Everything else is a hard error — and since every mutation
 * checks its input against the spec, a hard error means the file was edited by
 * hand.
 */
const inProgress = (f: Finding): boolean =>
  (f.rule === "E701" && f.path === "analysis") || f.rule === "E706" || f.rule === "E715";

/** Newlines have no representation in a one-line scalar; fold them, as prose. */
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ").trim();

interface Loaded {
  ts: Techspec;
  spec: SpecIndex;
}

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
  const spec = v.spec;
  if (hard.length > 0 || spec === null) {
    throw new CmdError(die(
      `${file} has errors; a tech spec is disposable, so delete it and start over:\n` +
        renderFindings(hard),
    ));
  }
  return { ts: parseTechspec(records), spec };
}

/** Serialize, gate, write. The gate cannot normally fire (inputs were checked), but it stays. */
function commit(file: string, what: string, ts: Techspec, spec: SpecIndex): CmdResult {
  const next = serializeTechspec(ts, spec);
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

// ── decided behaviour ──
// A link in the spec means: this behaviour was decided, read the record before
// deciding how to meet it. The tech spec cannot hold "I read it" (a flag proves
// nothing), so the reminder is printed where the how is being written down —
// on the verdict and on the task — and the skill relays it. stderr, exit 0.

/** The notice printed when a verdict is recorded on decided behaviour. */
function decidedVerdictNotice(spec: SpecIndex, acId: string, met: string): string {
  const d = decidedBy(spec, acId);
  if (d.adrs.length === 0) return "";
  let s = `DECIDED: ${acId} is decided by an ADR (via ${d.via.join(" and ")}).\n`;
  for (const a of d.adrs) s += `  ${a}\n`;
  s += met === "true"
    ? `The evidence for ${acId} must fit these decisions.\n`
    : `The task covering ${acId} must fit these decisions, or state that one no longer holds.\n`;
  return s;
}

/** The notice printed when a task covers decided behaviour: one line per decided criterion. */
function decidedTaskNotice(spec: SpecIndex, taskId: string, covers: string[]): string {
  const lines: string[] = [];
  for (const acId of covers) {
    const d = decidedBy(spec, acId);
    if (d.adrs.length > 0) lines.push(`  ${acId}: ${d.adrs.join(", ")}`);
  }
  if (lines.length === 0) return "";
  return `DECIDED: ${taskId} covers behaviour an ADR decides.\n${lines.join("\n")}\n`;
}

// ── init ──
export function runTechspecInit(args: string[]): CmdResult {
  try {
    const spec = args[0] ?? "";
    if (spec === "") return usageResult();
    let out = "";
    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      if (a === "--out") {
        out = argVal(args, i, a);
        i += 2;
      } else {
        return die(`unknown flag for techspec init: ${a}`);
      }
    }

    if (!isFile(spec)) return die(`spec not found: ${spec}`);
    if (!basename(spec).endsWith(SPEC_EXT)) {
      return die(`SPEC must be a ${SPEC_EXT} file: ${spec}`);
    }

    // A tech spec is planned from a *finished* spec: one that verifies clean.
    const { result } = verifyFile(spec);
    if (!result.valid) {
      return die(
        `${spec} has verify errors; a tech spec is planned from a finished spec:\n` +
          renderFindings(result.errors),
      );
    }
    const index = indexSpec(Deno.readTextFileSync(spec))!;
    if (index.criteria.length === 0) {
      return die(`${spec} declares no acceptance criteria; there is nothing to plan`);
    }

    if (out === "") {
      const dir = dirname(spec);
      const stem = basename(spec).slice(0, -SPEC_EXT.length);
      out = (dir === "" ? "" : `${dir}/`) + stem + TECHSPEC_EXT;
    }
    if (!basename(out).endsWith(TECHSPEC_EXT)) {
      return die(`--out must use the ${TECHSPEC_EXT} extension: ${out}`);
    }
    if (exists(out)) return die(`refusing to overwrite existing file: ${out}`);
    const outDir = dirname(out);
    if (outDir !== "" && !isDir(outDir)) return die(`directory does not exist: ${outDir}`);

    const ts: Techspec = {
      spec: relativePath(outDir, spec),
      system: index.system,
      analysis: null,
      requirements: [],
      tasks: [],
    };
    const r = commit(out, "techspec init", ts, index);
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

    const { ts, spec } = load(file);

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
    return commit(file, "techspec analysis", next, spec);
  } catch (e) {
    if (e instanceof CmdError) return e.result;
    throw e;
  }
}

// ── criterion ──
// One verdict per criterion of the spec. The requirement it sits under is the
// spec's to say, so it is looked up, never passed.
export function runTechspecCriterion(args: string[]): CmdResult {
  try {
    const file = args[0] ?? "";
    if (file === "") return usageResult();
    let ac = "";
    let met = "";
    let note = "";
    const evidence: string[] = [];
    let i = 1;
    while (i < args.length) {
      const a = args[i]!;
      switch (a) {
        case "--ac":
          ac = argVal(args, i, a);
          i += 2;
          break;
        case "--met":
          met = argVal(args, i, a);
          i += 2;
          break;
        case "--evidence":
          evidence.push(argVal(args, i, a));
          i += 2;
          break;
        case "--note":
          note = argVal(args, i, a);
          i += 2;
          break;
        default:
          return die(`unknown flag for techspec criterion: ${a}`);
      }
    }
    if (ac === "") return die("techspec criterion requires --ac AC-N");
    if (met !== "true" && met !== "false") {
      return die("techspec criterion requires --met true|false");
    }

    const { ts, spec } = load(file);

    const owner = spec.ownerOf.get(ac);
    if (owner === undefined) {
      return die(`no such criterion in ${ts.spec}: ${ac} (it has ${spec.criteria.join(", ")})`);
    }
    for (const rq of ts.requirements) {
      if (rq.criteria.some((c) => c.id === ac)) {
        return die(
          `${ac} already has a verdict; a tech spec is disposable, so delete it and start over ` +
            `rather than revising a verdict in place`,
        );
      }
    }
    const seen = new Set<string>();
    for (const e of evidence) {
      if (e.trim() === "") return die("an --evidence entry cannot be empty");
      if (seen.has(e)) return die(`duplicate --evidence: ${e}`);
      seen.add(e);
    }
    if (met === "true" && evidence.length === 0) {
      return die(
        `--met true needs at least one --evidence PATH:LINE showing where ${ac} is satisfied`,
      );
    }
    note = oneLine(note);

    const next: Techspec = { ...ts, requirements: ts.requirements.map((r) => ({ ...r })) };
    let group = next.requirements.find((r) => r.id === owner);
    if (group === undefined) {
      group = { id: owner, criteria: [] };
      next.requirements.push(group);
    } else {
      group.criteria = [...group.criteria];
    }
    group.criteria.push({ id: ac, met, evidence, note });
    const r = commit(file, "techspec criterion", next, spec);
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: "", stderr: decidedVerdictNotice(spec, ac, met) };
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
    const covers: string[] = [];
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
          covers.push(argVal(args, i, a));
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

    const { ts, spec } = load(file);

    const verdict = new Map<string, string>();
    for (const rq of ts.requirements) for (const c of rq.criteria) verdict.set(c.id, c.met);

    const seenCov = new Set<string>();
    for (const c of covers) {
      if (seenCov.has(c)) return die(`duplicate --covers: ${c}`);
      seenCov.add(c);
      if (!spec.criteria.includes(c)) {
        return die(`no such criterion in ${ts.spec}: ${c} (it has ${spec.criteria.join(", ")})`);
      }
      const v = verdict.get(c);
      if (v === undefined) {
        return die(
          `${c} has no verdict yet; record it with 'techspec criterion' before covering it`,
        );
      }
      if (v === "true") return die(`${c} is already met; a task cannot cover it`);
    }
    if (covers.length === 0 && why === "") {
      return die("a task that covers no criterion is an enabler and needs --why");
    }
    if (covers.length > 0 && why !== "") {
      return die("a task that covers criteria is justified by them; drop --why");
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
    const r = commit(file, "techspec task", next, spec);
    if (r.exitCode !== 0) return r;
    return { exitCode: 0, stdout: `${id}\n`, stderr: decidedTaskNotice(spec, id, covers) };
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
  summary: "build a spec's gap analysis and task list (a disposable .techspec.yaml)",
  help: `yamlet techspec — build a tech spec: one spec's gap analysis and task list

Usage:
  yamlet techspec init      SPEC [--out FILE]
  yamlet techspec analysis  FILE --commit SHA [--deep DIR ...] [--skimmed DIR ...]
  yamlet techspec criterion FILE --ac AC-N --met true|false \\
                            [--evidence PATH:LINE ...] [--note "..."]
  yamlet techspec task      FILE --title "..." [--covers AC-N ...] \\
                            [--depends-on T-N ...] [--why "..."]
  yamlet verify FILE.techspec.yaml

A tech spec is derived from a *finished* spec (one that verifies clean) and the
code that implements it: a verdict per acceptance criterion, then tasks covering
every unmet one. It is disposable — plan from it, implement, discard; the spec
and its ADRs are what persist — so keep it out of version control.

init       writes <spec>.techspec.yaml next to SPEC (or --out) and prints its path.
analysis   pins the commit the code was read at; --deep/--skimmed accumulate the
           paths read closely or only glanced at. Paths are recorded, not checked.
criterion  records AC-N as met (needs --evidence PATH:LINE) or unmet; the owning
           requirement is looked up in the spec. One verdict per criterion; to
           change one, start the tech spec over.
task       appends a task and prints its T-N. --covers names unmet criteria whose
           verdicts are already recorded; a task covering nothing is an enabler
           and needs --why. --depends-on names tasks that already exist, so the
           graph is acyclic by construction.
decided    behaviour: where the spec links an ADR on a criterion or its
           requirement, criterion and task print a DECIDED notice on stderr naming
           the records. Read them; the tech spec is where a decision is met or
           declared no longer to hold.
verify     E701–E715: every criterion has one verdict, met ones cite evidence,
           every unmet one is covered, dependencies resolve. See --list-rules.
`,
  run: runTechspec,
};
