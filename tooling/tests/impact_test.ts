// `yamlet impact` is the reverse of `composite.ts`: given a spec, which
// composites declare it as a member, under which alias, and which of its
// sockets do they bind, consume or name in prose. It is read-only and an empty
// result is an answer, so it always exits 0.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { collectImpact, runImpact } from "../src/impact.ts";

/** A leaf exposing a contract. */
function leaf(dir: string, name: string, exposeName: string, ins: string[], outs: string[]): void {
  const inBlock = ins.length > 0 ? `  inputs:\n${ins.map((i) => `  - ${i}`).join("\n")}\n` : "";
  const outBlock = outs.length > 0 ? `  outputs:\n${outs.map((o) => `  - ${o}`).join("\n")}\n` : "";
  Deno.writeTextFileSync(
    `${dir}/${name}`,
    `system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\n` +
      `blast_radius: low\nfront: internal\n` +
      `exposes:\n  name: ${exposeName}\n  intent: do a thing\n${inBlock}${outBlock}` +
      `requirements:\n`,
  );
}

/** A composite: `members` is alias -> path, `wires` is the raw connections block. */
function composite(
  dir: string,
  name: string,
  members: [string, string][],
  wires: string,
  criteria = "",
): void {
  const comps = members.map(([a, p]) => `- ${a}: ${p}`).join("\n");
  Deno.writeTextFileSync(
    `${dir}/${name}`,
    `system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\n` +
      `blast_radius: low\nfront: internal\n` +
      `components:\n${comps}\n\nconnections:\n${wires}\n${criteria}`,
  );
}

Deno.test("impact reports nothing for a spec no composite declares", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "lonely.yamlet.yaml", "lonely", ["a"], []);

  const rep = collectImpact(`${dir}/lonely.yamlet.yaml`, dir);
  assertEquals(rep.consumers, []);
  assertEquals(rep.scanned, 1);
  assertEquals(rep.contract?.name, "lonely");

  const r = runImpact([`${dir}/lonely.yamlet.yaml`, dir]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.stdout, "no composite declares this spec as a member");
});

Deno.test("impact finds the consumer, its alias, and the sockets it binds and uses", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "up.yamlet.yaml", "up", ["file", "filename"], ["pdf_file", "error"]);
  leaf(dir, "mail.yamlet.yaml", "mail", ["recipient", "body"], []);
  composite(
    dir,
    "arch.yamlet.yaml",
    [["uploads", "up.yamlet.yaml"], ["mailer", "mail.yamlet.yaml"]],
    "  uploads:\n    file: input.file\n    filename: input.filename\n" +
      "  mailer:\n    recipient: input.to\n    body: uploads.pdf_file\n",
  );

  const rep = collectImpact(`${dir}/up.yamlet.yaml`, dir);
  assertEquals(rep.consumers.length, 1);
  const c = rep.consumers[0]!;
  assertEquals(c.alias, "uploads");
  assertEquals(c.boundInputs, ["file", "filename"]);
  assertEquals(c.usedOutputs, ["pdf_file"]); // `error` is declared but never sourced
  assertEquals(c.referencedSockets, []);
});

Deno.test("impact picks up {alias.socket} references in criteria prose", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "up.yamlet.yaml", "up", ["file"], ["pdf_file"]);
  composite(
    dir,
    "arch.yamlet.yaml",
    [["uploads", "up.yamlet.yaml"]],
    "  uploads:\n    file: input.file\n",
    "requirements:\n- id: RQ-1\n  description: >-\n    emergent\n  acceptance-criteria:\n" +
      '  - id: AC-1\n    pattern: event\n    when: "{uploads.pdf_file} is returned"\n' +
      "    shall:\n    - archive it\n",
  );

  const c = collectImpact(`${dir}/up.yamlet.yaml`, dir).consumers[0]!;
  assertEquals(c.referencedSockets, ["pdf_file"]);
});

