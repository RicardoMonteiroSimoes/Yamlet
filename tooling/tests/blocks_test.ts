// Block addressing: locating an existing RQ/AC by id and knowing its extent.
//
// The two properties that matter are the ones a naive implementation gets
// wrong: a block's start is its `-` line whatever order its keys are in, and a
// block's end survives a folded scalar spanning lines the records never report.

import { assertEquals } from "jsr:@std/assert@1";
import { blocksOf, criteriaKeyLine, criteriaOf, findBlock, spliceAfter } from "../src/blocks.ts";

const HEAD = "system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\n" +
  "blast_radius: low\nfront: internal\n\n";

Deno.test("blocksOf reports requirements and criteria with their owners", () => {
  const text = HEAD +
    "requirements:\n" +
    "- id: RQ-1\n  description: >-\n    first\n  acceptance-criteria:\n" +
    "  - id: AC-1\n    pattern: ubiquitous\n    shall:\n    - a\n" +
    "- id: RQ-2\n  description: >-\n    second\n  acceptance-criteria:\n" +
    "  - id: AC-2\n    pattern: ubiquitous\n    shall:\n    - b\n" +
    "  - id: AC-3\n    pattern: ubiquitous\n    shall:\n    - c\n";

  const blocks = blocksOf(text);
  assertEquals(blocks.map((b) => b.id), ["RQ-1", "AC-1", "RQ-2", "AC-2", "AC-3"]);
  assertEquals(blocks.map((b) => b.kind), [
    "requirement",
    "criterion",
    "requirement",
    "criterion",
    "criterion",
  ]);
  assertEquals(criteriaOf(blocks, "RQ-2").map((b) => b.id), ["AC-2", "AC-3"]);
  assertEquals(findBlock(blocks, "AC-3")?.parentId, "RQ-2");
  assertEquals(findBlock(blocks, "nope"), undefined);
});

Deno.test("a requirement's own extent stops at acceptance-criteria; its outer extent covers them", () => {
  const text = HEAD +
    "requirements:\n" +
    "- id: RQ-1\n  description: >-\n    first\n  acceptance-criteria:\n" + // lines 9-13
    "  - id: AC-1\n    pattern: ubiquitous\n    shall:\n    - a\n"; //        lines 14-17

  const rq = findBlock(blocksOf(text), "RQ-1")!;
  assertEquals(rq.start, 10);
  assertEquals(rq.end, 13); // the `acceptance-criteria:` line — a header revision's extent
  assertEquals(rq.outerEnd, 17); // through its last criterion — a removal's extent
  assertEquals(criteriaKeyLine(text, rq), 13);
});

Deno.test("a folded description does not truncate the block that contains it", () => {
  // `description: >-` reports the line of its KEY, so a max-record-line extent
  // would stop above the text and cut the requirement in half.
  const text = HEAD +
    "requirements:\n" +
    "- id: RQ-1\n  description: >-\n    a long first line\n  acceptance-criteria:\n" +
    "  - id: AC-1\n    pattern: ubiquitous\n    shall:\n    - a\n" +
    "- id: RQ-2\n  description: >-\n    second\n  acceptance-criteria:\n";

  const blocks = blocksOf(text);
  const ac = findBlock(blocks, "AC-1")!;
  const rq2 = findBlock(blocks, "RQ-2")!;
  // AC-1 ends on its own last line, immediately above RQ-2's dash.
  assertEquals(ac.end, rq2.start - 1);
  assertEquals(text.split("\n")[ac.end - 1], "    - a");
});

Deno.test("extents ignore trailing blank lines and key order", () => {
  const text = HEAD +
    "requirements:\n" +
    // `pattern` before `id`: the dash rides the FIRST key, so the start must
    // still be the dash line rather than wherever `id` happens to sit.
    "- description: >-\n    first\n  id: RQ-1\n  acceptance-criteria:\n" +
    "  - pattern: ubiquitous\n    id: AC-1\n    shall:\n    - a\n" +
    "\n\n";

  const blocks = blocksOf(text);
  assertEquals(blocks.map((b) => b.id), ["RQ-1", "AC-1"]);
  assertEquals(blocks[0]!.start, 10); // the `- description:` line
  const lines = text.split("\n");
  assertEquals(lines[blocks[1]!.end - 1], "    - a"); // blanks trimmed off the end
});

Deno.test("criteriaKeyLine finds the anchor for a requirement with no criteria yet", () => {
  const text = HEAD + "requirements:\n- id: RQ-1\n  description: >-\n    first\n" +
    "  acceptance-criteria:\n";
  const rq = findBlock(blocksOf(text), "RQ-1")!;
  assertEquals(criteriaKeyLine(text, rq), 13);
  assertEquals(rq.outerEnd, 13); // nothing nested, so appending lands on the key line
});

Deno.test("criteriaKeyLine reports 0 when the requirement has no such key", () => {
  const text = HEAD + "requirements:\n- id: RQ-1\n  description: >-\n    first\n";
  const rq = findBlock(blocksOf(text), "RQ-1")!;
  assertEquals(criteriaKeyLine(text, rq), 0);
});

Deno.test("blocksOf is empty for a spec with no requirements", () => {
  assertEquals(blocksOf(HEAD + "requirements:\n"), []);
});

Deno.test("spliceAfter inserts at the line boundary and preserves the rest byte for byte", () => {
  const text = "a\nb\nc\n";
  assertEquals(spliceAfter(text, 2, "X\n"), "a\nb\nX\nc\n");
  // Splicing after the final content line is exactly an append.
  assertEquals(spliceAfter(text, 3, "X\n"), "a\nb\nc\nX\n");
});
