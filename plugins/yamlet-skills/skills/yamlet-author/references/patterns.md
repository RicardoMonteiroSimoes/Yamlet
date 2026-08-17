# EARS patterns, tokens and examples

Read this when you get to acceptance-criteria, whichever route you took.

## Requirements

A requirement is a capability, described so a reviewer knows what "done" means. One capability per requirement.

```
yamlet add-requirement specs/email.yamlet.yaml \
  --description "The service reliably connects to a single SMTP service"
# -> prints "RQ-1"
```

## Acceptance-criteria

Each criterion is **one testable behaviour** written in an EARS pattern. ALWAYS define criteria per requirement directly. When the user gives too few, or too broad, challenge that and suggest options that match the rules.

Decide the pattern by asking *what triggers or conditions this behaviour*:

| pattern | when to use | required clause(s) | flags |
|---|---|---|---|
| `ubiquitous` | always-on, no trigger | none | — |
| `state` | true while some state holds | `while` (a list) | `--while` (repeatable) |
| `event` | triggered by a discrete event | `when` | `--when` |
| `optional` | only in a certain configuration/feature | `where` | `--where` |
| `unwanted` | response to an error/undesired condition | `if` | `--if` |
| `complex` | a state **and** a trigger | `while` + exactly one of `when`/`if` | `--while` + (`--when`\|`--if`) |

Every criterion needs one or more `--shall` items: the concrete, verifiable obligations ("the system shall …"). Keep each `shall` atomic and observable.

```
yamlet add-criterion specs/email.yamlet.yaml \
  --rq RQ-1 --pattern event \
  --when "a login is attempted using valid TLS SMTP credentials" \
  --shall "authenticate to the SMTP server over TLS"
# -> prints "AC-1"
```

`--rq` accepts **any** requirement in the file. Add `--after AC-N` to insert directly behind a named sibling instead of appending to the end of that requirement's criteria; the inserted criterion takes a letter-suffixed id (`AC-1a`) so nothing is renumbered.

## The three kinds of `{token}`

Distinguished purely by shape:

- **`{input.NAME}`** — a reference to a contract input declared in `exposes`. Use it wherever the behaviour acts on a contract input. It must resolve to a declared input or the tool rejects it. It does **not** need an examples table.
- **`{output.NAME}`** — a reference to a declared contract output. Use it where the behaviour *returns* a value (typically in a `shall`, e.g. "return `{output.pdf_file}`"). Same rules; needs no table.
- **`{placeholder}`** — a value that varies across concrete example cases. Name matches `^[a-z][a-z0-9_]*$`. It **requires** an `examples` table, and **every row must bind every placeholder**.

On a composite, a fourth shape appears: **`{alias.socket}`**, a reference to a member's contract socket. Same rules as input/output references — see `references/composites.md`.

An `{input.NAME}` may *also* be tabulated (as an `input.NAME` example column) when you want to pin behaviour to concrete values — but that table is **illustrative cases, never a declaration of the only valid values**. To constrain the valid set, write an `unwanted` criterion instead. Domain validity is a `shall`, never a schema.

## Placeholders and examples

**Every example row must bind every placeholder** — the tool rejects the criterion otherwise, so gather the numbers from the user first.

```
yamlet add-criterion specs/email.yamlet.yaml \
  --rq RQ-1 --pattern complex \
  --while "{n} retries have already been attempted for the e-mail" \
  --if "an SMTP timeout occurs on the re-authentication attempt" \
  --shall "a retry is scheduled with {delay_seconds} seconds backoff delay" \
  --example "n=0;delay_seconds=10" --example "n=1;delay_seconds=30"
# -> prints "AC-3"
```

Pass literal text plainly; do **not** add quotes around `{...}` yourself — the tool quotes when needed.

## A note on `front`

An `external` scope owes `unwanted`/`if` criteria for malformed or hostile input — validation, authorisation, abusive input, rate limits. An `internal` scope should **not** re-litigate those: the validation lives once, at the boundary that owns the trust decision. If you find yourself writing input-validation criteria on an `internal` scope, question whether the scope's `front` is right, or whether that behaviour belongs upstream.
