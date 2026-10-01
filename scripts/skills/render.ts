/**
 * render.ts — turns one skill source into its Claude Code or pi file.
 *
 * A source is Markdown with a deliberately small set of directives, so the raw
 * file still reads as the skill it is:
 *
 *   {{#claude}} … {{/claude}}   kept only in the Claude Code build
 *   {{#pi}} … {{/pi}}           kept only in the pi build
 *   {{ A || B }}                A in the Claude Code build, B in the pi build
 *   {{cmd ARGV}}                a `yamlet` invocation, written in CLI syntax
 *   {{tool SUB}}                a command's name: `yamlet SUB` / `yamlet_SUB`
 *   {{ref TOPIC}}               a reference: `references/TOPIC.md` / `yamlet_guide(...)`
 *   {{invoke SKILL ARGS}}       how a user invokes a skill: `/SKILL` / `/skill:SKILL`
 *
 * A block tag alone on its line takes the line with it. Nothing nests.
 *
 * The frontmatter is not parsed as YAML: it is cut into top-level keys and each
 * key's text is copied through as written (after the directives above), so a
 * folded description keeps the line breaks it was reviewed with.
 */

import { type Arg, lookup } from "./commands.ts";

export type Harness = "claude" | "pi";
export type Kind = "skill" | "agent";

export class SourceError extends Error {}

// ── frontmatter ─────────────────────────────────────────────────────────────

/** A top-level frontmatter key: its name and its full text, key line included. */
interface Entry {
  key: string;
  text: string;
}

/** Cut a frontmatter block into its top-level keys, in order. */
function entries(block: string): Entry[] {
  const out: Entry[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(line);
    if (match) {
      out.push({ key: match[1]!, text: line });
    } else if (/^\s/.test(line) && out.length > 0) {
      out[out.length - 1]!.text += "\n" + line;
    } else {
      throw new SourceError(
        `frontmatter: cannot read line ${JSON.stringify(line)}`,
      );
    }
  }
  return out;
}

/** The scalar value of a one-line entry (`key: value`). */
function scalar(entry: Entry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.text.slice(entry.key.length + 1).trim();
}

/** A flow list (`[a, b]`) or a single scalar, as items. */
function list(entry: Entry | undefined): string[] {
  const value = scalar(entry);
  if (value === undefined || value === "") return [];
  const inner = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  return inner.split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** The entries of a nested block (`claude:` / `pi:`), dedented one level. */
function nested(entry: Entry | undefined): Entry[] {
  if (!entry) return [];
  const lines = entry.text.split("\n").slice(1);
  const indent = /^(\s*)/.exec(lines.find((l) => l.trim() !== "") ?? "")![1]!;
  return entries(
    lines.map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l)).join(
      "\n",
    ),
  );
}

export interface Source {
  name: string;
  kind: Kind;
  /** The yamlet_guide topic a pi agent's checklist is served under. */
  guide?: string;
  frontmatter: Entry[];
  body: string;
}

const SHARED = new Set([
  "name",
  "kind",
  "description",
  "tools",
  "invokes",
  "effort",
  "guide",
  "claude",
  "pi",
]);

export function parse(path: string, text: string): Source {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new SourceError(`${path}: no frontmatter`);
  const frontmatter = entries(match[1]!);
  const get = (k: string) => frontmatter.find((e) => e.key === k);
  for (const e of frontmatter) {
    if (!SHARED.has(e.key)) {
      throw new SourceError(
        `${path}: unknown key '${e.key}' — a harness-only field goes under claude: or pi:`,
      );
    }
  }
  const name = scalar(get("name"));
  if (!name) throw new SourceError(`${path}: no name`);
  const kind = scalar(get("kind")) ?? "skill";
  if (kind !== "skill" && kind !== "agent") {
    throw new SourceError(`${path}: kind must be skill or agent`);
  }
  if (!get("description")) throw new SourceError(`${path}: no description`);
  return {
    name,
    kind,
    guide: scalar(get("guide")),
    frontmatter,
    body: text.slice(match[0].length),
  };
}

// ── tools ───────────────────────────────────────────────────────────────────

