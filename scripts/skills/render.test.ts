// The same pinned assertion module tooling/tests uses; there is no root deno.json to map it.
// deno-lint-ignore no-import-prefix
import { assertEquals, assertThrows as throws } from "jsr:@std/assert@1";
import { directives, parse, renderSkill, SourceError } from "./render.ts";

const both = (text: string) => [
  directives(text, "claude"),
  directives(text, "pi"),
];

Deno.test("alternation picks a side; one hugging space belongs to the delimiter", () => {
  assertEquals(both("a {{ `X` || Y }} b"), ["a `X` b", "a Y b"]);
  assertEquals(both("a{{ || only pi}}b"), ["ab", "aonly pib"]);
});

Deno.test("a block tag alone on its line takes the line with it", () => {
  const text = "1\n{{#claude}}\nC\n{{/claude}}\n{{#pi}}\nP\n{{/pi}}\n2\n";
  assertEquals(both(text), ["1\nC\n2\n", "1\nP\n2\n"]);
  assertEquals(both("x {{#pi}}p{{/pi}}y"), ["x y", "x py"]);
});

Deno.test("tool, ref and invoke", () => {
  assertEquals(both("{{tool techspec init}}"), [
    "yamlet techspec init",
    "yamlet_techspec_init",
  ]);
  assertEquals(both("{{tool add-criterion}}"), [
    "yamlet add-criterion",
    "yamlet_add_criterion",
  ]);
  assertEquals(both("{{flag --depends-on}}"), ["--depends-on", "depends_on"]);
  assertEquals(both("{{ref creating}}"), [
    "references/creating.md",
    'yamlet_guide({ topic: "creating" })',
  ]);
  assertEquals(both("{{invoke yamlet-verifier SPEC}}"), [
    "/yamlet-verifier SPEC",
    "/skill:yamlet-verifier SPEC",
  ]);
});

Deno.test("cmd: placeholders stay bare, literals are quoted, flags map to params", () => {
  assertEquals(both("{{cmd systems DIR --system=S --criteria}}"), [
    "yamlet systems DIR --system=S --criteria",
    "yamlet_systems({ dir: DIR, system: S, criteria: true })",
  ]);
  assertEquals(
    directives("{{cmd systems specs --system e-mail}}", "pi"),
    [
      'yamlet_systems({ dir: "specs", system: "e-mail" })',
    ][0],
  );
  assertEquals(
    directives("{{cmd verify <path/to/spec.yamlet.yaml>}}", "pi"),
    "yamlet_verify({ file: <path/to/spec.yamlet.yaml> })",
  );
});

Deno.test("cmd: repeatable flags collect into lists; `...` and `|` carry through", () => {
  assertEquals(
    directives(
      '{{cmd techspec criterion TS --ac SPEC#AC-N --met true|false [--evidence PATH:LINE ...] [--note "..."]}}',
      "pi",
    ),
    'yamlet_techspec_criterion({ file: TS, ac: "SPEC#AC-N", met: true|false, evidence: ["PATH:LINE", ...], note: "..." })',
  );
  assertEquals(
    directives(
      "{{cmd techspec task TS --covers SPEC#AC-N|ADR-nnnn#R-n}}",
      "pi",
    ),
    'yamlet_techspec_task({ file: TS, covers: ["SPEC#AC-N", "ADR-nnnn#R-n"] })',
  );
  assertEquals(
    directives("{{cmd techspec init SPEC SPEC2 --scope SPEC#AC-1}}", "pi"),
    'yamlet_techspec_init({ specs: [SPEC, SPEC2], scope: ["SPEC#AC-1"] })',
  );
});

Deno.test("cmd: K=V pairs become objects", () => {
  assertEquals(
    directives(
      "{{cmd add-connection F mailer recipient=input.to body=input.text}}",
      "pi",
    ),
    'yamlet_add_connection({ file: F, group: "mailer", wires: [{ socket: "recipient", source: "input.to" }, { socket: "body", source: "input.text" }] })',
  );
  assertEquals(
    directives(
      '{{cmd adr add-option F --summary "S3" --against "D-1=cheap"}}',
      "pi",
    ),
    'yamlet_adr_add_option({ file: F, summary: "S3", against: [{ dimension: "D-1", text: "cheap" }] })',
  );
});

