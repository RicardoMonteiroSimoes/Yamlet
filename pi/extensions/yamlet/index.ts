// yamlet.ts — the yamlet CLI as first-class pi tools, plus the gate that makes
// yamlet's one hard rule actually hard.
//
// Why this exists. A yamlet spec is correct by construction only because every
// write goes through the `yamlet` CLI, which owns all serialization and mints
// every ID. In Claude Code that is expressed as `allowed-tools: Bash(yamlet:*)`.
// pi has no equivalent: `bash` is granular to the whole tool, and a skill's
// `allowed-tools` frontmatter is parsed away (pi 0.84.x keeps only name,
// description and disable-model-invocation). So on pi the rule was prose.
//
// Two things here replace that prose:
//
//   1. One tool per `yamlet` subcommand. The read/mutate split becomes
//      structural — an agent scoped to `ext:yamlet/yamlet_verify` can verify and
//      cannot possibly mutate, which no regex over a command string can promise.
//      Arguments are passed as an argv array, never a shell string, so there is
//      no quoting or injection surface either.
//
//   2. A `tool_call` gate that blocks `write`/`edit` on any `*.yamlet.yaml`.
//      This is the half that matters most: it holds in the MAIN session, where
//      the author skill interviews the user and where no subagent tool-scoping
//      can reach.
//
// The CLI is not bundled. `yamlet` must be on PATH (`brew install yamlet`) —
// this extension shells out to it and is inert without it, the same contract the
// skills have always had.

import { withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

/** A spec file, by the only naming the format recognises. */
const SPEC_RE = /\.yamlet\.ya?ml\b/i;

/**
 * Every file yamlet owns the bytes of: a spec, a tech spec (`yamlet techspec`
 * rewrites it whole from a parsed model) and a decision record (`yamlet adr`
 * mints its ids and freezes it on accept). The gate covers all three — the
 * reason to never hand-write one is the same, and a tech spec or record edited
 * by hand is refused by the CLI's own loader on the next call anyway.
 */
const OWNED_RE = /\.(yamlet|techspec|adr)\.ya?ml\b/i;

const INSTALL_HINT =
	"`yamlet` is not on PATH. Install it with:\n" +
	"    brew tap RicardoMonteiroSimoes/yamlet\n" +
	"    brew trust --tap RicardoMonteiroSimoes/yamlet\n" +
	"    brew install yamlet\n" +
	"or download a binary for your platform from\n" +
	"https://github.com/RicardoMonteiroSimoes/Yamlet/releases/latest and put it on your PATH.\n" +
	"The yamlet_* tools shell out to that binary and cannot work without it.";

/** Subcommands the authoring tools need; a CLI missing any of them is too old to load at all. */
const REQUIRED_COMMANDS = [
	"verify", "systems", "impact", "graph", "tests",
	"init", "add-component", "add-connection", "add-requirement", "add-criterion",
] as const;

/**
 * Subcommands the planning tools need (`yamlet_add_adr`, `yamlet_techspec_*`,
 * `yamlet_adr_*`). These arrived after the authoring set, so a CLI that has the
 * required commands but not these is *older*, not broken: the authoring tools
 * keep working, and only a planning tool call fails — with the upgrade hint,
 * not a raw usage error — so a user on the previous release loses nothing they
 * had. Every tool checks its own top-level command against this list.
 */
const PLANNING_COMMANDS = ["add-adr", "techspec", "adr"] as const;

/** Some models prefix path arguments with `@`; built-in tools strip it, so do we. */
const cleanPath = (p: string): string => (p.startsWith("@") ? p.slice(1) : p);

type Probe =
	| { ok: true; version: string; missing: string[] }
	| { ok: false; reason: string };

const UPGRADE_HINT =
	"Upgrade with `brew upgrade yamlet`, or download a newer build from " +
	"https://github.com/RicardoMonteiroSimoes/Yamlet/releases/latest.";

/**
 * Resolve `cmd` on PATH, or undefined.
 *
 * We cannot infer "not installed" from the exit code. pi's `execCommand` never
 * rejects and never surfaces 127: it spawns with `shell: false`, and a spawn
 * ENOENT is caught and resolved as `{ code: 1, stdout: "", stderr: "" }` — which
 * is indistinguishable from a real command that genuinely exited 1. Checking
 * PATH ourselves is the only way to tell "yamlet is missing" (actionable: here
 * is how to install it) from "yamlet ran and failed" (actionable: here is what
 * it said).
 */
async function findOnPath(cmd: string): Promise<string | undefined> {
	// On Windows an executable is only executable by extension, and node reports
	// X_OK true for any readable file — so probe the PATHEXT candidates there.
	const exts = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		for (const ext of exts) {
			try {
				await access(join(dir, cmd + ext), constants.X_OK);
				return join(dir, cmd + ext);
			} catch {
				// not here; keep looking
			}
		}
	}
	return undefined;
}

/**
 * Build the "is a usable `yamlet` on PATH?" probe for one extension instance.
 *
 * Checked once at session start so the user hears about a missing CLI up front,
 * in their own terminal, rather than three questions into an interview when the
 * first tool call fails. Capability is checked by *command name* rather than a
 * version floor: `yamlet help` is generated from the command registry, so asking
 * it which commands exist stays correct without pinning a version this repo
 * would then have to keep in step.
 *
 * Only successes are cached. A failed probe is retried on the next call, so
 * installing yamlet mid-session starts working without restarting pi.
 *
 * The cache lives per instance rather than at module scope: pi-subagents runs
 * subagents in-process, so a module-level cache would be shared across sessions
 * that each build their own `pi` handle.
 */
function makeProbe(pi: ExtensionAPI): (cwd: string) => Promise<Probe> {
	let cachedProbe: Promise<Probe> | undefined;

	return function probeYamlet(cwd: string): Promise<Probe> {
		if (cachedProbe) return cachedProbe;
		const run = (async (): Promise<Probe> => {
			if (!(await findOnPath("yamlet"))) return { ok: false, reason: INSTALL_HINT };

			const v = await pi.exec("yamlet", ["--version"], { cwd, timeout: 5000 });
			// `killed` is the only signal that a run was cut short: a process killed
			// by a signal reports a null exit code, which pi coerces to 0.
			if (v.killed) {
				return { ok: false, reason: "`yamlet --version` timed out after 5s. Is the binary on PATH wedged?" };
			}
			if (v.code !== 0) {
				return {
					ok: false,
					reason: `\`yamlet --version\` exited ${v.code}.\n${v.stderr.trim() || "(no output)"}`,
				};
			}
			const version = v.stdout.trim() || "unknown version";

			const h = await pi.exec("yamlet", ["help"], { cwd, timeout: 5000 });
			// Only conclude "too old" from a help listing we actually got. A killed or
			// failed `help` yields empty stdout, which would otherwise read as every
			// command missing and disable the whole toolset for the session.
			if (!h.killed && h.code === 0 && h.stdout.trim()) {
				const has = (c: string): boolean => new RegExp(`^\\s+${c}\\s`, "m").test(h.stdout);
				const missing = REQUIRED_COMMANDS.filter((c) => !has(c));
				if (missing.length > 0) {
					return {
						ok: false,
						reason:
							`Found ${version}, but it is missing the command(s) this extension needs: ` +
							`${missing.join(", ")}.\n${UPGRADE_HINT}`,
					};
				}
				return { ok: true, version, missing: PLANNING_COMMANDS.filter((c) => !has(c)) };
			}
			return { ok: true, version, missing: [] };
		})();
		cachedProbe = run.then((p) => {
			if (!p.ok) cachedProbe = undefined; // retry next time; a mid-session install should just work
			return p;
		});
		return cachedProbe;
	};
}