Deno.test("impact matches a member however its path is spelled", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "up.yamlet.yaml", "up", ["file"], []);
  composite(dir, "a.yamlet.yaml", [["m", "./up.yamlet.yaml"]], "  m:\n    file: input.file\n");
  composite(dir, "b.yamlet.yaml", [["m", "up.yamlet.yaml"]], "  m:\n    file: input.file\n");

  const rep = collectImpact(`${dir}/up.yamlet.yaml`, dir);
  assertEquals(rep.consumers.map((c) => c.file.endsWith("a.yamlet.yaml")), [true, false]);
  assertEquals(rep.consumers.length, 2);
});

Deno.test("impact lists one entry per alias when a composite wires a spec twice", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "mail.yamlet.yaml", "mail", ["to"], []);
  composite(
    dir,
    "two.yamlet.yaml",
    [["primary", "mail.yamlet.yaml"], ["backup", "mail.yamlet.yaml"]],
    "  primary:\n    to: input.a\n  backup:\n    to: input.b\n",
  );

  const rep = collectImpact(`${dir}/mail.yamlet.yaml`, dir);
  assertEquals(rep.consumers.map((c) => c.alias), ["backup", "primary"]);
});

Deno.test("impact never counts a spec as its own consumer", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "up.yamlet.yaml", "up", ["file"], []);
  composite(dir, "arch.yamlet.yaml", [["m", "up.yamlet.yaml"]], "  m:\n    file: input.file\n");

  assertEquals(collectImpact(`${dir}/arch.yamlet.yaml`, dir).consumers, []);
});

Deno.test("impact reports a contract-less target as unwireable", () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(
    `${dir}/bare.yamlet.yaml`,
    "system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\n" +
      "blast_radius: low\nfront: internal\nrequirements:\n",
  );

  const r = runImpact([`${dir}/bare.yamlet.yaml`, dir]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.stdout, "exposes no contract — it cannot be wired as a member");
});

Deno.test("impact states the scanned scope so a narrow search is never silent", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "up.yamlet.yaml", "up", ["file"], []);
  Deno.mkdirSync(`${dir}/sub`);
  composite(
    `${dir}/sub`,
    "arch.yamlet.yaml",
    [["m", "../up.yamlet.yaml"]],
    "  m:\n    file: input.file\n",
  );

  // Scanning only the leaf's own directory would miss the composite one level
  // down; the count is what makes that visible rather than a false "all clear".
  const narrow = collectImpact(`${dir}/up.yamlet.yaml`, `${dir}/sub`);
  assertEquals(narrow.consumers.length, 1);

  const wide = collectImpact(`${dir}/up.yamlet.yaml`, dir);
  assertEquals(wide.consumers.length, 1);
  assertEquals(wide.scanned, 2);
  assertStringIncludes(runImpact([`${dir}/up.yamlet.yaml`, dir]).stdout, "scanned 2 specs under");
});

Deno.test("impact --format=json emits the report payload", () => {
  const dir = Deno.makeTempDirSync();
  leaf(dir, "up.yamlet.yaml", "up", ["file"], ["pdf_file"]);
  composite(dir, "arch.yamlet.yaml", [["m", "up.yamlet.yaml"]], "  m:\n    file: input.file\n");

  const r = runImpact([`${dir}/up.yamlet.yaml`, dir, "--format=json"]);
  assertEquals(r.exitCode, 0);
  const payload = JSON.parse(r.stdout);
  assertEquals(payload.consumers.length, 1);
  assertEquals(payload.consumers[0].alias, "m");
  assertEquals(payload.contract.outputs, ["pdf_file"]);
});

Deno.test("impact fails cleanly on a bad file, a bad directory, or no argument", () => {
  assertEquals(runImpact([]).exitCode, 2);
  assertEquals(runImpact(["/no/such/file.yamlet.yaml"]).exitCode, 2);
  const dir = Deno.makeTempDirSync();
  leaf(dir, "up.yamlet.yaml", "up", ["file"], []);
  assertEquals(runImpact([`${dir}/up.yamlet.yaml`, "/no/such/dir"]).exitCode, 2);
  assertEquals(runImpact([`${dir}/up.yamlet.yaml`, dir, "--bogus"]).exitCode, 2);
});
