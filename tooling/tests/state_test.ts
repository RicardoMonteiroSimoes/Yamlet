// Stored state: a criterion's `reads`/`writes` (E306–E308), the reverse check that
// a read field has a writer in its system (W009), the author commands that declare
// them (`add-criterion --reads/--writes`, `add-state`), and `systems --state`.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runAddCriterion, runAddRequirement, runAddState, runInit } from "../src/author.ts";
import { verifyText } from "../src/verify.ts";
import { runSystems } from "../src/systems.ts";
import { mergeState } from "../src/state.ts";

/** Run `fn` with the working directory set to `dir`, restoring it afterwards. */
function inDir<T>(dir: string, fn: () => T): T {
  const prev = Deno.cwd();
  Deno.chdir(dir);
  try {
    return fn();
  } finally {
    Deno.chdir(prev);
  }
}

/** A hand-written spec of system `sys` with one criterion carrying `state` lines. */
function spec(sys: string, state: string): string {
  return `system: ${sys}\ntopic: T\nsummary: s\ndescription: >-\n  d\n` +
    `blast_radius: low\nfront: internal\nrequirements:\n- id: RQ-1\n  description: >-\n` +
    `    r\n  acceptance-criteria:\n  - id: AC-1\n    pattern: event\n` +
    `    when: a thing happens\n    shall:\n    - do it\n${state}`;
}

const rules = (file: string, text: string, rule: string) => {
  const r = verifyText(file, text).result;
  return [...r.errors, ...r.warnings].filter((f) => f.rule === rule);
};

// ── verifier ──

Deno.test("E307: a reads/writes entry must be entity.field", () => {
  const dir = Deno.makeTempDirSync();
  const text = spec("svc", "    reads:\n    - poll\n    writes:\n    - Poll.State\n");
  const found = inDir(dir, () => rules("a.yamlet.yaml", text, "E307"));
  assertEquals(found.map((f) => f.path), [
    "requirements[0].acceptance-criteria[0].reads[0]",
    "requirements[0].acceptance-criteria[0].writes[0]",
  ]);
});

Deno.test("E308: a field is named once per criterion, across both lists", () => {
  const dir = Deno.makeTempDirSync();
  const twice = spec("svc", "    writes:\n    - poll.state\n    - poll.state\n");
  const both = spec("svc", "    reads:\n    - poll.state\n    writes:\n    - poll.state\n");
  inDir(dir, () => {
    assertEquals(rules("a.yamlet.yaml", twice, "E308").length, 1);
    assertEquals(rules("a.yamlet.yaml", both, "E308").length, 1);
  });
});

Deno.test("E306: a reads entry read as a mapping is reported, not dropped", () => {
  const dir = Deno.makeTempDirSync();
  const text = spec("svc", "    reads:\n    - poll: state\n");
  const found = inDir(dir, () => rules("a.yamlet.yaml", text, "E306"));
  assertEquals(found.length, 1);
  assertEquals(found[0]!.path, "requirements[0].acceptance-criteria[0].reads[0]");
});

Deno.test("W009: a read field no scope of the system writes is warned on its entry", () => {
  const dir = Deno.makeTempDirSync();
  const text = spec("svc", "    reads:\n    - poll.state\n");
  const found = inDir(dir, () => rules("a.yamlet.yaml", text, "W009"));
  assertEquals(found.length, 1);
  assertEquals(found[0]!.path, "requirements[0].acceptance-criteria[0].reads[0]");
  assertStringIncludes(found[0]!.message, "AC-1: reads poll.state");
});

Deno.test("W009: a writer in another scope of the same system silences it", () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${dir}/b.yamlet.yaml`, spec("svc", "    writes:\n    - poll.state\n"));
  const text = spec("svc", "    reads:\n    - poll.state\n");
  assertEquals(inDir(dir, () => rules("a.yamlet.yaml", text, "W009")), []);
});

Deno.test("W009: a writer in another system does not count", () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${dir}/b.yamlet.yaml`, spec("other", "    writes:\n    - poll.state\n"));
  const text = spec("svc", "    reads:\n    - poll.state\n");
  assertEquals(inDir(dir, () => rules("a.yamlet.yaml", text, "W009")).length, 1);
});

Deno.test("W009: judged on the text in hand, not the file on disk", () => {
  const dir = Deno.makeTempDirSync();
  // On disk the spec writes the field; the text being verified only reads it.
  Deno.writeTextFileSync(`${dir}/a.yamlet.yaml`, spec("svc", "    writes:\n    - poll.state\n"));
  const text = spec("svc", "    reads:\n    - poll.state\n");
  assertEquals(inDir(dir, () => rules("a.yamlet.yaml", text, "W009")).length, 1);
});