/* ── shipping the agents ────────────────────────────────────────────────────
 *
 * `pi install` can deliver an extension and skills, but NOT agents:
 * @tintinweb/pi-subagents discovers those from three hardcoded directories
 * (.pi/agents/, .agents/agents/, $PI_CODING_AGENT_DIR/agents/) with no
 * package-based discovery, no configurable path, and no public registration RPC
 * — its cross-extension surface is ping/spawn/stop only.
 *
 * Left alone, that means a `pi install` of this package half-installs: a skill
 * runs, finds no `Agent` tool, and quietly degrades to reviewing its own
 * proposals (or, for the tech spec, researching the code in its own context) —
 * losing the adversarial gates, which are the point. So the package offers to
 * place its own agent files, with consent, and says what it did.
 *
 * Deliberately conservative: it asks before writing anything outside its own
 * directory, never overwrites a file the user has edited without saying so,
 * stays silent when pi-subagents is absent (there would be nothing to install
 * them for), and never writes at all without a UI to ask through.
 */
const AGENT_FILES = [
	"yamlet-contract-challenger.md",
	"yamlet-criteria-challenger.md",
	"yamlet-code-research.md",
	"yamlet-evidence-challenger.md",
	"yamlet-adr-challenger.md",
];

/** Where pi-subagents looks, in its own precedence order. */
const agentSearchDirs = (cwd: string): string[] => [
	join(cwd, ".pi", "agents"),
	join(cwd, ".agents", "agents"),
	join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "agents"),
];

/** The installed package root — `extensions/yamlet/index.ts` -> `../..`. */
function pkgRoot(): string | undefined {
	try {
		return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	} catch {
		return undefined;
	}
}

/** The `agents/` directory shipped alongside this extension, if reachable. */
function shippedAgentsDir(): string | undefined {
	const root = pkgRoot();
	return root === undefined ? undefined : join(root, "agents");
}

/**
 * What `yamlet_guide` can serve: a topic -> its path inside the package.
 *
 * The Claude Code build splits the author skill into a router plus `references/`
 * it reads on demand, which keeps the always-loaded body small. That relies on
 * Claude Code telling a skill where it lives; pi has no such guarantee, and a
 * skill installed into `~/.pi/agent/skills/` cannot know its own absolute path.
 *
 * So the extension serves them instead. It *does* know where it lives — the same
 * `import.meta.url` trick `shippedAgentsDir` uses to offer the challengers —
 * which turns "find your own bundled file" into a plain tool call. This is the
 * pi port earning its executable code a second time.
 *
 * `decisions` is the tech spec skill's own reference — the decision gate it runs
 * when a task needs a choice the user owns — served for the same reason.
 *
 * The `*-challenge` and `code-research` entries are the agents' *procedures*,
 * served for the degraded path where `@tintinweb/pi-subagents` is absent: the
 * skill then has to run the gate (or the research) inline, and "find the agent
 * file yourself" is exactly the instruction that turns into skipping it.
 */
const GUIDE_FILES = {
	creating: ["skills/yamlet-author/references", "creating.md"],
	editing: ["skills/yamlet-author/references", "editing.md"],
	composites: ["skills/yamlet-author/references", "composites.md"],
	patterns: ["skills/yamlet-author/references", "patterns.md"],
	decisions: ["skills/yamlet-techspec/references", "decisions.md"],
	"contract-challenge": ["agents", "yamlet-contract-challenger.md"],
	"criteria-challenge": ["agents", "yamlet-criteria-challenger.md"],
	"code-research": ["agents", "yamlet-code-research.md"],
	"evidence-challenge": ["agents", "yamlet-evidence-challenger.md"],
	"adr-challenge": ["agents", "yamlet-adr-challenger.md"],
} as const;

type GuideTopic = keyof typeof GUIDE_FILES;

const GUIDE_TOPICS: Record<GuideTopic, string> = {
	creating: "Setting up a NEW spec: systems discovery, topic, front, summary, blast-radius, contract, init.",
	editing: "Changing a spec that ALREADY EXISTS: locating the right file, reading its blast radius, what is possible.",
	composites: "Declaring members and wiring connections on a composite.",
	patterns: "The six EARS patterns, the three kinds of {token}, and placeholder examples.",
	decisions: "The tech spec's decision gate: when a task needs a choice the user owns, write the record, link it, cover what it obliges.",
	"contract-challenge": "The contract gate's checklist — only for running it inline when the Agent tool is absent.",
	"criteria-challenge": "The criteria gate's checklist — only for running it inline when the Agent tool is absent.",
	"code-research": "The code research procedure — only for running it inline when the Agent tool is absent.",
	"evidence-challenge": "The evidence gate's checklist — only for running it inline when the Agent tool is absent.",
	"adr-challenge": "The ADR gate's checklist — only for running it inline when the Agent tool is absent.",
};

/** "a", "a and b", "a, b and c". */
const listOf = (xs: string[]): string =>
	xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

const readOrNull = async (p: string): Promise<string | null> => {
	try {
		return await readFile(p, "utf8");
	} catch {
		return null;
	}
};

/**
 * Which agent files are missing from every search dir, and which exist but no
 * longer match what this package ships (an upgrade, or a local edit).
 */
async function agentInstallState(cwd: string, src: string) {
	const missing: string[] = [];
	const stale: string[] = [];
	for (const name of AGENT_FILES) {
		const shipped = await readOrNull(join(src, name));
		if (shipped === null) continue; // not shipped in this layout; nothing to offer
		let foundAt: string | undefined;
		let foundContent: string | null = null;
		for (const dir of agentSearchDirs(cwd)) {
			const c = await readOrNull(join(dir, name));
			if (c !== null) { foundAt = dir; foundContent = c; break; }
		}
		if (foundAt === undefined) missing.push(name);
		else if (foundContent !== shipped) stale.push(name);
	}
	return { missing, stale };
}

