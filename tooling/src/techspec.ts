// The tech spec (`*.techspec.yaml`) — one change's gap analysis and task list.
//
// A tech spec is *derived* from finished specs and the code that is supposed to
// implement them: for every acceptance criterion in scope a verdict (`met:
// true|false`, with the evidence that backs it), the same for every obligation
// of a decision record those criteria are decided by, and a task list that
// covers every unmet one. It is deliberately short-lived — generated when work
// is planned, consumed while it is done, discarded after; the specs and their
// ADRs are what persist. Nothing in it is a source of truth, which is why it
// carries no ids of its own except `T-N` for tasks, and why every requirement/
// criterion id in it must resolve to a spec it lists.
//
// One tech spec spans every spec a change touches, all of one system. The
// codebase is shared, so a plan per spec re-plans the same foundation once per
// spec, and a task in one plan cannot depend on a task in another. `scope`
// narrows a spec to the criteria a change touches (a diff of an existing spec),
// so the rest of it is not re-researched.
//
// This module owns the *format*: the model, the reader over flattened records,
// the canonical serializer, and the E7xx rules. The mutating commands live in
// `techspec_author.ts`; `verify.ts` dispatches here by file extension.
//
// The one value the file adds over the agent's prose is that it can be checked:
// every criterion in scope has exactly one verdict, `met: true` is backed by
// evidence, every obligation owed is accounted for, every unmet one is covered
// by a task, and the dependency graph resolves and is acyclic. An agent that
// silently skips a criterion is the failure mode the whole file exists to catch
// (E706/E715).

import type { Finding, FlatRecord, Summary } from "./types.ts";
import { flatten } from "./flatten.ts";
import { scalar } from "./scalar.ts";
import { blocksOf } from "./blocks.ts";
import {
  childKeys,
  indicesUnder,
  itemsUnder,
  listUnder,
  recordAt,
  strayMessage,
  strayUnder,
} from "./records.ts";
import { loadAdr, OBLIGATION_RE } from "./adr.ts";

export const TECHSPEC_EXT = ".techspec.yaml";
export const SPEC_EXT = ".yamlet.yaml";
export const COMMIT_RE = /^[0-9a-f]{7,40}$/;
export const TASK_ID_RE = /^T-[0-9]+$/;
/** A criterion as a task covers it: `<spec path>#AC-n`, the path as `specs:` lists it. */
export const CRITERION_REF_RE = /^(.+\.yamlet\.yaml)#(AC-[0-9]+[a-z]?)$/;
const AC_ID_RE = /^AC-[0-9]+[a-z]?$/;

const TOP_REQUIRED = ["system", "analysis", "specs"];
const TOP_ALLOWED = new Set(["system", "analysis", "specs", "obligations", "tasks"]);
const ANALYSIS_KEYS = new Set(["commit", "deep", "skimmed"]);
const SPEC_KEYS = new Set(["path", "scope", "requirements"]);
const RQ_KEYS = new Set(["id", "acceptance-criteria"]);
const VERDICT_KEYS = new Set(["id", "met", "evidence", "note"]);
const TASK_KEYS = new Set(["id", "title", "covers", "depends_on", "why"]);

// ── the model ──

/** A verdict on a criterion (`AC-N`) or an obligation (`ADR-nnnn#R-n`). */
export interface TsVerdict {
  id: string;
  /** Raw value; "" when absent. Valid values are exactly "true" and "false". */
  met: string;
  evidence: string[];
  note: string;
}
export interface TsRequirement {
  id: string;
  criteria: TsVerdict[];
}
export interface TsSpec {
  /** The spec, relative to the tech spec's directory. */
  path: string;
  /** The criteria in scope; empty means the whole spec. */
  scope: string[];
  requirements: TsRequirement[];
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
  system: string;
  /** `null` until `techspec analysis` records it. */
  analysis: TsAnalysis | null;
  specs: TsSpec[];
  obligations: TsVerdict[];
  tasks: TsTask[];
}

/** What the tech spec needs to know about a spec: the criteria, in order, and their owners. */
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

/** The criteria a spec entry puts in scope, in the spec's order. */
export function criteriaInScope(spec: SpecIndex, scope: readonly string[]): string[] {
  return scope.length === 0 ? [...spec.criteria] : spec.criteria.filter((c) => scope.includes(c));
}

