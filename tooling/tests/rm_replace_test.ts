// `rm`, `replace` and `set-description` — changing behaviour that already exists.
// A block is never cut out: it becomes a tombstone (id, `removed`, optional
// `replaced_by`), so its id is never minted again and every reference to it
// still resolves. A changed obligation is a new obligation under a new id.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  runAddAdr,
  runAddCriterion,
  runAddRequirement,
  runAddState,
  runInit,
  runReplace,
  runRm,
  runSetDescription,
} from "../src/author.ts";
import { blocksOf } from "../src/blocks.ts";
import { verifyFile, verifyText } from "../src/verify.ts";
import { runTests } from "../src/tests.ts";
import { indexSpec } from "../src/techspec.ts";
import { runAdr } from "../src/adr_author.ts";
import { runDocs } from "../src/docs.ts";

/** RQ-1 (AC-1, AC-2) and RQ-2 (AC-3), on a contract whose one input every criterion uses. */
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
    "--expose-name",
    "svc",
    "--expose-intent",
    "handle a request",
    "--input",
    "request",
  ]);
  const crit = (rq: string, shall: string) =>
    runAddCriterion([
      file,
      "--rq",
      rq,
      "--pattern",
      "event",
      "--when",
      "{input.request} is handled",
      "--shall",
      shall,
    ]);
  runAddRequirement([file, "--description", "first"]);
  crit("RQ-1", "a");
  crit("RQ-1", "b");
  runAddRequirement([file, "--description", "second"]);
  crit("RQ-2", "c");
  Deno.mkdirSync(`${dir}/adr`);
  Deno.writeTextFileSync(`${dir}/adr/ADR-0001.adr.yaml`, "adr: ADR-0001\n");
  return { dir, file, read: () => Deno.readTextFileSync(file) };
}

const errors = (file: string, text: string) => verifyText(file, text).result.errors;

