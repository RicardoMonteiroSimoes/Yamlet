<!-- Generated from skills/yamlet-author/references/patterns.md by scripts/build-skills.ts — edit the source, then rebuild. -->
# EARS patterns, tokens and examples

Read this when you get to acceptance-criteria, whichever route you took.

## Requirements

A requirement is a capability, described so a reviewer knows what "done" means. One capability per requirement.

```
yamlet add-requirement specs/email.yamlet.yaml \
  --description "A requested e-mail reaches its recipient"
# -> prints "RQ-1"
```

## Acceptance-criteria

Each criterion is **one testable behaviour** written in an EARS pattern. ALWAYS define criteria per requirement directly. When the user gives too few, or too broad, challenge that and suggest options that match the rules.

Decide the pattern by asking *what triggers or conditions this behaviour*:

| pattern | when to use | required clause(s) | flags |
|---|---|---|---|
| `event` | triggered by a discrete event | `when` | `--when` |
| `unwanted` | response to an error/undesired condition | `if` | `--if` |
| `optional` | only in a certain configuration/feature | `where` + exactly one of `when`/`if` | `--where` + (`--when`\|`--if`) |
| `complex` | a state **and** a trigger | `while` + exactly one of `when`/`if` | `--while` (repeatable) + (`--when`\|`--if`) |

**Every criterion carries exactly one trigger** (`--when` or `--if`). EARS's trigger-less `ubiquitous` and `state` are not accepted: a component with a contract has no continuous behaviour, and a trigger-less criterion projects to a Gherkin scenario with no `When` step. What people reach for them with is one of:

- **a definition** ("the normalised URL is …", "blank means empty or whitespace") — that is prose for `description`, pinned by example rows on the criteria that observe it (a whitespace-only row where blankness matters, an astral character where the unit of length does);
- **an invariant** ("at most one project per URL") — that is the `unwanted` criterion that maintains it;
- **an always-on behaviour** ("log every request") — that is `event`, `--when "a request is received"`.

Every criterion needs one or more `--shall` items: the concrete, verifiable obligations ("the system shall …"). Keep each `shall` atomic and observable.

**Word budgets are enforced (`E305`).** A clause (`--when`, `--if`, `--where`, each `--while`) and each `--shall` is at most 20 words; a requirement description and the summary 30. A `--when` that runs long is stacking preconditions that belong in `--while`, one per entry, or is two criteria. The verifier also warns (`W007`) on a trigger that reads "X, and Y" or "X together with Y".

```
yamlet add-criterion specs/email.yamlet.yaml \
  --rq RQ-1 --pattern event \
  --when "a send is requested for {input.recipient}" \
  --shall "deliver an e-mail with {input.subject} and {input.content} to {input.recipient}"
# -> prints "AC-1"
```

`--rq` accepts **any** requirement in the file. Add `--after AC-N` to insert directly behind a named sibling instead of appending to the end of that requirement's criteria; the inserted criterion takes a letter-suffixed id (`AC-1a`) so nothing is renumbered.

## Stored state — `--reads` / `--writes`

Ask per requirement what the business remembers or changes — facts like an order's status, not tables or columns — then put each on the criterion that touches it: `--reads entity.field`, `--writes entity.field` (a write covers the read). Reuse the system's names: `yamlet systems DIR --system=S --state` (`--details` shows each field's criteria — its only description). An index, not a schema.

A `NOTE:` means another scope touches the field and one side writes it: ask what happens when they interleave; cite the criterion that says so, or draft one. `W009`: a read field no scope writes — a missing scope, a typo, or external data.

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
  --while "the sender is on the {plan} plan" \
  --if "more than {daily_limit} e-mails are requested in one day" \
  --shall "reject the send" --reads account.plan --reads account.sent_today \
  --example "plan=free;daily_limit=100" --example "plan=pro;daily_limit=10000"
# -> prints "AC-3"
```

Pass literal text plainly; do **not** add quotes around `{...}` yourself — the tool quotes when needed.

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
