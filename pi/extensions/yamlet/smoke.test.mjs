// smoke.test.mjs — exercises the yamlet extension against a mock `pi` handle.
//
// Covers the three places a silent bug would live: the argv each tool builds (a
// wrong flag order or a dropped repeatable would corrupt specs quietly), the
// tool_call gate (a false negative would let a spec be hand-edited), and the
// availability probe.
//
// THE MOCK MUST MATCH pi's REAL `exec` SEMANTICS, which are surprising and were
// got wrong once already:
//   - it NEVER rejects — `execCommand` resolves in both its .then and .catch;
//   - a missing binary is NOT 127 and does not throw: spawn ENOENT resolves as
//     `{ code: 1, stdout: "", stderr: "" }`, indistinguishable from a genuine
//     exit 1, which is why the extension checks PATH itself;
//   - a killed run (timeout/abort) reports `{ code: 0, killed: true }`, because
//     a signal death has a null exit code that pi coerces to 0.
// A mock that throws ENOENT validates a path that cannot happen in production.
//
// Run it with the pi peer deps resolvable — from a directory where
// `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `typebox` are
// installed:
//
//     npx tsx pi/extensions/yamlet/smoke.test.mjs
//
// It must resolve as ESM: @earendil-works/pi-coding-agent exports only an
// "import" condition, so a CJS resolution fails with ERR_PACKAGE_PATH_NOT_EXPORTED.
// pi/package.json declares "type": "module", which is what makes that work (and
// is correct regardless — the extension uses import.meta.url).
//
// Exits non-zero if any assertion fails. `.github/workflows/pi-port.yml` runs it
// on every PR against the latest published pi.

import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ext from "./index.ts";

// Package root, resolved from this file so the suite runs from any cwd.
const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `yamlet — verify and author yamlet specs

Commands:
  verify            check a spec (or a tech spec) against the rule catalog
  version           print the yamlet version
  systems           list existing systems grouped by their scope files
  impact            list the composites that consume a spec (reverse dependency index)
  graph             write a DOT, JSON, or HTML graph model of a spec or a directory to a file
  tests             project spec acceptance criteria into Gherkin feature files
  init              create a new spec, correct by construction
  add-component     declare a composite member (echoes its contract)
  add-connection    wire a composite member's inputs (or the composite outputs)
  add-requirement   append a requirement to a spec (prints RQ-N)
  add-criterion     append an acceptance criterion (prints AC-N)
  add-adr           link an ADR to a requirement or criterion
  techspec          build a spec's gap analysis and task list (a disposable .techspec.yaml)
  adr               write a decision record (.adr.yaml), correct by construction
`;

// The release before tech specs and decision records: every authoring command,
// none of the planning ones.
const HELP_0_2_3 = HELP.replace(/  add-adr .*\n/, "").replace(/  techspec .*\n/, "").replace(/  adr .*\n/, "");

// A directory holding an executable `yamlet`, so findOnPath() resolves it.
const BIN = mkdtempSync(join(tmpdir(), "yamlet-smoke-"));
writeFileSync(join(BIN, "yamlet"), "#!/bin/sh\nexit 0\n");
chmodSync(join(BIN, "yamlet"), 0o755);
const REAL_PATH = process.env.PATH;