/**
 * Run the CLI and shape the result the way yamlet's own exit codes mean it:
 *
 *   0  success
 *   1  `verify` found errors — a real answer, not a tool failure, so it comes
 *      back as content and the model reads the findings
 *   2  usage/validation error, nothing written
 *   3  a mutation was rolled back by the commit gate
 *
 * 2 and 3 mean the call itself was wrong, so they throw: pi marks the result
 * isError and the model sees it as a failure to correct rather than an answer.
 *
 * A cancelled or timed-out run is checked FIRST and separately, because pi
 * reports it as `{ code: 0, killed: true }` — a signal death has a null exit
 * code, which is coerced to 0. Reading that as success would tell the model a
 * mutation landed when it may have been killed mid-write.
 */
async function runYamlet(
	pi: ExtensionAPI,
	probeYamlet: (cwd: string) => Promise<Probe>,
	ctx: ExtensionContext,
	args: string[],
	signal: AbortSignal | undefined,
) {
	// Fail with the actionable install message rather than a raw ENOENT, and do
	// it before the call so a missing CLI reads the same here as it does at startup.
	const probe = await probeYamlet(ctx.cwd);
	if (!probe.ok) throw new Error(probe.reason);
	// A planning command on a CLI that predates it: say "upgrade", not "unknown
	// command", and say it before running anything.
	const cmd = args[0] ?? "";
	if (probe.missing.includes(cmd)) {
		throw new Error(
			`Found ${probe.version}, but it is missing the command(s) this tool needs: ${cmd}.\n${UPGRADE_HINT}`,
		);
	}

	const res = await pi.exec("yamlet", args, { signal, cwd: ctx.cwd });

	const text = [res.stdout, res.stderr].map((s) => s.trimEnd()).filter(Boolean).join("\n");
	if (res.killed) {
		throw new Error(
			`\`yamlet ${args[0]}\` was cancelled or timed out before it finished. Do not assume it ` +
			`did or did not take effect — read the spec file back before continuing.` +
			(text ? `\n\nPartial output:\n${text}` : ""),
		);
	}
	if (res.code === 2 || res.code === 3) {
		throw new Error(text || `yamlet ${args[0]} exited ${res.code}`);
	}
	return {
		content: [{ type: "text" as const, text: text || `yamlet ${args[0]} exited ${res.code}` }],
		details: { command: ["yamlet", ...args], code: res.code },
	};
}

/** Append `--flag value` for each entry of a repeatable option. */
const repeat = (flag: string, values: string[] | undefined, into: string[]): void => {
	for (const v of values ?? []) into.push(flag, v);
};

/**
 * The commit a tech spec is already pinned to, or undefined.
 *
 * `techspec analysis` needs `--commit` on its first call and refuses a
 * different one afterwards. The tool resolves the commit from git only while
 * the file has none, so a later call that merely adds `--deep` paths does not
 * fail because HEAD moved in the meantime. The serializer writes exactly
 * `analysis:\n  commit: SHA`, which is what this matches.
 */
async function pinnedCommit(file: string): Promise<string | undefined> {
	const text = await readOrNull(file);
	return text === null ? undefined : /^analysis:\n  commit: ([0-9a-f]{7,40})$/m.exec(text)?.[1];
}

/**
 * `git rev-parse --short HEAD` in the code root.
 *
 * The tool reads the commit itself rather than taking it from the model, so the
 * pin is what git says and never a remembered or invented string. A code root
 * that is not a checkout is a usage error with a way out (`commit`), not a
 * silent unpinned tech spec — the CLI would refuse that anyway.
 */
async function gitHead(pi: ExtensionAPI, cwd: string, signal: AbortSignal | undefined): Promise<string> {
	const r = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd, signal, timeout: 5000 });
	const sha = r.stdout.trim();
	if (r.killed || r.code !== 0 || !/^[0-9a-f]{7,40}$/.test(sha)) {
		const why = r.stderr.trim();
		throw new Error(
			`Could not read the commit from git in ${cwd}${why ? ` (${why})` : ""}. A tech spec pins the ` +
			`commit its verdicts were read at; pass \`commit\` explicitly if the code root is not a git checkout.`,
		);
	}
	return sha;
}

/**
 * Best-effort shell check, defence in depth only.
 *
 * The tools above remove any *need* to touch a spec through the shell, and the
 * challenger agents get no `bash` at all. But the main session still has it, so
 * catch the obvious hand-write paths — a redirect, `tee`, or `sed -i` aimed at a
 * spec. A plain `yamlet ...` invocation is the sanctioned writer and passes.
 *
 * This is not a boundary: a shell is unbounded and anyone determined can evade
 * it. The write/edit gate is the real guarantee; this only stops the accident.
 */
function shellWritesSpec(command: string): boolean {
	if (!OWNED_RE.test(command)) return false;
	return command.split(/\|\||&&|[;\n|]/).some((segment) => {
		const s = segment.trim();
		if (!OWNED_RE.test(s)) return false;
		// A redirect into a spec is blocked whatever produced the bytes — including
		// `yamlet graph a.yamlet.yaml > b.yamlet.yaml`, which is still the shell
		// writing the file rather than the CLI's own serializer. (`graph` itself
		// now refuses a `*.yamlet.yaml` --out, so the two guards agree: a graph
		// never lands on a spec, by either route.)
		if (/>>?\s*\S*\.(yamlet|techspec|adr)\.ya?ml\b/i.test(s)) return true;
		// Otherwise the CLI itself is the sanctioned writer and passes.
		if (/^(?:sudo\s+)?yamlet\b/.test(s)) return false;
		return /\btee\b/.test(s) || /\bsed\b[^&]*\s-i\b/.test(s);
	});
}