Deno.test("cmd: continuation lines become object lines; Claude keeps the source", () => {
  const text =
    '{{cmd add-criterion F --rq RQ-1 --pattern unwanted \\\n  --if "x" \\\n  --shall "y"}}';
  const [claude, pi] = both(text);
  assertEquals(
    claude,
    'yamlet add-criterion F --rq RQ-1 --pattern unwanted \\\n  --if "x" \\\n  --shall "y"',
  );
  assertEquals(
    pi,
    'yamlet_add_criterion({\n  file: F, rq: "RQ-1", pattern: "unwanted",\n  if: "x",\n  shall: ["y"]\n})',
  );
});

Deno.test("cmd: over several lines, several pairs go one per line", () => {
  assertEquals(
    directives("{{cmd add-connection F up \\\n  a=input.a b=input.b}}", "pi"),
    'yamlet_add_connection({\n  file: F, group: "up",\n  wires: [\n    { socket: "a", source: "input.a" },\n    { socket: "b", source: "input.b" }\n  ]\n})',
  );
});

Deno.test("cmd: unknown commands and flags are errors, not guesses", () => {
  throws(() => directives("{{cmd frobnicate}}", "pi"), SourceError);
  throws(() => directives("{{cmd systems --nope}}", "pi"), SourceError);
  throws(() => directives("{{tool frobnicate}}", "pi"), SourceError);
  throws(() => directives("{{whatever}}", "pi"), SourceError);
});

Deno.test("frontmatter: tools, effort and agent defaults derive per harness", () => {
  const src = parse(
    "skills/x/SKILL.md",
    [
      "---",
      "name: x",
      "kind: agent",
      "description: >-",
      "  Does {{ `yamlet init` || `yamlet_init` }}.",
      "effort: low",
      "tools: [yamlet:systems, read, glob]",
      "claude:",
      "  model: sonnet",
      "pi:",
      "  display_name: X",
      "  max_turns: 8",
      "---",
      "body",
      "",
    ].join("\n"),
  );
  assertEquals(
    renderSkill(src, "skills/x/SKILL.md", "claude"),
    [
      "---",
      "# Generated from skills/x/SKILL.md by scripts/build-skills.ts — edit the source, then rebuild.",
      "name: x",
      "description: >-",
      "  Does `yamlet init`.",
      "context: fork",
      "background: false",
      "model: sonnet",
      "effort: low",
      "allowed-tools: Bash(yamlet systems:*), Read, Glob",
      "---",
      "body",
      "",
    ].join("\n"),
  );
  assertEquals(
    renderSkill(src, "skills/x/SKILL.md", "pi"),
    [
      "---",
      "# Generated from skills/x/SKILL.md by scripts/build-skills.ts — edit the source, then rebuild.",
      "description: >-",
      "  Does `yamlet_init`.",
      "display_name: X",
      "thinking: low",
      "extensions: [yamlet]",
      "skills: false",
      "tools: read, find, ls, ext:yamlet/yamlet_systems",
      "prompt_mode: replace",
      "inherit_context: false",
      "run_in_background: false",
      "max_turns: 8",
      "---",
      "body",
      "",
    ].join("\n"),
  );
});

Deno.test("frontmatter: a skill's invokes become Skill grants; pi gets no tool list", () => {
  const src = parse(
    "skills/y/SKILL.md",
    "---\nname: y\ndescription: d\ntools: [yamlet, read]\ninvokes: [yamlet-verifier]\nclaude:\n  argument-hint: <a>\n---\nb\n",
  );
  assertEquals(
    renderSkill(src, "skills/y/SKILL.md", "claude").split("\n").slice(2, 6),
    [
      "name: y",
      "description: d",
      "argument-hint: <a>",
      "allowed-tools: Bash(yamlet:*), Read, Skill(yamlet-verifier *), Skill(yamlet-skills:yamlet-verifier *)",
    ],
  );
  assertEquals(
    renderSkill(src, "skills/y/SKILL.md", "pi").split("\n").slice(2, 5),
    ["name: y", "description: d", "---"],
  );
});

Deno.test("frontmatter: an unknown top-level key must go under a harness", () => {
  throws(
    () => parse("s", "---\nname: z\ndescription: d\nmodel: opus\n---\n"),
    SourceError,
  );
});
