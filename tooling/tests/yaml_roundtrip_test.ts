// Every writer's output is standard YAML, and a standard parser reads from it
// exactly the values yamlet's own flattener reads. The failure this guards
// (issue #21): an unquoted colon-space made a `shall` entry a mapping, which
// yamlet then dropped without a word, and made ADR/tech spec values that other
// YAML parsers refuse outright.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";
import { needsQuote, readQuoted, scalar } from "../src/scalar.ts";
import { flatten } from "../src/flatten.ts";
import { runAddCriterion, runAddRequirement, runInit } from "../src/author.ts";
import { runAdr } from "../src/adr_author.ts";
import {
  runTechspecAnalysis,
  runTechspecCriterion,
  runTechspecInit,
  runTechspecTask,
} from "../src/techspec_author.ts";
import { runTests } from "../src/tests.ts";
import { verifyFile } from "../src/verify.ts";
import type { CmdResult } from "../src/types.ts";

const FIXTURES = new URL("./verifier-fixtures/", import.meta.url).pathname;
const ORACLE_AUTHOR = new URL("./oracle-author/", import.meta.url).pathname;

function ok(r: CmdResult, what: string): CmdResult {
  assertEquals(r.exitCode, 0, `${what}: ${r.stderr}`);
  return r;
}

/**
 * The standard parse of `text` as yamlet-style leaf paths. Every leaf must be a
 * string — except `met` (a bool) and an ADR's `date` (a timestamp), the two
 * keys whose value is meant to be typed. A bare key with nothing under it is
 * null to a standard parser and has no record in yamlet's; both mean "empty".
 */
function standardLeaves(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string): void => {
    if (v === null) return; // a key with nothing under it (`requirements:`) — no record either
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v instanceof Date) {
      assertEquals(path, "date", `only date may be a timestamp, got one at ${path}`);
      out.set(path, v.toISOString().slice(0, 10));
    } else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path === "" ? k : `${path}.${k}`);
    } else if (typeof v === "boolean") {
      assert(path.endsWith(".met"), `only met may be a bool, got ${v} at ${path}`);
      out.set(path, String(v));
    } else {
      assertEquals(typeof v, "string", `${path} is a ${typeof v} (${v}) to a standard parser`);
      out.set(path, v as string);
    }
  };
  walk(parse(text), "");
  return out;
}

/** yamlet's own reading of `text`, as the same path → value map. */
function yamletLeaves(text: string): Map<string, string> {
  const { records, parseErrors } = flatten(text);
  assertEquals(parseErrors, []);
  return new Map(records.map((r) => [r.path, r.value]));
}

function assertRoundTrips(text: string, what: string): void {
  assertEquals(standardLeaves(text), yamletLeaves(text), what);
}

const TRICKY = [
  "store {output.issued_voter_token} under the key formed by lunch-vote-token: followed by {input.poll_id}",
  "Confirm ADR-0003's obligations: R-1 by task",
  "tightest/highest-frequency cap: 60 requests / minute",
  "ends with a colon:",
  '"reason" must be recorded',
  "a path C:\\temp\\x and a \\n that is literal",
  "{placeholder} first",
  "[bracketed] first",
  "- dash first",
  "? question first",
  ": colon first",
  "#hash first",
  "value # with a comment",
  "&anchor",
  "*alias",
  "!tag",
  "|pipe",
  ">fold",
  "'single'",
  "%directive",
  "@at",
  "`tick",
  "true",
  "no",
  "off",
  "null",
  "~",
  "42",
  "-3.5",
  "1e3",
  "0x1F",
  "0o17",
  "010",
  "1:30",
  ".inf",
  ".nan",
  "2026-09-23",
  "=",
  " leading space",
  "trailing space ",
  "",
  "tab\there",
  "a-b: a colon-space mid-value",
];
const PLAIN = [
  "authenticate over TLS",
  "src/main/A.java:12",
  "AC-3",
  "ADR-0001#R-2",
  "send a keepalive every 30s",
  "retry-after:header",
  "9f3c1ab",
  "v1.2.3",
];