// ── contention ──

Deno.test("contended: a writer pairs with every other scope; two readers do not", () => {
  const st = mergeState([
    ["c.yamlet.yaml", [{ ac: "AC-1", condition: "", shall: [], reads: ["p.s"], writes: [] }]],
    ["a.yamlet.yaml", [{ ac: "AC-1", condition: "", shall: [], reads: [], writes: ["p.s"] }]],
    ["b.yamlet.yaml", [{
      ac: "AC-1",
      condition: "",
      shall: [],
      reads: ["p.s", "q.t"],
      writes: [],
    }]],
    ["d.yamlet.yaml", [{ ac: "AC-2", condition: "", shall: [], reads: ["q.t"], writes: [] }]],
  ]);
  assertEquals(st.contended, [
    { field: "p.s", scopes: ["a.yamlet.yaml", "b.yamlet.yaml"] },
    { field: "p.s", scopes: ["a.yamlet.yaml", "c.yamlet.yaml"] },
  ]);
  assertEquals(st.fields.map((u) => u.field), ["p.s", "q.t"]);
  assertEquals(st.fields[0]!.touches[0]!.access, "write");
});

// ── author ──

function seed(dir: string, name: string, system = "svc"): string {
  const file = `${dir}/${name}.yamlet.yaml`;
  runInit([
    file,
    "--system",
    system,
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
  return file;
}

const crit = (file: string, ...extra: string[]) =>
  runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--pattern",
    "event",
    "--when",
    "a thing happens",
    "--shall",
    "do it",
    ...extra,
  ]);

Deno.test("add-criterion --reads/--writes emits both lists after the shall", () => {
  const dir = Deno.makeTempDirSync();
  inDir(dir, () => {
    const file = seed(".", "a");
    const r = crit(file, "--writes", "vote.option", "--reads", "poll.state");
    assertEquals(r.exitCode, 0, r.stderr);
    assertStringIncludes(
      Deno.readTextFileSync(file),
      "    shall:\n    - do it\n    reads:\n    - poll.state\n    writes:\n    - vote.option\n",
    );
  });
});

Deno.test("add-criterion refuses a malformed or repeated field, writing nothing", () => {
  const dir = Deno.makeTempDirSync();
  const file = seed(dir, "a");
  const before = Deno.readTextFileSync(file);
  assertEquals(crit(file, "--reads", "poll").exitCode, 2);
  assertEquals(crit(file, "--reads", "a.b", "--writes", "a.b").exitCode, 2);
  assertEquals(crit(file, "--writes", "a.b", "--writes", "a.b").exitCode, 2);
  assertEquals(Deno.readTextFileSync(file), before);
});

Deno.test("add-state merges, a write supersedes a read, and a no-op is refused", () => {
  const dir = Deno.makeTempDirSync();
  inDir(dir, () => {
    const file = seed(".", "a");
    crit(file);
    crit(file);
    let r = runAddState([file, "--ac", "AC-1", "--reads", "vote.option", "--reads", "poll.state"]);
    assertEquals(r.exitCode, 0, r.stderr);
    assertEquals(r.stdout, "AC-1 reads:  vote.option, poll.state\n");
    r = runAddState([file, "--ac", "AC-1", "--writes", "vote.option"]);
    assertEquals(r.exitCode, 0, r.stderr);
    assertEquals(r.stdout, "AC-1 reads:  poll.state\nAC-1 writes: vote.option\n");
    const text = Deno.readTextFileSync(file);
    // The lists sit at AC-1's end, and AC-2 is untouched after them.
    assertStringIncludes(
      text,
      "    - do it\n    reads:\n    - poll.state\n    writes:\n    - vote.option\n  - id: AC-2\n",
    );
    assertEquals(runAddState([file, "--ac", "AC-1", "--reads", "vote.option"]).exitCode, 2);
    assertEquals(Deno.readTextFileSync(file), text);
    assertEquals(verifyText(file, text).result.errors, []);
  });
});

Deno.test("add-state refuses an unknown criterion and a missing field", () => {
  const dir = Deno.makeTempDirSync();
  const file = seed(dir, "a");
  crit(file);
  assertStringIncludes(runAddState([file, "--ac", "AC-9", "--reads", "a.b"]).stderr, "AC-1");
  assertEquals(runAddState([file, "--ac", "AC-1"]).exitCode, 2);
  assertEquals(runAddState([file, "--ac", "AC-1", "--writes", "ab"]).exitCode, 2);
});

