// Gherkin regression suite: `yamlet tests` must reproduce, byte-for-byte, the
// frozen feature tree under oracle-gherkin/ for the canonical example specs.
// The goldens are a snapshot of this command's own output -- re-freeze them with
//   deno run --allow-read --allow-write tests/gen-gherkin-oracle.ts

import { assertEquals } from "jsr:@std/assert@1";
import { existsSync } from "jsr:@std/fs@1";
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

Deno.test("tests: manifest lists each scenario's verbatim binding obligations", () => {
  const out = Deno.makeTempDirSync();
  assertEquals(runTests([SPECS, out]).exitCode, 0);

  const manifest = JSON.parse(Deno.readTextFileSync(`${out}/manifest.json`));
  assertEquals(manifest.format, "yamlet.tests/v1");
  const feats = manifest.features;

  // Contract inputs referenced by a leaf criterion are listed (deduped, sorted);
  // a token referenced twice appears once.
  assertEquals(feats["e-mail-sending-service/email_service.feature"]["AC-4"], {
    inputs: ["attachment", "content", "recipient", "subject"],
    outputs: [],
    sockets: [],
  });
  // Outputs are captured too.
  assertEquals(
    feats["pdf-upload/pdf_upload.feature"]["AC-1"].outputs,
    ["pdf_file"],
  );
  // Composite member-socket references land under `sockets`, not inputs/outputs.
  assertEquals(
    feats["pdf-archiver/pdf_archiver_resilient.feature"]["AC-2"].sockets,
    ["uploads.error", "uploads.pdf_file"],
  );
  // A scenario that binds nothing (no contract tokens) is absent, not empty.
  assertEquals("AC-1" in feats["e-mail-sending-service/email_service.feature"], false);
});

Deno.test("tests: no manifest is written when no features are produced", () => {
  const src = Deno.makeTempDirSync();
  Deno.writeTextFileSync(
    `${src}/bare.yamlet.yaml`,
    [
      "system: bare-system",
      "topic: Bare",
      "summary: none",
      "description: none",
      "blast_radius: low",
      "front: internal",
      "",
    ].join("\n"),
  );
  const out = Deno.makeTempDirSync();
  assertEquals(runTests([src, out]).exitCode, 0);
  assertEquals(existsSync(`${out}/manifest.json`), false);
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

Deno.test("tests: TARGET is wiped and rebuilt each run, leaving no stale content", () => {
  const out = Deno.makeTempDirSync();
  // First run populates the tree from the canonical specs.
  assertEquals(runTests([SPECS, out]).exitCode, 0);
  const before = readTree(out);
  const someSystem = [...before.keys()][0]!.split("/")[0]!;

  // Seed TARGET with junk a prior/hand run might have left: a stray feature, a
  // non-feature file, and a whole orphaned system directory.
  const stray = `${out}/${someSystem}/ghost.feature`;
  Deno.writeTextFileSync(stray, "Feature: ghost\n");
  Deno.writeTextFileSync(`${out}/${someSystem}/notes.txt`, "scratch\n");
  Deno.mkdirSync(`${out}/gone-system`);
  Deno.writeTextFileSync(`${out}/gone-system/old.feature`, "Feature: old\n");

  const res = runTests([SPECS, out]);
  assertEquals(res.exitCode, 0);

  // Everything not produced by this run is gone; TARGET is exactly the projection.
  assertEquals(existsSync(stray), false);
  assertEquals(existsSync(`${out}/${someSystem}/notes.txt`), false);
  assertEquals(existsSync(`${out}/gone-system`), false);
  const after = readTree(out);
  assertEquals([...after.keys()].sort(), [...before.keys()].sort());
  for (const [rel, content] of before) assertEquals(after.get(rel), content);
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