/**
 * The abstract tool vocabulary a source declares, and what each grants per
 * harness. `yamlet` is the whole CLI; `yamlet:SUB` one subcommand; `git:SUB`
 * one read-only git subcommand.
 */
function claudeTool(tool: string): string {
  const fixed: Record<string, string> = {
    read: "Read",
    grep: "Grep",
    glob: "Glob",
    yamlet: "Bash(yamlet:*)",
  };
  if (fixed[tool]) return fixed[tool]!;
  const m = /^(yamlet|git):(.+)$/.exec(tool);
  if (m) return `Bash(${m[1]} ${m[2]}:*)`;
  throw new SourceError(`unknown tool '${tool}'`);
}

/** pi built-ins first, then extension tools — the order pi-subagents documents. */
function piTools(tools: string[]): { builtins: string[]; ext: string[] } {
  const builtins: string[] = [];
  const ext: string[] = [];
  for (const tool of tools) {
    if (tool === "read" || tool === "grep") builtins.push(tool);
    else if (tool === "glob") builtins.push("find", "ls");
    else if (tool.startsWith("yamlet:")) {
      ext.push(`ext:yamlet/yamlet_${tool.slice(7).replaceAll("-", "_")}`);
    } else if (tool === "yamlet") ext.push("ext:yamlet");
    else if (tool.startsWith("git:")) {
      throw new SourceError(
        `'${tool}' has no pi equivalent for an agent (no bash)`,
      );
    } else throw new SourceError(`unknown tool '${tool}'`);
  }
  return { builtins, ext };
}

// ── frontmatter emission ────────────────────────────────────────────────────

/** Key order per output, so a generated file reads like a hand-written one. */
const ORDER: Record<string, string[]> = {
  claude: [
    "name",
    "description",
    "argument-hint",
    "context",
    "background",
    "model",
    "effort",
    "allowed-tools",
  ],
  "pi-skill": ["name", "description"],
  "pi-agent": [
    "description",
    "display_name",
    "color",
    "thinking",
    "extensions",
    "skills",
    "tools",
    "prompt_mode",
    "inherit_context",
    "run_in_background",
    "max_turns",
  ],
};

/** Fields every agent carries unless its source says otherwise. */
const AGENT_DEFAULTS: Record<string, Record<string, string>> = {
  claude: { context: "fork", background: "false" },
  pi: {
    skills: "false",
    prompt_mode: "replace",
    inherit_context: "false",
    run_in_background: "false",
  },
};

function frontmatterFor(src: Source, harness: Harness): string {
  const get = (k: string) => src.frontmatter.find((e) => e.key === k);
  const out = new Map<string, string>();
  const set = (key: string, value: string) => out.set(key, `${key}: ${value}`);

  const agentOnPi = harness === "pi" && src.kind === "agent";
  // A pi agent is named by its filename; a `name:` there would be a second source of it.
  if (!agentOnPi) set("name", src.name);
  out.set("description", directives(get("description")!.text, harness));

  if (src.kind === "agent") {
    for (const [k, value] of Object.entries(AGENT_DEFAULTS[harness]!)) {
      set(k, value);
    }
  }

  const tools = list(get("tools"));
  const effort = scalar(get("effort"));
  if (harness === "claude") {
    if (effort) set("effort", effort);
    const invokes = list(get("invokes")).flatMap((skill) => [
      `Skill(${skill} *)`,
      `Skill(yamlet-skills:${skill} *)`,
    ]);
    const granted = [...tools.map(claudeTool), ...invokes];
    if (granted.length > 0) set("allowed-tools", granted.join(", "));
  } else if (src.kind === "agent") {
    // pi drops a skill's tool list, so only an agent's is emitted at all.
    if (effort) set("thinking", effort);
    const { builtins, ext } = piTools(tools);
    set("extensions", ext.length > 0 ? "[yamlet]" : "false");
    set("tools", [...builtins, ...ext].join(", "));
  }

  // The harness block is copied last, so it can override anything derived above.
  for (const entry of nested(get(harness))) {
    out.set(entry.key, directives(entry.text, harness));
  }

  const order = ORDER[harness === "claude" ? "claude" : `pi-${src.kind}`]!;
  const keys = [
    ...order.filter((k) => out.has(k)),
    ...[...out.keys()].filter((k) => !order.includes(k)),
  ];
  return keys.map((k) => out.get(k)!).join("\n");
}

