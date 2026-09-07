// The architecture decision record (`*.adr.yaml`, format adr/v1).
//
// An ADR is the one long-lived artifact besides the spec: a decision, the
// forces on it, the axes it was judged on, the options judged, what the chosen
// option obliges future work to do, what it knowingly costs, and when it stops
// being right. It is written once and frozen — after `status: accepted` only
// `status`, `date` and `superseded_by` may change; a decision is revised by
// superseding it with a new record.
//
// The rules below are the ones an implementation must enforce (SPEC.md,
// "Decision records"). A few properties of the format carry the checks:
//
//   - ids are four digits, zero-padded, minted in time order, so `assumes` may
//     only point at a lower id and string comparison alone proves the graph
//     acyclic;
//   - `dimensions` are declared before `options`, so a hole in the matrix is
//     visible rather than absent: every option's `against` must cover exactly
//     the declared dimensions;
//   - obligations (`requires`) are addressable as `ADR-nnnn#R-n`, and a tech
//     spec task discharges one through `covers:` exactly as it covers an AC.
//
// Deliberately absent, and not to be added back: arithmetic (a cost model rots
// and the file is frozen — totals live behind `source`); inverse indexes (no
// dependents, no task list); per-cell provenance (option-specific goes in
// `refs`, shared in the dimension's `source`); confidence tiers; ticket ids.
//
// This module owns the format: model, reader over flattened records, canonical
// serializer, resolution of `ADR-nnnn` / `file#id` references, and E801–E815.
// `adr_author.ts` holds the commands; `verify.ts` dispatches here by extension.

import type { Finding, FlatRecord, Summary } from "./types.ts";
import { flatten } from "./flatten.ts";
import { blocksOf } from "./blocks.ts";
import { childKeys, indicesUnder, itemsUnder, recordAt } from "./records.ts";
import { QUANTITY_WORD } from "./validate.ts";

