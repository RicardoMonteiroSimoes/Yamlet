// smoke.test.mjs — exercises the yamlet extension against a mock `pi` handle.
//
// Covers the two places a silent bug would live: the argv each tool builds (a
// wrong flag order or a dropped repeatable would corrupt specs quietly) and the
// tool_call gate (a false negative would let a spec be hand-edited).
//
// Run it with the pi peer deps resolvable — from a directory where
// `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` and `typebox` are
// installed:
//
//     npx tsx pi/extensions/yamlet/smoke.test.mjs
//
// There is no CI for this yet: the repo's toolchain is Deno and this is the only
// node code in it. Run it by hand when you change the extension.

import ext from "./index.ts";

const HELP = `yamlet — verify and author yamlet specs

Commands:
  verify            check a spec against the rule catalog
  version           print the yamlet version
  systems           list existing systems grouped by their scope files
  graph             emit a DOT, JSON, or HTML graph model of a spec or a directory
  tests             project spec acceptance criteria into Gherkin feature files
  init              create a new spec, correct by construction
  add-component     declare a composite member (echoes its contract)
  add-connection    wire a composite member's inputs (or the composite outputs)
  add-requirement   append a requirement to a spec (prints RQ-N)
  add-criterion     append an acceptance criterion (prints AC-N)
`;

function makePi({ present = true, help = HELP, code = 0, stdout = "AC-3\n" } = {}) {
  const calls = [];
  const handlers = {};
  const tools = new Map();
  const pi = {
    on: (name, fn) => { handlers[name] = fn; },
    registerTool: (t) => tools.set(t.name, t),
    exec: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (!present) { const e = new Error("spawn yamlet ENOENT"); throw e; }
      if (args[0] === "--version") return { stdout: "yamlet 0.4.1\n", stderr: "", code: 0, killed: false };
      if (args[0] === "help") return { stdout: help, stderr: "", code: 0, killed: false };
      return { stdout, stderr: "", code, killed: false };
    },
  };
  ext(pi);
  return { pi, calls, handlers, tools };
}

