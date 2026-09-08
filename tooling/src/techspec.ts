// The tech spec (`*.techspec.yaml`) — one spec's gap analysis and task list.
//
// A tech spec is *derived* from a finished spec and the code that is supposed
// to implement it: for every acceptance criterion a verdict (`met: true|false`,
// with the evidence that backs it), and a task list that covers every unmet
// criterion. It is deliberately short-lived — generated when work is planned,
// consumed while it is done, discarded after; the spec and its ADRs are what
// persist. Nothing in it is a source of truth, which is why it carries no ids of
// its own except `T-N` for tasks, and why every requirement/criterion id in it
// must resolve to the spec it names.
//
// This module owns the *format*: the model, the reader over flattened records,
// the canonical serializer, and the E7xx rules. The mutating commands live in
// `techspec_author.ts`; `verify.ts` dispatches here by file extension.
//
// The one value the file adds over the agent's prose is that it can be checked:
// every criterion has exactly one verdict, `met: true` is backed by evidence,
// every unmet criterion is covered by a task, and the dependency graph resolves
// and is acyclic. An agent that silently skips a criterion is the failure mode
// the whole file exists to catch (E706/E715).

import type { Finding, FlatRecord, Summary } from "./types.ts";
import { flatten } from "./flatten.ts";
import { blocksOf } from "./blocks.ts";
import { childKeys, indicesUnder, itemsUnder, listUnder, recordAt } from "./records.ts";
import { loadAdr, OBLIGATION_RE } from "./adr.ts";

export const TECHSPEC_EXT = ".techspec.yaml";
export const SPEC_EXT = ".yamlet.yaml";
export const COMMIT_RE = /^[0-9a-f]{7,40}$/;
export const TASK_ID_RE = /^T-[0-9]+$/;

const TOP_REQUIRED = ["spec", "system", "analysis"];
const TOP_ALLOWED = new Set(["spec", "system", "analysis", "requirements", "tasks"]);
const ANALYSIS_KEYS = new Set(["commit", "deep", "skimmed"]);
const RQ_KEYS = new Set(["id", "acceptance-criteria"]);
const AC_KEYS = new Set(["id", "met", "evidence", "note"]);
const TASK_KEYS = new Set(["id", "title", "covers", "depends_on", "why"]);

// ── the model ──

export interface TsCriterion {
  id: string;
  /** Raw value; "" when absent. Valid values are exactly "true" and "false". */
  met: string;
  evidence: string[];
  note: string;
}
export interface TsRequirement {
  id: string;
  criteria: TsCriterion[];
}
export interface TsTask {
  id: string;
  title: string;
  covers: string[];
  dependsOn: string[];
  why: string;
}
export interface TsAnalysis {
  commit: string;
  deep: string[];
  skimmed: string[];
}
export interface Techspec {
  spec: string;
  system: string;
  /** `null` until `techspec analysis` records it. */
  analysis: TsAnalysis | null;
  requirements: TsRequirement[];
  tasks: TsTask[];
}

/** What the tech spec needs to know about its spec: the criteria, in order, and their owners. */
export interface SpecIndex {
  system: string;
  /** Requirement ids in file order. */
  requirements: string[];
  /** Criterion ids in file order. */
  criteria: string[];
  /** criterion id → owning requirement id. */
  ownerOf: Map<string, string>;
  /** block id (RQ-N or AC-N) → its own `adrs:` entries, in file order. */
  adrsOf: Map<string, string[]>;
}

/** What decides a criterion: the records linked on it and on its requirement. */
export interface Decided {
  /** "RQ-N", "itself", or both — where the links sit. */
  via: string[];
  /** The linked records, requirement's first, deduplicated. */
  adrs: string[];
}

/**
 * The decisions a criterion falls under. A requirement-level link decides every
 * criterion beneath it; a criterion-level link decides that one. Empty when
 * nothing is linked.
 */
