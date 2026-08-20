// `yamlet graph` writes a Graphviz DOT diagram from the verifier's own pipeline:
// a leaf becomes one record node, a composite becomes a boundary + member block
// diagram whose delegation wires are dashed and whose assembly wires are solid.
//
// The payload never reaches stdout — `--out` is required and takes every format —
// so these tests assert on the bytes written to that file (`.payload`), and on
// the one-line summary stdout gets instead (`.summary`).

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runGraph } from "../src/graph.ts";

const HEAD = (system: string, topic: string, front: string): string =>
  `system: ${system}\ntopic: ${topic}\nsummary: a summary\n` +
  `description: >-\n  ctx\nblast_radius: low\nfront: ${front}\n`;

function seedLeaf(
  path: string,
  system: string,
  topic: string,
  inputs: string[],
  outputs: string[],
): void {
  let s = HEAD(system, topic, "external") + `exposes:\n  name: ${system}\n  intent: does a thing\n`;
  s += "  inputs:\n" + inputs.map((i) => `  - ${i}\n`).join("");
  if (outputs.length) s += "  outputs:\n" + outputs.map((o) => `  - ${o}\n`).join("");
  s += "requirements:\n- id: RQ-1\n  description: d\n  acceptance-criteria:\n" +
    "  - id: AC-1\n    pattern: event\n    when: something happens\n    shall:\n    - do it\n";
  Deno.writeTextFileSync(path, s);
}

interface GraphRun {
  exitCode: number;
  stderr: string;
  payload: string; // the bytes written to --out ("" when the run failed)
  summary: string; // the one-line stdout the command prints in place of the payload
  out: string;
}

/** Run `graph` with a temp `--out`, returning the written bytes and the summary separately. */
function graph(args: string[]): GraphRun {
  const out = `${Deno.makeTempDirSync()}/graph.out`;
  const res = runGraph([...args, `--out=${out}`]);
  let payload = "";
  try {
    payload = Deno.readTextFileSync(out);
  } catch { /* nothing written: an error path */ }
  return { exitCode: res.exitCode, stderr: res.stderr, payload, summary: res.stdout, out };
}

