// `yamlet trace` builds the traceability model of a directory: specs, the verdicts
// and tasks their tech specs record, and the decision records that decide them.
//
// `tests/trace-fixtures/` is one verified set — `pdf-verify` with a tech spec that
// accounts for ADR-0001's obligations (R-4 already met, the rest covered by tasks), ADR-0002 assuming ADR-0001, and ADR-0093 superseded
// by ADR-0094. Tests that need a variation copy it to a temp dir and change one file,
// so every assertion traces back to a single, named difference.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runTrace, type TraceModel, type TraceNode } from "../src/trace.ts";

const FIXTURES = new URL("./trace-fixtures/", import.meta.url).pathname.replace(/\/$/, "");
const SPEC = "pdf-verify.yamlet.yaml";
const TECHSPEC = "pdf-verify.techspec.yaml";
const ADR1 = "ADR-0001-structural-pdf-parsing.adr.yaml";
const ADR2 = "ADR-0002-isolation-of-structural-parsing.adr.yaml";

interface TraceRun {
  exitCode: number;
  stderr: string;
  summary: string;
  payload: string;
}

function trace(args: string[]): TraceRun {
  const dir = Deno.makeTempDirSync();
  const hasOut = args.some((a) => a.startsWith("--out="));
  const out = `${dir}/trace.out`;
  const r = runTrace(hasOut ? args : [...args, `--out=${out}`]);
  let payload = "";
  try {
    payload = Deno.readTextFileSync(out);
  } catch { /* nothing written */ }
  return { exitCode: r.exitCode, stderr: r.stderr, summary: r.stdout, payload };
}

/** Run trace --format=json over `dir` and parse the model. */
function model(dir: string, extra: string[] = []): TraceModel {
  const r = trace([dir, "--format=json", ...extra]);
  assertEquals(r.exitCode, 0, r.stderr);
  return JSON.parse(r.payload) as TraceModel;
}

/** A private copy of the fixture set, to vary one file at a time. */
function copyFixtures(): string {
  const dir = Deno.makeTempDirSync();
  for (const e of Deno.readDirSync(FIXTURES)) {
    if (e.isFile) Deno.copyFileSync(`${FIXTURES}/${e.name}`, `${dir}/${e.name}`);
  }
  return dir;
}

function node(m: TraceModel, id: string): TraceNode {
  const n = m.nodes.find((x) => x.id === id);
  assert(n, `no node ${id}`);
  return n;
}
function edges(m: TraceModel, kind: string): string[] {
  return m.edges.filter((e) => e.kind === kind).map((e) => `${e.from} -> ${e.to}`);
}
function verdict(m: TraceModel, id: string): string | null {
  const n = node(m, id);
  assert(n.type === "criterion");
  return n.verdict;
}

// ── the model ──────────────────────────────────────────────────────────────

Deno.test("trace models specs, criteria, ADRs, obligations and tasks with typed edges", () => {
  const m = model(FIXTURES);
  assertEquals(m.format, "yamlet.trace/v1");
  assertEquals(m.kind, "trace");
  assertEquals(m.name, "trace-fixtures");
  assertEquals(m.skipped, []);

  const count = (t: string): number => m.nodes.filter((n) => n.type === t && !n.missing).length;
  assertEquals(count("spec"), 1);
  assertEquals(count("requirement"), 6);
  assertEquals(count("criterion"), 10);
  assertEquals(count("adr"), 4);
  assertEquals(count("obligation"), 6); // ADR-0001 has four, ADR-0002 two
  assertEquals(count("task"), 4);
  assert(!m.nodes.some((n) => n.missing), "nothing in the fixture set dangles");

  const S = `spec:${FIXTURES}/${SPEC}`;
  const A1 = `adr:${FIXTURES}/${ADR1}`;
  const A2 = `adr:${FIXTURES}/${ADR2}`;
  const T = (id: string): string => `task:${FIXTURES}/${TECHSPEC}#${id}`;

  // The spec's own `adrs:` links, on a requirement and on a criterion.
  assertEquals(edges(m, "decided_by"), [`${S}#RQ-5 -> ${A1}`, `${S}#AC-8 -> ${A2}`]);
  // The ADRs' side of the same story, and the record graph.
  assert(edges(m, "arises_from").includes(`${A1} -> ${S}#AC-8`));
  assert(edges(m, "assumes").includes(`${A2} -> ${A1}`));
  assertEquals(edges(m, "superseded_by").length, 1);
  assertEquals(edges(m, "cites"), [`${A2} -> ${A1}#R-4`]);
  // Tasks: covering criteria and obligations, and their dependency graph.
  assert(edges(m, "covers").includes(`${T("T-2")} -> ${S}#AC-8`));
  assert(edges(m, "covers").includes(`${T("T-2")} -> ${A1}#R-1`));
  assertEquals(edges(m, "depends_on").length, 4);
  assert(edges(m, "has").includes(`${S}#RQ-5 -> ${S}#AC-8`));
  assert(edges(m, "has").includes(`${A1} -> ${A1}#R-1`));
});

