// Phase 2: VALIDATE — port of the sh verifier's VALIDATE awk. Applies all
// structural and semantic rules over the flattened records.

import type { Finding, FlatRecord, Severity } from "./types.ts";
import type { CompositeInfo } from "./composite.ts";
import { socketKey } from "./composite.ts";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOKEN = /^[a-z][a-z0-9_]*$/;

const REQUIRED_TOP = [
  "system",
  "topic",
  "summary",
  "description",
  "blast_radius",
  "front",
  "requirements",
];
const OPTIONAL_TOP = new Set(["exposes", "components", "connections"]);
const BLAST_OK = new Set(["low", "medium", "high"]);
const FRONT_OK = new Set(["internal", "external"]);
const PATTERN_OK = new Set(["ubiquitous", "state", "event", "optional", "unwanted", "complex"]);

const PAT_REQ: Record<string, string> = {
  ubiquitous: "",
  state: "while",
  event: "when",
  optional: "where",
  unwanted: "if",
  complex: "while",
};
const PAT_ALLOWED: Record<string, string[]> = {
  ubiquitous: [],
  state: ["while"],
  event: ["when"],
  optional: ["where"],
  unwanted: ["if"],
  complex: ["while", "when", "if"],
};

export interface ValidateOutput {
  findings: Finding[];
  summary: { requirements: number; acceptanceCriteria: number };
}

