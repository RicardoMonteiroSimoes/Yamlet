// `yamlet add-component` declares a member of a composite: `- alias: path` under
// `components:`, inserted before `requirements:` and echoing the member's contract.
// It refuses bad aliases, unresolvable/contract-less members, duplicates, and any
// attempt to declare a component once connections or requirements exist.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runAddComponent, runAddRequirement, runInit } from "../src/author.ts";

// An init'd composite boundary (header + exposes inputs + empty `requirements:`).
function initComposite(dir: string, inputs: string[] = ["file"]): string {
  const file = `${dir}/archiver.yamlet.yaml`;
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
  const r = runInit(args);
  assertEquals(r.exitCode, 0, r.stderr);
  return file;
}

// A wireable member: a spec with an exposes contract (need not be valid on its own).
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

Deno.test("add-component declares a member, echoes its contract, and stays before requirements", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file", "filename"], ["pdf_file", "error"]);

  const r = runAddComponent([file, "uploads", "up.yamlet.yaml"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertStringIncludes(r.stdout, "uploads: up.yamlet.yaml");
  assertStringIncludes(r.stdout, "inputs  (must all be wired): file, filename");
  assertStringIncludes(r.stdout, "outputs (consume as needed): pdf_file, error");

  const text = Deno.readTextFileSync(file);
  assertStringIncludes(text, "components:\n- uploads: up.yamlet.yaml\n");
  // canonical order: components block sits before the requirements key
  assertEquals(text.indexOf("components:") < text.indexOf("requirements:"), true);
});

Deno.test("a second member joins the same components block, in order", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], ["pdf_file"]);
  member(dir, "mail.yamlet.yaml", "mail-send", ["recipient"], []);

  assertEquals(runAddComponent([file, "uploads", "up.yamlet.yaml"]).exitCode, 0);
  assertEquals(runAddComponent([file, "mailer", "mail.yamlet.yaml"]).exitCode, 0);

  const text = Deno.readTextFileSync(file);
  assertStringIncludes(
    text,
    "components:\n- uploads: up.yamlet.yaml\n- mailer: mail.yamlet.yaml\n",
  );
  // exactly one components block
  assertEquals(text.match(/^components:$/gm)?.length, 1);
});

Deno.test("a pure-sink member echoes out: (none)", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);
  member(dir, "mail.yamlet.yaml", "mail-send", ["recipient", "content"], []);
  const r = runAddComponent([file, "mailer", "mail.yamlet.yaml"]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertStringIncludes(r.stdout, "outputs (consume as needed): (none)");
});

Deno.test("add-component rejects a reserved alias", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], []);
  for (const bad of ["output", "input"]) {
    const r = runAddComponent([file, bad, "up.yamlet.yaml"]);
    assertEquals(r.exitCode, 2);
    assertStringIncludes(r.stderr, "reserved");
  }
});

Deno.test("add-component rejects a malformed alias and a missing argument", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], []);
  assertEquals(runAddComponent([file, "Up-load", "up.yamlet.yaml"]).exitCode, 2);
  assertEquals(runAddComponent([file, "uploads"]).exitCode, 2); // no PATH
});

Deno.test("add-component rejects an unresolvable path and a contract-less member", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);

  const missing = runAddComponent([file, "uploads", "nope.yamlet.yaml"]);
  assertEquals(missing.exitCode, 2);
  assertStringIncludes(missing.stderr, "does not resolve");

  // a spec with no exposes block is not wireable
  Deno.writeTextFileSync(
    `${dir}/bare.yamlet.yaml`,
    `system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\nblast_radius: low\nfront: internal\nrequirements:\n`,
  );
  const bare = runAddComponent([file, "bare", "bare.yamlet.yaml"]);
  assertEquals(bare.exitCode, 2);
  assertStringIncludes(bare.stderr, "exposes no contract");
});

Deno.test("add-component rejects a duplicate alias", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], []);
  assertEquals(runAddComponent([file, "uploads", "up.yamlet.yaml"]).exitCode, 0);
  const dup = runAddComponent([file, "uploads", "up.yamlet.yaml"]);
  assertEquals(dup.exitCode, 2);
  assertStringIncludes(dup.stderr, "duplicate component alias");
});

Deno.test("add-component refuses once a requirement exists (phase order)", () => {
  const dir = Deno.makeTempDirSync();
  const file = initComposite(dir);
  member(dir, "up.yamlet.yaml", "pdf-upload", ["file"], []);
  assertEquals(runAddRequirement([file, "--description", "does a thing"]).exitCode, 0);
  const late = runAddComponent([file, "uploads", "up.yamlet.yaml"]);
  assertEquals(late.exitCode, 2);
  assertStringIncludes(late.stderr, "before requirements");
});
