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

  A second harness port lives in `pi/` for the [pi coding agent](https://pi.dev),
  with `.pi/{agents,skills}/*` symlinked into it the same way `.claude/skills/*`
  is — one source, don't edit both. It is a
  **separate port, deliberately not shared source** — pi has no permission layer,
  no `Skill` tool, and no way for a subagent to ask the user a question, so the
  split between skills and subagents differs. Read [`pi/README.md`](pi/README.md)
  before touching it; keep behavioural changes in step across both builds.

## Authority

- **`SPEC.md`** — authoritative definition of the format (every field, why).
- **The verifier** (`yamlet verify`) — mechanical source of truth for validity.
  README's format section is a quick reference only; don't treat it as normative.
- `RELEASING.md`, `tooling/README.md` — release flow and tooling internals.

When code and docs disagree, the verifier wins. Update the docs.

## Conventions

Boy-scout rule: leave touched code better.
