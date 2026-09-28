// `yamlet adr` end to end: the two records the format was specified with are
// rebuilt through the commands and must come out byte-identical to the frozen
// fixtures; every refusal is a usage error that writes nothing; acceptance
// freezes a record; superseding is the only way on from there.
//
// The fixture bytes under verifier-fixtures/ are the goldens here — they are
// also what the verifier parity suite checks — so a change to the serializer
// shows up in both places at once.

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { runAdr } from "../src/adr_author.ts";
import { verifyFile } from "../src/verify.ts";
import type { CmdResult } from "../src/types.ts";

const FIXTURES = new URL("./verifier-fixtures/", import.meta.url).pathname;

function ok(r: CmdResult, what: string): CmdResult {
  assertEquals(r.exitCode, 0, `${what}: ${r.stderr}`);
  return r;
}
function refused(r: CmdResult, needle: string): void {
  assertEquals(
    r.exitCode,
    2,
    `expected a usage error, got exit ${r.exitCode}: ${r.stderr}${r.stdout}`,
  );
  assertStringIncludes(r.stderr, needle);
}
const adr = (...args: string[]): CmdResult => runAdr(args);

/** A directory holding the pdf-verify spec, so `arises_from` can resolve. */
function workDir(): string {
  const dir = Deno.makeTempDirSync();
  Deno.copyFileSync(`${FIXTURES}pdf-verify.yamlet.yaml`, `${dir}/pdf-verify.yamlet.yaml`);
  return dir;
}

