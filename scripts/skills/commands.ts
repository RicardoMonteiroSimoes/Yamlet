/**
 * commands.ts — how a `yamlet` CLI invocation reads as a pi tool call.
 *
 * Skill sources write every command once, in CLI syntax (`{{cmd ...}}`). The
 * Claude Code build prints it as written; the pi build turns it into the call of
 * the matching tool in `pi/extensions/yamlet/index.ts`. This table is that
 * translation: per subcommand, the tool's name, what each positional binds to,
 * and what each flag binds to.
 *
 * It mirrors the extension, which builds argv from the same parameters in the
 * other direction. `build-skills.ts --check` holds the two together: every tool
 * and parameter named here must be registered there.
 */

/**
 * How one argument renders as a tool parameter.
 *
 * - `string` — `--flag VALUE` → `param: VALUE`.
 * - `bool`   — bare `--flag` → `param: true`.
 * - `value`  — `--flag VALUE`, a boolean/literal written as-is (`--met true|false`).
 * - `list`   — repeatable `--flag VALUE` → `param: [VALUE, ...]`.
 * - `pairs`  — repeatable `--flag K=V` → `param: [{ k: K, v: V }, ...]`.
 */
export type Kind = "string" | "bool" | "value" | "list" | "pairs";

export interface Arg {
  param: string;
  kind: Kind;
  /** For `pairs`: the object keys the two halves of `K=V` bind to. */
  keys?: [string, string];
}

export interface Command {
  tool: string;
  /** Positional arguments in order; a `list`/`pairs` positional is variadic and last. */
  positionals: Arg[];
  flags: Record<string, Arg>;
}

const s = (param: string): Arg => ({ param, kind: "string" });
const b = (param: string): Arg => ({ param, kind: "bool" });
const v = (param: string): Arg => ({ param, kind: "value" });
const l = (param: string): Arg => ({ param, kind: "list" });
const p = (param: string, keys: [string, string]): Arg => ({
  param,
  kind: "pairs",
  keys,
});

const FORMAT = { "--format": s("format") };
const DATE = { "--date": s("date") };
const EVIDENCE = { "--evidence": l("evidence"), "--note": s("note") };

/** `adr <sub> FILE TEXT` — add-force / add-obligation / add-accept / add-revisit. */
const textTool = (tool: string): Command => ({
  tool,
  positionals: [s("file"), s("text")],
  flags: {},
});

