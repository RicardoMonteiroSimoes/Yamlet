// `yamlet docs`: the rendered pages are frozen goldens (replayed with --check,
// since pages link their sources relatively), and the owned-directory guards
// hold. Re-freeze the goldens with
//   deno run --allow-read --allow-write tests/gen-docs-oracle.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { copySync, existsSync } from "jsr:@std/fs@1";
import { runDocs } from "../src/docs.ts";

const here = (p: string) => new URL(p, import.meta.url).pathname.replace(/\/$/, "");
const SPECS = here("../../specs_example/");
const FIXTURES = here("./trace-fixtures/");
const ORACLE = here("./oracle-docs/");

Deno.test("docs: specs_example matches the frozen oracle", () => {
  const r = runDocs([SPECS, `${ORACLE}/specs_example`, "--check"]);
  assertEquals(r.stderr, "");
  assertEquals(r.exitCode, 0);
});

Deno.test("docs: trace fixtures (ADRs in every status) match the frozen oracle", () => {
  const r = runDocs([FIXTURES, `${ORACLE}/trace-fixtures`, "--check"]);
  assertEquals(r.stderr, "");
  assertEquals(r.exitCode, 0);
});

Deno.test("docs: tech specs are not rendered; every ADR is, whatever its status", () => {
  const out = Deno.makeTempDirSync();
  assertEquals(runDocs([FIXTURES, out]).exitCode, 0);
  const pages: string[] = [];
  const walk = (d: string) => {
    for (const e of Deno.readDirSync(d)) {
      e.isDirectory ? walk(`${d}/${e.name}`) : pages.push(e.name);
    }
  };
  walk(out);
  assertEquals(pages.length, 6, "index + 1 spec + 4 ADRs, and no page for the tech spec");
  for (const f of ["ADR-0001", "ADR-0002", "ADR-0093", "ADR-0094"]) {
    assert([...Deno.readDirSync(`${out}/decisions`)].some((e) => e.name.startsWith(f)), f);
  }
  const superseded = Deno.readTextFileSync(`${out}/decisions/ADR-0093-superseded-record.md`);
  assertStringIncludes(superseded, "**Superseded** by [ADR-0094");
  const index = Deno.readTextFileSync(`${out}/index.md`);
  assertStringIncludes(index, "| Superseded |");
});

Deno.test("docs: a rejected record says why, and stays as history", () => {
  const src = Deno.makeTempDirSync();
  copySync(FIXTURES, src, { overwrite: true });
  const p = `${src}/ADR-0002-isolation-of-structural-parsing.adr.yaml`;
  Deno.writeTextFileSync(
    p,
    Deno.readTextFileSync(p).replace(
      "status: proposed\n",
      "status: rejected\nrejected_because: >-\n  The scanner fits the request budget.\n",
    ),
  );
  const out = Deno.makeTempDirSync();
  assertEquals(runDocs([src, out]).exitCode, 0);
  const page = Deno.readTextFileSync(
    `${out}/decisions/ADR-0002-isolation-of-structural-parsing.md`,
  );
  assertStringIncludes(page, "> **Rejected.** The scanner fits the request budget.");
});

Deno.test("docs: --check reports missing, changed and extra pages and writes nothing", () => {
  const out = Deno.makeTempDirSync();
  assertEquals(runDocs([SPECS, out]).exitCode, 0);
  assertEquals(runDocs([SPECS, out, "--check"]).exitCode, 0);

  Deno.writeTextFileSync(`${out}/pdf-upload/pdf_upload.md`, "hand edit\n");
  Deno.removeSync(`${out}/index.md`);
  Deno.writeTextFileSync(`${out}/stale.md`, "orphan\n");
  const r = runDocs([SPECS, out, "--check"]);
  assertEquals(r.exitCode, 1);
  assertStringIncludes(r.stderr, `changed  ${out}/pdf-upload/pdf_upload.md`);
  assertStringIncludes(r.stderr, `missing  ${out}/index.md`);
  assertStringIncludes(r.stderr, `extra    ${out}/stale.md`);
  assertEquals(Deno.readTextFileSync(`${out}/pdf-upload/pdf_upload.md`), "hand edit\n");

  // A missing TARGET is all drift, not an error.
  assertEquals(runDocs([SPECS, `${out}/nope`, "--check"]).exitCode, 1);
});

Deno.test("docs: a rerun wipes orphans from its own directory", () => {
  const out = Deno.makeTempDirSync();
  assertEquals(runDocs([SPECS, out]).exitCode, 0);
  Deno.writeTextFileSync(`${out}/stale.md`, "orphan\n");
  assertEquals(runDocs([SPECS, out]).exitCode, 0);
  assert(!existsSync(`${out}/stale.md`));
});

