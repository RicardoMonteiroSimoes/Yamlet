# yamlet (binary)

A single self-contained `yamlet` binary — one TypeScript codebase compiled by Deno — that is the
**only** implementation of the yamlet verifier and author. It replaced the original POSIX-shell
tools (`verify.sh` + `author.sh`), which have been retired. Planned next: `edit`, `rm`.

## Toolchain

Deno is pinned via [`mise`](https://mise.jdx.dev) in the repo-root `mise.toml` (`deno = "2.9.2"`).
Nothing else is required.

```sh
mise install            # once, installs the pinned Deno
mise exec -- deno task test      # run the suite
mise exec -- deno task compile   # -> dist/yamlet (self-contained, ~65 MB, host target)
```

`dist/yamlet` runs with no Deno on the PATH. It is compiled with `--allow-read --allow-write` (the
author subcommands mutate spec files).

`deno task compile` builds one binary for the host. A **release** builds all four shipped targets
(macOS + Linux, Intel + arm64) and packages them — that is
[`scripts/build-release.sh`](./scripts/build-release.sh), driven by the one-click
[`.github/workflows/release.yml`](../.github/workflows/release.yml). See
[`RELEASING.md`](../RELEASING.md) for the full flow. The version reported by `yamlet --version`
comes from [`src/version.ts`](./src/version.ts) — `0.0.0-dev` in the tree, stamped to the real tag
by the release build.

### The `yamlet` command and the skills

The tool and the skills are **separate products**. `yamlet` is a standalone CLI (installed via a
Homebrew tap, usable without Claude). The `yamlet-author` / `yamlet-verifier` skills ship as a thin
Claude Code marketplace plugin that carries **no binary** — they invoke a bare `yamlet` on PATH
(`allowed-tools: Bash(yamlet:*)`) and depend on it being installed separately.

Because the skills call bare `yamlet`, dev needs `yamlet` on PATH too — but **only inside this
repo**, pointing at the current source. That is done with mise, no global install: `mise.toml` adds
`tooling/bin` to PATH via `[env] _.path`, and [`tooling/bin/yamlet`](./bin/yamlet) is a launcher
that runs the CLI **from source** via the mise-pinned Deno (always current, no build step). So in
this repo `yamlet` is the source build; anywhere else it's whatever is installed (the Homebrew tap).

mise computes this PATH entry when a shell initializes in the repo, so a shell (or Claude Code
session) started **before** the entry was added won't see it — restart it, then `command -v yamlet`
should resolve to `tooling/bin/yamlet`.

`dist/yamlet` (from `deno task compile`) is the same kind of self-contained artifact the Homebrew
tap ships (the release build just produces one per target); it is not used by the skills.

## Command surface

```
yamlet help [command]                              -> top-level help, or one command's synopsis
yamlet <command> --help | -h                       -> the same per-command synopsis
yamlet version | --version | -V                    -> print the yamlet version
yamlet verify [--format=human|json] <file.yamlet.yaml>
yamlet verify --list-rules [--format=human|json]
yamlet systems [DIR] [--system=SLUG] [--contracts] [--format=human|json]
                                                   -> existing systems grouped by their scope files; --contracts adds each
                                                      scope's exposed contract on labelled `in:`/`out:` lines (what you can
                                                      wire as a member), --system=SLUG narrows to one service
yamlet graph FILE|DIR [--format=dot|json|html] [--libs=embed|cdn] [--recursive]
                                                   -> Graphviz DOT of one spec (pipe to `dot -Tsvg`), the JSON graph
                                                      model, or a self-contained interactive HTML viewer of that model;
                                                      a DIR or --recursive imply a model format and expand the whole tree
yamlet init FILE --system s --topic t --summary s --description d \
                 --blast-radius low|medium|high --front internal|external \
                 [--expose-name n --expose-intent i --input NAME... --output NAME...]
yamlet add-component   FILE ALIAS PATH             -> declare a composite member; echoes its contract
yamlet add-connection  FILE GROUP SOCKET=SOURCE [SOCKET=SOURCE ...]
                                                   -> wire a member's inputs (or the 'output' group) in one atomic
                                                      call; SOURCE is input.X or alias.OUT; direction is enforced
yamlet add-requirement FILE --description "..."                    -> prints RQ-N
yamlet add-criterion   FILE --rq RQ-N --pattern P \
                 [--when ...|--if ...|--while ... (repeatable)|--where ...] \
                 --shall "..." [--shall ...] [--example "k=v;k=v" ...]  -> prints AC-N
```

Exit codes: `0` success · `1` verify found errors · `2` usage/validation error (nothing written) ·
`3` a mutation produced an unexpected finding and was rolled back by the commit gate.

The binary exposes primitives; the `yamlet-author` skill orchestrates them (interview → `init` →
`add-*`). IDs are generated by the tool and echoed on stdout — never an input.

**Not yet implemented (deferred):** `edit`, `rm`. Removing an `exposes.output`, for instance, must
first check whether anything depends on it — that dependency analysis is out of scope for the parity
milestone.

### The graph model (`yamlet graph --format=json`)

`--format=dot` is for `dot -Tsvg`; `--format=json` is the **renderer-agnostic contract** for anyone
building their own view — an interactive viewer, a different layout engine, a docs generator. It
emits a stable `yamlet.graph/v1` document built from the same pipeline the verifier uses, so it can
never disagree with `yamlet verify` about which wires exist. A custom renderer reads this instead of
re-parsing yamlet.

The model is **self-similar**: a composite carries a `graph` body `{boundary, members, wires}`, and
a member that is _itself_ a composite carries the same body under its own `graph` (populated under
`--recursive`). So one recursive walk handles any depth — one root spec expands into the whole app.

```jsonc
{
  "format": "yamlet.graph/v1",
  "kind": "composite", // "leaf" | "composite" | "forest"
  "spec": { // the graphed component's own header + contract
    "system": "pdf-archiver",
    "topic": "…",
    "name": "…",
    "intent": "…",
    "front": "internal",
    "blastRadius": "medium",
    "file": "specs_example/pdf_archiver.yamlet.yaml",
    "inputs": ["file", "…"],
    "outputs": [],
    "requirements": 1
  },
  "graph": { // present iff kind === "composite"
    "boundary": { "in": "__boundary_in", "out": "__boundary_out" },
    "members": [ // sorted by alias
      {
        "alias": "uploads",
        "status": "ok", // ok | missing | noexposes
        "kind": "leaf", // "leaf" | "composite"
        "system": "pdf-upload",
        "topic": "…",
        "name": "…",
        "intent": "…",
        "front": "external",
        "blastRadius": "medium",
        "file": "specs_example/pdf_upload.yamlet.yaml", // resolved source path — link/open it
        "inputs": ["file", "filename"],
        "outputs": ["pdf_file"],
        "requirements": 2
        // when kind === "composite" and --recursive: "graph": { … } (same body, nested)
        // or "truncated": true if expanding it would re-enter a cycle
      }
    ],
    "wires": [ // directed source → sink
      {
        "kind": "assembly", // assembly (member→member) | delegation (boundary↔member)
        "from": { "node": "uploads", "dir": "out", "socket": "pdf_file" },
        "to": { "node": "mailer", "dir": "in", "socket": "attachment" }
      }
    ]
  }
}
```

A wire endpoint's stable **port id** is `` `${dir}__${socket}` `` on `node`. A member `node` is its
`alias`; the two reserved `boundary` ids denote the _enclosing_ composite's own contract, whose
sockets are `spec.inputs`/`spec.outputs` at the root or `member.inputs`/`member.outputs` when
nested. A `leaf` carries only `spec` (no `graph`). Per-member `front`/`blastRadius` let a renderer
flag trust boundaries — e.g. an `external` member feeding an `internal` composite.

**A whole directory at once.** Point `graph` at a directory (or omit the path, defaulting to `.`)
and it emits a `forest`: every **root** spec — one no other spec includes as a member — expanded
deeply, so a project's entire composition is one document. Files that can't be graphed (a parse
error mid-edit) are surfaced under `skipped`, never silently dropped.

```jsonc
{
  "format": "yamlet.graph/v1",
  "kind": "forest",
  "root": "specs_example",
  "roots": [/* a leaf|composite GraphModel per root, each fully expanded */],
  "skipped": [{ "file": "…/wip.yamlet.yaml", "reason": "parse error (run `yamlet verify`)" }]
}
```

This assumes a project's `.yamlet.yaml` specs **live together under one directory** (the same
convention `yamlet systems` scans) — that is what lets a single `yamlet graph specs/` render the
whole application from its roots down.