Deno.test("graph of a leaf draws its contract as a single record node", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/upload.yamlet.yaml`;
  seedLeaf(f, "pdf-upload", "PDF upload", ["file", "filename"], ["pdf_file"]);

  const r = graph([f]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.payload, "digraph");
  assertStringIncludes(r.payload, '"contract"');
  assertStringIncludes(r.payload, "<in__file> file");
  assertStringIncludes(r.payload, "<out__pdf_file> pdf_file");
  assertStringIncludes(r.payload, "(pdf-upload)");
  // A leaf has no boundary cluster or wires.
  assert(!r.payload.includes("cluster_boundary"));
  assert(!r.payload.includes("->"));
});

Deno.test("graph of a composite draws boundary, members, and typed wires", () => {
  const dir = Deno.makeTempDirSync();
  seedLeaf(`${dir}/up.yamlet.yaml`, "pdf-upload", "Upload", ["file"], ["pdf_file"]);
  seedLeaf(
    `${dir}/mail.yamlet.yaml`,
    "e-mail-sending-service",
    "Mail",
    ["recipient", "attachment"],
    [],
  );

  const comp = `${dir}/archiver.yamlet.yaml`;
  Deno.writeTextFileSync(
    comp,
    HEAD("pdf-archiver", "Archiver", "internal") +
      "exposes:\n  name: pdf-archiver\n  intent: archive\n  inputs:\n  - file\n  - archive_address\n" +
      "components:\n- uploads: up.yamlet.yaml\n- mailer: mail.yamlet.yaml\n" +
      "connections:\n  uploads.file: input.file\n  mailer.recipient: input.archive_address\n" +
      "  mailer.attachment: uploads.pdf_file\n",
  );

  const r = graph([comp]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.payload, "subgraph cluster_boundary");
  assertStringIncludes(r.payload, "__boundary_in");
  // Members carry their own system as a subtitle.
  assertStringIncludes(r.payload, "(pdf-upload)");
  assertStringIncludes(r.payload, "(e-mail-sending-service)");

  // Delegation: a boundary input feeds a member input, drawn dashed.
  assertStringIncludes(
    r.payload,
    '"__boundary_in":in__file -> "uploads":in__file [color="#8a8a94", style=dashed',
  );
  // Assembly: a member output feeds another member input, drawn solid teal.
  assertStringIncludes(
    r.payload,
    '"uploads":out__pdf_file -> "mailer":in__attachment [color="#0f766e", penwidth=1.6]',
  );
});

Deno.test("graph rejects an unsupported --format", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const r = graph([f, "--format=mermaid"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "supported: dot, json");
});

// A composite that both exposes a contract and wires in one member — the unit of
// nesting used by the recursion/forest tests below.
function seedMidComposite(dir: string): void {
  seedLeaf(`${dir}/inner.yamlet.yaml`, "inner-sys", "Inner", ["x"], ["y"]);
  Deno.writeTextFileSync(
    `${dir}/mid.yamlet.yaml`,
    HEAD("mid-sys", "Mid", "internal") +
      "exposes:\n  name: mid\n  intent: mid\n  inputs:\n  - x\n  outputs:\n  - y\n" +
      "components:\n- inner: inner.yamlet.yaml\n" +
      "connections:\n  inner.x: input.x\n  output.y: inner.y\n",
  );
  Deno.writeTextFileSync(
    `${dir}/top.yamlet.yaml`,
    HEAD("top-sys", "Top", "internal") +
      "exposes:\n  name: top\n  intent: top\n  inputs:\n  - x\n" +
      "components:\n- middle: mid.yamlet.yaml\n" +
      "connections:\n  middle.x: input.x\n",
  );
}

Deno.test("graph --format=json emits a leaf's contract as a yamlet.graph/v1 model", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/upload.yamlet.yaml`;
  seedLeaf(f, "pdf-upload", "PDF upload", ["file", "filename"], ["pdf_file"]);

  const r = graph([f, "--format=json"]);
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.payload);
  assertEquals(m.format, "yamlet.graph/v1");
  assertEquals(m.kind, "leaf");
  assertEquals(m.spec.system, "pdf-upload");
  assertEquals(m.spec.front, "external");
  assertEquals(m.spec.inputs, ["file", "filename"]);
  assertEquals(m.spec.outputs, ["pdf_file"]);
  assertEquals(m.spec.requirements, 1);
  // A leaf carries no graph body.
  assert(m.graph === undefined);
});

Deno.test("graph --format=json emits a composite's graph body: members, boundary, typed wires", () => {
  const dir = Deno.makeTempDirSync();
  seedLeaf(`${dir}/up.yamlet.yaml`, "pdf-upload", "Upload", ["file"], ["pdf_file"]);
  seedLeaf(
    `${dir}/mail.yamlet.yaml`,
    "e-mail-sending-service",
    "Mail",
    ["recipient", "attachment"],
    [],
  );

  const comp = `${dir}/archiver.yamlet.yaml`;
  Deno.writeTextFileSync(
    comp,
    HEAD("pdf-archiver", "Archiver", "internal") +
      "exposes:\n  name: pdf-archiver\n  intent: archive\n  inputs:\n  - file\n  - archive_address\n" +
      "components:\n- uploads: up.yamlet.yaml\n- mailer: mail.yamlet.yaml\n" +
      "connections:\n  uploads.file: input.file\n  mailer.recipient: input.archive_address\n" +
      "  mailer.attachment: uploads.pdf_file\n",
  );

  const r = graph([comp, "--format=json"]);
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.payload);
  assertEquals(m.kind, "composite");
  assertEquals(m.graph.boundary, { in: "__boundary_in", out: "__boundary_out" });

  // Members are sorted by alias and carry their kind, metadata + source path.
  assertEquals(m.graph.members.map((x: { alias: string }) => x.alias), ["mailer", "uploads"]);
  const uploads = m.graph.members.find((x: { alias: string }) => x.alias === "uploads");
  assertEquals(uploads.kind, "leaf");
  assertEquals(uploads.status, "ok");
  assertEquals(uploads.system, "pdf-upload");
  assertEquals(uploads.outputs, ["pdf_file"]);
  assertStringIncludes(uploads.file, "up.yamlet.yaml");
  // Leaf members are not expanded.
  assert(uploads.graph === undefined);

  // The assembly wire (member output → member input) is typed and directed.
  const asm = m.graph.wires.find((w: { kind: string }) => w.kind === "assembly");
  assertEquals(asm.from, { node: "uploads", dir: "out", socket: "pdf_file" });
  assertEquals(asm.to, { node: "mailer", dir: "in", socket: "attachment" });
  // A delegation wire runs from the boundary into a member.
  const del = m.graph.wires.find(
    (w: { kind: string; from: { node: string } }) =>
      w.kind === "delegation" && w.from.node === "__boundary_in",
  );
  assert(del !== undefined);
});

