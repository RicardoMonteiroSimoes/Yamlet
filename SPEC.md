# Yamlet format specification

This is the **semantic source of truth** for the `.yamlet.yaml` format: what each
field means and *why* it exists. It is deliberately separate from:

- **the `yamlet` verifier** (in `tooling/`, run as `yamlet verify`) — the
  *mechanical* source of truth (what is valid: enums, cardinalities, patterns).
  Every rule has a stable id (`E###`/`W###`); run `yamlet verify --list-rules`. **If
  this document and the verifier ever disagree on validity, the verifier wins and
  this document is the bug.** (The original sh+awk `verify.sh`/`author.sh` were
  retired; the TypeScript tooling under `tooling/` is now the only implementation.)
- **`README.md`** — the pitch and a pointer here. Not a second spec.
- **`specs_example/`** — verified specimens: three leaves (`email_service`,
  `email_service_plain` — the attachment-free variant scope of the same service,
  `pdf_upload`) and two composites (`pdf_archiver`, and `pdf_archiver_resilient`,
  which adds a failure path notifying via the plain sender). Teach *shape*, not meaning.

Ownership rule: every fact has exactly one home. Don't restate a validity rule
here (link its id); don't put semantics in the example's comments (they rot).

---

## Altitude

One `.yamlet.yaml` file = **one component**: a small, coherent scope that exposes a
contract and lists the behaviours it must fulfil. A component is the leaf. Levels
*above* the component (a backend/composite that holds several components and wires
them together) are still being designed — see [Decisions in flight](#decisions-in-flight).

---

## Top-level keys

Seven required keys, plus three optional (`exposes`, `components`, `connections`).
Unknown keys are rejected (`E102`); a missing required one is `E101` — except
`requirements`, which is optional on a composite (see [Composition](#composition--a-level-above-the-component)).

| key | meaning | constraint | enforced by |
|---|---|---|---|
| `system` | slug naming the **service** this file belongs to — files that share a `system:` are different functionality *scopes* of one service (grouped by the `yamlet systems` command); many-to-one, not 1:1 | `^[a-z0-9]+(-[a-z0-9]+)*$` | `E105` |
| `topic` | short human title | non-empty | `E107` |
| `summary` | one sentence: what it is / what contract it exposes | non-empty | `E107` |
| `description` | a few sentences of context | non-empty | `E107` |
| `blast_radius` | what breaks if this is wrong | `low` \| `medium` \| `high` | `E103` |
| `front` | which side of the trust boundary the caller sits on | `internal` \| `external` | `E104` |
| `requirements` | the capabilities this component must fulfil | non-empty list | `E101`, `E106` |
| `exposes` *(optional)* | the contract this component offers | see [`exposes`](#exposes--the-contract-signature) | `E501`–`E511` |
| `components` *(optional)* | member specs this file wires together — makes it a **composite** | see [Composition](#composition--a-level-above-the-component) | `E601`–`E604` |
| `connections` *(optional)* | how a composite wires its members and boundary (`sink: source`) | see [Composition](#composition--a-level-above-the-component) | `E605`–`E610` |

### `front` — the trust boundary, not "who the user is"

`front` records **whether the caller is inside or outside the system's trust
boundary.** It is *not* about wiring (everything is consumed by something, so
"is it consumed" divides nothing) and it is *not* strictly about human users.

- **`external`** — an **untrusted caller** crosses this boundary. That is a human
  user *or* a third-party system hitting a public surface. Its input cannot be
  trusted.
- **`internal`** — the caller is **another component we deploy and control**.
  Input arriving here was already sanitised upstream at an `external` boundary, so
  it is trusted.

**Why it earns a field:** `front` predicts a *class of acceptance-criteria*. An
`external` component must describe what happens on untrusted input — validation,
authorisation, malformed/abusive input, rate limits (mostly `unwanted`/`if` and
`optional` patterns). An `internal` component should **not** re-litigate those; the
validation lives once, at the boundary that owns the trust decision
(single-source-of-truth applied to trust). In a composite, `front` marks where
untrusted input enters the graph.

> **Proposed, not yet enforced:** a `W`-class warning when a `front: external`
> component has zero unwanted-condition criteria — a user-facing thing that never
> says what it does with bad input is almost certainly underspecified. Tracked in
> [Decisions in flight](#decisions-in-flight); not in the verifier yet.

### `exposes` — the contract signature

Optional. Declares the contract this component offers, so another component can
reference a *socket* (a named contract input or output) rather than a box. It is a
**signature, not a schema**: a name, an intent, *named* inputs, and optional *named*
outputs — the two halves of a call signature (`inputs → outputs`, like a function's
parameters and its return value). No types, no formats, no required/optional flags,
no validation rules — the moment it grows those it becomes an IDL and reintroduces
the verbosity yamlet exists to kill.

```yaml
exposes:
  name: pdf-upload             # slug ^[a-z0-9]+(-[a-z0-9]+)*$          (E501)
  intent: verify a file is a well-formed PDF and return it   # non-empty (E502)
  inputs:                      # block sequence — flow [..] is E004
  - file                       # each ^[a-z][a-z0-9_]*$ (E503), unique (E504)
  - filename
  outputs:                     # optional; the return half of the signature
  - pdf_file                   # each ^[a-z][a-z0-9_]*$ (E508), unique (E509)
```

`name`, `intent`, `inputs`, `outputs` are the only permitted keys (`E507`).

**Referencing an input: `{input.NAME}`.** Criteria refer to a contract input with
the prefixed token `{input.channel}` — a *reference*, distinct from a bare
`{placeholder}`. The prefix is load-bearing: it makes a token's role self-evident,
removes any collision between an input and a like-named placeholder, and keeps the
verifier's rules purely syntactic. A bare `{X}` is *always* an example-placeholder
(and always needs a table); `{input.X}` is *always* a contract reference (and never
needs one).

**Binding is checked both directions, file-wide:**

- every `{input.NAME}` in any criterion must resolve to a declared input (`E505`);
- every declared input must be referenced by at least one criterion (`E506`).

This is a name-binding check, like a compiler resolving identifiers — not prose
matching. It catches vocabulary drift (the contract says `recipient`, a criterion
says `address`) because the two names simply won't resolve to each other. It does
**not** catch one name used for two meanings; that stays in `intent` and review, on
purpose (that would need types).

**Outputs: `{output.NAME}` — what the component returns.** An `outputs` list names
the values a caller gets back. It is optional (a pure sink returns nothing) and its
names obey the same token rules as inputs (`E508`/`E509`). A criterion refers to a
declared output with `{output.pdf_file}`, and the binding is symmetric with inputs,
both directions, file-wide:

- every `{output.NAME}` reference must resolve to a declared output (`E510`);
- every declared output must be *referenced* by at least one criterion (`E511`,
  symmetric with `E506` for inputs — typically produced in a `shall`) — declaring a
  return value nothing ever returns is dead surface.

Classification is purely by shape: `{input.x}` → input, `{output.x}` → output,
anything else `{x}` → placeholder. Why outputs earn a place: they give a *downstream*
component a named handle to react to. A connection's trigger ("when the validated PDF
is returned") anchors on an output, and its data-flow forwards that output into
another component's input — see [Composition](#composition--a-level-above-the-component).
Outputs are return values, **not** an event bus: whether "returned" compiles to a
method return, an in-process event, or a broker is an implementation choice yamlet
deliberately does not encode (same as it never says REST-vs-gRPC for a call).

**Tabulating an input.** An `{input.NAME}` reference *may* also appear as an
`input.NAME` column in an `examples` table, to pin down behaviour across concrete
values:

```yaml
    if: a notification for {input.channel} exceeds {max_length} characters
    shall:
    - reject the notification with a length error
    examples:
    - input.channel: sms
      max_length: 160
    - input.channel: push
      max_length: 240
```

Such a column must correspond to a referenced input (`W001` otherwise) and be bound
in every row (`E402`). Crucially, this table is **illustrative cases, not a domain
definition** — it does not declare "the only valid channels." yamlet makes no
closed-world claim about an input's values: a spec is closed-world for
*requirements* (an unspecified value is simply not required — building for it is
speculative), and if you genuinely need "reject anything unsupported" enforced, that
is a **behaviour** — an `unwanted` criterion — not metadata on the input. Domain
validity is a `shall`, never a schema.

---

## `requirements`

A non-empty list. Each requirement is a single capability, described so a reviewer
knows what "done" means.

| field | meaning | constraint | enforced by |
|---|---|---|---|
| `id` | requirement id | `^RQ-[0-9]+$`, unique, script-generated | `E201`, `E202` |
| `description` | the capability, precisely | non-empty | `E107` |
| `acceptance-criteria` | testable behaviours proving the capability | non-empty list | `E107`, `E108` |

Ids are **allocated by the `yamlet` author runner, never chosen by hand.** They are append-only
lists; the agent may not set or reuse an id.

## `acceptance-criteria`

Each criterion is **one testable behaviour**, written in an [EARS](https://alistairmavin.com/ears/)
pattern. The pattern dictates which clauses are allowed.

| pattern | required clause(s) | forbidden clauses |
|---|---|---|
| `ubiquitous` | none (always-on) | all clauses |
| `state` | `while` (a list) | `when`, `if`, `where` |
| `event` | `when` | — |
| `optional` | `where` | — |
| `unwanted` | `if` | — |
| `complex` | `while` + **exactly one** of `when`/`if` | — |

Enforced by `E301` (missing required clause), `E302` (clause not allowed for the
pattern), `E303` (complex needs exactly one of when/if).

| field | meaning | constraint | enforced by |
|---|---|---|---|
| `id` | criterion id | `^AC-[0-9]+[a-z]?$`, unique file-wide | `E203`, `E204` |
| `pattern` | one of the six EARS patterns | see table | `E301`–`E303` |
| clause(s) | `while`/`when`/`if`/`where` per pattern | — | `E301`, `E302` |
| `shall` | the concrete, verifiable obligations | non-empty list | `E304` |

### Placeholders and examples

When a value varies across concrete cases, use a `{placeholder}` in clause or
`shall` text and supply an `examples` table. Placeholder names match
`^[a-z][a-z0-9_]*$` (`E403`). **Every example row must bind every placeholder**
(`E401` if placeholders but no table, `E402` if a row misses one). A column with no
matching placeholder is a warning (`W001`); an examples table with no placeholders
at all is `W002`.

A `{input.NAME}` or `{output.NAME}` token is **not** a placeholder — it is a
contract reference (see [`exposes`](#exposes--the-contract-signature)). Neither forces
a table (an input may optionally be tabulated as an `input.NAME` column). The
classification is purely by shape: `{input.x}` → input, `{output.x}` → output,
anything else `{x}` → placeholder.

---

## Composition — a level above the component

A "backend" that holds several components and **wires them together**. Its reason to
exist is to be the **home for connections** — the wiring between parts is a fact the
composite *owns*, not something a reader infers from prose. (It is also the home for
*emergent* behaviour that belongs to no single leaf — "when a PDF is uploaded, e-mail
it out" belongs to neither leaf — but that now lives in optional `requirements:`, not
in the wiring.) A composite with neither wiring nor emergent behaviour is just a folder
and doesn't need the format.

A composite is the **same file format at higher altitude** (same verifier, same
EARS, same required keys), plus a `components:` membership list — a sequence of
`alias: path` mappings naming member specs by relative path:

```yaml
components:
- uploads: pdf_upload.yamlet.yaml       # alias ^[a-z][a-z0-9_]*$, unique (E601/E602)
- mailer:  email_service.yamlet.yaml    # path must resolve to a file (E603)
```

The key's *presence* is what makes the file a composite, so the list must name at
least one member — a `components:` key with no members is an empty composite, which
is an error (`E601`), never silently a leaf.

The wiring itself lives in a dedicated `connections:` block; a composite may also
carry its own `exposes` (a boundary contract — rules unchanged), and because the
wiring now carries the data flow, its `requirements:` are **optional**, reserved for
emergent obligations no wire can express.

**Cross-file resolution (`E601`–`E604`).** Given the `components:` list the verifier
reads *each member's `exposes` block* — only that; the member owns its own full
correctness and there is no recursion — to build an `alias → sockets` table. An unknown
alias, a missing path (`E603`), a member that exposes nothing, or a `{alias.socket}` in
a criterion that is not a declared input or output all fail (`E604`).

### `connections` — the wiring, held explicitly

A composite is a boundary box; two kinds of wire cross it — **delegation** (a boundary
port to/from a member socket) and **assembly** (one member's output into another's
input). Every wire is one entry, written **`sink: source`** and grouped by the sink's
owner:

```yaml
connections:
  uploads:                       # group = member alias; keys are that member's inputs
    file: input.file             #   delegation in  (composite input  -> member input)
    filename: input.filename
  mailer:
    recipient: input.archive_address
    attachment: uploads.pdf_file #   assembly       (member output    -> member input)
  output:                        # reserved group; keys are the composite's own outputs
    receipt: mailer.receipt      #   delegation out (member output    -> composite output)
```

Endpoints reuse the leaf vocabulary minus the braces (no prose to embed in):
`input.NAME`/`output.NAME` is the composite's own boundary port; `alias.socket` is a
member's socket. A group is a **member alias** or the reserved **`output`** (`E606`);
`input`/`output` are reserved prefixes and never collide with an alias. Binding the
same sink twice is a duplicate mapping key — already `E009`.

**Resolution is asymmetric, and that is what fixes direction.** A *sink* resolves only
against member inputs (or composite outputs, under `output`) — `E607` otherwise. A
*source* resolves only against composite inputs or member outputs — `E608` otherwise.
A member input can never be a source and a composite output can never be one, so a
backwards wire is rejected by the grammar with no dataflow analysis.

**Completeness is total, because contracts are total.** Every `exposes` contract is
total — there are no optional inputs; variance is modelled as separate variant files,
never flags. So wiring completeness is a flat rule, not a per-connection matrix:

- every **member input** must be bound by some connection (`E609`);
- every **composite boundary input** must be used as a source at least once (`E506`,
  the leaf "no dead surface" rule lifted to the boundary);
- every **composite output** must be fed by a connection (`E610`).

A member *output* need not be consumed — it is the member's surface, not the
composite's obligation. Composite-owned data (a configured archive address, a fixed
subject) is **not** a literal held in the file; it is a boundary input the composite
exposes and the level above supplies. yamlet says *what connects to what*, never *what
the value is*. `{alias.socket}` tokens stay legal inside a composite's criteria (still
resolved by `E604`): they let an emergent criterion *refer* to a member, but they no
longer *constitute* wiring.

**Why this reverses the earlier "resolution only, no coverage" stance.** An earlier
draft rejected coverage and direction checks as schema-thinking one level up. Both are
now enforced — but the objection was to their *cause*, and the cause is gone: coverage
was a "what is required *when*" matrix only because inputs could be optional, and
optional inputs were removed; direction meant inferring dataflow from prose, and the
wiring is no longer prose. The rule against matrices and prose-inference stands; the
things that forced them were deleted.

**Reserve composition for genuinely reused components.** If a member is only ever
called by one backend, it is a requirement of that backend, not a component.

Open sub-decisions (still unsettled):

- **One contract per component** (assumed, not enforced): with one contract per
  member, `{alias.socket}` is unambiguous; multiple operations would force
  `{alias.operation.socket}`. Wanting five operations is a smell it's really five
  components.
- **`front` for a graph**: where the trust boundary sits for a whole composite is not
  yet decided.
- **Authoring**: composites are **hand-written**. `yamlet init`/`add-*` own leaf
  serialization only, and gain no `components`/`connections` support until the shape
  is proven stable.

---

## Decisions in flight

Design decisions that are **settled in intent but not yet built** — captured here so
the *why* isn't lost as the format grows. These are **not** enforced by the verifier
and **not** valid syntax yet. When one ships, its rules move into the tables above
and its rationale stays here as the record.

### `front` external-without-unwanted warning

The `W`-class nudge described under [`front`](#front--the-trust-boundary-not-who-the-user-is):
warn when a `front: external` component specifies no unwanted-condition behaviour.
Not yet implemented.

---

*Shipped since first draft: the [`exposes`](#exposes--the-contract-signature) contract
signature with `{input.NAME}`/`{output.NAME}` references and both-direction binding
(`E501`–`E511`); and full [Composition](#composition--a-level-above-the-component) — a
`components:` membership list plus an explicit `connections:` block (`sink: source`),
with cross-file resolution, direction fixed by asymmetric resolution, and total wiring
completeness (`E601`–`E610`). Composition graduated from a decision-in-flight into the
live spec above.*