export function decidedBy(spec: SpecIndex, acId: string): Decided {
  const via: string[] = [];
  const adrs: string[] = [];
  const owner = spec.ownerOf.get(acId) ?? "";
  const add = (label: string, list: string[]): void => {
    if (list.length === 0) return;
    via.push(label);
    for (const a of list) if (!adrs.includes(a)) adrs.push(a);
  };
  if (owner !== "") add(owner, spec.adrsOf.get(owner) ?? []);
  add("itself", spec.adrsOf.get(acId) ?? []);
  return { via, adrs };
}

// ── reading ──

export function parseTechspec(records: readonly FlatRecord[]): Techspec {
  const val = (p: string): string => recordAt(records, p)?.value ?? "";
  const list = (p: string): string[] => itemsUnder(records, p).map((r) => r.value);

  const hasAnalysis = records.some((r) => r.path === "analysis" || r.path.startsWith("analysis."));
  const analysis: TsAnalysis | null = hasAnalysis
    ? {
      commit: val("analysis.commit"),
      deep: list("analysis.deep"),
      skimmed: list("analysis.skimmed"),
    }
    : null;

  const requirements: TsRequirement[] = [];
  for (const i of indicesUnder(records, "requirements")) {
    const rp = `requirements[${i}]`;
    const criteria: TsCriterion[] = [];
    for (const j of indicesUnder(records, `${rp}.acceptance-criteria`)) {
      const ap = `${rp}.acceptance-criteria[${j}]`;
      criteria.push({
        id: val(`${ap}.id`),
        met: val(`${ap}.met`),
        evidence: list(`${ap}.evidence`),
        note: val(`${ap}.note`),
      });
    }
    requirements.push({ id: val(`${rp}.id`), criteria });
  }

  const tasks: TsTask[] = [];
  for (const i of indicesUnder(records, "tasks")) {
    const tp = `tasks[${i}]`;
    tasks.push({
      id: val(`${tp}.id`),
      title: val(`${tp}.title`),
      covers: list(`${tp}.covers`),
      dependsOn: list(`${tp}.depends_on`),
      why: val(`${tp}.why`),
    });
  }

  return { spec: val("spec"), system: val("system"), analysis, requirements, tasks };
}

/**
 * Index a spec's requirements and criteria from its text. Returns null when the
 * spec does not parse — a tech spec cannot be checked against a spec it cannot
 * read, and E703 says so once rather than E706/E707 saying it per criterion.
 */
export function indexSpec(text: string): SpecIndex | null {
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) return null;
  const idx: SpecIndex = {
    system: recordAt(records, "system")?.value ?? "",
    requirements: [],
    criteria: [],
    ownerOf: new Map(),
    adrsOf: new Map(),
  };
  for (const b of blocksOf(text)) {
    if (b.id === "") continue;
    if (b.kind === "requirement") idx.requirements.push(b.id);
    else {
      idx.criteria.push(b.id);
      idx.ownerOf.set(b.id, b.parentId);
    }
    const adrs = listUnder(records, `${b.path}.adrs`);
    if (adrs.length > 0) idx.adrsOf.set(b.id, adrs);
  }
  return idx;
}

function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}

/** A decision record the spec links, with the obligations it places on the work. */
export interface LinkedAdr {
  /** The link as written in the spec (relative to the spec). */
  link: string;
  path: string;
  /** "" when the file could not be read or parsed. */
  id: string;
  status: string;
  /** `ADR-nnnn#R-n` for each obligation. */
  obligations: string[];
}

/**
 * Every record the spec links (on any requirement or criterion), read from
 * disk relative to the spec's directory. An unparseable link is returned with
 * an empty id so the caller can report it once.
 */
export function linkedAdrs(specFile: string, spec: SpecIndex): LinkedAdr[] {
  const dir = dirname(specFile);
  const seen = new Set<string>();
  const out: LinkedAdr[] = [];
  for (const links of spec.adrsOf.values()) {
    for (const link of links) {
      if (seen.has(link)) continue;
      seen.add(link);
      const path = link.startsWith("/") ? link : dir === "" ? link : `${dir}/${link}`;
      const loaded = loadAdr(path);
      if (loaded === null) {
        out.push({ link, path, id: "", status: "", obligations: [] });
        continue;
      }
      out.push({
        link,
        path,
        id: loaded.adr.id,
        status: loaded.adr.status,
        obligations: loaded.adr.requires.map((r) => `${loaded.adr.id}#${r.id}`),
      });
    }
  }
  return out;
}

