# skills/ — the one source of every skill and agent

Each unit here renders to both harness builds. The outputs are **generated and
committed** — they are what the Claude Code marketplace and `pi install git:…`
read, and what review sees — so never edit them; each carries a banner naming
its source.

| source | `kind` | Claude Code | pi |
| --- | --- | --- | --- |
| `<name>/SKILL.md` | `skill` | `plugins/yamlet-skills/skills/<name>/SKILL.md` | `pi/skills/<name>/SKILL.md` |
| `<name>/SKILL.md` | `agent` | `plugins/yamlet-skills/skills/<name>/SKILL.md` (`context: fork`) | `pi/agents/<name>.md` |
| `<name>/references/*.md` | — | `…/<name>/references/` | `pi/skills/<name>/references/` |

```sh
deno run --allow-read --allow-write scripts/build-skills.ts          # regenerate
deno run --allow-read scripts/build-skills.ts --check                # what CI runs
deno test --allow-read scripts/skills/                               # the renderer
```

Every Markdown file under those output directories must be generated: one
without the banner fails the build, and one whose source is gone is deleted on the
next rebuild. The build also keeps `.claude/skills/<name>` — tracked symlinks into
the Claude Code build, so this repo's own sessions have every skill without a
build step — one per unit. (`.pi/` stays untracked; `./pi/install.sh --project`
links it.)

The build also holds `pi/extensions/yamlet/index.ts` to what it generates:
`GUIDE_FILES` must serve every reference (topic = file name) and every agent's
`guide:` from the path it is generated at, `AGENT_FILES` must list every agent,
and every `{{ref TOPIC}}` must name a served topic.

## Frontmatter

```yaml
name: yamlet-contract-challenger
kind: agent                    # skill (default) | agent
description: >-                # shared; directives below work here too
  …
guide: contract-challenge      # agent: the yamlet_guide topic pi serves it under
effort: low                    # Claude `effort`, pi `thinking`
tools: [yamlet:systems, read]  # see below
invokes: [yamlet-verifier]     # skills it calls: Claude `Skill(…)` grants
claude:                        # copied verbatim into the Claude Code build
  argument-hint: <…>
  model: sonnet
pi:                            # copied verbatim into the pi build
  display_name: Yamlet Contract Challenger
  color: orange
  max_turns: 8
```

`tools` is one vocabulary for both harnesses:

| tool | Claude Code | pi agent |
| --- | --- | --- |
| `read` / `grep` | `Read` / `Grep` | `read` / `grep` |
| `glob` | `Glob` | `find, ls` |
| `yamlet` | `Bash(yamlet:*)` | — |
| `yamlet:SUB` | `Bash(yamlet SUB:*)` | `ext:yamlet/yamlet_SUB` (and `extensions: [yamlet]`) |
| `git:SUB` | `Bash(git SUB:*)` | — (an agent has no bash) |

pi drops a skill's tool list, so a pi **skill** gets none; only agents do. Agents
get `context: fork` / `background: false` on Claude Code, and `skills: false`,
`prompt_mode: replace`, `inherit_context: false`, `run_in_background: false` on pi.
Anything under `claude:` / `pi:` overrides a derived field.

## Body directives

Plain Markdown, plus a deliberately small set — the raw file should still read as
the skill it is:

| directive | Claude Code | pi |
| --- | --- | --- |
| `{{#claude}}…{{/claude}}` | kept | dropped |
| `{{#pi}}…{{/pi}}` | dropped | kept |
| `{{ A \|\| B }}` | `A` | `B` |
| `{{cmd systems DIR --system=S --criteria}}` | `yamlet systems DIR --system=S --criteria` | `yamlet_systems({ dir: DIR, system: S, criteria: true })` |
| `{{tool techspec init}}` | `yamlet techspec init` | `yamlet_techspec_init` |
| `{{flag --depends-on}}` | `--depends-on` | `depends_on` |
| `{{ref creating}}` | `references/creating.md` | `yamlet_guide({ topic: "creating" })` |
| `{{invoke yamlet-verifier ARGS}}` | `/yamlet-verifier ARGS` | `/skill:yamlet-verifier ARGS` |

A block tag alone on its line takes the line with it. Macros resolve first, so one
may sit inside a block or an alternation; blocks and alternations do not nest.

`{{cmd …}}` is written in CLI syntax, and `scripts/skills/commands.ts` maps it to
the pi tool: subcommand → tool, positional/flag → parameter. In the pi call a bare
`UPPER_CASE` word or `<…>` stays a placeholder and anything else is quoted;
repeatable flags collect into a list, `...` and `a|b` carry into it, `K=V` pairs
become objects, `[…]` optional groups drop their brackets, and a `\`-continued
line becomes one line of the object. An unknown command or flag is an error. The
build also fails if the table names a tool or parameter the extension does not
register, so the two cannot drift apart.

Reach for `{{cmd}}` when the two builds say the same thing in two syntaxes, and
for a conditional when they genuinely say different things — a harness
capability one side lacks.
