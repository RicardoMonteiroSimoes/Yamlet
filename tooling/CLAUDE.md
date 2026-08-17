# CLAUDE.md — `tooling/`

The `yamlet` CLI: one TypeScript codebase compiled to a self-contained binary by Deno. The only
implementation of the verifier and author. Repo-wide context is in the root
[`CLAUDE.md`](../CLAUDE.md); format/validity authority in [`SPEC.md`](../SPEC.md) and the verifier.

## Toolchain

Deno pinned via `mise` (repo-root `mise.toml`, `deno = 2.9.2`). Nothing else.

```sh
mise install                      # once
mise exec -- deno task test       # suite
mise exec -- deno task check      # typecheck
mise exec -- deno task compile    # -> dist/yamlet (host target)
deno fmt && deno lint             # before committing
```

`mise.toml` puts `tooling/bin/yamlet` (source launcher) on PATH inside this repo, so bare `yamlet`
runs current source here. A shell started before mise added the entry won't see it — restart it.
`command -v yamlet` should resolve to `tooling/bin`.

## Architecture

`main.ts` — command registry + dispatch (owns `verify`). Commands are a data-driven registry: each
module exports a `Command` descriptor (`{name, summary, help, run}`); dispatch and `yamlet help`
read the one list, so they can't drift. Add a command = write `run`, export descriptor, add to
array.

```
src/flatten.ts    Phase 1: constrained-YAML -> tab-free records; short-circuits on parse error
src/composite.ts  cross-file member/socket tables (directional: inputs vs outputs)
src/validate.ts   Phase 2: structural + semantic rules over records
src/catalog.ts    the rule catalog (source of truth for rule ids/severities)
src/render.ts     byte-exact human/JSON output
src/verify.ts     orchestration: extension -> flatten -> composite -> validate
src/author.ts     correct-by-construction appender; runs verifier as commit gate
src/blocks.ts     address an existing RQ-N/AC-N by id + its line extent (starts from records, ends from the next start)
src/systems.ts    `yamlet systems` (read-only)
src/impact.ts     `yamlet impact` — reverse dependency index: which composites consume a spec (read-only)
src/graph.ts      `yamlet graph` -> DOT | JSON model | HTML viewer (read-only)
src/tests.ts      `yamlet tests` -> project criteria into Gherkin .feature files + binding manifest.json (wipes + rebuilds TARGET)
src/viewer/       the HTML viewer (template + css + js + assembler); elk vendored
```

**Author owns all serialization** — indentation, quoting, pattern→clause mapping, ID allocation. IDs
are tool-generated and echoed on stdout, never an input. After every mutation the in-process
verifier runs as a commit gate; anything beyond the expected work-in-progress findings rolls the
file back and exits `3`.

**Exit codes:** `0` ok · `1` verify errors · `2` usage/validation (nothing written) · `3` mutation
rolled back.

## Tests are frozen oracles

- `tests/oracle/*.json` — `verify --format=json` output per fixture; `parity_test.ts` replays.
  Re-freeze after an intentional rule change:
  `deno run --allow-read --allow-write tests/gen-oracle.ts`.
- `tests/oracle-author/*.yamlet.yaml` — exact author output bytes; `author_parity_test.ts` replays.
  Re-freeze: `gen-author-oracle.ts`.
- `tests/oracle-gherkin/**/*.feature` + `manifest.json` — exact `yamlet tests` feature tree and
  binding manifest for `specs_example/`; `gherkin_test.ts` replays. Re-freeze:
  `gen-gherkin-oracle.ts`.

Oracle dirs are captured data — excluded from fmt/lint. A moved oracle without an intentional rule
change is a regression, not a re-freeze.

## Conventions

- Deno fmt: 2-space, 100 col, semicolons, double quotes. `strict` + `noUncheckedIndexedAccess`.
- `edit` / `rm` are **not implemented yet**, and must not be stubbed. Two pieces of the groundwork
  do exist: `src/blocks.ts` addresses an existing `RQ-N`/`AC-N` and its line extent, and
  `yamlet impact` supplies the reverse-dependency analysis safe removal needs. What is still missing
  is the mutation itself — and the commit gate that would police it. `guardCheck`'s allowlist is not
  a general safety property; it is the _append_ commands' predicted findings, written as a constant.
  A command that rewrites or deletes an existing block needs the stricter rule ("the resulting
  findings must be a subset of the pre-existing ones plus the ones this command predicts"), keyed on
  `(rule, message, owning RQ/AC)` rather than on path, since indices shift under insert and remove.
  Build that first.
- **IDs are permanent.** Never renumber and never reuse one: `yamlet tests` keys its manifest on
  `AC-N`, so a renumber silently re-points step definitions — the one failure mode with no loud
  symptom. Deletion leaves a gap, and the gap is correct. Ordered insertion uses the letter suffix
  `E203` already allows (`AC-3` → `AC-3a`).
