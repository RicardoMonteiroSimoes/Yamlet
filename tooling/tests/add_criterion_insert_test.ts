// `add-criterion` can target any requirement, and `--after` inserts between two
// existing criteria. This is the first wall from the editing design to come
// down: attaching to an earlier requirement used to be refused outright, with a
// message saying it would require editing an existing block.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runAddCriterion, runAddRequirement, runInit } from "../src/author.ts";
import { verifyText } from "../src/verify.ts";

/** A spec with two requirements, one criterion each (AC-1 under RQ-1, AC-2 under RQ-2). */
function seed(): { file: string; read: () => string } {
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
  runAddRequirement([file, "--description", "second"]);
  runAddCriterion([file, "--rq", "RQ-2", "--pattern", "ubiquitous", "--shall", "b"]);
  return { file, read: () => Deno.readTextFileSync(file) };
}

/** Ids in file order. */
function ids(text: string): string[] {
  return [...text.matchAll(/id: ((?:RQ|AC)-[0-9]+[a-z]?)/g)].map((m) => m[1]!);
}

Deno.test("a criterion can be added to an earlier requirement", () => {
  const { file, read } = seed();

  const r = runAddCriterion([file, "--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "c"]);
  assertEquals(r.exitCode, 0);
  assertEquals(r.stdout, "AC-3\n");

  // It lands inside RQ-1, after that requirement's existing criteria — not at
  // the end of the file, which is where a pure appender would have put it.
  assertEquals(ids(read()), ["RQ-1", "AC-1", "AC-3", "RQ-2", "AC-2"]);
  assertEquals(verifyText(file, read()).result.valid, true);
});

Deno.test("--after inserts directly behind the named criterion with a suffixed id", () => {
  const { file, read } = seed();
  runAddCriterion([file, "--rq", "RQ-2", "--pattern", "ubiquitous", "--shall", "c"]); // AC-3

  const r = runAddCriterion([
    file,
    "--rq",
    "RQ-2",
    "--after",
    "AC-2",
    "--pattern",
    "unwanted",
    "--if",
    "x",
    "--shall",
    "y",
  ]);
  assertEquals(r.exitCode, 0);
  assertEquals(r.stdout, "AC-2a\n");
  assertEquals(ids(read()), ["RQ-1", "AC-1", "RQ-2", "AC-2", "AC-2a", "AC-3"]);
  assertEquals(verifyText(file, read()).result.valid, true);
});

Deno.test("repeated inserts after one anchor walk the suffix, renumbering nothing", () => {
  const { file, read } = seed();
  for (const shall of ["x", "y"]) {
    runAddCriterion([
      file,
      "--rq",
      "RQ-1",
      "--after",
      "AC-1",
      "--pattern",
      "ubiquitous",
      "--shall",
      shall,
    ]);
  }
  // Each insert goes directly after the anchor, so the later one precedes the
  // earlier — and AC-1/AC-2 keep the ids they were allocated.
  assertEquals(ids(read()), ["RQ-1", "AC-1", "AC-1b", "AC-1a", "RQ-2", "AC-2"]);
  assertEquals(verifyText(file, read()).result.valid, true);
});

Deno.test("appending to the file's last requirement is still a plain append", () => {
  const { file, read } = seed();
  const before = read();
  const r = runAddCriterion([file, "--rq", "RQ-2", "--pattern", "ubiquitous", "--shall", "c"]);

  assertEquals(r.exitCode, 0);
  // Byte-for-byte: the previous content is untouched and the new block follows it.
  assertEquals(read().startsWith(before), true);
  assertEquals(read().slice(before.length).startsWith("  - id: AC-3\n"), true);
});

Deno.test("an unknown requirement is refused, and the message names the real ones", () => {
  const { file, read } = seed();
  const before = read();

  const r = runAddCriterion([file, "--rq", "RQ-9", "--pattern", "ubiquitous", "--shall", "a"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "no such requirement: RQ-9");
  assertStringIncludes(r.stderr, "RQ-1, RQ-2");
  assertEquals(read(), before); // nothing written
});

Deno.test("--after must name a criterion of --rq, and says where it actually lives", () => {
  const { file, read } = seed();
  const before = read();

  const r = runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--after",
    "AC-2", // AC-2 belongs to RQ-2
    "--pattern",
    "ubiquitous",
    "--shall",
    "a",
  ]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "belongs to RQ-2, not RQ-1");
  assertStringIncludes(r.stderr, "--rq RQ-2");
  assertEquals(read(), before);

  const missing = runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--after",
    "AC-99",
    "--pattern",
    "ubiquitous",
    "--shall",
    "a",
  ]);
  assertEquals(missing.exitCode, 2);
  assertStringIncludes(missing.stderr, "no such criterion: AC-99");
});

Deno.test("a criterion still cannot be added before any requirement exists", () => {
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

  const r = runAddCriterion([file, "--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "a"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "no requirements yet");
});
