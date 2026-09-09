// `yamlet techspec` end to end: a tech spec is built from a finished spec by
// the four subcommands, comes out in canonical order whatever order it was
// recorded in, and every rejection is a usage error that writes nothing.
// `verify` on the result is the closing gate the skill relies on.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runAddAdr, runAddCriterion, runAddRequirement, runInit } from "../src/author.ts";
import {
  runTechspec,
  runTechspecAnalysis,
  runTechspecCriterion,
  runTechspecInit,
  runTechspecTask,
} from "../src/techspec_author.ts";
import { verifyFile } from "../src/verify.ts";
import { renderHuman, renderJson } from "../src/render.ts";
import type { CmdResult } from "../src/types.ts";

/** A finished spec: two requirements, AC-1/AC-2 under RQ-1 and AC-3 under RQ-2. */
function seedSpec(dir: string): string {
  const file = `${dir}/svc.yamlet.yaml`;
  runInit([
    file,
    "--system",
    "svc",
    "--topic",
    "T",
    "--summary",
    "s",
    "--description",
    "d",
    "--blast-radius",
    "low",
    "--front",
    "internal",
  ]);
  runAddRequirement([file, "--description", "first"]);
  runAddCriterion([file, "--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "a"]);
  runAddCriterion([file, "--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "b"]);
  runAddRequirement([file, "--description", "second"]);
  runAddCriterion([file, "--rq", "RQ-2", "--pattern", "ubiquitous", "--shall", "c"]);
  return file;
}

function exists(p: string): boolean {
  try {
    Deno.statSync(p);
    return true;
  } catch {
    return false;
  }
}
function ok(r: CmdResult, what: string): void {
  assertEquals(r.exitCode, 0, `${what}: ${r.stderr}`);
}
function refused(r: CmdResult, needle: string): void {
  assertEquals(r.exitCode, 2, `expected a usage error, got exit ${r.exitCode}: ${r.stderr}`);
  assertStringIncludes(r.stderr, needle);
}

Deno.test("init writes spec + system next to the spec and prints the path", () => {
  const dir = Deno.makeTempDirSync();
  const spec = seedSpec(dir);
  const r = runTechspecInit([spec]);
  ok(r, "init");
  assertEquals(r.stdout, `${dir}/svc.techspec.yaml\n`);
  assertEquals(
    Deno.readTextFileSync(`${dir}/svc.techspec.yaml`),
    "spec: svc.yamlet.yaml\nsystem: svc\n",
  );

  // A fresh tech spec carries only in-progress findings: no analysis, no verdicts.
  const v = verifyFile(`${dir}/svc.techspec.yaml`);
  assertEquals(v.exitCode, 1);
  assertEquals(v.result.errors.map((e) => e.rule), ["E701", "E706", "E706", "E706"]);
});

Deno.test("init --out elsewhere records the spec relative to the tech spec's directory", () => {
  const dir = Deno.makeTempDirSync();
  const spec = seedSpec(dir);
  Deno.mkdirSync(`${dir}/plan/deep`, { recursive: true });
  ok(runTechspecInit([spec, "--out", `${dir}/plan/deep/x.techspec.yaml`]), "init --out");
  const text = Deno.readTextFileSync(`${dir}/plan/deep/x.techspec.yaml`);
  assertEquals(text, "spec: ../../svc.yamlet.yaml\nsystem: svc\n");
  // And the recorded path resolves: verify finds the spec through it.
  const rules = verifyFile(`${dir}/plan/deep/x.techspec.yaml`).result.errors.map((e) => e.rule);
  assertEquals(rules.includes("E703"), false);
  assertEquals(rules.includes("E706"), true);
});

Deno.test("init refuses an unfinished spec, a spec with nothing to plan, and an overwrite", () => {
  const dir = Deno.makeTempDirSync();
  const spec = seedSpec(dir);

  // Unfinished: a requirement with no criteria is an E108 error.
  runAddRequirement([spec, "--description", "third"]);
  refused(runTechspecInit([spec]), "has verify errors");
  assertEquals(exists(`${dir}/svc.techspec.yaml`), false, "nothing written");

  // A spec with zero criteria never verifies clean (E106/E108), so "nothing to
  // plan" is unreachable through init; the existence and extension checks are.
  refused(runTechspecInit([`${dir}/nope.yamlet.yaml`]), "spec not found");
  Deno.writeTextFileSync(`${dir}/svc.yaml`, "system: svc\n");
  refused(runTechspecInit([`${dir}/svc.yaml`]), "must be a .yamlet.yaml file");

  const good = seedSpec(Deno.makeTempDirSync());
  ok(runTechspecInit([good]), "init");
  refused(runTechspecInit([good]), "refusing to overwrite");
  refused(runTechspecInit([good, "--out", `${dir}/x.yaml`]), "--out must use the .techspec.yaml");
});

Deno.test("the full flow: verdicts in any order come out in spec order, tasks are minted", () => {
  const dir = Deno.makeTempDirSync();
  const spec = seedSpec(dir);
  const ts = `${dir}/svc.techspec.yaml`;
  ok(runTechspecInit([spec]), "init");

  ok(
    runTechspecAnalysis([ts, "--commit", "9f3c1ab", "--deep", "src/main", "--skimmed", "src/res"]),
    "analysis",
  );
  // The commit is fixed; the path lists accumulate and dedupe.
  ok(runTechspecAnalysis([ts, "--deep", "src/test", "--deep", "src/main"]), "analysis again");

  // Recorded out of order: AC-3 first, then AC-1, then AC-2.
  ok(
    runTechspecCriterion([ts, "--ac", "AC-3", "--met", "false", "--note", "not\n  there"]),
    "AC-3",
  );
  ok(
    runTechspecCriterion([ts, "--ac", "AC-1", "--met", "true", "--evidence", "src/main/A.java:12"]),
    "AC-1",
  );
  ok(
    runTechspecCriterion([
      ts,
      "--ac",
      "AC-2",
      "--met",
      "false",
      "--evidence",
      "src/main/B.java:40",
    ]),
    "AC-2",
  );

  const t1 = runTechspecTask([ts, "--title", "Fixtures", "--why", "none exist"]);
  ok(t1, "T-1");
  assertEquals(t1.stdout, "T-1\n");
  const t2 = runTechspecTask([
    ts,
    "--title",
    "Do b",
    "--covers",
    "AC-2",
    "--depends-on",
    "T-1",
  ]);
  assertEquals(t2.stdout, "T-2\n");
  const t3 = runTechspecTask([
    ts,
    "--title",
    "Do c: the rest",
    "--covers",
    "AC-3",
    "--depends-on",
    "T-1",
    "--depends-on",
    "T-2",
  ]);
  assertEquals(t3.stdout, "T-3\n");

  assertEquals(
    Deno.readTextFileSync(ts),
    `spec: svc.yamlet.yaml
system: svc

analysis:
  commit: 9f3c1ab
  deep:
  - src/main
  - src/test
  skimmed:
  - src/res

requirements:
- id: RQ-1
  acceptance-criteria:
  - id: AC-1
    met: true
    evidence:
    - src/main/A.java:12
  - id: AC-2
    met: false
    evidence:
    - src/main/B.java:40
- id: RQ-2
  acceptance-criteria:
  - id: AC-3
    met: false
    note: not there

tasks:
- id: T-1
  title: Fixtures
  why: none exist
- id: T-2
  title: Do b
  covers:
  - AC-2
  depends_on:
  - T-1
- id: T-3
  title: "Do c: the rest"
  covers:
  - AC-3
  depends_on:
  - T-1
  - T-2
`,
  );

  const v = verifyFile(ts);
  assertEquals(v.exitCode, 0, JSON.stringify(v.result.errors));
  assertEquals(v.result.summary, { requirements: 2, acceptanceCriteria: 3, tasks: 3 });
  assertEquals(
    renderHuman(v.result, v.kind).stdout,
    `OK: ${ts} (2 requirements, 3 acceptance-criteria, 3 tasks)\n`,
  );
  assertStringIncludes(renderJson(v.result, v.kind), '"tasks":3}}');
});

Deno.test("analysis: first call needs the commit, later calls may not change it", () => {
  const dir = Deno.makeTempDirSync();
  const ts = `${dir}/svc.techspec.yaml`;
  ok(runTechspecInit([seedSpec(dir)]), "init");
  refused(runTechspecAnalysis([ts, "--deep", "src"]), "requires --commit");
  refused(runTechspecAnalysis([ts, "--commit", "not-hex"]), "7–40 hex");
  ok(runTechspecAnalysis([ts, "--commit", "9f3c1ab", "--deep", "src"]), "analysis");
  refused(runTechspecAnalysis([ts, "--commit", "0000000"]), "pinned to commit 9f3c1ab");
  refused(runTechspecAnalysis([ts, "--skimmed", "src"]), "deep or skimmed, not both");
  refused(runTechspecAnalysis([ts, "--deep", " "]), "cannot be empty");
});

Deno.test("criterion: unknown, duplicate, met-without-evidence and bad --met are refused", () => {
  const dir = Deno.makeTempDirSync();
  const ts = `${dir}/svc.techspec.yaml`;
  ok(runTechspecInit([seedSpec(dir)]), "init");
  const before = Deno.readTextFileSync(ts);

  refused(runTechspecCriterion([ts, "--ac", "AC-9", "--met", "false"]), "no such criterion");
  refused(runTechspecCriterion([ts, "--ac", "AC-1", "--met", "yes"]), "--met true|false");
  refused(
    runTechspecCriterion([ts, "--ac", "AC-1", "--met", "true"]),
    "needs at least one --evidence",
  );
  refused(
    runTechspecCriterion([
      ts,
      "--ac",
      "AC-1",
      "--met",
      "true",
      "--evidence",
      "a:1",
      "--evidence",
      "a:1",
    ]),
    "duplicate --evidence",
  );
  refused(runTechspecCriterion([ts, "--met", "false"]), "requires --ac");
  assertEquals(Deno.readTextFileSync(ts), before, "nothing written");

  ok(runTechspecCriterion([ts, "--ac", "AC-1", "--met", "false"]), "AC-1");
  refused(
    runTechspecCriterion([ts, "--ac", "AC-1", "--met", "true", "--evidence", "a:1"]),
    "already has a verdict",
  );
});

Deno.test("task: covers must be recorded and unmet; why only on enablers; deps must exist", () => {
  const dir = Deno.makeTempDirSync();
  const ts = `${dir}/svc.techspec.yaml`;
  ok(runTechspecInit([seedSpec(dir)]), "init");
  ok(runTechspecCriterion([ts, "--ac", "AC-1", "--met", "true", "--evidence", "a:1"]), "AC-1");
  ok(runTechspecCriterion([ts, "--ac", "AC-2", "--met", "false"]), "AC-2");

  refused(runTechspecTask([ts, "--covers", "AC-2"]), "requires --title");
  refused(runTechspecTask([ts, "--title", "x"]), "needs --why");
  refused(runTechspecTask([ts, "--title", "x", "--covers", "AC-2", "--why", "w"]), "drop --why");
  refused(runTechspecTask([ts, "--title", "x", "--covers", "AC-1"]), "already met");
  refused(runTechspecTask([ts, "--title", "x", "--covers", "AC-3"]), "has no verdict yet");
  refused(runTechspecTask([ts, "--title", "x", "--covers", "AC-9"]), "no such criterion");
  refused(
    runTechspecTask([ts, "--title", "x", "--covers", "AC-2", "--covers", "AC-2"]),
    "duplicate --covers",
  );
  refused(
    runTechspecTask([ts, "--title", "x", "--covers", "AC-2", "--depends-on", "T-1"]),
    "no such task",
  );
  refused(
    runTechspecTask([ts, "--title", "x", "--covers", "AC-2", "--depends-on", "x"]),
    "expected T-N",
  );

  ok(runTechspecTask([ts, "--title", "x", "--covers", "AC-2"]), "T-1");
  refused(
    runTechspecTask([
      ts,
      "--title",
      "y",
      "--why",
      "w",
      "--depends-on",
      "T-1",
      "--depends-on",
      "T-1",
    ]),
    "duplicate --depends-on",
  );
});

Deno.test("a hand-edited tech spec with a hard error is refused for mutation, not repaired", () => {
  const dir = Deno.makeTempDirSync();
  const ts = `${dir}/svc.techspec.yaml`;
  ok(runTechspecInit([seedSpec(dir)]), "init");
  Deno.writeTextFileSync(ts, Deno.readTextFileSync(ts) + "tasks:\n- id: T-1\n  title: t\n");
  const r = runTechspecAnalysis([ts, "--commit", "9f3c1ab"]);
  refused(r, "has errors");
  assertStringIncludes(r.stderr, "E713");
});

Deno.test("dispatch: no subcommand or an unknown one is a usage error", () => {
  assertEquals(runTechspec([]).exitCode, 2);
  const r = runTechspec(["bogus"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "Unknown techspec subcommand: bogus");
  assertEquals(runTechspec(["init"]).exitCode, 2);
});

Deno.test("decided behaviour: verdict and task print the linked ADRs; unlinked stays quiet", () => {
  const dir = Deno.makeTempDirSync();
  const spec = seedSpec(dir);
  Deno.mkdirSync(`${dir}/adr`);
  Deno.writeTextFileSync(`${dir}/adr/ADR-0001.adr.yaml`, "adr: ADR-0001\nstatus: proposed\n");
  Deno.writeTextFileSync(`${dir}/adr/ADR-0002.adr.yaml`, "adr: ADR-0002\nstatus: proposed\n");
  ok(runAddAdr([spec, "adr/ADR-0001.adr.yaml", "--rq", "RQ-1"]), "link RQ-1");
  ok(runAddAdr([spec, "adr/ADR-0002.adr.yaml", "--ac", "AC-2"]), "link AC-2");
  ok(
    runAddAdr([spec, "adr/ADR-0001.adr.yaml", "--ac", "AC-2"]),
    "link AC-2 again (dedupes in notice)",
  );
  const ts = `${dir}/svc.techspec.yaml`;
  ok(runTechspecInit([spec]), "init");
  ok(runTechspecAnalysis([ts, "--commit", "9f3c1ab"]), "analysis");

  // AC-1: decided via its requirement only.
  const a1 = runTechspecCriterion([ts, "--ac", "AC-1", "--met", "true", "--evidence", "a:1"]);
  ok(a1, "AC-1");
  assertEquals(
    a1.stderr,
    "DECIDED: AC-1 is decided by an ADR (via RQ-1).\n  adr/ADR-0001.adr.yaml\n" +
      "The evidence for AC-1 must fit these decisions.\n",
  );
  // AC-2: via the requirement and itself; the shared record appears once.
  const a2 = runTechspecCriterion([ts, "--ac", "AC-2", "--met", "false"]);
  ok(a2, "AC-2");
  assertEquals(
    a2.stderr,
    "DECIDED: AC-2 is decided by an ADR (via RQ-1 and itself).\n  adr/ADR-0001.adr.yaml\n  adr/ADR-0002.adr.yaml\n" +
      "The task covering AC-2 must fit these decisions, or state that one no longer holds.\n",
  );
  // AC-3: nothing linked.
  const a3 = runTechspecCriterion([ts, "--ac", "AC-3", "--met", "false"]);
  ok(a3, "AC-3");
  assertEquals(a3.stderr, "");

  const t1 = runTechspecTask([ts, "--title", "only c", "--covers", "AC-3"]);
  assertEquals(t1.stdout, "T-1\n");
  assertEquals(t1.stderr, "");
  const t2 = runTechspecTask([ts, "--title", "b and c", "--covers", "AC-2", "--covers", "AC-3"]);
  assertEquals(t2.stdout, "T-2\n");
  assertEquals(
    t2.stderr,
    "DECIDED: T-2 covers behaviour an ADR decides.\n  AC-2: adr/ADR-0001.adr.yaml, adr/ADR-0002.adr.yaml\n",
  );
  assertEquals(verifyFile(ts).exitCode, 0);
});
