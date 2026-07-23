# Yet Another Markup Language Engineering Toolkit

Yamlet, is my own try at coming up with a reliable, minimalistic setup for spec driven development using agents. One that doesn't assume you're a hobby startup founder, but serious about the matter and interested in reliable results.

## What makes Yamlet so special?

My issue with existing options is that they're verbose and unreliable - the verbosity is at fault here, as it leads agents off through various interpretations of the same goal. Instead of clearly sculpting a goal, they write about how many adjectives fit its description. And nobody reads those in detail, not even agents. Or why are they not following them, hmm? 🧐

But agents suffer from the same pitfalls development teams have suffered the past decades. Unclear requirements, broad scopes, changing goal posts, rushed results, non prioritization of code quality metrics. Until now you paid a pretty penny to people that could manage this field, and could trust their judgement. But agents? They will assume something, misundertand it potentially, and output an avalanche of code based on wrong goals. Good luck reviewing that yourself.

In addition, many of these new "frameworks" are just over the top. Why do I need an mcp server for this? Why do I need 20+ skills to do something?

_So, what does this do?_

It focuses on a single source of truth, both for humans and agents. Minimal in its composition, but maximal in its meaning. It leverages [EARS](https://alistairmavin.com/ears/) for acceptance criterias.

[**`email_service.yamlet.yaml`**](specs_example/email_service.yamlet.yaml) is a complete example of _one such_ file. Yes, there can be many of these, and that's the point. They should encompass a small scope, with the descriptive focus on the exact, minimal, must-fulfill requirements.

## Install

`yamlet` is a single self-contained binary (no runtime needed) for macOS and
Linux, on both Intel and Apple Silicon / arm64.

```sh
brew tap RicardoMonteiroSimoes/yamlet          # add the tap (one-time)
brew trust --tap RicardoMonteiroSimoes/yamlet  # trust it (one-time)
brew install yamlet
yamlet --version
```

Homebrew 6+ gates non-official taps behind a trust step: without it, `brew
install` prompts you to confirm the tap on first use. `brew trust --tap`
pre-approves it so the install runs unattended (and covers future upgrades).

Homebrew works on Linux too, so the same commands install it there. To upgrade
later: `brew upgrade yamlet`.

Prefer not to use Homebrew? Grab the tarball for your platform from the
[latest release](https://github.com/RicardoMonteiroSimoes/Yamlet/releases/latest),
verify it against `SHA256SUMS`, and put the `yamlet` binary on your `PATH`.

## The format

The full, authoritative definition of every field — including what `front` and
`blast_radius` actually mean and why — lives in [`SPEC.md`](SPEC.md). The `yamlet`
verifier (`yamlet verify`, in `tooling/`) is the mechanical source of truth for
validity. What follows is a quick reference only.

### Top-level keys

All required: `system` (a slug, `^[a-z0-9]+(-[a-z0-9]+)*$`), `topic`, `summary`,
`description`, `blast_radius` (`low`\|`medium`\|`high`), `front`
(`internal`\|`external`), and a non-empty `requirements` list (optional on a
composite). Three are optional: `exposes`, `components`, `connections`.

### The contract (`exposes`)

`exposes` declares the component's contract signature — a `name`, an `intent`,
named `inputs`, and optional named `outputs` (the return half). Criteria reference
these as `{input.NAME}` / `{output.NAME}`, and the binding is checked both ways:
every reference must resolve, and every declared input/output must be used. See
[`SPEC.md`](SPEC.md#exposes--the-contract-signature).

### Composition (`components` + `connections`)

`components` makes the file a **composite** — a level above the component that
wires several member specs together. Members are listed as `alias: path`; the
wiring lives in a `connections:` block written `sink: source` (e.g.
`attachment: uploads.pdf_file`), where each endpoint is either the composite's own
boundary port (`input.NAME` / `output.NAME`) or a member socket (`alias.socket`).

Verification is cross-file and **total**: it resolves every endpoint against the
members' `exposes`, fixes dataflow direction by resolving sinks and sources
asymmetrically, and enforces completeness — every member input must be wired. A
composite's own `requirements:` are optional, reserved for emergent obligations no
wire expresses.

[`pdf_archiver.yamlet.yaml`](specs_example/pdf_archiver.yamlet.yaml) is a worked
example wiring [`pdf_upload`](specs_example/pdf_upload.yamlet.yaml) into
[`email_service`](specs_example/email_service.yamlet.yaml). See
[`SPEC.md`](SPEC.md#composition--a-level-above-the-component).

### Requirements & acceptance criteria

Each **requirement** has an `id` (`RQ-N`), a `description`, and a non-empty list of
`acceptance-criteria`. Each **criterion** has an `id` (`AC-N`), a `pattern`, its
required clause(s), and a non-empty `shall` list:

| pattern | required clause(s) |
|---|---|
| `ubiquitous` | none (always-on) |
| `state` | `while` |
| `event` | `when` |
| `optional` | `where` |
| `unwanted` | `if` |
| `complex` | `while` + exactly one of `when`/`if` |

Placeholders like `{n}` may appear in clause and `shall` text; when they do, an
`examples` table is required and every row must bind every placeholder.

### Visualizing (`yamlet graph`)

`yamlet graph <file>` emits a diagram of any spec's structure — a leaf's contract,
or a composite's boundary-and-wiring block diagram.

- **`--format=dot`** (default) is Graphviz DOT for `dot -Tsvg` to lay out:
  `yamlet graph specs_example/pdf_archiver.yamlet.yaml | dot -Tsvg > diagram.svg`
- **`--format=json`** emits a stable, renderer-agnostic graph model
  (`yamlet.graph/v1`) so a custom engine or interactive viewer can display it
  without re-parsing yamlet.

Because a project's specs are expected to **live together in one directory**,
`yamlet graph <dir>` (or `--recursive` on a single root) expands the whole
composition tree at once — every root spec, down through nested composites — as one
JSON document. See
[`tooling/README.md`](tooling/README.md#the-graph-model-yamlet-graph---formatjson).

## Skills

Two Claude Code skills under `.claude/skills/`, no MCP server:

- **`yamlet-author`** — interviews you, drills down to precise, testable requirements, and appends them through the `yamlet` tool (`yamlet init` / `add-requirement` / `add-criterion`). The agent never writes the YAML by hand and never picks IDs; the tool serializes everything and generates `RQ-N`/`AC-N` as it goes, so the file is correct by construction.
- **`yamlet-verifier`** — validates a `.yamlet.yaml` file against the rules and reports violations with stable rule IDs (`/yamlet-verifier <file>`). Backed by the single `yamlet` binary (TypeScript compiled by Deno); it is the single source of truth for what "valid" means.