let failures = 0;
const ok = (label, cond, extra = "") => {
	if (!cond) failures++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : "  <<< " + extra}`);
};

/**
 * @param onPath      is a `yamlet` binary resolvable? (drives findOnPath)
 * @param help        stdout for `yamlet help`
 * @param code/stdout/stderr result for every other yamlet invocation
 * @param killed      simulate a timeout/abort
 * @param git         result for `git rev-parse --short HEAD` (the analysis tool's commit source)
 */
function makePi({
	onPath = true, help = HELP, code = 0, stdout = "AC-3\n", stderr = "", killed = false, helpKilled = false,
	git = { stdout: "9f3c1ab\n", stderr: "", code: 0, killed: false },
} = {}) {
	process.env.PATH = onPath ? BIN : "";
	const calls = [];
	const handlers = {};
	const tools = new Map();
	// Mutable, so a test can "upgrade the CLI" between calls.
	const cli = { help };
	const pi = {
		on: (name, fn) => { handlers[name] = fn; },
		registerTool: (t) => tools.set(t.name, t),
		// No Agent tool here: the agent-install offer is exercised separately in §6.
		getAllTools: () => [],
		// Never throws — mirrors execCommand.
		exec: async (cmd, args) => {
			calls.push([cmd, ...args]);
			if (cmd === "git") return git;
			if (!onPath) return { stdout: "", stderr: "", code: 1, killed: false };
			if (args[0] === "--version") return { stdout: "yamlet 0.4.1\n", stderr: "", code: 0, killed: false };
			if (args[0] === "help") {
				return helpKilled
					? { stdout: "", stderr: "", code: 0, killed: true }
					: { stdout: cli.help, stderr: "", code: 0, killed: false };
			}
			return killed
				? { stdout: "", stderr: "", code: 0, killed: true }
				: { stdout, stderr, code, killed: false };
		},
	};
	ext(pi);
	return { pi, calls, handlers, tools, cli };
}

const notes = [];
const ctx = { cwd: "/repo", ui: { notify: (m, t) => notes.push([t, m]) } };
const resetNotes = () => (notes.length = 0);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. registration ────────────────────────────────────────────────────────
{
	const { tools } = makePi();
	const names = [...tools.keys()].sort();
	ok("28 tools registered", names.length === 28, names.join(","));
	ok("impact and guide are registered",
		names.includes("yamlet_impact") && names.includes("yamlet_guide"), names.join(","));
	const planning = [
		"yamlet_add_adr",
		"yamlet_techspec_init", "yamlet_techspec_analysis", "yamlet_techspec_criterion", "yamlet_techspec_task",
		"yamlet_adr_init", "yamlet_adr_add_force", "yamlet_adr_add_basis", "yamlet_adr_add_dimension",
		"yamlet_adr_add_option", "yamlet_adr_decide", "yamlet_adr_add_obligation", "yamlet_adr_add_accept",
		"yamlet_adr_add_revisit", "yamlet_adr_accept", "yamlet_adr_reject", "yamlet_adr_supersede",
	];
	ok("one tool per techspec/adr subcommand", planning.every((n) => names.includes(n)),
		planning.filter((n) => !names.includes(n)).join(","));
}

// ── 2. argv construction ───────────────────────────────────────────────────
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_add_criterion").execute("id", {
		file: "specs/e.yamlet.yaml", rq: "RQ-1", pattern: "complex",
		while: ["{n} retries attempted", "the queue is draining"],
		if: "an SMTP timeout occurs",
		shall: ["schedule a retry with {delay_seconds}s backoff", "emit a metric"],
		examples: ["n=0;delay_seconds=10", "n=1;delay_seconds=30"],
	}, undefined, undefined, ctx);
	const expected = ["yamlet", "add-criterion", "specs/e.yamlet.yaml", "--rq", "RQ-1", "--pattern", "complex",
		"--if", "an SMTP timeout occurs",
		"--while", "{n} retries attempted", "--while", "the queue is draining",
		"--shall", "schedule a retry with {delay_seconds}s backoff", "--shall", "emit a metric",
		"--example", "n=0;delay_seconds=10", "--example", "n=1;delay_seconds=30"];
	ok("add_criterion argv", same(calls.at(-1), expected), JSON.stringify(calls.at(-1)));
}
{
	// `after` inserts behind a named sibling; it must land before the clause flags.
	const { tools, calls } = makePi();
	await tools.get("yamlet_add_criterion").execute("id", {
		file: "specs/e.yamlet.yaml", rq: "RQ-1", after: "AC-1", pattern: "event",
		when: "a send is retried", shall: ["log the retry attempt"],
	}, undefined, undefined, ctx);
	const expected = ["yamlet", "add-criterion", "specs/e.yamlet.yaml", "--rq", "RQ-1", "--pattern", "event",
		"--after", "AC-1", "--when", "a send is retried", "--shall", "log the retry attempt"];
	ok("add_criterion --after argv", same(calls.at(-1), expected), JSON.stringify(calls.at(-1)));
}
{
	// Omitting `after` must not emit the flag at all — an empty --after would be
	// a usage error rather than an append.
	const { tools, calls } = makePi();
	await tools.get("yamlet_add_criterion").execute("id", {
		file: "specs/e.yamlet.yaml", rq: "RQ-1", pattern: "ubiquitous", shall: ["do a thing"],
	}, undefined, undefined, ctx);
	ok("add_criterion omits --after when not given", !calls.at(-1).includes("--after"),
		JSON.stringify(calls.at(-1)));
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_systems").execute("id", {
		dir: "specs", system: "e-mail-sending-service", details: true, contracts: true,
	}, undefined, undefined, ctx);
	const expected = ["yamlet", "systems", "specs", "--system=e-mail-sending-service", "--details", "--contracts"];
	ok("systems --details argv", same(calls.at(-1), expected), JSON.stringify(calls.at(-1)));
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_impact").execute("id", {
		file: "@specs/up.yamlet.yaml", dir: "specs", format: "json",
	}, undefined, undefined, ctx);
	const expected = ["yamlet", "impact", "specs/up.yamlet.yaml", "specs", "--format=json"];
	ok("impact argv (and strips leading @)", same(calls.at(-1), expected), JSON.stringify(calls.at(-1)));
}
{
	// `out` is required by the schema and always reaches the CLI: the payload has
	// no path back into context, and a dropped --out would restore the ~1.6 MB
	// stdout that this flag exists to prevent.
	const { tools, calls } = makePi();
	await tools.get("yamlet_graph").execute("id", {
		target: "@specs", out: "@build/graph.html", format: "html", libs: "cdn", recursive: true,
	}, undefined, undefined, ctx);
	const expected = [
		"yamlet", "graph", "specs", "--out=build/graph.html", "--format=html", "--libs=cdn", "--recursive",
	];
	ok("graph argv (always passes --out)", same(calls.at(-1), expected), JSON.stringify(calls.at(-1)));

	ok("graph schema requires out", tools.get("yamlet_graph").parameters.required?.includes("out") === true,
		JSON.stringify(tools.get("yamlet_graph").parameters.required));
}

// ── 2b. yamlet_guide serves the skills' procedures ─────────────────────────
// The whole point of this tool is that the extension knows where it lives and a
// skill does not. So the assertion that matters is that it resolves the REAL
// shipped file, not a stub — if the references move, this fails.
{
	const { tools } = makePi();
	const where = {
		creating: ["skills", "yamlet-author", "references", "creating.md"],
		editing: ["skills", "yamlet-author", "references", "editing.md"],
		composites: ["skills", "yamlet-author", "references", "composites.md"],
		patterns: ["skills", "yamlet-author", "references", "patterns.md"],
		decisions: ["skills", "yamlet-techspec", "references", "decisions.md"],
		// The degraded path: no pi-subagents, so a gate (or the research) runs
		// inline and needs the agent's own procedure rather than the model's
		// memory of it.
		"contract-challenge": ["agents", "yamlet-contract-challenger.md"],
		"criteria-challenge": ["agents", "yamlet-criteria-challenger.md"],
		"code-research": ["agents", "yamlet-code-research.md"],
		"evidence-challenge": ["agents", "yamlet-evidence-challenger.md"],
		"adr-challenge": ["agents", "yamlet-adr-challenger.md"],
	};
	for (const [topic, parts] of Object.entries(where)) {
		const res = await tools.get("yamlet_guide").execute("id", { topic }, undefined, undefined, ctx);
		const text = res.content[0].text;
		const onDisk = readFileSync(join(PKG, ...parts), "utf8");
		ok(`guide serves ${topic} verbatim`, text === onDisk && text.length > 0, `${text.length} chars`);
	}
	const topics = tools.get("yamlet_guide").parameters.properties.topic.enum ?? [];
	ok("guide offers exactly the topics it can serve", same([...topics].sort(), Object.keys(where).sort()),
		JSON.stringify(topics));
}
{
	// It reads a bundled file, so it must not depend on the CLI being installed:
	// the procedure has to be readable even while the user is still setting up.
	const { tools, calls } = makePi({ onPath: false });
	const res = await tools.get("yamlet_guide").execute("id", { topic: "creating" }, undefined, undefined, ctx);
	ok("guide works without the yamlet CLI on PATH", res.content[0].text.length > 0);
	ok("guide shells out to nothing", calls.length === 0, JSON.stringify(calls));
}
{
	// A missing procedure must say what to do, not return an empty string that
	// the model would then paper over by inventing the steps.
	const { tools } = makePi();
	let msg = "";
	try {
		await tools.get("yamlet_guide").execute("id", { topic: "nope" }, undefined, undefined, ctx);
	} catch (e) {
		msg = e.message;
	}
	ok("missing guide throws an actionable error",
		msg.includes("could not be read") && msg.includes("Reinstall") && msg.includes("Do NOT proceed"), msg);
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_init").execute("id", {
		file: "@specs/u.yamlet.yaml", system: "pdf", topic: "Upload", summary: "s", description: "d",
		blast_radius: "high", front: "external", expose_name: "pdf-upload", expose_intent: "verify",
		inputs: ["file", "filename"], outputs: ["pdf_file"],
	}, undefined, undefined, ctx);
	const a = calls.at(-1);
	ok("init strips leading @", a[2] === "specs/u.yamlet.yaml", JSON.stringify(a.slice(0, 3)));
	ok("init repeats --input/--output",
		same(a.slice(-6), ["--input", "file", "--input", "filename", "--output", "pdf_file"]),
		JSON.stringify(a.slice(-6)));
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_add_connection").execute("id", {
		file: "c.yamlet.yaml", group: "uploads",
		wires: [{ socket: "file", source: "input.file" }, { socket: "attachment", source: "uploads.pdf_file" }],
	}, undefined, undefined, ctx);
	ok("add_connection SOCKET=SOURCE",
		same(calls.at(-1).slice(-2), ["file=input.file", "attachment=uploads.pdf_file"]),
		JSON.stringify(calls.at(-1)));
}

// ── 2c. the planning tools: add-adr, techspec, adr ─────────────────────────
// Same discipline as §2: the argv is the contract with the CLI, and the CLI
// parses positionals and flags strictly (an unknown flag is exit 2).
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_add_adr").execute("id", {
		file: "@specs/pdf.yamlet.yaml", adr: "@../adr/ADR-0007-parser.adr.yaml", rq: "RQ-5",
	}, undefined, undefined, ctx);
	ok("add_adr --rq argv",
		same(calls.at(-1), ["yamlet", "add-adr", "specs/pdf.yamlet.yaml", "../adr/ADR-0007-parser.adr.yaml", "--rq", "RQ-5"]),
		JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_add_adr").execute("id", {
		file: "specs/pdf.yamlet.yaml", adr: "../adr/ADR-0007-parser.adr.yaml", ac: "AC-8",
	}, undefined, undefined, ctx);
	ok("add_adr --ac argv", same(calls.at(-1).slice(-2), ["--ac", "AC-8"]), JSON.stringify(calls.at(-1)));
	// The CLI takes exactly one of the two; the tool refuses before running so
	// the model is told which parameter to drop, not handed a usage dump.
	for (const input of [{}, { rq: "RQ-1", ac: "AC-1" }]) {
		let msg = "";
		try {
			await tools.get("yamlet_add_adr").execute("id", { file: "s.yamlet.yaml", adr: "a.adr.yaml", ...input },
				undefined, undefined, ctx);
		} catch (e) { msg = e.message; }
		ok(`add_adr refuses ${JSON.stringify(input)} before running`,
			msg.includes("exactly one") && !calls.at(-1).includes("a.adr.yaml"), msg || JSON.stringify(calls.at(-1)));
	}
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_techspec_init").execute("id", { spec: "@specs/pdf.yamlet.yaml" }, undefined, undefined, ctx);
	ok("techspec_init argv (no --out unless given)",
		same(calls.at(-1), ["yamlet", "techspec", "init", "specs/pdf.yamlet.yaml"]), JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_techspec_init").execute("id", {
		spec: "specs/pdf.yamlet.yaml", out: "@plan/pdf.techspec.yaml",
	}, undefined, undefined, ctx);
	ok("techspec_init --out argv", same(calls.at(-1).slice(-2), ["--out", "plan/pdf.techspec.yaml"]),
		JSON.stringify(calls.at(-1)));
}
{
	// The commit is read from git, not from the model, when the file has none yet.
	const home = mkdtempSync(join(tmpdir(), "yamlet-ts-"));
	const tctx = { ...ctx, cwd: home };
	const { tools, calls } = makePi();
	await tools.get("yamlet_techspec_analysis").execute("id", {
		file: "pdf.techspec.yaml", code_root: "@code", deep: ["src/verify/", "src/api/"], skimmed: ["src/util/"],
	}, undefined, undefined, tctx);
	const gitAt = calls.findIndex((c) => c[0] === "git");
	ok("analysis resolves the commit from git in code_root, before running the CLI",
		gitAt >= 0 && same(calls[gitAt], ["git", "rev-parse", "--short", "HEAD"]) && gitAt < calls.length - 1,
		JSON.stringify(calls));
	ok("analysis argv (--commit first, repeatables after)",
		same(calls.at(-1), ["yamlet", "techspec", "analysis", "pdf.techspec.yaml", "--commit", "9f3c1ab",
			"--deep", "src/verify/", "--deep", "src/api/", "--skimmed", "src/util/"]),
		JSON.stringify(calls.at(-1)));

	// Once pinned, later calls that only add paths must not pass --commit: HEAD
	// may have moved, and the CLI refuses a different commit.
	writeFileSync(join(home, "pdf.techspec.yaml"), "spec: pdf.yamlet.yaml\nsystem: pdf\n\nanalysis:\n  commit: 9f3c1ab\n\nrequirements: []\n");
	const before = calls.length;
	await tools.get("yamlet_techspec_analysis").execute("id", {
		file: "pdf.techspec.yaml", deep: ["src/cli/"],
	}, undefined, undefined, tctx);
	ok("analysis omits --commit once the file is pinned",
		calls.length === before + 1 && same(calls.at(-1), ["yamlet", "techspec", "analysis", "pdf.techspec.yaml", "--deep", "src/cli/"]),
		JSON.stringify(calls.slice(before)));

	// An explicit commit always wins and never consults git.
	await tools.get("yamlet_techspec_analysis").execute("id", {
		file: "pdf.techspec.yaml", commit: "abcdef0",
	}, undefined, undefined, tctx);
	ok("analysis passes an explicit commit verbatim",
		same(calls.at(-1), ["yamlet", "techspec", "analysis", "pdf.techspec.yaml", "--commit", "abcdef0"]) && calls.at(-2)[0] !== "git",
		JSON.stringify(calls.slice(-2)));
}
{
	// Not a git checkout: say so, and say what to do, instead of running the CLI
	// without a commit and relaying its usage error.
	const { tools, calls } = makePi({ git: { stdout: "", stderr: "fatal: not a git repository", code: 128, killed: false } });
	let msg = "";
	try {
		await tools.get("yamlet_techspec_analysis").execute("id", { file: "x.techspec.yaml" }, undefined, undefined, ctx);
	} catch (e) { msg = e.message; }
	ok("analysis without git fails actionably",
		msg.includes("not a git repository") && msg.includes("pass `commit`") && calls.at(-1)[0] === "git", msg);
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_techspec_criterion").execute("id", {
		file: "pdf.techspec.yaml", ac: "AC-3", met: false,
		evidence: ["src/verify/SizeCheck.java:19"], note: "rejects at exactly the limit",
	}, undefined, undefined, ctx);
	ok("criterion argv (met as true|false)",
		same(calls.at(-1), ["yamlet", "techspec", "criterion", "pdf.techspec.yaml", "--ac", "AC-3", "--met", "false",
			"--evidence", "src/verify/SizeCheck.java:19", "--note", "rejects at exactly the limit"]),
		JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_techspec_criterion").execute("id", {
		file: "pdf.techspec.yaml", ac: "AC-1", met: true, evidence: ["a.ts:1", "b.ts:2"],
	}, undefined, undefined, ctx);
	ok("criterion repeats --evidence and omits --note",
		same(calls.at(-1).slice(-6), ["--met", "true", "--evidence", "a.ts:1", "--evidence", "b.ts:2"]),
		JSON.stringify(calls.at(-1)));
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_techspec_task").execute("id", {
		file: "pdf.techspec.yaml", title: "Return invalid_xref_trailer when no startxref resolves",
		covers: ["AC-8", "ADR-0001#R-1"], depends_on: ["T-6"],
	}, undefined, undefined, ctx);
	ok("task argv",
		same(calls.at(-1), ["yamlet", "techspec", "task", "pdf.techspec.yaml",
			"--title", "Return invalid_xref_trailer when no startxref resolves",
			"--covers", "AC-8", "--covers", "ADR-0001#R-1", "--depends-on", "T-6"]),
		JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_techspec_task").execute("id", {
		file: "pdf.techspec.yaml", title: "Assemble a corpus of malformed PDFs", why: "the xref checks need known-bad input",
	}, undefined, undefined, ctx);
	ok("enabler task passes --why and nothing else",
		same(calls.at(-1).slice(-4), ["--title", "Assemble a corpus of malformed PDFs", "--why", "the xref checks need known-bad input"]),
		JSON.stringify(calls.at(-1)));
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_adr_init").execute("id", {
		dir: "@adr", title: "Structural PDF parsing", kind: "selection",
		question: "What reads the cross-reference table?",
		arises_from: ["../specs/pdf.yamlet.yaml#AC-8", "../specs/pdf.yamlet.yaml#AC-10"], assumes: ["ADR-0001"],
		date: "2026-09-08",
	}, undefined, undefined, ctx);
	ok("adr_init argv",
		same(calls.at(-1), ["yamlet", "adr", "init", "adr",
			"--title", "Structural PDF parsing", "--kind", "selection", "--question", "What reads the cross-reference table?",
			"--arises-from", "../specs/pdf.yamlet.yaml#AC-8", "--arises-from", "../specs/pdf.yamlet.yaml#AC-10",
			"--assumes", "ADR-0001", "--date", "2026-09-08"]),
		JSON.stringify(calls.at(-1)));
	ok("adr_init kind is an enum of the five kinds",
		same(tools.get("yamlet_adr_init").parameters.properties.kind.enum, ["selection", "mechanism", "policy", "boundary", "sequencing"]),
		JSON.stringify(tools.get("yamlet_adr_init").parameters.properties.kind));
}
{
	// The FILE TEXT trio and decide take positionals, not flags.
	const { tools, calls } = makePi();
	const text = "AC-10 fixes a precedence order the parser must honour";
	for (const [tool, sub] of [
		["yamlet_adr_add_force", "add-force"], ["yamlet_adr_add_obligation", "add-obligation"],
		["yamlet_adr_add_accept", "add-accept"], ["yamlet_adr_add_revisit", "add-revisit"],
	]) {
		await tools.get(tool).execute("id", { file: "@adr/ADR-0002-x.adr.yaml", text }, undefined, undefined, ctx);
		ok(`${sub} argv is FILE TEXT`,
			same(calls.at(-1), ["yamlet", "adr", sub, "adr/ADR-0002-x.adr.yaml", text]), JSON.stringify(calls.at(-1)));
	}
	await tools.get("yamlet_adr_decide").execute("id", { file: "adr/ADR-0002-x.adr.yaml", option: "OPT-2" }, undefined, undefined, ctx);
	ok("decide argv is FILE OPT-n",
		same(calls.at(-1), ["yamlet", "adr", "decide", "adr/ADR-0002-x.adr.yaml", "OPT-2"]), JSON.stringify(calls.at(-1)));
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_adr_add_basis").execute("id", {
		file: "a.adr.yaml", quantity: "40000 uploads / month", source: "ingest telemetry, 2026-08",
	}, undefined, undefined, ctx);
	ok("add_basis argv",
		same(calls.at(-1), ["yamlet", "adr", "add-basis", "a.adr.yaml", "--quantity", "40000 uploads / month", "--source", "ingest telemetry, 2026-08"]),
		JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_adr_add_dimension").execute("id", {
		file: "a.adr.yaml", matters: "Only decisive at a spread wide enough to survive the day rate being wrong by a third.",
		unit: "EUR of total ownership", source: "cost/pdf-parsing-tco.md", basis: ["B-1", "B-2"],
	}, undefined, undefined, ctx);
	ok("add_dimension argv (measured)",
		same(calls.at(-1).slice(-8), ["--unit", "EUR of total ownership", "--source", "cost/pdf-parsing-tco.md", "--basis", "B-1", "--basis", "B-2"]),
		JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_adr_add_dimension").execute("id", {
		file: "a.adr.yaml", matters: "An AGPL obligation on a distributed artifact is a legal blocker.",
	}, undefined, undefined, ctx);
	ok("add_dimension argv (unmeasured: matters only)",
		same(calls.at(-1), ["yamlet", "adr", "add-dimension", "a.adr.yaml", "--matters", "An AGPL obligation on a distributed artifact is a legal blocker."]),
		JSON.stringify(calls.at(-1)));
}
{
	// A cell is one `--against D-n=TEXT`; a ref is one `--ref LABEL=LOCATOR`. The
	// text may itself contain `=`, which is why the pair is joined here and never
	// split again on the CLI side beyond the first `=`.
	const { tools, calls } = makePi();
	await tools.get("yamlet_adr_add_option").execute("id", {
		file: "a.adr.yaml", summary: "Apache PDFBox 3.x", reversibility: "costly",
		refs: [{ label: "project", locator: "https://pdfbox.apache.org/" }],
		against: [{ dimension: "D-1", text: "Apache-2.0, no distribution obligation." }, { dimension: "D-5", text: "About 26k, mostly recurring; basis=B-1" }],
	}, undefined, undefined, ctx);
	ok("add_option argv",
		same(calls.at(-1), ["yamlet", "adr", "add-option", "a.adr.yaml", "--summary", "Apache PDFBox 3.x", "--reversibility", "costly",
			"--ref", "project=https://pdfbox.apache.org/",
			"--against", "D-1=Apache-2.0, no distribution obligation.", "--against", "D-5=About 26k, mostly recurring; basis=B-1"]),
		JSON.stringify(calls.at(-1)));
	ok("add_option requires at least one cell",
		tools.get("yamlet_adr_add_option").parameters.properties.against.minItems === 1 &&
		tools.get("yamlet_adr_add_option").parameters.required.includes("against"));
}
{
	const { tools, calls } = makePi();
	await tools.get("yamlet_adr_accept").execute("id", { file: "a.adr.yaml" }, undefined, undefined, ctx);
	ok("accept argv (no --date unless given)", same(calls.at(-1), ["yamlet", "adr", "accept", "a.adr.yaml"]), JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_adr_reject").execute("id", { file: "a.adr.yaml", date: "2026-09-08" }, undefined, undefined, ctx);
	ok("reject --date argv", same(calls.at(-1), ["yamlet", "adr", "reject", "a.adr.yaml", "--date", "2026-09-08"]), JSON.stringify(calls.at(-1)));
	await tools.get("yamlet_adr_supersede").execute("id", { file: "a.adr.yaml", by: "ADR-0009" }, undefined, undefined, ctx);
	ok("supersede argv", same(calls.at(-1), ["yamlet", "adr", "supersede", "a.adr.yaml", "--by", "ADR-0009"]), JSON.stringify(calls.at(-1)));
}

// ── 3. exit-code semantics ─────────────────────────────────────────────────
{
	const { tools } = makePi({ code: 1, stdout: "E401 vague shall\n" });
	const r = await tools.get("yamlet_verify").execute("id", { file: "a.yamlet.yaml" }, undefined, undefined, ctx);
	ok("verify exit 1 returns findings (not throw)", r.content[0].text.includes("E401"));
}
{
	const { tools } = makePi({ code: 2, stdout: "error: bad flag\n" });
	let threw = false;
	try { await tools.get("yamlet_add_requirement").execute("id", { file: "a.yamlet.yaml", description: "d" }, undefined, undefined, ctx); }
	catch (e) { threw = e.message.includes("bad flag"); }
	ok("exit 2 throws with the CLI message", threw);
}
{
	// The planning tools inherit the same contract: a DECIDED notice is stderr
	// on exit 0, so it must come back as content, not be dropped or thrown.
	const { tools } = makePi({ stdout: "T-3\n", stderr: "DECIDED: T-3 covers behaviour an ADR decides.\n  AC-8: ADR-0001\n" });
	const r = await tools.get("yamlet_techspec_task").execute("id", { file: "x.techspec.yaml", title: "t", covers: ["AC-8"] }, undefined, undefined, ctx);
	ok("a DECIDED notice on stderr reaches the model with the id",
		r.content[0].text.includes("T-3") && r.content[0].text.includes("DECIDED: T-3"), r.content[0].text);
}
{
	// pi reports a killed run as { code: 0, killed: true }. Treating that as
	// success would tell the model a mutation landed when it may have been
	// killed mid-write.
	const { tools } = makePi({ killed: true });
	let msg = "";
	try { await tools.get("yamlet_add_requirement").execute("id", { file: "a.yamlet.yaml", description: "d" }, undefined, undefined, ctx); }
	catch (e) { msg = e.message; }
	ok("killed run throws rather than reporting success",
		msg.includes("cancelled or timed out") && msg.includes("read the spec file back"), msg.slice(0, 80));
}

// ── 4. availability probe ──────────────────────────────────────────────────
{
	resetNotes();
	const { handlers, tools } = makePi({ onPath: false });
	await handlers.session_start({}, ctx);
	ok("missing binary: startup notice", notes.length === 1 && notes[0][0] === "error", JSON.stringify(notes));
	ok("missing binary: notice names brew install", (notes[0]?.[1] ?? "").includes("brew install yamlet"));
	let msg = "";
	try { await tools.get("yamlet_systems").execute("id", {}, undefined, undefined, ctx); } catch (e) { msg = e.message; }
	ok("missing binary: tool call errors actionably", msg.includes("brew install yamlet"), msg.slice(0, 60));
}
{
	resetNotes();
	const oldHelp = HELP.replace(/  add-connection.*\n/, "").replace(/  tests .*\n/, "");
	const { handlers } = makePi({ help: oldHelp });
	await handlers.session_start({}, ctx);
	ok("old CLI: names the missing commands",
		notes[0]?.[0] === "error" && (notes[0]?.[1] ?? "").includes("add-connection") && (notes[0]?.[1] ?? "").includes("tests"), JSON.stringify(notes));
}
{
	// The release before tech specs and decision records must keep loading:
	// every authoring tool works, the planning tools fail with the upgrade hint,
	// and the user hears about it once, at startup, as a warning rather than an
	// error — nothing they had is gone.
	resetNotes();
	const { handlers, tools, calls } = makePi({ help: HELP_0_2_3 });
	await handlers.session_start({}, ctx);
	ok("older CLI (no techspec/adr): one startup warning naming them",
		notes.length === 1 && notes[0][0] === "warning" && notes[0][1].includes("techspec") && notes[0][1].includes("adr") &&
		notes[0][1].includes("brew upgrade yamlet"), JSON.stringify(notes));
	const r = await tools.get("yamlet_add_requirement").execute("id", { file: "a.yamlet.yaml", description: "d" }, undefined, undefined, ctx);
	ok("older CLI: authoring tools still run", r.content[0].text.includes("AC-3"), JSON.stringify(r));
	const before = calls.length;
	let msg = "";
	try { await tools.get("yamlet_techspec_init").execute("id", { spec: "a.yamlet.yaml" }, undefined, undefined, ctx); } catch (e) { msg = e.message; }
	// The probe itself re-runs (a partial result is never cached, see the
	// upgrade case below); what must not run is the command the CLI lacks.
	ok("older CLI: a planning tool fails with the upgrade hint, before running",
		msg.includes("missing the command(s)") && msg.includes("techspec") && msg.includes("brew upgrade yamlet") &&
		!calls.slice(before).some((c) => c[1] === "techspec"),
		msg || JSON.stringify(calls.slice(before)));
	try { await tools.get("yamlet_adr_add_force").execute("id", { file: "a.adr.yaml", text: "t" }, undefined, undefined, ctx); } catch (e) { msg = e.message; }
	ok("older CLI: an adr tool names `adr` as the missing command", msg.includes("needs: adr."), msg);
}
{
	// The startup warning tells the user to upgrade. That upgrade must take
	// effect in the same session: a partial probe result is not cached, so the
	// next call re-reads `help` and finds the command.
	resetNotes();
	const { handlers, tools, cli } = makePi({ help: HELP_0_2_3 });
	await handlers.session_start({}, ctx);
	let msg = "";
	try { await tools.get("yamlet_techspec_init").execute("id", { spec: "a.yamlet.yaml" }, undefined, undefined, ctx); } catch (e) { msg = e.message; }
	ok("upgrade mid-session: before it, the planning tool refuses", msg.includes("techspec"), msg);
	cli.help = HELP; // brew upgrade yamlet
	const r = await tools.get("yamlet_techspec_init").execute("id", { spec: "a.yamlet.yaml" }, undefined, undefined, ctx);
	ok("upgrade mid-session: after it, the planning tool runs without a restart",
		r.details.command[1] === "techspec", JSON.stringify(r));
}
{
	// A killed `help` yields empty stdout; concluding "every command missing"
	// from that would disable the whole toolset for a healthy install.
	resetNotes();
	const { handlers } = makePi({ helpKilled: true });
	await handlers.session_start({}, ctx);
	ok("killed `help` does not report a healthy CLI as too old", notes.length === 0, JSON.stringify(notes));
}
{
	resetNotes();
	const { handlers } = makePi();
	await handlers.session_start({}, ctx);
	ok("healthy CLI emits no notice", notes.length === 0, JSON.stringify(notes));
}

// ── 5. the gate ────────────────────────────────────────────────────────────
{
	const { handlers } = makePi();
	const gate = handlers.tool_call;
	const cases = [
		["write spec", { toolName: "write", input: { path: "specs/a.yamlet.yaml" } }, true],
		["edit spec @", { toolName: "edit", input: { path: "@specs/a.yamlet.yaml" } }, true],
		["write tech spec", { toolName: "write", input: { path: "specs/a.techspec.yaml" } }, true],
		["edit decision record", { toolName: "edit", input: { path: "@adr/ADR-0001-x.adr.yaml" } }, true],
		["write other", { toolName: "write", input: { path: "src/a.ts" } }, false],
		["write other yaml", { toolName: "write", input: { path: "adr/README.yaml" } }, false],
		["bash redirect", { toolName: "bash", input: { command: "echo x > specs/a.yamlet.yaml" } }, true],
		["bash redirect into tech spec", { toolName: "bash", input: { command: "echo x >> specs/a.techspec.yaml" } }, true],
		["bash tee", { toolName: "bash", input: { command: "cat f | tee specs/a.yamlet.yaml" } }, true],
		["bash sed -i", { toolName: "bash", input: { command: "sed -i 's/a/b/' specs/a.yamlet.yaml" } }, true],
		["bash sed -i record", { toolName: "bash", input: { command: "sed -i 's/proposed/accepted/' adr/ADR-0001-x.adr.yaml" } }, true],
		["bash yamlet redirect", { toolName: "bash", input: { command: "yamlet graph a.yamlet.yaml > b.yamlet.yaml" } }, true],
		["bash yamlet", { toolName: "bash", input: { command: "yamlet verify specs/a.yamlet.yaml" } }, false],
		["bash yamlet adr", { toolName: "bash", input: { command: "yamlet adr accept adr/ADR-0001-x.adr.yaml" } }, false],
		["bash cat", { toolName: "bash", input: { command: "cat specs/a.yamlet.yaml" } }, false],
		["bash cat record", { toolName: "bash", input: { command: "cat adr/ADR-0001-x.adr.yaml" } }, false],
		["bash rm tech spec", { toolName: "bash", input: { command: "rm specs/a.techspec.yaml" } }, false],
		["bash unrelated", { toolName: "bash", input: { command: "echo hi > out.txt" } }, false],
	];
	for (const [label, ev, shouldBlock] of cases) {
		const r = await gate(ev, ctx);
		ok(`gate: ${label} -> ${shouldBlock ? "blocked" : "allowed"}`, !!r?.block === shouldBlock, JSON.stringify(r));
	}
	const kinds = [
		["specs/a.yamlet.yaml", "yamlet_init"],
		["plan/a.techspec.yaml", "yamlet_techspec_"],
		["adr/ADR-0001-x.adr.yaml", "yamlet_adr_"],
	];
	for (const [path, tool] of kinds) {
		const r = await gate({ toolName: "write", input: { path } }, ctx);
		ok(`gate: refusal for ${path} points at ${tool}*`, r.reason.includes(tool), r.reason);
	}
}

// ── 6. shipping the agents (option B) ──────────────────────────────────────
// pi-subagents cannot load agents from a package, so the extension offers to
// place them. These assert it asks first, never clobbers, and stays quiet when
// there is nothing to install them for.
const AGENTS = [
	"yamlet-contract-challenger.md", "yamlet-criteria-challenger.md",
	"yamlet-code-research.md", "yamlet-evidence-challenger.md", "yamlet-adr-challenger.md",
];
const REAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR;

function agentScenario({ hasAgentTool = true, hasUI = true, answer = true, prepopulate = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "yamlet-agents-"));
  process.env.PI_CODING_AGENT_DIR = home;
  if (prepopulate) {
    mkdirSync(join(home, "agents"), { recursive: true });
    for (const a of AGENTS) {
      const content = prepopulate(a);
      if (content !== null) writeFileSync(join(home, "agents", a), content);
    }
  }
  const notes = [], prompts = [], h = {}, tools = new Map();
  process.env.PATH = BIN;
  const pi = {
    on: (n, f) => (h[n] = f),
    registerTool: (t) => tools.set(t.name, t),
    getAllTools: () => (hasAgentTool ? [{ name: "Agent" }] : []),
    exec: async (_c, a) => a[0] === "--version"
      ? { stdout: "yamlet 0.4.1\n", stderr: "", code: 0, killed: false }
      : { stdout: HELP, stderr: "", code: 0, killed: false },
  };
  ext(pi);
  const ctx = {
    cwd: join(home, "proj"), hasUI, mode: "tui",
    ui: {
      notify: (m, t) => notes.push(`[${t}] ${m}`),
      confirm: async (title, body) => { prompts.push(title); return answer; },
    },
  };
  return { h, ctx, notes, prompts, home,
           installed: () => AGENTS.filter((a) => existsSync(join(home, "agents", a))),
           read: (a) => readFileSync(join(home, "agents", a), "utf8") };
}
const shipped = (a) => readFileSync(join(PKG, "agents", a), "utf8");
ok("every shipped agent file exists", AGENTS.every((a) => existsSync(join(PKG, "agents", a))));

{ const s = agentScenario({ hasAgentTool: false });
  await s.h.session_start({}, s.ctx);
  ok("agents: silent when pi-subagents absent", s.prompts.length === 0 && s.installed().length === 0,
     JSON.stringify(s.notes)); }

{ const s = agentScenario({ answer: true });
  await s.h.session_start({}, s.ctx);
  ok("agents: asks before writing", s.prompts.length === 1, JSON.stringify(s.prompts));
  ok("agents: installs all five on yes", s.installed().length === 5, JSON.stringify(s.installed()));
  ok("agents: content matches what the package ships", AGENTS.every((a) => s.read(a) === shipped(a)));
  ok("agents: tells the user a reload is needed",
     s.notes.some((n) => /reload|Restart/i.test(n)), JSON.stringify(s.notes)); }

{ const s = agentScenario({ answer: false });
  await s.h.session_start({}, s.ctx);
  ok("agents: writes nothing on no", s.installed().length === 0, JSON.stringify(s.installed()));
  ok("agents: says it skipped", s.notes.some((n) => /skipped/i.test(n)), JSON.stringify(s.notes)); }

{ const s = agentScenario({ hasUI: false });
  await s.h.session_start({}, s.ctx);
  ok("agents: headless never writes without asking", s.installed().length === 0);
  ok("agents: headless explains the manual step",
     s.notes.some((n) => n.includes("install.sh")), JSON.stringify(s.notes)); }

{ const s = agentScenario({ prepopulate: shipped });
  await s.h.session_start({}, s.ctx);
  ok("agents: silent when already installed and current", s.prompts.length === 0 &&
     !s.notes.some((n) => /challenger|research/i.test(n)), JSON.stringify(s.notes)); }

{ const s = agentScenario({ prepopulate: () => "locally edited by the user\n" });
  await s.h.session_start({}, s.ctx);
  ok("agents: never clobbers a locally-edited agent", s.prompts.length === 0 &&
     AGENTS.every((a) => s.read(a).startsWith("locally edited")),
     JSON.stringify(s.notes));
  ok("agents: reports the difference instead",
     s.notes.some((n) => /differ/i.test(n)), JSON.stringify(s.notes)); }

{ // The upgrade path from the release with two agents: those two are on disk
  // (and current), the three planning agents are not. Offer the three, leave
  // the two alone.
  const old = new Set(["yamlet-contract-challenger.md", "yamlet-criteria-challenger.md"]);
  const s = agentScenario({ prepopulate: (a) => (old.has(a) ? shipped(a) : null) });
  await s.h.session_start({}, s.ctx);
  ok("agents: upgrade offers only the missing three", s.prompts.length === 1 &&
     s.notes.some((n) => n.includes("installed yamlet-code-research.md, yamlet-evidence-challenger.md and yamlet-adr-challenger.md")),
     JSON.stringify(s.notes));
  ok("agents: upgrade installs all five", s.installed().length === 5 && AGENTS.every((a) => s.read(a) === shipped(a))); }

{ // Same upgrade, but the two old agents carry a local edit: install the three,
  // keep the two, and say which were left alone — the prompt must not hide it.
  const old = new Set(["yamlet-contract-challenger.md", "yamlet-criteria-challenger.md"]);
  const s = agentScenario({ prepopulate: (a) => (old.has(a) ? "locally edited by the user\n" : null) });
  await s.h.session_start({}, s.ctx);
  ok("agents: upgrade with edited old agents keeps them",
     s.installed().length === 5 && [...old].every((a) => s.read(a).startsWith("locally edited")),
     JSON.stringify(s.installed()));
  ok("agents: …and reports them as left untouched",
     s.notes.some((n) => /differ/.test(n) && /left untouched/.test(n)), JSON.stringify(s.notes)); }

{ const s = agentScenario({ answer: false });
  await s.h.session_start({}, s.ctx);
  await s.h.session_start({}, s.ctx);
  ok("agents: asks at most once per session", s.prompts.length === 1, JSON.stringify(s.prompts)); }

if (REAL_AGENT_DIR === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = REAL_AGENT_DIR;

process.env.PATH = REAL_PATH;
console.log(`\n${failures === 0 ? "all assertions passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