Deno.test("rm --ac leaves a tombstone in place and the rest byte-identical", () => {
  const { file, read } = seed();
  const before = read();
  const r = runRm([file, "--ac", "AC-1", "--reason", "no longer needed"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertEquals(r.stdout, "AC-1\n");
  assertStringIncludes(r.stderr, "orphaned");
  const after = read();
  assertEquals(
    after,
    before.replace(
      '  - id: AC-1\n    pattern: event\n    when: "{input.request} is handled"\n    shall:\n    - a\n',
      "  - id: AC-1\n    removed: no longer needed\n",
    ),
  );
  assertEquals(errors(file, after), []);
  const b = blocksOf(after).find((x) => x.id === "AC-1")!;
  assertEquals(b.removed, "no longer needed");
});

Deno.test("a removed id is never minted again, even when it was the highest", () => {
  const { file, read } = seed();
  assertEquals(runRm([file, "--ac", "AC-2", "--reason", "x"]).exitCode, 0);
  // AC-3 is still highest; remove RQ-2 so AC-3 is a tombstone too.
  assertEquals(runAddRequirement([file, "--description", "third"]).exitCode, 0);
  const add = (rq: string) =>
    runAddCriterion([
      file,
      "--rq",
      rq,
      "--pattern",
      "event",
      "--when",
      "{input.request} is handled",
      "--shall",
      "d",
    ]);
  assertEquals(add("RQ-3").stdout, "AC-4\n");
  assertEquals(runRm([file, "--ac", "AC-4", "--reason", "x"]).exitCode, 2); // last live of RQ-3
  assertEquals(runRm([file, "--rq", "RQ-3", "--reason", "x"]).stdout, "RQ-3\nAC-4\n");
  // RQ-3 and AC-4 are the highest ids, and both are removed: the next ones are new.
  assertEquals(runAddRequirement([file, "--description", "fourth"]).stdout, "RQ-4\n");
  assertEquals(add("RQ-4").stdout, "AC-5\n");
  // Inserting after a sibling skips a removed suffix too.
  assertEquals(
    runAddCriterion([
      file,
      "--rq",
      "RQ-4",
      "--after",
      "AC-5",
      "--pattern",
      "event",
      "--when",
      "{input.request} is handled",
      "--shall",
      "e",
    ]).stdout,
    "AC-5a\n",
  );
  assertEquals(runRm([file, "--ac", "AC-5a", "--reason", "x"]).exitCode, 0);
  assertEquals(
    runAddCriterion([
      file,
      "--rq",
      "RQ-4",
      "--after",
      "AC-5",
      "--pattern",
      "event",
      "--when",
      "{input.request} is handled",
      "--shall",
      "f",
    ]).stdout,
    "AC-5b\n",
  );
  assertEquals(errors(file, read()), []);
});

Deno.test("rm --rq tombstones the requirement and every criterion under it", () => {
  const { file, read } = seed();
  assertEquals(runRm([file, "--ac", "AC-2", "--reason", "own reason"]).exitCode, 0);
  const r = runRm([file, "--rq", "RQ-1", "--reason", "gone", "--replaced-by", "RQ-2"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertEquals(r.stdout, "RQ-1\nAC-1\n");
  assertStringIncludes(
    read(),
    "- id: RQ-1\n  removed: gone\n  replaced_by: RQ-2\n  acceptance-criteria:\n" +
      "  - id: AC-1\n    removed: gone\n  - id: AC-2\n    removed: own reason\n- id: RQ-2\n",
  );
  assertEquals(errors(file, read()), []);
  assertEquals(verifyText(file, read()).result.summary, { requirements: 1, acceptanceCriteria: 1 });
});

Deno.test("rm refuses what would leave a spec asserting nothing, or a block already gone", () => {
  const { file, read } = seed();
  const before = read();
  assertStringIncludes(runRm([file, "--ac", "AC-3", "--reason", "x"]).stderr, "--rq RQ-2");
  assertEquals(runRm([file, "--rq", "RQ-1", "--reason", "x"]).exitCode, 0);
  assertStringIncludes(runRm([file, "--rq", "RQ-2", "--reason", "x"]).stderr, "last live");
  assertStringIncludes(runRm([file, "--rq", "RQ-1", "--reason", "x"]).stderr, "already removed");
  assertStringIncludes(runRm([file, "--ac", "AC-3"]).stderr, "--reason");
  assertStringIncludes(runRm([file, "--ac", "AC-9", "--reason", "x"]).stderr, "no such criterion");
  assertEquals(runRm([file, "--ac", "AC-1", "--rq", "RQ-1", "--reason", "x"]).exitCode, 2);
  assert(read() !== before);
});

Deno.test("--replaced-by must name another live block of the same kind", () => {
  const { file } = seed();
  for (const to of ["AC-1", "RQ-2", "AC-9"]) {
    const r = runRm([file, "--ac", "AC-1", "--reason", "x", "--replaced-by", to]);
    assertEquals(r.exitCode, 2, to);
  }
  assertEquals(runRm([file, "--ac", "AC-2", "--reason", "x"]).exitCode, 0);
  assertEquals(runRm([file, "--ac", "AC-1", "--reason", "x", "--replaced-by", "AC-2"]).exitCode, 2);
  assertEquals(runRm([file, "--ac", "AC-1", "--reason", "x", "--replaced-by", "AC-3"]).exitCode, 2); // last live
});

Deno.test("a removal that orphans a contract input is rolled back", () => {
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
    "--expose-name",
    "svc",
    "--expose-intent",
    "i",
    "--input",
    "a",
    "--input",
    "b",
  ]);
  runAddRequirement([file, "--description", "r"]);
  for (const t of ["a", "b"]) {
    runAddCriterion([
      file,
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      `{input.${t}}`,
      "--shall",
      "x",
    ]);
  }
  runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--pattern",
    "event",
    "--when",
    "{input.a} again",
    "--shall",
    "y",
  ]);
  const before = Deno.readTextFileSync(file);
  const r = runRm([file, "--ac", "AC-2", "--reason", "x"]);
  assertEquals(r.exitCode, 3);
  assertStringIncludes(r.stderr, "E506");
  assertStringIncludes(r.stderr, "contract");
  assertEquals(Deno.readTextFileSync(file), before);
});

