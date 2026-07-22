// `yamlet add-connection` wires a group of a composite in one atomic call:
// `<group>: { socket: source, … }` under `connections:`, inserted before
// `requirements:`. An alias group binds ALL of that member's inputs; the `output`
// group feeds ALL declared composite outputs. Sources are `input.X` or `alias.out`;
// direction (a member input / `output.X` is a sink, never a source) is enforced.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  runAddComponent,
  runAddConnection,
  runAddCriterion,
  runAddRequirement,
  runInit,
} from "../src/author.ts";
import { verifyText } from "../src/verify.ts";

function initComposite(dir: string, inputs: string[], outputs: string[] = []): string {
  const file = `${dir}/arch.yamlet.yaml`;
  const args = [
    file,
    "--system",
    "pdf-archiver",
    "--topic",
    "Archiver",
    "--summary",
    "s",
    "--description",
    "d",
    "--blast-radius",
    "medium",
    "--front",
    "internal",
    "--expose-name",
    "pdf-archiver",
    "--expose-intent",
    "archive",
  ];
  for (const i of inputs) args.push("--input", i);
  for (const o of outputs) args.push("--output", o);
  const r = runInit(args);
  assertEquals(r.exitCode, 0, r.stderr);
  return file;
}

function member(
  dir: string,
  name: string,
  exposeName: string,
  inputs: string[],
  outputs: string[],
): void {
  const inB = inputs.length > 0 ? `  inputs:\n${inputs.map((i) => `  - ${i}`).join("\n")}\n` : "";
  const outB = outputs.length > 0
    ? `  outputs:\n${outputs.map((o) => `  - ${o}`).join("\n")}\n`
    : "";
  Deno.writeTextFileSync(
    `${dir}/${name}`,
    `system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\nblast_radius: low\nfront: internal\n` +
      `exposes:\n  name: ${exposeName}\n  intent: do\n${inB}${outB}requirements:\n`,
  );
}

// A composite with an uploads member and a mailer member, wired boundary + assembly.
function seedUploadsAndMailer(dir: string): string {
  const file = initComposite(dir, ["file", "filename", "archive_address", "subject", "content"]);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file", "filename"], ["pdf_file", "error"]);
  member(
    dir,
    "mail.yamlet.yaml",
    "mail-send",
    ["recipient", "subject", "content", "attachment"],
    [],
  );
  assertEquals(runAddComponent([file, "uploads", "up.yamlet.yaml"]).exitCode, 0);
  assertEquals(runAddComponent([file, "mailer", "mail.yamlet.yaml"]).exitCode, 0);
  return file;
}

Deno.test("add-connection wires a member's inputs and writes a connections block", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);

  const r = runAddConnection([file, "uploads", "file=input.file", "filename=input.filename"]);
  assertEquals(r.exitCode, 0, r.stderr);

  const text = Deno.readTextFileSync(file);
  assertStringIncludes(
    text,
    "connections:\n  uploads:\n    file: input.file\n    filename: input.filename\n",
  );
  // canonical order: connections after components, before requirements
  assertEquals(text.indexOf("components:") < text.indexOf("connections:"), true);
  assertEquals(text.indexOf("connections:") < text.indexOf("requirements:"), true);
});

Deno.test("assembly and boundary sources both resolve; a second group appends", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);

  assertEquals(
    runAddConnection([file, "uploads", "file=input.file", "filename=input.filename"]).exitCode,
    0,
  );
  // mailer.attachment is fed by the uploads member output (assembly)
  const r = runAddConnection([
    file,
    "mailer",
    "recipient=input.archive_address",
    "subject=input.subject",
    "content=input.content",
    "attachment=uploads.pdf_file",
  ]);
  assertEquals(r.exitCode, 0, r.stderr);

  const text = Deno.readTextFileSync(file);
  assertStringIncludes(text, "    attachment: uploads.pdf_file\n");
  assertEquals(text.match(/^connections:$/gm)?.length, 1); // one connections block
});

Deno.test("a fully wired composite verifies clean", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);
  runAddConnection([file, "uploads", "file=input.file", "filename=input.filename"]);
  runAddConnection([
    file,
    "mailer",
    "recipient=input.archive_address",
    "subject=input.subject",
    "content=input.content",
    "attachment=uploads.pdf_file",
  ]);

  const text = Deno.readTextFileSync(file);
  const { result } = verifyText(file, text);
  assertEquals(result.errors, []);
});

