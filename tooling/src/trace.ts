// `yamlet trace` — the traceability model of a directory: every spec's
// requirements and acceptance criteria, the verdicts and tasks a tech spec
// (`*.techspec.yaml`) records against them, and the decision records
// (`*.adr.yaml`) that decide them — written as a `yamlet.trace/v1` JSON document
// (`--format=json`) or a self-contained interactive page (`--format=html`, the
// default; assembled by `viewer/html.ts`).
//
// `yamlet graph` answers "how is this wired?"; this answers "what is decided,
// what is done, and what is left?" — a different graph with different edges:
//
//   has           spec → RQ → AC, ADR → R-n
//   decided_by    RQ/AC → ADR          (the spec's `adrs:` links)
//   arises_from   ADR → RQ/AC          (the ADR's `arises_from`)
//   assumes       ADR → ADR
//   superseded_by ADR → ADR
//   cites         ADR → R-n            (an `ADR-nnnn#R-n` quoted in a force)
//   covers        task → AC | R-n      (the tech spec's `covers`)
//   depends_on    task → task
//
// Discovery. Specs, tech specs and ADRs are found by walking DIR. A tech spec
// names its specs, not the reverse, so pairing is by the specs its `specs:`
// paths resolve to; two tech specs naming one spec are ambiguous for that spec
// and neither is used for it unless `--techspec=FILE` pins one (it may live
// outside DIR — tech specs are disposable). References are followed wherever they lead: an ADR linked from a
// spec, assumed, superseding or superseded is read even outside DIR, as is a spec
// an ADR arises from.
//
// Parse, never validate. A file that does not parse is listed in `skipped[]`; a
// reference that does not resolve becomes a node marked `missing: true`. The page
// is a diagnostic view — `yamlet verify` stays the judge of validity.
//
// Like `graph`, the payload goes to `--out=FILE` (required) and stdout gets one
// summary line. Exit codes: 0 ok · 2 usage/path/write error.

import type { CmdResult, Command } from "./types.ts";
import { flatten } from "./flatten.ts";
import { blocksOf } from "./blocks.ts";
import { listUnder, recordAt } from "./records.ts";
import { listFiles, listSpecs } from "./systems.ts";
import { canonPath, metaOf, writePayload } from "./graph.ts";
import { type Adr, listAdrs, loadAdr, OBLIGATION_RE, SPEC_REF_RE } from "./adr.ts";
import {
  criteriaInScope,
  CRITERION_REF_RE,
  indexSpec,
  parseTechspec,
  type SpecIndex,
  specPathOf,
  type Techspec,
  type TsSpec,
} from "./techspec.ts";
import { type Libs, renderTraceHtml } from "./viewer/html.ts";

const die = (msg: string): CmdResult => ({ exitCode: 2, stdout: "", stderr: `error: ${msg}\n` });

const OBLIGATION_CITE = /\b(ADR-[0-9]{4})#(R-[0-9]+)\b/g;
/** `--out` must never name a yamlet source file: a trace would overwrite it. */
const SOURCE_PATH_RE = /\.(yamlet|techspec|adr)\.ya?ml$/i;

// ── JSON model (`yamlet.trace/v1`) ────────────────────────────────────────
//
// A flat node/edge list plus a per-spec rollup. Node ids are stable strings:
//   spec:<file>   spec:<file>#RQ-n   spec:<file>#AC-n
//   adr:<file>    adr:<file>#R-n     task:<techspec file>#T-n
// A reference that resolves to nothing gets an id of the same shape (for an ADR
// named only by id: `adr:<dir>/ADR-nnnn`) and `missing: true`.

export type Verdict = "met" | "unmet" | "unrecorded";

