// Gherkin regression suite: `yamlet tests` must reproduce, byte-for-byte, the
// frozen feature tree under oracle-gherkin/ for the canonical example specs.
// The goldens are a snapshot of this command's own output -- re-freeze them with
//   deno run --allow-read --allow-write tests/gen-gherkin-oracle.ts

import { assertEquals } from "jsr:@std/assert@1";
import { runTests } from "../src/tests.ts";

const SPECS = new URL("../../specs_example/", import.meta.url).pathname.replace(/\/$/, "");
const ORACLE = new URL("./oracle-gherkin/", import.meta.url).pathname.replace(/\/$/, "");

/** Every file under `root` as relativePath → contents (deterministic). */
function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    const entries = [...Deno.readDirSync(dir)].sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) walk(p, r);
      else if (e.isFile) out.set(r, Deno.readTextFileSync(p));
    }
  };
  walk(root, "");
  return out;
}

Deno.test("tests: features match the frozen oracle byte-for-byte", () => {
  const tmp = Deno.makeTempDirSync();
  const res = runTests([SPECS, tmp]);
  assertEquals(res.exitCode, 0);

  const got = readTree(tmp);
  const want = readTree(ORACLE);
  assertEquals([...got.keys()].sort(), [...want.keys()].sort(), "feature file set differs");
  for (const [rel, content] of want) {
    assertEquals(got.get(rel), content, `feature content differs: ${rel}`);
  }
});

Deno.test("tests: requires both a source and a target directory", () => {
  assertEquals(runTests([SPECS]).exitCode, 2);
  assertEquals(runTests([]).exitCode, 2);
});

Deno.test("tests: a missing source directory is a clean usage error", () => {
  const res = runTests([`${SPECS}/does-not-exist`, Deno.makeTempDirSync()]);
  assertEquals(res.exitCode, 2);
  assertEquals(res.stdout, "");
});

Deno.test("tests: a scope with no requirements is skipped, not written", () => {
  const src = Deno.makeTempDirSync();
  // A composite may legally carry no requirements: nothing to assert -> skipped.
  Deno.writeTextFileSync(
    `${src}/bare.yamlet.yaml`,
    [
      "system: bare-system",
      "topic: Bare",
      "summary: no requirements here",
      "description: nothing to test",
      "blast_radius: low",
      "front: internal",
      "",
    ].join("\n"),
  );
  const out = Deno.makeTempDirSync();
  const res = runTests([src, out]);
  assertEquals(res.exitCode, 0);
  assertEquals([...Deno.readDirSync(out)].length, 0);
  assertEquals(res.stdout.includes("no requirements"), true);
});
