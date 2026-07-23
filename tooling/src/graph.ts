// `yamlet graph` — emit a machine-readable model of a spec's structure as Graphviz
// DOT (`--format=dot`, the default), a renderer-agnostic JSON graph (`--format=json`),
// or a self-contained interactive HTML viewer of that JSON (`--format=html`; the
// viewer assembler lives in `viewer/html.ts`, its layout engine chosen by `--libs`).
//
// For a *composite* the graph is the internal block diagram: the boundary's
// input and output ports, one node per member (ports = its exposes sockets),
// and the wiring — delegation edges (boundary↔member) and assembly edges
// (member output→member input). For a *leaf* it is the single exposed contract.
//
// `--format=dot` emits DOT *text*, not a rendered image: a real layout engine
// (`dot -Tsvg`) places the nodes, which is exactly the fragile hand-placement
// this command exists to eliminate. Pipe it:
//
//   yamlet graph specs_example/pdf_archiver.yamlet.yaml | dot -Tsvg > diagram.svg
//
// `--format=json` emits the same structure as a stable `yamlet.graph/v1`
// document (nodes, ports, typed wires, per-member metadata + source paths) so a
// custom engine or renderer — an interactive viewer, a different layout tool —
// can display the graph without re-parsing yamlet. See `GraphModel` below.
//
// Scope, model formats only — json/html (DOT is always a single spec at one level):
//   • `--recursive` expands member composites into their own nested `graph`, so
//     one root spec yields the whole composition tree (a self-similar model).
//   • pointing at a DIRECTORY yields a `forest` — every root spec (one nothing
//     else includes) under it, each expanded. A directory or `--recursive`
//     implies a model format and deep expansion; forcing `--format=dot` on
//     either is an error.
//
// All formats reuse the verifier's own pipeline (flatten → resolveComposite →
// the connections records) so the picture can never disagree with the verifier
// about which wires exist.
//
// Read-only. Exit codes: 0 ok · 2 usage/parse error (run `yamlet verify` first).

import type { CmdResult, Command } from "./types.ts";
import { flatten } from "./flatten.ts";
import { type CompositeInfo, type MemberStatus, resolveComposite } from "./composite.ts";
import { listSpecs } from "./systems.ts";
import type { FlatRecord } from "./types.ts";
import { type Libs, renderViewerHtml } from "./viewer/html.ts";

const die = (msg: string): CmdResult => ({ exitCode: 2, stdout: "", stderr: `error: ${msg}\n` });

// Node ids reserved for the composite boundary's port banks.
const BOUNDARY_IN = "__boundary_in";
const BOUNDARY_OUT = "__boundary_out";

// Subtle per-system fills; members sharing a system share a colour.
const PALETTE = ["#e8ecff", "#fff0e0", "#e0f5f0", "#f3e8ff", "#eef7e0", "#ffe8ef"];

/** A record-port id, namespaced by direction so `in`/`out` sockets never clash. */
function portId(dir: "in" | "out", socket: string): string {
  return `${dir}__${socket}`;
}

interface Meta {
  system: string;
  topic: string;
  name: string;
  intent: string;
  front: string;
  blastRadius: string;
  inputs: string[];
  outputs: string[];
  requirements: number;
}

/** Read a spec's header + contract + requirement count from its flattened records. */
function metaOf(records: FlatRecord[]): Meta {
  const get = (path: string): string => records.find((r) => r.path === path)?.value ?? "";
  const collect = (re: RegExp): string[] =>
    records.filter((r) => re.test(r.path)).map((r) => r.value);
  const reqIds = new Set(
    records
      .map((r) => r.path.match(/^requirements\[([0-9]+)\]/)?.[1])
      .filter((x): x is string => x !== undefined),
  );
  return {
    system: get("system"),
    topic: get("topic"),
    name: get("exposes.name"),
    intent: get("exposes.intent"),
    front: get("front"),
    blastRadius: get("blast_radius"),
    inputs: collect(/^exposes\.inputs\[[0-9]+\]$/),
    outputs: collect(/^exposes\.outputs\[[0-9]+\]$/),
    requirements: reqIds.size,
  };
}