export const ADR_EXT = ".adr.yaml";
export const ADR_ID_RE = /^ADR-([0-9]{4})$/;
export const STATUS = ["proposed", "accepted", "rejected", "superseded"] as const;
export const KIND = ["selection", "mechanism", "policy", "boundary", "sequencing"] as const;
export const REVERSIBILITY = ["reversible", "costly", "one-way"] as const;
export const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export const SPEC_REF_RE = /^(.+\.yamlet\.yaml)#((?:RQ|AC)-[0-9]+[a-z]?)$/;
export const OBLIGATION_RE = /^(ADR-[0-9]{4})#(R-[0-9]+)$/;
const OBLIGATION_CITE = /\b(ADR-[0-9]{4})#(R-[0-9]+)\b/g;
const B_RE = /^B-[0-9]+$/;
const D_RE = /^D-[0-9]+$/;
const OPT_RE = /^OPT-[0-9]+$/;
const R_RE = /^R-[0-9]+$/;
const NA_CELL = /^n\/a(?:\s*[—–-]\s*(.*))?$/;
const ID_TOKENS = /\b(?:ADR-[0-9]{4}(?:#R-[0-9]+)?|(?:B|D|R|OPT)-[0-9]+)\b/g;

const TOP_REQUIRED = [
  "adr",
  "title",
  "status",
  "date",
  "kind",
  "question",
  "dimensions",
  "options",
];
const TOP_ALLOWED = new Set([
  ...TOP_REQUIRED,
  "arises_from",
  "assumes",
  "superseded_by",
  "forces",
  "basis",
  "decision",
  "requires",
  "accepts",
  "revisit",
]);
const BASIS_KEYS = new Set(["id", "quantity", "source"]);
const DIM_KEYS = new Set(["id", "matters", "unit", "source", "basis"]);
const OPT_KEYS = new Set(["id", "summary", "refs", "reversibility", "against"]);
const REQ_KEYS = new Set(["id", "must"]);

// ── the model ──

export interface AdrBasis {
  id: string;
  quantity: string;
  source: string;
}
export interface AdrDimension {
  id: string;
  matters: string;
  unit: string;
  source: string;
  basis: string[];
}
export interface AdrRef {
  label: string;
  locator: string;
}
export interface AdrCell {
  dim: string;
  text: string;
}
export interface AdrOption {
  id: string;
  summary: string;
  refs: AdrRef[];
  reversibility: string;
  against: AdrCell[];
}
export interface AdrObligation {
  id: string;
  must: string;
}
export interface Adr {
  id: string;
  title: string;
  status: string;
  date: string;
  kind: string;
  arisesFrom: string[];
  assumes: string[];
  supersededBy: string;
  question: string;
  forces: string[];
  basis: AdrBasis[];
  dimensions: AdrDimension[];
  options: AdrOption[];
  decision: string;
  requires: AdrObligation[];
  accepts: string[];
  revisit: string[];
}

export const adrNum = (id: string): number => Number(id.match(ADR_ID_RE)?.[1] ?? -1);
export const adrId = (n: number): string => `ADR-${String(n).padStart(4, "0")}`;

// ── reading ──

export function parseAdr(records: readonly FlatRecord[]): Adr {
  const val = (p: string): string => recordAt(records, p)?.value ?? "";
  const list = (p: string): string[] => itemsUnder(records, p).map((r) => r.value);

  const basis: AdrBasis[] = indicesUnder(records, "basis").map((i) => ({
    id: val(`basis[${i}].id`),
    quantity: val(`basis[${i}].quantity`),
    source: val(`basis[${i}].source`),
  }));
  const dimensions: AdrDimension[] = indicesUnder(records, "dimensions").map((i) => ({
    id: val(`dimensions[${i}].id`),
    matters: val(`dimensions[${i}].matters`),
    unit: val(`dimensions[${i}].unit`),
    source: val(`dimensions[${i}].source`),
    basis: list(`dimensions[${i}].basis`),
  }));
  const options: AdrOption[] = indicesUnder(records, "options").map((i) => {
    const p = `options[${i}]`;
    return {
      id: val(`${p}.id`),
      summary: val(`${p}.summary`),
      refs: childKeys(records, `${p}.refs`).map((label) => ({
        label,
        locator: val(`${p}.refs.${label}`),
      })),
      reversibility: val(`${p}.reversibility`),
      against: childKeys(records, `${p}.against`).map((dim) => ({
        dim,
        text: val(`${p}.against.${dim}`),
      })),
    };
  });
  const requires: AdrObligation[] = indicesUnder(records, "requires").map((i) => ({
    id: val(`requires[${i}].id`),
    must: val(`requires[${i}].must`),
  }));

  return {
    id: val("adr"),
    title: val("title"),
    status: val("status"),
    date: val("date"),
    kind: val("kind"),
    arisesFrom: list("arises_from"),
    assumes: list("assumes"),
    supersededBy: val("superseded_by"),
    question: val("question"),
    forces: list("forces"),
    basis,
    dimensions,
    options,
    decision: val("decision"),
    requires,
    accepts: list("accepts"),
    revisit: list("revisit"),
  };
}

// ── resolution ──

function dirname(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash < 0 ? "" : p.slice(0, slash);
}
function join(dir: string, rel: string): string {
  return rel.startsWith("/") ? rel : dir === "" ? rel : `${dir}/${rel}`;
}

/** A parsed ADR on disk, or the reason it could not be read. */
export interface LoadedAdr {
  path: string;
  adr: Adr;
}

/** Every `*.adr.yaml` in `dir` that parses, with its declared id. Sorted by path. */
export function listAdrs(dir: string): LoadedAdr[] {
  const out: LoadedAdr[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir === "" ? "." : dir)];
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (!e.isFile || !e.name.endsWith(ADR_EXT)) continue;
    const path = join(dir, e.name);
    const loaded = loadAdr(path);
    if (loaded) out.push(loaded);
  }
  return out;
}

/** Read and parse one ADR file; null when unreadable or not parseable. */
export function loadAdr(path: string): LoadedAdr | null {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return null;
  }
  const { records, parseErrors } = flatten(text);
  if (parseErrors.length > 0) return null;
  return { path, adr: parseAdr(records) };
}

/**
 * Resolve `ADR-nnnn` within `dir`: the file whose `adr:` declares that id.
 * Resolution is by declared id, not file name, so a directory is the namespace
 * and a file may be named as its author likes (the CLI names it
 * `ADR-nnnn-<slug>.adr.yaml`).
 */
export function resolveAdr(dir: string, id: string): LoadedAdr | null {
  return listAdrs(dir).find((l) => l.adr.id === id) ?? null;
}

/** The highest id declared in `dir`, as a number; 0 when there is none. */
export function maxAdrNum(dir: string): number {
  let max = 0;
  for (const l of listAdrs(dir)) {
    const n = adrNum(l.adr.id);
    if (n > max) max = n;
  }
  return max;
}

