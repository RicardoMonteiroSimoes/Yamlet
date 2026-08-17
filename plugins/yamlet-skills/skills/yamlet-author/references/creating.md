# Creating a new spec

The setup procedure for a spec that does not exist yet. Everything from the first requirement onward is in `SKILL.md`; this file ends at `init` (or, for a composite, hands off to `references/composites.md`).

## 0. Get the rough idea, and a home for it

If the user hasn't already, ask for a short write-down of what they want. The goal is an initial idea before proceeding. **PUSH BACK if it is already too vague** — worst case, tell them to rethink it before continuing.

Unless it's clear, ask which `directory` the file should go in. A dedicated folder for specs is best practice; push the user to create one if none exists.

## 1. Analyse the systems that already exist

Run `yamlet systems` or `yamlet systems DIR`. Your goal is to work out which existing system the new scope belongs to. **You never decide — you only recommend.**

- If they pick an existing system, reuse its **exact** `system:` slug at `init` — do not coin a variant (`e-mail-sending-service`, never `…-plain`).
- If it's genuinely new, agree on a fresh, generic slug.

Never skip this and never guess: silently minting a new system when the user meant a new scope of an existing one **fragments the service**. If the scan lists no systems, say so and proceed with a new one.

When several scopes of one service look similar, add `--details` to read each one's summary and description — topics alone rarely tell them apart.

## 2. Define the topic

A `topic` is a short, specific title for the scope. An `email-service` might hold several yamlet files, one per topic:

- Service connects to an SMTP server
- Send out emails using a template
- Send out emails with attachments

If a scope cannot be titled that briefly, you **have to** advise the user on how to split it. Too large a scope per yamlet defeats the point of the file.

## 3. Define the front

`front` is `internal` or `external`, and it marks a **trust boundary** — *who* calls this scope, not merely whether it is used.

- **`external`** — an **untrusted caller** crosses here: an end user *or* a third-party system whose input cannot be trusted.
- **`internal`** — the caller is another component we deploy and control.

A scope is exactly one of the two, never both. A `pdf-verifier` that only stores and checks files is `internal`; the `pdf-uploader` receiving untrusted uploads (from a human *or* a foreign system) is `external`.

An `external` scope therefore **owes extra `unwanted`/`if` acceptance-criteria** for malformed or hostile input — factor that in when you drill the requirements. This also serves as a scope-limiting factor, which makes it easier to judge whether the requirements are concise.

## 4. Converge on a summary

The `summary` is one short sentence of what the scope encompasses, free of technicalities. *"Accepts an uploaded file, verifies it is a well-formed PDF, and returns the validated PDF."* is a perfect example.

If a short summary is not possible, the scope is too broad and needs splitting further.

## 5. Categorise the blast-radius

`blast_radius` is the impact of this scope failing or being misconfigured: `low`, `medium` or `high`. A service handling authentication is `high` — everything else *might* become unusable if it fails. Use YOUR experience to interview the user and help them categorise it.

## 6. Discuss the exposed contract

A scope may expose a contract: named `input` and `output` attributes. These expose functionality and are what overarching systems wire together into more complex behaviour. Recommend generic options that make sense now *and* later — a `pdf-validator` should offer an `error` output, reusable to display a problem with the PDF.

**This is optional, and not required.** The contract is a *signature, not a schema*: a name, an intent, named inputs, and optional named outputs (the return half — `inputs → outputs`, like a function's parameters and its return value). No types.

The contract needs its own slug, `exposes.name`, which is **different from `system`** and unique per scope. The system `email-service` might have two topics whose contract names are `e-mail-plain-sending` and `e-mail-attachment-sending`, so a system referencing both can tell them apart.

**Two different name rules — do not conflate them.** `--expose-name` is a **slug** (`^[a-z0-9]+(-[a-z0-9]+)*$`, dash-separated, e.g. `pdf-upload`). Each `--input`/`--output` name is a **token** (`^[a-z][a-z0-9_]*$`, underscore-separated, e.g. `target_email`, `pdf_file`). Dashes in an input name, or underscores in the contract name, are rejected. `--input`/`--output` are repeatable and **require `--expose-name`** (which itself requires `--expose-intent`). An input and an output *may* share a name — uniqueness is per-list, not global.

Every declared input **must** be referenced by some criterion as `{input.NAME}`, and every declared output as `{output.NAME}`, before the spec is complete. So only declare inputs and outputs the behaviour actually uses.

**Get this right now.** Adding an input to a contract later is not yet supported, and even once it is, it will reach every composite that wires this spec — contracts are total, so a new input leaves every parent with an unbound member input. Run `yamlet impact FILE` on any spec you're unsure about to see what that would mean.

**Leaf or composite?** Decide here, because it changes what the contract *means*. A **leaf** does the work itself; its inputs and outputs are referenced by its own criteria. A **composite** does none of the work — it wires *existing* scopes together and its contract is a **boundary**: inputs it accepts from its caller and routes to members, outputs it surfaces from what members produce. If the behaviour is "take these inputs, run them through services X and Y, hand back their results," it's a composite. If unsure, it's a leaf.

## 7. Challenge the contract before you freeze it

The contract is set at `init` and cannot yet be changed afterwards — this is your last cheap chance to catch a mistake. Before running `init`, invoke the **`yamlet-contract-challenger`** skill (`/yamlet-contract-challenger <proposal>`) with a compact serialization of everything decided so far: the six header fields (system, topic, front, blast-radius, summary, description), the contract (expose-name, expose-intent, every input, every output), whether this is a **leaf** or **composite**, and the target directory. It returns `BLOCKERS` / `QUESTIONS` / `SUGGESTIONS` / `BOTTOM LINE`.

You do **not** obey it blindly and it does not decide — bring its findings back to the user in plain prose:

- Any **BLOCKER** (unused input, missing output, misclassified leaf/composite, fragmented system) must be resolved with the user *before* `init`.
- Put its **QUESTIONS** to the user and its **SUGGESTIONS** up for a decision.

Run this gate **once**, right before `init`. Do not skip it: a contract mistake is the most expensive error in the whole flow.

## 8. Create the spec

```
yamlet init specs/email.yamlet.yaml \
  --system email-sending-service --topic "E-Mail sending service" \
  --summary "A service that sends emails over a single TLS SMTP server" \
  --description "The generic e-mail sending service offers connectivity to a single TLS SMTP server for the platform." \
  --blast-radius high --front internal
```

With a contract:

```
yamlet init specs/upload.yamlet.yaml <the six flags above> \
  --expose-name pdf-upload \
  --expose-intent "verify a file is a well-formed PDF and return it" \
  --input file --input filename \
  --output pdf_file
```

If it fails, run `yamlet init --help`.

**Next:** if this is a composite, go to `references/composites.md` before adding any requirement. Otherwise return to `SKILL.md`'s working rhythm and start eliciting requirements.
