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
  refused(adr("add-dimension", A, "--matters", "late"), "before the options");
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
      ["accept", A],
      ["reject", A],
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

  // Reject: from proposed only.
  ok(adr("reject", B, "--date", "2026-09-09"), "reject");
  assertStringIncludes(Deno.readTextFileSync(B), "status: rejected\ndate: 2026-09-09\n");
  refused(adr("reject", B), "only possible while proposed");
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