Deno.test("graph --recursive expands member composites into nested graph bodies", () => {
  const dir = Deno.makeTempDirSync();
  seedMidComposite(dir);
  const top = `${dir}/top.yamlet.yaml`;

  // Non-recursive: a composite member is reported but not expanded.
  const shallow = JSON.parse(graph([top, "--format=json"]).payload);
  const midShallow = shallow.graph.members.find((x: { alias: string }) => x.alias === "middle");
  assertEquals(midShallow.kind, "composite");
  assert(midShallow.graph === undefined);

  // --recursive implies json and expands the whole tree.
  const r = graph([top, "--recursive"]);
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.payload);
  const middle = m.graph.members.find((x: { alias: string }) => x.alias === "middle");
  assertEquals(middle.kind, "composite");
  assert(middle.graph !== undefined);
  const inner = middle.graph.members.find((x: { alias: string }) => x.alias === "inner");
  assertEquals(inner.kind, "leaf");
  assert(inner.graph === undefined);
});

Deno.test("graph of a directory emits a forest of root specs, expanded, surfacing skips", () => {
  const dir = Deno.makeTempDirSync();
  seedMidComposite(dir);
  // A file that does not parse must be surfaced, not silently dropped.
  Deno.writeTextFileSync(`${dir}/broken.yamlet.yaml`, "system: x\n\ttopic: tabbed\n");

  const r = graph([dir]); // a directory implies json + deep expansion
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.payload);
  assertEquals(m.kind, "forest");

  // Only `top` is a root — `mid` and `inner` are included by others.
  assertEquals(m.roots.length, 1);
  assertEquals(m.roots[0].spec.system, "top-sys");
  // The forest is deep: the root's composite member is expanded.
  const middle = m.roots[0].graph.members.find((x: { alias: string }) => x.alias === "middle");
  assert(middle.graph !== undefined);
  // The unparseable file is reported.
  assert(m.skipped.some((s: { file: string }) => s.file.endsWith("broken.yamlet.yaml")));
});

Deno.test("graph accepts the -r short alias for --recursive", () => {
  const dir = Deno.makeTempDirSync();
  seedMidComposite(dir);
  const m = JSON.parse(graph([`${dir}/top.yamlet.yaml`, "-r"]).payload);
  const middle = m.graph.members.find((x: { alias: string }) => x.alias === "middle");
  assert(middle.graph !== undefined);
});

Deno.test("a spec that includes itself is still reported as a root", () => {
  const dir = Deno.makeTempDirSync();
  seedLeaf(`${dir}/inner.yamlet.yaml`, "inner-sys", "Inner", ["x"], ["y"]);
  // `loop` lists itself as a member — it must not disqualify itself from being a root.
  Deno.writeTextFileSync(
    `${dir}/loop.yamlet.yaml`,
    HEAD("loop-sys", "Loop", "internal") +
      "exposes:\n  name: loop\n  intent: loop\n  inputs:\n  - x\n" +
      "components:\n- inner: inner.yamlet.yaml\n- me: loop.yamlet.yaml\n" +
      "connections:\n  inner.x: input.x\n",
  );
  const m = JSON.parse(graph([dir]).payload);
  assertEquals(m.kind, "forest");
  assert(m.roots.some((r: { spec: { system: string } }) => r.spec.system === "loop-sys"));
});

