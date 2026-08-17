// `yamlet systems` discovers and groups spec files by their shared `system:`
// slug. Files with no system key are ignored; grouping and ordering are
// deterministic (systems sorted by slug, scopes by path).

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { collectSystems, runSystems } from "../src/systems.ts";

function seed(dir: string, name: string, system: string | null, topic: string): void {
  const head = system === null ? "" : `system: ${system}\n`;
  Deno.writeTextFileSync(
    `${dir}/${name}`,
    `${head}topic: ${topic}\nsummary: a summary\ndescription: >-\n  ctx\n` +
      `blast_radius: low\nfront: internal\nrequirements:\n`,
  );
}

// A scope that exposes a contract (name + inputs + optional outputs).
function seedContract(
  dir: string,
  name: string,
  system: string,
  exposeName: string,
  inputs: string[],
  outputs: string[],
): void {
  const inLines = inputs.map((i) => `  - ${i}`).join("\n");
  const outBlock = outputs.length > 0
    ? `\n  outputs:\n${outputs.map((o) => `  - ${o}`).join("\n")}`
    : "";
  Deno.writeTextFileSync(
    `${dir}/${name}`,
    `system: ${system}\ntopic: T\nsummary: a summary\ndescription: >-\n  ctx\n` +
      `blast_radius: low\nfront: internal\n` +
      `exposes:\n  name: ${exposeName}\n  intent: do a thing\n  inputs:\n${inLines}${outBlock}\n` +
      `requirements:\n`,
  );
}

Deno.test("collectSystems groups scopes under a shared system slug", () => {
  const dir = Deno.makeTempDirSync();
  seed(dir, "send.yamlet.yaml", "e-mail-sending-service", "Send with attachment");
  seed(dir, "plain.yamlet.yaml", "e-mail-sending-service", "Plain send");
  seed(dir, "archiver.yamlet.yaml", "pdf-archiver", "PDF archiver");
  seed(dir, "orphan.yamlet.yaml", null, "No system key"); // ignored

  const groups = collectSystems(dir);

  assertEquals(groups.map((g) => g.system), ["e-mail-sending-service", "pdf-archiver"]);
  assertEquals(groups[0]!.scopes.map((s) => s.file.endsWith("plain.yamlet.yaml")), [true, false]);
  assertEquals(groups[0]!.scopes.length, 2);
  assertEquals(groups[0]!.scopes[1]!.topic, "Send with attachment");
  assertEquals(groups[1]!.scopes.length, 1);
});

Deno.test("runSystems --format=json emits the grouped payload", () => {
  const dir = Deno.makeTempDirSync();
  seed(dir, "a.yamlet.yaml", "svc", "A");
  seed(dir, "b.yamlet.yaml", "svc", "B");

  const r = runSystems([dir, "--format=json"]);
  assertEquals(r.exitCode, 0);
  const payload = JSON.parse(r.stdout);
  assertEquals(payload.systems.length, 1);
  assertEquals(payload.systems[0].system, "svc");
  assertEquals(payload.systems[0].scopes.length, 2);
});

Deno.test("runSystems fails cleanly on a missing directory", () => {
  const r = runSystems(["/no/such/dir/here"]);
  assertEquals(r.exitCode, 2);
});

Deno.test("collectSystems omits contract unless requested; default output is unchanged", () => {
  const dir = Deno.makeTempDirSync();
  seedContract(dir, "up.yamlet.yaml", "pdf-upload", "pdf-upload", ["file", "filename"], [
    "pdf_file",
  ]);

  const plain = collectSystems(dir);
  assertEquals(plain[0]!.scopes[0]!.contract, undefined);

  const withC = collectSystems(dir, { contracts: true });
  assertEquals(withC[0]!.scopes[0]!.contract, {
    name: "pdf-upload",
    inputs: ["file", "filename"],
    outputs: ["pdf_file"],
  });
});

Deno.test("collectSystems reports a null contract for an exposes-less scope", () => {
  const dir = Deno.makeTempDirSync();
  seed(dir, "leaf.yamlet.yaml", "svc", "No contract");
  assertEquals(collectSystems(dir, { contracts: true })[0]!.scopes[0]!.contract, null);
});

Deno.test("runSystems --contracts renders the signature line; outputs only when present", () => {
  const dir = Deno.makeTempDirSync();
  seedContract(dir, "up.yamlet.yaml", "pdf-upload", "pdf-upload", ["file", "filename"], [
    "pdf_file",
    "error",
  ]);
  seedContract(dir, "sink.yamlet.yaml", "mailer", "mail-send", ["recipient", "content"], []);

  const r = runSystems([dir, "--contracts"]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(
    r.stdout,
    "    exposes pdf-upload\n      in:  file, filename\n      out: pdf_file, error\n",
  );
  // a pure sink still reads clearly: inputs labelled, outputs explicitly none
  assertStringIncludes(
    r.stdout,
    "    exposes mail-send\n      in:  recipient, content\n      out: (none)\n",
  );
});

Deno.test("collectSystems omits description unless --details is asked for", () => {
  const dir = Deno.makeTempDirSync();
  seed(dir, "a.yamlet.yaml", "svc", "A");

  assertEquals(collectSystems(dir)[0]!.scopes[0]!.description, undefined);
  assertEquals(collectSystems(dir, { details: true })[0]!.scopes[0]!.description, "ctx");
});

Deno.test("runSystems --details renders summary and description; default is unchanged", () => {
  const dir = Deno.makeTempDirSync();
  seed(dir, "a.yamlet.yaml", "svc", "A");

  const plain = runSystems([dir]);
  assertEquals(plain.stdout.includes("summary:"), false);
  assertEquals(plain.stdout.includes("description:"), false);

  const detailed = runSystems([dir, "--details"]);
  assertEquals(detailed.exitCode, 0);
  assertStringIncludes(detailed.stdout, "    summary:     a summary\n");
  assertStringIncludes(detailed.stdout, "    description: ctx\n");
});

Deno.test("runSystems --details wraps long prose with a hanging indent", () => {
  const dir = Deno.makeTempDirSync();
  const long = "word ".repeat(40).trim();
  Deno.writeTextFileSync(
    `${dir}/w.yamlet.yaml`,
    `system: svc\ntopic: T\nsummary: ${long}\ndescription: >-\n  ctx\n` +
      `blast_radius: low\nfront: internal\nrequirements:\n`,
  );

  const r = runSystems([dir, "--details"]);
  const lines = r.stdout.split("\n").filter((l) => l.includes("word"));
  // Wrapped across several lines, none longer than the indent + label + 72 columns.
  assertEquals(lines.length > 1, true);
  for (const l of lines) assertEquals(l.length <= 4 + 13 + 72, true);
  // Continuation lines align under the text, not under the label.
  assertStringIncludes(r.stdout, "\n                 word");
});

Deno.test("runSystems --system filters to one slug; a miss is a clean empty result", () => {
  const dir = Deno.makeTempDirSync();
  seed(dir, "a.yamlet.yaml", "svc-a", "A");
  seed(dir, "b.yamlet.yaml", "svc-b", "B");

  const hit = runSystems([dir, "--system=svc-a", "--format=json"]);
  const payload = JSON.parse(hit.stdout);
  assertEquals(payload.systems.length, 1);
  assertEquals(payload.systems[0].system, "svc-a");

  const miss = runSystems([dir, "--system=nope"]);
  assertEquals(miss.exitCode, 0);
  assertStringIncludes(miss.stdout, "no system 'nope' found");
});