/** ADR-0001 exactly as the fixture was produced, minus the final `accept`. */
function buildStructuralParsing(dir: string): string {
  const A = ok(
    adr(
      "init",
      dir,
      "--title",
      "Structural PDF parsing",
      "--kind",
      "selection",
      "--date",
      "2026-09-07",
      "--arises-from",
      "pdf-verify.yamlet.yaml#AC-8",
      "--arises-from",
      "pdf-verify.yamlet.yaml#AC-9",
      "--question",
      "What reads the cross-reference table, trailer and object structure of an untrusted upload, given that the two failures must be reported as distinct identifiers?",
    ),
    "init",
  ).stdout.trim();
  assertEquals(A, `${dir}/ADR-0001-structural-pdf-parsing.adr.yaml`);
  ok(
    adr(
      "add-force",
      A,
      "The bytes arrive from an unauthenticated caller (front: external) and are adversarial by default.",
    ),
    "force 1",
  );
  ok(
    adr(
      "add-force",
      A,
      "AC-10 fixes a precedence order over seven identifiers, so invalid_xref_trailer and invalid_object_structure must be decidable independently of each other.",
    ),
    "force 2",
  );
  ok(
    adr(
      "add-force",
      A,
      "Doing nothing is not available: AC-8 and AC-9 name failures no header/EOF check can detect.",
    ),
    "force 3",
  );
  ok(
    adr("add-force", A, "The service is distributed to customers as a closed-source artifact."),
    "force 4",
  );
  assertEquals(
    ok(
      adr(
        "add-basis",
        A,
        "--quantity",
        "40000 uploads / month",
        "--source",
        "ingest telemetry, 2026-08 monthly mean",
      ),
      "B-1",
    ).stdout,
    "B-1\n",
  );
  assertEquals(
    ok(
      adr(
        "add-basis",
        A,
        "--quantity",
        "36 months",
        "--source",
        "the amortisation horizon this team uses for build-versus-buy",
      ),
      "B-2",
    ).stdout,
    "B-2\n",
  );
  assertEquals(
    ok(
      adr(
        "add-dimension",
        A,
        "--matters",
        "An AGPL obligation on a distributed closed-source artifact is a legal blocker, not a cost.",
        "--source",
        "OSS-policy/distribution.md",
      ),
      "D-1",
    ).stdout,
    "D-1\n",
  );
  ok(
    adr(
      "add-dimension",
      A,
      "--matters",
      "AC-8 and AC-9 must map to different identifiers. A parser that collapses both into one generic failure cannot satisfy them without a second mechanism on top.",
    ),
    "D-2",
  );
  ok(
    adr(
      "add-dimension",
      A,
      "--matters",
      "Code size reachable from untrusted bytes bounds the damage a malformed upload can do.",
    ),
    "D-3",
  );
  ok(
    adr(
      "add-dimension",
      A,
      "--matters",
      "An unmaintained parser is a standing obligation to fork or migrate.",
      "--source",
      "upstream release history and open-issue age",
    ),
    "D-4",
  );
  assertEquals(
    ok(
      adr(
        "add-dimension",
        A,
        "--matters",
        "Only decisive at a spread wide enough to survive the engineer-day rate being wrong by a third.",
        "--unit",
        "EUR of total ownership",
        "--basis",
        "B-1",
        "--basis",
        "B-2",
        "--source",
        "cost/pdf-parsing-tco.md, over platform chargeback 2026-H2 and the internal engineer-day rate.",
      ),
      "D-5",
    ).stdout,
    "D-5\n",
  );
  assertEquals(
    ok(
      adr(
        "add-option",
        A,
        "--summary",
        "Apache PDFBox 3.x",
        "--reversibility",
        "costly",
        "--ref",
        "project=https://pdfbox.apache.org/",
        "--ref",
        "licence=https://github.com/apache/pdfbox/blob/trunk/LICENSE.txt",
        "--ref",
        "failure-modes=https://pdfbox.apache.org/docs/3.0.3/javadocs/org/apache/pdfbox/Loader.html",
        "--against",
        "D-1=Apache-2.0, no distribution obligation.",
        "--against",
        "D-2=Both failures surface as IOException with library-authored messages. Distinguishing them means matching on message text, which is not a contract.",
        "--against",
        "D-3=A full document model, font and stream decoding are reachable from a parse call; roughly two orders of magnitude more code than the checks need.",
        "--against",
        "D-4=Active, wide deployment, predictable major-version cadence.",
        "--against",
        "D-5=About 26k, mostly recurring: three engineer-days to adopt, then upgrade and CVE tracking, plus one further service instance to absorb parse-time heap.",
      ),
      "OPT-1",
    ).stdout,
    "OPT-1\n",
  );
  ok(
    adr(
      "add-option",
      A,
      "--summary",
      "iText 8",
      "--reversibility",
      "costly",
      "--ref",
      "project=https://itextpdf.com/products/itext-core",
      "--ref",
      "licence=https://github.com/itext/itext-java/blob/develop/LICENSE.md",
      "--ref",
      "pricing=https://itextpdf.com/how-buy/pricing",
      "--against",
      "D-1=AGPL-3.0 or a per-seat commercial licence. Blocker under the distribution model.",
      "--against",
      "D-2=n/a — not evaluated, D-1 excludes the option.",
      "--against",
      "D-3=n/a — not evaluated, D-1 excludes the option.",
      "--against",
      "D-4=Active, commercially supported.",
      "--against",
      "D-5=n/a — not priced, D-1 excludes the option.",
    ),
    "OPT-2",
  );
  ok(
    adr(
      "add-option",
      A,
      "--summary",
      "A scanner written here that reads only startxref, the trailer dictionary and object delimiters",
      "--reversibility",
      "reversible",
      "--ref",
      "grammar=ISO 32000-1:2008 §7.5",
      "--against",
      "D-1=No third-party licence.",
      "--against",
      "D-2=Each check is a separate function, so the two identifiers fall out of the structure rather than being recovered from a message.",
      "--against",
      "D-3=Reads bytes; builds no document model, decodes no streams, resolves no fonts.",
      "--against",
      "D-4=Maintained here. The PDF structural grammar it depends on is frozen in ISO 32000 and does not move.",
      "--against",
      "D-5=About 25k, front-loaded: twelve engineer-days to write it and assemble the corpus it is tested against, then low ownership with no dependency to track. Cheaper than OPT-1 only past roughly month 32, so the two are a wash at this horizon.",
    ),
    "OPT-3",
  );
  ok(adr("decide", A, "OPT-3"), "decide");
  assertEquals(
    ok(
      adr(
        "add-obligation",
        A,
        "Resolve startxref offsets without following them recursively. A cross-reference chain is bounded, or a malformed file can direct it to loop.",
      ),
      "R-1",
    ).stdout,
    "R-1\n",
  );
  ok(
    adr(
      "add-obligation",
      A,
      "Validate every byte offset read from the file against the file length before using it.",
    ),
    "R-2",
  );
  ok(
    adr(
      "add-obligation",
      A,
      "Keep each check independent of whether another has run. AC-10 evaluates all seven independently, so a scanner that short-circuits cannot report the earliest failure correctly.",
    ),
    "R-3",
  );
  ok(
    adr(
      "add-obligation",
      A,
      "Keep structural parsing of untrusted bytes off the request thread under default JVM limits.",
    ),
    "R-4",
  );
  ok(
    adr(
      "add-accept",
      A,
      "The scanner accepts files a full parser would reject, and rejects none a full parser accepts, only within the four structural properties AC-6 through AC-9 name. It is not a PDF validator.",
    ),
    "accept 1",
  );
  ok(
    adr(
      "add-accept",
      A,
      "Cross-reference streams (PDF 1.5+) need their own decoding path, which is more work than calling a library.",
    ),
    "accept 2",
  );
  ok(
    adr(
      "add-revisit",
      A,
      "A requirement asks for anything inside the page tree — content extraction, rendering, signature verification. The scanner is the wrong shape for it and OPT-1 returns.",
    ),
    "revisit 1",
  );
  ok(
    adr(
      "add-revisit",
      A,
      "Ownership of the scanner runs past 0.25 engineer-day / month, which is the assumption D-5 rests on.",
    ),
    "revisit 2",
  );
  return A;
}

