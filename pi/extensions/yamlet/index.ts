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
import { resolve } from "node:path";
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
	"verify", "systems", "graph", "tests",
	"init", "add-component", "add-connection", "add-requirement", "add-criterion",
] as const;

/** Some models prefix path arguments with `@`; built-in tools strip it, so do we. */
const cleanPath = (p: string): string => (p.startsWith("@") ? p.slice(1) : p);

type Probe =
	| { ok: true; version: string }
	| { ok: false; reason: string };

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
			let version: string;
			try {
				const v = await pi.exec("yamlet", ["--version"], { cwd, timeout: 5000 });
				if (v.code === 127) return { ok: false, reason: INSTALL_HINT };
				if (v.code !== 0) {
					return { ok: false, reason: `\`yamlet --version\` exited ${v.code}.\n${v.stderr.trim()}` };
				}
				version = v.stdout.trim() || "unknown version";
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				return { ok: false, reason: `${INSTALL_HINT}\n\n(${detail})` };
			}

			try {
				const h = await pi.exec("yamlet", ["help"], { cwd, timeout: 5000 });
				if (h.code === 0) {
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
			} catch {
				// `help` is a capability nicety; if it cannot run but --version could,
				// do not fail the session over it — the per-call errors still apply.
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

	let res: { stdout: string; stderr: string; code: number; killed: boolean };
	try {
		res = await pi.exec("yamlet", args, { signal, cwd: ctx.cwd });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`${INSTALL_HINT}\n\n(${detail})`);
	}
	if (res.code === 127) throw new Error(INSTALL_HINT);

	const text = [res.stdout, res.stderr].map((s) => s.trimEnd()).filter(Boolean).join("\n");
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
		if (/^(?:sudo\s+)?yamlet\b/.test(s)) return false;
		return (
			/>>?\s*\S*\.yamlet\.ya?ml\b/i.test(s) ||
			/\btee\b/.test(s) ||
			/\bsed\b[^&]*\s-i\b/.test(s)
		);
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
	});

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
			"service from fragmenting into near-duplicates. Pass contracts=true to also print each scope's " +
			"exposed input/output signature, which is what you wire a composite against.",
		promptSnippet: "Discover existing yamlet systems and their exposed contracts",
		parameters: Type.Object({
			dir: Type.Optional(Type.String({ description: "Directory to scan for *.yamlet.yaml (default: .)" })),
			system: Type.Optional(Type.String({ description: "Show only the system with this exact slug" })),
			contracts: Type.Optional(Type.Boolean({ description: "Include each scope's exposed contract signature" })),
			format: Type.Optional(StringEnum(["human", "json"] as const)),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["systems"];
			if (params.dir) args.push(cleanPath(params.dir));
			if (params.system) args.push(`--system=${params.system}`);
			if (params.contracts) args.push("--contracts");
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
			"Emit a graph model of one spec or a whole directory — dot (one spec, one level), json (the " +
			"yamlet.graph/v1 model), or html (a self-contained interactive viewer). Use recursive=true to " +
			"expand composite members deeply; a directory or recursive requires json or html, not dot.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "A spec file or a directory of specs (default: .)" })),
			format: Type.Optional(StringEnum(["dot", "json", "html"] as const)),
			libs: Type.Optional(StringEnum(["embed", "cdn"] as const)),
			recursive: Type.Optional(Type.Boolean({ description: "Expand composite members deeply" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["graph"];
			if (params.target) args.push(cleanPath(params.target));
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
			"inputs, outputs) is IMMUTABLE after this call — it cannot be added to or corrected later, so " +
			"settle it with the user first. expose_name is a dash slug (^[a-z0-9]+(-[a-z0-9]+)*$); each input " +
			"and output is an underscore token (^[a-z][a-z0-9_]*$). Declaring inputs/outputs requires " +
			"expose_name, which requires expose_intent. On a leaf, every declared input must later be " +
			"referenced by a criterion as {input.NAME} and every output as {output.NAME}, or verify fails — " +
			"so declare only what the behaviour actually uses.",
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
			"Declare one member of a composite. alias is a token you coin as the local handle for this member " +
			"in the wiring ('input' and 'output' are reserved); path is the member's spec, resolved relative " +
			"to the composite, which must already exist and expose a contract. Echoes the member's contract: " +
			"every listed input MUST be wired or verify fails, outputs are consumed as needed. Declare all " +
			"components before any connection, and all wiring before the first requirement — the CLI refuses " +
			"components once a requirement exists.",
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
			"Wire one group of a composite atomically. group is a member alias (binding that member's inputs) " +
			"or the reserved 'output' (feeding the composite's own declared outputs). The call must bind ALL " +
			"of that group's sinks at once — partial wiring is rejected, so gather them first. Direction is " +
			"strict: a source is either 'input.NAME' (a boundary input) or 'alias.SOCKET' (an OUTPUT of an " +
			"already-declared member). A member input, or 'output.NAME', is a sink and never a source. Cycles " +
			"are allowed.",
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
			"Append a requirement and print its assigned RQ-N — never invent that id yourself, read it from " +
			"the output. One capability per requirement; split anything joined by 'and'. This is ONE-WAY: a " +
			"committed requirement cannot be edited or deleted in this version, and criteria can only be " +
			"attached to the most recent requirement, so finish each one before starting the next.",
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
			"Append one EARS acceptance criterion to a requirement and print its AC-N. Pick the pattern by " +
			"what triggers the behaviour: ubiquitous (always on, no clause), state (while), event (when), " +
			"optional (where), unwanted (if — error/undesired conditions), complex (while + exactly one of " +
			"when/if). Each shall is one atomic, observable obligation. {input.NAME}/{output.NAME} reference " +
			"the declared contract and need no examples; any other {placeholder} REQUIRES examples, and every " +
			"row must bind every placeholder. Pass text plainly — do not quote {...} yourself.",
		promptSnippet: "Append an EARS acceptance criterion (returns its AC-N)",
		parameters: Type.Object({
			file: Type.String(),
			rq: Type.String({ description: "The requirement id, e.g. RQ-1 — as printed by yamlet_add_requirement" }),
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
