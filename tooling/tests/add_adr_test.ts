// `add-adr` links a decision record to a requirement or a criterion — the first
// mutation that rewrites an existing block rather than appending after the last
// one, and the first through the stricter (rule, message)-keyed commit gate.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  decidedNotice,
  runAddAdr,
  runAddCriterion,
  runAddRequirement,
  runInit,
} from "../src/author.ts";
import { blocksOf } from "../src/blocks.ts";
import { verifyText } from "../src/verify.ts";

/** A spec with RQ-1 (AC-1, AC-2) and RQ-2 (AC-3), plus two ADR files beside it. */
function seed(): { dir: string; file: string; read: () => string } {
  const dir = Deno.makeTempDirSync();
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
  Deno.mkdirSync(`${dir}/adr`);
  Deno.writeTextFileSync(`${dir}/adr/ADR-0001.md`, "# 1\n");
  Deno.writeTextFileSync(`${dir}/adr/ADR-0002.md`, "# 2\n");
  return { dir, file, read: () => Deno.readTextFileSync(file) };
}

Deno.test("a requirement's link lands before its criteria; a criterion's at its end", () => {
  const { file, read } = seed();
  assertEquals(runAddAdr([file, "adr/ADR-0001.md", "--rq", "RQ-1"]).exitCode, 0);
  assertEquals(runAddAdr([file, "adr/ADR-0002.md", "--ac", "AC-1"]).exitCode, 0);

  const text = read();
  assertStringIncludes(
    text,
    "  description: >-\n    first\n  adrs:\n  - adr/ADR-0001.md\n  acceptance-criteria:\n",
  );
  assertStringIncludes(
    text,
    "  - id: AC-1\n    pattern: ubiquitous\n    shall:\n    - a\n    adrs:\n    - adr/ADR-0002.md\n  - id: AC-2\n",
  );
  assertEquals(verifyText(file, text).result.valid, true);
});

Deno.test("a second link appends to the existing list; the same path twice is refused", () => {
  const { file, read } = seed();
  runAddAdr([file, "adr/ADR-0001.md", "--rq", "RQ-2"]);
  runAddAdr([file, "adr/ADR-0001.md", "--ac", "AC-3"]);
  assertEquals(runAddAdr([file, "adr/ADR-0002.md", "--rq", "RQ-2"]).exitCode, 0);
  assertEquals(runAddAdr([file, "adr/ADR-0002.md", "--ac", "AC-3"]).exitCode, 0);

  const text = read();
  assertStringIncludes(
    text,
    "  adrs:\n  - adr/ADR-0001.md\n  - adr/ADR-0002.md\n  acceptance-criteria:\n",
  );
  assertStringIncludes(text, "    adrs:\n    - adr/ADR-0001.md\n    - adr/ADR-0002.md\n");

  const dup = runAddAdr([file, "adr/ADR-0002.md", "--rq", "RQ-2"]);
  assertEquals(dup.exitCode, 2);
  assertStringIncludes(dup.stderr, "RQ-2 already links adr/ADR-0002.md");
  assertEquals(read(), text, "nothing written");
  assertEquals(verifyText(file, text).result.valid, true);
});

Deno.test("the same ADR may be linked on several requirements", () => {
  const { file, read } = seed();
  assertEquals(runAddAdr([file, "adr/ADR-0001.md", "--rq", "RQ-1"]).exitCode, 0);
  assertEquals(runAddAdr([file, "adr/ADR-0001.md", "--rq", "RQ-2"]).exitCode, 0);
  assertEquals(verifyText(file, read()).result.valid, true);
});