/** `spec` resolved against the tech spec's own directory. */
export function specPathOf(techspecFile: string, spec: string): string {
  if (spec.startsWith("/")) return spec;
  const dir = dirname(techspecFile);
  return dir === "" ? spec : `${dir}/${spec}`;
}

// ── serializing ──

/** Quote a scalar only when the constrained YAML subset requires it (same rule as the author). */
function q(s: string): string {
  if (s[0] === "{" || s[0] === "[" || s[0] === '"' || s.includes(" #")) return `"${s}"`;
  return s;
}

const taskNum = (id: string): number => Number(id.match(/^T-([0-9]+)$/)?.[1] ?? 0);

/**
 * The canonical text of a tech spec. Requirements and criteria come out in the
 * spec's order (whatever order they were recorded in), tasks by number, and a
 * section that is empty is omitted — an enabler has no `covers:`, an unmet
 * criterion with nothing to point at has no `evidence:`. The whole file is
 * rewritten on every mutation, which is what makes the ordering free.
 */
export function serializeTechspec(ts: Techspec, spec: SpecIndex | null): string {
  const rqPos = (id: string): number => {
    const i = spec?.requirements.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const acPos = (id: string): number => {
    const i = spec?.criteria.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const stable = <T>(xs: T[], key: (x: T) => number): T[] =>
    xs.map((x, i) => ({ x, i })).sort((a, b) => key(a.x) - key(b.x) || a.i - b.i).map((p) => p.x);

  let out = "";
  out += `spec: ${q(ts.spec)}\n`;
  out += `system: ${ts.system}\n`;

  if (ts.analysis !== null) {
    out += "\nanalysis:\n";
    out += `  commit: ${ts.analysis.commit}\n`;
    if (ts.analysis.deep.length > 0) {
      out += "  deep:\n";
      for (const d of ts.analysis.deep) out += `  - ${q(d)}\n`;
    }
    if (ts.analysis.skimmed.length > 0) {
      out += "  skimmed:\n";
      for (const d of ts.analysis.skimmed) out += `  - ${q(d)}\n`;
    }
  }

  if (ts.requirements.length > 0) {
    out += "\nrequirements:\n";
    for (const rq of stable(ts.requirements, (r) => rqPos(r.id))) {
      out += `- id: ${rq.id}\n`;
      out += "  acceptance-criteria:\n";
      for (const ac of stable(rq.criteria, (c) => acPos(c.id))) {
        out += `  - id: ${ac.id}\n`;
        out += `    met: ${ac.met}\n`;
        if (ac.evidence.length > 0) {
          out += "    evidence:\n";
          for (const e of ac.evidence) out += `    - ${q(e)}\n`;
        }
        if (ac.note !== "") out += `    note: ${q(ac.note)}\n`;
      }
    }
  }

  if (ts.tasks.length > 0) {
    out += "\ntasks:\n";
    for (const t of stable(ts.tasks, (x) => taskNum(x.id))) {
      out += `- id: ${t.id}\n`;
      out += `  title: ${q(t.title)}\n`;
      if (t.covers.length > 0) {
        out += "  covers:\n";
        for (const c of t.covers) out += `  - ${c}\n`;
      }
      if (t.why !== "") out += `  why: ${q(t.why)}\n`;
      if (t.dependsOn.length > 0) {
        out += "  depends_on:\n";
        for (const d of t.dependsOn) out += `  - ${d}\n`;
      }
    }
  }
  return out;
}

// ── the rules ──

export interface TechspecValidation {
  findings: Finding[];
  summary: Summary;
  /** The spec's index when it resolved; null under E703. */
  spec: SpecIndex | null;
}

function readSpec(path: string): SpecIndex | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return null;
  }
  return indexSpec(text);
}

/**
 * Apply E701–E715 to a tech spec's records. `file` is needed to resolve `spec`
 * relative to the tech spec's own directory, exactly as a composite resolves
 * its members.
 */