Deno.test("ADR-0001 rebuilt through the commands is byte-identical to the fixture", () => {
  const dir = workDir();
  const A = buildStructuralParsing(dir);
  ok(adr("accept", A, "--date", "2026-09-07"), "accept");
  assertEquals(
    Deno.readTextFileSync(A),
    Deno.readTextFileSync(`${FIXTURES}ADR-0001-structural-pdf-parsing.adr.yaml`),
  );
  const v = verifyFile(A);
  assertEquals(v.exitCode, 0, JSON.stringify(v.result.errors));
  assertEquals(v.result.summary, {
    requirements: 0,
    acceptanceCriteria: 0,
    options: 3,
    obligations: 4,
  });
});

Deno.test("ADR-0002 assumes ADR-0001, cites its obligation, and matches the fixture", () => {
  const dir = workDir();
  const A = buildStructuralParsing(dir);
  ok(adr("accept", A, "--date", "2026-09-07"), "accept");
  const B = ok(
    adr(
      "init",
      dir,
      "--title",
      "Isolation of structural parsing",
      "--kind",
      "mechanism",
      "--date",
      "2026-09-07",
      "--assumes",
      "ADR-0001",
      "--question",
      "Where does the byte scanner run, given that it must not be able to exhaust the service on a malformed upload?",
    ),
    "init",
  ).stdout.trim();
  assertEquals(B, `${dir}/ADR-0002-isolation-of-structural-parsing.adr.yaml`);
  ok(
    adr(
      "add-force",
      B,
      "ADR-0001#R-4 places structural parsing off the request thread under default JVM limits.",
    ),
    "force cites R-4",
  );
  refused(adr("add-force", B, "ADR-0001#R-9 does not exist."), "declares no R-9");
  refused(adr("add-force", B, "ADR-0077#R-1 does not resolve."), "does not resolve");
  ok(
    adr(
      "add-force",
      B,
      "A malformed cross-reference chain is unbounded work until a limit stops it.",
    ),
    "force 2",
  );
  ok(
    adr(
      "add-force",
      B,
      "blast_radius is medium: the verification scope is called by other scopes in this system.",
    ),
    "force 3",
  );
  ok(
    adr(
      "add-basis",
      B,
      "--quantity",
      "40000 uploads / month",
      "--source",
      "ingest telemetry, 2026-08 monthly mean",
    ),
    "B-1",
  );
  ok(
    adr(
      "add-dimension",
      B,
      "--matters",
      "A hostile upload must be able to exhaust its own budget only, never the service's.",
    ),
    "D-1",
  );
  ok(
    adr(
      "add-dimension",
      B,
      "--matters",
      "Operational surface: a mechanism nobody can observe or tune is a mechanism nobody will maintain.",
    ),
    "D-2",
  );
  ok(
    adr(
      "add-dimension",
      B,
      "--matters",
      "Decisive here: the option that costs materially more per upload has to earn it on D-1.",
      "--unit",
      "EUR/month of compute",
      "--basis",
      "B-1",
      "--source",
      "platform chargeback 2026-H2",
    ),
    "D-3",
  );
  ok(
    adr(
      "add-option",
      B,
      "--summary",
      "Bounded work in-process — an instruction and allocation budget the scanner checks itself",
      "--reversibility",
      "reversible",
      "--ref",
      "metrics=src/main/java/ch/adnovum/pdfservice/VerificationMetrics.java",
      "--against",
      "D-1=Bounds the malformed-input case, but shares a heap with the request path, so an allocation spike is still felt service-wide.",
      "--against",
      "D-2=One counter and one timeout, both already exposed by the existing metrics.",
      "--against",
      "D-3=0 — the budget is checked inside the existing request path.",
    ),
    "OPT-1",
  );
  ok(
    adr(
      "add-option",
      B,
      "--summary",
      "A separate process per upload, with rlimits",
      "--reversibility",
      "costly",
      "--ref",
      "mechanism=https://man7.org/linux/man-pages/man2/setrlimit.2.html",
      "--against",
      "D-1=A hard boundary; the kernel enforces it rather than the code being trusted to.",
      "--against",
      "D-2=Adds process lifecycle, a byte channel and a second failure mode (spawn failure) that AC-10's identifier list has no room for.",
      "--against",
      "D-3=Roughly 900/month: one process spawn per upload, plus the memory floor of a second JVM for every concurrent upload. The largest single line in the option.",
    ),
    "OPT-2",
  );
  ok(adr("decide", B, "OPT-1"), "decide");
  ok(
    adr(
      "add-obligation",
      B,
      "Fix the budget as policy, not caller-supplied, on the same grounds the spec states for max_size_bytes.",
    ),
    "R-1",
  );
  ok(
    adr(
      "add-obligation",
      B,
      "Map budget exhaustion to invalid_xref_trailer, not to a new identifier. AC-10's list is closed.",
    ),
    "R-2",
  );
  ok(
    adr(
      "add-accept",
      B,
      "A malformed upload can still cause an allocation spike visible to concurrent requests.",
    ),
    "accepts",
  );
  ok(
    adr(
      "add-revisit",
      B,
      "p99 verification latency under malformed input exceeds 200 ms, against the 34 ms measured on well-formed input in 2026-08. The shared-heap argument no longer holds and OPT-2 returns.",
    ),
    "revisit 1",
  );
  ok(
    adr(
      "add-revisit",
      B,
      "A second scope in this system begins parsing untrusted bytes, so the budget is no longer the only thing standing between an upload and the request path.",
    ),
    "revisit 2",
  );
  assertEquals(
    Deno.readTextFileSync(B),
    Deno.readTextFileSync(`${FIXTURES}ADR-0002-isolation-of-structural-parsing.adr.yaml`),
  );
  assertEquals(verifyFile(B).exitCode, 0);
});