Deno.test("scalar: a standard parser and the flattener both read back the exact string", () => {
  for (const s of [...TRICKY, ...PLAIN]) {
    for (const doc of [`k: ${scalar(s)}\n`, `k:\n- ${scalar(s)}\n`]) {
      const std = parse(doc) as { k: string | string[] };
      assertEquals(Array.isArray(std.k) ? std.k[0] : std.k, s, `standard: ${doc}`);
      if (!/[\t]/.test(s) && s === s.trim()) {
        // The flattener trims and forbids raw tabs; for everything else it must agree.
        const recs = flatten(doc).records;
        assertEquals(recs.map((r) => r.value), [s], `yamlet: ${doc}`);
      }
    }
  }
});

Deno.test("scalar: stays plain whenever plain already reads back as the string", () => {
  for (const s of PLAIN) {
    assertEquals(needsQuote(s), false, s);
    assertEquals(scalar(s), s);
  }
});

Deno.test("readQuoted: decodes YAML escapes and stops at the closing quote", () => {
  assertEquals(readQuoted('"a \\"b\\" \\\\ c" # comment'), 'a "b" \\ c');
  assertEquals(readQuoted('"\\x41\\u00e9\\t"'), "Aé\t");
  assertEquals(readQuoted('"unknown \\q stays"'), "unknown \\q stays");
  assertEquals(readQuoted('"unterminated'), "unterminated");
});

Deno.test("flatten: a double-quoted list entry is a scalar even with a colon-space inside", () => {
  const { records } = flatten('shall:\n- "a: b"\n- c: d\n');
  assertEquals(records.map((r) => [r.path, r.value]), [["shall[0]", "a: b"], ["shall[1].c", "d"]]);
});