export function validateTechspec(file: string, records: readonly FlatRecord[]): TechspecValidation {
  const findings: Finding[] = [];
  const finding = (rule: string, line: number, path: string, message: string): void => {
    findings.push({ rule, severity: "error", line, path, message });
  };
  const lineOf = (p: string): number => recordAt(records, p)?.line ?? 0;

  // ── E701/E702: top-level keys ──
  const seenTop = new Set(records.map((r) => r.path.replace(/[.[].*$/, "")));
  for (const k of TOP_REQUIRED) {
    if (!seenTop.has(k)) finding("E701", 0, k, `missing required top-level key: ${k}`);
  }
  for (const k of seenTop) {
    if (!TOP_ALLOWED.has(k)) finding("E702", 0, k, `unknown top-level key: ${k}`);
  }

  const ts = parseTechspec(records);

  // ── E703: the spec must resolve and parse ──
  let spec: SpecIndex | null = null;
  if (seenTop.has("spec")) {
    if (ts.spec === "" || !ts.spec.endsWith(SPEC_EXT)) {
      finding("E703", lineOf("spec"), "spec", `spec must name a ${SPEC_EXT} file, got: ${ts.spec}`);
    } else {
      const path = specPathOf(file, ts.spec);
      spec = readSpec(path);
      if (spec === null) {
        finding(
          "E703",
          lineOf("spec"),
          "spec",
          `spec does not resolve to a parseable file: ${path}`,
        );
      }
    }
  }

  // ── E704: system agrees with the spec ──
  if (spec !== null && seenTop.has("system") && ts.system !== spec.system) {
    finding(
      "E704",
      lineOf("system"),
      "system",
      `system is ${ts.system} but the spec says ${spec.system}`,
    );
  }

  // ── E705: analysis ──
  if (ts.analysis !== null) {
    const a = ts.analysis;
    for (const k of childKeys(records, "analysis")) {
      if (!ANALYSIS_KEYS.has(k)) {
        finding(
          "E705",
          lineOf(`analysis.${k}`),
          `analysis.${k}`,
          `unknown key under analysis: ${k}`,
        );
      }
    }
    if (a.commit === "") {
      finding("E705", lineOf("analysis"), "analysis", "analysis.commit is missing");
    } else if (!COMMIT_RE.test(a.commit)) {
      finding(
        "E705",
        lineOf("analysis.commit"),
        "analysis.commit",
        `analysis.commit must be 7–40 hex characters, got: ${a.commit}`,
      );
    }
    const deep = itemsUnder(records, "analysis.deep");
    const skimmed = itemsUnder(records, "analysis.skimmed");
    for (const r of [...deep, ...skimmed]) {
      if (r.value === "") finding("E705", r.line, r.path, "analysis path entry is empty");
    }
    const deepSet = new Set(deep.map((r) => r.value));
    for (const r of skimmed) {
      if (r.value !== "" && deepSet.has(r.value)) {
        finding("E705", r.line, r.path, `path listed as both deep and skimmed: ${r.value}`);
      }
    }
  }

  // ── requirements / criteria: E706–E710 ──
  const recorded = new Map<string, { met: string; line: number; path: string }>();
  let nAc = 0;
  for (const i of indicesUnder(records, "requirements")) {
    const rp = `requirements[${i}]`;
    const rqId = recordAt(records, `${rp}.id`)?.value ?? "";
    const rqLine = lineOf(`${rp}.id`);
    for (const k of childKeys(records, rp)) {
      if (!RQ_KEYS.has(k)) {
        finding("E710", lineOf(`${rp}.${k}`), `${rp}.${k}`, `unknown key under ${rp}: ${k}`);
      }
    }
    if (rqId === "") {
      finding("E710", 0, rp, `${rp}: missing required field: id`);
    } else if (spec !== null && !spec.requirements.includes(rqId)) {
      finding("E707", rqLine, `${rp}.id`, `requirement ${rqId} is not in the spec`);
    }

    for (const j of indicesUnder(records, `${rp}.acceptance-criteria`)) {
      const ap = `${rp}.acceptance-criteria[${j}]`;
      const acId = recordAt(records, `${ap}.id`)?.value ?? "";
      const acLine = lineOf(`${ap}.id`);
      nAc++;
      for (const k of childKeys(records, ap)) {
        if (!AC_KEYS.has(k)) {
          finding("E710", lineOf(`${ap}.${k}`), `${ap}.${k}`, `unknown key under ${ap}: ${k}`);
        }
      }
      if (acId === "") {
        finding("E710", 0, ap, `${ap}: missing required field: id`);
      } else if (recorded.has(acId)) {
        finding("E707", acLine, `${ap}.id`, `criterion ${acId} is recorded twice`);
      } else if (spec !== null && !spec.criteria.includes(acId)) {
        finding("E707", acLine, `${ap}.id`, `criterion ${acId} is not in the spec`);
      } else if (spec !== null && rqId !== "" && spec.ownerOf.get(acId) !== rqId) {
        finding(
          "E707",
          acLine,
          `${ap}.id`,
          `criterion ${acId} belongs to ${spec.ownerOf.get(acId)} in the spec, not ${rqId}`,
        );
      }

      const met = recordAt(records, `${ap}.met`);
      if (met === undefined) {
        finding("E708", acLine, ap, `${acId || ap}: missing required field: met`);
      } else if (met.value !== "true" && met.value !== "false") {
        finding(
          "E708",
          met.line,
          `${ap}.met`,
          `${acId || ap}: met must be true|false, got: ${met.value}`,
        );
      }
      const evidence = itemsUnder(records, `${ap}.evidence`);
      for (const r of evidence) {
        if (r.value === "") {
          finding("E710", r.line, r.path, `${acId || ap}: evidence entry is empty`);
        }
      }
      if (met?.value === "true" && evidence.length === 0) {
        finding(
          "E709",
          acLine,
          ap,
          `${acId || ap}: met: true must cite at least one piece of evidence`,
        );
      }
      const note = recordAt(records, `${ap}.note`);
      if (note !== undefined && note.value === "") {
        finding("E710", note.line, `${ap}.note`, `${acId || ap}: note is empty`);
      }
      if (acId !== "" && !recorded.has(acId)) {
        recorded.set(acId, { met: met?.value ?? "", line: acLine, path: ap });
      }
    }
  }

  // E706: every criterion of the spec has a verdict.
  if (spec !== null) {
    for (const acId of spec.criteria) {
      if (!recorded.has(acId)) {
        finding("E706", 0, "requirements", `criterion ${acId} of the spec has no verdict`);
      }
    }
  }

  // Obligations a task may cover: every linked record's; those it must cover: an accepted one's.
  const linked = spec === null ? [] : linkedAdrs(specPathOf(file, ts.spec), spec);
  const obligations = new Set<string>();
  const required = new Set<string>();
  for (const l of linked) {
    if (l.id === "") {
      finding(
        "E716",
        0,
        "spec",
        `linked record ${l.link} does not parse, so its obligations are unknown`,
      );
      continue;
    }
    for (const o of l.obligations) {
      obligations.add(o);
      if (l.status === "accepted") required.add(o);
    }
  }

  // ── tasks: E711–E714 ──
  const taskIds = new Set<string>();
  const covered = new Set<string>();
  const deps = new Map<string, string[]>();
  const taskAt = new Map<string, { line: number; path: string }>();
  for (const i of indicesUnder(records, "tasks")) {
    const tp = `tasks[${i}]`;
    const id = recordAt(records, `${tp}.id`)?.value ?? "";
    const idLine = lineOf(`${tp}.id`);
    for (const k of childKeys(records, tp)) {
      if (!TASK_KEYS.has(k)) {
        finding("E711", lineOf(`${tp}.${k}`), `${tp}.${k}`, `unknown key under ${tp}: ${k}`);
      }
    }
    if (id === "") {
      finding("E711", 0, tp, `${tp}: missing required field: id`);
    } else if (!TASK_ID_RE.test(id)) {
      finding("E711", idLine, `${tp}.id`, `${tp}: id must match ^T-[0-9]+$, got: ${id}`);
    } else if (taskIds.has(id)) {
      finding("E711", idLine, `${tp}.id`, `duplicate task id: ${id}`);
    } else {
      taskIds.add(id);
      taskAt.set(id, { line: idLine, path: tp });
    }
    const label = id || tp;
    const title = recordAt(records, `${tp}.title`);
    if (title === undefined || title.value === "") {
      finding("E711", idLine, tp, `${label}: missing required field: title`);
    }

    const covers = itemsUnder(records, `${tp}.covers`);
    const seenCov = new Set<string>();
    for (const c of covers) {
      const v = recorded.get(c.value);
      if (seenCov.has(c.value)) {
        finding("E712", c.line, c.path, `${label}: covers ${c.value} twice`);
      } else if (OBLIGATION_RE.test(c.value)) {
        if (spec !== null && !obligations.has(c.value)) {
          finding(
            "E712",
            c.line,
            c.path,
            `${label}: covers ${c.value}, which no record linked from the spec declares`,
          );
        }
      } else if (spec !== null && !spec.criteria.includes(c.value)) {
        finding("E712", c.line, c.path, `${label}: covers ${c.value}, which is not in the spec`);
      } else if (v === undefined) {
        finding("E712", c.line, c.path, `${label}: covers ${c.value}, which has no verdict`);
      } else if (v.met === "true") {
        finding("E712", c.line, c.path, `${label}: covers ${c.value}, which is already met`);
      }
      seenCov.add(c.value);
      covered.add(c.value);
    }

    const why = recordAt(records, `${tp}.why`);
    if (covers.length === 0 && (why === undefined || why.value === "")) {
      finding("E713", idLine, tp, `${label}: covers no criterion, so it needs a why`);
    } else if (covers.length > 0 && why !== undefined) {
      finding(
        "E713",
        why.line,
        `${tp}.why`,
        `${label}: covers criteria; drop the why (the criteria justify it)`,
      );
    }

    const ds = itemsUnder(records, `${tp}.depends_on`);
    const seenDep = new Set<string>();
    const list: string[] = [];
    for (const d of ds) {
      if (d.value === id) {
        finding("E714", d.line, d.path, `${label}: depends on itself`);
      } else if (seenDep.has(d.value)) {
        finding("E714", d.line, d.path, `${label}: depends on ${d.value} twice`);
      }
      seenDep.add(d.value);
      list.push(d.value);
    }
    if (id !== "") deps.set(id, list);
  }

  // Unknown dependencies are checked once every id is known (order-independent);
  // cycles are reported once, at the task that closes them.
  for (const [id, list] of deps) {
    for (const d of list) {
      if (d !== id && !taskIds.has(d)) {
        const at = taskAt.get(id)!;
        finding("E714", at.line, `${at.path}.depends_on`, `${id}: depends on unknown task ${d}`);
      }
    }
  }
  const state = new Map<string, 1 | 2>(); // 1 visiting, 2 done
  const visit = (id: string, trail: string[]): void => {
    const st = state.get(id);
    if (st === 2) return;
    if (st === 1) {
      const cycle = [...trail.slice(trail.indexOf(id)), id].join(" -> ");
      const at = taskAt.get(id)!;
      finding("E714", at.line, `${at.path}.depends_on`, `dependency cycle: ${cycle}`);
      return;
    }
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) {
      if (d !== id && taskIds.has(d)) visit(d, [...trail, id]);
    }
    state.set(id, 2);
  };
  for (const id of [...taskIds].sort((a, b) => taskNum(a) - taskNum(b))) visit(id, []);

  // ── E715: every unmet criterion is covered ──
  for (const [acId, v] of recorded) {
    if (v.met === "false" && !covered.has(acId)) {
      finding("E715", v.line, v.path, `${acId} is unmet and no task covers it`);
    }
  }

  // ── E716: every obligation of an accepted linked record is covered ──
  for (const o of required) {
    if (!covered.has(o)) finding("E716", 0, "tasks", `obligation ${o} is covered by no task`);
  }

  return {
    findings,
    summary: {
      requirements: ts.requirements.length,
      acceptanceCriteria: nAc,
      tasks: ts.tasks.length,
    },
    spec,
  };
}
