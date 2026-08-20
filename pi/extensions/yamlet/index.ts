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

const INSTALL_HINT =
	"`yamlet` is not on PATH. Install it with:\n" +
	"    brew tap RicardoMonteiroSimoes/yamlet\n" +
	"    brew trust --tap RicardoMonteiroSimoes/yamlet\n" +
	"    brew install yamlet\n" +
	"or download a binary for your platform from\n" +
	"https://github.com/RicardoMonteiroSimoes/Yamlet/releases/latest and put it on your PATH.\n" +
	"The yamlet_* tools shell out to that binary and cannot work without it.";

/** Subcommands this extension exposes; a CLI missing any of them is too old. */
const REQUIRED_COMMANDS = [
	"verify", "systems", "impact", "graph", "tests",
	"init", "add-component", "add-connection", "add-requirement", "add-criterion",
] as const;

/** Some models prefix path arguments with `@`; built-in tools strip it, so do we. */
const cleanPath = (p: string): string => (p.startsWith("@") ? p.slice(1) : p);

type Probe =
	| { ok: true; version: string }
	| { ok: false; reason: string };

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
				const missing = REQUIRED_COMMANDS.filter((c) => !new RegExp(`^\\s+${c}\\s`, "m").test(h.stdout));
				if (missing.length > 0) {
					return {
						ok: false,
						reason:
							`Found ${version}, but it is missing the command(s) this extension needs: ` +
							`${missing.join(", ")}.\nUpgrade with \`brew upgrade yamlet\`, or download a newer ` +
							`build from https://github.com/RicardoMonteiroSimoes/Yamlet/releases/latest.`,
					};
				}
			}
			return { ok: true, version };
		})();
		cachedProbe = run.then((p) => {
			if (!p.ok) cachedProbe = undefined; // retry next time; a mid-session install should just work
			return p;
		});
		return cachedProbe;
	};
}

/* ── shipping the challenger agents ──────────────────────────────────────────
 *
 * `pi install` can deliver an extension and skills, but NOT agents:
 * @tintinweb/pi-subagents discovers those from three hardcoded directories
 * (.pi/agents/, .agents/agents/, $PI_CODING_AGENT_DIR/agents/) with no
 * package-based discovery, no configurable path, and no public registration RPC
 * — its cross-extension surface is ping/spawn/stop only.
 *
 * Left alone, that means a `pi install` of this package half-installs: the author
 * skill runs, finds no `Agent` tool, and quietly degrades to reviewing its own
 * proposals — losing the adversarial gates, which are the point. So the package
 * offers to place its own agent files, with consent, and says what it did.
 *
 * Deliberately conservative: it asks before writing anything outside its own
 * directory, never overwrites a file the user has edited without saying so,
 * stays silent when pi-subagents is absent (there would be nothing to install
 * them for), and never writes at all without a UI to ask through.
 */
const AGENT_FILES = ["yamlet-contract-challenger.md", "yamlet-criteria-challenger.md"];

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
 * The last two entries are the challenger *checklists*, served for the degraded
 * path where `@tintinweb/pi-subagents` is absent: the skill then has to run the
 * gate inline, and "find the agent file yourself" is exactly the instruction that
 * turns into skipping the gate.
 */
const GUIDE_FILES = {
	creating: ["skills/yamlet-author/references", "creating.md"],
	editing: ["skills/yamlet-author/references", "editing.md"],
	composites: ["skills/yamlet-author/references", "composites.md"],
	patterns: ["skills/yamlet-author/references", "patterns.md"],
	"contract-challenge": ["agents", "yamlet-contract-challenger.md"],
	"criteria-challenge": ["agents", "yamlet-criteria-challenger.md"],
} as const;

type GuideTopic = keyof typeof GUIDE_FILES;

