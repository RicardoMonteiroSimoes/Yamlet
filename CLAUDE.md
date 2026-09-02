# CLAUDE.md

Yamlet: a spec-driven-development toolkit. Specs are `.yamlet.yaml` files — one
component per file, minimal, single source of truth for humans and agents, with
EARS acceptance criteria. Composites wire specs together.

Two separate products, one repo:

- **`yamlet` CLI** — one TypeScript codebase (`tooling/`) compiled to a
  self-contained binary by Deno. Shipped via Homebrew tap. The only
  implementation of the verifier and author. See [`tooling/CLAUDE.md`](tooling/CLAUDE.md).
- **Skills** — `plugins/yamlet-skills/` ships as a Claude Code marketplace
  plugin carrying *no binary*; skills call bare `yamlet` on PATH. `.claude/skills/*`
  are symlinks into the plugin — one source, don't edit both.

  A second harness port lives in `pi/` for the [pi coding agent](https://pi.dev).
  Unlike `.claude/skills/*`, its `.pi/` wiring is **not** tracked — run
  `./pi/install.sh --project` to generate it; `pi/` is the source of truth. It is a **separate port,
  deliberately not shared source** — pi has no `Skill` tool and no way for a
  subagent to ask the user a question, so the split between skills and subagents
  differs. Read [`pi/README.md`](pi/README.md) before touching it; keep
  behavioural changes in step across both builds.

  Unlike the Claude Code plugin, the pi port **does ship executable code**:
  `pi/extensions/yamlet/` registers one pi tool per `yamlet` subcommand and gates
  `write`/`edit` on `*.yamlet.yaml`. That is what makes "never hand-write the
  YAML" enforced on pi rather than merely instructed — pi has no permission layer
  and drops a skill's `allowed-tools`. It still ships **no binary**: the tools
  shell out to bare `yamlet` on PATH, same as the skills.

  One tool is not a subcommand: `yamlet_guide` serves the author skill's own
  `references/` procedures. Claude Code skills read bundled files relative to
  themselves; a pi skill cannot know its installed path, but the extension knows
  its own (`import.meta.url`), so on pi the router fetches a procedure through a
  tool instead of a relative read.

  The repo root carries a small **private** `package.json` — not cruft, don't
  delete it. Its only job is to point `pi install git:…` at `pi/extensions` and
  `pi/skills`; the same port ships to npm as `yamlet-pi` on each release. It has
  no dependencies and no scripts, and `tooling/` imports nothing bare, so the
  Deno build never consults it.

## Authority

- **`SPEC.md`** — authoritative definition of the format (every field, why).
- **The verifier** (`yamlet verify`) — mechanical source of truth for validity.
  README's format section is a quick reference only; don't treat it as normative.
- `RELEASING.md`, `tooling/README.md` — release flow and tooling internals.

When code and docs disagree, the verifier wins. Update the docs.

## Conventions

Boy-scout rule: leave touched code better.

**Skill budgets are checked, not judged.** A skill's `description` is always in
context in every session, and both harnesses cap it silently — pi warns past
1024 chars, Claude Code truncates `description` + `when_to_use` at 1536 with no
warning at all, mid-sentence. `scripts/lint-skills.ts` holds every skill in
`plugins/` and `pi/` to the tighter cap plus a body-length budget, and
`.github/workflows/skills-lint.yml` runs it on every PR. Run it before you
commit a skill change:

```sh
deno run --allow-read --allow-env scripts/lint-skills.ts
```

A description exists to decide *whether to load the skill*; the procedure
belongs in the body, and detail belongs in `references/`, which costs nothing
until it is read.
