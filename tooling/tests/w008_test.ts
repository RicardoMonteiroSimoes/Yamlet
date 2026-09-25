// W008: `front: internal` claims a trusted caller; a composite wiring the spec as a
// member is the only place yamlet names it. The lookup is reverse, so it scans the
// working directory (as `yamlet impact` does) — these tests pin that scope.

import { assertEquals } from "jsr:@std/assert@1";
import { verifyFile, verifyText } from "../src/verify.ts";

function spec(front: "internal" | "external", body: string): string {
  return `system: svc\ntopic: T\nsummary: s\ndescription: >-\n  d\n` +
    `blast_radius: low\nfront: ${front}\n${body}`;
}

const LEAF = spec("internal", "exposes:\n  name: leaf\n  intent: do a thing\n  inputs:\n  - a\n");
const WIRING = (member: string) =>
  spec(
    "external",
    `exposes:\n  name: root\n  intent: wire it\n  inputs:\n  - a\n\n` +
      `components:\n- m: ${member}\n\nconnections:\n  m:\n    a: input.a\n`,
  );

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

const w008 = (file: string) => verifyFile(file).result.warnings.filter((w) => w.rule === "W008");

Deno.test("W008: an internal spec no composite wires is warned on its front line", () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${dir}/leaf.yamlet.yaml`, LEAF);
  const found = inDir(dir, () => w008("leaf.yamlet.yaml"));
  assertEquals(found.length, 1);
  assertEquals(found[0]!.line, 7);
  assertEquals(found[0]!.path, "front");
});

Deno.test("W008: a composite anywhere under the working directory silences it", () => {
  const dir = Deno.makeTempDirSync();
  Deno.mkdirSync(`${dir}/leaves`);
  Deno.writeTextFileSync(`${dir}/leaves/leaf.yamlet.yaml`, LEAF);
  Deno.writeTextFileSync(`${dir}/root.yamlet.yaml`, WIRING("leaves/leaf.yamlet.yaml"));
  assertEquals(inDir(dir, () => w008("leaves/leaf.yamlet.yaml")), []);
});

Deno.test("W008: a composite outside the working directory is not seen", () => {
  const dir = Deno.makeTempDirSync();
  Deno.mkdirSync(`${dir}/leaves`);
  Deno.writeTextFileSync(`${dir}/leaves/leaf.yamlet.yaml`, LEAF);
  Deno.writeTextFileSync(`${dir}/root.yamlet.yaml`, WIRING("leaves/leaf.yamlet.yaml"));
  assertEquals(inDir(`${dir}/leaves`, () => w008("leaf.yamlet.yaml")).length, 1);
});

Deno.test("W008: an external spec is never asked for a caller", () => {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${dir}/root.yamlet.yaml`, WIRING("missing.yamlet.yaml"));
  assertEquals(inDir(dir, () => w008("root.yamlet.yaml")), []);
});

Deno.test("W008: judged on the text in hand, so an unsaved spec is checked too", () => {
  const dir = Deno.makeTempDirSync();
  const found = inDir(
    dir,
    () => verifyText("new.yamlet.yaml", LEAF).result.warnings.filter((w) => w.rule === "W008"),
  );
  assertEquals(found.length, 1);
});