Deno.test("spec writer: a shall with a colon-space survives into the file, verify and the projection", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/vote.yamlet.yaml`;
  ok(
    runInit([
      file,
      "--system",
      "lunch",
      "--topic",
      "Voting: tokens",
      "--summary",
      "Issues voter tokens: one per poll",
      "--description",
      "d",
      "--blast-radius",
      "low",
      "--front",
      "internal",
      "--expose-name",
      "vote",
      "--expose-intent",
      "issue: a token",
      "--input",
      "poll_id",
      "--output",
      "issued_voter_token",
    ]),
    "init",
  );
  ok(runAddRequirement([file, "--description", "Tokens: issued once"]), "RQ-1");
  ok(
    runAddCriterion([
      file,
      "--rq",
      "RQ-1",
      "--pattern",
      "complex",
      "--while",
      "state: open",
      "--when",
      "a vote is cast: first time",
      "--shall",
      TRICKY[0]!,
      "--shall",
      "respond: 201",
    ]),
    "AC-1",
  );
  ok(
    runAddCriterion([
      file,
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      "a vote arrives for {n}",
      "--shall",
      "count it",
      "--example",
      "n=0",
      "--example",
      "n=yes: really",
    ]),
    "AC-2",
  );
  const text = Deno.readTextFileSync(file);
  assertRoundTrips(text, "spec");
  const leaves = yamletLeaves(text);
  assertEquals(leaves.get("requirements[0].acceptance-criteria[0].shall[0]"), TRICKY[0]);
  assertEquals(leaves.get("requirements[0].acceptance-criteria[0].shall[1]"), "respond: 201");
  assertEquals(verifyFile(file).exitCode, 0);

  const out = `${dir}/features`;
  ok(runTests([dir, out]), "tests");
  const feature = Deno.readTextFileSync(`${out}/lunch/vote.feature`);
  assertStringIncludes(feature, "lunch-vote-token: followed by");
});

Deno.test("tech spec writer: titles, notes and why with a colon-space are standard YAML", () => {
  const dir = Deno.makeTempDirSync();
  const spec = `${dir}/svc.yamlet.yaml`;
  runInit([
    spec,
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
  runAddRequirement([spec, "--description", "first"]);
  runAddCriterion([spec, "--rq", "RQ-1", "--pattern", "event", "--when", "x", "--shall", "a"]);
  const ts = ok(runTechspecInit([spec]), "init").stdout.trim();
  ok(runTechspecAnalysis([ts, "--commit", "1234567", "--deep", "src: main"]), "analysis");
  ok(
    runTechspecCriterion([ts, "--ac", "AC-1", "--met", "false", "--note", "gap: none of it"]),
    "criterion",
  );
  ok(runTechspecTask([ts, "--title", "Do c: the rest", "--covers", "AC-1"]), "T-1");
  ok(runTechspecTask([ts, "--title", "Enable: x", "--why", "because: y"]), "T-2");
  assertRoundTrips(Deno.readTextFileSync(ts), "techspec");
  assertEquals(verifyFile(ts).exitCode, 0);
});

Deno.test("ADR writer: a title and a basis quantity with a colon-space are standard YAML", () => {
  const dir = Deno.makeTempDirSync();
  Deno.copyFileSync(`${FIXTURES}pdf-verify.yamlet.yaml`, `${dir}/pdf-verify.yamlet.yaml`);
  const A = ok(
    runAdr([
      "init",
      dir,
      "--title",
      TRICKY[1]!,
      "--kind",
      "policy",
      "--date",
      "2026-09-23",
      "--arises-from",
      "pdf-verify.yamlet.yaml#AC-8",
      "--question",
      "What: exactly?",
    ]),
    "init",
  ).stdout.trim();
  ok(runAdr(["add-force", A, "Forces: fold fine"]), "force");
  ok(runAdr(["add-basis", A, "--quantity", TRICKY[2]!, "--source", "load test: 2026-08"]), "B-1");
  assertRoundTrips(Deno.readTextFileSync(A), "adr");
});

Deno.test("every frozen writer output round-trips through a standard parser", () => {
  for (const e of Deno.readDirSync(ORACLE_AUTHOR)) {
    assertRoundTrips(Deno.readTextFileSync(ORACLE_AUTHOR + e.name), e.name);
  }
  for (const f of ["ADR-0001-structural-pdf-parsing", "ADR-0002-isolation-of-structural-parsing"]) {
    assertRoundTrips(Deno.readTextFileSync(`${FIXTURES}${f}.adr.yaml`), f);
  }
});

Deno.test("verify: a while/shall entry read as a mapping is E306, and states no shall (E304)", () => {
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
  runAddCriterion([file, "--rq", "RQ-1", "--pattern", "event", "--when", "x", "--shall", "a"]);
  // Hand-edited the way the old writer emitted it: unquoted colon-space.
  const text = Deno.readTextFileSync(file).replace(
    "    - a\n",
    "    - store it under the key lunch-vote-token: followed by the id\n",
  );
  Deno.writeTextFileSync(file, text);
  const v = verifyFile(file);
  assertEquals(v.exitCode, 1);
  assertEquals(v.result.errors.map((e) => e.rule).sort(), ["E304", "E306"]);
  assertStringIncludes(
    v.result.errors.find((e) => e.rule === "E306")!.message,
    "store it under the key lunch-vote-token: followed by the id",
  );

  // And `yamlet tests` refuses to project a criterion with no Then, touching nothing.
  const out = `${dir}/features`;
  const r = runTests([dir, out]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "AC-1 has no shall text");
  assertStringIncludes(r.stderr, "has an entry read as a mapping");
  let made = true;
  try {
    Deno.statSync(out);
  } catch {
    made = false;
  }
  assertEquals(made, false, "TARGET untouched");
});

Deno.test("verify: a tech spec list entry read as a mapping is reported, not dropped", () => {
  const dir = Deno.makeTempDirSync();
  const spec = `${dir}/svc.yamlet.yaml`;
  runInit([
    spec,
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
  runAddRequirement([spec, "--description", "first"]);
  runAddCriterion([spec, "--rq", "RQ-1", "--pattern", "event", "--when", "x", "--shall", "a"]);
  const ts = ok(runTechspecInit([spec]), "init").stdout.trim();
  ok(runTechspecAnalysis([ts, "--commit", "1234567", "--deep", "src"]), "analysis");
  ok(runTechspecCriterion([ts, "--ac", "AC-1", "--met", "true", "--evidence", "a.ts:1"]), "AC-1");
  Deno.writeTextFileSync(
    ts,
    Deno.readTextFileSync(ts).replace("    - a.ts:1\n", "    - a.ts: line 1\n"),
  );
  const rules = verifyFile(ts).result.errors.map((e) => e.rule).sort();
  assertEquals(rules, ["E709", "E710"]);
});
