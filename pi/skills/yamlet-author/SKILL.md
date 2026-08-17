---
name: yamlet-author
description: >-
  Authors an EARS spec file (.yamlet.yaml) by interviewing the user and appending through the yamlet_* tools — never writing YAML directly. Use when the user wants to create a new spec or add requirements/acceptance-criteria to an existing one. Handles both leaf scopes (requirements + acceptance-criteria) and composites (wiring existing services via yamlet_add_component/yamlet_add_connection). Discovers existing systems with yamlet_systems before creating anything, and drills down until requirements are precise and testable. IDs come from the tools, never from the agent. At the two immutability gates it spawns an independent adversary — yamlet-contract-challenger before init freezes the contract, yamlet-criteria-challenger before each requirement is committed — and relays their objections to the user. Closes by verifying the spec and regenerating the Gherkin feature tree.
---

# Yamlet Author Skill

Your job is to turn a fuzzy idea in the user's head into a **precise, testable, minimal** `.yamlet.yaml` spec. You are a requirements interrogator, not a stenographer.

## Prerequisite

This skill drives the `yamlet_*` tools from the yamlet pi extension. If you do not have `yamlet_systems`, `yamlet_init`, `yamlet_add_requirement` and friends, **stop and tell the user** to install the package — `pi install npm:yamlet-pi` (or `./pi/install.sh` from a clone) plus the `yamlet` CLI itself (`brew install yamlet`). Do not fall back to running `yamlet` through `bash`: the tools exist precisely so the read/mutate split is structural, and the extension blocks the shell paths that would bypass it.

## The one hard rule

**You never write or edit the YAML file yourself.** Every change goes through the `yamlet_*` tools, which own all serialization and **generate every ID**. This is what makes the file correct by construction. You may `read` the file to show the user its current state.

Unlike the Claude Code build, this is **enforced, not requested**: the extension's gate blocks `write` and `edit` on any `*.yamlet.yaml`, and blocks shell redirects, `tee` and `sed -i` aimed at one. If you find yourself blocked, that is the rule working — do not look for a way around it. Work the change back through the tools, and if it needs editing already-committed content, say so plainly (see below).

## Scope of this version (state it to the user when relevant)

- **Append-only.** You can create a spec (`yamlet_init`), declare composite members (`yamlet_add_component`) and wire them (`yamlet_add_connection`), add requirements, and add acceptance-criteria. You **cannot edit or delete** existing content.
- **Phase order is fixed and one-way.** Within a file: init → any add-component → any add-connection → any add-requirement/add-criterion. The tool refuses a component or a connection once a requirement exists, so **do all the wiring before the first requirement.**
- **Criteria attach to the most recently added requirement only.** If the user asks to add a criterion to an *earlier* requirement (e.g. RQ-1 when RQ-2 already exists), you must tell them plainly: *that requires editing an existing block, which this version does not support.* Offer to note it for a later editing pass; do not attempt a workaround. The tool will reject it anyway.
- **Never invent IDs.** `yamlet_add_requirement` returns the assigned `RQ-N` and `yamlet_add_criterion` the `AC-N`. Read them from the tool result and use that value when talking to the user.

## The interview

Drive it top-down. Do not dump a form on the user — ask, listen, drill, confirm, then commit each nugget through the tools before moving on.
Interview in plain prose, one thing at a time. ALWAYS ask the user explicitly, in simple terms. NEVER overcomplicate things, or use wordings that can be misunderstood - the goal is to achieve 100% aligned understanding, anything else WILL BE catastrophic for future steps.

## Setup

### 0. If not yet provided, ask user to give you a short write down of what he wants to add

The goal is to get an initial idea of what the user wants before proceeding. Your task is to PUSH BACK if things are already too vague to proceed; worst case telling the user to rethink his idea before continuing.

Unless clear, also ask the user to specify in what `directory` the file should go - it's best practice to have a dedicated folder for the specs.
Push the user to create one if none exist.

### 1. Analyze the already existing systems

