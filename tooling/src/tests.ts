// `yamlet tests` — project every spec's acceptance criteria into Gherkin.
//
// The spec's acceptance criteria are already Given/When/Then in disguise: an
// EARS clause maps onto a step. This command makes that projection explicit,
// emitting one `.feature` file per scope, so a BDD runner can bind step
// definitions to real code. It stops at the `.feature` boundary — step
// definitions, fixtures, the runner and CI belong to whoever consumes them.
//
// The mapping is total and mechanical (it can never disagree with `verify`
// about which criteria exist):
//
//   scope (one .yamlet.yaml)  -> Feature   (tagged @<system> @front-… @blast-radius-…)
//   requirement (RQ-N)        -> Rule      (tagged @RQ-N)
//   criterion   (AC-N)        -> Scenario  (tagged @AC-N @<pattern>; named with the
//                                          rebuilt EARS sentence so a failure is legible)
//
//   where  (optional gate) -> Given
//   while  (state, a list) -> Given (one per entry)
//   when / if  (trigger)   -> When
//   shall  (a list)        -> Then the system shall …
//
// A criterion with `examples` rows becomes a Scenario Outline: example-backed
// {placeholder}s render as <placeholder> columns; contract/member references
// ({input.X}, {output.X}, {alias.socket}) stay verbatim for the consumer's
// step definitions to bind.
//
// Alongside the features it writes <target>/manifest.json (`yamlet.tests/v1`):
// per scenario, the inputs/outputs/member-sockets it leaves verbatim — the
// machine-readable contract of what a consumer's step definitions must bind. It
// is a second view of the same tokens the steps show (never a different truth),
// so a downstream check can assert binding coverage without re-parsing Gherkin.
//
// Output layout groups scopes by system: <target>/<system>/<scope>.feature — so
// `cucumber --tags @<system>` runs a whole system across its several files, and
// a stakeholder can open one system's folder. Specs with no requirements (a bare
// composite) have nothing to assert and are skipped, surfaced in the summary.
//
// TARGET is a yamlet-owned generated directory: every run wipes it and rebuilds
// from the specs, so a renamed or deleted scope can never leave an orphan behind.
// It holds nothing but this projection — the consumer's step definitions, fixtures
// and runner live in their own directory, never in TARGET (anything put here is
// erased on the next run).
//
// Writes files. Exit codes: 0 ok · 2 usage/path/collision error.

import type { CmdResult, Command, FlatRecord } from "./types.ts";
import { flatten } from "./flatten.ts";
import { listSpecs } from "./systems.ts";

const die = (msg: string): CmdResult => ({ exitCode: 2, stdout: "", stderr: `error: ${msg}\n` });

// ── the structured view of a spec we project from ─────────────────────────

interface Criterion {
  id: string;
  pattern: string;
  where: string;
  whiles: string[];
  when: string;
  ifCond: string;
  shalls: string[];
  exampleKeys: string[]; // sorted union of column keys ("" when not an outline)
  exampleRows: Record<string, string>[];
}
interface Requirement {
  id: string;
  description: string;
  criteria: Criterion[];
}
interface SpecDoc {
  system: string;
  topic: string;
  summary: string;
  name: string; // exposes.name, or "" when the scope exposes none
  front: string;
  blastRadius: string;
  requirements: Requirement[];
}

/** Escape the literal characters of a record path for use inside a RegExp. */
function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The distinct sequence indices present for `${prefix}[N]…`, ascending. */
function indicesUnder(records: readonly FlatRecord[], prefix: string): number[] {
  const re = new RegExp(`^${escRe(prefix)}\\[(\\d+)\\]`);
  const seen = new Set<number>();
  for (const r of records) {
    const m = r.path.match(re);
    if (m) seen.add(Number(m[1]));
  }
  return [...seen].sort((a, b) => a - b);
}

