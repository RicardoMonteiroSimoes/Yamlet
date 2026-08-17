# Design note: editing existing specs

**Status: IN BUILD.** Steps 0–3 of §12 are shipped — `yamlet systems --details`,
`yamlet impact`, block addressing (`src/blocks.ts`), and insertion (`add-criterion`
into any requirement, `--after` for `AC-Na`) — along with the §11 skill partition on
the Claude Code build. Steps 4–7 and the `pi/` port are unbuilt; the pi port follows
once the Claude Code side is complete. This note is the *spec of the spec*: it
fixes the model, the safety story and the command surface for mutating an existing
`.yamlet.yaml` before any tooling code is written, in the same way
[`composite-connections.design.md`](composite-connections.design.md) did for wiring.
Rule ids and command names below are **intent sketches**; the verifier and
`tooling/src/` own the final numbering and naming.

Where this note and [`SPEC.md`](SPEC.md) ever differ on intent, SPEC.md wins.

---

## 1. The walls we hit today

`yamlet`'s author is an **appender**. Every mutation is `text + block`, and the four
places that refuse work all refuse for the same underlying reason — the tool cannot
address a block that already exists:

| Wall | Where | Message |
|---|---|---|
| A criterion may only attach to the newest requirement | `author.ts:730` | *"that would require EDITING an existing block, which is out of scope for now"* |
| An input/output cannot be added to a contract | `author.ts:826`, `:838` | *"Declare it at init; adding inputs to an existing contract is out of scope for now"* |
| No component after a connection, none after a requirement | `author.ts:379`, `:382` | *"declare all components before connections / before requirements"* |
| No connection after a requirement; a group is wired once | `author.ts:485`, `:511` | *"add all connections before requirements"* / *"wire a group in one call"* |

These read as four separate scope limits. They are one: **there is no way to name an
existing block.** Everything below follows from adding that.

The user-visible cost is worst at the contract. `exposes` is frozen at `init`, the
author skill says so three times, and the whole `yamlet-contract-challenger` gate
exists to buy the decision back. A contract that turns out to need one more input is
currently unfixable through the tool — the only remedy is to hand-write the YAML,
which is exactly the thing the design forbids.

## 2. The reframe: block addressing, not "edit"

The missing primitive is **addressing a block by its id and knowing its line extent**.
`flatten.ts` already emits `{path, value, line}` for every scalar, so a block's extent
is derivable with no new parser:

> The block for `AC-3` spans `[min(line), max(line)]` over every record whose path is
> prefixed by that criterion's path. In a block sequence the first key of an item
> carries the `-`, so the minimum line *is* the dash line — regardless of key order,
> which keeps this honest on hand-written files where `id` may not come first.

That one primitive unlocks three operations that are worth shipping — and reasoning
about — separately:

- **insert** — attach a criterion to an *earlier* requirement. Still purely additive:
  no existing bytes change, nothing downstream is invalidated. This is the most-hit
  wall and the cheapest to remove.
- **revise** — replace a block's content while its id stays put.
- **remove** — delete a block; its id is retired forever.

## 3. What does not change

Editing must not become a side door around the properties that make yamlet worth
using. These are non-negotiable and every decision below is subordinate to them:

1. **The tool owns all serialization.** No command accepts YAML, a structural path, or
   a line number from its caller. This is why the surface is per-target verbs and not
   a generic `--path a.b[2].c --value …` setter — that would be hand-editing wearing a
   CLI, and it could not check pattern↔clause coherence.
2. **The tool owns all ids.** Revision preserves an id; it never accepts one as a value
   to *write*, only as a value to *address*.
3. **Every mutation is verified, and rolls back on failure.** The guard generalizes
   (§5); it does not weaken.
4. **Nothing but the addressed block changes.** Mutations splice in place, byte-for-byte
   preserving the rest of the file (§4).

## 4. Mechanism: splice in place

A mutation re-serializes **only the addressed block** with the existing emitters and
splices it over that line range. The alternative — parse the file into a model and
re-emit the whole thing — is rejected:

- `SPEC.md` still describes composites as hand-written, and hand-written files carry
  comments and formatting a re-emitter would silently normalize away.
- It would churn the frozen `tests/oracle-author/` bytes for no behavioural reason.
- It converts every edit into a whole-file diff, destroying reviewability — the thing
  a spec-as-source-of-truth repo most depends on.