Deno.test("init: origin, kind and references are checked before anything is written", () => {
  const dir = workDir();
  const base = ["init", dir, "--title", "T", "--kind", "policy", "--question", "Q?"];
  refused(adr(...base), "must arise from a spec");
  refused(adr(...base, "--arises-from", "pdf-verify.yamlet.yaml#AC-99"), "declares no AC-99");
  refused(adr(...base, "--arises-from", "nope.yamlet.yaml#AC-1"), "spec not found");
  refused(adr(...base, "--arises-from", "AC-1"), "must be <spec>.yamlet.yaml#RQ-n|AC-n");
  refused(adr(...base, "--assumes", "ADR-0007"), "does not resolve");
  refused(
    adr(
      "init",
      dir,
      "--title",
      "T",
      "--kind",
      "vibe",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
    ),
    "--kind must be one of",
  );
  refused(
    adr(
      "init",
      dir,
      "--title",
      "T",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
      "--date",
      "yesterday",
    ),
    "--date must be YYYY-MM-DD",
  );
  refused(
    adr("init", `${dir}/missing`, ...base.slice(2), "--arises-from", "pdf-verify.yamlet.yaml#RQ-1"),
    "existing directory",
  );
  assertEquals([...Deno.readDirSync(dir)].map((e) => e.name), ["pdf-verify.yamlet.yaml"]);

  const r = ok(
    adr(...base, "--arises-from", "pdf-verify.yamlet.yaml#RQ-1", "--date", "2026-09-07"),
    "init",
  );
  assertEquals(r.stdout, `${dir}/ADR-0001-t.adr.yaml\n`);
  assertEquals(
    Deno.readTextFileSync(`${dir}/ADR-0001-t.adr.yaml`),
    "adr: ADR-0001\ntitle: T\nstatus: proposed\ndate: 2026-09-07\nkind: policy\narises_from:\n- pdf-verify.yamlet.yaml#RQ-1\n\nquestion: >-\n  Q?\n",
  );
  // The next record takes the next id, whatever the file is called.
  const r2 = ok(
    adr(...base, "--arises-from", "pdf-verify.yamlet.yaml#RQ-2", "--date", "2026-09-07"),
    "init 2",
  );
  assertEquals(r2.stdout, `${dir}/ADR-0002-t.adr.yaml\n`);
});

Deno.test("phase order: basis before dimensions before options; matrices are atomic", () => {
  const dir = workDir();
  const A = ok(
    adr(
      "init",
      dir,
      "--title",
      "Order",
      "--kind",
      "mechanism",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
      "--date",
      "2026-09-07",
    ),
    "init",
  ).stdout.trim();
  refused(
    adr("add-option", A, "--summary", "x", "--reversibility", "reversible"),
    "declare the dimensions before the options",
  );
  refused(adr("add-basis", A, "--quantity", "no numeral", "--source", "s"), "must carry a numeral");
  ok(adr("add-basis", A, "--quantity", "10 things", "--source", "s"), "B-1");
  refused(adr("add-dimension", A, "--matters", "m", "--unit", "EUR"), "--unit needs --source");
  refused(adr("add-dimension", A, "--matters", "m", "--basis", "B-1"), "--basis needs --unit");
  refused(
    adr("add-dimension", A, "--matters", "m", "--unit", "EUR", "--source", "s"),
    "must name the basis",
  );
  refused(
    adr("add-dimension", A, "--matters", "m", "--unit", "EUR", "--source", "s", "--basis", "B-9"),
    "no such basis",
  );
  ok(
    adr(
      "add-dimension",
      A,
      "--matters",
      "measured",
      "--unit",
      "EUR",
      "--source",
      "s",
      "--basis",
      "B-1",
    ),
    "D-1",
  );
  ok(adr("add-dimension", A, "--matters", "plain"), "D-2");
  refused(adr("add-basis", A, "--quantity", "2 late", "--source", "s"), "before the dimensions");

  refused(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "someday",
      "--against",
      "D-1=1",
      "--against",
      "D-2=y",
    ),
    "--reversibility must be one of",
  );
  refused(
    adr("add-option", A, "--summary", "x", "--reversibility", "reversible", "--against", "D-1=1"),
    "missing: D-2",
  );
  refused(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--against",
      "D-1=1",
      "--against",
      "D-2=y",
      "--against",
      "D-2=z",
    ),
    "given twice",
  );
  refused(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--against",
      "D-1=1",
      "--against",
      "D-3=y",
    ),
    "no such dimension: D-3",
  );
  refused(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--against",
      "D-1=about twenty",
      "--against",
      "D-2=y",
    ),
    "needs a numeral",
  );
  refused(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--against",
      "D-1=n/a",
      "--against",
      "D-2=y",
    ),
    "bare n/a",
  );
  refused(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--against",
      "D-1=n/a — D-2 excludes it",
      "--against",
      "D-2=n/a — unpriced",
    ),
    "not substantive",
  );
  refused(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--ref",
      "docs=A long description of the product that is really prose and not a locator at all.",
      "--against",
      "D-1=1",
      "--against",
      "D-2=y",
    ),
    "must be a locator",
  );
  ok(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--against",
      "D-1=n/a — D-2 excludes it",
      "--against",
      "D-2=too weak",
    ),
    "OPT-1",
  );
  refused(adr("add-dimension", A, "--matters", "late"), "missing: OPT-1");
  ok(
    adr(
      "add-option",
      A,
      "--summary",
      "y",
      "--reversibility",
      "one-way",
      "--against",
      "D-1=12 per unit, see B-1",
      "--against",
      "D-2=fine",
    ),
    "OPT-2",
  );
  refused(adr("decide", A, "OPT-9"), "no such option");
  refused(adr("add-revisit", A, "cost exceeds the assumption"), "must quantify it");
  ok(adr("add-revisit", A, "cost exceeds 12 per unit"), "revisit");
  assertEquals(
    verifyFile(A).exitCode,
    0,
    "a proposed record with two options and no decision verifies",
  );
});

