# Wiring a composite

A composite carries the same header and contract as a leaf, but instead of describing behaviour it declares **members** (`components:`) and **connections** between them.

Do all of this immediately after `init` and **before** the first `add-requirement` — the tool refuses components and connections once a requirement exists.

## C1. Discover the members you'll wire

```
yamlet systems DIR --contracts --details [--system=SLUG]
```

This lists existing scopes with their exposed contracts on labelled `in:`/`out:` lines. You wire *against those contracts*, so choose members whose inputs you can supply and whose outputs you need — and read `--details` alongside them, because a contract signature tells you the *shape* of a member but only its summary tells you what it actually does. Two scopes of one service often differ by a single socket (`…-plain` without the attachment); the prose is what says which one you want.

A member must already exist as a spec file **and** expose a contract — a contract-less scope cannot be wired.

## C2. Declare each member

```
yamlet add-component FILE ALIAS PATH
```

`ALIAS` is a token (`^[a-z][a-z0-9_]*$`) you coin as a local handle for this member in the wiring; `PATH` is the member's spec file, resolved relative to the composite. `input` and `output` are reserved and cannot be aliases.

It echoes the member's contract:

```
uploads: up.yamlet.yaml
  inputs  (must all be wired): file, filename
  outputs (consume as needed): pdf_file
```

Read that echo as the **obligation asymmetry**: every listed input MUST be wired or verify fails; outputs are consumed à la carte — wire the ones you need, leave the rest.

## C3. Wire each member

```
yamlet add-connection FILE GROUP SOCKET=SOURCE [SOCKET=SOURCE ...]
```

`GROUP` is either a **member alias** (to bind that member's inputs) or the reserved **`output`** (to feed the composite's own declared outputs). One call per group, and it must bind **all** of that group's sinks at once:

- an alias group must supply **every** input of that member — partial wiring is rejected, so gather them all first;
- the `output` group must feed **every** declared composite output.

**Direction is strict and asymmetric.** A `SOURCE` may only be:

- **`input.NAME`** — a boundary input this composite declared at `init`, or
- **`alias.SOCKET`** — an **output** of an already-declared member (an *assembly* wire).

A member input, or `output.NAME`, is a **sink and never a source** — the tool rejects it. There is **no acyclic rule**: a member output may feed another member whose own output loops back, so request/response cycles are wireable.

```
# route boundary inputs into a member
yamlet add-connection specs/archiver.yamlet.yaml uploads \
  file=input.file filename=input.filename

# assembly: feed a member's output into another member's input,
# alongside more boundary inputs
yamlet add-connection specs/archiver.yamlet.yaml mailer \
  recipient=input.archive_address subject=input.subject \
  content=input.content attachment=uploads.pdf_file

# surface a member's output as one of the composite's own outputs
yamlet add-connection specs/archiver.yamlet.yaml output \
  problem=uploads.error
```

**If a member doesn't offer what you need**, the tool refuses and names the member. That refusal is correct and the fix is to change *that* spec first — not to work around it here.

## C4. What "used" means on a composite

A composite's boundary **input** counts as used the moment it is a connection **source** (`input.X`) — you do **not** owe it an `{input.X}` acceptance-criterion the way a leaf does. A composite **output** is satisfied by the `output`-group connection that feeds it, not by an `{output.X}` reference.

So a composite whose whole job is wiring can be **complete with no requirements at all** — verify passes on `components` + `connections` alone. State this to the user rather than inventing filler requirements.

## C5. Requirements on a composite are optional

A composite *may* carry requirements — **emergent** obligations of the assembly that no single member owns (e.g. "the archive e-mail is sent only once the PDF has validated"). Add these after all wiring, exactly like a leaf's. Only add one when there is a genuine cross-member obligation; otherwise leave the composite requirement-less (C4).

A composite criterion may reference a **member socket** as `{alias.socket}` (e.g. `{uploads.pdf_file}`), in any clause or `--shall` just like `{input.X}`. It resolves against that member's contract — the socket must be a declared input **or** output of that member — and needs no `--example` table:

```
yamlet add-criterion specs/archiver.yamlet.yaml \
  --rq RQ-1 --pattern event \
  --when "{uploads.pdf_file} has been produced" \
  --shall "hand {uploads.pdf_file} to the mailer as the attachment"
```

**The completeness guard**: you cannot add a requirement until every member input is bound and every declared output is fed. An under-wired composite is refused — finish C3 first, because once a requirement exists you can no longer add components or connections.

**Next:** return to `SKILL.md`'s working rhythm.