const GUIDE_TOPICS: Record<GuideTopic, string> = {
	creating: "Setting up a NEW spec: systems discovery, topic, front, summary, blast-radius, contract, init.",
	editing: "Changing a spec that ALREADY EXISTS: locating the right file, reading its blast radius, what is possible.",
	composites: "Declaring members and wiring connections on a composite.",
	patterns: "The six EARS patterns, the three kinds of {token}, and placeholder examples.",
	"contract-challenge": "The contract gate's checklist — only for running it inline when the Agent tool is absent.",
	"criteria-challenge": "The criteria gate's checklist — only for running it inline when the Agent tool is absent.",
};

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
	if (!SPEC_RE.test(command)) return false;
	return command.split(/\|\||&&|[;\n|]/).some((segment) => {
		const s = segment.trim();
		if (!SPEC_RE.test(s)) return false;
		// A redirect into a spec is blocked whatever produced the bytes — including
		// `yamlet graph a.yamlet.yaml > b.yamlet.yaml`, which is still the shell
		// writing the file rather than the CLI's own serializer. (`graph` itself
		// now refuses a `*.yamlet.yaml` --out, so the two guards agree: a graph
		// never lands on a spec, by either route.)
		if (/>>?\s*\S*\.yamlet\.ya?ml\b/i.test(s)) return true;
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
		}
		// Convenience, never a prerequisite: a failure here must not take down the
		// session, and the yamlet_* tools work with or without the challengers.
		try {
			await offerAgentInstall(ctx);
		} catch {
			// deliberately silent — the author skill reports missing gates itself
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

		const what = missing.join(" and ");
		if (!ctx.hasUI) {
			ctx.ui.notify(
				`yamlet: the challenger agent${missing.length === 1 ? "" : "s"} (${what}) ${missing.length === 1 ? "is" : "are"} ` +
				`not installed, so the author skill's adversarial gates cannot run. Copy ${src}/*.md into ` +
				`${dest} (or run the package's install.sh).`,
				"info",
			);
			return;
		}

		const yes = await ctx.ui.confirm(
			"Install the yamlet challenger agents?",
			`The yamlet author flow runs two adversarial reviewers as subagents. ${what} ` +
			`${missing.length === 1 ? "is" : "are"} not on disk yet, and pi-subagents can only load agents ` +
			`from a fixed set of directories — a package cannot ship them.\n\n` +
			`Copy them to ${dest}? Without them the author still works, but reviews its own proposals.`,
		);
		if (!yes) {
			ctx.ui.notify("yamlet: skipped. The author will say so when it reaches a gate.", "info");
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
				`pi-subagents reads agents at startup.`,
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
						`yamlet_add_criterion, …) instead. Note that this version cannot edit or delete ` +
						`committed content; if that is what you need, say so rather than working around it.`,
				};
			}
		}

		if (event.toolName === "bash") {
			const command = typeof input?.command === "string" ? input.command : "";
			if (shellWritesSpec(command)) {
				return {
					block: true,
					reason:
						"Refusing a shell command that writes a .yamlet.yaml. Specs are written only by the " +
						"yamlet CLI — use the yamlet_* tools. (Running `yamlet ...` itself is fine.)",
				};
			}
		}
	});

	// ── read-only tools ─────────────────────────────────────────────────────
	pi.registerTool({
		name: "yamlet_systems",
		label: "yamlet systems",
		description:
			"List the systems already defined across a directory of specs, grouped by their scope files. " +
			"Run this BEFORE creating any new spec: reusing an existing system's exact slug is what keeps a " +
			"service from fragmenting into near-duplicates. Pass details=true to read each scope's summary " +
			"and description — a slug and a topic say what a service is CALLED, only the prose says what it " +
			"COVERS, and nothing downstream ever flags a fragmented service. Pass contracts=true to also " +
			"print each scope's exposed input/output signature, which is what you wire a composite against.",
		promptSnippet: "Discover existing yamlet systems, their summaries and their contracts",
		parameters: Type.Object({
			dir: Type.Optional(Type.String({ description: "Directory to scan for *.yamlet.yaml (default: .)" })),
			system: Type.Optional(Type.String({ description: "Show only the system with this exact slug" })),
			details: Type.Optional(Type.Boolean({
				description: "Include each scope's summary and description — required before recommending a system",
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
			"Read one of the yamlet-author procedures. The author skill is a router: it asks whether this is a " +
			"new spec or a change to an existing one, then reads the matching procedure from here rather than " +
			"carrying all of them at once. Load 'creating' or 'editing' at the start of the work, 'composites' " +
			"when the scope wires existing services together, and 'patterns' when you reach acceptance-criteria. " +
			"Read only the one in play. The two '*-challenge' topics are the challenger checklists, needed only " +
			"when the Agent tool is unavailable and the gate has to be run inline.",
		promptSnippet: "Read a yamlet-author procedure or challenger checklist",
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
			"and which of its sockets each one binds, consumes or names in prose. Every exposes contract is " +
			"TOTAL — a composite must bind every input of every member — so adding an input reaches every file " +
			"listed here, and removing an input or output breaks each consumer that uses it. Run this before " +
			"proposing any change to an exposes block, and before removing a spec. Read the scanned count: a " +
			"consumer outside the scanned tree is one this cannot see.",
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
			"Check a spec against the rule catalog — the mechanical source of truth for validity. " +
			"Exit 0 prints `OK: …`; otherwise it prints E### errors (invalid) and W### warnings (non-fatal). " +
			"Set list_rules=true (with no file) to print the catalog and resolve what a rule ID means. " +
			"Verify at the END of authoring: a declared input/output that nothing references yet is an error, " +
			"so an early run reports failures that are not real.",
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
			"WRITE a graph model of one spec or a whole directory TO A FILE — dot (one spec, one level), " +
			"json (the yamlet.graph/v1 model), or html (a self-contained interactive viewer). The graph is " +
			"never returned to you: `out` is required, the payload goes there, and this tool returns one " +
			"summary line (path, format, size, roots/members/wires). Report that path to the user and stop " +
			"— do NOT read the file back. format=html inlines the elk layout engine and is ~1.6 MB whatever " +
			"the spec count; reading it would end the session's context in a single call. Use recursive=true " +
			"to expand composite members deeply; a directory or recursive requires json or html, not dot.",
		promptSnippet: "Write a spec graph (dot/json/html) to a file",
		promptGuidelines: [
			"yamlet_graph writes to `out` and returns only a summary — hand the user the path, never read the graph file back into context.",
		],
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "A spec file or a directory of specs (default: .)" })),
			out: Type.String({
				description:
					"REQUIRED. Path to write the graph to (e.g. graph.html). Must not be a *.yamlet.yaml path.",
			}),
			format: Type.Optional(StringEnum(["dot", "json", "html"] as const)),
			libs: Type.Optional(StringEnum(["embed", "cdn"] as const)),
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
			"Project every acceptance criterion in SRC into a Gherkin .feature tree in TARGET, plus a " +
			"manifest.json of the contract tokens each scenario leaves for a consumer to bind. " +
			"TARGET is yamlet-owned: every run WIPES AND REBUILDS it, so the tests can never drift from the " +
			"specs — never keep step definitions, fixtures or runner config there, they belong in the " +
			"consumer's own directory and are erased on the next run. Run once, at the very end, after " +
			"verification passes.",
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
			"Create a new spec, correct by construction. The exposed contract (expose_name, expose_intent, " +
			"inputs, outputs) is IMMUTABLE after this call — settle it with the user first. Naming rules and " +
			"what must reference each input/output: see the yamlet-author skill.",
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
			"Declare one member of a composite. Echoes the member's contract: every listed input MUST be " +
			"wired or verify fails; outputs are consumed as needed. All components before any connection, " +
			"and all wiring before the first requirement — the CLI refuses components once one exists.",
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
			"Wire one group of a composite atomically — group is a member alias, or 'output' for the " +
			"composite's own outputs. Must bind ALL of that group's sinks in one call; partial wiring is " +
			"rejected. A source is 'input.NAME' or 'alias.SOCKET' (a member OUTPUT); member inputs and " +
			"'output.NAME' are sinks, never sources. Cycles are allowed.",
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
			"Append a requirement and return its assigned RQ-N — read that id from the output, never invent " +
			"it. One capability per requirement. ONE-WAY: a committed requirement cannot be edited, and " +
			"criteria attach only to the most recent one, so finish each before starting the next.",
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
			"Add one EARS acceptance criterion and return its AC-N. The pattern picks the clauses: " +
			"ubiquitous (none), state (while), event (when), optional (where), unwanted (if), complex " +
			"(while + exactly one of when/if). Each shall is one atomic, observable obligation. " +
			"{input.X}/{output.X} need no examples; any other {placeholder} requires examples, with every " +
			"row binding every placeholder. rq may name ANY requirement in the file, not only the newest; " +
			"pass after=AC-N to insert directly behind a named sibling instead of appending.",
		promptSnippet: "Add an EARS acceptance criterion (returns its AC-N)",
		parameters: Type.Object({
			file: Type.String(),
			rq: Type.String({ description: "The requirement id, e.g. RQ-1 — any requirement, not only the newest" }),
			after: Type.Optional(Type.String({
				description:
					"Insert directly after this criterion (must belong to rq). The new id takes a letter " +
					"suffix on it — after AC-3 comes AC-3a — so nothing is renumbered. Omit to append.",
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
}