Deno.test("trace carries each criterion's verdict, evidence and EARS clauses", () => {
  const m = model(FIXTURES);
  const S = `spec:${FIXTURES}/${SPEC}`;
  const ac1 = node(m, `${S}#AC-1`);
  assert(ac1.type === "criterion");
  assertEquals(ac1.verdict, "met");
  assertEquals(ac1.evidence, ["src/Verify.java:10"]);
  assertEquals(ac1.pattern, "event");
  assertEquals(ac1.shalls.length, 2);
  assertEquals(verdict(m, `${S}#AC-8`), "unmet");
  const s = node(m, S);
  assert(s.type === "spec");
  assertEquals(s.techspec, `${FIXTURES}/${TECHSPEC}`);
  assertEquals(s.commit, "9f3c1ab");
});

Deno.test("trace rolls each spec up: verdict counts, tasks, ADRs, nothing left open", () => {
  const [r] = model(FIXTURES).specs;
  assert(r);
  assertEquals(r.criteria, { met: 7, unmet: 3, unrecorded: 0, total: 10, outOfScope: 0 });
  assertEquals(r.tasks, 4);
  assertEquals(r.adrs.length, 2);
  assertEquals(r.uncovered, []);
  assertEquals(r.openObligations, []);
});

Deno.test("trace reports unmet criteria and accepted obligations no task covers", () => {
  const dir = copyFixtures();
  // Drop T-4, the only task covering AC-10 and ADR-0001#R-3.
  const ts = Deno.readTextFileSync(`${dir}/${TECHSPEC}`);
  Deno.writeTextFileSync(`${dir}/${TECHSPEC}`, ts.slice(0, ts.indexOf("- id: T-4")));
  const [r] = model(dir).specs;
  assert(r);
  assertEquals(r.tasks, 3);
  assertEquals(r.uncovered, [`spec:${dir}/${SPEC}#AC-10`]);
  // ADR-0002 is proposed: its obligations are not yet owed (the E716 rule). R-4 is met.
  assertEquals(r.openObligations, [`adr:${dir}/${ADR1}#R-3`]);
});

Deno.test("trace carries an obligation's verdict; a met one is owed no task", () => {
  const m = model(FIXTURES);
  const r4 = node(m, `adr:${FIXTURES}/${ADR1}#R-4`);
  assert(r4.type === "obligation");
  assertEquals(r4.verdict, "met");
  assertEquals(r4.evidence, ["src/Verify.java:55"]);
  const r1 = node(m, `adr:${FIXTURES}/${ADR1}#R-1`);
  assert(r1.type === "obligation");
  assertEquals(r1.verdict, "unmet");
  // ADR-0002's obligations are recorded by nobody.
  const b1 = node(m, `adr:${FIXTURES}/${ADR2}#R-1`);
  assert(b1.type === "obligation");
  assertEquals(b1.verdict, null);
});