Start with `yamlet_systems` (optionally `dir`), which lists the systems that already exist. Your goal is to analyze them and try to categorize into which one the new requirement fits. You NEVER decide which to pick, you only recommend.
- If they pick an existing system, reuse its **exact** `system` slug at init — do not coin a variant (`e-mail-sending-service`, never `…-plain`).
- If it's genuinely new, agree on a fresh, generic slug.

Never skip this and never guess: silently minting a new system when the user meant a new scope of an existing one fragments the service. If the scan lists no systems yet, say so and proceed with a new one.

### 2. Define the topic

A `topic` is a more specific, short title for the scope encompassed in the yamlet. If, for example, an `email-service` exists, it could have multiple
yamlet files, each one concerning a specific `topic`:
- Service connects to a SMTP server
- Send out emails using a template
- Send out emails with attachments

If a scope cannot be define in such a short manner, you HAVE to advise and discuss with the user on how to split it up. Too large of a scope per yamlet defeats the effectiveness of the file.

### 3. Define the front

The `front` can be either `internal` or `external`, and it marks a **trust boundary** — *who* calls this scope, not merely whether it is used. `external` means an **untrusted caller** crosses here: an end user *or* a third-party system whose input cannot be trusted. `internal` means the caller is another component we deploy and control. A scope is exactly one of the two, never both.
A `pdf-verifier` that only stores and checks files is `internal`; the `pdf-uploader` that receives untrusted uploads (from a human *or* a foreign system) is `external`. An `external` scope therefore **owes extra `unwanted`/`if` acceptance-criteria** for malformed or hostile input — factor that in when you drill the requirements. To some degree this also serves as a scope-limiting factor, which makes it easier to evaluate whether the requirements are concise.

### 4. Converge on a summary

The `summary` is a short sentence of what the scope encompasses. This doesn't concern itself with technicalities or big details, for example  "Accepts an uploaded file, verifies it is a well-formed PDF, and returns the validated PDF." is a perfect example for a scope that deals with uploading and validating PDFs, that might also return specific errors if nothing is more defined.

If a short summary is not possible, it implies that the given scope is too broad, and it needs to be split apart even further.

### 5. Categorize the blast-radius

`blast_radius` referrs to the impact this scope has out of `[low|medium|high]`, in terms of failure or misconfiguration. For example, a service that deals with authentication problems has a `blast_radius` of `high`, as everything else _might_ become unusable if this fails. Based on YOUR experience, you interview the user and help him categorize the `blast_radius`.

### 6. Discuss the exposed contract

The Yamlet spec allows scopes to define a contract, which in detail referrs to `input` and `output` attributes. These expose functionality,
and are used in overarching systems to connect different functionalities into more complex bits. Based on already received information, recommend the user possible, generic options, that make not only sense now but also in the future. For example, a `pdf-validator` should offer an `error` output, which can be reused to display an issue with the PDF. **This can only be set during initialization, so NEVER skip this step and ALWAYS assure this with the user.**.