### The HTML viewer (`yamlet graph --format=html`)

`--format=html` wraps the very same `yamlet.graph/v1` model in a **single self-contained page**: an
editorial service map, a live SVG composition (laid out by [elkjs](https://github.com/kieler/elkjs)
in the browser, with pan/zoom), and a completeness ledger — all derived from the model, so it can
never disagree with `yamlet verify`. Like `json`, it is a model format: a directory yields the whole
forest — a service switcher jumps to any system (leaf or composite) as the entry point — and
`--recursive` expands deeply.

The composition navigates **by system**, one level at a time. A level shows *every* scope that
shares a `system:` slug — the one actually wired here (marked) plus its sibling variants — so drilling
into, say, an archiver surfaces all of that system's scopes side by side, not just the wired one.
Click a member card to descend into its system; use the breadcrumb to climb back. A terminal leaf
opens its contract in a drawer. Pass `--recursive`: without it, composite scopes reached only through
wiring aren't expanded, so they render as opaque single cards instead of their internals.

The viewer's own CSS/JS are always inlined; only the layout engine is delivered two ways:

- **`--libs=embed`** (default) inlines elkjs — one offline file, ~1.6 MB, no network. Use this for
  anything that must work offline or inside a strict-CSP sandbox (e.g. a hosted artifact, which
  blocks every external origin — the embedded build is the only one that renders there).
- **`--libs=cdn`** references a **version-pinned, SRI-guarded** elkjs from jsDelivr — a ~45 KB page
  that fetches the ~1.6 MB engine at load time. Smaller to store/serve, but needs network and that
  the `cdn.jsdelivr.net` origin is allowed. `--libs` applies only to `--format=html`.

```sh
yamlet graph specs_example --format=html > graph.html            # offline, self-contained
yamlet graph specs_example --format=html --libs=cdn > graph.html # small, fetches elk at load time
```

## Architecture

```
main.ts                the command registry + data-driven dispatch (owns the `verify` command)
src/help.ts            `yamlet help` — pure aggregator over the registry (help = stdout, exit 0)
src/systems.ts         `yamlet systems` — group spec files by shared `system:` slug (read-only)
src/graph.ts           `yamlet graph` — emit DOT, the JSON graph model, or the HTML viewer (read-only)
src/viewer/            the `--format=html` viewer: template + CSS + JS + `html.ts` assembler; elk vendored
src/types.ts           shared shapes (Finding, FlatRecord, Result, Command, CmdResult, …)
src/catalog.ts         the 50-rule catalog (E0xx–E6xx, W00x)
src/flatten.ts         Phase 1: constrained-YAML → tab-free leaf records
src/composite.ts       cross-file member/socket tables (directional: inputs vs outputs)
src/validate.ts        Phase 2: structural + semantic rules over records
src/render.ts          byte-exact human/JSON output
src/verify.ts          orchestration: extension → flatten → composite → validate
src/author.ts          correct-by-construction appender + verify commit gate
```

**Commands** are a data-driven registry. Each command module exports a `Command` descriptor
(`{ name, summary, help, run }`) that colocates its `--help` text with its runner; `main.ts`
assembles them into one `COMMANDS` array that drives _both_ dispatch and `yamlet help`. So a command
cannot be registered without its help, and there is no separate `switch` to fall out of sync. Adding
a command is: write its `run`, export its descriptor, add it to the array.

**Verify** is two phases. `flatten` is a faithful port of the sh `_flatten` awk state machine; on
any parse error it short-circuits (as the sh tool does). Otherwise `validate` runs the E1xx–E6xx /
W00x rules and `render` reproduces the three output shapes exactly.

**Author** owns all serialization (indentation, the quoting rule `q()`, the pattern→clause mapping,
and ID allocation). After every mutation it runs the in-process verifier as a **commit gate**,
tolerating only the expected "work-in-progress" findings (`E106`/`E108`/`E506`/`E511`/`E609`/`E610`,
and the missing `requirements` / `acceptance-criteria` messages — a half-wired composite between
`add-component` and its `add-connection` calls is expected to trip `E609`/`E610`); anything else
rolls the file back and exits `3`.

## Regression oracles (tests)

Two frozen oracles, snapshots of this tool's own deterministic output (the sh+awk reference they
were once captured from has been retired):

- **verify** — `tests/oracle/*.json` (46 fixtures): the `yamlet verify --format=json` output + exit
  code for every fixture. `parity_test.ts` replays each through the verifier and compares
  structurally (findings-as-set, valid flag, summary, exit code). Re-freeze after an intentional
  rule change with `deno run --allow-read --allow-write tests/gen-oracle.ts`, which reports exactly
  which oracles moved.
- **author** — `tests/oracle-author/*.yamlet.yaml` (4 goldens, incl. a composite of `components` +
  `connections`): the exact file bytes the author runners produce for the full success sequences.
  `author_parity_test.ts` replays the same sequences and asserts byte-identical output + the same
  allocated IDs, plus the full rejection matrix (exit codes, nothing written). Re-freeze with
  `deno run --allow-read --allow-write tests/gen-author-oracle.ts`.

The oracle directories are excluded from `deno fmt`/`lint` (they are captured data, not source).

### Determinism note

- **Duplicate-id location** (`E202`/`E204`/…): the verifier flags the _later_ occurrence, treating
  the first as the original — deterministic, and the more useful place to point a fix.
