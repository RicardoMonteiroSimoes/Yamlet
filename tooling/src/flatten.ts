// Phase 1: FLATTEN — a faithful port of the sh verifier's `_flatten` awk.
//
// Parses the constrained YAML subset into tab-free leaf records:
//   { path, value, line }
// Path notation: "system", "requirements[0].id",
//   "requirements[0].acceptance-criteria[2].while[1]".
//
// Parse-phase findings (E002/E003/E004/E006/E008/E009/E010) are collected
// separately; when any are present the caller short-circuits and reports only
// those, exactly as the sh verifier does.

import type { FlatRecord, FlattenResult, ParseError } from "./types.ts";

// POSIX [[:space:]] minus newline (lines are already split): space, tab, CR, FF, VT.
const TRAILING_WS = /[ \t\r\f\v]$/;
const LEADING_WS_RUN = /^[ \t\n\r\f\v]+/;
const TRAILING_WS_RUN = /[ \t\n\r\f\v]+$/;
const BLOCK_FOLD = /^>[-+]?$/;
const BLOCK_LIT = /^\|[-+]?$/;
const KEY_ONLY = /^[^:]+:\s*$/; // "key:" with nothing (but spaces) after

export function flatten(text: string): FlattenResult {
  const records: FlatRecord[] = [];
  const parseErrors: ParseError[] = [];

  // ── parser state (mirrors the awk globals) ──
  const keyStack: string[] = [];
  const indentStack: number[] = [];
  let sp = 0;

  let inBlock = false;
  let blockPath = "";
  let blockLine = 0;
  let blockType = ""; // "fold" | "lit"
  let blockChomp = ""; // "" clip | "-" strip | "+" keep
  let blockIndent = -1;
  let blockVal = "";

  const seqCtr: Record<string, number> = {};
  const seenKeys: Record<string, number> = {};

  // ── helpers ──
  const buildPath = (): string => {
    let p = "";
    for (let i = 0; i < sp; i++) {
      const k = keyStack[i]!;
      if (p === "") p = k;
      else if (k[0] === "[") p = p + k;
      else p = p + "." + k;
    }
    return p;
  };

  const pushFrame = (key: string, ind: number): void => {
    keyStack[sp] = key;
    indentStack[sp] = ind;
    sp++;
  };

  const emit = (path: string, val: string, ln: number): void => {
    let v = val.replace(/\n/g, " ");
    v = v.replace(LEADING_WS_RUN, "").replace(TRAILING_WS_RUN, "");
    records.push({ path, value: v, line: ln });
  };

  const stripComment = (s: string): string => {
    // Strip a trailing " #..." comment (space then #), scanning from index 1.
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "#" && s[i - 1] === " ") {
        s = s.slice(0, i - 1);
        break;
      }
    }
    return s.replace(TRAILING_WS_RUN, "");
  };

  const unquote = (s: string): string => s.slice(1, s.length - 1);

  const finaliseBlock = (): void => {
    let v = blockVal;
    if (blockChomp === "-") {
      v = v.replace(TRAILING_WS_RUN, "");
    } else {
      while (v.length > 0 && v[v.length - 1] === "\n") v = v.slice(0, -1);
    }
    emit(blockPath, v, blockLine);
    if (sp > 0) sp--;
  };

  const parseErr = (line: number, rule: string, message: string): void => {
    parseErrors.push({ rule, line, message });
  };

  const leadingSpaces = (raw: string): number => {
    let col = 0;
    while (col < raw.length && raw[col] === " ") col++;
    return col;
  };

  // ── per-line processing ──
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineno = idx + 1;

    // E008: trailing whitespace (checked before any stripping; no early exit).
    if (TRAILING_WS.test(raw)) {
      parseErr(lineno, "E008", "trailing whitespace on line");
    }

    // E002: tabs anywhere on the line (fatal for the line).
    if (raw.indexOf("\t") >= 0) {
      parseErr(lineno, "E002", "tabs are not allowed; use spaces only");
      continue;
    }

    // E006: YAML document markers.
    if (raw.startsWith("---") || raw.startsWith("...")) {
      parseErr(lineno, "E006", "YAML document markers (--- / ...) are not supported");
      continue;
    }

    // ── Block scalar collection ──
    if (inBlock) {
      const col = leadingSpaces(raw);
      const thisIndent = col;
      const content = raw.slice(col);

      if (raw.length === 0 || content === "") {
        blockVal = blockVal + "\n";
        continue;
      }
      if (blockIndent === -1) blockIndent = thisIndent;

      if (thisIndent < blockIndent) {
        finaliseBlock();
        inBlock = false;
        // fall through — process this line normally below
      } else {
        const lineText = raw.slice(blockIndent);
        if (blockVal === "") {
          blockVal = lineText;
        } else {
          const lastCh = blockVal[blockVal.length - 1];
          if (blockType === "fold") {
            if (lastCh === "\n") blockVal = blockVal + lineText;
            else blockVal = blockVal + " " + lineText;
          } else {
            blockVal = blockVal + "\n" + lineText;
          }
        }
        continue;
      }
    }

    // ── Normal line processing ──

    // Full-line comment or blank line — skip.
    if (/^\s*#/.test(raw) || /^\s*$/.test(raw)) continue;

    const col = leadingSpaces(raw);
    const thisIndent = col;
    const rest = raw.slice(col);

    // E003: indent not a multiple of 2.
    if (thisIndent % 2 !== 0) {
      parseErr(
        lineno,
        "E003",
        "indentation must be a multiple of 2 spaces (found " + thisIndent + ")",
      );
      continue;
    }

    // ── Sequence item: leading "- " ──
    if (rest.slice(0, 2) === "- " || rest === "-") {
      while (sp > 0 && indentStack[sp - 1]! > thisIndent) sp--;
      while (
        sp > 0 && indentStack[sp - 1] === thisIndent && keyStack[sp - 1]![0] === "["
      ) {
        sp--;
      }

      const seqKey = "seqctr_" + thisIndent;
      if (seqKey in seqCtr) seqCtr[seqKey]!++;
      else seqCtr[seqKey] = 0;
      const seqBracket = "[" + seqCtr[seqKey] + "]";

      const afterDash = rest === "-" ? "" : rest.slice(2);

      // E010: empty sequence item.
      if (rest === "-" || afterDash === "") {
        parseErr(lineno, "E010", "empty sequence item");
        continue;
      }

      const colonPos = afterDash.indexOf(": ");
      const isMapKey = colonPos >= 0 || KEY_ONLY.test(afterDash);

      if (isMapKey) {
        let mk: string;
        let mv: string;
        if (colonPos >= 0) {
          mk = afterDash.slice(0, colonPos);
          mv = afterDash.slice(colonPos + 2);
        } else {
          mk = afterDash.replace(/:.*$/, "");
          mv = "";
        }
        if (mv !== "" && mv[0] !== '"') mv = stripComment(mv);

        pushFrame(seqBracket, thisIndent);
        pushFrame(mk, thisIndent + 2);

        if (mv === "") {
          // block structure follows
        } else if (BLOCK_FOLD.test(mv) || BLOCK_LIT.test(mv)) {
          inBlock = true;
          blockPath = buildPath();
          blockLine = lineno;
          blockType = mv[0] === ">" ? "fold" : "lit";
          const lc = mv[mv.length - 1];
          blockChomp = lc === "-" || lc === "+" ? lc! : "";
          blockIndent = -1;
          blockVal = "";
        } else {
          let v = mv;
          if (v[0] === '"') {
            v = unquote(v);
          } else {
            const fc = v[0];
            if (fc === "{" || fc === "[") {
              parseErr(
                lineno,
                "E004",
                "flow collection not allowed as value (starts with " + fc +
                  "); quote the value if it is literal text",
              );
              sp -= 2;
              continue;
            }
          }
          emit(buildPath(), v, lineno);
          sp--; // pop mapping key; bracket stays for sibling keys
        }
      } else {
        // "- scalar text"
        pushFrame(seqBracket, thisIndent);
        let v = afterDash;
        if (v[0] === '"') {
          v = unquote(v);
        } else {
          v = stripComment(v);
          const fc = v[0];
          if (fc === "{" || fc === "[") {
            parseErr(
              lineno,
              "E004",
              "flow collection not allowed as value (starts with " + fc + ")",
            );
            sp--;
            continue;
          }
        }
        emit(buildPath(), v, lineno);
        sp--;
      }
      continue;
    }

    // ── Mapping key ──
    while (sp > 0 && indentStack[sp - 1]! >= thisIndent) sp--;
    for (const sk of Object.keys(seqCtr)) {
      const sd = Number(sk.replace(/^seqctr_/, ""));
      if (sd >= thisIndent) delete seqCtr[sk];
    }

    let mk: string;
    let mv: string;
    const colonPos = rest.indexOf(": ");
    if (colonPos >= 0) {
      mk = rest.slice(0, colonPos);
      mv = rest.slice(colonPos + 2);
    } else if (KEY_ONLY.test(rest)) {
      mk = rest.replace(/:.*$/, "");
      mv = "";
    } else {
      parseErr(lineno, "E003", "not a mapping key or sequence item: " + rest);
      continue;
    }

    // E009: duplicate mapping key within the same block.
    let dupProbe = buildPath();
    dupProbe = dupProbe === "" ? mk : dupProbe + "." + mk;
    if (dupProbe in seenKeys) {
      parseErr(lineno, "E009", "duplicate mapping key: " + mk);
    } else {
      seenKeys[dupProbe] = lineno;
    }

    if (mv !== "" && mv[0] !== '"') mv = stripComment(mv);

    pushFrame(mk, thisIndent);

    if (mv === "") {
      // nested structure follows
    } else if (BLOCK_FOLD.test(mv) || BLOCK_LIT.test(mv)) {
      inBlock = true;
      blockPath = buildPath();
      blockLine = lineno;
      blockType = mv[0] === ">" ? "fold" : "lit";
      const lc = mv[mv.length - 1];
      blockChomp = lc === "-" || lc === "+" ? lc! : "";
      blockIndent = -1;
      blockVal = "";
    } else {
      let v = mv;
      if (v[0] === '"') {
        v = unquote(v);
      } else {
        const fc = v[0];
        if (fc === "{" || fc === "[") {
          parseErr(
            lineno,
            "E004",
            "flow collection not allowed as value (starts with " + fc +
              "); quote the value if it is literal text",
          );
          sp--;
          continue;
        }
      }
      emit(buildPath(), v, lineno);
      sp--;
    }
  }

  if (inBlock) finaliseBlock();

  return { records, parseErrors };
}