Deno.test("an unreadable member file is reported as missing, never a crash", () => {
  const dir = Deno.makeTempDirSync();
  const member = `${dir}/secret.yamlet.yaml`;
  seedLeaf(member, "sec-sys", "Secret", ["a"], []);
  Deno.chmodSync(member, 0o000);
  let readable = true;
  try {
    Deno.readTextFileSync(member);
  } catch {
    readable = false;
  }

  const comp = `${dir}/host.yamlet.yaml`;
  Deno.writeTextFileSync(
    comp,
    HEAD("host-sys", "Host", "internal") +
      "exposes:\n  name: host\n  intent: host\n  inputs:\n  - a\n" +
      "components:\n- sec: secret.yamlet.yaml\n" +
      "connections:\n  sec.a: input.a\n",
  );

  const r = graph([comp, "--format=json"]);
  assertEquals(r.exitCode, 0); // resolveComposite is total — it never throws on a bad member
  if (!readable) {
    const m = JSON.parse(r.payload);
    const sec = m.graph.members.find((x: { alias: string }) => x.alias === "sec");
    assertEquals(sec.status, "missing");
  }
  Deno.chmodSync(member, 0o644); // restore so temp cleanup can read it
});

Deno.test("graph rejects unknown flags (long and short) and extra arguments", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const short = graph([f, "-x"]);
  assertEquals(short.exitCode, 2);
  assertStringIncludes(short.stderr, "unknown flag");
  assertEquals(graph([f, "--bogus"]).exitCode, 2);
  assertEquals(graph([f, f]).exitCode, 2); // two positional arguments
});

Deno.test("graph rejects dot format for a directory or --recursive", () => {
  const dir = Deno.makeTempDirSync();
  seedMidComposite(dir);
  const onDir = graph([dir, "--format=dot"]);
  assertEquals(onDir.exitCode, 2);
  assertStringIncludes(onDir.stderr, "single spec");
  const onRec = graph([`${dir}/top.yamlet.yaml`, "--format=dot", "--recursive"]);
  assertEquals(onRec.exitCode, 2);
  assertStringIncludes(onRec.stderr, "single spec");
});

Deno.test("graph fails cleanly on a missing file and on a parse error", () => {
  assertEquals(graph(["/no/such/file.yamlet.yaml"]).exitCode, 2);

  const dir = Deno.makeTempDirSync();
  const bad = `${dir}/bad.yamlet.yaml`;
  Deno.writeTextFileSync(bad, "system: x\n\ttopic: tabbed\n"); // tab indent → parse error
  const r = graph([bad]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "verify");
});

// ── --format=html: the self-contained interactive viewer ──────────────────
//
// A marker string that only appears when the elk UMD bundle is inlined — used to
// tell embed (present) from cdn (absent) apart without pinning the whole payload.
const ELK_INLINE_MARK = "function(f){if(typeof exports";

Deno.test("graph --format=html embeds the viewer and inlines elk by default", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);

  const r = graph([f, "--format=html"]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.payload, "<!DOCTYPE html>"); // a full standalone document
  assertStringIncludes(r.payload, "window.__YAMLET_GRAPH__ = {"); // the model, inlined
  assertStringIncludes(r.payload, "yamlet.graph/v1");
  // embed mode inlines the layout engine and references no external origin.
  assertStringIncludes(r.payload, ELK_INLINE_MARK);
  assert(!r.payload.includes("cdn.jsdelivr.net"));
});

Deno.test("graph --format=html --libs=cdn references a pinned, SRI-guarded elk instead of inlining it", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);

  const r = graph([f, "--format=html", "--libs=cdn"]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(
    r.payload,
    'src="https://cdn.jsdelivr.net/npm/elkjs@0.12.0/lib/elk.bundled.js"',
  );
  assertStringIncludes(r.payload, 'integrity="sha384-');
  assertStringIncludes(r.payload, 'crossorigin="anonymous"');
  assertStringIncludes(r.payload, "window.__YAMLET_GRAPH__ = {"); // model still inlined
  assert(!r.payload.includes(ELK_INLINE_MARK)); // engine is NOT inlined
});