Deno.test("a field shared with another scope prints a NOTE naming it", () => {
  const dir = Deno.makeTempDirSync();
  inDir(dir, () => {
    const closing = seed(".", "closing");
    crit(closing, "--writes", "poll.state");
    const voting = seed(".", "voting");
    const r = crit(voting, "--reads", "poll.state");
    assertEquals(r.exitCode, 0);
    assertStringIncludes(r.stderr, "poll.state: written by closing.yamlet.yaml AC-1");
    // Another system's writer is not this system's contention.
    const other = seed(".", "other", "elsewhere");
    assertEquals(crit(other, "--reads", "poll.state").stderr, "");
  });
});

Deno.test("two readers of one field print no NOTE", () => {
  const dir = Deno.makeTempDirSync();
  inDir(dir, () => {
    crit(seed(".", "a"), "--reads", "poll.state");
    assertEquals(crit(seed(".", "b"), "--reads", "poll.state").stderr, "");
  });
});

// ── systems --state ──

function lunch(): string {
  const dir = Deno.makeTempDirSync();
  inDir(dir, () => {
    crit(seed(".", "closing"), "--writes", "poll.state", "--reads", "vote.option");
    const v = seed(".", "voting");
    crit(v, "--reads", "poll.state", "--writes", "vote.option");
    crit(v, "--reads", "poll.state");
  });
  return dir;
}

Deno.test("systems --state lists fields, writers first, and contended pairs", () => {
  const dir = lunch();
  const r = runSystems([dir, "--state"]);
  assertEquals(r.exitCode, 0);
  const d = dir;
  assertStringIncludes(
    r.stdout,
    `  stored state (2 fields)\n` +
      `    poll.state   w  ${d}/closing.yamlet.yaml AC-1\n` +
      `                 r  ${d}/voting.yamlet.yaml AC-1, AC-2\n` +
      `    vote.option  w  ${d}/voting.yamlet.yaml AC-1\n` +
      `                 r  ${d}/closing.yamlet.yaml AC-1\n` +
      `  contended (written by one scope, read or written by another)\n` +
      `    poll.state   ${d}/closing.yamlet.yaml <-> ${d}/voting.yamlet.yaml\n` +
      `    vote.option  ${d}/closing.yamlet.yaml <-> ${d}/voting.yamlet.yaml\n`,
  );
  // Without --state the listing is unchanged.
  assert(!runSystems([dir]).stdout.includes("stored state"));
});

Deno.test("systems --state --details shows each criterion as the field's meaning", () => {
  const dir = lunch();
  const r = runSystems([dir, "--state", "--details"]);
  assertStringIncludes(
    r.stdout,
    `    poll.state\n      w  ${dir}/closing.yamlet.yaml AC-1\n` +
      `         when a thing happens\n         shall do it\n`,
  );
});

Deno.test("systems --state --format=json carries criterion text only under --details", () => {
  const dir = lunch();
  const plain = JSON.parse(runSystems([dir, "--state", "--format=json"]).stdout);
  const touch = plain.systems[0].state.fields[0].touches[0];
  assertEquals(touch, { file: `${dir}/closing.yamlet.yaml`, ac: "AC-1", access: "write" });
  const rich = JSON.parse(runSystems([dir, "--state", "--details", "--format=json"]).stdout);
  assertEquals(rich.systems[0].state.fields[0].touches[0].shall, ["do it"]);
  assertEquals(plain.systems[0].state.contended.length, 2);
});

Deno.test("systems --state says so when a system declares no stored state", () => {
  const dir = Deno.makeTempDirSync();
  crit(seed(dir, "a"));
  assertStringIncludes(runSystems([dir, "--state"]).stdout, "  stored state: none declared\n");
});

Deno.test("add-state leaves a hand-ordered examples table after the list intact", () => {
  const dir = Deno.makeTempDirSync();
  inDir(dir, () => {
    const text = spec("svc", "").replace(
      "    - do it\n",
      "    - do it within {n} seconds\n    reads:\n    - poll.state\n    examples:\n    - n: 1\n",
    );
    Deno.writeTextFileSync("a.yamlet.yaml", text);
    const r = runAddState(["a.yamlet.yaml", "--ac", "AC-1", "--writes", "vote.option"]);
    assertEquals(r.exitCode, 0, r.stderr);
    assertStringIncludes(
      Deno.readTextFileSync("a.yamlet.yaml"),
      "    examples:\n    - n: 1\n    reads:\n    - poll.state\n    writes:\n    - vote.option\n",
    );
  });
});