// ── body directives ─────────────────────────────────────────────────────────

/** Apply every directive for one harness to a piece of source text. */
export function directives(text: string, harness: Harness): string {
  let out = text;

  // Blocks: a tag alone on its line takes the line with it.
  for (const h of ["claude", "pi"] as Harness[]) {
    const keep = h === harness;
    out = out.replace(
      new RegExp(
        `^\\{\\{#${h}\\}\\}\\n([\\s\\S]*?)^\\{\\{/${h}\\}\\}\\n`,
        "gm",
      ),
      (_, inner: string) => (keep ? inner : ""),
    );
    out = out.replace(
      new RegExp(`\\{\\{#${h}\\}\\}([\\s\\S]*?)\\{\\{/${h}\\}\\}`, "g"),
      (_, inner: string) => (keep ? inner : ""),
    );
  }

  out = out.replace(
    /\{\{(cmd|tool|ref|invoke)\s+([\s\S]*?)\}\}/g,
    (_, macro: string, arg: string) => {
      switch (macro) {
        case "cmd":
          return cmd(arg, harness);
        case "tool":
          return toolName(arg.trim(), harness);
        case "ref":
          return ref(arg.trim(), harness);
        default:
          return invoke(arg.trim(), harness);
      }
    },
  );

  // Alternation: one space hugging each delimiter belongs to the delimiter.
  out = out.replace(
    /\{\{ ?((?:(?!\}\})[\s\S])*?) ?\|\| ?((?:(?!\}\})[\s\S])*?) ?\}\}/g,
    (_, a: string, b: string) => (harness === "claude" ? a : b),
  );

  const stray = /\{\{[\s\S]{0,40}/.exec(out);
  if (stray) {
    throw new SourceError(
      `unrecognised directive: ${JSON.stringify(stray[0])}`,
    );
  }
  return out;
}

function toolName(sub: string, harness: Harness): string {
  if (!lookup(sub.split(/\s+/))) {
    throw new SourceError(`{{tool ${sub}}}: no such yamlet command`);
  }
  return harness === "claude"
    ? `yamlet ${sub}`
    : `yamlet_${sub.replace(/[ -]/g, "_")}`;
}

function ref(topic: string, harness: Harness): string {
  return harness === "claude"
    ? `references/${topic}.md`
    : `yamlet_guide({ topic: "${topic}" })`;
}

function invoke(arg: string, harness: Harness): string {
  return harness === "claude" ? `/${arg}` : `/skill:${arg}`;
}

// ── {{cmd ...}} ─────────────────────────────────────────────────────────────

/** Split CLI-ish text into words, keeping quoted strings whole and `[`/`]` apart. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /"(?:[^"\\]|\\.)*"|\[|\]|[^\s"[\]]+(?:"(?:[^"\\]|\\.)*")?/g;
  for (const m of line.matchAll(re)) out.push(m[0]);
  return out;
}

/** A value as it reads in the pi call: placeholders bare, literals quoted. */
function literal(word: string): string {
  if (word.startsWith('"')) return word;
  if (word === "..." || /^[A-Z][A-Z0-9_]*$/.test(word) || /^<.*>$/.test(word)) {
    return word;
  }
  return JSON.stringify(word);
}

/** `--flag=value` and `--flag value` both bind `value`. */
function render(arg: Arg, value: string | undefined): string {
  switch (arg.kind) {
    case "bool":
      return "true";
    case "value":
      return value ?? "true";
    default:
      return literal(value!);
  }
}

function cmd(source: string, harness: Harness): string {
  if (harness === "claude") return `yamlet ${source}`;

  // Each continuation line (`\` + newline) becomes one line of the object.
  const groups = source.split(/\s*\\\n\s*/).map(words);
  const all = groups.flat().filter((w) => w !== "[" && w !== "]");
  const found = lookup(all);
  if (!found) {
    throw new SourceError(`{{cmd ${source}}}: no such yamlet command`);
  }
  const { command } = found;
  let skip = found.rest;

  // Keep insertion order; remember which source line each parameter came from.
  const params = new Map<
    string,
    { values: string[]; arg: Arg; line: number }
  >();
  const add = (arg: Arg, value: string, line: number) => {
    const entry = params.get(arg.param) ?? { values: [], arg, line };
    entry.values.push(value);
    params.set(arg.param, entry);
  };

  let positional = 0;
  let last: Arg | undefined;
  groups.forEach((group, line) => {
    const ws = group.filter((w) => w !== "[" && w !== "]");
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i]!;
      if (skip > 0) {
        skip--;
        continue;
      }
      if (w === "..." && last) {
        add(last, "...", line);
        continue;
      }
      if (w.startsWith("--")) {
        const [flag, inline] = w.split(/=(.*)/s, 2) as [string, string?];
        const arg = command.flags[flag];
        if (!arg) {
          throw new SourceError(
            `{{cmd ${source}}}: ${found.name} has no flag ${flag}`,
          );
        }
        let value = inline;
        if (value === undefined && arg.kind !== "bool") {
          const next = ws[i + 1];
          if (
            arg.kind === "value" &&
            (next === undefined || next.startsWith("--"))
          ) {
            value = undefined;
          } else {
            value = next;
            i++;
          }
        }
        if (
          arg.kind === "list" && value !== undefined && !value.startsWith('"')
        ) {
          for (const part of value.split("|")) {
            add(arg, render(arg, part), line);
          }
        } else if (arg.kind === "pairs") {
          add(arg, pair(arg, value!), line);
        } else {
          add(arg, render(arg, value), line);
        }
        last = arg;
        continue;
      }
      const arg = command
        .positionals[Math.min(positional, command.positionals.length - 1)];
      if (
        !arg ||
        (positional >= command.positionals.length && arg.kind === "string")
      ) {
        throw new SourceError(
          `{{cmd ${source}}}: too many positionals for ${found.name}`,
        );
      }
      add(arg, arg.kind === "pairs" ? pair(arg, w) : render(arg, w), line);
      if (arg.kind === "string") positional++;
      last = arg;
    }
  });

  const field = (param: string, e: { values: string[]; arg: Arg }) => {
    const many = e.arg.kind === "list" || e.arg.kind === "pairs";
    const value = many ? `[${e.values.join(", ")}]` : e.values[0]!;
    return `${param}: ${value}`;
  };

  if (groups.length === 1) {
    const fields = [...params].map(([k, e]) => field(k, e));
    return fields.length === 0
      ? `${command.tool}()`
      : `${command.tool}({ ${fields.join(", ")} })`;
  }
  const lines: string[][] = groups.map(() => []);
  for (const [k, e] of params) lines[e.line]!.push(field(k, e));
  const body = lines.filter((l) => l.length > 0).map((l) =>
    "  " + l.join(", ")
  );
  return `${command.tool}({\n${body.join(",\n")}\n})`;
}