Deno.test("selection requires refs on every option", () => {
  const dir = workDir();
  const A = ok(
    adr(
      "init",
      dir,
      "--title",
      "Pick",
      "--kind",
      "selection",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
    ),
    "init",
  ).stdout.trim();
  ok(adr("add-dimension", A, "--matters", "fit"), "D-1");
  refused(
    adr("add-option", A, "--summary", "x", "--reversibility", "reversible", "--against", "D-1=ok"),
    "needs at least one --ref",
  );
  ok(
    adr(
      "add-option",
      A,
      "--summary",
      "x",
      "--reversibility",
      "reversible",
      "--ref",
      "project=https://example.org/x",
      "--against",
      "D-1=ok",
    ),
    "OPT-1",
  );
});

Deno.test("accept needs a decision and a clean record, then freezes it; supersede is the way on", () => {
  const dir = workDir();
  const A = ok(
    adr(
      "init",
      dir,
      "--title",
      "Freeze",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
      "--date",
      "2026-09-01",
    ),
    "init",
  ).stdout.trim();
  ok(adr("add-dimension", A, "--matters", "fit"), "D-1");
  ok(
    adr("add-option", A, "--summary", "a", "--reversibility", "reversible", "--against", "D-1=ok"),
    "OPT-1",
  );
  // One option: accept is refused by the strict gate, with the rule named.
  ok(adr("decide", A, "OPT-1"), "decide");
  const one = adr("accept", A);
  refused(one, "E811");
  ok(
    adr("add-option", A, "--summary", "b", "--reversibility", "reversible", "--against", "D-1=meh"),
    "OPT-2",
  );
  const before = Deno.readTextFileSync(A);
  ok(adr("accept", A, "--date", "2026-09-07"), "accept");
  const after = Deno.readTextFileSync(A);
  assertEquals(
    after,
    before.replace("status: proposed\ndate: 2026-09-01", "status: accepted\ndate: 2026-09-07"),
  );

  // Frozen: every content mutation is refused, the file is untouched.
  for (
    const args of [
      ["add-force", A, "late"],
      ["add-basis", A, "--quantity", "1", "--source", "s"],
      ["add-dimension", A, "--matters", "late"],
      ["add-option", A, "--summary", "c", "--reversibility", "reversible", "--against", "D-1=x"],
      ["decide", A, "OPT-2"],
      ["add-obligation", A, "late"],
      ["add-accept", A, "late"],
      ["add-revisit", A, "late"],
      ["remove", A, "D-1"],
      ["remove", A, "--force", "1"],
      [
        "replace",
        A,
        "OPT-2",
        "--summary",
        "c",
        "--reversibility",
        "reversible",
        "--against",
        "D-1=x",
      ],
      ["replace", A, "--revisit", "1", "late"],
      ["accept", A],
      ["reject", A, "--reason", "late"],
    ]
  ) {
    refused(adr(...args), "only possible while proposed");
  }
  assertEquals(Deno.readTextFileSync(A), after);

  // Supersede: needs a later record in the same directory.
  refused(adr("supersede", A, "--by", "ADR-0002"), "does not resolve");
  const B = ok(
    adr(
      "init",
      dir,
      "--title",
      "Freeze revised",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--assumes",
      "ADR-0001",
      "--date",
      "2026-09-07",
    ),
    "init B",
  ).stdout.trim();
  refused(adr("supersede", B, "--by", "ADR-0001"), "only an accepted record can be superseded");
  ok(adr("supersede", A, "--by", "ADR-0002", "--date", "2026-09-08"), "supersede");
  assertStringIncludes(
    Deno.readTextFileSync(A),
    "status: superseded\ndate: 2026-09-08\nkind: policy\narises_from:\n- pdf-verify.yamlet.yaml#RQ-1\nsuperseded_by: ADR-0002\n",
  );
  assertEquals(verifyFile(A).exitCode, 0);
  refused(adr("supersede", A, "--by", "ADR-0002"), "only an accepted record");

  // Reject: from proposed only, and only with a reason, which the record keeps.
  refused(adr("reject", B, "--date", "2026-09-09"), "requires --reason");
  ok(
    adr("reject", B, "--reason", "The question was: moot.", "--date", "2026-09-09"),
    "reject",
  );
  assertStringIncludes(
    Deno.readTextFileSync(B),
    "status: rejected\ndate: 2026-09-09\n",
  );
  assertStringIncludes(
    Deno.readTextFileSync(B),
    "assumes:\n- ADR-0001\nrejected_because: >-\n  The question was: moot.\n",
  );
  assertEquals(verifyFile(B).result.errors.filter((f) => f.rule === "E804"), []);
  refused(adr("reject", B, "--reason", "again"), "only possible while proposed");
});