Deno.test("docs: refuses to erase a directory it did not write", () => {
  const out = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${out}/handbook.md`, "mine\n");
  const r = runDocs([SPECS, out]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "refusing to erase it");
  assertEquals(Deno.readTextFileSync(`${out}/handbook.md`), "mine\n");
});

Deno.test("docs: refuses a TARGET that contains SRC", () => {
  const root = Deno.makeTempDirSync();
  copySync(SPECS, `${root}/specs`);
  for (const target of [`${root}/specs`, root]) {
    const r = runDocs([`${root}/specs`, target]);
    assertEquals(r.exitCode, 2, target);
    assertStringIncludes(r.stderr, "would erase the specs");
  }
});

Deno.test("docs: usage errors", () => {
  assertEquals(runDocs([]).exitCode, 2);
  assertEquals(runDocs([SPECS]).exitCode, 2);
  assertEquals(runDocs([SPECS, "a", "b"]).exitCode, 2);
  assertEquals(runDocs([SPECS, "a", "--bogus"]).exitCode, 2);
  assertEquals(runDocs(["/nonexistent", "a"]).exitCode, 2);
});

/** specs/ and a sibling adr/, linked both ways across the boundary. */
function siblingLayout(): string {
  const root = Deno.makeTempDirSync();
  Deno.mkdirSync(`${root}/specs`);
  Deno.mkdirSync(`${root}/adr`);
  const spec = Deno.readTextFileSync(`${FIXTURES}/pdf-verify.yamlet.yaml`)
    .replace(/^(\s*- )(ADR-\d{4}-\S+\.adr\.yaml)$/gm, "$1../adr/$2");
  Deno.writeTextFileSync(`${root}/specs/pdf-verify.yamlet.yaml`, spec);
  for (const e of Deno.readDirSync(FIXTURES)) {
    if (!e.name.endsWith(".adr.yaml")) continue;
    const adr = Deno.readTextFileSync(`${FIXTURES}/${e.name}`)
      .replace(/^- pdf-verify\.yamlet\.yaml/gm, "- ../specs/pdf-verify.yamlet.yaml");
    Deno.writeTextFileSync(`${root}/adr/${e.name}`, adr);
  }
  return root;
}

Deno.test("docs: --adrs renders records kept beside SRC, linked both ways", () => {
  const root = siblingLayout();
  const out = `${root}/out`;
  const r = runDocs([`${root}/specs`, out, `--adrs=${root}/adr`]);
  assertEquals(r.exitCode, 0, r.stderr);
  const spec = Deno.readTextFileSync(`${out}/pdf-service/pdf-verify.md`);
  assertStringIncludes(
    spec,
    "Decided by [ADR-0001 · Structural PDF parsing](../decisions/adr/ADR-0001-structural-pdf-parsing.md)",
  );
  const adr = Deno.readTextFileSync(`${out}/decisions/adr/ADR-0001-structural-pdf-parsing.md`);
  assertStringIncludes(adr, "[PDF verification · AC-8](../../pdf-service/pdf-verify.md#ac-8)");
  assertStringIncludes(adr, "(../../../adr/ADR-0001-structural-pdf-parsing.adr.yaml)");
  assertEquals(runDocs([`${root}/specs`, out, `--adrs=${root}/adr`, "--check"]).exitCode, 0);

  // Without --adrs the link stays visible, as plain text, and no record page is written.
  const bare = runDocs([`${root}/specs`, `${root}/bare`]);
  assertEquals(bare.exitCode, 0);
  assert(!existsSync(`${root}/bare/decisions`));
  assertStringIncludes(
    Deno.readTextFileSync(`${root}/bare/pdf-service/pdf-verify.md`),
    "`../adr/ADR-0001-structural-pdf-parsing.adr.yaml` (not found",
  );
});

Deno.test("docs: a record reached from SRC and from --adrs renders once", () => {
  const out = Deno.makeTempDirSync();
  const r = runDocs([FIXTURES, out, `--adrs=${FIXTURES}`]);
  assertEquals(r.exitCode, 0, r.stderr);
  assertStringIncludes(r.stdout, "4 decisions");
});

Deno.test("docs: --adrs must be a directory and must not sit inside TARGET", () => {
  const root = siblingLayout();
  assertEquals(runDocs([`${root}/specs`, `${root}/out`, `--adrs=${root}/nope`]).exitCode, 2);
  Deno.mkdirSync(`${root}/site`);
  Deno.renameSync(`${root}/adr`, `${root}/site/adr`);
  const r = runDocs([`${root}/specs`, `${root}/site`, `--adrs=${root}/site/adr`]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "would erase the records");
  assert(existsSync(`${root}/site/adr/ADR-0001-structural-pdf-parsing.adr.yaml`));
});