// ── serializing ──

/** Quote a scalar only when the constrained YAML subset requires it (the author's rule). */
function q(s: string): string {
  if (s[0] === "{" || s[0] === "[" || s[0] === '"' || s.includes(" #")) return `"${s}"`;
  return s;
}

/**
 * Prose is always emitted as a folded block (`>-`) wrapped at ~96 columns: a
 * colon-space in unquoted prose would silently turn the entry into a mapping,
 * and a block scalar has no such hazard. The flattener folds it back to one
 * line, so the value round-trips exactly.
 */
function fold(text: string, indent: string): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const width = 100 - indent.length;
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur === "") cur = w;
    else if (cur.length + 1 + w.length > width) {
      lines.push(cur);
      cur = w;
    } else cur += " " + w;
  }
  if (cur !== "") lines.push(cur);
  return lines.map((l) => indent + l).join("\n") + "\n";
}
const prose = (key: string, text: string, indent: string): string =>
  `${indent}${key}: >-\n` + fold(text, indent + "  ");
const proseItem = (text: string, indent: string): string =>
  `${indent}- >-\n` + fold(text, indent + "  ");

/** The canonical text of an ADR. Section order is fixed; empty sections are omitted. */
export function serializeAdr(a: Adr): string {
  let out = "";
  out += `adr: ${a.id}\n`;
  out += `title: ${q(a.title)}\n`;
  out += `status: ${a.status}\n`;
  out += `date: ${a.date}\n`;
  out += `kind: ${a.kind}\n`;
  if (a.arisesFrom.length > 0) {
    out += "arises_from:\n";
    for (const r of a.arisesFrom) out += `- ${q(r)}\n`;
  }
  if (a.assumes.length > 0) {
    out += "assumes:\n";
    for (const r of a.assumes) out += `- ${r}\n`;
  }
  if (a.supersededBy !== "") out += `superseded_by: ${a.supersededBy}\n`;

  out += "\n" + prose("question", a.question, "");

  if (a.forces.length > 0) {
    out += "\nforces:\n";
    for (const f of a.forces) out += proseItem(f, "");
  }
  if (a.basis.length > 0) {
    out += "\nbasis:\n";
    for (const b of a.basis) {
      out += `- id: ${b.id}\n`;
      out += `  quantity: ${q(b.quantity)}\n`;
      out += prose("source", b.source, "  ");
    }
  }
  if (a.dimensions.length > 0) {
    out += "\ndimensions:\n";
    for (const d of a.dimensions) {
      out += `- id: ${d.id}\n`;
      out += prose("matters", d.matters, "  ");
      if (d.unit !== "") out += `  unit: ${q(d.unit)}\n`;
      if (d.basis.length > 0) {
        out += "  basis:\n";
        for (const b of d.basis) out += `  - ${b}\n`;
      }
      if (d.source !== "") out += prose("source", d.source, "  ");
    }
  }
  if (a.options.length > 0) {
    out += "\noptions:\n";
    for (const o of a.options) {
      out += `- id: ${o.id}\n`;
      out += prose("summary", o.summary, "  ");
      if (o.refs.length > 0) {
        out += "  refs:\n";
        for (const r of o.refs) out += `    ${r.label}: ${q(r.locator)}\n`;
      }
      out += `  reversibility: ${o.reversibility}\n`;
      if (o.against.length > 0) {
        out += "  against:\n";
        for (const c of o.against) out += prose(c.dim, c.text, "    ");
      }
    }
  }
  if (a.decision !== "") out += `\ndecision: ${a.decision}\n`;
  if (a.requires.length > 0) {
    out += "\nrequires:\n";
    for (const r of a.requires) {
      out += `- id: ${r.id}\n`;
      out += prose("must", r.must, "  ");
    }
  }
  if (a.accepts.length > 0) {
    out += "\naccepts:\n";
    for (const s of a.accepts) out += proseItem(s, "");
  }
  if (a.revisit.length > 0) {
    out += "\nrevisit:\n";
    for (const s of a.revisit) out += proseItem(s, "");
  }
  return out;
}

// ── the rules ──

export interface AdrValidation {
  findings: Finding[];
  summary: Summary;
}

/**
 * A `refs` value must be a locator, not prose: a URL, a path, or a short
 * citation. Prose is what ends in a full stop or runs past eight words.
 */