/** `K=V` → `{ k: K, v: V }`, each half a literal. */
function pair(arg: Arg, word: string): string {
  const unquoted = word.startsWith('"') ? word.slice(1, -1) : word;
  const at = unquoted.indexOf("=");
  if (at < 0) throw new SourceError(`expected K=V, got ${word}`);
  const [k, v] = arg.keys!;
  const half = (s: string) => literal(word.startsWith('"') ? `"${s}"` : s);
  return `{ ${k}: ${half(unquoted.slice(0, at))}, ${v}: ${
    half(unquoted.slice(at + 1))
  } }`;
}

// ── whole files ─────────────────────────────────────────────────────────────

export function banner(sourcePath: string, markdown: boolean): string {
  const text =
    `Generated from ${sourcePath} by scripts/build-skills.ts — edit the source, then rebuild.`;
  return markdown ? `<!-- ${text} -->` : `# ${text}`;
}

export function renderSkill(
  src: Source,
  sourcePath: string,
  harness: Harness,
): string {
  return [
    "---",
    banner(sourcePath, false),
    frontmatterFor(src, harness),
    "---",
    directives(src.body, harness),
  ].join("\n");
}

export function renderReference(
  text: string,
  sourcePath: string,
  harness: Harness,
): string {
  return `${banner(sourcePath, true)}\n${directives(text, harness)}`;
}