interface NodeBase {
  id: string;
  /** Present (and true) when a reference named this node but it could not be read. */
  missing?: true;
}
export interface SpecNode extends NodeBase {
  type: "spec";
  file: string;
  system: string;
  topic: string;
  name: string;
  intent: string;
  /** The tech spec paired with this spec, or null when there is none (or it is ambiguous). */
  techspec: string | null;
  /** The recorded analysis commit of that tech spec, "" when none. */
  commit: string;
  /** True when the spec lies outside DIR and was reached only by a reference. */
  outside?: true;
}
export interface RequirementNode extends NodeBase {
  type: "requirement";
  spec: string;
  rq: string;
  description: string;
}
export interface CriterionNode extends NodeBase {
  type: "criterion";
  spec: string;
  rq: string;
  ac: string;
  pattern: string;
  where: string;
  whiles: string[];
  when: string;
  if: string;
  shalls: string[];
  /** null when the spec has no tech spec; otherwise what the tech spec records. */
  verdict: Verdict | null;
  evidence: string[];
  note: string;
  /** Present (and true) when the spec's tech spec scopes this criterion out. */
  outOfScope?: true;
}
export interface AdrNode extends NodeBase {
  type: "adr";
  file: string;
  adr: string;
  title: string;
  adrStatus: string;
  kind: string;
  date: string;
  question: string;
  forces: string[];
  options: { id: string; summary: string; reversibility: string }[];
  decision: string;
  accepts: string[];
  revisit: string[];
}
export interface ObligationNode extends NodeBase {
  type: "obligation";
  adrNode: string;
  /** `ADR-nnnn#R-n`, as a task's `covers:` names it. */
  ref: string;
  must: string;
  /** null when no tech spec records a verdict on it. */
  verdict: Verdict | null;
  evidence: string[];
  note: string;
}
export interface TaskNode extends NodeBase {
  type: "task";
  techspec: string;
  /**
   * The paired spec nodes whose criteria it covers; every spec its tech spec pairs with when it
   * covers no criterion; none when it covers only criteria of specs the tech spec lost.
   */
  specs: string[];
  task: string;
  title: string;
  why: string;
}
export type TraceNode =
  | SpecNode
  | RequirementNode
  | CriterionNode
  | AdrNode
  | ObligationNode
  | TaskNode;

export type EdgeKind =
  | "has"
  | "decided_by"
  | "arises_from"
  | "assumes"
  | "superseded_by"
  | "cites"
  | "covers"
  | "depends_on";

export interface TraceEdge {
  kind: EdgeKind;
  from: string;
  to: string;
}

/** The per-spec rollup — computed here so the page and the JSON cannot disagree. */
export interface SpecRollup {
  node: string;
  file: string;
  system: string;
  topic: string;
  techspec: string | null;
  /** Why no tech spec is paired, when one was found but not used. */
  techspecIssue?: string;
  /**
   * Verdict counts over the criteria in scope (`total`); `outOfScope` counts the rest. Without a
   * tech spec nothing is recorded, so every criterion is `unrecorded`.
   */
  criteria: { met: number; unmet: number; unrecorded: number; total: number; outOfScope: number };
  tasks: number;
  /** ADR node ids linked from this spec (on any requirement or criterion). */
  adrs: string[];
  /** Unmet criteria no task covers (only with a tech spec). */
  uncovered: string[];
  /** Obligations of accepted ADRs in scope neither met nor covered by a task (only with a tech spec). */
  openObligations: string[];
}

export interface TraceModel {
  format: "yamlet.trace/v1";
  kind: "trace";
  root: string;
  /** The traced directory's own name — `root` may be `.`. */
  name: string;
  specs: SpecRollup[];
  nodes: TraceNode[];
  edges: TraceEdge[];
  skipped: { file: string; reason: string }[];
}

// ── paths ──

function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

/** `rel` against `dir`, with `.` and `..` segments collapsed (display form, not canonical). */
function joinNorm(dir: string, rel: string): string {
  const raw = rel.startsWith("/") ? rel : dir === "" || dir === "." ? rel : `${dir}/${rel}`;
  const abs = raw.startsWith("/");
  const out: string[] = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return (abs ? "/" : "") + out.join("/");
}

function exists(p: string): boolean {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
}

// ── the builder ──

interface SpecCtx {
  node: SpecNode;
  path: string;
  index: SpecIndex | null;
  techspec: { path: string; ts: Techspec; entry: TsSpec } | null;
  techspecIssue?: string;
}
interface AdrCtx {
  node: AdrNode;
  path: string;
  dir: string;
  adr: Adr;
}

class Builder {
  nodes = new Map<string, TraceNode>();
  edges: TraceEdge[] = [];
  private edgeKeys = new Set<string>();
  skipped: { file: string; reason: string }[] = [];

  /** canonical path → spec, for every spec read (or found missing). */
  specs = new Map<string, SpecCtx>();
  missingSpecs = new Map<string, SpecNode>();
  /** canonical path → ADR. */
  adrs = new Map<string, AdrCtx>();
  /** `<canonical dir>|ADR-nnnn` → ADR node id. */
  private adrByDirId = new Map<string, string>();
  /** canonical paths that could not be read or parsed — reported once in `skipped`. */
  private failed = new Set<string>();
  private pendingSpecs: SpecCtx[] = [];
  private pendingAdrs: AdrCtx[] = [];

  node<T extends TraceNode>(n: T): T {
    const cur = this.nodes.get(n.id);
    if (cur) return cur as T;
    this.nodes.set(n.id, n);
    return n;
  }