Deno.test("trace pairs one tech spec with every spec it lists, scope and all", () => {
  const dir = copyFixtures();
  const OTHER = "pdf-verify-copy.yamlet.yaml";
  Deno.copyFileSync(`${dir}/${SPEC}`, `${dir}/${OTHER}`);
  const ts = Deno.readTextFileSync(`${dir}/${TECHSPEC}`);
  const second = `- path: ${OTHER}\n  scope:\n  - AC-1\n  requirements:\n  - id: RQ-1\n` +
    "    acceptance-criteria:\n    - id: AC-1\n      met: false\n\nobligations:\n";
  const task = `- id: T-5\n  title: Fix the copy\n  covers:\n  - ${OTHER}#AC-1\n` +
    "  depends_on:\n  - T-1\n";
  Deno.writeTextFileSync(
    `${dir}/${TECHSPEC}`,
    ts.replace("\nobligations:\n", second) + task,
  );

  const summary = trace([dir, "--format=json"]).summary;
  assertStringIncludes(summary, "2 specs, 1 tech spec,");
  const m = model(dir);
  const [a, b] = [...m.specs].sort((x, y) => (x.file < y.file ? -1 : 1));
  assertEquals(b!.file, `${dir}/${SPEC}`);
  assertEquals(a!.file, `${dir}/${OTHER}`);
  assertEquals(a!.techspec, `${dir}/${TECHSPEC}`);
  assertEquals(b!.techspec, `${dir}/${TECHSPEC}`);
  // The scoped spec: one criterion in scope, the other nine counted apart.
  assertEquals(a!.criteria, { met: 0, unmet: 1, unrecorded: 0, total: 1, outOfScope: 9 });
  assertEquals(a!.uncovered, []);
  assertEquals(a!.tasks, 2); // T-5, and the enabler T-1
  const out = node(m, `spec:${dir}/${OTHER}#AC-2`);
  assert(out.type === "criterion");
  assertEquals(out.verdict, null);
  assertEquals(out.outOfScope, true);
  // A task names the specs it covers; it depends across them freely.
  const t5 = node(m, `task:${dir}/${TECHSPEC}#T-5`);
  assert(t5.type === "task");
  assertEquals(t5.specs, [`spec:${dir}/${OTHER}`]);
  assert(edges(m, "depends_on").includes(`${t5.id} -> task:${dir}/${TECHSPEC}#T-1`));
  // The enabler belongs to every spec the tech spec pairs with.
  const t1 = node(m, `task:${dir}/${TECHSPEC}#T-1`);
  assert(t1.type === "task");
  assertEquals(t1.specs.length, 2);
});

Deno.test("trace does not owe a task to an obligation that was cited but never declared", () => {
  const dir = copyFixtures();
  // ADR-0002 cites ADR-0001#R-9; ADR-0001 declares only R-1..R-4.
  const adr2 = Deno.readTextFileSync(`${dir}/${ADR2}`);
  Deno.writeTextFileSync(`${dir}/${ADR2}`, adr2.replace("ADR-0001#R-4", "ADR-0001#R-9"));
  const m = model(dir);
  assertEquals(node(m, `adr:${dir}/${ADR1}#R-9`).missing, true); // still drawn, as missing
  assertEquals(m.specs[0]!.openObligations, []);
});

Deno.test("trace marks a criterion the tech spec does not record as unrecorded", () => {
  const dir = copyFixtures();
  const ts = Deno.readTextFileSync(`${dir}/${TECHSPEC}`);
  const cut = ts.replace(
    "    - id: AC-7\n      met: true\n      evidence:\n      - src/Header.java:31\n",
    "",
  );
  assert(cut !== ts);
  Deno.writeTextFileSync(`${dir}/${TECHSPEC}`, cut);
  const m = model(dir);
  assertEquals(verdict(m, `spec:${dir}/${SPEC}#AC-7`), "unrecorded");
  assertEquals(m.specs[0]!.criteria.unrecorded, 1);
});

Deno.test("trace leaves verdicts null for a spec with no tech spec", () => {
  const dir = copyFixtures();
  Deno.removeSync(`${dir}/${TECHSPEC}`);
  const m = model(dir);
  assertEquals(verdict(m, `spec:${dir}/${SPEC}#AC-1`), null);
  const [r] = m.specs;
  assertEquals(r!.techspec, null);
  assertEquals(r!.criteria, { met: 0, unmet: 0, unrecorded: 10, total: 10, outOfScope: 0 });
  assertEquals(r!.uncovered, []); // nothing is judged, so nothing is owed a task
  assertEquals(m.nodes.filter((n) => n.type === "task").length, 0);
});

// ── dangling references and unreadable files ───────────────────────────────

