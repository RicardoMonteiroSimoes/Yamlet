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
| `event` | triggered by a discrete event | `when` | `when: "..."` |
| `unwanted` | response to an error/undesired condition | `if` | `if: "..."` |
| `optional` | only in a certain configuration/feature | `where` + exactly one of `when`/`if` | `where: "..."` + (`when`\|`if`) |
| `complex` | a state **and** a trigger | `while` + exactly one of `when`/`if` | `while: [...]` + (`when`\|`if`) |

**Every criterion carries exactly one trigger** (`when` or `if`). EARS's trigger-less `ubiquitous` and `state` are not accepted: a component with a contract has no continuous behaviour, and a trigger-less criterion projects to a Gherkin scenario with no `When` step. What people reach for them with is one of:

- **a definition** ("the normalised URL is …", "blank means empty or whitespace") — that is prose for `description`, pinned by example rows on the criteria that observe it (a whitespace-only row where blankness matters, an astral character where the unit of length does);
- **an invariant** ("at most one project per URL") — that is the `unwanted` criterion that maintains it;
- **an always-on behaviour** ("log every request") — that is `event`, `when: "a request is received"`.

Every criterion needs one or more `shall` items: the concrete, verifiable obligations ("the system shall …"). Keep each `shall` atomic and observable.

**Word budgets are enforced (`E305`).** A clause (`when`, `if`, `where`, each `while` entry) and each `shall` is at most 20 words; a requirement description and the summary 30. A `when` that runs long is stacking preconditions that belong in `while`, one per entry, or is two criteria. The verifier also warns (`W007`) on a trigger that reads "X, and Y" or "X together with Y".

```
yamlet_add_criterion({
  file: "specs/email.yamlet.yaml", rq: "RQ-1", pattern: "event",
  when: "a login is attempted using valid TLS SMTP credentials",
  shall: ["authenticate to the SMTP server over TLS"]
})
# -> returns "AC-1"
```

`rq` accepts **any** requirement in the file. Add `after: "AC-N"` to insert directly behind a named sibling instead of appending to the end of that requirement's criteria; the inserted criterion takes a letter-suffixed id (`AC-1a`) so nothing is renumbered.

## Stored state — `reads` / `writes`

Criteria lean on persisted state — "the poll is closed", "replace the earlier vote", "the instant it was changed". Name it: `reads` for a field (`entity.field`) the criterion only looks at, `writes` for one it creates, changes or deletes. A write covers the read, so a field is named once per criterion. Ask the user, per criterion: *what stored data does this look at, and what does it change?* A criterion that touches none carries neither.

```
yamlet_add_criterion({
  file: "specs/vote_casting.yamlet.yaml", rq: "RQ-1", pattern: "unwanted",
  if: "the poll is closed", shall: ["reject the vote"], reads: ["poll.state"]
})
```

1. **Reuse names first.** Before naming a field, list what the system already has: `yamlet_systems({ dir: "specs", system: "lunch-poll", state: true })`. Add `details: true` to see the criteria behind each field — they are its only description. A second spelling of the same thing (`poll.status` next to `poll.state`) is invisible to the verifier and splits the data model.
2. **An index, not a schema.** No types, keys, collation or formats — those stay in the code, or become a decision while planning. No prose description either: if the criteria don't say what a field means, a criterion is missing.
3. **Contention.** When the field is also touched by another scope of the system, one side writing it, the result carries a `NOTE:` naming that scope. A second writer races the first; a reader may act on a value the other is changing (a vote checked against a poll being closed). Ask the user what should happen when the two interleave. Point to the criterion that already says so, in either spec — or draft one (typically `unwanted`, in the scope that must refuse or reconcile) and challenge it. Two readers never race.
4. **`W009`** — a field this spec reads that no scope of the system writes. The writing scope isn't specified yet, the name is misspelled, or the data comes from outside the system. Tell the user which; it is a warning, not a reason to change the name.

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
