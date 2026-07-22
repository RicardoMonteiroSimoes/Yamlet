// `yamlet graph` emits a Graphviz DOT diagram from the verifier's own pipeline:
// a leaf becomes one record node, a composite becomes a boundary + member block
// diagram whose delegation wires are dashed and whose assembly wires are solid.

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

Deno.test("graph of a leaf draws its contract as a single record node", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/upload.yamlet.yaml`;
  seedLeaf(f, "pdf-upload", "PDF upload", ["file", "filename"], ["pdf_file"]);

  const r = runGraph([f]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.stdout, "digraph");
  assertStringIncludes(r.stdout, '"contract"');
  assertStringIncludes(r.stdout, "<in__file> file");
  assertStringIncludes(r.stdout, "<out__pdf_file> pdf_file");
  assertStringIncludes(r.stdout, "(pdf-upload)");
  // A leaf has no boundary cluster or wires.
  assert(!r.stdout.includes("cluster_boundary"));
  assert(!r.stdout.includes("->"));
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

  const r = runGraph([comp]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.stdout, "subgraph cluster_boundary");
  assertStringIncludes(r.stdout, "__boundary_in");
  // Members carry their own system as a subtitle.
  assertStringIncludes(r.stdout, "(pdf-upload)");
  assertStringIncludes(r.stdout, "(e-mail-sending-service)");

  // Delegation: a boundary input feeds a member input, drawn dashed.
  assertStringIncludes(
    r.stdout,
    '"__boundary_in":in__file -> "uploads":in__file [color="#8a8a94", style=dashed',
  );
  // Assembly: a member output feeds another member input, drawn solid teal.
  assertStringIncludes(
    r.stdout,
    '"uploads":out__pdf_file -> "mailer":in__attachment [color="#0f766e", penwidth=1.6]',
  );
});

Deno.test("graph rejects an unsupported --format", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const r = runGraph([f, "--format=mermaid"]);
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

  const r = runGraph([f, "--format=json"]);
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.stdout);
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

  const r = runGraph([comp, "--format=json"]);
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.stdout);
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
  const shallow = JSON.parse(runGraph([top, "--format=json"]).stdout);
  const midShallow = shallow.graph.members.find((x: { alias: string }) => x.alias === "middle");
  assertEquals(midShallow.kind, "composite");
  assert(midShallow.graph === undefined);

  // --recursive implies json and expands the whole tree.
  const r = runGraph([top, "--recursive"]);
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.stdout);
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

  const r = runGraph([dir]); // a directory implies json + deep expansion
  assertEquals(r.exitCode, 0);
  const m = JSON.parse(r.stdout);
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
  const m = JSON.parse(runGraph([`${dir}/top.yamlet.yaml`, "-r"]).stdout);
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
  const m = JSON.parse(runGraph([dir]).stdout);
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

  const r = runGraph([comp, "--format=json"]);
  assertEquals(r.exitCode, 0); // resolveComposite is total — it never throws on a bad member
  if (!readable) {
    const m = JSON.parse(r.stdout);
    const sec = m.graph.members.find((x: { alias: string }) => x.alias === "sec");
    assertEquals(sec.status, "missing");
  }
  Deno.chmodSync(member, 0o644); // restore so temp cleanup can read it
});

Deno.test("graph rejects unknown flags (long and short) and extra arguments", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const short = runGraph([f, "-x"]);
  assertEquals(short.exitCode, 2);
  assertStringIncludes(short.stderr, "unknown flag");
  assertEquals(runGraph([f, "--bogus"]).exitCode, 2);
  assertEquals(runGraph([f, f]).exitCode, 2); // two positional arguments
});

Deno.test("graph rejects dot format for a directory or --recursive", () => {
  const dir = Deno.makeTempDirSync();
  seedMidComposite(dir);
  const onDir = runGraph([dir, "--format=dot"]);
  assertEquals(onDir.exitCode, 2);
  assertStringIncludes(onDir.stderr, "single spec");
  const onRec = runGraph([`${dir}/top.yamlet.yaml`, "--format=dot", "--recursive"]);
  assertEquals(onRec.exitCode, 2);
  assertStringIncludes(onRec.stderr, "single spec");
});

Deno.test("graph fails cleanly on a missing file and on a parse error", () => {
  assertEquals(runGraph(["/no/such/file.yamlet.yaml"]).exitCode, 2);

  const dir = Deno.makeTempDirSync();
  const bad = `${dir}/bad.yamlet.yaml`;
  Deno.writeTextFileSync(bad, "system: x\n\ttopic: tabbed\n"); // tab indent → parse error
  const r = runGraph([bad]);
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

  const r = runGraph([f, "--format=html"]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(r.stdout, "<!DOCTYPE html>"); // a full standalone document
  assertStringIncludes(r.stdout, "window.__YAMLET_GRAPH__ = {"); // the model, inlined
  assertStringIncludes(r.stdout, "yamlet.graph/v1");
  // embed mode inlines the layout engine and references no external origin.
  assertStringIncludes(r.stdout, ELK_INLINE_MARK);
  assert(!r.stdout.includes("cdn.jsdelivr.net"));
});

Deno.test("graph --format=html --libs=cdn references a pinned, SRI-guarded elk instead of inlining it", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);

  const r = runGraph([f, "--format=html", "--libs=cdn"]);
  assertEquals(r.exitCode, 0);
  assertStringIncludes(
    r.stdout,
    'src="https://cdn.jsdelivr.net/npm/elkjs@0.12.0/lib/elk.bundled.js"',
  );
  assertStringIncludes(r.stdout, 'integrity="sha384-');
  assertStringIncludes(r.stdout, 'crossorigin="anonymous"');
  assertStringIncludes(r.stdout, "window.__YAMLET_GRAPH__ = {"); // model still inlined
  assert(!r.stdout.includes(ELK_INLINE_MARK)); // engine is NOT inlined
});

Deno.test("graph --libs is rejected without --format=html", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const r = runGraph([f, "--format=json", "--libs=cdn"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "--libs only applies to --format=html");
});

Deno.test("graph rejects an unsupported --libs value", () => {
  const dir = Deno.makeTempDirSync();
  const f = `${dir}/leaf.yamlet.yaml`;
  seedLeaf(f, "svc", "Svc", ["a"], []);
  const r = runGraph([f, "--format=html", "--libs=nope"]);
  assertEquals(r.exitCode, 2);
  assertStringIncludes(r.stderr, "unsupported --libs: nope");
});
