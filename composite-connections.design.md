# Design note: explicit composite connections

**Status: SHIPPED** (2026-07-20). The live specification is now the *Composition*
section of [SPEC.md](SPEC.md#composition--a-level-above-the-component); the rules
(`E605`–`E610`, plus the reused `E009`/`E506`/`E511`) are enforced by the `yamlet`
verifier and the reversal of the earlier "resolution only" stance is recorded in
SPEC.md. This file is kept as the **design record** — the fuller derivation and the
rationale behind [§6](#6-what-this-reverses-and-why-its-now-safe). Where it and
SPEC.md ever differ on intent, SPEC.md wins.

This note is the *spec of the spec*: it fixes the format and rules for explicit
composite connections before any verifier code is written. Rule ids below are
**intent sketches**, not final — `verify.sh` owns the numbering.

---

## 1. The problem with the shipped model

Today a composite expresses wiring *implicitly*, inside an EARS criterion, by
co-locating member tokens:

```yaml
# pdf_archiver.yamlet.yaml — as shipped
- id: AC-1
  when: "{uploads.pdf_file} is returned"
  shall:
  - e-mail {uploads.pdf_file} as {mailer.attachment} to the configured archive {mailer.recipient}
  - ensure the archive e-mail is sent successfully
```

The wiring is recoverable only by *reading the prose* and noticing that
`{uploads.pdf_file}` and `{mailer.attachment}` sit in the same sentence. Three
consequences:

- **The pairing is a heuristic, not a fact.** "These two tokens are wired" is an
  inference a human draws from adjacency; the verifier only checks each token
  *resolves* (E604), never that pdf_file *feeds* attachment.
- **Silent gaps.** `mailer` declares four inputs; this criterion mentions two
  (`attachment`, `recipient`). `subject` and `content` are never bound and nothing
  complains. The composite is under-wired and looks complete.
- **Wiring and obligation are tangled.** One `shall` line carries both the data
  route *and* the delivery guarantee. They have different owners (the route is
  mechanical; "sent successfully" is emergent) and want different treatment.

The composite is supposed to be the *home* for the connections — it should **hold**
them explicitly, the way a system diagram draws a wire, not leave them implied.

## 2. The model: a composite is a boundary box

A composite is a bordered box (SysML internal-block style). Its members sit inside.
There are exactly two kinds of wire and two kinds of endpoint:

**Endpoints (two kinds):**

- `input.NAME` / `output.NAME` — the **composite's own** boundary port, declared in
  the composite's `exposes`. Same vocabulary a leaf uses for its own contract.
- `alias.socket` — a **member's** contract socket. Same vocabulary the shipped model
  already uses.

**Wires (two kinds), both are just `sink: source`:**

- **delegation** — a composite boundary port crosses the border to/from a member:
  `input.file → uploads.file` (in), or `output.receipt ← mailer.receipt` (out).
- **assembly** — one member's output feeds another member's input:
  `uploads.pdf_file → mailer.attachment`.

There is **no third endpoint kind and no literal values.** Composite-owned data ("a
configured archive address", "a fixed subject") is **not** a constant embedded in the
composite — it is a **boundary input** the composite exposes and the level above
supplies. yamlet describes *what connects to what*, never *what the value is* (same
reason it never encodes REST-vs-gRPC or a literal channel list). "Configured" means
"configured by the caller," and the literal text lives in implementation/config,
outside yamlet.

## 3. Grammar

A composite gains an optional `exposes` (already permitted by SPEC.md, rules
unchanged) and a new optional `connections:` block. `requirements:` stays but shrinks
to emergent obligations only.

```yaml
exposes:                       # the composite's own boundary contract (total)
  name: pdf-archiver
  intent: archive an uploaded PDF by e-mailing it to a configured archive address
  inputs:
  - file
  - filename
  - archive_address
  - subject
  - content
  # no outputs — this composite is a pure sink

connections:                   # sink: source, grouped by the sink's owner
  uploads:                     # member alias → its inputs
    file: input.file           #   delegation in
    filename: input.filename   #   delegation in
  mailer:
    recipient: input.archive_address
    subject: input.subject
    content: input.content
    attachment: uploads.pdf_file   # assembly
  output:                      # reserved group: the composite's own outputs
    receipt: mailer.receipt    #   delegation out (n/a for the archiver; shown for grammar)
```

**Reading:** each leaf key is a **sink**, its value is the **source**, read as a
binding (`attachment: uploads.pdf_file` = "attachment gets pdf_file").

**Group keys** are member aliases **or** the reserved `output`. `input`/`output` are
already reserved prefixes (SPEC.md §exposes), so they can never collide with a member
alias. There is no `input` group — a composite input is a *source*, it never receives.

## 4. The completeness rule (binary)

Because every contract is now **total** (no optional inputs — settled this cycle),
completeness is flat, not a matrix:

- **Every member input must appear as a sink key.** `mailer` declares four inputs →
  four keys required. A missing key *is* the unbound-input error. (This is exactly
  what catches the shipped archiver's silent `subject`/`content` gap.)
- **Every composite boundary input must be used as a source at least once** — the
  same "no dead surface" rule as a leaf's E506, lifted to the boundary.
- **Every composite output must appear as a sink under `output`** — symmetric, the
  boundary output must be fed.
- **Member outputs need not all be consumed** — an output is the member's surface,
  not the composite's obligation. Leaving `uploads.pdf_file` unused would be legal
  (though usually a smell).

**Direction is structural, not inferred.** A source must be *source-capable*
(a composite input, or a member output); a sink must be *sink-capable* (a member
input, or a composite output). Wiring a member input to another member input (two
sinks) is a grammar error, caught by shape — no dataflow analysis needed.

## 5. Rules that come for free

- **Double-binding** — binding the same sink twice is a duplicate mapping key, which
  **`E009` already rejects.** No new rule.
- **Socket resolution** — every `alias.socket` in a connection resolves against the
  member's `exposes` exactly as **`E604`** already does for criterion tokens. The
  resolver is reused; only the call sites are new.
- **Composite `exposes` validity** — `E501`–`E511` apply unchanged. One
  reinterpretation: for a composite, a boundary input counts as "referenced" (E506)
  when it is used as a **connection source**, not only in a criterion. Likewise E511
  for outputs.

## 6. What this reverses, and why it's now safe

SPEC.md:268–274 records that coverage and direction were "considered and rejected."
This design brings both back. That is a real reversal, and here is the justification:

| Rejected then | Because | Why it's safe now |
|---|---|---|
| **Coverage** ("supply every input") | It implied *conditional* requiredness — a "what is required *when*" matrix, schema-thinking one level up. | Optional inputs are gone. Coverage is no longer conditional: *every* input, *always*. Flat rule, no matrix. |
| **Direction** ("trigger reads an output; forward runs output→input") | It meant analysing free prose to guess dataflow legality. | Connections are no longer prose. `sink: source` *is* the direction; it's grammar, checked by shape. |

Both objections were objections to their *cause*, and the cause (optional inputs;
prose-encoded wiring) is what we removed. We did not change our mind that matrices and
prose-dataflow-inference are bad — we deleted the things that forced them.

## 7. `requirements:` on a composite — optional, emergent only

A composite **may** still carry `requirements:`; they are **optional** and reserved
for **emergent** obligations no wire encodes. The archiver's delivery guarantee is the
canonical case:

```yaml
requirements:
- id: RQ-1
  description: A validated PDF returned by the upload surface is reliably delivered to the archive
  acceptance-criteria:
  - id: AC-1
    pattern: event
    when: "{uploads.pdf_file} is returned"     # trigger still anchors on a member output
    shall:
    - ensure the archive e-mail is sent successfully   # emergent — no wire expresses "reliably"
```

The wiring that used to live in this criterion's prose is gone — it moved to
`connections:`. What remains is only the guarantee the composition makes *as a whole*.
A composite whose behaviour is fully captured by its wiring carries no `requirements:`
at all and is still a valid composite (its reason to exist is the wiring it holds).

`{alias.socket}` tokens remain legal inside composite criteria (still resolved by
E604) — they let an emergent criterion *refer* to a member, but they no longer
*constitute* wiring.

## 8. Partial inputs → variant files, never flags

When a partial contract is genuinely needed (e.g. an e-mail path with no attachment),
define a **second, total** member spec — never an optional flag:

```yaml
# email_service_plain.yamlet.yaml
exposes:
  name: e-mail-sending-service-plain
  intent: send an email with a subject and content to a recipient over TLS SMTP
  inputs:
  - recipient
  - subject
  - content            # no attachment — a different, total contract
```

A composite that has no attachment to send wires `mailer: email_service_plain…`; the
completeness rule then requires exactly three sinks. The illegal "attachment sometimes
present" combination has no file, so it cannot be expressed — variance is
**extensional** (enumerate total variants), never **intensional** (flags + a
required/optional matrix). Cost: duplicated contract text across variants; mitigate,
if it bites, by making variants thin composites over a shared core leaf — not
mandated.

## 9. Worked example: the archiver, before and after

**Before** (shipped) — wiring implicit in prose, `subject`/`content` silently unbound:

```yaml
components:
- uploads: pdf_upload.yamlet.yaml
- mailer:  email_service.yamlet.yaml
requirements:
- id: RQ-1
  acceptance-criteria:
  - id: AC-1
    when: "{uploads.pdf_file} is returned"
    shall:
    - e-mail {uploads.pdf_file} as {mailer.attachment} to the configured archive {mailer.recipient}
    - ensure the archive e-mail is sent successfully
```

**After** — wiring explicit and total; the gap is now a hard error; the criterion
keeps only the emergent guarantee:

```yaml
exposes:
  name: pdf-archiver
  intent: archive an uploaded PDF by e-mailing it to a configured archive address
  inputs: [file, filename, archive_address, subject, content]   # (block seq in real file)

components:
- uploads: pdf_upload.yamlet.yaml
- mailer:  email_service.yamlet.yaml

connections:
  uploads:
    file: input.file
    filename: input.filename
  mailer:
    recipient: input.archive_address
    subject: input.subject
    content: input.content
    attachment: uploads.pdf_file

requirements:
- id: RQ-1
  description: A validated PDF returned by the upload surface is reliably delivered to the archive
  acceptance-criteria:
  - id: AC-1
    pattern: event
    when: "{uploads.pdf_file} is returned"
    shall:
    - ensure the archive e-mail is sent successfully
```

## 10. Open questions

- **`front` for a composite** — where the trust boundary sits for a graph is still
  unsettled (SPEC.md already flags this). Not blocked by this note.
- **Rule numbering** — the completeness/direction/connection-structure rules need
  real ids and messages in `verify.sh`; sketched here as intent only.
- **Authoring** — composites remain hand-written; `author.sh` gains no connection
  support until the shape is proven.
- **Multiple sinks from one source** — a source feeding several sinks (fan-out) is
  implicitly allowed (only *sinks* are unique keys). Confirm that's intended before
  it's relied on.