Deno.test("block extents stay true: criteria can still be appended and inserted around links", () => {
  const { file, read } = seed();
  runAddAdr([file, "adr/ADR-0001.md", "--rq", "RQ-1"]);
  runAddAdr([file, "adr/ADR-0001.md", "--ac", "AC-1"]);

  // Insert after the linked criterion: lands after its adrs list, not inside it.
  assertEquals(
    runAddCriterion([
      file,
      "--rq",
      "RQ-1",
      "--after",
      "AC-1",
      "--pattern",
      "ubiquitous",
      "--shall",
      "x",
    ])
      .stdout,
    "AC-1a\n",
  );
  // Append to the linked requirement: lands after its last criterion.
  assertEquals(
    runAddCriterion([file, "--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "y"]).stdout,
    "AC-4\n",
  );
  const ids = blocksOf(read()).map((b) => b.id);
  assertEquals(ids, ["RQ-1", "AC-1", "AC-1a", "AC-2", "AC-4", "RQ-2", "AC-3"]);
  assertStringIncludes(read(), "    - a\n    adrs:\n    - adr/ADR-0001.md\n  - id: AC-1a\n");
  assertEquals(verifyText(file, read()).result.valid, true);
});

Deno.test("refusals: missing file, unknown id, wrong kind, neither/both selectors", () => {
  const { file, read } = seed();
  const before = read();
  const cases: [string[], string][] = [
    [[file, "adr/ADR-0009.md", "--rq", "RQ-1"], "does not resolve to a file"],
    [
      [file, "adr/ADR-0001.md", "--rq", "RQ-9"],
      "no such requirement: RQ-9 (this spec has RQ-1, RQ-2)",
    ],
    [[file, "adr/ADR-0001.md", "--ac", "RQ-1"], "no such criterion: RQ-1"],
    [[file, "adr/ADR-0001.md", "--rq", "AC-1"], "no such requirement: AC-1"],
    [[file, "adr/ADR-0001.md"], "exactly one of --rq RQ-N or --ac AC-N"],
    [[file, "adr/ADR-0001.md", "--rq", "RQ-1", "--ac", "AC-1"], "exactly one of"],
    [[file, "--rq", "RQ-1"], "requires PATH"],
    [[file, "adr/ADR-0001.md", "extra", "--rq", "RQ-1"], "too many arguments"],
    [[file, "adr/ADR-0001.md", "--rq", "RQ-1", "--bogus"], "unknown flag"],
    [[`${file}.nope`, "adr/ADR-0001.md", "--rq", "RQ-1"], "file not found"],
  ];
  for (const [args, needle] of cases) {
    const r = runAddAdr(args);
    assertEquals(r.exitCode, 2, `${args.join(" ")}: ${r.stderr}`);
    assertStringIncludes(r.stderr, needle);
  }
  assertEquals(read(), before, "nothing written");
});

Deno.test("E109: a link whose file disappears is reported on the spec", () => {
  const { dir, file, read } = seed();
  runAddAdr([file, "adr/ADR-0001.md", "--ac", "AC-2"]);
  Deno.removeSync(`${dir}/adr/ADR-0001.md`);
  const { result } = verifyText(file, read());
  assertEquals(result.errors.map((e) => e.rule), ["E109"]);
  assertStringIncludes(result.errors[0]!.message, "adr/ADR-0001.md");
});

Deno.test("adding a criterion under a decided requirement warns loudly, and still applies", () => {
  const { file, read } = seed();
  runAddAdr([file, "adr/ADR-0001.md", "--rq", "RQ-1"]);
  runAddAdr([file, "adr/ADR-0002.md", "--rq", "RQ-1"]);
  runAddAdr([file, "adr/ADR-0002.md", "--ac", "AC-3"]); // a criterion-level link on RQ-2

  const r = runAddCriterion([file, "--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "z"]);
  assertEquals(r.exitCode, 0);
  assertEquals(r.stdout, "AC-4\n");
  assertStringIncludes(r.stderr, "WARNING: RQ-1 is decided by an ADR");
  assertStringIncludes(r.stderr, "AC-4 falls under its decision");
  assertStringIncludes(r.stderr, "  adr/ADR-0001.md\n  adr/ADR-0002.md\n");
  assertStringIncludes(r.stderr, "supersede");
  assertStringIncludes(read(), "    - z\n");

  // A criterion-level link on a sibling does not decide a new criterion of the requirement.
  const quiet = runAddCriterion([file, "--rq", "RQ-2", "--pattern", "ubiquitous", "--shall", "w"]);
  assertEquals(quiet.exitCode, 0);
  assertEquals(quiet.stderr, "");

  // And with --after, the owning requirement's decision still applies.
  const ins = runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--after",
    "AC-1",
    "--pattern",
    "ubiquitous",
    "--shall",
    "v",
  ]);
  assertEquals(ins.stdout, "AC-1a\n");
  assertStringIncludes(ins.stderr, "AC-1a falls under its decision");
});

Deno.test("decidedNotice is empty without links and names every link with one", () => {
  assertEquals(decidedNotice("AC-1", "x", []), "");
  const n = decidedNotice("AC-1", "its shall changed", ["a.md", "b.md"]);
  assertStringIncludes(
    n,
    "WARNING: AC-1 is decided by an ADR — its shall changed.\n  a.md\n  b.md\n",
  );
});