export function isLocator(v: string): boolean {
  if (v.trim() === "") return false;
  if (/^https?:\/\/\S+$/.test(v)) return true;
  if (/\.\s*$/.test(v)) return false;
  return v.trim().split(/\s+/).length <= 8;
}

/** `text` with every id reference removed, so a numeral check sees only the claim. */
export const stripIds = (text: string): string => text.replace(ID_TOKENS, "");

/** Apply E801–E815 to an ADR's records. `file` resolves references relative to its directory. */
export function validateAdr(file: string, records: readonly FlatRecord[]): AdrValidation {
  const findings: Finding[] = [];
  const finding = (rule: string, line: number, path: string, message: string): void => {
    findings.push({ rule, severity: "error", line, path, message });
  };
  const lineOf = (p: string): number => recordAt(records, p)?.line ?? 0;
  const dir = dirname(file);
  const a = parseAdr(records);

  // ── E801/E802: top-level keys ──
  const seenTop = new Set(records.map((r) => r.path.replace(/[.[].*$/, "")));
  for (const k of TOP_REQUIRED) {
    if (!seenTop.has(k)) finding("E801", 0, k, `missing required top-level key: ${k}`);
  }
  for (const k of seenTop) {
    if (!TOP_ALLOWED.has(k)) finding("E802", 0, k, `unknown top-level key: ${k}`);
  }
  const nonEmpty = (key: string, rule: string): void => {
    if (seenTop.has(key) && a[key as "title" | "question"] === "") {
      finding(rule, lineOf(key), key, `${key} is empty`);
    }
  };
  nonEmpty("title", "E801");
  nonEmpty("question", "E801");

  // ── E803: the id, and its uniqueness in the directory ──
  const ownNum = adrNum(a.id);
  if (seenTop.has("adr")) {
    if (ownNum < 0) {
      finding("E803", lineOf("adr"), "adr", `adr must match ^ADR-[0-9]{4}$, got: ${a.id}`);
    } else {
      const others = listAdrs(dir).filter((l) => l.adr.id === a.id && l.path !== file);
      for (const o of others) {
        finding("E803", lineOf("adr"), "adr", `${a.id} is also declared by ${o.path}`);
      }
    }
  }

  // ── E804: status, and superseded_by iff superseded ──
  const accepted = a.status === "accepted" || a.status === "superseded";
  if (seenTop.has("status") && !(STATUS as readonly string[]).includes(a.status)) {
    finding(
      "E804",
      lineOf("status"),
      "status",
      `status must be ${STATUS.join("|")}, got: ${a.status}`,
    );
  }
  if (a.status === "superseded" && !seenTop.has("superseded_by")) {
    finding(
      "E804",
      lineOf("status"),
      "status",
      "status is superseded but superseded_by is missing",
    );
  }
  if (seenTop.has("superseded_by")) {
    if (a.status !== "superseded") {
      finding(
        "E804",
        lineOf("superseded_by"),
        "superseded_by",
        "superseded_by requires status: superseded",
      );
    }
    const n = adrNum(a.supersededBy);
    if (n < 0) {
      finding(
        "E804",
        lineOf("superseded_by"),
        "superseded_by",
        `superseded_by must be an ADR id, got: ${a.supersededBy}`,
      );
    } else if (ownNum >= 0 && n <= ownNum) {
      finding(
        "E804",
        lineOf("superseded_by"),
        "superseded_by",
        `superseded_by must be a later record than ${a.id}, got: ${a.supersededBy}`,
      );
    } else if (resolveAdr(dir, a.supersededBy) === null) {
      finding(
        "E804",
        lineOf("superseded_by"),
        "superseded_by",
        `superseded_by ${a.supersededBy} does not resolve to a record in ${dir || "."}`,
      );
    }
  }

  // ── E805/E806: date, kind ──
  if (seenTop.has("date") && !DATE_RE.test(a.date)) {
    finding("E805", lineOf("date"), "date", `date must be YYYY-MM-DD, got: ${a.date}`);
  }
  if (seenTop.has("kind") && !(KIND as readonly string[]).includes(a.kind)) {
    finding("E806", lineOf("kind"), "kind", `kind must be ${KIND.join("|")}, got: ${a.kind}`);
  }

  // ── E807: origin ──
  const arises = itemsUnder(records, "arises_from");
  const assumes = itemsUnder(records, "assumes");
  if (seenTop.has("adr") && arises.length + assumes.length === 0) {
    finding(
      "E807",
      0,
      "arises_from",
      "an ADR must arise from a spec (arises_from) or a prior decision (assumes)",
    );
  }
  for (const r of arises) {
    const m = r.value.match(SPEC_REF_RE);
    if (!m) {
      finding(
        "E807",
        r.line,
        r.path,
        `arises_from entry must be <spec>.yamlet.yaml#RQ-n|AC-n, got: ${r.value}`,
      );
      continue;
    }
    const specPath = join(dir, m[1]!);
    let text: string;
    try {
      text = Deno.readTextFileSync(specPath);
    } catch {
      finding(
        "E807",
        r.line,
        r.path,
        `arises_from spec does not resolve to a file: ${m[1]} (looked at ${specPath})`,
      );
      continue;
    }
    if (flatten(text).parseErrors.length > 0) {
      finding("E807", r.line, r.path, `arises_from spec does not parse: ${specPath}`);
      continue;
    }
    if (!blocksOf(text).some((b) => b.id === m[2])) {
      finding("E807", r.line, r.path, `${m[1]} declares no ${m[2]}`);
    }
  }
  for (const r of assumes) {
    const n = adrNum(r.value);
    if (n < 0) {
      finding("E807", r.line, r.path, `assumes entry must be an ADR id, got: ${r.value}`);
    } else if (ownNum >= 0 && n >= ownNum) {
      finding(
        "E807",
        r.line,
        r.path,
        `assumes may only name a lower-numbered record than ${a.id}, got: ${r.value}`,
      );
    } else {
      const target = resolveAdr(dir, r.value);
      if (target === null) {
        finding(
          "E807",
          r.line,
          r.path,
          `assumes ${r.value} does not resolve to a record in ${dir || "."}`,
        );
      } else if (
        accepted && target.adr.status !== "accepted" && target.adr.status !== "superseded"
      ) {
        finding(
          "E807",
          r.line,
          r.path,
          `an accepted record may not assume ${r.value}, which is ${target.adr.status}`,
        );
      }
    }
  }

  // ── E808: forces are strings; citations resolve ──
  const proseList = (key: string, rule: string): FlatRecord[] => {
    const items = itemsUnder(records, key);
    const stray = records.filter((r) => new RegExp(`^${key}\\[[0-9]+\\]\\.`).test(r.path));
    for (const r of stray) {
      finding(
        rule,
        r.line,
        r.path,
        `${key} entry is not a plain string (a colon-space in unquoted prose becomes a mapping); fold it with >-`,
      );
    }
    for (const r of items) {
      if (r.value === "") finding(rule, r.line, r.path, `${key} entry is empty`);
    }
    return items;
  };
  for (const r of proseList("forces", "E808")) {
    for (const m of r.value.matchAll(OBLIGATION_CITE)) {
      const target = resolveAdr(dir, m[1]!);
      if (target === null) {
        finding(
          "E808",
          r.line,
          r.path,
          `cites ${m[0]} but ${m[1]} does not resolve to a record in ${dir || "."}`,
        );
      } else if (!target.adr.requires.some((o) => o.id === m[2])) {
        finding("E808", r.line, r.path, `cites ${m[0]} but ${m[1]} declares no ${m[2]}`);
      }
    }
  }

  // ── E809: basis ──
  const basisIds = new Set<string>();
  for (const i of indicesUnder(records, "basis")) {
    const p = `basis[${i}]`;
    for (const k of childKeys(records, p)) {
      if (!BASIS_KEYS.has(k)) {
        finding("E809", lineOf(`${p}.${k}`), `${p}.${k}`, `unknown key under ${p}: ${k}`);
      }
    }
    const b = a.basis[i]!;
    if (!B_RE.test(b.id)) {
      finding("E809", lineOf(`${p}.id`), `${p}.id`, `${p}: id must match ^B-[0-9]+$, got: ${b.id}`);
    } else if (basisIds.has(b.id)) {
      finding("E809", lineOf(`${p}.id`), `${p}.id`, `duplicate basis id: ${b.id}`);
    } else basisIds.add(b.id);
    if (!/[0-9]/.test(b.quantity)) {
      finding(
        "E809",
        lineOf(`${p}.quantity`) || lineOf(`${p}.id`),
        `${p}.quantity`,
        `${b.id || p}: quantity must carry a numeral, got: ${b.quantity || "(missing)"}`,
      );
    }
    if (b.source === "") {
      finding("E809", lineOf(`${p}.id`), `${p}.source`, `${b.id || p}: source is missing`);
    }
  }

  // ── E810: dimensions ──
  const dimIds = new Set<string>();
  const unitOf = new Map<string, string>();
  const usedBasis = new Set<string>();
  const dimIdx = indicesUnder(records, "dimensions");
  if (seenTop.has("dimensions") && dimIdx.length === 0) {
    finding("E810", 0, "dimensions", "dimensions list is empty");
  }
  for (const i of dimIdx) {
    const p = `dimensions[${i}]`;
    const d = a.dimensions[i]!;
    for (const k of childKeys(records, p)) {
      if (!DIM_KEYS.has(k)) {
        finding("E810", lineOf(`${p}.${k}`), `${p}.${k}`, `unknown key under ${p}: ${k}`);
      }
    }
    if (!D_RE.test(d.id)) {
      finding("E810", lineOf(`${p}.id`), `${p}.id`, `${p}: id must match ^D-[0-9]+$, got: ${d.id}`);
    } else if (dimIds.has(d.id)) {
      finding("E810", lineOf(`${p}.id`), `${p}.id`, `duplicate dimension id: ${d.id}`);
    } else dimIds.add(d.id);
    const label = d.id || p;
    if (d.matters === "") {
      finding("E810", lineOf(`${p}.id`), `${p}.matters`, `${label}: matters is missing`);
    }
    if (d.unit !== "") {
      unitOf.set(d.id, d.unit);
      if (d.source === "") {
        finding(
          "E810",
          lineOf(`${p}.unit`),
          `${p}.source`,
          `${label}: a unit needs a source for the yardstick`,
        );
      }
      if (a.basis.length > 0 && d.basis.length === 0) {
        finding(
          "E810",
          lineOf(`${p}.unit`),
          `${p}.basis`,
          `${label}: a measured dimension must name the basis it is stated under`,
        );
      }
    } else if (d.basis.length > 0) {
      finding("E810", lineOf(`${p}.basis[0]`), `${p}.basis`, `${label}: basis refs need a unit`);
    }
    for (const r of itemsUnder(records, `${p}.basis`)) {
      if (!basisIds.has(r.value)) {
        finding("E810", r.line, r.path, `${label}: basis ${r.value} is not declared`);
      } else usedBasis.add(r.value);
    }
  }
  for (const b of a.basis) {
    if (b.id !== "" && basisIds.has(b.id) && !usedBasis.has(b.id)) {
      finding(
        "E809",
        lineOf(`basis[${a.basis.indexOf(b)}].id`),
        "basis",
        `${b.id} is referenced by no dimension`,
      );
    }
  }

  // ── E811/E812: options and the matrix ──
  const optIds = new Set<string>();
  const optIdx = indicesUnder(records, "options");
  if (seenTop.has("options") && optIdx.length < 2) {
    finding(
      "E811",
      0,
      "options",
      `at least two options, or this is a constraint rather than a decision (found ${optIdx.length})`,
    );
  }
  for (const i of optIdx) {
    const p = `options[${i}]`;
    const o = a.options[i]!;
    for (const k of childKeys(records, p)) {
      if (!OPT_KEYS.has(k)) {
        finding("E811", lineOf(`${p}.${k}`), `${p}.${k}`, `unknown key under ${p}: ${k}`);
      }
    }
    if (!OPT_RE.test(o.id)) {
      finding(
        "E811",
        lineOf(`${p}.id`),
        `${p}.id`,
        `${p}: id must match ^OPT-[0-9]+$, got: ${o.id}`,
      );
    } else if (optIds.has(o.id)) {
      finding("E811", lineOf(`${p}.id`), `${p}.id`, `duplicate option id: ${o.id}`);
    } else optIds.add(o.id);
    const label = o.id || p;
    if (o.summary === "") {
      finding("E811", lineOf(`${p}.id`), `${p}.summary`, `${label}: summary is missing`);
    }
    if (!(REVERSIBILITY as readonly string[]).includes(o.reversibility)) {
      finding(
        "E811",
        lineOf(`${p}.reversibility`) || lineOf(`${p}.id`),
        `${p}.reversibility`,
        `${label}: reversibility must be ${REVERSIBILITY.join("|")}, got: ${
          o.reversibility || "(missing)"
        }`,
      );
    }
    if (a.kind === "selection" && o.refs.length === 0) {
      finding(
        "E811",
        lineOf(`${p}.id`),
        `${p}.refs`,
        `${label}: a selection names products, so every option needs refs`,
      );
    }
    for (const r of o.refs) {
      if (!isLocator(r.locator)) {
        finding(
          "E811",
          lineOf(`${p}.refs.${r.label}`),
          `${p}.refs.${r.label}`,
          `${label}: refs.${r.label} must be a locator (URL, path or short citation), not prose`,
        );
      }
    }

    // against: exactly the declared dimensions.
    const cells = new Map(o.against.map((c) => [c.dim, c.text]));
    for (const d of dimIds) {
      if (!cells.has(d)) {
        finding(
          "E812",
          lineOf(`${p}.id`),
          `${p}.against`,
          `${label}: against has no cell for ${d}`,
        );
      }
    }
    for (const c of o.against) {
      const cp = `${p}.against.${c.dim}`;
      if (!dimIds.has(c.dim)) {
        finding(
          "E812",
          lineOf(cp),
          cp,
          `${label}: against names ${c.dim}, which is not a declared dimension`,
        );
        continue;
      }
      const na = c.text.match(NA_CELL);
      if (na) {
        const reason = (na[1] ?? "").trim();
        if (reason === "") {
          finding(
            "E812",
            lineOf(cp),
            cp,
            `${label}/${c.dim}: a bare n/a says nothing; write "n/a — <reason>"`,
          );
          continue;
        }
        for (const m of reason.matchAll(/\bD-[0-9]+\b/g)) {
          const other = cells.get(m[0]);
          if (other === undefined || NA_CELL.test(other)) {
            finding(
              "E812",
              lineOf(cp),
              cp,
              `${label}/${c.dim}: cites ${m[0]} as excluding the option, but ${label}/${
                m[0]
              } is not a substantive cell`,
            );
          }
        }
        continue;
      }
      if (c.text.trim() === "") {
        finding("E812", lineOf(cp), cp, `${label}/${c.dim}: cell is empty`);
      } else if (unitOf.has(c.dim) && !/[0-9]/.test(stripIds(c.text))) {
        finding(
          "E812",
          lineOf(cp),
          cp,
          `${label}/${c.dim}: ${c.dim} is measured in ${
            unitOf.get(c.dim)
          }; the cell needs a numeral`,
        );
      }
    }
  }

  // ── E813: decision ──
  if (seenTop.has("decision")) {
    if (!optIds.has(a.decision)) {
      finding(
        "E813",
        lineOf("decision"),
        "decision",
        `decision must be a declared option id, got: ${a.decision}`,
      );
    }
  } else if (accepted) {
    finding("E813", lineOf("status"), "decision", `an ${a.status} record must name its decision`);
  }

  // ── E814: requires ──
  const reqIds = new Set<string>();
  for (const i of indicesUnder(records, "requires")) {
    const p = `requires[${i}]`;
    const r = a.requires[i]!;
    for (const k of childKeys(records, p)) {
      if (!REQ_KEYS.has(k)) {
        finding("E814", lineOf(`${p}.${k}`), `${p}.${k}`, `unknown key under ${p}: ${k}`);
      }
    }
    if (!R_RE.test(r.id)) {
      finding("E814", lineOf(`${p}.id`), `${p}.id`, `${p}: id must match ^R-[0-9]+$, got: ${r.id}`);
    } else if (reqIds.has(r.id)) {
      finding("E814", lineOf(`${p}.id`), `${p}.id`, `duplicate obligation id: ${r.id}`);
    } else reqIds.add(r.id);
    if (r.must === "") {
      finding("E814", lineOf(`${p}.id`), `${p}.must`, `${r.id || p}: must is missing`);
    }
  }
  proseList("accepts", "E814");

  // ── E815: revisit — a threshold names its number ──
  for (const r of proseList("revisit", "E815")) {
    if (QUANTITY_WORD.test(r.value) && !/[0-9]/.test(stripIds(r.value))) {
      finding(
        "E815",
        r.line,
        r.path,
        `a condition naming a threshold must quantify it: ${r.value}`,
      );
    }
  }

  return {
    findings,
    summary: {
      requirements: 0,
      acceptanceCriteria: 0,
      options: a.options.length,
      obligations: a.requires.length,
    },
  };
}