Deno.test("the output group feeds a declared composite output from a member output", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir, ["file"], ["problem"]);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], ["error"]);
  assertEquals(runAddComponent([file, "uploads", "up.yamlet.yaml"]).exitCode, 0);

  const r = runAddConnection([file, "output", "problem=uploads.error"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertStringIncludes(Deno.readTextFileSync(file), "  output:\n    problem: uploads.error\n");
});

Deno.test("add-connection demands every input of a member in one call", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);
  const r = runAddConnection([file, "uploads", "file=input.file"]); // missing filename
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "bind every input of uploads");
  assertStringIncludes(r.stderr, "filename");
});

Deno.test("add-connection enforces source direction and resolution", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);

  // a member INPUT cannot be a source (direction)
  const dir1 = runAddConnection([file, "mailer", "recipient=uploads.file"]);
  assertEquals(dir1.exitCode, 2);
  assertStringIncludes(dir1.stderr, "not a declared output of uploads");

  // output.* is a sink, never a source
  const dir2 = runAddConnection([file, "mailer", "recipient=output.whatever"]);
  assertEquals(dir2.exitCode, 2);
  assertStringIncludes(dir2.stderr, "sink, not a source");

  // an unknown composite input
  const dir3 = runAddConnection([file, "uploads", "file=input.nope", "filename=input.filename"]);
  assertEquals(dir3.exitCode, 2);
  assertStringIncludes(dir3.stderr, "not a declared composite input");
});

Deno.test("add-connection rejects a bad sink, an unknown group, and a non-composite", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);

  // a socket that is not one of the member's inputs
  const badSink = runAddConnection([file, "uploads", "pdf_file=input.file"]);
  assertEquals(badSink.exitCode, 2);
  assertStringIncludes(badSink.stderr, "is not a declared input of uploads");

  // a group that is neither an alias nor 'output'
  const badGroup = runAddConnection([file, "ghost", "x=input.file"]);
  assertEquals(badGroup.exitCode, 2);
  assertStringIncludes(badGroup.stderr, "is not a component alias or 'output'");

  // a leaf (no components) cannot wire
  const leaf = `${dir}/leaf.yamlet.yaml`;
  runInit([
    leaf,
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
  const onLeaf = runAddConnection([leaf, "output", "x=input.y"]);
  assertEquals(onLeaf.exitCode, 2);
  assertStringIncludes(onLeaf.stderr, "connections require components");
});

Deno.test("add-connection refuses to wire a group twice", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);
  assertEquals(
    runAddConnection([file, "uploads", "file=input.file", "filename=input.filename"]).exitCode,
    0,
  );
  const again = runAddConnection([file, "uploads", "file=input.file", "filename=input.filename"]);
  assertEquals(again.exitCode, 2);
  assertStringIncludes(again.stderr, "already exist");
});

Deno.test("add-connection refuses once a requirement exists (phase order)", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir);
  // Wire fully first: add-requirement is refused on an under-wired composite
  // (see the requirement-guard test below), so the composite must be complete
  // before a requirement can exist to trigger this phase guard.
  assertEquals(
    runAddConnection([file, "uploads", "file=input.file", "filename=input.filename"]).exitCode,
    0,
  );
  assertEquals(
    runAddConnection([
      file,
      "mailer",
      "recipient=input.archive_address",
      "subject=input.subject",
      "content=input.content",
      "attachment=uploads.pdf_file",
    ]).exitCode,
    0,
  );
  assertEquals(runAddRequirement([file, "--description", "does a thing"]).exitCode, 0);
  const late = runAddConnection([file, "uploads", "file=input.file", "filename=input.filename"]);
  assertEquals(late.exitCode, 2);
  assertStringIncludes(late.stderr, "before requirements");
});

// ── requirement-phase guard: a composite must be fully wired first ──
// add-component / add-connection are both refused once a requirement exists, so
// an unbound member input (E609) or unfed output (E610) left at that point would
// be permanently unfixable. add-requirement therefore refuses on a under-wired
// composite instead of trapping the file.

Deno.test("add-requirement refuses on an under-wired composite (no permanent E609 trap)", () => {
  const dir = Deno.makeTempDirSync();
  const file = seedUploadsAndMailer(dir); // members declared, nothing wired yet
  const before = Deno.readTextFileSync(file);

  const r = runAddRequirement([file, "--description", "premature"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "finish wiring the composite before adding requirements");
  assertStringIncludes(r.stderr, "E609");
  // nothing written — the file is byte-identical
  assertEquals(Deno.readTextFileSync(file), before);
});

Deno.test("add-requirement is allowed once every member input and output is wired", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir, ["file"], ["problem"]);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], ["error"]);
  assertEquals(runAddComponent([file, "uploads", "up.yamlet.yaml"]).exitCode, 0);
  assertEquals(runAddConnection([file, "uploads", "file=input.file"]).exitCode, 0);
  assertEquals(runAddConnection([file, "output", "problem=uploads.error"]).exitCode, 0);
  assertEquals(runAddRequirement([file, "--description", "emergent"]).exitCode, 0);
});