  edge(kind: EdgeKind, from: string, to: string): void {
    const key = `${kind}|${from}|${to}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({ kind, from, to });
  }

  private fail(canon: string, file: string, reason: string): null {
    this.failed.add(canon);
    this.skipped.push({ file, reason });
    return null;
  }

  // ── specs ──

  /** Read a spec into nodes. Returns null (and records why) when it cannot be read. */
  loadSpec(path: string, outside: boolean): SpecCtx | null {
    const canon = canonPath(path);
    const known = this.specs.get(canon);
    if (known) return known;
    if (this.failed.has(canon)) return null;
    let text: string;
    try {
      text = Deno.readTextFileSync(path);
    } catch {
      return this.fail(canon, path, "unreadable");
    }
    const { records, parseErrors } = flatten(text);
    if (parseErrors.length > 0) return this.fail(canon, path, "parse error (run `yamlet verify`)");
    const meta = metaOf(records);
    const id = `spec:${path}`;
    const node = this.node<SpecNode>({
      id,
      type: "spec",
      file: path,
      system: meta.system,
      topic: meta.topic,
      name: meta.name,
      intent: meta.intent,
      techspec: null,
      commit: "",
    });
    if (outside) node.outside = true;
    const val = (p: string): string => recordAt(records, p)?.value ?? "";
    for (const b of blocksOf(text)) {
      if (b.id === "") continue;
      if (b.kind === "requirement") {
        this.node<RequirementNode>({
          id: `${id}#${b.id}`,
          type: "requirement",
          spec: id,
          rq: b.id,
          description: val(`${b.path}.description`),
        });
        this.edge("has", id, `${id}#${b.id}`);
      } else {
        this.node<CriterionNode>({
          id: `${id}#${b.id}`,
          type: "criterion",
          spec: id,
          rq: b.parentId,
          ac: b.id,
          pattern: val(`${b.path}.pattern`),
          where: val(`${b.path}.where`),
          whiles: listUnder(records, `${b.path}.while`),
          when: val(`${b.path}.when`),
          if: val(`${b.path}.if`),
          shalls: listUnder(records, `${b.path}.shall`),
          verdict: null,
          evidence: [],
          note: "",
        });
        this.edge("has", `${id}#${b.parentId}`, `${id}#${b.id}`);
      }
    }
    const ctx: SpecCtx = { node, path, index: indexSpec(text), techspec: null };
    this.specs.set(canon, ctx);
    this.pendingSpecs.push(ctx);
    return ctx;
  }

  /** The spec node id for a path: read it when it exists, else a missing node. */
  specRef(path: string): string {
    const ctx = this.specs.get(canonPath(path)) ??
      (exists(path) ? this.loadSpec(path, true) : null);
    if (ctx) return ctx.node.id;
    const id = `spec:${path}`;
    const known = this.missingSpecs.get(id);
    if (known) return known.id;
    const n = this.node<SpecNode>({
      id,
      type: "spec",
      missing: true,
      file: path,
      system: "",
      topic: "",
      name: "",
      intent: "",
      techspec: null,
      commit: "",
    });
    this.missingSpecs.set(id, n);
    return id;
  }

  /** A requirement or criterion of a spec, missing when the spec lacks it. */
  blockRef(specId: string, block: string): string {
    const id = `${specId}#${block}`;
    if (this.nodes.has(id)) return id;
    if (block.startsWith("RQ-")) {
      this.node<RequirementNode>({
        id,
        type: "requirement",
        missing: true,
        spec: specId,
        rq: block,
        description: "",
      });
    } else {
      this.node<CriterionNode>({
        id,
        type: "criterion",
        missing: true,
        spec: specId,
        rq: "",
        ac: block,
        pattern: "",
        where: "",
        whiles: [],
        when: "",
        if: "",
        shalls: [],
        verdict: null,
        evidence: [],
        note: "",
      });
    }
    return id;
  }

  // ── ADRs ──

  /** Read an ADR into nodes. Returns null (and records why) when it cannot be read. */
  loadAdrFile(path: string): AdrCtx | null {
    const canon = canonPath(path);
    const known = this.adrs.get(canon);
    if (known) return known;
    if (this.failed.has(canon) || !exists(path)) return null;
    const loaded = loadAdr(path);
    if (loaded === null) return this.fail(canon, path, "parse error (run `yamlet verify`)");
    const a = loaded.adr;
    const id = `adr:${path}`;
    const node = this.node<AdrNode>({
      id,
      type: "adr",
      file: path,
      adr: a.id,
      title: a.title,
      adrStatus: a.status,
      kind: a.kind,
      date: a.date,
      question: a.question,
      forces: a.forces,
      options: a.options.map((o) => ({
        id: o.id,
        summary: o.summary,
        reversibility: o.reversibility,
      })),
      decision: a.decision,
      accepts: a.accepts,
      revisit: a.revisit,
    });
    for (const r of a.requires) {
      this.node<ObligationNode>({
        id: `${id}#${r.id}`,
        type: "obligation",
        adrNode: id,
        ref: `${a.id}#${r.id}`,
        must: r.must,
        verdict: null,
        evidence: [],
        note: "",
      });
      this.edge("has", id, `${id}#${r.id}`);
    }
    const dir = dirname(path);
    const ctx: AdrCtx = { node, path, dir, adr: a };
    this.adrs.set(canon, ctx);
    if (a.id !== "") {
      const key = `${canonPath(dir === "" ? "." : dir)}|${a.id}`;
      if (!this.adrByDirId.has(key)) this.adrByDirId.set(key, id);
    }
    this.pendingAdrs.push(ctx);
    return ctx;
  }

  /** The ADR node for a linked path: read it when it can be, else a missing node. */
  adrRefByPath(path: string): string {
    const ctx = this.loadAdrFile(path);
    if (ctx) return ctx.node.id;
    return this.missingAdr(`adr:${path}`, path, "");
  }

  /** The ADR declaring `adrId` in `dir` (the folder is the namespace), else a missing node. */
  adrRefById(dir: string, adrId: string): string {
    const key = `${canonPath(dir === "" ? "." : dir)}|${adrId}`;
    const known = this.adrByDirId.get(key);
    if (known) return known;
    for (const l of listAdrs(dir)) {
      if (l.adr.id !== adrId) continue;
      const ctx = this.loadAdrFile(l.path);
      if (ctx) return ctx.node.id;
    }
    const id = `adr:${joinNorm(dir, adrId)}`;
    this.adrByDirId.set(key, id);
    return this.missingAdr(id, "", adrId);
  }

  private missingAdr(id: string, file: string, adrId: string): string {
    this.node<AdrNode>({
      id,
      type: "adr",
      missing: true,
      file,
      adr: adrId,
      title: "",
      adrStatus: "",
      kind: "",
      date: "",
      question: "",
      forces: [],
      options: [],
      decision: "",
      accepts: [],
      revisit: [],
    });
    return id;
  }

  /** An obligation `R-n` of an ADR node, missing when the ADR does not declare it. */
  obligationRef(adrNodeId: string, rid: string): string {
    const id = `${adrNodeId}#${rid}`;
    if (this.nodes.has(id)) return id;
    const a = this.nodes.get(adrNodeId) as AdrNode | undefined;
    this.node<ObligationNode>({
      id,
      type: "obligation",
      missing: true,
      adrNode: adrNodeId,
      ref: `${a?.adr || "ADR-?"}#${rid}`,
      must: "",
      verdict: null,
      evidence: [],
      note: "",
    });
    this.edge("has", adrNodeId, id);
    return id;
  }

  // ── following references ──

  /** Process every spec and ADR read so far — and whatever they reach — until none is left. */
  drain(): void {
    while (this.pendingSpecs.length > 0 || this.pendingAdrs.length > 0) {
      const s = this.pendingSpecs.shift();
      if (s) this.linkSpec(s);
      const a = this.pendingAdrs.shift();
      if (a) this.linkAdr(a);
    }
  }

  private linkSpec(s: SpecCtx): void {
    if (!s.index) return;
    const dir = dirname(s.path);
    for (const [block, links] of s.index.adrsOf) {
      for (const link of links) {
        this.edge("decided_by", `${s.node.id}#${block}`, this.adrRefByPath(joinNorm(dir, link)));
      }
    }
  }

  private linkAdr(a: AdrCtx): void {
    const id = a.node.id;
    for (const ref of a.adr.arisesFrom) {
      const m = ref.match(SPEC_REF_RE);
      if (!m) continue;
      const spec = this.specRef(joinNorm(a.dir, m[1]!));
      this.edge("arises_from", id, this.blockRef(spec, m[2]!));
    }
    for (const other of a.adr.assumes) this.edge("assumes", id, this.adrRefById(a.dir, other));
    if (a.adr.supersededBy !== "") {
      this.edge("superseded_by", id, this.adrRefById(a.dir, a.adr.supersededBy));
    }
    for (const force of a.adr.forces) {
      for (const m of force.matchAll(OBLIGATION_CITE)) {
        const target = m[1] === a.adr.id ? id : this.adrRefById(a.dir, m[1]!);
        this.edge("cites", id, this.obligationRef(target, m[2]!));
      }
    }
  }

  // ── tech specs ──

  /**
   * Apply a tech spec to the specs it is paired with: verdicts on criteria and
   * obligations, tasks and their edges. `paired` is never empty.
   */
  applyTechspec(t: { path: string; ts: Techspec }, paired: SpecCtx[]): void {
    const verdictOf = (met: string): Verdict =>
      met === "true" ? "met" : met === "false" ? "unmet" : "unrecorded";
    // `specs[].path` → spec node id, for the specs this tech spec is paired with only: a spec it
    // lists but lost (ambiguous, or not found) is not its to draw verdicts, covers or tasks on.
    const specIdOf = new Map<string, string>();
    for (const s of paired) specIdOf.set(s.techspec!.entry.path, s.node.id);

    for (const s of paired) {
      const entry = s.techspec!.entry;
      s.node.techspec = t.path;
      s.node.commit = t.ts.analysis?.commit ?? "";
      const specId = s.node.id;
      // Every criterion in scope starts unrecorded; the tech spec says otherwise.
      const inScope = s.index ? criteriaInScope(s.index, entry.scope) : [];
      for (const acId of s.index?.criteria ?? []) {
        const n = this.nodes.get(`${specId}#${acId}`) as CriterionNode | undefined;
        if (!n) continue;
        if (inScope.includes(acId)) n.verdict = "unrecorded";
        else n.outOfScope = true;
      }
      for (const rq of entry.requirements) {
        for (const c of rq.criteria) {
          if (c.id === "") continue;
          const n = this.nodes.get(this.blockRef(specId, c.id)) as CriterionNode;
          n.verdict = verdictOf(c.met);
          n.evidence = c.evidence;
          n.note = c.note;
        }
      }
    }

    const target = (cover: string): string | null => {
      const o = cover.match(OBLIGATION_RE);
      if (o) return this.obligationRef(this.obligationAdr(paired, t.path, o[1]!), o[2]!);
      const c = cover.match(CRITERION_REF_RE);
      const specId = c ? specIdOf.get(c[1]!) : undefined;
      return c && specId ? this.blockRef(specId, c[2]!) : null;
    };

    for (const o of t.ts.obligations) {
      const id = o.id === "" ? null : target(o.id);
      if (!id) continue;
      const n = this.nodes.get(id) as ObligationNode;
      n.verdict = verdictOf(o.met);
      n.evidence = o.evidence;
      n.note = o.note;
    }

    const taskId = (tid: string): string => `task:${t.path}#${tid}`;
    const all = paired.map((s) => s.node.id);
    for (const task of t.ts.tasks) {
      if (task.id === "") continue;
      // The paired specs whose criteria it covers. A task covering criteria only of specs this
      // tech spec is not paired with belongs to none; one covering no criterion, to all of them.
      const specs: string[] = [];
      let coversCriteria = false;
      for (const cover of task.covers) {
        const c = cover.match(CRITERION_REF_RE);
        if (!c) continue;
        coversCriteria = true;
        const specId = specIdOf.get(c[1]!);
        if (specId && !specs.includes(specId)) specs.push(specId);
      }
      this.node<TaskNode>({
        id: taskId(task.id),
        type: "task",
        techspec: t.path,
        specs: coversCriteria ? specs : all,
        task: task.id,
        title: task.title,
        why: task.why,
      });
    }
    for (const task of t.ts.tasks) {
      if (task.id === "") continue;
      for (const cover of task.covers) {
        const to = target(cover);
        if (to) this.edge("covers", taskId(task.id), to);
      }
      for (const dep of task.dependsOn) {
        if (!this.nodes.has(taskId(dep))) {
          this.node<TaskNode>({
            id: taskId(dep),
            type: "task",
            missing: true,
            techspec: t.path,
            specs: all,
            task: dep,
            title: "",
            why: "",
          });
        }
        this.edge("depends_on", taskId(task.id), taskId(dep));
      }
    }
  }

  /**
   * The ADR an `ADR-nnnn#R-n` in a tech spec names: one a paired spec links
   * first (the set the verifier holds a tech spec to, E716), else by id beside
   * a paired spec, else beside the tech spec.
   */
  private obligationAdr(paired: SpecCtx[], techspecPath: string, adrId: string): string {
    for (const s of paired) {
      for (const e of this.edges) {
        if (e.kind !== "decided_by" || !e.from.startsWith(`${s.node.id}#`)) continue;
        const n = this.nodes.get(e.to) as AdrNode | undefined;
        if (n && !n.missing && n.adr === adrId) return n.id;
      }
    }
    const dirs = [...paired.map((s) => dirname(s.path)), dirname(techspecPath)];
    const seen = new Set<string>();
    let first = "";
    for (const d of dirs) {
      const canon = canonPath(d || ".");
      if (seen.has(canon)) continue;
      seen.add(canon);
      const id = this.adrRefById(d, adrId);
      if (first === "") first = id;
      if (!(this.nodes.get(id) as AdrNode).missing) return id;
    }
    return first;
  }

  // ── rollup ──

  rollup(): SpecRollup[] {
    const out: SpecRollup[] = [];
    const coveredBy = new Map<string, Set<string>>(); // target → task ids
    for (const e of this.edges) {
      if (e.kind !== "covers") continue;
      const set = coveredBy.get(e.to) ?? new Set<string>();
      set.add(e.from);
      coveredBy.set(e.to, set);
    }
    const tasksWhere = (keep: (n: TaskNode) => boolean): Set<string> => {
      const ids = new Set<string>();
      for (const n of this.nodes.values()) {
        if (n.type === "task" && !n.missing && keep(n)) ids.add(n.id);
      }
      return ids;
    };
    const coveredWithin = (target: string, tasks: Set<string>): boolean =>
      [...(coveredBy.get(target) ?? [])].some((t) => tasks.has(t));

    for (const s of this.specs.values()) {
      const specId = s.node.id;
      const criteria = { met: 0, unmet: 0, unrecorded: 0, total: 0, outOfScope: 0 };
      const uncovered: string[] = [];
      const tasks = tasksWhere((n) => n.specs.includes(specId));
      const planTasks = s.techspec
        ? tasksWhere((n) => n.techspec === s.techspec!.path)
        : new Set<string>();
      for (const acId of s.index?.criteria ?? []) {
        const n = this.nodes.get(`${specId}#${acId}`) as CriterionNode | undefined;
        if (!n) continue;
        if (n.outOfScope) {
          criteria.outOfScope++;
          continue;
        }
        criteria.total++;
        if (n.verdict === "met") criteria.met++;
        else if (n.verdict === "unmet") {
          criteria.unmet++;
          if (!coveredWithin(n.id, planTasks)) uncovered.push(n.id);
        } else criteria.unrecorded++;
      }

      const adrs: string[] = [];
      for (const e of this.edges) {
        if (e.kind === "decided_by" && e.from.startsWith(`${specId}#`) && !adrs.includes(e.to)) {
          adrs.push(e.to);
        }
      }
      const openObligations: string[] = [];
      if (s.techspec && s.index) {
        // The records in scope: every link with no scope, else those deciding a scoped criterion.
        const scope = s.techspec.entry.scope;
        const blocks = new Set<string>();
        for (const ac of criteriaInScope(s.index, scope)) {
          blocks.add(`${specId}#${ac}`);
          const owner = s.index.ownerOf.get(ac);
          if (owner) blocks.add(`${specId}#${owner}`);
        }
        const inScope: string[] = [];
        for (const e of this.edges) {
          if (e.kind !== "decided_by" || inScope.includes(e.to)) continue;
          if (scope.length === 0 ? e.from.startsWith(`${specId}#`) : blocks.has(e.from)) {
            inScope.push(e.to);
          }
        }
        for (const a of inScope) {
          const n = this.nodes.get(a) as AdrNode;
          if (n.missing || n.adrStatus !== "accepted") continue;
          for (const e of this.edges) {
            if (e.kind !== "has" || e.from !== a) continue;
            const o = this.nodes.get(e.to) as ObligationNode | undefined;
            // A missing R-n was only cited, never declared: nothing is owed to it.
            if (!o || o.missing || o.verdict === "met") continue;
            if (!coveredWithin(e.to, planTasks)) openObligations.push(e.to);
          }
        }
      }

      const r: SpecRollup = {
        node: specId,
        file: s.path,
        system: s.node.system,
        topic: s.node.topic,
        techspec: s.node.techspec,
        criteria,
        tasks: tasks.size,
        adrs,
        uncovered,
        openObligations,
      };
      if (s.techspecIssue) r.techspecIssue = s.techspecIssue;
      out.push(r);
    }
    return out;
  }
}