Deno.test("replace tombstones the criterion and writes the new obligation under a new id", () => {
  const { file, read } = seed();
  const r = runReplace([
    file,
    "--ac",
    "AC-1",
    "--reason",
    "a is now a2",
    "--pattern",
    "event",
    "--when",
    "{input.request} is handled",
    "--shall",
    "a2",
  ]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertEquals(r.stdout, "AC-1a\n");
  assertStringIncludes(
    read(),
    "  - id: AC-1\n    removed: a is now a2\n    replaced_by: AC-1a\n" +
      '  - id: AC-1a\n    pattern: event\n    when: "{input.request} is handled"\n' +
      "    shall:\n    - a2\n  - id: AC-2\n",
  );
  assertEquals(errors(file, read()), []);
  // The tombstone is not replaceable, and not a place to add anything.
  const again = runReplace([
    file,
    "--ac",
    "AC-1",
    "--reason",
    "x",
    "--pattern",
    "event",
    "--when",
    "w",
    "--shall",
    "s",
  ]);
  assertStringIncludes(again.stderr, "replaced by AC-1a");
  assertEquals(runAddState([file, "--ac", "AC-1", "--reads", "a.b"]).exitCode, 2);
  assertEquals(runAddAdr([file, "adr/ADR-0001.adr.yaml", "--ac", "AC-1"]).exitCode, 2);
  assertEquals(
    runAddCriterion([
      file,
      "--rq",
      "RQ-1",
      "--after",
      "AC-1",
      "--pattern",
      "event",
      "--when",
      "w",
      "--shall",
      "s",
    ]).exitCode,
    2,
  );
});

Deno.test("replace checks the new criterion exactly as add-criterion does", () => {
  const { file, read } = seed();
  const before = read();
  const r = runReplace([
    file,
    "--ac",
    "AC-1",
    "--reason",
    "x",
    "--pattern",
    "event",
    "--shall",
    "s",
  ]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "pattern=event requires --when");
  const u = runReplace([
    file,
    "--ac",
    "AC-1",
    "--reason",
    "x",
    "--pattern",
    "event",
    "--when",
    "{input.nope}",
    "--shall",
    "s",
  ]);
  assertStringIncludes(u.stderr, "not a declared exposes input");
  assertEquals(runReplace([file, "--ac", "AC-1", "--pattern", "event"]).exitCode, 2);
  assertEquals(read(), before);
});

Deno.test("replace on a decided criterion names the decision, and does not carry it over", () => {
  const { file, read } = seed();
  assertEquals(runAddAdr([file, "adr/ADR-0001.adr.yaml", "--ac", "AC-3"]).exitCode, 0);
  runAddCriterion([
    file,
    "--rq",
    "RQ-2",
    "--pattern",
    "event",
    "--when",
    "{input.request} x",
    "--shall",
    "k",
  ]);
  const r = runReplace([
    file,
    "--ac",
    "AC-3",
    "--reason",
    "x",
    "--pattern",
    "event",
    "--when",
    "{input.request} is handled",
    "--shall",
    "c2",
  ]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertStringIncludes(r.stderr, "WARNING: AC-3 is decided by an ADR");
  assertStringIncludes(r.stderr, "adr/ADR-0001.adr.yaml");
  assert(!read().includes("adrs:"));
});

Deno.test("set-description rewords a requirement in place and nothing else", () => {
  const { file, read } = seed();
  const before = read();
  const r = runSetDescription([file, "--rq", "RQ-2", "--description", "second, reworded"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertEquals(read(), before.replace("    second\n", "    second, reworded\n"));
  assertEquals(runSetDescription([file, "--rq", "RQ-2", "--description", "a\nb"]).exitCode, 2);
  assertEquals(runSetDescription([file, "--rq", "RQ-9", "--description", "x"]).exitCode, 2);
  // Over the word budget (E305): rolled back.
  const long = Array(40).fill("word").join(" ");
  assertEquals(runSetDescription([file, "--rq", "RQ-2", "--description", long]).exitCode, 3);
  assertEquals(read(), before.replace("    second\n", "    second, reworded\n"));
  // On a linked requirement, the decision is named.
  assertEquals(runAddAdr([file, "adr/ADR-0001.adr.yaml", "--rq", "RQ-1"]).exitCode, 0);
  const d = runSetDescription([file, "--rq", "RQ-1", "--description", "first, reworded"]);
  assertEquals(d.exitCode, 0, d.stderr);
  assertStringIncludes(d.stderr, "WARNING: RQ-1");
  assertStringIncludes(read(), "  description: >-\n    first, reworded\n  adrs:\n");
  assertEquals(runRm([file, "--rq", "RQ-1", "--reason", "x"]).exitCode, 0);
  assertEquals(runSetDescription([file, "--rq", "RQ-1", "--description", "x"]).exitCode, 2);
});

Deno.test("the test projection drops tombstones and lists them in the manifest", () => {
  const { dir, file } = seed();
  runReplace([
    file,
    "--ac",
    "AC-1",
    "--reason",
    "changed",
    "--pattern",
    "event",
    "--when",
    "{input.request} is handled",
    "--shall",
    "a2",
  ]);
  const out = `${dir}/out`;
  assertEquals(runTests([dir, out]).exitCode, 0);
  const feature = Deno.readTextFileSync(`${out}/svc/svc.feature`);
  assert(!feature.includes("@AC-1 "));
  assertStringIncludes(feature, "@AC-1a");
  const manifest = JSON.parse(Deno.readTextFileSync(`${out}/manifest.json`));
  assertEquals(manifest.removed, {
    "svc/svc.feature": { "AC-1": { reason: "changed", replaced_by: "AC-1a" } },
  });
  assert(!("AC-1" in manifest.features["svc/svc.feature"]));
});

Deno.test("the tech spec index knows no tombstone", () => {
  const { file, read } = seed();
  runRm([file, "--ac", "AC-1", "--reason", "x"]);
  const idx = indexSpec(read())!;
  assertEquals(idx.criteria, ["AC-2", "AC-3"]);
});

Deno.test("an accepted ADR still verifies after the criterion it arose from is removed", () => {
  const src = new URL("./verifier-fixtures/", import.meta.url).pathname;
  const dir = Deno.makeTempDirSync();
  for (const f of ["pdf-verify.yamlet.yaml", "ADR-0001-structural-pdf-parsing.adr.yaml"]) {
    Deno.copyFileSync(`${src}${f}`, `${dir}/${f}`);
  }
  const adr = `${dir}/ADR-0001-structural-pdf-parsing.adr.yaml`;
  const spec = `${dir}/pdf-verify.yamlet.yaml`;
  const errs = () => verifyFile(adr).result.errors.filter((e) => e.rule === "E807");
  assertEquals(errs(), []);
  const r = runRm([spec, "--ac", "AC-8", "--reason", "folded into AC-9", "--replaced-by", "AC-9"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertEquals(errs(), []);
});

Deno.test("no new decision arises from a removed criterion", () => {
  const src = new URL("./verifier-fixtures/", import.meta.url).pathname;
  const dir = Deno.makeTempDirSync();
  Deno.copyFileSync(`${src}pdf-verify.yamlet.yaml`, `${dir}/pdf-verify.yamlet.yaml`);
  const spec = `${dir}/pdf-verify.yamlet.yaml`;
  assertEquals(
    runRm([spec, "--ac", "AC-8", "--reason", "gone", "--replaced-by", "AC-9"]).exitCode,
    0,
  );
  const r = runAdr([
    "init",
    dir,
    "--title",
    "T",
    "--kind",
    "selection",
    "--date",
    "2026-09-07",
    "--arises-from",
    "pdf-verify.yamlet.yaml#AC-8",
    "--question",
    "Which?",
  ]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "is removed (gone); decide against AC-9");
});

Deno.test("a docs page keeps a tombstone's anchor and says what replaced it", () => {
  const { dir, file } = seed();
  runReplace([
    file,
    "--ac",
    "AC-1",
    "--reason",
    "changed",
    "--pattern",
    "event",
    "--when",
    "{input.request} is handled",
    "--shall",
    "a2",
  ]);
  const r = runDocs([dir, `${dir}/site`]);
  assertEquals(r.exitCode, 0, r.stderr);
  const page = Deno.readTextFileSync(`${dir}/site/svc/svc.md`);
  assertStringIncludes(
    page,
    '<a id="ac-1"></a>\n**~~AC-1~~ · removed: changed · replaced by [AC-1a](#ac-1a)**\n',
  );
});