Deno.test("trace draws a reference that resolves to nothing as a missing node", () => {
  const dir = copyFixtures();
  const spec = Deno.readTextFileSync(`${dir}/${SPEC}`);
  Deno.writeTextFileSync(`${dir}/${SPEC}`, spec.replace(ADR2, "ADR-0077-gone.adr.yaml"));
  const adr2 = Deno.readTextFileSync(`${dir}/${ADR2}`);
  Deno.writeTextFileSync(
    `${dir}/${ADR2}`,
    adr2.replace("- ADR-0001\n", "- ADR-0001\n- ADR-0099\n"),
  );

  const m = model(dir);
  const gone = node(m, `adr:${dir}/ADR-0077-gone.adr.yaml`);
  assertEquals(gone.missing, true);
  assert(edges(m, "decided_by").includes(`spec:${dir}/${SPEC}#AC-8 -> ${gone.id}`));
  const byId = node(m, `adr:${dir}/ADR-0099`);
  assertEquals(byId.missing, true);
  assert(edges(m, "assumes").includes(`adr:${dir}/${ADR2} -> ${byId.id}`));
});

Deno.test("trace lists an unparseable file as skipped and traces the rest", () => {
  const dir = copyFixtures();
  Deno.writeTextFileSync(`${dir}/ADR-0005-broken.adr.yaml`, "adr: ADR-0005\n\ttitle: tabbed\n");
  const m = model(dir);
  assertEquals(m.skipped.length, 1);
  assertEquals(m.skipped[0]!.file, `${dir}/ADR-0005-broken.adr.yaml`);
  assertStringIncludes(m.skipped[0]!.reason, "parse error");
  assertEquals(m.specs.length, 1);
});