Deno.test("an accepted record may not assume a proposed one", () => {
  const dir = workDir();
  const A = ok(
    adr(
      "init",
      dir,
      "--title",
      "Base",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
    ),
    "init",
  ).stdout.trim();
  ok(adr("add-dimension", A, "--matters", "fit"), "D-1");
  ok(
    adr("add-option", A, "--summary", "a", "--reversibility", "reversible", "--against", "D-1=ok"),
    "OPT-1",
  );
  ok(
    adr("add-option", A, "--summary", "b", "--reversibility", "reversible", "--against", "D-1=ok"),
    "OPT-2",
  );
  ok(adr("decide", A, "OPT-1"), "decide");
  const B = ok(
    adr(
      "init",
      dir,
      "--title",
      "On top",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--assumes",
      "ADR-0001",
    ),
    "init B",
  ).stdout.trim();
  ok(adr("add-dimension", B, "--matters", "fit"), "D-1");
  ok(
    adr("add-option", B, "--summary", "a", "--reversibility", "reversible", "--against", "D-1=ok"),
    "OPT-1",
  );
  ok(
    adr("add-option", B, "--summary", "b", "--reversibility", "reversible", "--against", "D-1=ok"),
    "OPT-2",
  );
  ok(adr("decide", B, "OPT-2"), "decide");
  refused(adr("accept", B), "may not assume ADR-0001, which is proposed");
  ok(adr("accept", A), "accept A");
  ok(adr("accept", B), "accept B");
});

Deno.test("dispatch and text arguments", () => {
  assertEquals(runAdr([]).exitCode, 2);
  assertStringIncludes(runAdr(["bogus"]).stderr, "Unknown adr subcommand: bogus");
  const dir = workDir();
  const A = ok(
    adr(
      "init",
      dir,
      "--title",
      "Text",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
    ),
    "init",
  ).stdout.trim();
  refused(adr("add-force", A), "requires TEXT");
  refused(adr("add-force", A, "x", "--bogus", "y"), "unknown flag");
  refused(adr("add-force", `${dir}/nope.adr.yaml`, "x"), "file not found");
  // Unquoted words are joined; newlines fold to one line.
  ok(adr("add-force", A, "two", "words"), "force");
  ok(adr("add-force", A, "line one\n  line two"), "force");
  assertStringIncludes(
    Deno.readTextFileSync(A),
    "forces:\n- >-\n  two words\n- >-\n  line one line two\n",
  );
});

/** A proposed policy record: D-1 plain, D-2 measured in EUR, OPT-1 and OPT-2 judged on both. */
function draft(dir: string): string {
  const A = ok(
    adr(
      "init",
      dir,
      "--title",
      "Draft",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
      "--date",
      "2026-09-07",
    ),
    "init",
  ).stdout.trim();
  ok(adr("add-force", A, "first force"), "force 1");
  ok(adr("add-force", A, "second force"), "force 2");
  ok(adr("add-basis", A, "--quantity", "10 users", "--source", "s"), "B-1");
  ok(adr("add-dimension", A, "--matters", "fit"), "D-1");
  ok(
    adr(
      "add-dimension",
      A,
      "--matters",
      "cost",
      "--unit",
      "EUR",
      "--source",
      "s",
      "--basis",
      "B-1",
    ),
    "D-2",
  );
  ok(
    adr(
      "add-option",
      A,
      "--summary",
      "a",
      "--reversibility",
      "reversible",
      "--against",
      "D-1=good",
      "--against",
      "D-2=10",
    ),
    "OPT-1",
  );
  ok(
    adr(
      "add-option",
      A,
      "--summary",
      "b",
      "--reversibility",
      "costly",
      "--against",
      "D-1=poor",
      "--against",
      "D-2=n/a — D-1 excludes it",
    ),
    "OPT-2",
  );
  return A;
}

