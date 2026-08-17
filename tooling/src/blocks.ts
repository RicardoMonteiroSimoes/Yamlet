// Block addressing — naming an existing requirement or criterion by its id.
//
// The author is an appender, and every one of its "out of scope" refusals traces
// back to one missing primitive: nothing could locate a block that already
// exists. This module is that primitive. It reports, for each `RQ-N` and `AC-N`,
// the line range it occupies, so a caller can insert next to it, replace it, or
// cut it out without reformatting anything else.
//
// **Starts come from records; ends come from the next start.** In a block
// sequence the first key of an item carries the `-`, so the minimum line over a
// block's records is always its dash line, whatever order the keys are in. The
// *end* cannot be derived the same way: a folded scalar (`description: >-`)
// reports the line of its key, not of the text beneath it, so a maximum-line
// extent would slice a requirement's description in half. Taking the end as "the
// line before the next block begins" is exact regardless of how many
// continuation lines a scalar spans.
//
// Assumption, stated because it is the one thing that would break the extents:
// `acceptance-criteria` is a requirement's last key. The author always emits it
// last and the format gives a requirement only three keys, so this holds for
// every generated file; a hand-written requirement that put `description` *after*
// its criteria would leave that line inside the final criterion's range.

import { flatten } from "./flatten.ts";

export type BlockKind = "requirement" | "criterion";

export interface Block {
  kind: BlockKind;
  /** `RQ-N` / `AC-N`, or "" when the block declares no id (an E201/E203 file). */
  id: string;
  /** The flattened path prefix, e.g. `requirements[1].acceptance-criteria[0]`. */
  path: string;
  /** 1-based line of the block's `-` marker. */
  start: number;
  /**
   * 1-based last line of the block's *own* lines, inclusive, trailing blanks
   * trimmed. For a requirement this stops at its `acceptance-criteria:` key —
   * the header alone, which is what a header revision replaces.
   */
  end: number;
  /**
   * 1-based last line of the block *including everything nested under it*: for a
   * requirement, the end of its final criterion. This is the extent to remove,
   * and the anchor to append after. Equal to `end` for a criterion, and for a
   * requirement that has no criteria yet.
   */
  outerEnd: number;
  /** For a criterion, the owning `RQ-N`; "" for a requirement. */
  parentId: string;
}

const RQ = /^requirements\[([0-9]+)\]$/;
const AC = /^requirements\[([0-9]+)\]\.acceptance-criteria\[([0-9]+)\]$/;

/**
 * Every requirement and criterion in `text`, ordered by position in the file.
 * A file with no requirements yields an empty list.
 */
export function blocksOf(text: string): Block[] {
  const lines = text.split("\n");
  const { records } = flatten(text);

  // prefix -> {start, id}. The start is the minimum record line under the prefix.
  const seen = new Map<string, { start: number; id: string }>();
  const note = (prefix: string, line: number): void => {
    const cur = seen.get(prefix);
    if (cur === undefined) seen.set(prefix, { start: line, id: "" });
    else if (line < cur.start) cur.start = line;
  };

  for (const r of records) {
    const acM = r.path.match(/^(requirements\[[0-9]+\]\.acceptance-criteria\[[0-9]+\])(\.|$)/);
    if (acM) {
      const prefix = acM[1]!;
      note(prefix, r.line);
      if (r.path === `${prefix}.id`) seen.get(prefix)!.id = r.value;
    }
    const rqM = r.path.match(/^(requirements\[[0-9]+\])(\.|$)/);
    if (rqM) {
      const prefix = rqM[1]!;
      note(prefix, r.line);
      if (r.path === `${prefix}.id`) seen.get(prefix)!.id = r.value;
    }
  }

  const blocks: Block[] = [];
  for (const [path, { start, id }] of seen) {
    const kind: BlockKind = AC.test(path)
      ? "criterion"
      : RQ.test(path)
      ? "requirement"
      : "criterion";
    blocks.push({ kind, id, path, start, end: 0, outerEnd: 0, parentId: "" });
  }
  blocks.sort((a, b) => a.start - b.start);

  // The end of a block is the line before the next block starts — never the
  // maximum record line, which a folded scalar would under-report.
  const lastLine = lines.length;
  for (let i = 0; i < blocks.length; i++) {
    const next = blocks[i + 1];
    let end = next === undefined ? lastLine : next.start - 1;
    while (end > blocks[i]!.start && (lines[end - 1] ?? "").trim() === "") end--;
    blocks[i]!.end = end;
    blocks[i]!.outerEnd = end;
  }

  // A criterion's owner is the requirement whose path it extends; a requirement's
  // outer extent runs to the end of its last criterion.
  const byPath = new Map(blocks.map((b) => [b.path, b]));
  for (const b of blocks) {
    if (b.kind !== "criterion") continue;
    const m = b.path.match(AC);
    if (!m) continue;
    const owner = byPath.get(`requirements[${m[1]}]`);
    if (owner === undefined) continue;
    b.parentId = owner.id;
    if (b.end > owner.outerEnd) owner.outerEnd = b.end;
  }
  return blocks;
}

/** The block carrying `id`, or undefined. Ids are unique file-wide (E202/E204). */
export function findBlock(blocks: readonly Block[], id: string): Block | undefined {
  return blocks.find((b) => b.id === id);
}

/** The criteria of one requirement, in file order. */
export function criteriaOf(blocks: readonly Block[], rqId: string): Block[] {
  return blocks.filter((b) => b.kind === "criterion" && b.parentId === rqId);
}

/**
 * The line of a requirement's `acceptance-criteria:` key — the insertion anchor
 * when it has no criteria yet, since an empty mapping key emits no record for
 * the flattener to report. Returns 0 when the requirement has no such key.
 */
export function criteriaKeyLine(text: string, rq: Block): number {
  const lines = text.split("\n");
  for (let i = rq.start - 1; i < rq.end && i < lines.length; i++) {
    if (/^ *acceptance-criteria: *$/.test(lines[i] ?? "")) return i + 1;
  }
  return 0;
}

/** `text` with `insert` spliced in directly after 1-based `line`. */
export function spliceAfter(text: string, line: number, insert: string): string {
  const lines = text.split("\n");
  const head = lines.slice(0, line).join("\n");
  const tail = lines.slice(line).join("\n");
  return head + "\n" + insert + tail;
}