/**
 * One end of a wire: a `node` (a member alias, or a reserved boundary id) and a
 * `socket` on the port field named by `dir`. The stable port id a renderer draws
 * is `portId(dir, socket)` — the same id DOT uses.
 */
interface Endpoint {
  node: string;
  dir: "in" | "out";
  socket: string;
}
interface Wire {
  kind: "delegation" | "assembly";
  from: Endpoint;
  to: Endpoint;
}

/**
 * Parse the `connections` records into directed wires. A wire is a delegation
 * when either endpoint is a composite boundary port (`input.NAME` source or
 * `output.NAME` sink), otherwise it is an assembly between two members. Malformed
 * entries are skipped — `yamlet verify` is the authority on those.
 */
function wiresOf(records: FlatRecord[]): Wire[] {
  const wires: Wire[] = [];
  for (const r of records) {
    const m = r.path.match(/^connections\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/);
    if (!m) continue;
    const group = m[1]!;
    const socket = m[2]!;
    const src = r.value;

    const toBoundaryOut = group === "output";
    const to: Endpoint = toBoundaryOut
      ? { node: BOUNDARY_OUT, dir: "out", socket }
      : { node: group, dir: "in", socket };

    const im = src.match(/^input\.([a-z][a-z0-9_]*)$/);
    let from: Endpoint;
    let fromBoundaryIn = false;
    if (im) {
      from = { node: BOUNDARY_IN, dir: "in", socket: im[1]! };
      fromBoundaryIn = true;
    } else {
      const am = src.match(/^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/);
      if (!am || am[1] === "input" || am[1] === "output") continue; // malformed → verify catches it
      from = { node: am[1]!, dir: "out", socket: am[2]! };
    }

    wires.push({ kind: toBoundaryOut || fromBoundaryIn ? "delegation" : "assembly", from, to });
  }
  return wires;
}

// ── DOT emission helpers ──────────────────────────────────────────────────

