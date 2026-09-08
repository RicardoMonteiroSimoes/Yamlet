# The decision gate

Run this when a task needs a choice the user owns, or a `DECIDED:` record no longer fits. It ends with an accepted record linked into the spec.

## 1. Name the choice

State the criteria that force it and the options you see, one line each. Do not decide.

## 2. Write the record

Invoke **`yamlet-adr`** (`/yamlet-adr <records-dir> <the choice, with the criteria ids>`). It interviews the user and drives `yamlet adr`; it ends with `yamlet adr accept` and prints the record's path. Records live in one directory per system (`adr/` unless the repository already has one).

## 3. Link it into the spec

```
yamlet add-adr SPEC adr/ADR-0007-parser.adr.yaml --rq RQ-5
yamlet add-adr SPEC adr/ADR-0007-parser.adr.yaml --ac AC-8
```

`--rq` when the decision covers every criterion of the requirement, `--ac` when it is specific to one. Then `yamlet verify SPEC` must print `OK`.

## 4. Cover what it obliges

An accepted record's obligations (`ADR-nnnn#R-n`) are work: the tasks you write next must cover each one (`--covers ADR-0007#R-1`), or `yamlet verify` on the tech spec reports E716. The `DECIDED:` notice on a verdict lists them.

## 5. Superseding

A record that no longer holds is not edited. `yamlet-adr` writes the successor (`--assumes` the old id), then `yamlet adr supersede OLD --by NEW`, then `add-adr` the new record where the old one was linked.
