// Small readers over flattened records, shared by every module that walks a
// file's `{ path, value, line }` leaves by prefix (`yamlet tests`, the tech
// spec). They live here so the projection and the tech spec read a sequence
// the same way the verifier flattened it.

import type { FlatRecord } from "./types.ts";

/** Escape the literal characters of a record path for use inside a RegExp. */
export function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The distinct sequence indices present for `${prefix}[N]…`, ascending. */
export function indicesUnder(records: readonly FlatRecord[], prefix: string): number[] {
  const re = new RegExp(`^${escRe(prefix)}\\[(\\d+)\\]`);
  const seen = new Set<number>();
  for (const r of records) {
    const m = r.path.match(re);
    if (m) seen.add(Number(m[1]));
  }
  return [...seen].sort((a, b) => a - b);
}

/** The ordered scalar records of an indexed list at `${prefix}[N]`. */
export function itemsUnder(records: readonly FlatRecord[], prefix: string): FlatRecord[] {
  const re = new RegExp(`^${escRe(prefix)}\\[(\\d+)\\]$`);
  const rows: { i: number; r: FlatRecord }[] = [];
  for (const r of records) {
    const m = r.path.match(re);
    if (m) rows.push({ i: Number(m[1]), r });
  }
  rows.sort((a, b) => a.i - b.i);
  return rows.map((x) => x.r);
}

/** The ordered scalar values of an indexed list at `${prefix}[N]`. */
export function listUnder(records: readonly FlatRecord[], prefix: string): string[] {
  return itemsUnder(records, prefix).map((r) => r.value);
}

/** The record at exactly `path`, or undefined. */
export function recordAt(records: readonly FlatRecord[], path: string): FlatRecord | undefined {
  return records.find((r) => r.path === path);
}

/**
 * The direct child keys under a mapping at `prefix` (`prefix.key…`), in first-
 * occurrence order. A sequence child reports as its bare key (`shall`, not
 * `shall[0]`). Used to reject keys a block does not allow.
 */
export function childKeys(records: readonly FlatRecord[], prefix: string): string[] {
  const re = new RegExp(`^${escRe(prefix)}\\.([^.[]+)`);
  const out: string[] = [];
  for (const r of records) {
    const m = r.path.match(re);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}
