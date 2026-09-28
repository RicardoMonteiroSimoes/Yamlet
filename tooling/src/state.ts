// Stored state — the fields a criterion reads or writes, and what they add up to.
//
// A criterion may carry `reads:` and `writes:`, lists of `entity.field` names
// (E307/E308). They are an index over the criteria, not a schema: no types, keys
// or collation, which stay in the code. Their job is to make visible, per system,
// which scopes touch the same stored field — so that the interleavings nobody
// specified can be asked about while the spec is written, and the planner can
// derive schema work without re-reading prose.
//
// Nothing here is stored twice. A field has no description of its own: its
// meaning is the criteria that touch it, which are already written and already
// projected into tests. `systems --state --details` shows exactly those.
//
// Read-only.

import type { FlatRecord } from "./types.ts";
import { flatten } from "./flatten.ts";
import { indicesUnder, listUnder } from "./records.ts";
import { listSpecs } from "./systems.ts";
import { FIELD } from "./validate.ts";

export type Access = "read" | "write";

/** One criterion's stored-state declaration, with the text that gives it meaning. */
export interface CriterionState {
  ac: string;
  /** `where …, while …, when|if …` — the criterion's condition, as the Gherkin name renders it. */
  condition: string;
  shall: string[];
  reads: string[];
  writes: string[];
}

/** One criterion touching one field. */
export interface Touch {
  file: string;
  ac: string;
  access: Access;
  /** The criterion's text: present unless a caller stripped it (\`systems --state\` without --details). */
  condition?: string;
  shall?: string[];
}

export interface FieldUse {
  field: string;
  /** Criteria that write the field, then those that only read it; each in file, then AC order. */
  touches: Touch[];
}

/** Two scopes (files) touching one field, at least one of them writing it. */
export interface Contention {
  field: string;
  scopes: [string, string];
}

export interface SystemState {
  fields: FieldUse[];
  contended: Contention[];
}

function condition(records: readonly FlatRecord[], ac: string): string {
  const get = (p: string): string => records.find((r) => r.path === p)?.value ?? "";
  const cond: string[] = [];
  const where = get(`${ac}.where`);
  const whiles = listUnder(records, `${ac}.while`);
  const when = get(`${ac}.when`);
  const ifc = get(`${ac}.if`);
  if (where) cond.push(`where ${where}`);
  if (whiles.length > 0) cond.push(`while ${whiles.join(" and ")}`);
  if (when) cond.push(`when ${when}`);
  else if (ifc) cond.push(`if ${ifc}`);
  return cond.join(", ");
}

/**
 * The reads/writes of every criterion in a spec that declares any, in file order.
 * Only well-formed field names count (a malformed one is E307's business), and a
 * field both read and written by one criterion (E308) counts as a write.
 */
export function criterionStates(records: readonly FlatRecord[]): CriterionState[] {
  const out: CriterionState[] = [];
  for (const i of indicesUnder(records, "requirements")) {
    const rq = `requirements[${i}]`;
    for (const j of indicesUnder(records, `${rq}.acceptance-criteria`)) {
      const ab = `${rq}.acceptance-criteria[${j}]`;
      const writes = [...new Set(listUnder(records, `${ab}.writes`).filter((f) => FIELD.test(f)))];
      const reads = [
        ...new Set(
          listUnder(records, `${ab}.reads`).filter((f) => FIELD.test(f) && !writes.includes(f)),
        ),
      ];
      if (reads.length === 0 && writes.length === 0) continue;
      out.push({
        ac: records.find((r) => r.path === `${ab}.id`)?.value ?? "",
        condition: condition(records, ab),
        shall: listUnder(records, `${ab}.shall`),
        reads,
        writes,
      });
    }
  }
  return out;
}

/** The `system:` slug of a spec, or "". */
export function systemOf(records: readonly FlatRecord[]): string {
  return records.find((r) => r.path === "system")?.value ?? "";
}

/**
 * Merge per-file criterion states into per-field uses and contended scope pairs.
 * `files` is `[path, states]` in any order; the result is sorted and deterministic.
 */
export function mergeState(files: readonly [string, CriterionState[]][]): SystemState {
  const byField = new Map<string, Touch[]>();
  const sorted = [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [file, states] of sorted) {
    for (const s of states) {
      const add = (field: string, access: Access): void => {
        const arr = byField.get(field) ?? [];
        arr.push({ file, ac: s.ac, access, condition: s.condition, shall: s.shall });
        byField.set(field, arr);
      };
      for (const f of s.writes) add(f, "write");
      for (const f of s.reads) add(f, "read");
    }
  }

  const fields: FieldUse[] = [];
  const contended: Contention[] = [];
  for (const field of [...byField.keys()].sort()) {
    const touches = byField.get(field)!;
    // Writers first, then readers; stable within each (file order, then AC order).
    touches.sort((a, b) => (a.access === b.access ? 0 : a.access === "write" ? -1 : 1));
    fields.push({ field, touches });

    // A pair of distinct scopes is contended when either one writes the field: a
    // second writer races the first, and a reader may act on a value another scope
    // is about to change (a vote checked against a poll being closed). Two readers
    // cannot race each other.
    const writers = new Set(touches.filter((t) => t.access === "write").map((t) => t.file));
    const scopes = [...new Set(touches.map((t) => t.file))].sort();
    for (let x = 0; x < scopes.length; x++) {
      for (let y = x + 1; y < scopes.length; y++) {
        const a = scopes[x]!;
        const b = scopes[y]!;
        if (writers.has(a) || writers.has(b)) contended.push({ field, scopes: [a, b] });
      }
    }
  }
  return { fields, contended };
}

/**
 * The stored state of every spec of `system` under `root`. `override`, when
 * given, replaces one file's on-disk records (the verifier checks text that may
 * not be written yet).
 */
export function collectState(
  root: string,
  system: string,
  override?: { file: string; records: readonly FlatRecord[] },
): SystemState {
  const files: [string, CriterionState[]][] = [];
  const same = (a: string, b: string): boolean => canonical(a) === canonical(b);
  let overridden = false;
  for (const f of listSpecs(root)) {
    let records: readonly FlatRecord[];
    if (override !== undefined && same(f, override.file)) {
      records = override.records;
      overridden = true;
    } else {
      let text: string;
      try {
        text = Deno.readTextFileSync(f);
      } catch {
        continue;
      }
      records = flatten(text).records;
    }
    if (systemOf(records) !== system) continue;
    files.push([f, criterionStates(records)]);
  }
  if (override !== undefined && !overridden && systemOf(override.records) === system) {
    files.push([override.file, criterionStates(override.records)]);
  }
  return mergeState(files);
}

function canonical(p: string): string {
  try {
    return Deno.realPathSync(p);
  } catch {
    return p;
  }
}