/**
 * The records a spec entry's scope reaches: every link in the spec when the
 * whole spec is in scope, else the links deciding a scoped criterion (on it or
 * on its requirement). Links as written in the spec, first occurrence order.
 */
export function linksInScope(spec: SpecIndex, scope: readonly string[]): string[] {
  const out: string[] = [];
  const add = (xs: readonly string[]): void => {
    for (const x of xs) if (!out.includes(x)) out.push(x);
  };
  if (scope.length === 0) {
    for (const links of spec.adrsOf.values()) add(links);
  } else {
    for (const ac of criteriaInScope(spec, scope)) add(decidedBy(spec, ac).adrs);
  }
  return out;
}

// ── reading ──

export function parseTechspec(records: readonly FlatRecord[]): Techspec {
  const val = (p: string): string => recordAt(records, p)?.value ?? "";
  const list = (p: string): string[] => itemsUnder(records, p).map((r) => r.value);
  const verdict = (p: string): TsVerdict => ({
    id: val(`${p}.id`),
    met: val(`${p}.met`),
    evidence: list(`${p}.evidence`),
    note: val(`${p}.note`),
  });

  const hasAnalysis = records.some((r) => r.path === "analysis" || r.path.startsWith("analysis."));
  const analysis: TsAnalysis | null = hasAnalysis
    ? {
      commit: val("analysis.commit"),
      deep: list("analysis.deep"),
      skimmed: list("analysis.skimmed"),
    }
    : null;

  const specs: TsSpec[] = [];
  for (const s of indicesUnder(records, "specs")) {
    const sp = `specs[${s}]`;
    const requirements: TsRequirement[] = [];
    for (const i of indicesUnder(records, `${sp}.requirements`)) {
      const rp = `${sp}.requirements[${i}]`;
      const criteria = indicesUnder(records, `${rp}.acceptance-criteria`)
        .map((j) => verdict(`${rp}.acceptance-criteria[${j}]`));
      requirements.push({ id: val(`${rp}.id`), criteria });
    }
    specs.push({ path: val(`${sp}.path`), scope: list(`${sp}.scope`), requirements });
  }

  const obligations = indicesUnder(records, "obligations").map((i) => verdict(`obligations[${i}]`));

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

  return { system: val("system"), analysis, specs, obligations, tasks };
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

/** A decision record a spec links, with the obligations it places on the work. */
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
 * The records behind `links` (as written in the spec), read from disk relative
 * to the spec's directory. An unparseable link is returned with an empty id so
 * the caller can report it once.
 */
export function linkedAdrs(specFile: string, links: readonly string[]): LinkedAdr[] {
  const dir = dirname(specFile);
  const out: LinkedAdr[] = [];
  for (const link of links) {
    if (out.some((l) => l.link === link)) continue;
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
  return out;
}

/** A spec path in a tech spec, resolved against the tech spec's own directory. */
export function specPathOf(techspecFile: string, spec: string): string {
  if (spec.startsWith("/")) return spec;
  const dir = dirname(techspecFile);
  return dir === "" ? spec : `${dir}/${spec}`;
}

/** The identity of a file on disk (its real path), or the path itself when it does not exist. */
export function fileKey(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}

/** A spec the tech spec lists, resolved and read. */
export interface ResolvedSpec {
  /** As `specs[].path` writes it. */
  path: string;
  /** Resolved against the tech spec's directory. */
  file: string;
  index: SpecIndex;
  scope: string[];
}

/** An obligation the listed specs reach, and whether it is owed (its record is accepted). */
export interface ReachedObligation {
  ref: string;
  record: string;
  owed: boolean;
}

/**
 * Every obligation the specs' scopes reach through their links, keyed by
 * `ADR-nnnn#R-n`. `problems` names links that do not parse and ids declared by
 * two different records — either leaves the obligations ambiguous.
 */
export function reachedObligations(
  specs: readonly ResolvedSpec[],
): { obligations: Map<string, ReachedObligation>; problems: string[] } {
  const obligations = new Map<string, ReachedObligation>();
  const problems: string[] = [];
  const recordOf = new Map<string, string>(); // ADR id → file key
  for (const s of specs) {
    for (const l of linkedAdrs(s.file, linksInScope(s.index, s.scope))) {
      if (l.id === "") {
        const p =
          `record ${l.link} linked from ${s.path} does not parse, so its obligations are unknown`;
        if (!problems.includes(p)) problems.push(p);
        continue;
      }
      const key = fileKey(l.path);
      const prior = recordOf.get(l.id);
      if (prior !== undefined && prior !== key) {
        const p =
          `${l.id} is declared by two records (${prior} and ${key}); keep one system's records in one directory`;
        if (!problems.includes(p)) problems.push(p);
        continue;
      }
      recordOf.set(l.id, key);
      for (const o of l.obligations) {
        obligations.set(o, { ref: o, record: l.path, owed: l.status === "accepted" });
      }
    }
  }
  return { obligations, problems };
}

// ── serializing ──

const taskNum = (id: string): number => Number(id.match(/^T-([0-9]+)$/)?.[1] ?? 0);
const obligationKey = (id: string): [string, number] => {
  const m = id.match(OBLIGATION_RE);
  return m ? [m[1]!, Number(m[2]!.slice(2))] : [id, 0];
};

function verdictText(v: TsVerdict, indent: string): string {
  let out = "";
  out += `${indent}- id: ${v.id}\n`;
  out += `${indent}  met: ${v.met}\n`;
  if (v.evidence.length > 0) {
    out += `${indent}  evidence:\n`;
    for (const e of v.evidence) out += `${indent}  - ${scalar(e)}\n`;
  }
  if (v.note !== "") out += `${indent}  note: ${scalar(v.note)}\n`;
  return out;
}

/**
 * The canonical text of a tech spec. Specs come out as listed, their
 * requirements and criteria in each spec's order (whatever order they were
 * recorded in), obligations by record then number, tasks by number, and a
 * section that is empty is omitted — an enabler has no `covers:`, an unmet
 * criterion with nothing to point at has no `evidence:`. The whole file is
 * rewritten on every mutation, which is what makes the ordering free.
 * `indexes` maps `specs[].path` to its index; a spec missing from it keeps the
 * recorded order.
 */
export function serializeTechspec(ts: Techspec, indexes: Map<string, SpecIndex>): string {
  const stable = <T>(xs: T[], key: (x: T) => number): T[] =>
    xs.map((x, i) => ({ x, i })).sort((a, b) => key(a.x) - key(b.x) || a.i - b.i).map((p) => p.x);
  const pos = (list: string[] | undefined, id: string): number => {
    const i = list?.indexOf(id) ?? -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };

  let out = "";
  out += `system: ${ts.system}\n`;

  if (ts.analysis !== null) {
    out += "\nanalysis:\n";
    out += `  commit: ${scalar(ts.analysis.commit)}\n`;
    if (ts.analysis.deep.length > 0) {
      out += "  deep:\n";
      for (const d of ts.analysis.deep) out += `  - ${scalar(d)}\n`;
    }
    if (ts.analysis.skimmed.length > 0) {
      out += "  skimmed:\n";
      for (const d of ts.analysis.skimmed) out += `  - ${scalar(d)}\n`;
    }
  }

  if (ts.specs.length > 0) {
    out += "\nspecs:\n";
    for (const s of ts.specs) {
      const idx = indexes.get(s.path);
      out += `- path: ${scalar(s.path)}\n`;
      if (s.scope.length > 0) {
        out += "  scope:\n";
        for (const c of stable(s.scope, (c) => pos(idx?.criteria, c))) out += `  - ${c}\n`;
      }
      if (s.requirements.length > 0) {
        out += "  requirements:\n";
        for (const rq of stable(s.requirements, (r) => pos(idx?.requirements, r.id))) {
          out += `  - id: ${rq.id}\n`;
          out += "    acceptance-criteria:\n";
          for (const ac of stable(rq.criteria, (c) => pos(idx?.criteria, c.id))) {
            out += verdictText(ac, "    ");
          }
        }
      }
    }
  }

  if (ts.obligations.length > 0) {
    out += "\nobligations:\n";
    const sorted = [...ts.obligations].sort((a, b) => {
      const [ra, na] = obligationKey(a.id);
      const [rb, nb] = obligationKey(b.id);
      return ra < rb ? -1 : ra > rb ? 1 : na - nb;
    });
    for (const o of sorted) out += verdictText(o, "");
  }

  if (ts.tasks.length > 0) {
    out += "\ntasks:\n";
    for (const t of stable(ts.tasks, (x) => taskNum(x.id))) {
      out += `- id: ${t.id}\n`;
      out += `  title: ${scalar(t.title)}\n`;
      if (t.covers.length > 0) {
        out += "  covers:\n";
        for (const c of t.covers) out += `  - ${scalar(c)}\n`;
      }
      if (t.why !== "") out += `  why: ${scalar(t.why)}\n`;
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
  /** The specs that resolved, in listed order; one that did not is E703 and absent here. */
  specs: ResolvedSpec[];
  /** True when every listed spec resolved — only then are E706/E712/E716 complete. */
  complete: boolean;
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
 * Apply E701–E719 to a tech spec's records. `file` is needed to resolve each
 * `specs[].path` relative to the tech spec's own directory, exactly as a
 * composite resolves its members.
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
    for (
      const r of [
        ...strayUnder(records, "analysis.deep"),
        ...strayUnder(records, "analysis.skimmed"),
      ]
    ) {
      finding("E705", r.line, r.path, strayMessage(r));
    }
    const deepSet = new Set(deep.map((r) => r.value));
    for (const r of skimmed) {
      if (r.value !== "" && deepSet.has(r.value)) {
        finding("E705", r.line, r.path, `path listed as both deep and skimmed: ${r.value}`);
      }
    }
  }

  // Structural checks shared by a criterion verdict and an obligation verdict (E708–E710).
  const checkVerdict = (p: string, label: string, unknownKey: string): string => {
    for (const k of childKeys(records, p)) {
      if (!VERDICT_KEYS.has(k)) {
        finding(unknownKey, lineOf(`${p}.${k}`), `${p}.${k}`, `unknown key under ${p}: ${k}`);
      }
    }
    const idLine = lineOf(`${p}.id`);
    const met = recordAt(records, `${p}.met`);
    if (met === undefined) {
      finding("E708", idLine, p, `${label}: missing required field: met`);
    } else if (met.value !== "true" && met.value !== "false") {
      finding("E708", met.line, `${p}.met`, `${label}: met must be true|false, got: ${met.value}`);
    }
    const evidence = itemsUnder(records, `${p}.evidence`);
    for (const r of strayUnder(records, `${p}.evidence`)) {
      finding("E710", r.line, r.path, strayMessage(r));
    }
    for (const r of evidence) {
      if (r.value === "") finding("E710", r.line, r.path, `${label}: evidence entry is empty`);
    }
    if (met?.value === "true" && evidence.length === 0) {
      finding("E709", idLine, p, `${label}: met: true must cite at least one piece of evidence`);
    }
    const note = recordAt(records, `${p}.note`);
    if (note !== undefined && note.value === "") {
      finding("E710", note.line, `${p}.note`, `${label}: note is empty`);
    }
    return met?.value ?? "";
  };

  // ── specs: E703/E704/E717, then their verdicts E706–E710 ──
  const resolved: ResolvedSpec[] = [];
  const specIdx = indicesUnder(records, "specs");
  let complete = true;
  if (seenTop.has("specs") && specIdx.length === 0) {
    finding("E703", lineOf("specs"), "specs", "specs lists no spec");
  }
  const seenSpec = new Map<string, string>(); // file key → path as written
  /** `<path>#AC-n` → its verdict, for every criterion recorded under a resolved spec. */
  const recorded = new Map<string, { met: string; line: number; path: string }>();
  let nAc = 0;
  let nRq = 0;
  for (const s of specIdx) {
    const sp = `specs[${s}]`;
    for (const k of childKeys(records, sp)) {
      if (!SPEC_KEYS.has(k)) {
        finding("E703", lineOf(`${sp}.${k}`), `${sp}.${k}`, `unknown key under ${sp}: ${k}`);
      }
    }
    const path = recordAt(records, `${sp}.path`)?.value ?? "";
    const pathLine = lineOf(`${sp}.path`);
    let index: SpecIndex | null = null;
    if (path === "" || !path.endsWith(SPEC_EXT)) {
      finding(
        "E703",
        pathLine,
        `${sp}.path`,
        `${sp}: path must name a ${SPEC_EXT} file, got: ${path}`,
      );
    } else {
      const f = specPathOf(file, path);
      const key = fileKey(f);
      const prior = seenSpec.get(key);
      if (prior !== undefined) {
        finding("E703", pathLine, `${sp}.path`, `${path} is listed twice (as ${prior} before)`);
      } else {
        seenSpec.set(key, path);
        index = readSpec(f);
        if (index === null) {
          finding("E703", pathLine, `${sp}.path`, `${path} does not resolve to a parseable file`);
        }
      }
    }
    if (index === null) complete = false;

    // E704: every spec is of the tech spec's system.
    if (index !== null && seenTop.has("system") && ts.system !== index.system) {
      finding(
        "E704",
        pathLine,
        `${sp}.path`,
        `system is ${ts.system} but ${path} says ${index.system}`,
      );
    }

    // E717: scope names criteria of this spec, once each.
    const scopeItems = itemsUnder(records, `${sp}.scope`);
    for (const r of strayUnder(records, `${sp}.scope`)) {
      finding("E717", r.line, r.path, strayMessage(r));
    }
    const scope: string[] = [];
    for (const r of scopeItems) {
      if (scope.includes(r.value)) {
        finding("E717", r.line, r.path, `${path}: scope names ${r.value} twice`);
      } else if (!AC_ID_RE.test(r.value)) {
        finding(
          "E717",
          r.line,
          r.path,
          `${path}: scope entries are criteria (AC-N), got: ${r.value}`,
        );
      } else if (index !== null && !index.criteria.includes(r.value)) {
        finding(
          "E717",
          r.line,
          r.path,
          `${path}: scope names ${r.value}, which is not in the spec`,
        );
      }
      scope.push(r.value);
    }
    if (index !== null) resolved.push({ path, file: specPathOf(file, path), index, scope });
    const inScope = index === null ? [] : criteriaInScope(index, scope);

    for (const i of indicesUnder(records, `${sp}.requirements`)) {
      const rp = `${sp}.requirements[${i}]`;
      nRq++;
      const rqId = recordAt(records, `${rp}.id`)?.value ?? "";
      for (const k of childKeys(records, rp)) {
        if (!RQ_KEYS.has(k)) {
          finding("E710", lineOf(`${rp}.${k}`), `${rp}.${k}`, `unknown key under ${rp}: ${k}`);
        }
      }
      if (rqId === "") {
        finding("E710", 0, rp, `${rp}: missing required field: id`);
      } else if (index !== null && !index.requirements.includes(rqId)) {
        finding("E707", lineOf(`${rp}.id`), `${rp}.id`, `requirement ${rqId} is not in ${path}`);
      }

      for (const j of indicesUnder(records, `${rp}.acceptance-criteria`)) {
        const ap = `${rp}.acceptance-criteria[${j}]`;
        nAc++;
        const acId = recordAt(records, `${ap}.id`)?.value ?? "";
        const acLine = lineOf(`${ap}.id`);
        const ref = `${path}#${acId}`;
        if (acId === "") {
          finding("E710", 0, ap, `${ap}: missing required field: id`);
        } else if (recorded.has(ref)) {
          finding("E707", acLine, `${ap}.id`, `criterion ${ref} is recorded twice`);
        } else if (index !== null && !index.criteria.includes(acId)) {
          finding("E707", acLine, `${ap}.id`, `criterion ${acId} is not in ${path}`);
        } else if (index !== null && rqId !== "" && index.ownerOf.get(acId) !== rqId) {
          finding(
            "E707",
            acLine,
            `${ap}.id`,
            `criterion ${acId} belongs to ${index.ownerOf.get(acId)} in ${path}, not ${rqId}`,
          );
        } else if (index !== null && !inScope.includes(acId)) {
          finding("E707", acLine, `${ap}.id`, `criterion ${ref} is outside the scope`);
        }
        const met = checkVerdict(ap, acId === "" ? ap : ref, "E710");
        if (acId !== "" && index !== null && !recorded.has(ref)) {
          recorded.set(ref, { met, line: acLine, path: ap });
        }
      }
    }

    // E706: every criterion in scope has a verdict.
    for (const acId of inScope) {
      if (!recorded.has(`${path}#${acId}`)) {
        finding("E706", pathLine, sp, `criterion ${path}#${acId} has no verdict`);
      }
    }
  }

  // ── obligations: E716/E718/E719 ──
  const reached = reachedObligations(resolved);
  for (const p of reached.problems) finding("E719", 0, "specs", p);
  const obligationVerdict = new Map<string, { met: string; line: number; path: string }>();
  for (const i of indicesUnder(records, "obligations")) {
    const op = `obligations[${i}]`;
    const id = recordAt(records, `${op}.id`)?.value ?? "";
    const idLine = lineOf(`${op}.id`);
    if (id === "") {
      finding("E710", 0, op, `${op}: missing required field: id`);
    } else if (!OBLIGATION_RE.test(id)) {
      finding("E718", idLine, `${op}.id`, `${op}: id must be ADR-nnnn#R-n, got: ${id}`);
    } else if (obligationVerdict.has(id)) {
      finding("E718", idLine, `${op}.id`, `obligation ${id} is recorded twice`);
    } else if (complete && !reached.obligations.has(id)) {
      finding(
        "E718",
        idLine,
        `${op}.id`,
        `obligation ${id} is declared by no record the scope links`,
      );
    }
    const met = checkVerdict(op, id || op, "E710");
    if (id !== "" && !obligationVerdict.has(id)) {
      obligationVerdict.set(id, { met, line: idLine, path: op });
    }
  }
  if (complete) {
    for (const o of reached.obligations.values()) {
      if (o.owed && !obligationVerdict.has(o.ref)) {
        finding("E716", 0, "obligations", `obligation ${o.ref} has no verdict`);
      }
    }
  }

  // ── tasks: E711–E714 ──
  const listed = new Set(resolved.map((s) => s.path));
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
    for (const r of strayUnder(records, `${tp}.covers`)) {
      finding("E712", r.line, r.path, strayMessage(r));
    }
    const seenCov = new Set<string>();
    for (const c of covers) {
      const at = (msg: string): void => finding("E712", c.line, c.path, `${label}: ${msg}`);
      const crit = c.value.match(CRITERION_REF_RE);
      if (seenCov.has(c.value)) {
        at(`covers ${c.value} twice`);
      } else if (OBLIGATION_RE.test(c.value)) {
        const v = obligationVerdict.get(c.value);
        if (v === undefined) at(`covers ${c.value}, which has no verdict`);
        else if (v.met === "true") at(`covers ${c.value}, which is already met`);
      } else if (crit === null) {
        at(`covers ${c.value}; expected <spec>#AC-N or ADR-nnnn#R-n`);
      } else if (!listed.has(crit[1]!)) {
        if (complete) at(`covers ${c.value}, but ${crit[1]} is not a spec this tech spec lists`);
      } else {
        const v = recorded.get(c.value);
        if (v === undefined) at(`covers ${c.value}, which has no verdict`);
        else if (v.met === "true") at(`covers ${c.value}, which is already met`);
      }
      seenCov.add(c.value);
      covered.add(c.value);
    }

    const why = recordAt(records, `${tp}.why`);
    if (covers.length === 0 && (why === undefined || why.value === "")) {
      finding("E713", idLine, tp, `${label}: covers nothing, so it needs a why`);
    } else if (covers.length > 0 && why !== undefined) {
      finding(
        "E713",
        why.line,
        `${tp}.why`,
        `${label}: covers criteria or obligations; drop the why (they justify it)`,
      );
    }

    const ds = itemsUnder(records, `${tp}.depends_on`);
    for (const r of strayUnder(records, `${tp}.depends_on`)) {
      finding("E714", r.line, r.path, strayMessage(r));
    }
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

  // ── E715: every unmet criterion and obligation is covered ──
  for (const [ref, v] of [...recorded, ...obligationVerdict]) {
    if (v.met === "false" && !covered.has(ref)) {
      finding("E715", v.line, v.path, `${ref} is unmet and no task covers it`);
    }
  }

  return {
    findings,
    summary: { requirements: nRq, acceptanceCriteria: nAc, tasks: ts.tasks.length },
    specs: resolved,
    complete,
  };
}