Deno.test("trace follows an ADR link out of DIR and reads the record there", () => {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/specs`);
  Deno.mkdirSync(`${root}/decisions`);
  for (const f of [SPEC, TECHSPEC]) Deno.copyFileSync(`${FIXTURES}/${f}`, `${root}/specs/${f}`);
  for (const f of [ADR1, ADR2]) Deno.copyFileSync(`${FIXTURES}/${f}`, `${root}/decisions/${f}`);
  const spec = Deno.readTextFileSync(`${root}/specs/${SPEC}`);
  Deno.writeTextFileSync(
    `${root}/specs/${SPEC}`,
    spec.replaceAll("- ADR-000", "- ../decisions/ADR-000"),
  );
  const m = model(`${root}/specs`);
  const a1 = node(m, `adr:${root}/decisions/${ADR1}`);
  assert(a1.type === "adr" && !a1.missing);
  assertEquals(a1.adrStatus, "accepted");
  assertEquals(m.specs[0]!.openObligations, []); // obligations resolve across the folders
});

// ── pairing tech specs with specs ───────────────────────────────────────────

Deno.test("trace uses neither of two tech specs naming one spec, and says why", () => {
  const dir = copyFixtures();
  Deno.mkdirSync(`${dir}/old`);
  const ts = Deno.readTextFileSync(`${dir}/${TECHSPEC}`);
  Deno.writeTextFileSync(
    `${dir}/old/${TECHSPEC}`,
    ts.replace(`- path: ${SPEC}`, `- path: ../${SPEC}`),
  );

  const m = model(dir);
  const [r] = m.specs;
  assertEquals(r!.techspec, null);
  assertStringIncludes(r!.techspecIssue ?? "", "ambiguous");
  assertEquals(
    m.skipped.map((s) => s.file).sort(),
    [`${dir}/old/${TECHSPEC}`, `${dir}/${TECHSPEC}`].sort(),
  );

  // --techspec settles it: the pinned one is used, the other is set aside.
  const pinned = model(dir, [`--techspec=${dir}/old/${TECHSPEC}`]);
  assertEquals(pinned.specs[0]!.techspec, `${dir}/old/${TECHSPEC}`);
  assertEquals(pinned.skipped.length, 1);
  assertStringIncludes(pinned.skipped[0]!.reason, "--techspec");
});

Deno.test("trace --techspec pairs a tech spec that lives outside DIR", () => {
  const dir = copyFixtures();
  Deno.removeSync(`${dir}/${TECHSPEC}`);
  const elsewhere = Deno.makeTempDirSync();
  const ts = Deno.readTextFileSync(`${FIXTURES}/${TECHSPEC}`);
  Deno.writeTextFileSync(
    `${elsewhere}/${TECHSPEC}`,
    ts.replace(`- path: ${SPEC}`, `- path: ${dir}/${SPEC}`),
  );

  const m = model(dir, [`--techspec=${elsewhere}/${TECHSPEC}`]);
  assertEquals(m.specs[0]!.techspec, `${elsewhere}/${TECHSPEC}`);
  assertEquals(m.specs[0]!.criteria.met, 7);
});

Deno.test("trace refuses a --techspec it cannot use", () => {
  const dir = copyFixtures();
  let r = trace([dir, `--techspec=${dir}/nope.techspec.yaml`]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "unreadable");

  const lost = `${Deno.makeTempDirSync()}/lost.techspec.yaml`;
  Deno.writeTextFileSync(
    lost,
    "system: x\nanalysis:\n  commit: 9f3c1ab\nspecs:\n- path: nowhere.yamlet.yaml\n",
  );
  r = trace([dir, `--techspec=${lost}`]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "was not found");

  r = trace([dir, `--techspec=${dir}/${SPEC}`]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "*.techspec.yaml");
});

// ── the command surface ─────────────────────────────────────────────────────

Deno.test("trace takes a directory, never a file", () => {
  const r = trace([`${FIXTURES}/${SPEC}`]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "takes a directory");
  assertStringIncludes(r.stderr, "yamlet graph");
});

Deno.test("trace requires --out and refuses to overwrite a yamlet source file", () => {
  let r = trace([FIXTURES, "--out="]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "requires --out");
  for (const out of ["x.yamlet.yaml", "x.techspec.yaml", "x.adr.yaml"]) {
    r = trace([FIXTURES, `--out=${out}`]);
    assertEquals(r.exitCode, 2);
    assertStringIncludes(r.stderr, "must not name a yamlet source file");
  }
});

Deno.test("trace rejects bad flags", () => {
  const cases: [string[], string][] = [
    [["--format=dot"], "unsupported format: dot"],
    [["--format=json", "--libs=cdn"], "--libs only applies to --format=html"],
    [["--libs=nope"], "unsupported --libs: nope"],
    [["--recursive"], "unknown flag for trace: --recursive"],
    [[FIXTURES], "too many arguments"],
  ];
  for (const [extra, msg] of cases) {
    const r = trace([FIXTURES, ...extra]);
    assertEquals(r.exitCode, 2, msg);
    assertStringIncludes(r.stderr, msg);
  }
  const r = trace(["/no/such/dir"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "path not found");
});

Deno.test("trace prints a one-line summary, never the payload", () => {
  const r = trace([FIXTURES, "--format=json"]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.summary, "json");
  assertStringIncludes(r.summary, "1 spec, 1 tech spec, 4 ADRs, 4 tasks, 7/10 criteria met");
  assertEquals(r.summary.split("\n").length, 2); // one line + trailing newline
  assert(!r.summary.includes("yamlet.trace/v1"));
});

Deno.test("trace's met ratio counts only specs a tech spec has judged", () => {
  const dir = copyFixtures();
  // A second spec with no tech spec: its criteria are not "unmet", just unjudged.
  Deno.copyFileSync(`${FIXTURES}/${SPEC}`, `${dir}/other.yamlet.yaml`);
  const r = trace([dir, "--format=json"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertStringIncludes(r.summary, "2 specs, 1 tech spec");
  assertStringIncludes(r.summary, "7/10 criteria met");
});

// A marker only the inlined elk UMD bundle contains (see graph_test.ts).
const ELK_INLINE_MARK = "function(f){if(typeof exports";

Deno.test("trace --format=html (the default) inlines the model, both viewers' scripts and a pinned elk", () => {
  const r = trace([FIXTURES]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.summary, "html");
  assertStringIncludes(r.payload, "<!DOCTYPE html>");
  assertStringIncludes(r.payload, "window.__YAMLET_TRACE__ = {");
  assertStringIncludes(r.payload, "yamlet.trace/v1");
  assertStringIncludes(r.payload, "window.YamletViewer"); // common.js
  assertStringIncludes(r.payload, "yamlet trace viewer"); // trace.js
  assertStringIncludes(
    r.payload,
    'src="https://cdn.jsdelivr.net/npm/elkjs@0.12.0/lib/elk.bundled.js"',
  );
  assertStringIncludes(r.payload, 'integrity="sha384-');
  assert(!r.payload.includes(ELK_INLINE_MARK));
});

Deno.test("trace --libs=embed inlines elk and references no external origin", () => {
  const r = trace([FIXTURES, "--libs=embed"]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.payload, ELK_INLINE_MARK);
  assert(!r.payload.includes("cdn.jsdelivr.net"));
});