// ── building the model ──

interface ReadTechspec {
  path: string;
  ts: Techspec;
  /** Each `specs[]` entry with the spec path it resolves to. */
  entries: { entry: TsSpec; specPath: string }[];
}

function readTechspec(path: string): ReadTechspec | string {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return "unreadable";
  }
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) return "parse error (run `yamlet verify`)";
  const ts = parseTechspec(records);
  const entries = ts.specs
    .filter((e) => e.path !== "")
    .map((entry) => ({ entry, specPath: joinNorm("", specPathOf(path, entry.path)) }));
  if (entries.length === 0) return "names no spec";
  return { path, ts, entries };
}

/**
 * Build the `yamlet.trace/v1` model of `root`. `pinned` are `--techspec` files:
 * each is paired with its specs ahead of discovery. Returns an error message
 * when a pinned tech spec cannot be used — it was asked for by name, so it is
 * not quietly skipped.
 */
export function traceModel(root: string, pinned: string[] = []): TraceModel | string {
  const b = new Builder();
  for (const f of listSpecs(root)) b.loadSpec(f, false);
  for (const f of listFiles(root, ".adr.yaml")) b.loadAdrFile(f);
  const loadSpecAt = (p: string): SpecCtx | null =>
    b.specs.get(canonPath(p)) ?? (exists(p) ? b.loadSpec(p, true) : null);

  /** tech spec path → the tech spec and the specs it ends up paired with. */
  const active = new Map<string, { t: ReadTechspec; paired: SpecCtx[] }>();
  const pair = (t: ReadTechspec, entry: TsSpec, spec: SpecCtx): void => {
    spec.techspec = { path: t.path, ts: t.ts, entry };
    const a = active.get(t.path) ?? { t, paired: [] };
    a.paired.push(spec);
    active.set(t.path, a);
  };

  // Pinned tech specs first: they win over whatever discovery finds.
  const pinnedSpecs = new Set<string>();
  const pinnedFiles = new Set<string>();
  for (const p of pinned) {
    const t = readTechspec(p);
    if (typeof t === "string") return `--techspec ${p}: ${t}`;
    for (const { entry, specPath } of t.entries) {
      const spec = loadSpecAt(specPath);
      if (!spec) return `--techspec ${p}: its spec ${specPath} was not found or does not parse`;
      const canon = canonPath(specPath);
      if (pinnedSpecs.has(canon)) {
        return `--techspec ${p}: another --techspec already names ${specPath}`;
      }
      pinnedSpecs.add(canon);
      pair(t, entry, spec);
    }
    pinnedFiles.add(canonPath(p));
  }

  // Discovery: group every other tech spec's entries by the spec each names.
  const bySpec = new Map<string, { t: ReadTechspec; entry: TsSpec; specPath: string }[]>();
  for (const f of listFiles(root, ".techspec.yaml")) {
    if (pinnedFiles.has(canonPath(f))) continue;
    const t = readTechspec(f);
    if (typeof t === "string") {
      b.skipped.push({ file: f, reason: t });
      continue;
    }
    for (const { entry, specPath } of t.entries) {
      const canon = canonPath(specPath);
      if (pinnedSpecs.has(canon)) {
        b.skipped.push({ file: f, reason: `${specPath} is paired by --techspec` });
        continue;
      }
      if (!loadSpecAt(specPath)) {
        b.skipped.push({ file: f, reason: `spec not found: ${specPath}` });
        continue;
      }
      const list = bySpec.get(canon) ?? [];
      list.push({ t, entry, specPath });
      bySpec.set(canon, list);
    }
  }
  for (const [canon, list] of bySpec) {
    const spec = b.specs.get(canon)!;
    if (list.length === 1) {
      pair(list[0]!.t, list[0]!.entry, spec);
      continue;
    }
    spec.techspecIssue =
      `ambiguous — ${list.length} tech specs name this spec; pin one with --techspec`;
    for (const x of list) {
      b.skipped.push({
        file: x.t.path,
        reason: `ambiguous: ${list.length} tech specs name ${x.specPath}`,
      });
    }
  }

  b.drain(); // links first: a task's ADR obligation resolves against the specs' links
  for (const { t, paired } of active.values()) b.applyTechspec(t, paired);
  b.drain(); // obligations may have reached ADRs not read yet

  return {
    format: "yamlet.trace/v1",
    kind: "trace",
    root,
    name: titleOf(root),
    specs: b.rollup(),
    nodes: [...b.nodes.values()],
    edges: b.edges,
    skipped: b.skipped,
  };
}