Deno.test("a dimension added after options judges every one of them in the same call", () => {
  const A = draft(workDir());
  refused(adr("add-dimension", A, "--matters", "late"), "missing: OPT-1, OPT-2");
  refused(
    adr("add-dimension", A, "--matters", "late", "--against", "OPT-1=x", "--against", "OPT-9=y"),
    "no such option: OPT-9",
  );
  refused(
    adr(
      "add-dimension",
      A,
      "--matters",
      "late",
      "--unit",
      "ms",
      "--source",
      "s",
      "--basis",
      "B-1",
      "--against",
      "OPT-1=fast",
      "--against",
      "OPT-2=5",
    ),
    "OPT-1/D-3 is measured in ms; the cell needs a numeral",
  );
  refused(
    adr("add-dimension", A, "--matters", "late", "--against", "OPT-1=x", "--against", "OPT-2=n/a"),
    "OPT-2/D-3: a bare n/a",
  );
  const out = ok(
    adr(
      "add-dimension",
      A,
      "--matters",
      "late",
      "--against",
      "OPT-1=fine",
      "--against",
      "OPT-2=n/a — D-1 excludes it",
    ),
    "D-3",
  );
  assertEquals(out.stdout, "D-3\n");
  const text = Deno.readTextFileSync(A);
  assertStringIncludes(text, "    D-2: >-\n      10\n    D-3: >-\n      fine\n");
  assertEquals(verifyFile(A).exitCode, 0);
  // Before any option, --against has nothing to judge.
  const dir = workDir();
  const B = ok(
    adr(
      "init",
      dir,
      "--title",
      "E",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--arises-from",
      "pdf-verify.yamlet.yaml#RQ-1",
    ),
    "init",
  ).stdout.trim();
  refused(adr("add-dimension", B, "--matters", "m", "--against", "OPT-1=x"), "no such option");
});

Deno.test("remove drops one element of a proposed record and refuses what would dangle", () => {
  const A = draft(workDir());
  refused(adr("remove", A), "needs an id");
  refused(adr("remove", A, "X-1"), "needs an id");
  refused(adr("remove", A, "D-9"), "no such dimension: D-9 (this record has D-1, D-2)");
  refused(adr("remove", A, "--force", "3"), "no such entry: --force 3 (this record has 2");
  refused(adr("remove", A, "--force", "0"), "counted from 1");
  refused(adr("remove", A, "--force", "1", "--revisit", "1"), "not several");
  refused(adr("remove", A, "D-1", "D-2"), "too many arguments: D-2");
  refused(adr("replace", A, "D-1", "--force", "1", "text"), "takes an id or --force, not both");
  refused(adr("remove", A, "B-1"), "B-1 is the basis of D-2");
  // OPT-2's D-2 cell cites D-1 as excluding it: D-1 cannot go while that stands.
  refused(adr("remove", A, "D-1"), "would leave OPT-2/D-2: cites D-1");

  ok(adr("decide", A, "OPT-1"), "decide");
  refused(adr("remove", A, "OPT-1"), "OPT-1 is the decision");
  ok(adr("add-obligation", A, "do it"), "R-1");
  // Prose still naming an element holds it in place; a citation of another record's R-n does not.
  ok(adr("add-revisit", A, "OPT-2 drops below 5 EUR, see ADR-0009#R-1"), "revisit");
  refused(adr("remove", A, "OPT-2"), "OPT-2 is still named in revisit 1");
  ok(adr("remove", A, "--revisit", "1"), "remove revisit 1");
  ok(adr("add-accept", A, "cost one"), "accept 1");
  ok(adr("add-accept", A, "cost two"), "accept 2");

  ok(adr("remove", A, "--force", "1"), "remove force 1");
  ok(adr("remove", A, "--accept", "2"), "remove accept 2");
  ok(adr("remove", A, "R-1"), "remove R-1");
  ok(adr("remove", A, "OPT-2"), "remove OPT-2");
  ok(adr("remove", A, "D-2"), "remove D-2: its cells go with it");
  ok(adr("remove", A, "B-1"), "remove B-1: no longer used");
  const text = Deno.readTextFileSync(A);
  assertStringIncludes(text, "forces:\n- >-\n  second force\n");
  assertStringIncludes(text, "accepts:\n- >-\n  cost one\n");
  for (const gone of ["first force", "cost two", "R-1", "OPT-2", "D-2", "B-1", "basis:"]) {
    assertEquals(text.includes(gone), false, `${gone} should be gone:\n${text}`);
  }
  assertStringIncludes(text, "  against:\n    D-1: >-\n      good\n");
  // One option left: the draft carries the in-progress E811, and nothing else.
  ok(
    adr("add-option", A, "--summary", "c", "--reversibility", "reversible", "--against", "D-1=ok"),
    "OPT-3",
  );
  assertEquals(verifyFile(A).exitCode, 0);
});