Deno.test("graph --libs is rejected without --format=html", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const r = graph([f, "--format=json", "--libs=cdn"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "--libs only applies to --format=html");
});

Deno.test("graph rejects an unsupported --libs value", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const r = graph([f, "--format=html", "--libs=nope"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "unsupported --libs: nope");
});

// ── --out: the payload has no path to stdout ──────────────────────────────
//
// The reason this flag is required rather than optional: `--format=html` inlines
// the elk layout engine, so it is ~1.6 MB whatever the spec count. Returned as an
// agent tool result that exhausts a context window in a single call. These tests
// pin the guarantee that no format can print its payload.

Deno.test("graph requires --out and refuses to run without it", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);

  for (const args of [[f], [f, "--format=json"], [f, "--format=html"], [dir]]) {
    const r = runGraph(args); // deliberately raw: no --out appended
    assertEquals(r.exitCode, 2);
    assertEquals(r.stdout, "");
    assertStringIncludes(r.stderr, "requires --out=FILE");
  }
});

Deno.test("graph writes every format to --out and prints only a summary", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);

  for (
    const [fmt, mark] of [["dot", "digraph"], ["json", "yamlet.graph/v1"], [
      "html",
      "<!DOCTYPE html>",
    ]]
  ) {
    const r = graph([f, `--format=${fmt}`]);
    assertEquals(r.exitCode, 0);
    assertStringIncludes(r.payload, mark!); // the payload landed in the file
    assert(!r.summary.includes(mark!)); // and nowhere near stdout
    assertStringIncludes(r.summary, `wrote ${r.out}`);
    assertStringIncludes(r.summary, fmt!);
    assertEquals(r.summary.trimEnd().includes("\n"), false); // exactly one line
  }
});

Deno.test("the summary stays tiny even for the ~1.6 MB embedded-elk viewer", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);

  const r = graph([f, "--format=html"]); // --libs=embed is the default
  assertEquals(r.exitCode, 0);
  assert(r.payload.length > 1_000_000, `expected the embedded viewer, got ${r.payload.length} B`);
  assert(
    r.summary.length < 200,
    `summary should not scale with the payload: ${r.summary.length} B`,
  );
  assertStringIncludes(r.summary, "MB");
});

Deno.test("graph refuses an --out that would overwrite a spec", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const before = Deno.readTextFileSync(f);

  for (const victim of [f, `${dir}/other.yamlet.yml`]) {
    const r = runGraph([f, `--out=${victim}`]);
    assertEquals(r.exitCode, 2);
    assertStringIncludes(r.stderr, "must not name a spec file");
  }
  assertEquals(Deno.readTextFileSync(f), before); // the spec is untouched
});

Deno.test("graph reports a write it cannot perform instead of succeeding silently", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);

  const r = runGraph([f, `--out=${dir}/no/such/dir/graph.dot`]);
  assertEquals(r.exitCode, 2);
  assertEquals(r.stdout, "");
  assertStringIncludes(r.stderr, "could not write");
});

Deno.test("the summary counts what it wrote: roots, members and wires", () => {
  const dir = Deno.makeTempDirSync();
  seedMidComposite(dir);

  const one = graph([`${dir}/top.yamlet.yaml`, "--format=json"]);
  assertStringIncludes(one.summary, "1 root,");

  // Deep expansion reaches the nested composite, so the totals grow.
  const deep = graph([`${dir}/top.yamlet.yaml`, "--format=json", "--recursive"]);
  assertStringIncludes(deep.summary, "members");
  const members = (s: string) => Number(s.match(/(\d+) members/)?.[1] ?? 0);
  assert(
    members(deep.summary) > members(one.summary),
    `--recursive should count more members: ${one.summary} vs ${deep.summary}`,
  );
});