/** The summary line's counts: what was traced, without printing it. */
function summaryParts(m: TraceModel): string[] {
  const count = (t: TraceNode["type"]): number =>
    m.nodes.filter((n) => n.type === t && !n.missing).length;
  const specs = m.specs.length;
  // One tech spec may pair with several specs; count the files.
  const techspecs = new Set(m.specs.map((s) => s.techspec).filter((t) => t !== null)).size;
  // Only a spec with a tech spec has verdicts; the rest would dilute the ratio.
  const judged = m.specs.filter((s) => s.techspec !== null);
  const met = judged.reduce((a, s) => a + s.criteria.met, 0);
  const total = judged.reduce((a, s) => a + s.criteria.total, 0);
  const parts = [
    `${specs} spec${specs === 1 ? "" : "s"}`,
    `${techspecs} tech spec${techspecs === 1 ? "" : "s"}`,
    `${count("adr")} ADR${count("adr") === 1 ? "" : "s"}`,
    `${count("task")} task${count("task") === 1 ? "" : "s"}`,
    `${met}/${total} criteria met`,
  ];
  if (m.skipped.length > 0) parts.push(`${m.skipped.length} skipped`);
  return parts;
}

/** The page title: the traced directory's name. */
function titleOf(root: string): string {
  const abs = canonPath(root);
  return abs.split("/").filter((s) => s !== "").pop() || root;
}