Deno.test("replace rewrites one element in place under the same id", () => {
  const A = draft(workDir());
  ok(adr("decide", A, "OPT-2"), "decide");

  // Options: the whole option, as add-option takes it; the decision still points at it.
  refused(
    adr(
      "replace",
      A,
      "OPT-2",
      "--summary",
      "b2",
      "--reversibility",
      "costly",
      "--against",
      "D-1=x",
    ),
    "missing: D-2",
  );
  refused(
    adr("replace", A, "OPT-2", "--matters", "m"),
    "--matters does not apply to replacing OPT-2",
  );
  ok(
    adr(
      "replace",
      A,
      "OPT-2",
      "--summary",
      "b2",
      "--reversibility",
      "one-way",
      "--against",
      "D-1=still poor",
      "--against",
      "D-2=12",
    ),
    "replace OPT-2",
  );
  let text = Deno.readTextFileSync(A);
  assertStringIncludes(text, "- id: OPT-2\n  summary: >-\n    b2\n  reversibility: one-way\n");
  assertStringIncludes(text, "decision: OPT-2\n");

  // Dimensions: a new unit that leaves a cell without a numeral must re-judge it.
  refused(
    adr("replace", A, "D-1", "--matters", "fit", "--unit", "ms", "--source", "s", "--basis", "B-1"),
    "OPT-1/D-1 is measured in ms; the cell needs a numeral: good; re-judge that cell",
  );
  refused(adr("replace", A, "D-1", "--matters", "m", "--against", "OPT-7=1"), "no such option");
  ok(
    adr(
      "replace",
      A,
      "D-1",
      "--matters",
      "latency",
      "--unit",
      "ms",
      "--source",
      "s",
      "--basis",
      "B-1",
      "--against",
      "OPT-1=20",
      "--against",
      "OPT-2=40",
    ),
    "replace D-1",
  );
  text = Deno.readTextFileSync(A);
  assertStringIncludes(text, "- id: D-1\n  matters: >-\n    latency\n  unit: ms\n");
  assertStringIncludes(text, "    D-1: >-\n      20\n    D-2: >-\n      10\n");
  assertStringIncludes(text, "    D-1: >-\n      40\n    D-2: >-\n      12\n");

  // Basis, obligations and the id-less lists.
  refused(adr("replace", A, "B-1", "--quantity", "many", "--source", "s"), "must carry a numeral");
  ok(adr("replace", A, "B-1", "--quantity", "20 users", "--source", "t"), "replace B-1");
  ok(adr("add-obligation", A, "do it"), "R-1");
  refused(adr("replace", A, "R-1"), "requires TEXT");
  ok(adr("replace", A, "R-1", "do it", "properly"), "replace R-1");
  ok(adr("replace", A, "--force", "2", "a", "better", "force"), "replace force 2");
  ok(adr("add-revisit", A, "cost exceeds 12 EUR"), "revisit");
  refused(adr("replace", A, "--revisit", "1", "cost exceeds the budget"), "must quantify it");
  ok(adr("replace", A, "--revisit", "1", "cost exceeds 15 EUR"), "replace revisit 1");
  text = Deno.readTextFileSync(A);
  assertStringIncludes(text, "- id: B-1\n  quantity: 20 users\n");
  assertStringIncludes(text, "- id: R-1\n  must: >-\n    do it properly\n");
  assertStringIncludes(text, "forces:\n- >-\n  first force\n- >-\n  a better force\n");
  assertStringIncludes(text, "revisit:\n- >-\n  cost exceeds 15 EUR\n");
  assertEquals(verifyFile(A).exitCode, 0);
  ok(adr("accept", A), "accept");
});

Deno.test("an obligation another record cites can be neither removed nor replaced", () => {
  const dir = workDir();
  const A = draft(dir);
  ok(adr("decide", A, "OPT-1"), "decide");
  ok(adr("add-obligation", A, "one"), "R-1");
  ok(adr("add-obligation", A, "two"), "R-2");
  const B = ok(
    adr(
      "init",
      dir,
      "--title",
      "B",
      "--kind",
      "policy",
      "--question",
      "Q?",
      "--assumes",
      "ADR-0001",
    ),
    "init B",
  ).stdout.trim();
  ok(adr("add-force", B, "ADR-0001#R-1 holds."), "force citing R-1");
  refused(adr("remove", A, "R-1"), "ADR-0001#R-1 is cited by ADR-0002");
  refused(adr("replace", A, "R-1", "other"), "ADR-0001#R-1 is cited by ADR-0002");
  // Its own forces count too: the gate reads the file before the write, so only this catches it.
  ok(adr("add-force", A, "ADR-0001#R-2 constrains this."), "self-citation");
  refused(adr("remove", A, "R-2"), "ADR-0001#R-2 is cited by ADR-0001");
  ok(adr("remove", A, "--force", "3"), "drop the self-citation");
  // R-2 is uncited — and R-1 must not match a citation of R-10.
  ok(adr("replace", A, "R-2", "two, reworded"), "replace R-2");
  ok(adr("remove", A, "R-2"), "remove R-2");
});
