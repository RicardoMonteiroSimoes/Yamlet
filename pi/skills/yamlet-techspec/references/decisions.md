# The decision gate

Run this when a task needs a choice the user owns, or a `DECIDED:` record no longer fits. It ends with an accepted record linked into the spec.

## 1. Name the choice

State the criteria that force it and the options you see, one line each. Do not decide.

## 2. Write the record

Load the **`yamlet-adr`** skill and follow it, with the records directory and the choice (with the criteria ids) as its input. It interviews the user and drives the `yamlet_adr_*` tools; it ends with `yamlet_adr_accept` and reports the record's path. Records live in one directory per system (`adr/` unless the repository already has one).

It runs in this session, not in a subagent: it is an interview, and a pi subagent cannot ask the user anything.

## 3. Link it into the spec

```
yamlet_add_adr({ file: SPEC, adr: "adr/ADR-0007-parser.adr.yaml", rq: "RQ-5" })
yamlet_add_adr({ file: SPEC, adr: "adr/ADR-0007-parser.adr.yaml", ac: "AC-8" })
```

`rq` when the decision covers every criterion of the requirement, `ac` when it is specific to one — exactly one of the two. Then `yamlet_verify({ file: SPEC })` must report `OK`.

## 4. Cover what it obliges

An accepted record's obligations (`ADR-nnnn#R-n`) are work: the tasks you write next must cover each one (`covers: ["ADR-0007#R-1"]`), or `yamlet_verify` on the tech spec reports E716. The `DECIDED:` notice on a verdict lists them.

## 5. Superseding

A record that no longer holds is not edited. `yamlet-adr` writes the successor (`assumes` the old id), then `yamlet_adr_supersede({ file: OLD, by: "ADR-nnnn" })`, then `yamlet_add_adr` the new record where the old one was linked.