export function runTrace(args: string[]): CmdResult {
  let target = "";
  let out = "";
  let format = "html";
  let libs: Libs = "cdn";
  let libsSet = false;
  const pinned: string[] = [];
  for (const a of args) {
    if (a.startsWith("--out=")) out = a.slice("--out=".length);
    else if (a.startsWith("--format=")) format = a.slice("--format=".length);
    else if (a.startsWith("--techspec=")) pinned.push(a.slice("--techspec=".length));
    else if (a.startsWith("--libs=")) {
      const v = a.slice("--libs=".length);
      if (v !== "embed" && v !== "cdn") {
        return die(`unsupported --libs: ${v} (supported: embed, cdn)`);
      }
      libs = v;
      libsSet = true;
    } else if (a.startsWith("-")) return die(`unknown flag for trace: ${a}`);
    else if (target !== "") return die(`too many arguments: ${a}`);
    else target = a;
  }
  if (target === "") target = ".";

  if (out === "") {
    return die(
      "trace requires --out=FILE — the model is written to a file, never to stdout.\n" +
        `  try: yamlet trace ${target} --out=trace.html`,
    );
  }
  if (SOURCE_PATH_RE.test(out)) {
    return die(`--out must not name a yamlet source file: ${out} would be overwritten`);
  }
  if (format !== "json" && format !== "html") {
    return die(`unsupported format: ${format} (supported: html, json)`);
  }
  if (libsSet && format !== "html") return die("--libs only applies to --format=html");

  let isDir: boolean;
  try {
    isDir = Deno.statSync(target).isDirectory;
  } catch {
    return die(`path not found: ${target}`);
  }
  if (!isDir) {
    return die(
      `trace takes a directory, not a file: ${target}\n` +
        "  (for one spec's wiring use `yamlet graph`)",
    );
  }
  for (const p of pinned) {
    if (!p.endsWith(".techspec.yaml")) return die(`--techspec must name a *.techspec.yaml: ${p}`);
  }

  const model = traceModel(target, pinned);
  if (typeof model === "string") return die(model);
  const json = JSON.stringify(model, null, format === "json" ? 2 : undefined);
  const payload = format === "json" ? json + "\n" : renderTraceHtml(json, model.name, libs);
  return writePayload(out, payload, format, summaryParts(model));
}