/** The ordered scalar values of an indexed list at `${prefix}[N]`. */
function listUnder(records: readonly FlatRecord[], prefix: string): string[] {
  const re = new RegExp(`^${escRe(prefix)}\\[(\\d+)\\]$`);
  const rows: { i: number; v: string }[] = [];
  for (const r of records) {
    const m = r.path.match(re);
    if (m) rows.push({ i: Number(m[1]), v: r.value });
  }
  rows.sort((a, b) => a.i - b.i);
  return rows.map((x) => x.v);
}

/** Parse one criterion's `examples` rows into per-row key→value maps + the sorted key union. */
function examplesUnder(
  records: readonly FlatRecord[],
  prefix: string,
): { keys: string[]; rows: Record<string, string>[] } {
  // A key may itself contain a dot (`input.recipient`), so capture the rest of the path.
  const re = new RegExp(`^${escRe(prefix)}\\.examples\\[(\\d+)\\]\\.(.+)$`);
  const byRow = new Map<number, Record<string, string>>();
  const keys = new Set<string>();
  for (const r of records) {
    const m = r.path.match(re);
    if (!m) continue;
    const row = Number(m[1]);
    const key = m[2]!;
    keys.add(key);
    const bucket = byRow.get(row) ?? {};
    bucket[key] = r.value;
    byRow.set(row, bucket);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b).map((i) => byRow.get(i)!);
  return { keys: [...keys].sort(), rows };
}

/** Read a spec's flattened records into the structured view the renderer walks. */
function parseSpec(records: FlatRecord[]): SpecDoc {
  const get = (path: string): string => records.find((r) => r.path === path)?.value ?? "";

  const requirements: Requirement[] = [];
  for (const i of indicesUnder(records, "requirements")) {
    const rqPrefix = `requirements[${i}]`;
    const criteria: Criterion[] = [];
    for (const j of indicesUnder(records, `${rqPrefix}.acceptance-criteria`)) {
      const acPrefix = `${rqPrefix}.acceptance-criteria[${j}]`;
      const { keys, rows } = examplesUnder(records, acPrefix);
      criteria.push({
        id: get(`${acPrefix}.id`),
        pattern: get(`${acPrefix}.pattern`),
        where: get(`${acPrefix}.where`),
        whiles: listUnder(records, `${acPrefix}.while`),
        when: get(`${acPrefix}.when`),
        ifCond: get(`${acPrefix}.if`),
        shalls: listUnder(records, `${acPrefix}.shall`),
        exampleKeys: keys,
        exampleRows: rows,
      });
    }
    requirements.push({
      id: get(`${rqPrefix}.id`),
      description: get(`${rqPrefix}.description`),
      criteria,
    });
  }

  return {
    system: get("system"),
    topic: get("topic"),
    summary: get("summary"),
    name: get("exposes.name"),
    front: get("front"),
    blastRadius: get("blast_radius"),
    requirements,
  };
}

// ── Gherkin rendering ──────────────────────────────────────────────────────

/** Rewrite example-backed `{key}` tokens to Scenario Outline `<key>`; leave contract/member refs verbatim. */
function subst(text: string, exampleKeys: Set<string>): string {
  return text.replace(/\{([^}]*)\}/g, (m, tok) => (exampleKeys.has(tok) ? `<${tok}>` : m));
}

/** Escape a Gherkin table cell (`\` and `|` are the only structural characters). */
function cell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/**
 * A human-readable scenario description: the EARS sentence rebuilt from the
 * criterion's clauses, so a failing scenario names *what* broke rather than just
 * an opaque id. Leads with the first `shall` (the primary response); the full
 * detail lives in the steps. Placeholders resolve to `<col>` so an Outline's per-
 * example name shows concrete values.
 */