function topKey(path: string): string {
  return path.replace(/[.[].*$/, "");
}

export function validate(
  records: FlatRecord[],
  composite: CompositeInfo,
): ValidateOutput {
  const findings: Finding[] = [];
  const finding = (rule: string, line: number, path: string, message: string): void => {
    const severity: Severity = rule[0] === "W" ? "warning" : "error";
    findings.push({ rule, severity, line: line === 0 ? 0 : line, path, message });
  };

  // Composite pre-computed findings are buffered first (as the awk does in BEGIN).
  for (const f of composite.findings) findings.push({ ...f });
  const isComposite = composite.isComposite;

  // Accumulate flattened records.
  const byPath = new Map<string, string>();
  const byLine = new Map<string, number>();
  const seenTop = new Set<string>();
  for (const r of records) {
    byPath.set(r.path, r.value);
    byLine.set(r.path, r.line);
    seenTop.add(topKey(r.path));
  }

  // File-wide reference tracking (populated by extractPh).
  const usedInputs = new Map<string, { line: number; path: string }>();
  const usedOutputs = new Map<string, { line: number; path: string }>();
  const memberRefs = new Map<string, { line: number; path: string }>();

  // Extract {token}s from a scalar, classified by shape. Populates per-criterion
  // sets (result/iresult/oresult) and the file-wide maps above.
  const extractPh = (
    s: string,
    path: string,
    ln: number,
    result: Set<string>,
    iresult: Set<string>,
    oresult: Set<string>,
  ): void => {
    let inside = false;
    let buf = "";
    for (let i = 0; i < s.length; i++) {
      const c = s[i]!;
      if (c === "{" && !inside) {
        inside = true;
        buf = "";
      } else if (c === "}" && inside) {
        inside = false;
        if (/^input\.[a-z][a-z0-9_]*$/.test(buf)) {
          const nm = buf.slice(6);
          iresult.add(nm);
          if (!usedInputs.has(nm)) usedInputs.set(nm, { line: ln, path });
        } else if (/^output\.[a-z][a-z0-9_]*$/.test(buf)) {
          const nm = buf.slice(7);
          oresult.add(nm);
          if (!usedOutputs.has(nm)) usedOutputs.set(nm, { line: ln, path });
        } else if (TOKEN.test(buf)) {
          result.add(buf);
        } else if (/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(buf)) {
          // {alias.socket} — resolved in the member-ref pass below.
          if (!memberRefs.has(buf)) memberRefs.set(buf, { line: ln, path });
        } else if (buf !== "") {
          finding("E403", ln, path, "placeholder name {" + buf + "} must match ^[a-z][a-z0-9_]*$");
        }
        buf = "";
      } else if (inside) {
        buf = buf + c;
      }
    }
  };

  // ── E101/E102: required and unknown top-level keys ──
  // `requirements` is optional on a composite: its reason to exist can be the
  // wiring it holds, with no emergent obligation of its own (design §7).
  for (const k of REQUIRED_TOP) {
    if (k === "requirements" && isComposite) continue;
    if (!seenTop.has(k)) finding("E101", 0, k, "missing required top-level key: " + k);
  }
  for (const k of seenTop) {
    if (!REQUIRED_TOP.includes(k) && !OPTIONAL_TOP.has(k)) {
      finding("E102", 0, k, "unknown top-level key: " + k);
    }
  }

  // ── E105: system slug ──
  if (byPath.has("system")) {
    const v = byPath.get("system")!;
    if (!SLUG.test(v)) {
      finding(
        "E105",
        byLine.get("system")!,
        "system",
        "system must match ^[a-z0-9]+(-[a-z0-9]+)*$, got: " + v,
      );
    }
  }

  // ── E103: blast_radius enum ──
  if (byPath.has("blast_radius")) {
    const v = byPath.get("blast_radius")!;
    if (!BLAST_OK.has(v)) {
      finding(
        "E103",
        byLine.get("blast_radius")!,
        "blast_radius",
        "blast_radius must be low|medium|high, got: " + v,
      );
    }
  }

  // ── E104: front enum ──
  if (byPath.has("front")) {
    const v = byPath.get("front")!;
    if (!FRONT_OK.has(v)) {
      finding("E104", byLine.get("front")!, "front", "front must be internal|external, got: " + v);
    }
  }

  // ── Discover requirement indices ──
  const rqIdxs: number[] = [];
  for (const p of byPath.keys()) {
    const m = p.match(/^requirements\[([0-9]+)\]\.id$/);
    if (m) rqIdxs.push(Number(m[1]));
  }
  const nRq = rqIdxs.length;

  // E106: requirements non-empty
  if (nRq === 0 && seenTop.has("requirements")) {
    finding("E106", 0, "requirements", "requirements list is empty");
  }

  // Process each requirement (index order for deterministic output).
  const rqSeenIds = new Set<string>();
  for (const ri of [...rqIdxs].sort((a, b) => a - b)) {
    const rb = "requirements[" + ri + "]";
    const idP = rb + ".id";

    if (!byPath.has(idP)) {
      finding("E107", 0, rb, rb + ": missing required field: id");
    } else {
      const rqId = byPath.get(idP)!;
      if (!/^RQ-[0-9]+$/.test(rqId)) {
        finding("E201", byLine.get(idP)!, rb, rb + ": id must match ^RQ-[0-9]+$, got: " + rqId);
      }
      if (rqSeenIds.has(rqId)) {
        finding("E202", byLine.get(idP)!, rb, "duplicate requirement id: " + rqId);
      } else {
        rqSeenIds.add(rqId);
      }
    }

    if (!byPath.has(rb + ".description")) {
      finding("E107", 0, rb, rb + ": missing required field: description");
    }

    // Discover acceptance-criteria items for this requirement.
    const acIdxs: number[] = [];
    let hasAcKey = false;
    const acPrefix = rb + ".acceptance-criteria[";
    for (const p of byPath.keys()) {
      if (p.startsWith(acPrefix)) {
        hasAcKey = true;
        const m = p.match(/acceptance-criteria\[([0-9]+)\]/);
        if (m) acIdxs.push(Number(m[1]));
      }
    }
    const uniqAc = [...new Set(acIdxs)];

    if (!hasAcKey) {
      finding("E107", 0, rb, rb + ": missing required field: acceptance-criteria");
    } else if (uniqAc.length === 0) {
      finding("E108", 0, rb + ".acceptance-criteria", rb + ": acceptance-criteria is empty");
    } else {
      for (const ai of uniqAc.sort((a, b) => a - b)) {
        validateAc(rb + ".acceptance-criteria[" + ai + "]");
      }
    }
  }

  // E204: file-wide duplicate AC id check.
  const acSeenIds = new Set<string>();
  for (const p of byPath.keys()) {
    if (/\.acceptance-criteria\[[0-9]+\]\.id$/.test(p)) {
      const acid = byPath.get(p)!;
      if (acSeenIds.has(acid)) {
        finding("E204", byLine.get(p)!, p, "duplicate acceptance-criteria id: " + acid);
      } else {
        acSeenIds.add(acid);
      }
    }
  }

  // ── exposes contract (optional top-level) ──
  const declaredInputs = new Map<string, number>();
  const declaredOutputs = new Map<string, number>();
  if (seenTop.has("exposes")) {
    // E501: name present and a slug
    if (!byPath.has("exposes.name")) {
      finding("E501", 0, "exposes", "exposes.name is missing");
    } else {
      const nv = byPath.get("exposes.name")!;
      if (!SLUG.test(nv)) {
        finding(
          "E501",
          byLine.get("exposes.name")!,
          "exposes.name",
          "exposes.name must be a slug ^[a-z0-9]+(-[a-z0-9]+)*$, got: " + nv,
        );
      }
    }

    // E502: intent present and non-empty
    if (!byPath.has("exposes.intent")) {
      finding("E502", 0, "exposes", "exposes.intent is missing");
    } else if (byPath.get("exposes.intent") === "") {
      finding("E502", byLine.get("exposes.intent")!, "exposes.intent", "exposes.intent is empty");
    }

    // E503/E504: input tokens
    for (const p of byPath.keys()) {
      if (/^exposes\.inputs\[[0-9]+\]$/.test(p)) {
        const iv = byPath.get(p)!;
        const iln = byLine.get(p)!;
        if (!TOKEN.test(iv)) {
          finding("E503", iln, p, "exposes input name must match ^[a-z][a-z0-9_]*$, got: " + iv);
        } else if (declaredInputs.has(iv)) {
          finding("E504", iln, p, "duplicate exposes input: " + iv);
        } else {
          declaredInputs.set(iv, iln);
        }
      }
    }

    // E508/E509: output tokens
    for (const p of byPath.keys()) {
      if (/^exposes\.outputs\[[0-9]+\]$/.test(p)) {
        const ov = byPath.get(p)!;
        const oln = byLine.get(p)!;
        if (!TOKEN.test(ov)) {
          finding("E508", oln, p, "exposes output name must match ^[a-z][a-z0-9_]*$, got: " + ov);
        } else if (declaredOutputs.has(ov)) {
          finding("E509", oln, p, "duplicate exposes output: " + ov);
        } else {
          declaredOutputs.set(ov, oln);
        }
      }
    }

    // E507: unknown keys under exposes
    const expReported = new Set<string>();
    for (const p of byPath.keys()) {
      if (p.startsWith("exposes.")) {
        const expChild = p.slice(8).replace(/[.[].*$/, "");
        if (
          expChild !== "name" && expChild !== "intent" && expChild !== "inputs" &&
          expChild !== "outputs" && !expReported.has(expChild)
        ) {
          expReported.add(expChild);
          finding(
            "E507",
            byLine.get(p)!,
            "exposes." + expChild,
            "unknown key under exposes: " + expChild,
          );
        }
      }
    }
  }

  // ── connections: explicit composite wiring (E605–E610) ──
  // Each leaf record is `connections.<group>.<socket>: <source>`, where group is
  // a member alias or the reserved `output`. Sinks resolve against member inputs
  // (or composite outputs under `output`); sources against composite inputs or
  // member outputs. That asymmetry is what enforces dataflow direction — a member
  // input or an `output.NAME` can never be a source.
  const connSinkBound = new Map<string, Set<string>>(); // alias → bound input sockets
  const fedOutputs = new Set<string>(); // composite outputs fed by a connection

  if (seenTop.has("connections")) {
    const connPaths: string[] = [];
    for (const p of byPath.keys()) {
      if (p === "connections" || p.startsWith("connections.") || p.startsWith("connections[")) {
        connPaths.push(p);
      }
    }
    connPaths.sort();

    if (!isComposite) {
      const ln = connPaths.length > 0 ? byLine.get(connPaths[0]!)! : 0;
      finding(
        "E605",
        ln,
        "connections",
        "connections requires a components list; a leaf cannot declare connections",
      );
    } else {
      const resolveSource = (src: string, ln: number, path: string): void => {
        const im = src.match(/^input\.([a-z][a-z0-9_]*)$/);
        if (im) {
          const nm = im[1]!;
          if (!declaredInputs.has(nm)) {
            finding(
              "E608",
              ln,
              path,
              "connection source input." + nm + " does not resolve to a declared composite input",
            );
          } else if (!usedInputs.has(nm)) {
            usedInputs.set(nm, { line: ln, path });
          }
          return;
        }
        const am = src.match(/^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/);
        if (am && am[1] !== "input" && am[1] !== "output") {
          const al = am[1]!, sk = am[2]!;
          if (!composite.memberDeclared.has(al)) {
            finding(
              "E608",
              ln,
              path,
              "connection source " + src + " names unknown component alias: " + al,
            );
          } else if (composite.memberStatus.get(al) === "missing") {
            // E603 root cause already reported — suppress
          } else if (composite.memberStatus.get(al) === "noexposes") {
            finding(
              "E608",
              ln,
              path,
              "connection source " + src + ": component " + al + " exposes no contract",
            );
          } else if (!composite.memberOutputs.get(al)?.has(sk)) {
            finding(
              "E608",
              ln,
              path,
              "connection source " + src + " is not a declared output of " + al +
                " (only outputs can be sources)",
            );
          }
          return;
        }
        finding(
          "E608",
          ln,
          path,
          "connection source " + src +
            " does not resolve to a composite input or a component output",
        );
      };

      for (const p of connPaths) {
        const ln = byLine.get(p)!;
        const src = byPath.get(p)!;
        const m = p.match(/^connections\.([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/);
        if (!m) {
          finding(
            "E606",
            ln,
            p,
            "connection entry must be <group>.<socket>: <source>, got path: " + p,
          );
          continue;
        }
        const group = m[1]!;
        const socket = m[2]!;

        if (group === "output") {
          if (!declaredOutputs.has(socket)) {
            finding(
              "E607",
              ln,
              p,
              "connection sink output." + socket + " is not a declared composite output",
            );
          } else {
            fedOutputs.add(socket);
          }
        } else if (!composite.memberDeclared.has(group)) {
          finding(
            "E606",
            ln,
            p,
            "connection group '" + group + "' is not a component alias or 'output'",
          );
          continue;
        } else {
          const st = composite.memberStatus.get(group);
          if (st === "missing") {
            // E603 root cause — suppress
          } else if (st === "noexposes") {
            finding(
              "E607",
              ln,
              p,
              "connection sink " + group + "." + socket + ": component " + group +
                " exposes no contract",
            );
          } else if (!composite.memberInputs.get(group)?.has(socket)) {
            finding(
              "E607",
              ln,
              p,
              "connection sink " + group + "." + socket + " is not a declared input of " + group,
            );
          } else {
            let bound = connSinkBound.get(group);
            if (!bound) {
              bound = new Set();
              connSinkBound.set(group, bound);
            }
            bound.add(socket);
          }
        }
        resolveSource(src, ln, p);
      }
    }
  }

  // E609: every declared member input must be bound by some connection.
  // E610: every declared composite output must be fed by some connection.
  if (isComposite) {
    for (const al of [...composite.memberDeclared].sort()) {
      if (composite.memberStatus.get(al) !== "ok") continue; // missing/noexposes → root cause
      const inputs = composite.memberInputs.get(al);
      if (!inputs) continue;
      const bound = connSinkBound.get(al) ?? new Set<string>();
      for (const sk of [...inputs].sort()) {
        if (!bound.has(sk)) {
          finding(
            "E609",
            composite.memberLine.get(al) ?? 0,
            "components." + al,
            "component " + al + " input " + sk + " is not bound by any connection",
          );
        }
      }
    }
    for (const [nm, ln] of declaredOutputs) {
      if (!fedOutputs.has(nm)) {
        finding(
          "E610",
          ln,
          "exposes.outputs",
          "composite output " + nm + " is not fed by any connection",
        );
      }
    }
  }

  // E505/E506: input references vs declarations
  for (const [nm, ref] of usedInputs) {
    if (!declaredInputs.has(nm)) {
      finding(
        "E505",
        ref.line,
        ref.path,
        "reference {input." + nm + "} does not resolve to a declared exposes input",
      );
    }
  }
  for (const [nm, ln] of declaredInputs) {
    if (!usedInputs.has(nm)) {
      finding(
        "E506",
        ln,
        "exposes.inputs",
        "declared exposes input " + nm + " is never referenced as {input." + nm + "}",
      );
    }
  }

  // E510/E511: output references vs declarations
  for (const [nm, ref] of usedOutputs) {
    if (!declaredOutputs.has(nm)) {
      finding(
        "E510",
        ref.line,
        ref.path,
        "reference {output." + nm + "} does not resolve to a declared exposes output",
      );
    }
  }
  // On a composite, an output's "production" is a connection feeding it (E610),
  // not a criterion reference — so E511 (leaf-only) does not apply.
  if (!isComposite) {
    for (const [nm, ln] of declaredOutputs) {
      if (!usedOutputs.has(nm)) {
        finding(
          "E511",
          ln,
          "exposes.outputs",
          "declared exposes output " + nm + " is never referenced as {output." + nm + "}",
        );
      }
    }
  }

  // ── Member references {alias.socket} ──
  for (const [r, ref] of memberRefs) {
    if (!isComposite) {
      finding(
        "E403",
        ref.line,
        ref.path,
        "placeholder name {" + r + "} must match ^[a-z][a-z0-9_]*$",
      );
      continue;
    }
    const dotp = r.indexOf(".");
    const al = r.slice(0, dotp);
    const sk = r.slice(dotp + 1);
    if (!composite.memberDeclared.has(al)) {
      finding(
        "E604",
        ref.line,
        ref.path,
        "member reference {" + r + "} names unknown component alias: " + al,
      );
    } else if (composite.memberStatus.get(al) === "missing") {
      // root cause already reported as E603 — suppress
    } else if (composite.memberStatus.get(al) === "noexposes") {
      finding(
        "E604",
        ref.line,
        ref.path,
        "member reference {" + r + "}: component " + al + " exposes no contract",
      );
    } else if (!composite.sockets.has(socketKey(al, sk))) {
      finding(
        "E604",
        ref.line,
        ref.path,
        "member reference {" + r + "} does not resolve to a declared input or output of " + al,
      );
    }
  }

  // Summary counts.
  let nAcTotal = 0;
  for (const p of byPath.keys()) {
    if (/\.acceptance-criteria\[[0-9]+\]\.id$/.test(p)) nAcTotal++;
  }

  return { findings, summary: { requirements: nRq, acceptanceCriteria: nAcTotal } };

  // ── validate one acceptance criterion ──
  function validateAc(ab: string): void {
    const idP = ab + ".id";
    const patP = ab + ".pattern";

    let acid: string;
    let acidLn: number;
    if (!byPath.has(idP)) {
      finding("E107", 0, ab, ab + ": missing required field: id");
      acid = "???";
      acidLn = 0;
    } else {
      acid = byPath.get(idP)!;
      acidLn = byLine.get(idP)!;
      if (!/^AC-[0-9]+[a-z]?$/.test(acid)) {
        finding("E203", acidLn, idP, ab + ": id must match ^AC-[0-9]+[a-z]?$, got: " + acid);
      }
    }

    let acPat: string;
    let acPatLn: number;
    if (!byPath.has(patP)) {
      finding("E107", 0, ab, ab + ": missing required field: pattern");
      acPat = "";
      acPatLn = 0;
    } else {
      acPat = byPath.get(patP)!;
      acPatLn = byLine.get(patP)!;
      if (!PATTERN_OK.has(acPat)) {
        finding(
          "E107",
          acPatLn,
          patP,
          ab + ": pattern must be ubiquitous|state|event|optional|unwanted|complex, got: " + acPat,
        );
        acPat = "";
      }
    }

    // E304: shall required and non-empty
    let shallCount = 0;
    for (const p of byPath.keys()) if (p.startsWith(ab + ".shall[")) shallCount++;
    if (shallCount === 0) {
      finding(
        "E304",
        acidLn,
        ab + ".shall",
        acid + ": missing required field (shall) or shall is empty",
      );
    }

    // Detect trigger/condition clauses.
    let hasWhile = false, hasWhen = false, hasIf = false, hasWhere = false;
    let wlLn = 0, wnLn = 0, ifLn = 0, wrLn = 0;
    for (const p of byPath.keys()) {
      if (p.startsWith(ab + ".while[")) {
        hasWhile = true;
        if (wlLn === 0) wlLn = byLine.get(p)!;
      }
    }
    if (byPath.has(ab + ".when")) {
      hasWhen = true;
      wnLn = byLine.get(ab + ".when")!;
    }
    if (byPath.has(ab + ".if")) {
      hasIf = true;
      ifLn = byLine.get(ab + ".if")!;
    }
    if (byPath.has(ab + ".where")) {
      hasWhere = true;
      wrLn = byLine.get(ab + ".where")!;
    }

    if (acPat !== "") {
      const allowed = PAT_ALLOWED[acPat]!;

      // E302: clause present but not allowed
      if (!allowed.includes("while") && hasWhile) {
        finding(
          "E302",
          wlLn,
          ab + ".while",
          acid + ": pattern=" + acPat + " does not allow clause: while",
        );
      }
      if (!allowed.includes("when") && hasWhen) {
        finding(
          "E302",
          wnLn,
          ab + ".when",
          acid + ": pattern=" + acPat + " does not allow clause: when",
        );
      }
      if (!allowed.includes("if") && hasIf) {
        finding(
          "E302",
          ifLn,
          ab + ".if",
          acid + ": pattern=" + acPat + " does not allow clause: if",
        );
      }
      if (!allowed.includes("where") && hasWhere) {
        finding(
          "E302",
          wrLn,
          ab + ".where",
          acid + ": pattern=" + acPat + " does not allow clause: where",
        );
      }

      // E301: required clause missing
      const req = PAT_REQ[acPat]!;
      if (req === "while" && !hasWhile) {
        finding("E301", acidLn, ab, acid + ": pattern=" + acPat + " requires clause: while");
      }
      if (req === "when" && !hasWhen) {
        finding("E301", acidLn, ab, acid + ": pattern=" + acPat + " requires clause: when");
      }
      if (req === "where" && !hasWhere) {
        finding("E301", acidLn, ab, acid + ": pattern=" + acPat + " requires clause: where");
      }
      if (req === "if" && !hasIf) {
        finding("E301", acidLn, ab, acid + ": pattern=" + acPat + " requires clause: if");
      }

      // E303: complex requires exactly one of when/if
      if (acPat === "complex") {
        if (hasWhen && hasIf) {
          finding(
            "E303",
            acidLn,
            ab,
            acid + ": pattern=complex must have exactly one of (when/if), not both",
          );
        } else if (!hasWhen && !hasIf) {
          finding("E303", acidLn, ab, acid + ": pattern=complex requires exactly one of (when/if)");
        }
      }
    }

    // ── E401/E402/E403/W001/W002: placeholder ↔ examples consistency ──
    const phs = new Set<string>();
    const inrefs = new Set<string>();
    const outrefs = new Set<string>();

    // Clauses in a fixed order for deterministic first-occurrence recording.
    const whileItems: string[] = [];
    const shallItems: string[] = [];
    for (const p of byPath.keys()) {
      if (p.startsWith(ab + ".while[")) whileItems.push(p);
      if (p.startsWith(ab + ".shall[")) shallItems.push(p);
    }
    const byBracketIdx = (a: string, b: string): number => {
      const ia = Number(a.match(/\[([0-9]+)\]$/)?.[1] ?? 0);
      const ib = Number(b.match(/\[([0-9]+)\]$/)?.[1] ?? 0);
      return ia - ib;
    };
    for (const p of whileItems.sort(byBracketIdx)) {
      extractPh(byPath.get(p)!, p, byLine.get(p)!, phs, inrefs, outrefs);
    }
    for (const p of shallItems.sort(byBracketIdx)) {
      extractPh(byPath.get(p)!, p, byLine.get(p)!, phs, inrefs, outrefs);
    }
    if (hasWhen) extractPh(byPath.get(ab + ".when")!, ab + ".when", wnLn, phs, inrefs, outrefs);
    if (hasIf) extractPh(byPath.get(ab + ".if")!, ab + ".if", ifLn, phs, inrefs, outrefs);
    if (hasWhere) extractPh(byPath.get(ab + ".where")!, ab + ".where", wrLn, phs, inrefs, outrefs);

    const phCount = phs.size;

    // Index example rows.
    const exIdxs = new Set<number>();
    const exPrefix = ab + ".examples[";
    for (const p of byPath.keys()) {
      if (p.startsWith(exPrefix)) {
        const m = p.match(/examples\[([0-9]+)\]/);
        if (m) exIdxs.add(Number(m[1]));
      }
    }
    const hasExamples = exIdxs.size > 0;

    if (phCount > 0 && !hasExamples) {
      finding(
        "E401",
        acidLn,
        ab,
        acid + ": has " + phCount + " placeholder(s) but no examples table",
      );
    } else if (hasExamples) {
      // E402: every example row must bind every bare placeholder.
      for (const exI of [...exIdxs].sort((a, b) => a - b)) {
        const exBase = ab + ".examples[" + exI + "]";
        for (const ph of phs) {
          if (!byPath.has(exBase + "." + ph)) {
            finding(
              "E402",
              acidLn,
              exBase,
              acid + ": example row " + exI + " missing binding for {" + ph + "}",
            );
          }
        }
      }

      // Columns present across the union of all rows.
      const cols = new Set<string>();
      const colMinrow = new Map<string, number>();
      for (const p of byPath.keys()) {
        if (p.startsWith(exPrefix)) {
          const rm = p.match(/examples\[([0-9]+)\]/);
          const rI = Number(rm?.[1] ?? 0);
          const cm = p.match(/examples\[[0-9]+\]\.(.*)$/);
          if (cm) {
            const colKey = cm[1]!;
            cols.add(colKey);
            if (!colMinrow.has(colKey) || rI < colMinrow.get(colKey)!) colMinrow.set(colKey, rI);
          }
        }
      }

      let hasValidInputcol = false;
      for (const colKey of cols) {
        const colPath = ab + ".examples[" + colMinrow.get(colKey) + "]." + colKey;
        if (phs.has(colKey)) {
          // placeholder column — already handled
        } else if (/^input\.[a-z][a-z0-9_]*$/.test(colKey)) {
          const ckNm = colKey.slice(6);
          if (inrefs.has(ckNm)) {
            hasValidInputcol = true;
            for (const exI of [...exIdxs].sort((a, b) => a - b)) {
              const exBase = ab + ".examples[" + exI + "]";
              if (!byPath.has(exBase + "." + colKey)) {
                finding(
                  "E402",
                  acidLn,
                  exBase,
                  acid + ": example row " + exI + " missing binding for {" + colKey + "}",
                );
              }
            }
          } else {
            finding(
              "W001",
              acidLn,
              colPath,
              acid + ": examples column (" + colKey + ") is not a referenced input",
            );
          }
        } else {
          finding(
            "W001",
            acidLn,
            colPath,
            acid + ": examples column (" + colKey + ") has no matching placeholder",
          );
        }
      }

      // W002: examples present but nothing legitimately bindable.
      if (phCount === 0 && !hasValidInputcol) {
        finding(
          "W002",
          acidLn,
          ab + ".examples",
          acid + ": examples present but no placeholders or input references found in clauses",
        );
      }
    }

    void acPatLn;
    void outrefs;
  }
}