export default function (pi: ExtensionAPI) {
	const probeYamlet = makeProbe(pi);
	const run = (ctx: ExtensionContext, args: string[], signal: AbortSignal | undefined) =>
		runYamlet(pi, probeYamlet, ctx, args, signal);

	// ── startup: is the CLI actually there? ─────────────────────────────────
	// Say so once, in the user's terminal, at the moment they can still fix it.
	// Non-blocking: the session starts either way, and every tool call repeats
	// the check so the failure is never silent.
	pi.on("session_start", async (_event, ctx) => {
		const probe = await probeYamlet(ctx.cwd);
		if (!probe.ok) {
			ctx.ui.notify(`yamlet tools unavailable — ${probe.reason}`, "error");
		} else if (probe.missing.length > 0) {
			// Older CLI: authoring works, planning does not. Say which, and how to
			// fix it, now — not at step 2 of a tech spec.
			ctx.ui.notify(
				`yamlet: ${probe.version} has no ${probe.missing.join("/")} command, so the tech spec and ` +
				`decision record tools will fail until you upgrade; the authoring tools work. ${UPGRADE_HINT}`,
				"warning",
			);
		}
		// Convenience, never a prerequisite: a failure here must not take down the
		// session, and the yamlet_* tools work with or without the challengers.
		try {
			await offerAgentInstall(ctx);
		} catch {
			// deliberately silent — the skills report a missing gate themselves
		}
	});

	// Asked at most once per session: session_start also fires on reload/resume,
	// and re-prompting someone who already said no is nagging.
	let agentPromptDone = false;

	async function offerAgentInstall(ctx: ExtensionContext): Promise<void> {
		if (agentPromptDone) return;

		// No pi-subagents means no `Agent` tool, so there is nothing these files
		// would be used by. Stay silent rather than explaining an absent feature.
		// getAllTools is guarded: it is not on every pi version this may run against,
		// and an absent method must not turn into a thrown session_start.
		if (typeof pi.getAllTools !== "function") return;
		if (!pi.getAllTools().some((t) => t.name === "Agent")) return;

		const src = shippedAgentsDir();
		if (!src) return;
		const { missing, stale } = await agentInstallState(ctx.cwd, src);
		if (missing.length === 0 && stale.length === 0) return;

		agentPromptDone = true;
		const dest = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "agents");

		if (stale.length > 0 && missing.length === 0) {
			// Never silently clobber: the difference may be the user's own edit.
			ctx.ui.notify(
				`yamlet: ${stale.join(", ")} differ${stale.length === 1 ? "s" : ""} from the version this ` +
				`package ships. Left untouched — re-copy from ${src} if you want the packaged version.`,
				"info",
			);
			return;
		}

		const what = listOf(missing);
		// An upgrade path: the old agents are on disk, the new ones are not. The
		// missing ones are offered as usual; a stale one is reported alongside
		// rather than lost behind the prompt, and still never overwritten.
		const staleNote = stale.length > 0
			? ` (${listOf(stale)} differ${stale.length === 1 ? "s" : ""} from the packaged version and ` +
				`${stale.length === 1 ? "was" : "were"} left untouched.)`
			: "";
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`yamlet: the agent${missing.length === 1 ? "" : "s"} ${what} ${missing.length === 1 ? "is" : "are"} ` +
				`not installed, so the yamlet skills' adversarial gates and code research cannot run as subagents. ` +
				`Copy ${src}/*.md into ${dest} (or run the package's install.sh).${staleNote}`,
				"info",
			);
			return;
		}

		const yes = await ctx.ui.confirm(
			"Install the yamlet agents?",
			`The yamlet author, tech spec and ADR flows run their adversarial reviewers and code research as ` +
			`subagents. ${what} ${missing.length === 1 ? "is" : "are"} not on disk yet, and pi-subagents can ` +
			`only load agents from a fixed set of directories — a package cannot ship them.\n\n` +
			`Copy them to ${dest}? Without them the skills still work, but run those steps inline, in their ` +
			`own context — a weaker check.${staleNote}`,
		);
		if (!yes) {
			ctx.ui.notify("yamlet: skipped. The skills will say so when they reach a gate.", "info");
			return;
		}

		try {
			await mkdir(dest, { recursive: true });
			for (const name of missing) {
				const content = await readOrNull(join(src, name));
				if (content !== null) await writeFile(join(dest, name), content, "utf8");
			}
			ctx.ui.notify(
				`yamlet: installed ${what} to ${dest}. Restart pi (or /reload) to pick them up — ` +
				`pi-subagents reads agents at startup.${staleNote}`,
				"info",
			);
		} catch (err) {
			ctx.ui.notify(
				`yamlet: could not write to ${dest} (${err instanceof Error ? err.message : String(err)}). ` +
				`Copy ${src}/*.md there by hand, or run the package's install.sh.`,
				"error",
			);
		}
	}

	// ── the gate ────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event) => {
		const input = event.input as Record<string, unknown> | undefined;

		if (event.toolName === "write" || event.toolName === "edit") {
			const path = typeof input?.path === "string" ? cleanPath(input.path) : "";
			if (SPEC_RE.test(path)) {
				return {
					block: true,
					reason:
						`Refusing to ${event.toolName} ${path} directly. A .yamlet.yaml is written only by the ` +
						`yamlet CLI, which owns serialization and mints every RQ-/AC- id — hand-editing is what ` +
						`makes a spec drift. Use the yamlet_* tools (yamlet_init, yamlet_add_requirement, ` +
						`yamlet_add_criterion, …) instead. They still append to an existing spec; only revising or ` +
						`deleting committed text is unsupported — say so rather than working around it.`,
				};
			}
			if (/\.techspec\.ya?ml\b/i.test(path)) {
				return {
					block: true,
					reason:
						`Refusing to ${event.toolName} ${path} directly. A .techspec.yaml is written only by the ` +
						`yamlet CLI, which checks every RQ-/AC- id against the spec and mints every T- id. Use the ` +
						`yamlet_techspec_* tools. A verdict is never revised in place: if one was wrong, delete the ` +
						`file and start the tech spec over.`,
				};
			}
			if (/\.adr\.ya?ml\b/i.test(path)) {
				return {
					block: true,
					reason:
						`Refusing to ${event.toolName} ${path} directly. A .adr.yaml is written only by the yamlet ` +
						`CLI, which mints every B-/D-/OPT-/R- id and freezes the record on accept. Use the ` +
						`yamlet_adr_* tools; a decision that no longer holds is superseded by a new record, never edited.`,
				};
			}
		}

		if (event.toolName === "bash") {
			const command = typeof input?.command === "string" ? input.command : "";
			if (shellWritesSpec(command)) {
				return {
					block: true,
					reason:
						"Refusing a shell command that writes a .yamlet.yaml, .techspec.yaml or .adr.yaml. These " +
						"are written only by the yamlet CLI — use the yamlet_* tools. (Running `yamlet ...` itself is fine.)",
				};
			}
		}
	});

	// ── read-only tools ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "yamlet_systems",
		label: "yamlet systems",
		description:
			"List the systems defined across a directory of specs, grouped by their scope files.",
		promptSnippet: "Discover existing yamlet systems, their summaries and their contracts",
		parameters: Type.Object({
			dir: Type.Optional(Type.String({ description: "Directory to scan for *.yamlet.yaml (default: .)" })),
			system: Type.Optional(Type.String({ description: "Show only the system with this exact slug" })),
			details: Type.Optional(Type.Boolean({
				description: "Include each scope's summary and description",
			})),
			contracts: Type.Optional(Type.Boolean({ description: "Include each scope's exposed contract signature" })),
			format: Type.Optional(StringEnum(["human", "json"] as const)),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["systems"];
			if (params.dir) args.push(cleanPath(params.dir));
			if (params.system) args.push(`--system=${params.system}`);
			if (params.details) args.push("--details");
			if (params.contracts) args.push("--contracts");
			if (params.format) args.push(`--format=${params.format}`);
			return run(ctx, args, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_guide",
		label: "yamlet guide",
		description:
			"Read one of the yamlet skills' procedures, or an agent's checklist for running it inline. Load " +
			"only the one in play.",
		promptSnippet: "Read a yamlet skill procedure or an agent's checklist",
		parameters: Type.Object({
			topic: StringEnum(Object.keys(GUIDE_FILES) as [GuideTopic, ...GuideTopic[]], {
				description: Object.entries(GUIDE_TOPICS).map(([k, v]) => `${k}: ${v}`).join(" "),
			}),
		}),
		async execute(_id, params) {
			const root = pkgRoot();
			const entry = GUIDE_FILES[params.topic as GuideTopic];
			const path = root && entry ? join(root, ...entry) : undefined;
			const text = path ? await readOrNull(path) : null;
			if (text === null) {
				throw new Error(
					`The '${params.topic}' guide could not be read` + (path ? ` from ${path}` : "") +
					".\nThis extension seems to be installed without the files it ships alongside. Reinstall " +
					"with `pi install git:github.com/RicardoMonteiroSimoes/Yamlet`.\n" +
					"Do NOT proceed by guessing the content — tell the user instead.",
				);
			}
			return { content: [{ type: "text" as const, text }], details: { topic: params.topic, path } };
		},
	});

	pi.registerTool({
		name: "yamlet_impact",
		label: "yamlet impact",
		description:
			"The reverse dependency index: which composites declare this spec as a member, under which alias, " +
			"and which of its sockets each one binds or consumes.",
		promptSnippet: "List the composites that consume a spec (blast radius of a contract change)",
		parameters: Type.Object({
			file: Type.String({ description: "The spec whose consumers you want" }),
			dir: Type.Optional(Type.String({ description: "Directory to scan for composites (default: .)" })),
			format: Type.Optional(StringEnum(["human", "json"] as const)),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["impact", cleanPath(params.file)];
			if (params.dir) args.push(cleanPath(params.dir));
			if (params.format) args.push(`--format=${params.format}`);
			return run(ctx, args, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_verify",
		label: "yamlet verify",
		description:
			"Check a spec against the rule catalog, the mechanical source of truth for validity. E### is " +
			"invalid; W### is a non-fatal warning.",
		promptSnippet: "Verify a .yamlet.yaml against the rule catalog",
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "Path to the .yamlet.yaml to verify" })),
			list_rules: Type.Optional(Type.Boolean({ description: "Print the rule catalog instead of verifying" })),
			format: Type.Optional(StringEnum(["human", "json"] as const)),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!params.list_rules && !params.file) {
				throw new Error("yamlet_verify needs either `file` (a .yamlet.yaml to check) or list_rules=true.");
			}
			const args = ["verify"];
			if (params.format) args.push(`--format=${params.format}`);
			if (params.list_rules) args.push("--list-rules");
			else args.push(cleanPath(params.file!));
			return run(ctx, args, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_graph",
		label: "yamlet graph",
		description:
			"Write a graph of one spec or a directory to `out` — dot, json, or html. Returns only a summary " +
			"line: hand the user that path and never read the file back. dot is one spec, one level; a " +
			"directory or recursive needs json or html.",
		promptSnippet: "Write a spec graph (dot/json/html) to a file",
		promptGuidelines: [
			"yamlet_graph writes to `out` and returns only a summary — hand the user the path, never read the graph file back into context.",
		],
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "A spec file or a directory of specs (default: .)" })),
			out: Type.String({
				description: "Where to write the graph (e.g. graph.html); must not be a *.yamlet.yaml path.",
			}),
			format: Type.Optional(StringEnum(["dot", "json", "html"] as const)),
			libs: Type.Optional(StringEnum(["cdn", "embed"] as const)),
			recursive: Type.Optional(Type.Boolean({ description: "Expand composite members deeply" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["graph"];
			if (params.target) args.push(cleanPath(params.target));
			args.push(`--out=${cleanPath(params.out)}`);
			if (params.format) args.push(`--format=${params.format}`);
			if (params.libs) args.push(`--libs=${params.libs}`);
			if (params.recursive) args.push("--recursive");
			return run(ctx, args, signal);
		},
	});

	// ── projection ──────────────────────────────────────────────────────────
	pi.registerTool({
		name: "yamlet_tests",
		label: "yamlet tests",
		description:
			"Project every acceptance criterion in `src` into a Gherkin .feature tree in `target`, plus a " +
			"manifest.json of the contract tokens each scenario leaves for a consumer to bind.",
		promptSnippet: "Regenerate the Gherkin feature tree from a specs directory",
		promptGuidelines: [
			"yamlet_tests wipes and rebuilds its TARGET directory on every run — confirm the target before calling it, and never point it at a directory holding step definitions.",
		],
		parameters: Type.Object({
			src: Type.String({ description: "Directory to scan for *.yamlet.yaml specs" }),
			target: Type.String({ description: "Directory to write the feature tree into — WIPED on every run" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return run(ctx, ["tests", cleanPath(params.src), cleanPath(params.target)], signal);
		},
	});

	// ── mutating tools ──────────────────────────────────────────────────────
	// Every one of these goes through withFileMutationQueue on the spec path, so
	// two calls touching the same file serialize instead of racing. yamlet's own
	// phase order (init -> components -> connections -> requirements) is enforced
	// by the CLI and reported as an exit-2 error.
	const mutate = (
		file: string,
		ctx: ExtensionContext,
		build: () => string[],
		signal: AbortSignal | undefined,
	) => withFileMutationQueue(resolve(ctx.cwd, cleanPath(file)), () => run(ctx, build(), signal));

	pi.registerTool({
		name: "yamlet_init",
		label: "yamlet init",
		description:
			"Create a new spec. The exposed contract (expose_name, expose_intent, inputs, outputs) is " +
			"immutable after this call.",
		promptSnippet: "Create a new .yamlet.yaml spec (freezes its contract)",
		parameters: Type.Object({
			file: Type.String({ description: "Path of the .yamlet.yaml to create" }),
			system: Type.String({ description: "System slug — reuse an existing one exactly, or coin a new generic one" }),
			topic: Type.String({ description: "Short title for this scope within the system" }),
			summary: Type.String({ description: "One plain sentence; if it needs 'and … and', the scope is too broad" }),
			description: Type.String(),
			blast_radius: StringEnum(["low", "medium", "high"] as const),
			front: StringEnum(["internal", "external"] as const),
			expose_name: Type.Optional(Type.String({ description: "Contract slug, dash-separated (e.g. pdf-upload)" })),
			expose_intent: Type.Optional(Type.String({ description: "What the contract does; required with expose_name" })),
			inputs: Type.Optional(Type.Array(Type.String(), { description: "Contract input tokens, underscore-separated" })),
			outputs: Type.Optional(Type.Array(Type.String(), { description: "Contract output tokens, underscore-separated" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => {
				const args = [
					"init", cleanPath(params.file),
					"--system", params.system,
					"--topic", params.topic,
					"--summary", params.summary,
					"--description", params.description,
					"--blast-radius", params.blast_radius,
					"--front", params.front,
				];
				if (params.expose_name) args.push("--expose-name", params.expose_name);
				if (params.expose_intent) args.push("--expose-intent", params.expose_intent);
				repeat("--input", params.inputs, args);
				repeat("--output", params.outputs, args);
				return args;
			}, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_add_component",
		label: "yamlet add-component",
		description:
			"Declare one member of a composite. Echoes the member's contract: every input listed must be " +
			"wired, outputs are consumed as needed.",
		parameters: Type.Object({
			file: Type.String({ description: "The composite .yamlet.yaml" }),
			alias: Type.String({ description: "Local handle for this member (^[a-z][a-z0-9_]*$)" }),
			path: Type.String({ description: "The member's spec file, relative to the composite" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => [
				"add-component", cleanPath(params.file), params.alias, cleanPath(params.path),
			], signal);
		},
	});

	pi.registerTool({
		name: "yamlet_add_connection",
		label: "yamlet add-connection",
		description:
			"Wire one group of a composite atomically — `group` is a member alias, or 'output' for the " +
			"composite's own outputs. Bind all of that group's sinks in one call. A source is 'input.NAME' or " +
			"'alias.SOCKET' (a member output); member inputs and 'output.NAME' are sinks, never sources.",
		parameters: Type.Object({
			file: Type.String({ description: "The composite .yamlet.yaml" }),
			group: Type.String({ description: "A member alias, or the reserved 'output'" }),
			wires: Type.Array(
				Type.Object({
					socket: Type.String({ description: "The sink being fed: a member input, or a composite output" }),
					source: Type.String({ description: "'input.NAME' or 'alias.SOCKET'" }),
				}),
				{ minItems: 1, description: "Every sink of this group, bound in one call" },
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => [
				"add-connection", cleanPath(params.file), params.group,
				...params.wires.map((w) => `${w.socket}=${w.source}`),
			], signal);
		},
	});

	pi.registerTool({
		name: "yamlet_add_requirement",
		label: "yamlet add-requirement",
		description:
			"Append a requirement and return its assigned RQ-N.",
		promptSnippet: "Append a requirement to a spec (returns its RQ-N)",
		parameters: Type.Object({
			file: Type.String(),
			description: Type.String({ description: "The capability, concrete enough that a reviewer knows what 'done' means" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => [
				"add-requirement", cleanPath(params.file), "--description", params.description,
			], signal);
		},
	});

	pi.registerTool({
		name: "yamlet_add_criterion",
		label: "yamlet add-criterion",
		description:
			"Add one EARS acceptance criterion and return its AC-N. The pattern picks the clauses: ubiquitous " +
			"(none), state (while), event (when), optional (where), unwanted (if), complex (while + exactly " +
			"one of when/if). {input.X}/{output.X} need no examples; any other {placeholder} does, with every " +
			"row binding every placeholder.",
		promptSnippet: "Add an EARS acceptance criterion (returns its AC-N)",
		parameters: Type.Object({
			file: Type.String(),
			rq: Type.String({ description: "The requirement id, e.g. RQ-1 — any requirement, not only the newest" }),
			after: Type.Optional(Type.String({
				description:
					"Insert after this criterion (must belong to rq); the new id takes a letter suffix, " +
					"AC-3 -> AC-3a. Omit to append.",
			})),
			pattern: StringEnum(["ubiquitous", "state", "event", "optional", "unwanted", "complex"] as const),
			when: Type.Optional(Type.String({ description: "event / complex: the discrete trigger" })),
			if: Type.Optional(Type.String({ description: "unwanted / complex: the error or undesired condition" })),
			while: Type.Optional(Type.Array(Type.String(), { description: "state / complex: the state(s) that hold" })),
			where: Type.Optional(Type.String({ description: "optional: the configuration or feature" })),
			shall: Type.Array(Type.String(), { minItems: 1, description: "One atomic, verifiable obligation each" }),
			examples: Type.Optional(Type.Array(Type.String(), {
				description: "Rows binding every placeholder, e.g. 'n=0;delay_seconds=10'",
			})),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => {
				const args = ["add-criterion", cleanPath(params.file), "--rq", params.rq, "--pattern", params.pattern];
				if (params.after) args.push("--after", params.after);
				if (params.when) args.push("--when", params.when);
				if (params.if) args.push("--if", params.if);
				repeat("--while", params.while, args);
				if (params.where) args.push("--where", params.where);
				repeat("--shall", params.shall, args);
				repeat("--example", params.examples, args);
				return args;
			}, signal);
		},
	});

	// ── linking a decision into a spec ──────────────────────────────────────
	// The one in-place mutation of an existing block: it appends a path to the
	// block's `adrs:` list. Queued on the spec like every other spec mutation.
	pi.registerTool({
		name: "yamlet_add_adr",
		label: "yamlet add-adr",
		description:
			"Link a decision record (.adr.yaml, written by the yamlet_adr_* tools) to ONE requirement (rq) or " +
			"ONE criterion (ac) of a spec — exactly one of the two. `adr` is relative to the spec's directory " +
			"and must exist. The same record may be linked on several requirements.",
		promptSnippet: "Link an ADR to a spec's requirement or criterion",
		parameters: Type.Object({
			file: Type.String({ description: "The spec .yamlet.yaml" }),
			adr: Type.String({ description: "The record's path, relative to the spec's directory" }),
			rq: Type.Optional(Type.String({ description: "Link on this requirement: every criterion under it is decided by it" })),
			ac: Type.Optional(Type.String({ description: "Link on this one criterion" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!params.rq === !params.ac) {
				throw new Error("yamlet_add_adr needs exactly one of `rq` (RQ-N) or `ac` (AC-N).");
			}
			return mutate(params.file, ctx, () => [
				"add-adr", cleanPath(params.file), cleanPath(params.adr),
				...(params.rq ? ["--rq", params.rq] : ["--ac", params.ac!]),
			], signal);
		},
	});

	// ── tech spec ───────────────────────────────────────────────────────────
	// Every call rewrites the whole file from a parsed model, so calls on one
	// tech spec are queued on its path exactly like spec mutations.
	pi.registerTool({
		name: "yamlet_techspec_init",
		label: "yamlet techspec init",
		description:
			"Open a tech spec for a FINISHED spec (one yamlet_verify reports OK on): writes " +
			"<spec>.techspec.yaml next to it (or `out`) and returns its path. Refuses to overwrite. The file " +
			"is disposable — plan from it, implement, discard; keep it out of version control.",
		promptSnippet: "Open a disposable .techspec.yaml for a finished spec (returns its path)",
		parameters: Type.Object({
			spec: Type.String({ description: "The finished .yamlet.yaml to plan against" }),
			out: Type.Optional(Type.String({
				description: "Where to write it (must end in .techspec.yaml); default: next to the spec",
			})),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const spec = cleanPath(params.spec);
			const out = params.out ? cleanPath(params.out) : spec.replace(/\.yamlet\.ya?ml$/i, ".techspec.yaml");
			return mutate(out, ctx, () => {
				const args = ["techspec", "init", spec];
				if (params.out) args.push("--out", out);
				return args;
			}, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_techspec_analysis",
		label: "yamlet techspec analysis",
		description:
			"Record what the verdicts are relative to: the commit the code was read at, and the directories " +
			"read closely (`deep`) or only glanced at (`skimmed`), which accumulate across calls. The commit " +
			"is fixed on the first call and read from git in `code_root` unless `commit` is given.",
		promptSnippet: "Pin a tech spec to the commit read, and record which directories were read",
		parameters: Type.Object({
			file: Type.String({ description: "The .techspec.yaml" }),
			code_root: Type.Optional(Type.String({
				description: "Where the code lives; `git rev-parse --short HEAD` runs here (default: the working directory)",
			})),
			commit: Type.Optional(Type.String({
				description: "7–40 hex chars; only when the code was read at a commit other than HEAD of code_root",
			})),
			deep: Type.Optional(Type.Array(Type.String(), { description: "Directories read closely, relative to the code root" })),
			skimmed: Type.Optional(Type.Array(Type.String(), { description: "Directories only glanced at" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const file = cleanPath(params.file);
			let commit = params.commit;
			if (!commit && (await pinnedCommit(resolve(ctx.cwd, file))) === undefined) {
				commit = await gitHead(pi, resolve(ctx.cwd, cleanPath(params.code_root ?? ".")), signal);
			}
			return mutate(file, ctx, () => {
				const args = ["techspec", "analysis", file];
				if (commit) args.push("--commit", commit);
				repeat("--deep", params.deep, args);
				repeat("--skimmed", params.skimmed, args);
				return args;
			}, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_techspec_criterion",
		label: "yamlet techspec criterion",
		description:
			"Record one criterion's verdict. met=true needs `evidence` (PATH:LINE where each shall is " +
			"satisfied) and goes through the evidence challenger first; met=false takes the references as " +
			"evidence and a one-line `note` saying what differs. One verdict per criterion, never revised — " +
			"a wrong one means delete the file and start over. A DECIDED notice in the result names ADRs to read.",
		promptSnippet: "Record a met/unmet verdict for one criterion, with file:line evidence",
		parameters: Type.Object({
			file: Type.String({ description: "The .techspec.yaml" }),
			ac: Type.String({ description: "The criterion's id in the spec, e.g. AC-3" }),
			met: Type.Boolean({ description: "true only when EVERY shall is observably satisfied at a cited reference" }),
			evidence: Type.Optional(Type.Array(Type.String(), {
				description: "PATH:LINE references, relative to the code root; required when met",
			})),
			note: Type.Optional(Type.String({ description: "One line: what falls short, or a caveat" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => {
				const args = [
					"techspec", "criterion", cleanPath(params.file),
					"--ac", params.ac, "--met", params.met ? "true" : "false",
				];
				repeat("--evidence", params.evidence, args);
				if (params.note) args.push("--note", params.note);
				return args;
			}, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_techspec_task",
		label: "yamlet techspec task",
		description:
			"Append a task and return its T-N. `covers` names unmet criteria (AC-N) whose verdicts are " +
			"recorded, or obligations (ADR-nnnn#R-n) of records the spec links; a task covering nothing is an " +
			"enabler and needs `why`. `depends_on` names tasks that already exist. The title states the " +
			"behaviour delivered, not the activity.",
		promptSnippet: "Append a task to a tech spec (returns its T-N)",
		parameters: Type.Object({
			file: Type.String({ description: "The .techspec.yaml" }),
			title: Type.String({ description: "The behaviour this task delivers" }),
			covers: Type.Optional(Type.Array(Type.String(), { description: "AC-N or ADR-nnnn#R-n, each unmet/uncovered" })),
			depends_on: Type.Optional(Type.Array(Type.String(), { description: "T-N of tasks that must land first" })),
			why: Type.Optional(Type.String({ description: "For an enabler (no covers): what it makes possible" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => {
				const args = ["techspec", "task", cleanPath(params.file), "--title", params.title];
				repeat("--covers", params.covers, args);
				repeat("--depends-on", params.depends_on, args);
				if (params.why) args.push("--why", params.why);
				return args;
			}, signal);
		},
	});

	// ── decision records ────────────────────────────────────────────────────
	// Phase-ordered by the CLI (forces any time; basis -> dimensions -> options
	// -> decide -> obligations/accepts/revisit -> accept), frozen after accept.
	// `init` mints the next id in DIR, so it is queued on the directory; every
	// other call rewrites one record and is queued on that file.
	pi.registerTool({
		name: "yamlet_adr_init",
		label: "yamlet adr init",
		description:
			"Start a decision record: writes DIR/ADR-nnnn-<slug>.adr.yaml (the next id in DIR) as proposed " +
			"and returns its path. A record must arise from a spec criterion or requirement " +
			"(`arises_from`: SPEC.yamlet.yaml#AC-n) or assume a prior record (`assumes`: ADR-nnnn); every " +
			"reference is resolved before anything is written. The question must be answerable by choosing " +
			"one option.",
		promptSnippet: "Start a decision record (.adr.yaml) in a records directory (returns its path)",
		parameters: Type.Object({
			dir: Type.String({ description: "The records directory (one per system); must exist" }),
			title: Type.String(),
			kind: StringEnum(["selection", "mechanism", "policy", "boundary", "sequencing"] as const, {
				description: "selection (a product; every option then needs a ref), mechanism (a pattern), policy (a fixed value), boundary, sequencing",
			}),
			question: Type.String({ description: "Answerable by choosing one option" }),
			arises_from: Type.Optional(Type.Array(Type.String(), {
				description: "SPEC.yamlet.yaml#AC-n or #RQ-n, relative to dir",
			})),
			assumes: Type.Optional(Type.Array(Type.String(), { description: "ADR-nnnn, lower-numbered records in dir" })),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD (default: today)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.dir, ctx, () => {
				const args = [
					"adr", "init", cleanPath(params.dir),
					"--title", params.title, "--kind", params.kind, "--question", params.question,
				];
				repeat("--arises-from", params.arises_from, args);
				repeat("--assumes", params.assumes, args);
				if (params.date) args.push("--date", params.date);
				return args;
			}, signal);
		},
	});

	/** The `FILE TEXT` shape shared by add-force / add-obligation / add-accept / add-revisit. */
	const textTool = (name: string, sub: string, description: string, promptSnippet: string, text: string) =>
		pi.registerTool({
			name,
			label: `yamlet adr ${sub}`,
			description,
			promptSnippet,
			parameters: Type.Object({
				file: Type.String({ description: "The .adr.yaml" }),
				text: Type.String({ description: text }),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return mutate(params.file, ctx, () => ["adr", sub, cleanPath(params.file), params.text], signal);
			},
		});

	textTool(
		"yamlet_adr_add_force", "add-force",
		"Add one force: a constraint OUTSIDE the author's control (a trust boundary, a spec obligation, a " +
		"distribution model). A prior record's obligation is cited as ADR-nnnn#R-n, never restated. Allowed " +
		"at any phase.",
		"Add a force (an external constraint) to a decision record",
		"The constraint, one sentence",
	);

	pi.registerTool({
		name: "yamlet_adr_add_basis",
		label: "yamlet adr add-basis",
		description:
			"Declare the load a measured dimension's numbers are stated under (a volume, a horizon) and " +
			"return its B-n. Needs a numeral in the quantity and a source. Before any dimension that cites it.",
		promptSnippet: "Add a measurement basis to a decision record (returns its B-n)",
		parameters: Type.Object({
			file: Type.String({ description: "The .adr.yaml" }),
			quantity: Type.String({ description: "With a numeral, e.g. '40000 uploads / month'" }),
			source: Type.String({ description: "Where the number comes from" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => [
				"adr", "add-basis", cleanPath(params.file), "--quantity", params.quantity, "--source", params.source,
			], signal);
		},
	});

	pi.registerTool({
		name: "yamlet_adr_add_dimension",
		label: "yamlet adr add-dimension",
		description:
			"Declare one axis the options are judged on and return its D-n. `matters` states the THRESHOLD at " +
			"which the axis decides anything, not what the axis is. A measured dimension names its unit, its " +
			"source (a shared yardstick) and the basis it is stated under. All dimensions before any option.",
		promptSnippet: "Add a dimension (a decisive threshold) to a decision record (returns its D-n)",
		parameters: Type.Object({
			file: Type.String({ description: "The .adr.yaml" }),
			matters: Type.String({ description: "The threshold at which this axis decides anything" }),
			unit: Type.Optional(Type.String({ description: "Makes the dimension measured: every cell then needs a numeral" })),
			source: Type.Optional(Type.String({ description: "The yardstick the cells are measured with" })),
			basis: Type.Optional(Type.Array(Type.String(), { description: "B-n the numbers are stated under" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => {
				const args = ["adr", "add-dimension", cleanPath(params.file), "--matters", params.matters];
				if (params.unit) args.push("--unit", params.unit);
				if (params.source) args.push("--source", params.source);
				repeat("--basis", params.basis, args);
				return args;
			}, signal);
		},
	});

	pi.registerTool({
		name: "yamlet_adr_add_option",
		label: "yamlet adr add-option",
		description:
			"Add one option, judged against EVERY declared dimension in this one call, and return its OPT-n. " +
			"A cell states a fact; on a measured dimension it carries a numeral; 'n/a — <reason>' is allowed, " +
			"a bare 'n/a' is not. kind=selection needs at least one ref (a locator: URL, path, citation) per option.",
		promptSnippet: "Add an option judged against every dimension (returns its OPT-n)",
		parameters: Type.Object({
			file: Type.String({ description: "The .adr.yaml" }),
			summary: Type.String({ description: "The option, one line; the status quo counts" }),
			reversibility: StringEnum(["reversible", "costly", "one-way"] as const),
			refs: Type.Optional(Type.Array(
				Type.Object({
					label: Type.String({ description: "e.g. project, licence, docs" }),
					locator: Type.String({ description: "A URL, path or short citation — never prose" }),
				}),
				{ description: "Locators for this option; required under kind=selection" },
			)),
			against: Type.Array(
				Type.Object({
					dimension: Type.String({ description: "D-n" }),
					text: Type.String({ description: "The fact for this option on that dimension" }),
				}),
				{ minItems: 1, description: "One cell per declared dimension — exactly the declared set" },
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => [
				"adr", "add-option", cleanPath(params.file),
				"--summary", params.summary, "--reversibility", params.reversibility,
				...(params.refs ?? []).flatMap((r) => ["--ref", `${r.label}=${r.locator}`]),
				...params.against.flatMap((a) => ["--against", `${a.dimension}=${a.text}`]),
			], signal);
		},
	});

	pi.registerTool({
		name: "yamlet_adr_decide",
		label: "yamlet adr decide",
		description:
			"Record the user's choice among the options. After every option is judged against every dimension; " +
			"before the obligations, accepted costs and revisit conditions.",
		promptSnippet: "Record which option a decision record chooses",
		parameters: Type.Object({
			file: Type.String({ description: "The .adr.yaml" }),
			option: Type.String({ description: "OPT-n" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => ["adr", "decide", cleanPath(params.file), params.option], signal);
		},
	});

	textTool(
		"yamlet_adr_add_obligation", "add-obligation",
		"Add what the decision obliges — work, in the imperative — and return its R-n. Addressable as " +
		"ADR-nnnn#R-n: a tech spec task covers it exactly as it covers a criterion. After decide.",
		"Add an obligation to a decision record (returns its R-n)",
		"Imperative voice: the work the decision requires",
	);
	textTool(
		"yamlet_adr_add_accept", "add-accept",
		"Add a cost the decision takes knowingly. Deliberately not addressable: nothing discharges a cost. " +
		"After decide.",
		"Add an accepted cost to a decision record",
		"The cost, one sentence",
	);
	textTool(
		"yamlet_adr_add_revisit", "add-revisit",
		"Add a condition under which the decision stops being right; one with a threshold names its number. " +
		"After decide.",
		"Add a revisit condition to a decision record",
		"The condition, with its number if it has one",
	);

	/** The `FILE [--date D]` shape shared by accept and reject. */
	const statusTool = (name: string, sub: string, description: string, promptSnippet: string) =>
		pi.registerTool({
			name,
			label: `yamlet adr ${sub}`,
			description,
			promptSnippet,
			parameters: Type.Object({
				file: Type.String({ description: "The .adr.yaml" }),
				date: Type.Optional(Type.String({ description: "YYYY-MM-DD (default: today)" })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				return mutate(params.file, ctx, () => {
					const args = ["adr", sub, cleanPath(params.file)];
					if (params.date) args.push("--date", params.date);
					return args;
				}, signal);
			},
		});

	statusTool(
		"yamlet_adr_accept", "accept",
		"Accept a decided record that verifies clean, and FREEZE it: afterwards only reject, supersede and " +
		"their dates change. The spec must then link it (yamlet_add_adr).",
		"Accept and freeze a decision record",
	);
	statusTool(
		"yamlet_adr_reject", "reject",
		"Reject a proposed record. Only from proposed; an accepted record is superseded, never rejected.",
		"Reject a proposed decision record",
	);

	pi.registerTool({
		name: "yamlet_adr_supersede",
		label: "yamlet adr supersede",
		description:
			"Mark an accepted record as superseded by a newer one (which should `assumes` it). The old record " +
			"and its links stay; they are history. Then link the new record where the old one was.",
		promptSnippet: "Supersede an accepted decision record by a newer one",
		parameters: Type.Object({
			file: Type.String({ description: "The old .adr.yaml" }),
			by: Type.String({ description: "ADR-nnnn of the successor, in the same directory" }),
			date: Type.Optional(Type.String({ description: "YYYY-MM-DD (default: today)" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return mutate(params.file, ctx, () => {
				const args = ["adr", "supersede", cleanPath(params.file), "--by", params.by];
				if (params.date) args.push("--date", params.date);
				return args;
			}, signal);
		},
	});
}