export const traceCommand: Command = {
  name: "trace",
  summary: "write a traceability model (specs → criteria → ADRs → tasks) of a directory",
  help: `yamlet trace — write the traceability model of a directory to a file

Usage:
  yamlet trace [DIR] --out=FILE [--format=html|json] [--libs=cdn|embed] [--techspec=FILE ...]

Arguments:
  DIR                     a directory holding specs, tech specs and ADRs (default: .)

Options:
  --out=FILE              REQUIRED. Where to write the model. It never goes to stdout;
                          stdout gets one summary line. Refuses a *.yamlet.yaml,
                          *.techspec.yaml or *.adr.yaml path.
  --format=html|json      html (default): an interactive page — an overview of every
                                spec's progress and the decision graph, a drill-down
                                per spec (RQ → AC → ADR/obligation → task) and per ADR
                          json: the yamlet.trace/v1 model (nodes, typed edges, a
                                per-spec rollup)
  --libs=cdn|embed        html only — how the layout engine (elkjs) is delivered, as
                          for \`yamlet graph\`: cdn (default, small, needs network) or
                          embed (~1.6 MB, works offline)
  --techspec=FILE         pair this tech spec with the specs its \`specs:\` names, ahead
                          of discovery. Repeatable. For a tech spec outside DIR, or
                          to settle two that name the same spec.

What it reads. Every *.yamlet.yaml, *.techspec.yaml and *.adr.yaml under DIR, and
whatever they reference, even outside DIR: ADRs a spec links (\`adrs:\`), assumes or
is superseded by, and specs an ADR arises from. A tech spec is paired with every spec
its \`specs:\` paths resolve to; when two name one spec, neither is used for it (both
are listed as skipped) unless --techspec pins one. Criteria a tech spec scopes out
carry no verdict and are counted apart.

It parses, it does not validate: an unparseable file is listed as skipped, and a
reference that resolves to nothing is drawn as a missing node. \`yamlet verify\`
remains the judge of validity.

Examples:
  yamlet trace specs --out=trace.html
  yamlet trace specs --format=json --out=trace.json
  yamlet trace specs --techspec=/tmp/pdf.techspec.yaml --out=trace.html
`,
  run: runTrace,
};
