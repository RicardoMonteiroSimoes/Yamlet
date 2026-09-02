# EARS patterns, tokens and examples

Read this when you get to acceptance-criteria, whichever route you took.

## Requirements

A requirement is a capability, described so a reviewer knows what "done" means. One capability per requirement.

```
yamlet_add_requirement({
  file: "specs/email.yamlet.yaml",
  description: "The service reliably connects to a single SMTP service"
})
# -> returns "RQ-1"
```

## Acceptance-criteria

Each criterion is **one testable behaviour** written in an EARS pattern. ALWAYS define criteria per requirement directly. When the user gives too few, or too broad, challenge that and suggest options that match the rules.

Decide the pattern by asking *what triggers or conditions this behaviour*:

| pattern | when to use | required clause(s) | parameter |
|---|---|---|---|
| `ubiquitous` | always-on, no trigger | none | — |
| `state` | true while some state holds | `while` (a list) | `while: [...]` |
| `event` | triggered by a discrete event | `when` | `when: "..."` |
| `optional` | only in a certain configuration/feature | `where` | `where: "..."` |
| `unwanted` | response to an error/undesired condition | `if` | `if: "..."` |
| `complex` | a state **and** a trigger | `while` + exactly one of `when`/`if` | `while: [...]` + (`when`\|`if`) |

Every criterion needs one or more `shall` items: the concrete, verifiable obligations ("the system shall …"). Keep each `shall` atomic and observable.

```
yamlet_add_criterion({
  file: "specs/email.yamlet.yaml", rq: "RQ-1", pattern: "event",
  when: "a login is attempted using valid TLS SMTP credentials",
  shall: ["authenticate to the SMTP server over TLS"]
})
# -> returns "AC-1"
```

`rq` accepts **any** requirement in the file. Add `after: "AC-N"` to insert directly behind a named sibling instead of appending to the end of that requirement's criteria; the inserted criterion takes a letter-suffixed id (`AC-1a`) so nothing is renumbered.

## The three kinds of `{token}`

Distinguished purely by shape:

- **`{input.NAME}`** — a reference to a contract input declared at init. Use it wherever the behaviour acts on a contract input. It must resolve to a declared input or the tool rejects it. It does **not** need examples.
- **`{output.NAME}`** — a reference to a declared contract output. Use it where the behaviour *returns* a value (typically in a `shall`, e.g. "return `{output.pdf_file}`"). Same rules; needs no examples.
- **`{placeholder}`** — a value that varies across concrete example cases. Name matches `^[a-z][a-z0-9_]*$`. It **requires** `examples`, and **every row must bind every placeholder**.

On a composite, a fourth shape appears: **`{alias.socket}`**, a reference to a member's contract socket. Same rules as input/output references — see the `composites` guide.

An `{input.NAME}` may *also* be tabulated (as an `input.NAME` example column) when you want to pin behaviour to concrete values — but that table is **illustrative cases, never a declaration of the only valid values**. To constrain the valid set, write an `unwanted` criterion instead. Domain validity is a `shall`, never a schema.

## Placeholders and examples

**Every example row must bind every placeholder** — the tool rejects the criterion otherwise, so gather the numbers from the user first.

```
yamlet_add_criterion({
  file: "specs/email.yamlet.yaml", rq: "RQ-1", pattern: "complex",
  while: ["{n} retries have already been attempted for the e-mail"],
  if: "an SMTP timeout occurs on the re-authentication attempt",
  shall: ["a retry is scheduled with {delay_seconds} seconds backoff delay"],
  examples: ["n=0;delay_seconds=10", "n=1;delay_seconds=30"]
})
# -> returns "AC-3"
```

Pass literal text plainly; do **not** add quotes around `{...}` yourself — the tool handles serialization.

## What a test must not have to invent

Each clause and `shall` becomes a Gherkin step, and a step definition binds only what the line names. Read each line alone before committing:

- **Contract data is a token, never prose.** "The identity's email" should have been `{input.email}`. Behind a frozen bag input, anchor the field to it (`the email carried by {input.user_identity}`), one name throughout.
- **Every value is bound.** A limit, size or format is a `{placeholder}` with examples, a literal (`10 MiB`), or an input. "The store's maximum length" binds nothing.
- **Results are stated, not described.** `set {output.outcome} to created`, not "indicate the record was created".
- **A `shall` is a positive observable.** "Not fail provisioning for that reason alone" hides a precondition; that goes in the clause. A named absence (`return no {output.error}`) is fine.
- **No open lists.** "Such as", "including", "etc." — name the set.
- **Each line stands alone.** "That maximum length" points back into the clause.

## A note on `front`

An `external` scope owes `unwanted`/`if` criteria for malformed or hostile input — validation, authorisation, abusive input, rate limits. An `internal` scope should **not** re-litigate those: the validation lives once, at the boundary that owns the trust decision. If you find yourself writing input-validation criteria on an `internal` scope, question whether the scope's `front` is right, or whether that behaviour belongs upstream. Checking that a field the scope needs is *present* is not validation; checking its format, length or allowed values is.