export const COMMANDS: Record<string, Command> = {
  "systems": {
    tool: "yamlet_systems",
    positionals: [s("dir")],
    flags: {
      "--system": s("system"),
      "--details": b("details"),
      "--contracts": b("contracts"),
      "--state": b("state"),
      "--criteria": b("criteria"),
      ...FORMAT,
    },
  },
  "impact": {
    tool: "yamlet_impact",
    positionals: [s("file"), s("dir")],
    flags: { ...FORMAT },
  },
  "verify": {
    tool: "yamlet_verify",
    positionals: [s("file")],
    flags: { "--list-rules": b("list_rules"), ...FORMAT },
  },
  "graph": {
    tool: "yamlet_graph",
    positionals: [s("target")],
    flags: {
      "--out": s("out"),
      "--format": s("format"),
      "--libs": s("libs"),
      "--recursive": b("recursive"),
    },
  },
  "trace": {
    tool: "yamlet_trace",
    positionals: [s("dir")],
    flags: {
      "--out": s("out"),
      "--format": s("format"),
      "--libs": s("libs"),
      "--techspec": l("techspec"),
    },
  },
  "tests": {
    tool: "yamlet_tests",
    positionals: [s("src"), s("target")],
    flags: {},
  },
  "docs": {
    tool: "yamlet_docs",
    positionals: [s("src"), s("target")],
    flags: { "--adrs": l("adrs"), "--check": b("check") },
  },
  "init": {
    tool: "yamlet_init",
    positionals: [s("file")],
    flags: {
      "--system": s("system"),
      "--topic": s("topic"),
      "--summary": s("summary"),
      "--description": s("description"),
      "--blast-radius": s("blast_radius"),
      "--front": s("front"),
      "--expose-name": s("expose_name"),
      "--expose-intent": s("expose_intent"),
      "--input": l("inputs"),
      "--output": l("outputs"),
    },
  },
  "add-component": {
    tool: "yamlet_add_component",
    positionals: [s("file"), s("alias"), s("path")],
    flags: {},
  },
  "add-connection": {
    tool: "yamlet_add_connection",
    positionals: [s("file"), s("group"), p("wires", ["socket", "source"])],
    flags: {},
  },
  "add-requirement": {
    tool: "yamlet_add_requirement",
    positionals: [s("file")],
    flags: { "--description": s("description") },
  },
  "add-criterion": {
    tool: "yamlet_add_criterion",
    positionals: [s("file")],
    flags: {
      "--rq": s("rq"),
      "--after": s("after"),
      "--pattern": s("pattern"),
      "--when": s("when"),
      "--if": s("if"),
      "--while": l("while"),
      "--where": s("where"),
      "--shall": l("shall"),
      "--example": l("examples"),
      "--reads": l("reads"),
      "--writes": l("writes"),
    },
  },
  "add-state": {
    tool: "yamlet_add_state",
    positionals: [s("file")],
    flags: { "--ac": s("ac"), "--reads": l("reads"), "--writes": l("writes") },
  },
  "add-adr": {
    tool: "yamlet_add_adr",
    positionals: [s("file"), s("adr")],
    flags: { "--rq": s("rq"), "--ac": s("ac") },
  },
  "techspec init": {
    tool: "yamlet_techspec_init",
    positionals: [l("specs")],
    flags: { "--scope": l("scope"), "--out": s("out") },
  },
  "techspec analysis": {
    tool: "yamlet_techspec_analysis",
    positionals: [s("file")],
    flags: {
      "--commit": s("commit"),
      "--deep": l("deep"),
      "--skimmed": l("skimmed"),
    },
  },
  "techspec criterion": {
    tool: "yamlet_techspec_criterion",
    positionals: [s("file")],
    flags: { "--ac": s("ac"), "--met": v("met"), ...EVIDENCE },
  },
  "techspec obligation": {
    tool: "yamlet_techspec_obligation",
    positionals: [s("file")],
    flags: { "--of": s("of"), "--met": v("met"), ...EVIDENCE },
  },
  "techspec task": {
    tool: "yamlet_techspec_task",
    positionals: [s("file")],
    flags: {
      "--title": s("title"),
      "--covers": l("covers"),
      "--depends-on": l("depends_on"),
      "--why": s("why"),
    },
  },
  "adr init": {
    tool: "yamlet_adr_init",
    positionals: [s("dir")],
    flags: {
      "--title": s("title"),
      "--kind": s("kind"),
      "--question": s("question"),
      "--arises-from": l("arises_from"),
      "--assumes": l("assumes"),
      ...DATE,
    },
  },
  "adr add-force": textTool("yamlet_adr_add_force"),
  "adr add-obligation": textTool("yamlet_adr_add_obligation"),
  "adr add-accept": textTool("yamlet_adr_add_accept"),
  "adr add-revisit": textTool("yamlet_adr_add_revisit"),
  "adr add-basis": {
    tool: "yamlet_adr_add_basis",
    positionals: [s("file")],
    flags: { "--quantity": s("quantity"), "--source": s("source") },
  },
  "adr add-dimension": {
    tool: "yamlet_adr_add_dimension",
    positionals: [s("file")],
    flags: {
      "--matters": s("matters"),
      "--unit": s("unit"),
      "--source": s("source"),
      "--basis": l("basis"),
      "--against": p("against", ["option", "text"]),
    },
  },
  "adr add-option": {
    tool: "yamlet_adr_add_option",
    positionals: [s("file")],
    flags: {
      "--summary": s("summary"),
      "--reversibility": s("reversibility"),
      "--ref": p("refs", ["label", "locator"]),
      "--against": p("against", ["dimension", "text"]),
    },
  },
  "adr decide": {
    tool: "yamlet_adr_decide",
    positionals: [s("file"), s("option")],
    flags: {},
  },
  "adr remove": {
    tool: "yamlet_adr_remove",
    positionals: [s("file"), s("id")],
    flags: {},
  },
  "adr replace": {
    tool: "yamlet_adr_replace",
    positionals: [s("file"), s("id"), s("text")],
    flags: {
      "--quantity": s("quantity"),
      "--matters": s("matters"),
      "--unit": s("unit"),
      "--source": s("source"),
      "--basis": l("basis"),
      "--summary": s("summary"),
      "--reversibility": s("reversibility"),
      "--ref": p("refs", ["label", "locator"]),
      "--against": p("against", ["key", "text"]),
    },
  },
  "adr accept": {
    tool: "yamlet_adr_accept",
    positionals: [s("file")],
    flags: { ...DATE },
  },
  "adr reject": {
    tool: "yamlet_adr_reject",
    positionals: [s("file")],
    flags: { "--reason": s("reason"), ...DATE },
  },
  "adr supersede": {
    tool: "yamlet_adr_supersede",
    positionals: [s("file")],
    flags: { "--by": s("by"), ...DATE },
  },
};

/** The command a source names: the longest subcommand prefix of its words. */
export function lookup(
  words: string[],
): { name: string; command: Command; rest: number } | undefined {
  for (const n of [2, 1]) {
    const name = words.slice(0, n).join(" ");
    const command = COMMANDS[name];
    if (command) return { name, command, rest: n };
  }
  return undefined;
}