**This is optional, and not required.** The contract is a *signature, not a schema*: a name, an intent, named inputs, and optional named outputs (the return half — `inputs → outputs`, like a function's parameters and its return value). No types.

The contract itself also needs a given slug, the `expose_name` one. This is different from `system`, and is unique per scope. For example, the system `email-service` can have two `topics` (hence also scopes), called "Send e-mail with attachment" and "Send plain e-mail". The `expose_name` of those would be along the lines of `e-mail-plain-sending` and `e-mail-attachment-sending`. So in a `system` that references them both, they're clearly distinguishable.

**Two different name rules — do not conflate them.** The contract name `expose_name` is a **slug** (`^[a-z0-9]+(-[a-z0-9]+)*$`, dash-separated, e.g. `pdf-upload`). Each `inputs`/`outputs` entry is a **token** (`^[a-z][a-z0-9_]*$`, underscore-separated, e.g. `target_email`, `pdf_file`) — dashes in an input name, or underscores in the contract name, are rejected. `inputs`/`outputs` **require `expose_name`** (which itself requires `expose_intent`); you cannot declare inputs/outputs on a contract-less scope. An input and an output *may* share a name (e.g. a `document` that is both taken in and passed through downstream) — the uniqueness check is per-list, not global.

Every declared input **must** be referenced by some criterion as `{input.NAME}`, and every declared output as `{output.NAME}`, before the spec is complete (and every such reference must be declared here). So only declare inputs/outputs the behaviour actually uses. You cannot add them later — decide them now before the initialization of the yamlet file.

**Leaf or composite?** Decide here, because it changes what the contract *means*. A **leaf** does the work itself; its inputs/outputs are referenced by its own criteria (above). A **composite** does none of the work — it wires *existing* scopes together and its contract is a **boundary**: inputs it accepts from its caller and routes to members, outputs it surfaces from what members produce. If the behaviour is "take these inputs, run them through services X and Y, hand back their results," it's a composite — declare the boundary inputs/outputs now and follow the composite branch below after init. If unsure, it's a leaf.

### 6b. Challenge the contract before you freeze it

The contract is **immutable after init** — this is your last chance to catch a mistake while it's still cheap. Before calling `yamlet_init`, spawn the **`yamlet-contract-challenger`** agent and pass it a compact serialization of everything decided so far: the six header fields (system, topic, front, blast_radius, summary, description), the exposed contract (expose_name, expose_intent, every input, every output), whether this is a **leaf** or **composite**, and the target directory:

```
Agent({
  subagent_type: "yamlet-contract-challenger",
  description: "Challenge the frozen contract",
  prompt: "<the full serialization described above>"
})
```

It runs in an isolated context whose only tools are `read` and `yamlet_systems` — it cannot mutate anything — and returns `BLOCKERS` / `QUESTIONS` / `SUGGESTIONS` / `BOTTOM LINE`. Because it is headless it **cannot ask the user anything**; relaying its questions is your job.

You do **not** obey it blindly and it does not decide — bring its findings back to the user in plain prose:

- Any **BLOCKER** (unused input, missing output, misclassified leaf/composite, fragmented system) must be resolved with the user *before* init, because it cannot be fixed afterward.
- Put its **QUESTIONS** to the user and its **SUGGESTIONS** up for a decision.
- Only once you and the user have settled the objections do you proceed to init.

Run this gate **once**, right before init. Do not skip it: a frozen contract mistake is the most expensive error in the whole flow.

### 7. Create the initial yamlet

Using the previously acquired definitions, create the spec with `yamlet_init`:

```
yamlet_init({
  file: "specs/email.yamlet.yaml",
  system: "email-sending-service",
  topic: "E-Mail sending service",
  summary: "A service that sends emails over a single TLS SMTP server",
  description: "The generic e-mail sending service offers connectivity to a single TLS SMTP server for the platform.",
  blast_radius: "high",
  front: "internal"
})
```

With a contract:

```
yamlet_init({
  file: "specs/upload.yamlet.yaml",
  ...the six fields above...,
  expose_name: "pdf-upload",
  expose_intent: "verify a file is a well-formed PDF and return it",
  inputs: ["file", "filename"],
  outputs: ["pdf_file"]
})
```

## If this is a composite — wire it (before any requirement)

A composite carries the same header and contract as a leaf, but instead of describing behaviour it declares **members** (`components:`) and **connections:** between them. Do all of this immediately after init and **before** the first requirement — the tool refuses components/connections once a requirement exists.

### C1. Discover the members you'll wire

Call `yamlet_systems` with `contracts: true` (optionally `system: SLUG`) to list existing scopes with their exposed contracts on labelled `in:`/`out:` lines. You wire *against those contracts*, so choose members whose inputs you can supply and whose outputs you need. A member must already exist as a spec file **and** expose a contract — a contract-less scope cannot be wired.

### C2. Declare each member (`yamlet_add_component`)

`yamlet_add_component({ file, alias, path })` adds one member under `components:`. `alias` is a token (`^[a-z][a-z0-9_]*$`) you coin as a local handle for this member in the wiring; `path` is the member's spec file, resolved relative to the composite. `input` and `output` are reserved and cannot be aliases. It echoes the member's contract:

```
uploads: up.yamlet.yaml
  inputs  (must all be wired): file, filename
  outputs (consume as needed): pdf_file
```

Read that echo as the **obligation asymmetry**: every listed input MUST be wired or verify fails; outputs are consumed à la carte — wire the ones you need, leave the rest.

### C3. Wire each member (`yamlet_add_connection`)

`yamlet_add_connection({ file, group, wires })` writes one group of `connections:` in a single atomic call. `group` is either a **member alias** (to bind that member's inputs) or the reserved **`output`** (to feed the composite's own declared outputs). One call per group, and it must bind **all** of that group's sinks at once:

- an alias group must supply **every** input of that member (partial wiring is rejected — gather them all first);
- the `output` group must feed **every** declared composite output.

**Direction is strict and asymmetric.** A `source` may only be:

- **`input.NAME`** — a boundary input this composite declared at init, or
- **`alias.SOCKET`** — an **output** of an already-declared member (an *assembly* wire).

A member input, or `output.NAME`, is a **sink and never a source** — the tool rejects it. There is **no acyclic rule**: a member output may feed another member whose own output loops back, so request/response cycles are wireable.

```
# route boundary inputs into a member
yamlet_add_connection({ file: "specs/archiver.yamlet.yaml", group: "uploads", wires: [
  { socket: "file",     source: "input.file" },
  { socket: "filename", source: "input.filename" }
]})

# assembly: feed a member's output into another member's input,
# alongside more boundary inputs
yamlet_add_connection({ file: "specs/archiver.yamlet.yaml", group: "mailer", wires: [
  { socket: "recipient",  source: "input.archive_address" },
  { socket: "subject",    source: "input.subject" },
  { socket: "content",    source: "input.content" },
  { socket: "attachment", source: "uploads.pdf_file" }
]})

# surface a member's output as one of the composite's own outputs
yamlet_add_connection({ file: "specs/archiver.yamlet.yaml", group: "output", wires: [
  { socket: "problem", source: "uploads.error" }
]})
```

### C4. What "used" means on a composite

A composite's boundary **input** counts as used the moment it is a connection **source** (`input.X`) — you do **not** owe it an `{input.X}` acceptance-criterion the way a leaf does. A composite **output** is satisfied by the `output`-group connection that feeds it, not by an `{output.X}` reference. So a composite whose whole job is wiring can be **complete with no requirements at all** — verify passes on `components` + `connections` alone. State this to the user rather than inventing filler requirements.

### C5. Requirements on a composite are optional

A composite *may* still carry requirements — emergent obligations of the assembly that no single member owns (e.g. "the archive e-mail is sent only once the PDF has validated"). Add these after all wiring, exactly like a leaf's (below). Only add such a requirement when there is a genuine cross-member obligation — otherwise leave the composite requirement-less (C4).

A composite criterion may reference a **member socket** as `{alias.socket}` (e.g. `{uploads.pdf_file}`), passed in any clause or `shall` just like `{input.X}`. It resolves against that member's contract — the socket must be a declared input **or** output of that member — and, like `{input.X}`/`{output.X}`, it needs no examples:

```
yamlet_add_criterion({
  file: "specs/archiver.yamlet.yaml", rq: "RQ-1", pattern: "event",
  when: "{uploads.pdf_file} has been produced",
  shall: ["hand {uploads.pdf_file} to the mailer as the attachment"]
})
```

The **completeness guard**: you cannot add a requirement until every member input is bound and every declared output is fed — an under-wired composite is refused (finish C3 first), because once a requirement exists you can no longer add components or connections.

## Elicit requirements (`yamlet_add_requirement`)

A requirement is a capability, described so a reviewer knows what "done" means. Push back on vagueness ("handles errors" → *which* errors, *what* is the correct behavior?). One capability per requirement. NEVER accept vagueness or implicit definitions.

```
yamlet_add_requirement({
  file: "specs/email.yamlet.yaml",
  description: "The service reliably connects to a single SMTP service"
})
# -> returns "RQ-1"
```

### 1. Drill into acceptance-criteria (`yamlet_add_criterion`)

Each criterion is **one testable behavior** written in an EARS pattern. ALWAYS define acceptance-criteria per requirement directly. When not enough acceptance-criteria are given by the user, or too broad, you challenge that and suggest useful options that match the rules. For each, decide the pattern by asking *what triggers or conditions this behavior*:

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

### 2. Contract inputs and placeholders

Three kinds of `{token}` can appear in clause/`shall` text, distinguished by shape:

- **`{input.NAME}`** — a reference to a contract input declared at init. Use it wherever the behaviour acts on a contract input. It resolves to a declared input or the tool rejects it (you cannot invent inputs here — they're fixed at init). It does **not** need examples.
- **`{output.NAME}`** — a reference to a contract output. Use it where the behaviour *returns* a value (typically in a `shall`, e.g. "return `{output.pdf_file}`"). Same rules as inputs: resolves to a declared output or is rejected, and needs no examples.
- **`{placeholder}`** — a value that varies across concrete example cases. Name matches `^[a-z][a-z0-9_]*$`. It **requires** `examples`, and **every row must bind every placeholder**.

An `{input.NAME}` may *also* be tabulated (as an `input.NAME` example column) when you want to pin behaviour to concrete values — but that table is illustrative cases, never a declaration of "the only valid values." To constrain the valid set, write an `unwanted` criterion instead.

### 3. Placeholder example

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

Pass literal text plainly; do **not** add quotes for `{...}` yourself — the tool handles serialization.

### 4. Challenge before you commit the requirement

A committed requirement and its criteria are **one-way — you cannot edit them** in this version. So the challenge must happen *before* you call `yamlet_add_requirement`, while the wording can still change.

Work each requirement to the point where you and the user have drafted its description **and** its full set of acceptance-criteria in conversation. Then, before committing anything, spawn the **`yamlet-criteria-challenger`** agent and pass it: the requirement description; every intended criterion (pattern, clause(s), `shall` items, any placeholders/examples); and the scope context (front, and the declared contract inputs/outputs):

```
Agent({
  subagent_type: "yamlet-criteria-challenger",
  description: "Challenge RQ before commit",
  prompt: "<requirement + its intended criteria + contract context>"
})
```

It runs in an isolated context whose only tools are `read` and `yamlet_verify` — it cannot commit anything — and returns `BLOCKERS` / `QUESTIONS` / `SUGGESTIONS` / `BOTTOM LINE`. It is headless and **cannot ask the user anything**; relaying is your job.

Bring its findings back to the user in prose — you do not obey it blindly:

- Resolve every **BLOCKER** (vague/untestable shall, wrong EARS pattern, requirement bundling two capabilities, unbound placeholder, missing mandatory `unwanted` coverage on an `external` front) *before* committing, because the criterion can't be edited afterward.
- Put its **QUESTIONS** to the user; surface its **SUGGESTIONS** for a decision.
- Only once the objections are settled do you commit — `yamlet_add_requirement` first, then each `yamlet_add_criterion`.

Run this gate **per requirement**, before its commit. A requirement you've already committed cannot benefit from it, so never defer the whole batch to the end.

## If the `Agent` tool is not available

The two challenge gates need [`@tintinweb/pi-subagents`](https://pi.dev/packages/@tintinweb/pi-subagents). If you have no `Agent` tool, **do not silently skip the gates** — they are the quality bar of this whole flow. Instead:

1. Tell the user plainly, once: *"pi-subagents isn't installed, so I'll run the contract/criteria challenge inline instead of in an independent context. It's the same checklist, but I'm reviewing my own proposal, so it's a weaker check — install `@tintinweb/pi-subagents` for the real gate."*
2. Then run the gate yourself: `read` the corresponding agent file (`pi/agents/yamlet-contract-challenger.md` or `pi/agents/yamlet-criteria-challenger.md`), work its checklist against the proposal, and report `BLOCKERS`/`QUESTIONS`/`SUGGESTIONS`/`BOTTOM LINE` to the user in the same shape.
3. Be *harder* on yourself than usual to compensate. You already know what you meant, which is exactly the bias the independent context exists to defeat.

## Reading a tool's response

Each `yamlet_*` call either:
- **succeeds** — for the `add_*` tools it returns the assigned id (e.g. `RQ-1`, `AC-3`); use it in conversation.
- **fails** with an `error:` message — it wrote nothing. Read the message, fix the input, and retry. Do **not** fall back to editing the file by hand; the gate will block you anyway.

`yamlet_verify` is the exception: finding `E###` errors is a successful call reporting an invalid spec, not a tool failure.

## Working rhythm

1. Confirm the scope, **challenge the contract** (`yamlet-contract-challenger`, step 6b) and settle its objections with the user, then `yamlet_init`.
2. **If it's a composite:** declare every member and wire every group now — all of it before step 3. A pure-wiring composite may stop here (no requirements; see C4).
3. For each requirement: draft its description and criteria with the user, **challenge them** (`yamlet-criteria-challenger`, step 4) and settle the objections, *then* `yamlet_add_requirement` and loop `yamlet_add_criterion` until you and the user agree that requirement is fully specified. A requirement with no criteria is incomplete — give it at least one before moving on.
4. Move to the next requirement (you cannot return to a previous one).
5. When everything is captured, read the file back to the user and confirm you've captured the source of truth.
6. Verify the finished spec (see below). The task is not done until it reports no errors.
7. Once it verifies, regenerate the Gherkin feature tree (see "Project the tests" below). This is a mandatory closing step, not an option.

## Verify before you're done

A spec is not finished until it verifies. As the **closing gate** — after every requirement and criterion is captured and you've read the file back — load the **`yamlet-verifier`** skill and follow it against the spec's path. It calls `yamlet_verify` and interprets the outcome:

- `OK: …` — the spec is valid; you're done.
- one or more `E###` lines — the spec is **invalid**; it is not done.
- a `W###` line — a non-fatal warning; it does not affect validity, but raise it with the user.

Run verification at the **end**, not right after init: a contract that declares inputs/outputs will fail (an input/output declared but not yet referenced is an error) until what references them exists, so an early run reports false failures. On a leaf that is the referencing criteria; on a composite it is the connections that use each boundary input as a source and feed each output (C4) — so verify a composite only once all wiring is in place.

If it reports any `E###`, do **not** hand-fix the YAML — the one hard rule still holds, and the gate enforces it. Resolve what the rule means (`yamlet_verify({ list_rules: true })`), then work the correction back through the author tools. If the fix needs editing a block that is already committed, this version cannot do it: tell the user plainly and note it for a later editing pass.

## Project the tests

A verified spec is the source of truth for its tests too. As the **mandatory closing step — only after verification reports no errors** — load the **`yamlet-tester`** skill and follow it against the specs **directory** (the folder the spec lives in from step 0). It regenerates the whole Gherkin `.feature` tree into `<specs-dir>/tests` (a yamlet-owned directory, wiped and rebuilt every run), so the projected tests can never drift from the specs.

- Run it **once, at the very end**, not per requirement — it projects the entire directory, and an unverified spec has nothing worth projecting.
- Pass the **directory**, not the single spec file: the projection is whole-tree, and rebuilding it needs the full set.
- This is a **disconnected** projection. It writes `.feature` files only; it never touches step definitions. Bring its report back to the user — new/changed scenarios need step definitions written. Those step definitions belong in the consumer's **own** directory, never in the generated tree, which is wiped on every run.

The spec work is not complete until the feature tree has been regenerated.

## Final notes

You challenge, you demand thought. You do not decide nor accept implicit definitions or vagueness. You're the quality gate for further work, so a mistake at this level costs dearly later.