const ctx = { cwd: "/repo", ui: { notify: (m, t) => notes.push([t, m]) } };
let notes = [];
const ok = (label, cond, extra="") => console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond?"":"  <<< "+extra}`);

// 1. tools registered
{
  const { tools } = makePi();
  const names = [...tools.keys()].sort();
  ok("9 tools registered", names.length === 9, names.join(","));
  console.log("      " + names.join(", "));
}

// 2. add_criterion argv (the gnarliest one)
{
  const { tools, calls } = makePi();
  await tools.get("yamlet_add_criterion").execute("id", {
    file: "specs/e.yamlet.yaml", rq: "RQ-1", pattern: "complex",
    while: ["{n} retries attempted", "the queue is draining"],
    if: "an SMTP timeout occurs",
    shall: ["schedule a retry with {delay_seconds}s backoff", "emit a metric"],
    examples: ["n=0;delay_seconds=10", "n=1;delay_seconds=30"],
  }, undefined, undefined, ctx);
  const argv = calls.at(-1);
  const expected = ["yamlet","add-criterion","specs/e.yamlet.yaml","--rq","RQ-1","--pattern","complex",
    "--if","an SMTP timeout occurs",
    "--while","{n} retries attempted","--while","the queue is draining",
    "--shall","schedule a retry with {delay_seconds}s backoff","--shall","emit a metric",
    "--example","n=0;delay_seconds=10","--example","n=1;delay_seconds=30"];
  ok("add_criterion argv", JSON.stringify(argv) === JSON.stringify(expected), JSON.stringify(argv));
}

// 3. init argv with contract
{
  const { tools, calls } = makePi();
  await tools.get("yamlet_init").execute("id", {
    file: "@specs/u.yamlet.yaml", system: "pdf", topic: "Upload", summary: "s", description: "d",
    blast_radius: "high", front: "external", expose_name: "pdf-upload", expose_intent: "verify",
    inputs: ["file","filename"], outputs: ["pdf_file"],
  }, undefined, undefined, ctx);
  const a = calls.at(-1);
  ok("init strips leading @", a[1] === "init" && a[2] === "specs/u.yamlet.yaml", JSON.stringify(a.slice(0,3)));
  ok("init repeats --input/--output",
     JSON.stringify(a.slice(-6)) === JSON.stringify(["--input","file","--input","filename","--output","pdf_file"]),
     JSON.stringify(a.slice(-6)));
}

// 4. add_connection wires
{
  const { tools, calls } = makePi();
  await tools.get("yamlet_add_connection").execute("id", {
    file: "c.yamlet.yaml", group: "uploads",
    wires: [{socket:"file",source:"input.file"},{socket:"attachment",source:"uploads.pdf_file"}],
  }, undefined, undefined, ctx);
  ok("add_connection SOCKET=SOURCE",
     JSON.stringify(calls.at(-1).slice(-2)) === JSON.stringify(["file=input.file","attachment=uploads.pdf_file"]),
     JSON.stringify(calls.at(-1)));
}

// 5. exit-code semantics
{
  const { tools } = makePi({ code: 1, stdout: "E401 vague shall\n" });
  const r = await tools.get("yamlet_verify").execute("id", { file: "a.yamlet.yaml" }, undefined, undefined, ctx);
  ok("verify exit 1 returns findings (not throw)", r.content[0].text.includes("E401"));
}
{
  const { tools } = makePi({ code: 2, stdout: "error: bad flag\n" });
  let threw = false;
  try { await tools.get("yamlet_add_requirement").execute("id", { file:"a.yamlet.yaml", description:"d" }, undefined, undefined, ctx); }
  catch (e) { threw = e.message.includes("bad flag"); }
  ok("exit 2 throws with the CLI message", threw);
}

// 6. missing binary
{
  notes = [];
  const { handlers, tools } = makePi({ present: false });
  await handlers.session_start({}, ctx);
  ok("session_start notifies on missing yamlet", notes.length === 1 && notes[0][0] === "error", JSON.stringify(notes));
  ok("notice names brew install", notes[0]?.[1].includes("brew install yamlet"));
  let msg = "";
  try { await tools.get("yamlet_systems").execute("id", {}, undefined, undefined, ctx); } catch (e) { msg = e.message; }
  ok("tool call also errors actionably", msg.includes("brew install yamlet"), msg.slice(0,60));
}

// 7. too-old CLI
{
  notes = [];
  const oldHelp = HELP.replace(/  add-connection.*\n/, "").replace(/  tests .*\n/, "");
  const { handlers } = makePi({ help: oldHelp });
  await handlers.session_start({}, ctx);
  ok("old CLI: names missing commands",
     notes[0]?.[1].includes("add-connection") && notes[0]?.[1].includes("tests"), JSON.stringify(notes));
}

// 8. healthy CLI stays quiet
{
  notes = [];
  const { handlers } = makePi();
  await handlers.session_start({}, ctx);
  ok("healthy CLI emits no notice", notes.length === 0, JSON.stringify(notes));
}

// 9. the gate
{
  const { handlers } = makePi();
  const gate = handlers.tool_call;
  const cases = [
    ["write spec",  { toolName:"write", input:{ path:"specs/a.yamlet.yaml" } }, true],
    ["edit spec @", { toolName:"edit",  input:{ path:"@specs/a.yamlet.yaml" } }, true],
    ["write other", { toolName:"write", input:{ path:"src/a.ts" } }, false],
    ["bash redirect", { toolName:"bash", input:{ command:"echo x > specs/a.yamlet.yaml" } }, true],
    ["bash tee",     { toolName:"bash", input:{ command:"cat f | tee specs/a.yamlet.yaml" } }, true],
    ["bash sed -i",  { toolName:"bash", input:{ command:"sed -i 's/a/b/' specs/a.yamlet.yaml" } }, true],
    ["bash yamlet",  { toolName:"bash", input:{ command:"yamlet verify specs/a.yamlet.yaml" } }, false],
    ["bash cat",     { toolName:"bash", input:{ command:"cat specs/a.yamlet.yaml" } }, false],
    ["bash unrelated",{ toolName:"bash", input:{ command:"echo hi > out.txt" } }, false],
  ];
  for (const [label, ev, shouldBlock] of cases) {
    const r = await gate(ev, ctx);
    ok(`gate: ${label} -> ${shouldBlock ? "blocked" : "allowed"}`, !!r?.block === shouldBlock, JSON.stringify(r));
  }
}
