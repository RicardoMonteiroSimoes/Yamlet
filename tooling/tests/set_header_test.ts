// `set-header` rewrites topic, summary or description in place — the header
// prose an append can make wrong — under the same rules `init` applies.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runAddCriterion, runAddRequirement, runInit, runSetHeader } from "../src/author.ts";
import { verifyText } from "../src/verify.ts";

function seed(): { file: string; read: () => string } {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/svc.yamlet.yaml`;
  runInit([
    file,
    "--system",
    "svc",
    "--topic",
    "Define workflows",
    "--summary",
    "Lets a human define workflows.",
    "--description",
    "Assembles the define scope.",
    "--blast-radius",
    "low",
    "--front",
    "internal",
  ]);
  runAddRequirement([file, "--description", "first"]);
  runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--pattern",
    "event",
    "--when",
    "a request is handled",
    "--shall",
    "a",
  ]);
  return { file, read: () => Deno.readTextFileSync(file) };
}

Deno.test("set-header rewrites the named fields and leaves the rest byte-identical", () => {
  const { file, read } = seed();
  const before = read();
  const r = runSetHeader([
    file,
    "--summary",
    "Lets a human define workflows and open their runs.",
    "--description",
    "Assembles the define and runs scopes.",
  ]);
  assertEquals(r.exitCode, 0);
  assertEquals(
    read(),
    before
      .replace(
        "summary: Lets a human define workflows.",
        "summary: Lets a human define workflows and open their runs.",
      )
      .replace("  Assembles the define scope.", "  Assembles the define and runs scopes."),
  );
  assertEquals(verifyText(file, read()).result.errors, []);
});

Deno.test("set-header replaces a hand-folded multi-line description whole", () => {
  const { file, read } = seed();
  Deno.writeTextFileSync(
    file,
    read().replace("  Assembles the define scope.\n", "  Line one\n\n  line two.\n"),
  );
  assertEquals(runSetHeader([file, "--description", "One line."]).exitCode, 0);
  assertStringIncludes(read(), "description: >-\n  One line.\nblast_radius: low\n");
  assertEquals(read().includes("line two"), false);
});

Deno.test("set-header quotes as init does", () => {
  const { file, read } = seed();
  assertEquals(runSetHeader([file, "--topic", "Runs: open one"]).exitCode, 0);
  assertStringIncludes(read(), 'topic: "Runs: open one"\n');
  assertEquals(verifyText(file, read()).result.errors, []);
});

Deno.test("a summary over budget rolls back (exit 3), even if the old one was over too", () => {
  const { file, read } = seed();
  const long = Array.from({ length: 31 }, (_, i) => `w${i}`).join(" ");
  const before = read();
  const r = runSetHeader([file, "--summary", long]);
  assertEquals(r.exitCode, 3);
  assertStringIncludes(r.stderr, "E305");
  assertEquals(read(), before);

  // A hand edit left a 31-word summary; a same-length rewrite is still refused.
  Deno.writeTextFileSync(file, before.replace("Lets a human define workflows.", long));
  const again = long.replace("w0", "x0");
  assertEquals(runSetHeader([file, "--summary", again]).exitCode, 3);
});

Deno.test("set-header usage errors write nothing", () => {
  const { file, read } = seed();
  const before = read();
  assertEquals(runSetHeader([file]).exitCode, 2);
  assertEquals(runSetHeader([file, "--front", "external"]).exitCode, 2);
  assertEquals(runSetHeader([file, "--blast-radius", "high"]).exitCode, 2);
  assertEquals(runSetHeader([file, "--topic", ""]).exitCode, 2);
  assertEquals(runSetHeader([file, "--summary", "a\nb"]).exitCode, 2);
  assertEquals(runSetHeader([file, "--topic", "a", "--topic", "b"]).exitCode, 2);
  assertEquals(runSetHeader([`${file}.missing`, "--topic", "a"]).exitCode, 2);
  assertEquals(read(), before);
});

Deno.test("every append reminds the author the header may now be stale", () => {
  const { file } = seed();
  const rq = runAddRequirement([file, "--description", "second"]);
  assertStringIncludes(rq.stderr, "NOTE: RQ-2 adds behaviour");
  assertStringIncludes(rq.stderr, "yamlet set-header");
  const ac = runAddCriterion([
    file,
    "--rq",
    "RQ-2",
    "--pattern",
    "event",
    "--when",
    "a run is opened",
    "--shall",
    "b",
  ]);
  assertStringIncludes(ac.stderr, "NOTE: AC-2 adds behaviour");
});