// ── {alias.socket} member references in composite criteria ──
// The verifier resolves {alias.socket} on a composite (E604); the author must be
// able to emit it too, else a valid cross-member criterion is unauthorable.

// A fully-wired composite with a single requirement ready for its criteria.
function wiredComposite(dir: string): string {
  const file = initComposite(dir, ["file"], ["problem"]);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], ["pdf_file", "error"]);
  assertEquals(runAddComponent([file, "uploads", "up.yamlet.yaml"]).exitCode, 0);
  assertEquals(runAddConnection([file, "uploads", "file=input.file"]).exitCode, 0);
  assertEquals(runAddConnection([file, "output", "problem=uploads.error"]).exitCode, 0);
  assertEquals(runAddRequirement([file, "--description", "emergent"]).exitCode, 0);
  return file;
}

Deno.test("a composite criterion may reference a member output socket and verifies clean", () => {
  const dir = Deno.makeTempDirSync();
  const file = wiredComposite(dir);

  const r = runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--pattern",
    "event",
    "--when",
    "{uploads.pdf_file} is produced",
    "--shall",
    "surface it downstream",
  ]);
  assertEquals(r.exitCode, 0, r.stderr);
  // no --example rows needed: a member ref is a real socket, not a placeholder
  const { result } = verifyText(file, Deno.readTextFileSync(file));
  assertEquals(result.errors, []);
});

Deno.test("a member reference to an input socket also resolves (E604 spans inputs and outputs)", () => {
  const dir = Deno.makeTempDirSync();
  const file = wiredComposite(dir);
  assertEquals(
    runAddCriterion([
      file,
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      "{uploads.file} arrives",
      "--shall",
      "note it",
    ]).exitCode,
    0,
  );
});

Deno.test("a member reference is rejected: unknown socket, unknown alias, and on a leaf", () => {
  const dir = Deno.makeTempDirSync();
  const file = wiredComposite(dir);

  const badSocket = runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--pattern",
    "event",
    "--when",
    "{uploads.ghost} happens",
    "--shall",
    "x",
  ]);
  assertEquals(badSocket.exitCode, 2);
  assertStringIncludes(badSocket.stderr, "not a declared input or output of 'uploads'");

  const badAlias = runAddCriterion([
    file,
    "--rq",
    "RQ-1",
    "--pattern",
    "event",
    "--when",
    "{ghost.error} happens",
    "--shall",
    "x",
  ]);
  assertEquals(badAlias.exitCode, 2);
  assertStringIncludes(badAlias.stderr, "is not a declared component alias");

  // a leaf has no members, so any {alias.socket} is meaningless there
  const leaf = `${dir}/leaf.yamlet.yaml`;
  runInit([
    leaf,
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
    "l",
    "--expose-intent",
    "do",
    "--input",
    "i",
  ]);
  assertEquals(runAddRequirement([leaf, "--description", "r"]).exitCode, 0);
  const onLeaf = runAddCriterion([
    leaf,
    "--rq",
    "RQ-1",
    "--pattern",
    "event",
    "--when",
    "{a.b} happens",
    "--shall",
    "x",
  ]);
  assertEquals(onLeaf.exitCode, 2);
  assertStringIncludes(onLeaf.stderr, "member references are only valid on a composite");
});

// ── commit-gate rollback: a pre-existing hard error is not swallowed ──

Deno.test("a mutation over a spec with a pre-existing hard error rolls back (exit 3, file unchanged)", () => {
  const dir = Deno.makeTempDirSync();
  const file = `${dir}/broken.yamlet.yaml`;
  // front: bogus is E104 — a hard error NOT in the work-in-progress allowlist.
  const seed = "system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\n" +
    "blast_radius: low\nfront: bogus\nrequirements:\n";
  Deno.writeTextFileSync(file, seed);

  const r = runAddRequirement([file, "--description", "x"]);
  assertEquals(r.exitCode, 3);
  assertStringIncludes(r.stderr, "rolled back");
  assertStringIncludes(r.stderr, "E104");
  // the rollback restored the exact original bytes
  assertEquals(Deno.readTextFileSync(file), seed);
});