/** Escape a value for a Graphviz record label (only `{}|<>` and quotes are structural). */
function escRecord(s: string): string {
  return s.replace(/([\\{}|<>"])/g, "\\$1");
}

/** Escape a value for a plain double-quoted DOT string attribute. */
function escAttr(s: string): string {
  return s.replace(/(["\\])/g, "\\$1");
}

/** A vertically-stacked field of ports for one side of a record (empty if none). */
function portField(dir: "in" | "out", sockets: string[]): string {
  if (sockets.length === 0) return "";
  return "{" + sockets.map((s) => `<${portId(dir, s)}> ${escRecord(s)}`).join(" | ") + "}";
}

/** Build a left-to-right record label: [inputs] | title/subtitle | [outputs]. */
function recordLabel(inputs: string[], titleLines: string[], outputs: string[]): string {
  const mid = titleLines.map(escRecord).join("\\n");
  return [portField("in", inputs), mid, portField("out", outputs)]
    .filter((f) => f !== "")
    .join(" | ");
}

const DEL_STYLE = `[color="#8a8a94", style=dashed, arrowsize=0.8]`;
const ASM_STYLE = `[color="#0f766e", penwidth=1.6]`;

function edgeLine(w: Wire): string {
  const port = (e: Endpoint): string => `"${e.node}":${portId(e.dir, e.socket)}`;
  const head = `${port(w.from)} -> ${port(w.to)}`;
  return `  ${head} ${w.kind === "delegation" ? DEL_STYLE : ASM_STYLE};`;
}

function dotComposite(meta: Meta, c: CompositeInfo, records: FlatRecord[]): string {
  const members = [...c.memberDeclared].sort();
  const memMeta = new Map<string, Meta>();
  for (const al of members) {
    const p = c.memberPath.get(al);
    if (!p) continue;
    try {
      memMeta.set(al, metaOf(flatten(Deno.readTextFileSync(p)).records));
    } catch {
      // missing file → E603 territory; drawn as a stub below.
    }
  }

  const systems = [
    ...new Set(members.map((al) => memMeta.get(al)?.system).filter((s): s is string => !!s)),
  ].sort();
  const fillOf = (sys: string): string => PALETTE[systems.indexOf(sys) % PALETTE.length]!;

  const L: string[] = [];
  L.push(`digraph "${escAttr(meta.topic || meta.system)}" {`);
  L.push(`  rankdir=LR;`);
  L.push(
    `  graph [fontname="Helvetica", labelloc=t, fontsize=13, label="${escAttr(meta.topic)}\\n${
      escAttr(meta.system)
    }"];`,
  );
  L.push(
    `  node  [shape=record, fontname="Helvetica", fontsize=11, style=filled, fillcolor="#f6f6f8", color="#c9c9d2"];`,
  );
  L.push(`  edge  [fontname="Helvetica", fontsize=9];`);
  L.push("");

  // Boundary port banks — the composite's own exposed contract.
  if (meta.inputs.length > 0) {
    L.push(
      `  "${BOUNDARY_IN}" [label="{ boundary in | ${
        portField("in", meta.inputs)
      } }", fillcolor="#eef0f4", color="#9aa0ac"];`,
    );
  }
  if (meta.outputs.length > 0) {
    L.push(
      `  "${BOUNDARY_OUT}" [label="{ ${
        portField("out", meta.outputs)
      } | boundary out }", fillcolor="#eef0f4", color="#9aa0ac"];`,
    );
  }
  L.push("");

  // Members, boxed inside the composite boundary cluster.
  L.push(`  subgraph cluster_boundary {`);
  L.push(`    label="";`);
  L.push(`    style="rounded,dashed"; color="#b6bac4"; margin=16;`);
  for (const al of members) {
    const mm = memMeta.get(al);
    if (!mm) {
      L.push(
        `    "${al}" [label="${escRecord(al)}\\n(missing)", fillcolor="#fde8e8", color="#d98a8a"];`,
      );
      continue;
    }
    const inputs = [...(c.memberInputs.get(al) ?? new Set<string>())].sort();
    const outputs = [...(c.memberOutputs.get(al) ?? new Set<string>())].sort();
    const label = recordLabel(inputs, [al, `(${mm.system})`], outputs);
    L.push(`    "${al}" [label="${label}", fillcolor="${fillOf(mm.system)}"];`);
  }
  L.push(`  }`);
  L.push("");

  for (const w of wiresOf(records)) L.push(edgeLine(w));
  L.push(`}`);
  return L.join("\n") + "\n";
}

function dotLeaf(meta: Meta): string {
  const titleLines = [meta.name || meta.topic, `(${meta.system})`];
  if (meta.requirements > 0) {
    titleLines.push(`${meta.requirements} requirement${meta.requirements === 1 ? "" : "s"}`);
  }
  const label = recordLabel(meta.inputs, titleLines, meta.outputs);
  const L: string[] = [];
  L.push(`digraph "${escAttr(meta.topic || meta.system)}" {`);
  L.push(`  rankdir=LR;`);
  L.push(
    `  graph [fontname="Helvetica", labelloc=t, fontsize=13, label="${escAttr(meta.topic)}\\n${
      escAttr(meta.system)
    }"];`,
  );
  L.push(
    `  node  [shape=record, fontname="Helvetica", fontsize=11, style=filled, fillcolor="#e8ecff", color="#9aa0ac"];`,
  );
  L.push(`  "contract" [label="${label}"];`);
  L.push(`}`);
  return L.join("\n") + "\n";
}

// ── JSON model (`yamlet.graph/v1`) ────────────────────────────────────────
//
// The renderer-agnostic contract. A custom engine reads this instead of the
// yamlet source. The model is *self-similar*: a composite carries a `graph`
// body `{boundary, members, wires}`, and a member that is itself a composite
// carries the same body under its own `graph` (when `--recursive`) — so a
// renderer walks the tree with one recursive routine. A wire endpoint
// `{node, dir, socket}` maps to the stable port id `${dir}__${socket}` on
// `node`; the two reserved `boundary` ids denote the enclosing composite's own
// contract, whose sockets are its `spec.inputs` / `member.inputs` (resp. out).
//
// Three top-level `kind`s: `leaf` (only `spec`), `composite` (`spec` + `graph`),
// and `forest` (a directory scan: `roots[]`, plus any `skipped[]` files).

/** A wire endpoint, mirroring the internal `Endpoint` (see its doc). */
interface GraphEndpoint {
  node: string;
  dir: "in" | "out";
  socket: string;
}

interface GraphWire {
  kind: "delegation" | "assembly";
  from: GraphEndpoint;
  to: GraphEndpoint;
}

/** A composite's internals: its boundary, its members, and the wires between them. */
interface GraphBody {
  boundary: { in: string; out: string }; // reserved node ids for this composite's own ports
  members: GraphMember[];
  wires: GraphWire[];
}

interface GraphMember {
  alias: string;
  status: MemberStatus; // ok | missing | noexposes
  kind: "leaf" | "composite";
  system: string;
  topic: string;
  name: string;
  intent: string;
  front: string;
  blastRadius: string;
  file: string; // resolved source path — a renderer can link/open it
  inputs: string[]; // declared exposes input sockets (sinks)
  outputs: string[]; // declared exposes output sockets (sources)
  requirements: number;
  graph?: GraphBody; // composite member, expanded (present under `--recursive`)
  truncated?: true; // composite member left unexpanded because it re-entered a cycle
}

interface GraphSpec {
  system: string;
  topic: string;
  name: string;
  intent: string;
  front: string;
  blastRadius: string;
  file: string;
  inputs: string[];
  outputs: string[];
  requirements: number;
}

interface GraphModel {
  format: "yamlet.graph/v1";
  kind: "leaf" | "composite";
  spec: GraphSpec;
  graph?: GraphBody; // present iff kind === "composite"
}

interface ForestModel {
  format: "yamlet.graph/v1";
  kind: "forest";
  root: string; // the scanned directory
  roots: GraphModel[]; // specs nothing else includes, sorted by path, each expanded
  skipped?: { file: string; reason: string }[]; // files that couldn't be graphed (surfaced, not dropped)
}

interface BuildOpts {
  recursive: boolean;
}

/** Canonicalize a path for cycle detection; falls back to the raw path if it can't resolve. */
function canonPath(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

function specOf(meta: Meta, file: string): GraphSpec {
  return {
    system: meta.system,
    topic: meta.topic,
    name: meta.name,
    intent: meta.intent,
    front: meta.front,
    blastRadius: meta.blastRadius,
    file,
    inputs: meta.inputs,
    outputs: meta.outputs,
    requirements: meta.requirements,
  };
}

/** One member of `c`, expanded into its own nested `graph` when recursing (cycle-guarded by `path`). */
function memberModel(
  alias: string,
  c: CompositeInfo,
  opts: BuildOpts,
  path: Set<string>,
): GraphMember {
  const file = c.memberPath.get(alias) ?? "";

  // Read the member once for its metadata and (possibly) its own composition.
  let mRecords: FlatRecord[] = [];
  let mComposite: CompositeInfo | null = null;
  let mm: Meta | null = null;
  try {
    const text = Deno.readTextFileSync(file);
    const flat = flatten(text);
    if (flat.parseErrors.length === 0) {
      mRecords = flat.records;
      mm = metaOf(mRecords);
      mComposite = resolveComposite(file, text, mRecords);
    }
  } catch {
    // missing/unreadable → status carries it; drawn as a stub by renderers.
  }

  const member: GraphMember = {
    alias,
    status: c.memberStatus.get(alias) ?? "missing",
    kind: mComposite?.isComposite ? "composite" : "leaf",
    system: mm?.system ?? "",
    topic: mm?.topic ?? "",
    name: mm?.name ?? "",
    intent: mm?.intent ?? "",
    front: mm?.front ?? "",
    blastRadius: mm?.blastRadius ?? "",
    file,
    inputs: [...(c.memberInputs.get(alias) ?? new Set<string>())].sort(),
    outputs: [...(c.memberOutputs.get(alias) ?? new Set<string>())].sort(),
    requirements: mm?.requirements ?? 0,
  };

  if (member.kind === "composite" && opts.recursive && mComposite) {
    const canon = canonPath(file);
    if (path.has(canon)) {
      member.truncated = true; // cycle: expanding would not terminate
    } else {
      path.add(canon);
      member.graph = bodyOf(mComposite, mRecords, opts, path);
      path.delete(canon); // path-based: a shared member still expands on other branches
    }
  }
  return member;
}

/** The `{boundary, members, wires}` body of a composite. */
function bodyOf(
  c: CompositeInfo,
  records: FlatRecord[],
  opts: BuildOpts,
  path: Set<string>,
): GraphBody {
  return {
    boundary: { in: BOUNDARY_IN, out: BOUNDARY_OUT },
    members: [...c.memberDeclared].sort().map((alias) => memberModel(alias, c, opts, path)),
    wires: wiresOf(records),
  };
}

/** Build the `yamlet.graph/v1` model for one spec (recursing into members under `opts.recursive`). */
function graphModel(
  file: string,
  meta: Meta,
  c: CompositeInfo,
  records: FlatRecord[],
  opts: BuildOpts,
): GraphModel {
  const spec = specOf(meta, file);
  if (!c.isComposite) return { format: "yamlet.graph/v1", kind: "leaf", spec };
  const path = new Set<string>([canonPath(file)]);
  return {
    format: "yamlet.graph/v1",
    kind: "composite",
    spec,
    graph: bodyOf(c, records, opts, path),
  };
}

/** Scan `root` for spec files and model every *root* spec (one nothing else includes). */
function forestModel(root: string, opts: BuildOpts): ForestModel {
  const skipped: { file: string; reason: string }[] = [];
  const parsed = new Map<
    string,
    { records: FlatRecord[]; composite: CompositeInfo; meta: Meta }
  >();
  const included = new Set<string>();

  for (const f of listSpecs(root)) {
    let text: string;
    try {
      text = Deno.readTextFileSync(f);
    } catch {
      skipped.push({ file: f, reason: "unreadable" });
      continue;
    }
    const flat = flatten(text);
    if (flat.parseErrors.length > 0) {
      skipped.push({ file: f, reason: "parse error (run `yamlet verify`)" });
      continue;
    }
    const composite = resolveComposite(f, text, flat.records);
    parsed.set(f, { records: flat.records, composite, meta: metaOf(flat.records) });
    const self = canonPath(f);
    for (const p of composite.memberPath.values()) {
      const cp = canonPath(p);
      if (cp !== self) included.add(cp); // a spec that includes itself is still a root
    }
  }

  const roots: GraphModel[] = [];
  for (const f of [...parsed.keys()].sort()) {
    if (included.has(canonPath(f))) continue; // included by another spec → not a root
    const ctx = parsed.get(f)!;
    roots.push(graphModel(f, ctx.meta, ctx.composite, ctx.records, opts));
  }

  const model: ForestModel = { format: "yamlet.graph/v1", kind: "forest", root, roots };
  if (skipped.length > 0) model.skipped = skipped;
  return model;
}

const json = (v: unknown): CmdResult => ({
  exitCode: 0,
  stdout: JSON.stringify(v, null, 2) + "\n",
  stderr: "",
});

/** A human page title for a model: the first root's topic (forest) or the spec's own. */
function titleOf(model: GraphModel | ForestModel): string {
  if (model.kind === "forest") return model.roots[0]?.spec.topic || model.root;
  return model.spec.topic || model.spec.system || "graph";
}

/** Read+flatten one spec file, or a ready-to-return error (missing / doesn't parse). */
function loadSpec(
  target: string,
): { ok: true; text: string; records: FlatRecord[] } | { ok: false; res: CmdResult } {
  let text: string;
  try {
    text = Deno.readTextFileSync(target);
  } catch {
    return { ok: false, res: die(`file not found: ${target}`) };
  }
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) {
    return {
      ok: false,
      res: die(`${target} does not parse; run \`yamlet verify ${target}\` first`),
    };
  }
  return { ok: true, text, records };
}

export function runGraph(args: string[]): CmdResult {
  let target = "";
  let format = "dot";
  let formatSet = false;
  let recursive = false;
  let libs: Libs = "embed";
  let libsSet = false;
  for (const a of args) {
    if (a === "--recursive" || a === "-r") recursive = true;
    else if (a.startsWith("--format=")) {
      format = a.slice("--format=".length);
      formatSet = true;
    } else if (a.startsWith("--libs=")) {
      const v = a.slice("--libs=".length);
      if (v !== "embed" && v !== "cdn") {
        return die(`unsupported --libs: ${v} (supported: embed, cdn)`);
      }
      libs = v;
      libsSet = true;
    } else if (a.startsWith("-")) return die(`unknown flag for graph: ${a}`);
    else if (target !== "") return die(`too many arguments: ${a}`);
    else target = a;
  }
  if (target === "") target = ".";

  let isDir: boolean;
  try {
    isDir = Deno.statSync(target).isDirectory;
  } catch {
    return die(`path not found: ${target}`);
  }

  // A directory or deep expansion is a model-shaped output (json/html), never dot.
  // Default the format to json when unset; reject it only when dot was asked for.
  if (!formatSet && (isDir || recursive)) format = "json";
  if (format !== "dot" && format !== "json" && format !== "html") {
    return die(`unsupported format: ${format} (supported: dot, json, html)`);
  }
  if (format === "dot" && (isDir || recursive)) {
    return die(
      "the dot format renders a single spec at one level; use --format=json or --format=html for a directory or --recursive",
    );
  }
  if (libsSet && format !== "html") {
    return die("--libs only applies to --format=html");
  }

  // json and html share the yamlet.graph/v1 model; only the serialization differs.
  if (format === "json" || format === "html") {
    let model: GraphModel | ForestModel;
    if (isDir) {
      model = forestModel(target, { recursive: true });
    } else {
      const spec = loadSpec(target);
      if (!spec.ok) return spec.res;
      const composite = resolveComposite(target, spec.text, spec.records);
      model = graphModel(target, metaOf(spec.records), composite, spec.records, { recursive });
    }
    if (format === "json") return json(model);
    return {
      exitCode: 0,
      stdout: renderViewerHtml(JSON.stringify(model), titleOf(model), libs),
      stderr: "",
    };
  }

  // dot: a single spec at one level (directory/recursive already rejected above).
  const spec = loadSpec(target);
  if (!spec.ok) return spec.res;
  const meta = metaOf(spec.records);
  const composite = resolveComposite(target, spec.text, spec.records);
  const dot = composite.isComposite ? dotComposite(meta, composite, spec.records) : dotLeaf(meta);
  return { exitCode: 0, stdout: dot, stderr: "" };
}

export const graphCommand: Command = {
  name: "graph",
  summary: "emit a DOT, JSON, or HTML graph model of a spec or a directory",
  help: `yamlet graph — emit a graph model of one spec or a whole directory

Usage:
  yamlet graph [FILE|DIR] [--format=dot|json|html] [--libs=embed|cdn] [--recursive]

Arguments:
  FILE|DIR                a spec file or a directory of specs (default: .)

Options:
  --format=dot|json|html  dot:  Graphviz for one spec, one level (pipe to \`dot -Tsvg\`)
                          json: the yamlet.graph/v1 model (renderer-agnostic)
                          html: a self-contained interactive viewer of that model
  --libs=embed|cdn        html only — how the layout engine (elkjs) is delivered:
                          embed (default): inline it, one offline file, no network
                          cdn: reference a pinned, SRI-guarded elk from jsDelivr —
                               a small file, but needs network and that the origin
                               is allowed (a strict CSP/artifact sandbox blocks it)
  --recursive, -r         expand composite members deeply

A directory or --recursive implies a model format (json/html) and expands the whole
tree. --format=dot with a directory or --recursive is an error: DOT renders a single
spec at one level. --libs is meaningful only with --format=html.

The html viewer navigates by system: each level shows every scope that shares a
system: slug (the wired one, marked, plus its sibling variants). Click a member to
drill into its system, the breadcrumb to climb back. Pass -r so composite scopes
reached through wiring show their internals rather than an opaque card.
`,
  run: runGraph,
};