function describe(c: Criterion): string {
  const keys = new Set(c.exampleKeys);
  const cond: string[] = [];
  if (c.where) cond.push(`where ${c.where}`);
  if (c.whiles.length > 0) cond.push(`while ${c.whiles.join(" and ")}`);
  const trigger = c.when ? `when ${c.when}` : c.ifCond ? `if ${c.ifCond}` : "";
  if (trigger) cond.push(trigger);

  const resp = c.shalls[0] ?? "";
  const sentence = cond.length > 0
    ? `${cond.join(", ")}, the system shall ${resp}`
    : `the system shall ${resp}`;
  const out = subst(sentence, keys).replace(/\s+$/, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The Given/When/Then step lines for one criterion (unindented). */
function stepLines(c: Criterion): string[] {
  const keys = new Set(c.exampleKeys);
  const lines: string[] = [];

  const givens: string[] = [];
  if (c.where) givens.push(c.where);
  for (const w of c.whiles) givens.push(w);
  givens.forEach((g, i) => lines.push(`${i === 0 ? "Given" : "And"} ${subst(g, keys)}`));

  const trigger = c.when || c.ifCond; // event/unwanted/complex carry exactly one
  if (trigger) lines.push(`When ${subst(trigger, keys)}`);

  c.shalls.forEach((s, i) =>
    lines.push(`${i === 0 ? "Then" : "And"} the system shall ${subst(s, keys)}`)
  );
  return lines;
}

interface Bindings {
  inputs: string[];
  outputs: string[];
  sockets: string[];
}

/**
 * The contract tokens a criterion leaves *verbatim* in the feature — the binding
 * obligations a consumer's step definitions must satisfy. Example-backed tokens
 * are excluded: they render as Scenario Outline `<columns>` and carry their own
 * data, so nothing needs binding. Mirrors `subst`'s verbatim/`<column>` split, so
 * the manifest can never disagree with the rendered steps about what is a binding.
 */
function bindings(c: Criterion): Bindings {
  const backed = new Set(c.exampleKeys);
  const inputs = new Set<string>();
  const outputs = new Set<string>();
  const sockets = new Set<string>();
  const texts = [c.where, ...c.whiles, c.when, c.ifCond, ...c.shalls];
  for (const t of texts) {
    for (const m of t.matchAll(/\{([^}]*)\}/g)) {
      const tok = m[1]!;
      if (backed.has(tok)) continue; // rendered as a `<column>`, not a binding
      const inp = tok.match(/^input\.(.+)$/);
      const out = tok.match(/^output\.(.+)$/);
      if (inp) inputs.add(inp[1]!);
      else if (out) outputs.add(out[1]!);
      else if (/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(tok)) sockets.add(tok);
      // A bare, non-example-backed placeholder can't survive `yamlet verify` — ignore.
    }
  }
  const sorted = (s: Set<string>) => [...s].sort();
  return { inputs: sorted(inputs), outputs: sorted(outputs), sockets: sorted(sockets) };
}

/** The full `.feature` text for one scope. */
function renderFeature(doc: SpecDoc): string {
  const tags = [`@${doc.system}`];
  if (doc.front) tags.push(`@front-${doc.front}`);
  if (doc.blastRadius) tags.push(`@blast-radius-${doc.blastRadius}`);

  const L: string[] = [];
  L.push(tags.join(" "));
  L.push(`Feature: ${doc.name ? `${doc.topic} — ${doc.name}` : doc.topic || doc.system}`);
  if (doc.summary) L.push(`  ${doc.summary}`);

  for (const rq of doc.requirements) {
    L.push("");
    L.push(`  @${rq.id}`);
    L.push(`  Rule: ${rq.description || rq.id}`);

    for (const ac of rq.criteria) {
      L.push("");
      L.push(`    @${ac.id}${ac.pattern ? ` @${ac.pattern}` : ""}`);
      const outline = ac.exampleRows.length > 0;
      L.push(`    Scenario${outline ? " Outline" : ""}: ${describe(ac)}`);
      for (const st of stepLines(ac)) L.push(`      ${st}`);
      if (outline) {
        L.push("");
        L.push(`      Examples:`);
        L.push(`        | ${ac.exampleKeys.map(cell).join(" | ")} |`);
        for (const row of ac.exampleRows) {
          L.push(`        | ${ac.exampleKeys.map((k) => cell(row[k] ?? "")).join(" | ")} |`);
        }
      }
    }
  }
  return L.join("\n") + "\n";
}

// ── command ────────────────────────────────────────────────────────────────

/** `<basename>.feature` for a spec path (strips directories and the `.yamlet.yaml` suffix). */
function featureName(specPath: string): string {
  const base = specPath.slice(specPath.lastIndexOf("/") + 1);
  return base.replace(/\.yamlet\.yaml$/, "") + ".feature";
}

interface Written {
  out: string;
  rules: number;
  scenarios: number;
}
interface Skipped {
  file: string;
  reason: string;
}

/** Empty TARGET (keeping the dir itself); no-op if it doesn't exist yet. */
function clearTarget(target: string): void {
  try {
    for (const e of Deno.readDirSync(target)) {
      Deno.removeSync(`${target}/${e.name}`, { recursive: true });
    }
  } catch {
    // Doesn't exist yet — created lazily per feature below.
  }
}

// One feature's binding obligations: AC id → the contract tokens that scenario
// leaves verbatim. Only scenarios with at least one obligation are recorded.
type FeatureBinds = Record<string, Bindings>;

/** The binding obligations of every scenario in a scope that has any. */
function featureBinds(doc: SpecDoc): FeatureBinds {
  const acs: FeatureBinds = {};
  for (const rq of doc.requirements) {
    for (const ac of rq.criteria) {
      const b = bindings(ac);
      if (b.inputs.length + b.outputs.length + b.sockets.length > 0) acs[ac.id] = b;
    }
  }
  return acs;
}

/** Numeric order for `AC-N` ids (`AC-2` before `AC-10`). */
function acOrder(a: string, b: string): number {
  const n = (s: string) => Number(s.replace(/\D+/g, "")) || 0;
  return n(a) - n(b);
}

/**
 * The `yamlet.tests/v1` binding manifest: `<system>/<scope>.feature` → `AC-N` →
 * the inputs/outputs/member-sockets that scenario references but does not carry
 * as example data. It is the machine-readable contract of what a consumer's step
 * definitions must bind — a second view of the same tokens the steps show, so a
 * downstream check can assert coverage without re-parsing feature text. Keys are
 * ordered deterministically (features by path, scenarios by id) for a stable file.
 */
function renderManifest(
  plan: readonly { rel: string; binds: FeatureBinds }[],
): string {
  const features: Record<string, FeatureBinds> = {};
  for (const p of [...plan].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    if (Object.keys(p.binds).length === 0) continue;
    const ordered: FeatureBinds = {};
    for (const ac of Object.keys(p.binds).sort(acOrder)) ordered[ac] = p.binds[ac]!;
    features[p.rel] = ordered;
  }
  return JSON.stringify({ format: "yamlet.tests/v1", features }, null, 2) + "\n";
}

export function runTests(args: string[]): CmdResult {
  const positionals: string[] = [];
  for (const a of args) {
    if (a.startsWith("-")) return die(`unknown flag for tests: ${a}`);
    positionals.push(a);
  }
  if (positionals.length < 2) {
    return die("tests requires a source directory and a target directory: yamlet tests SRC TARGET");
  }
  if (positionals.length > 2) return die(`too many arguments: ${positionals[2]}`);
  const src = positionals[0]!;
  const target = positionals[1]!;

  try {
    if (!Deno.statSync(src).isDirectory) return die(`not a directory: ${src}`);
  } catch {
    return die(`source directory not found: ${src}`);
  }
  try {
    if (!Deno.statSync(target).isDirectory) {
      return die(`target exists but is not a directory: ${target}`);
    }
  } catch {
    // Doesn't exist yet — created lazily per feature below.
  }

  // Build the whole write plan in memory first, so a collision aborts before we
  // wipe TARGET — never erase the existing tree for a run that can't complete.
  const plan: (Written & { system: string; rel: string; content: string; binds: FeatureBinds })[] =
    [];
  const skipped: Skipped[] = [];
  const claimed = new Map<string, string>(); // output path → source spec (collision guard)

  for (const spec of listSpecs(src)) {
    let text: string;
    try {
      text = Deno.readTextFileSync(spec);
    } catch {
      skipped.push({ file: spec, reason: "unreadable" });
      continue;
    }
    const { records, parseErrors } = flatten(text);
    if (parseErrors.length > 0) {
      skipped.push({ file: spec, reason: "parse error (run `yamlet verify`)" });
      continue;
    }
    const doc = parseSpec(records);
    if (doc.system === "") {
      skipped.push({ file: spec, reason: "no system" });
      continue;
    }
    if (doc.requirements.length === 0) {
      skipped.push({ file: spec, reason: "no requirements" });
      continue;
    }

    const out = `${target}/${doc.system}/${featureName(spec)}`;
    const prior = claimed.get(out);
    if (prior !== undefined) {
      return die(
        `two specs map to the same feature file ${out}:\n  ${prior}\n  ${spec}\n` +
          `rename one so their basenames differ within the '${doc.system}' system`,
      );
    }
    claimed.set(out, spec);
    plan.push({
      out,
      system: doc.system,
      rel: `${doc.system}/${featureName(spec)}`,
      content: renderFeature(doc),
      binds: featureBinds(doc),
      rules: doc.requirements.length,
      scenarios: doc.requirements.reduce((n, rq) => n + rq.criteria.length, 0),
    });
  }

  // TARGET is ours: clear it, then write the fresh tree.
  clearTarget(target);
  for (const p of plan) {
    try {
      Deno.mkdirSync(`${target}/${p.system}`, { recursive: true });
      Deno.writeTextFileSync(p.out, p.content);
    } catch (e) {
      return die(`could not write ${p.out}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // The binding manifest: what each scenario's step definitions must satisfy,
  // regenerated with the tree. Emitted whenever any feature was written, so a
  // consumer can rely on `<target>/manifest.json` existing beside the features.
  if (plan.length > 0) {
    const manifestOut = `${target}/manifest.json`;
    try {
      Deno.writeTextFileSync(manifestOut, renderManifest(plan));
    } catch (e) {
      return die(`could not write ${manifestOut}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const written = plan.sort((a, b) => (a.out < b.out ? -1 : a.out > b.out ? 1 : 0));
  skipped.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  let stdout = written.length === 0
    ? `no specs with requirements found under ${src}\n`
    : `wrote ${written.length} feature${written.length === 1 ? "" : "s"} to ${target}\n`;
  for (const w of written) {
    stdout += `  ${w.out}  (${w.rules} rule${w.rules === 1 ? "" : "s"}, ` +
      `${w.scenarios} scenario${w.scenarios === 1 ? "" : "s"})\n`;
  }
  if (written.length > 0) stdout += `  ${target}/manifest.json  (binding obligations)\n`;
  if (skipped.length > 0) {
    stdout += `skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"}:\n`;
    for (const s of skipped) stdout += `  ${s.file} — ${s.reason}\n`;
  }
  return { exitCode: 0, stdout, stderr: "" };
}

export const testsCommand: Command = {
  name: "tests",
  summary: "project spec acceptance criteria into Gherkin feature files",
  help: `yamlet tests — project acceptance criteria into Gherkin feature files

Usage:
  yamlet tests SRC TARGET

Arguments:
  SRC      directory to scan for *.yamlet.yaml specs
  TARGET   directory to write feature files into (created if absent)

Both are required. For every scope with requirements, writes
TARGET/<system>/<scope>.feature — a Feature per scope, a Rule per requirement,
a Scenario per acceptance criterion, tagged @<system>/@RQ-N/@AC-N for selection
and traceability. Criteria with examples become Scenario Outlines.

TARGET is a yamlet-owned directory: every run wipes it and rebuilds from the
specs, so a renamed or deleted scope never leaves an orphan. Keep step
definitions and anything else in their own directory — TARGET holds only this
projection and its whole contents are erased on each run.

Beside the features it writes TARGET/manifest.json (yamlet.tests/v1): per
scenario, the contract inputs/outputs/member-sockets it leaves verbatim — the
list a consumer's step definitions must bind. A downstream check can read it to
assert nothing was left unbound.

yamlet emits the feature files and stops there: step definitions, fixtures and
the runner belong to whoever consumes them. Specs with no requirements are
skipped. Run \`yamlet verify\` first — files that don't parse are skipped.

Exit: 0 ok · 2 usage/path/collision error
`,
  run: runTests,
};