**Accepted cost, stated plainly:** a revise re-serializes its block, so *comments
inside the revised block are lost*. Comments anywhere else in the file survive. This
should be in the command's `--help`, not discovered.

**The criterion is the atom of revision.** `revise-criterion` replaces a whole
criterion (taking exactly `add-criterion`'s flags, plus `--ac AC-N`); it is not a patch
of individual clauses. Two reasons, and they are the same reason: the legality of a
clause depends on the `pattern`, so only a whole criterion can be checked for
coherence; and patching one `shall` out of a list would need positional addressing,
which violates §3.1. A header field, by contrast, is an independent scalar, so
per-field `set-*` verbs are right there.

## 5. The guard, generalized

`guardCheck` (`author.ts:147`) currently tolerates a hardcoded global allowlist —
`E106`/`E108`/`E506`/`E511`/`E609`/`E610` plus two message matches — because an append
leaves a spec mid-construction. That list is not a general safety property; it is
*the set of findings the append commands predict about themselves*, written once as a
constant.

Make that explicit and the guard covers editing for free:

> **A mutation is accepted iff the resulting findings are a subset of
> (the findings that existed before) ∪ (the findings this command predicts).**

Each command declares its own predicted set. `add-requirement` predicts "the new
requirement has no criteria yet" (`E108`). `add-input` predicts "the new input is
unreferenced" (`E506`) **and** "each named parent composite now has an unbound member
input" (`E609`, §7). A revise predicts nothing — its result must not gain a single
finding. Anything outside the union rolls the file back, exactly as today.

**Findings must be compared by stable identity, not by path.** Positional indices shift
under insert and remove (`requirements[1]` becomes `requirements[0]` when its
predecessor is deleted), so a path-keyed comparison would report every later finding as
new. Key on `(rule, message, owning RQ-N/AC-N)` instead.

## 6. Identity: ids are permanent, holes are legal

- **An id is never reused and never renumbered.** `yamlet tests` writes a
  `manifest.json` keyed `feature → AC-N`, and scenarios carry `@AC-N` tags. Renumbering
  would silently re-point step definitions at different behaviour — the one failure
  mode with no loud symptom.
- **Deleting leaves a hole.** `E203`/`E204` check pattern and uniqueness, never
  density; `AC-1, AC-2, AC-4` is valid today. Allocation stays "max existing + 1", so a
  hole is never refilled.
- **Ordered insertion uses the suffix the format already reserves.** `E203` accepts
  `^AC-[0-9]+[a-z]?$` (`validate.ts:611`), but the author has never emitted a suffix and
  no example uses one. `add-criterion --after AC-3` allocates `AC-3a` — sorted position
  without touching a single neighbouring id. The affordance was designed in and left
  unused; this is what it was for.
- **`exposes.name` is not a link key.** `contractOf` reads it only as a presence
  sentinel; members link by *path* and connection groups by *alias*. Renaming it is
  cross-file safe, so it belongs in Tier 0 despite sitting inside the frozen block.

## 7. Blast radius, and why Tier 2 has an internal order

| Tier | Targets | Cross-file | Notes |
|---|---|---|---|
| **0** | `topic`, `summary`, `description`, `blast_radius`, `exposes.name`, `exposes.intent`; requirement `description`; criterion clauses/`shall`/`examples`; insert criterion | no | Fallout is caught by the verifier — e.g. revising away the last `{input.x}` raises `E506` |
| **1** | criterion `pattern`; `front`; `system`; remove RQ/AC | no | File-local but structural; a removed criterion orphans step definitions (§8) |
| **2** | `exposes` add/remove/rename input·output; `components`; `connections`; delete a file | **yes** | Needs the reverse index, and has a prerequisite chain |

### 7.1 The reverse index — `yamlet impact`

Read-only, and the foundation for everything cross-file: given a spec, which specs
declare it in `components:`, and which of its sockets do they consume? `listSpecs`
(`systems.ts:60`) plus `resolveComposite` per file is the whole implementation. It is
independently useful — it is also what finally unblocks the long-deferred `rm`, whose
stated blocker in `tooling/CLAUDE.md` is precisely "safe removal needs dependency
analysis".

### 7.2 Contract edits are asymmetric

Totality (`E609`: every member input must be bound) makes the four contract mutations
behave quite differently:

| Mutation | Effect on the spec itself | Effect on parent composites |
|---|---|---|
| **add input** | unreferenced → `E506` | **every parent breaks** — a new unbound member input (`E609`) |
| **remove input** | `{input.x}` refs dangle → `E505` | every parent's connection to that sink stops resolving (`E607`) |
| **add output** | unreferenced → `E511` | none — outputs are consumed à la carte |
| **remove output** | `{output.x}` refs dangle → `E510` | parents using it as a source break (`E608`) |

So `add-output` is cross-file safe and the other three are not. A rename is a remove
plus an add and inherits the worse half.

### 7.3 Two directions, two answers — and refusing is the feature

The tool exists to enforce correctness. A refusal is therefore a **correct outcome**,
not a usability failure to be designed around, and the design should reach for it
wherever a valid order exists. Which direction the dependency runs decides which answer
is right:

**Downward — editing A, which depends on B.** A is a composite; B is a member it wires.
An edit to A that asks for something B does not offer (a socket that isn't declared, an
input that isn't there) has an ordering that works: **fix B, then A.** So the tool
refuses, and it must say so in those words — naming the file to edit and the command
that would do it, never just emitting a rule id:

```
error: cannot wire mailer.locale
  email_service.yamlet.yaml declares no input 'locale', so this connection
  cannot resolve (E607).

  B doesn't allow for this — edit it first:
      yamlet add-input email_service.yamlet.yaml locale
  then re-run this command.

nothing was written.
```

This is the single most important message in the whole feature. The user is holding a
half-formed intention about A and the tool knows exactly which other file blocks it;
that knowledge must land as an instruction, not as a diagnostic. `yamlet impact` (§7.1)
is what makes it cheap to produce.

The same shape applies to `remove-*`: deleting something a parent consumes has a valid
order (unwire the parent, then delete), so it **refuses** and names every consumer.

**Upward — editing B, which parents depend on.** This is the one case with no valid
order, and §7.4 is about it.

### 7.4 The one unavoidable transient

Widening a contract necessarily passes through an invalid tree: the input must exist on
B before any parent can wire it, and §7.3's refusal is precisely what forces that order.
There is no sequence that avoids the gap, and cascading the fix is impossible — the tool
cannot know what should feed the new input.

Refusing here would make widening a used contract permanently impossible, which is the
one outcome worse than a transient. So `add-input` **succeeds**, permits exactly the
findings it predicted (§5), and prints the resulting work list:

```
added input 'locale' to pdf_upload.yamlet.yaml

  this input is not yet referenced by any criterion (E506)
  2 composites now have an unbound member input (E609):
    pdf_archiver.yamlet.yaml            uploads.locale
    pdf_archiver_resilient.yamlet.yaml  uploads.locale
```

**This is what makes connection editing a prerequisite of contract editing, not a peer
of it.** That work list is only actionable if a single sink can be added to an existing
group — and today `add-connection` refuses a group that already exists (`author.ts:511`)
and refuses anything at all once a requirement exists (`:485`). Both must go first.

The transient is bounded and visible: every file it touches is named above, and
`yamlet verify` on the tree is what closes it. It is the same shape as any multi-file
refactor between two commits — acceptable *because* it is reported, and only because the
alternative is a contract that can never grow.

### 7.5 Parallel change — duplicates are legal, and they are the migration path

Not every change has to be a mutation. The safest way to alter behaviour that something
already depends on is to **add the replacement alongside the original, migrate, then
remove the original** — expand/contract, and yamlet supports it today without a single
new rule.

**Two requirements may describe the same capability, and the verifier must never
object.** There is no semantic-duplicate rule in `validate.ts`, and none should ever be
added: overlap is not mechanically detectable (it would need to compare prose meanings),
and more importantly a temporary duplicate is a *correct intermediate state*, not a
mistake. So the migration is:

1. `add-requirement` the new wording; `add-criterion` its criteria. New ids throughout —
   the old `RQ-2`/`AC-7` keep their ids and keep passing.
2. Re-project the tests. Both old and new scenarios exist; the consumer writes step
   definitions for the new ones while the old ones stay green.
3. `remove-requirement RQ-2` once the new path is live. Its scenarios disappear and the
   §8 change report names the step definitions now orphaned.

The tree is valid at every step, and nothing breaks in between. That is worth stating in
the skill explicitly, because the instinct — the agent's especially — is to revise in
place and leave a green tree that is quietly testing something else. **Revise in place
when the change is a clarification; run parallel change when the change alters
behaviour something else relies on.**

The same pattern at file scale is what `SPEC.md` §8 already prescribes for contracts:
when a contract must change shape, add a **second, total variant spec**, migrate parents
onto it one at a time, then delete the original. That sidesteps §7.4's transient
entirely — the old contract stays valid and fully wired the whole time — at the cost of
duplicated contract text. For a widening that parents will all want anyway, take the
transient; for a change that parents must adopt individually, take the variant.

Removal of a requirement is, notably, always cross-file safe: requirements are never
referenced from another spec (only contracts and members are), so `remove-requirement`
needs no impact refusal. Its only fallout is downstream step definitions, which §8
reports.

### 7.6 The phase-order guards are an artifact, and they should go

`init → add-component → add-connection → add-requirement` is one-way today because an
appender that cannot revisit an earlier block would otherwise **trap** the file in an
unfixable state — which is exactly why `add-requirement` refuses to run on an
under-wired composite (`author.ts:618`). Once blocks are addressable, no state is a
trap, and the guards are enforcing a construction order the *format* never required.

Replace all of them with the generalized guard (§5). This is the largest single
simplification in the effort: four bespoke phase checks collapse into one rule.

## 8. Closing the loop with the tests

`yamlet tests` force-regenerates its whole tree, so the `.feature` files self-heal after
an edit. **Step definitions do not.** They live in the consumer's own directory and bind
to step *text*, so revising a `shall` leaves the old definition behind as dead code, and
removing a criterion orphans its definitions silently.

The manifest is the right place to fix this, and it needs one field. `yamlet.tests/v1`
records per-scenario bindings but nothing about content, so "changed" is not currently
expressible. Add a per-criterion `digest` (a hash of the rendered scenario text), bump
to `yamlet.tests/v2`, and have the command read the pre-existing manifest *before* it
wipes the target so it can report:

```
  3 scenarios added · 1 changed (@AC-7) · 1 removed (@AC-4)
  changed and removed scenarios need their step definitions reviewed
```

Small, and it is the only mechanism that connects an edit to the code that edit
invalidates.

## 9. Command surface

Verbs mirror their targets; `set-*` for scalars, `revise-*` for whole blocks,
`remove-*` for deletion. Every one addresses by id, never by position.

```sh
# Discovery — read-only, and the entry point for editing (§11.1)
yamlet systems [DIR] [--system=SLUG] [--details] [--contracts]   # --details: SHIPPED

# Tier 0 / 1 — file-local
yamlet set-header      FILE [--topic t] [--summary s] [--description d] \
                            [--blast-radius r] [--front f] [--system s]
yamlet set-contract    FILE [--expose-name n] [--expose-intent i]
yamlet revise-requirement FILE --rq RQ-N --description "…"
yamlet revise-criterion   FILE --ac AC-N  <all of add-criterion's flags>
yamlet remove-requirement FILE --rq RQ-N
yamlet remove-criterion   FILE --ac AC-N
yamlet add-criterion      FILE --rq RQ-N [--after AC-N] …   # phase guard dropped

# Tier 2 — cross-file
yamlet impact          FILE [DIR]                  # read-only reverse index
yamlet add-input       FILE NAME  ·  remove-input  FILE NAME  ·  rename-input  FILE OLD NEW
yamlet add-output      FILE NAME  ·  remove-output FILE NAME  ·  rename-output FILE OLD NEW
yamlet set-connection  FILE GROUP SOCKET=SOURCE    # single sink, re-enterable
yamlet remove-component FILE ALIAS
```

`remove-requirement` removes its criteria with it — a requirement with no criteria is
`E108`, so the two cannot be separated.

## 10. What this costs the challenger gates

`yamlet-contract-challenger` and `yamlet-criteria-challenger` are both sold to the
model as *last chance before immutability*. That claim becomes false, and leaving it in
place would be worse than useless — a gate whose stated reason a reader can see through
is a gate that gets skipped.

Restate rather than remove. The gates keep their teeth for a different and now
*truthful* reason: a committed criterion has already been projected into Gherkin and
bound by step definitions, and a committed contract has already been wired by parent
composites. The cost of a mistake moved from *impossible to fix* to *expensive to fix,
across files you are not currently looking at* — which is still ample justification to
challenge before committing, and is the argument `yamlet impact` makes concrete.

## 11. Partitioning the author skill

Editing does **not** get its own skill. A separate `yamlet-editor` was the obvious first
answer and it is the wrong one: the two paths share almost everything that matters — the
challenger gates, the interrogation rhythm, the verify gate, the closing test
projection — so splitting would either duplicate them or need cross-skill delegation.
Discovery argues the same way: "I want to change a spec" and "I want to write a spec"
should not require the user to already know which door to knock on.

Instead **`yamlet-author` becomes a router**, and the long procedures move out of the
always-loaded body into files it reads on demand:

```
yamlet-author/
├── SKILL.md                 # router + the one hard rule + the shared closing gates
└── references/
    ├── creating.md          # setup steps 0–7: systems discovery → contract → init
    ├── composites.md        # C1–C5: members and wiring
    ├── editing.md           # locate → impact → propose → challenge → apply
    └── patterns.md          # the EARS table and the three {token} kinds
```

The skill's **first question becomes "new spec, or changing an existing one?"** — then it
reads the one procedure that applies.

### 11.1 Editing starts with finding the right file

"I want to adapt the e-mail sending spec" does not name a file, and a service routinely
has three. Guessing from a filename is exactly the failure the whole design is built to
prevent, so `references/editing.md` opens with a fixed locate step:

1. **`yamlet systems DIR`** — which systems exist? Map the user's words onto one slug.
2. **Ask which *behaviour* they mean**, in their terms, before touching anything.
3. **`yamlet systems DIR --system=SLUG --details`** — read each scope's summary and
   description and propose the best match, with the reason.
4. **Confirm the file with the user** before the first mutation. Never infer it.

Step 3 is why `--details` exists and is **shipped in this change**: `renderHumanSystems`
was collecting `summary` and discarding it, so the human listing showed only a topic —
and two scopes of one service routinely carry near-interchangeable topics ("Send plain
e-mail" / "Send e-mail with attachment"). Prose is what separates them:

```
e-mail-sending-service  (2 scopes)
  specs/email_service.yamlet.yaml        E-Mail sending service
    summary:     A generic e-mail sending service that exposes a contract for others
                 to send emails with a given content
    description: … connectivity to a single TLS SMTP server …
  specs/email_service_plain.yamlet.yaml  Attachment-free (plain) e-mail sending
    summary:     A scope of the e-mail sending service that sends a plain e-mail —
                 subject and content only, no attachment.
    description: … a separate, total scope rather than an optional attachment …
```

The default listing is unchanged; `--details` is additive, and `--contracts` composes
with it. Today's `SKILL.md` is ~300 lines and every session
pays for all of it, including the composite branch that most sessions never take; the
router shrinks the resident cost to the part in play. Splitting the file is also what
makes room for the editing procedure to be written properly rather than squeezed in.

**The tasklist is shared, and that is the point.** Adding and changing run the same
rhythm — draft with the user → challenge → commit through a `yamlet` command → verify →
re-project the tests. Only the *setup* differs (creation discovers systems and designs a
contract; editing locates a block and reads its impact), which is exactly the part the
reference files hold. The router picks a setup file; everything after it converges.

Three things must move in step with this, and one needs checking first:

- **`SKILL.md`'s "Scope of this version"** is the section that becomes false — append-only,
  one-way phase order, criteria-attach-to-newest-only. It goes; what replaces it is the
  §7.3 refusal contract, so the model knows a blocked edit names its own fix.
- **The `pi/` port needs the same partition**, hand-ported as always — plus one registered
  tool per new subcommand in `pi/extensions/yamlet/index.ts`, and its `write`/`edit` gate
  already covers the new commands since it keys on the `*.yamlet.yaml` path, not the verb.
- **Verify that pi resolves a skill-relative path.** Claude Code needs no wiring — the
  `.claude/skills/*` symlinks point at skill *directories*, so `references/` travels for
  free — and `pi/skills` is directory-based too, so the files ship. What is unconfirmed is
  whether a pi skill can reference its own bundled files once installed into `~/.pi/agent/`
  or `.pi/`, where the absolute path isn't knowable in advance. If it cannot, the pi build
  keeps a single flat `SKILL.md` and accepts the divergence; the two ports are already
  deliberately not shared source, so this would be one more honest split rather than a
  blocker. **Check this before committing to the layout.**

## 12. Rollout order

Each step is independently shippable and leaves the tree valid.

0. ✅ **Discovery — `yamlet systems --details`.** Read-only, additive, and a
   prerequisite for the editing skill's locate step (§11.1): you cannot edit the right
   spec until you can tell which one it is.
1. ✅ **`yamlet impact`** — read-only, no mutation semantics, immediately useful.
2. ✅ **Block addressing** (`src/blocks.ts`) — internal; no new commands. Blocks carry
   two extents, `end` (the header alone, what a revision replaces) and `outerEnd`
   (through the last nested criterion, what a removal cuts and an append anchors to).
   The generalized guard of §5 is **not** part of this step: nothing yet mutates an
   existing block, so the append allowlist still covers every command. It lands with
   step 4, which is the first to need it.
3. ✅ **Insert** — `add-criterion --rq` to any requirement, `--after` for `AC-Na`.
   Dropped the first wall with zero mutation risk; `tests/oracle-author/` did not move,
   confirming an append to the final requirement is still byte-identical.
4. **Tier 0 revise** — `set-header`, `set-contract`, `revise-requirement`,
   `revise-criterion`.
5. **Tier 1 remove** — `remove-requirement`, `remove-criterion`; manifest v2 digests and
   the change report land with this, since removal is the first operation that can
   orphan a step definition.
6. **Connection editing** — `set-connection`, `remove-component`, and the phase guards
   come out (§7.6).
7. **Contract editing** — `add-input` and friends, with the impact work list (§7.4).

Then, and only then, `rm` becomes a coherent conversation.

**Riding along, per step:** a frozen oracle for every new command's bytes (the appender
has one; the mutators must too), and both harness builds kept in step (§11). The skill
partition lands with step 3 — that is the moment "Scope of this version" becomes false —
and `references/editing.md` grows with steps 4 through 7 rather than being written once
up front.

`SPEC.md` needs two touch-ups but no format change: the *Authoring* open sub-decision
under Composition ("composites are hand-written; `author.sh` gains no connection
support") is already stale, and id holes plus the `AC-Na` suffix deserve an explicit
sentence now that they are load-bearing rather than incidental.

## 13. Open questions

- **Moving a criterion between requirements.** `revise-criterion --rq` would be a
  *move*, not a revision. Deliberately excluded above. It is probably wanted (splitting
  an over-stuffed requirement is the obvious use), but it interacts with ordering and
  with `--after`, and it should be designed on its own.
- **Should `front` be editable at all?** Flipping `internal → external` means the scope
  now owes `unwanted` coverage it does not have. The proposed-but-unbuilt `W`-class
  warning in SPEC.md would catch it; without that warning the flip is silent.
- **`system` rename.** Mechanically trivial, but it moves a scope's whole folder in the
  `yamlet tests` output layout (`<target>/<system>/<scope>.feature`) and therefore
  changes every feature path in the manifest. Wants the change report of §8 to say so.
- **Concurrent edits.** Every mutation is read–modify–write with no locking. Fine for a
  single interactive agent; worth a sentence before anything runs these in parallel.
- **Can a pi skill read its own bundled reference files?** §11's layout is now live on
  the Claude Code build — the `.claude/skills/*` symlinks point at skill directories, so
  `references/` travelled with no wiring at all. The pi answer is still unknown, and the
  fallback (a flat `SKILL.md` on pi only) should be a decision rather than a discovery.
  Settle it when the port is done.

*Settled by build:* **how wide `impact` searches.** It takes an optional `DIR` and
defaults to the working directory, matching `yamlet systems` rather than the target's own
directory — and it always reports how many specs it scanned, so a search too narrow to
see a consumer is visible instead of a false all-clear.

*Settled by review, kept for the record:* whether `remove-*` should refuse on a non-empty
impact set or succeed with a work list — it **refuses** (§7.3). Removal always has a
valid order, so the work list is reserved for the one case that does not (§7.4).
