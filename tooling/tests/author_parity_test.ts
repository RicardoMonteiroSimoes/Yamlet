// Author regression suite: the runners must reproduce, byte-for-byte, the frozen
// goldens under oracle-author/, allocate the same IDs, and reject the same inputs
// with the same exit codes. The sh+awk author.sh was retired, so the goldens are
// a snapshot of these runners' own output -- re-freeze them with
//   deno run --allow-read --allow-write tests/gen-author-oracle.ts
// The success sequences below mirror that generator; keep the two in lock-step.

import { assertEquals } from "jsr:@std/assert@1";
import {
  runAddComponent,
  runAddConnection,
  runAddCriterion,
  runAddRequirement,
  runInit,
} from "../src/author.ts";
import type { CmdResult } from "../src/types.ts";

const ORACLE = new URL("./oracle-author/", import.meta.url);

function run(cmd: string, file: string, args: string[]): CmdResult {
  const argv = [file, ...args];
  switch (cmd) {
    case "init":
      return runInit(argv);
    case "add-component":
      return runAddComponent(argv);
    case "add-connection":
      return runAddConnection(argv);
    case "add-requirement":
      return runAddRequirement(argv);
    case "add-criterion":
      return runAddCriterion(argv);
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

function golden(name: string): string {
  return Deno.readTextFileSync(new URL(name, ORACLE));
}

Deno.test("svc: no exposed contract, all EARS patterns, quoting edge cases", () => {
  const dir = Deno.makeTempDirSync();
  const F = `${dir}/svc.yamlet.yaml`;

  assertEquals(
    run("init", F, [
      "--system",
      "email-service",
      "--topic",
      "Email service",
      "--summary",
      "Sends email",
      "--description",
      "A service that sends email.",
      "--blast-radius",
      "high",
      "--front",
      "internal",
    ]).exitCode,
    0,
  );

  assertEquals(run("add-requirement", F, ["--description", "Connects to SMTP"]).stdout, "RQ-1\n");
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      "a login is attempted with valid credentials",
      "--shall",
      "authenticate over TLS",
    ]).stdout,
    "AC-1\n",
  );
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-1",
      "--pattern",
      "ubiquitous",
      "--shall",
      "log the actor identity",
    ])
      .stdout,
    "AC-2\n",
  );
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-1",
      "--pattern",
      "state",
      "--while",
      "the connection is established",
      "--shall",
      "send a keepalive every 30s",
    ]).exitCode,
    0,
  );
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-1",
      "--pattern",
      "optional",
      "--where",
      "the account is premium",
      "--shall",
      "expose funnel analytics",
    ]).exitCode,
    0,
  );
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-1",
      "--pattern",
      "unwanted",
      "--if",
      "the gateway returns a non-retriable error",
      "--shall",
      "mark the transaction failed",
    ]).exitCode,
    0,
  );
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-1",
      "--pattern",
      "complex",
      "--while",
      "{n} retries have been attempted",
      "--if",
      "an SMTP timeout occurs",
      "--shall",
      "schedule a retry after {delay_seconds} seconds",
      "--example",
      "n=0;delay_seconds=10",
      "--example",
      "n=1;delay_seconds=30",
    ]).stdout,
    "AC-6\n",
  );

  assertEquals(run("add-requirement", F, ["--description", "Handles bounces"]).stdout, "RQ-2\n");
  // AC ids are file-wide: RQ-1 already holds AC-1..AC-6, so this is AC-7.
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "ubiquitous",
      "--shall",
      "record every bounce event",
    ])
      .stdout,
    "AC-7\n",
  );
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "event",
      "--when",
      "the field is present",
      "--shall",
      'log the "reason" field',
    ]).exitCode,
    0,
  );
  assertEquals(
    run("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "event",
      "--when",
      "the field is present",
      "--shall",
      '"reason" must be recorded',
    ]).exitCode,
    0,
  );

  assertEquals(Deno.readTextFileSync(F), golden("svc.yamlet.yaml"));
});

Deno.test("notify: exposed contract with inputs, {input.X} refs and tabulation", () => {
  const dir = Deno.makeTempDirSync();
  const G = `${dir}/notify.yamlet.yaml`;

  assertEquals(
    run("init", G, [
      "--system",
      "notification-service",
      "--topic",
      "Notify",
      "--summary",
      "Delivers notifications",
      "--description",
      "Delivers to a user over a channel.",
      "--blast-radius",
      "medium",
      "--front",
      "external",
      "--expose-name",
      "notification-service",
      "--expose-intent",
      "deliver a notification over a channel",
      "--input",
      "user_id",
      "--input",
      "channel",
      "--input",
      "message",
    ]).exitCode,
    0,
  );
  assertEquals(
    run("add-requirement", G, ["--description", "Delivered over the requested channel"]).stdout,
    "RQ-1\n",
  );
  assertEquals(
    run("add-criterion", G, [
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      "a notification is requested for {input.user_id} over {input.channel}",
      "--shall",
      "deliver the {input.message} to the user",
    ]).exitCode,
    0,
  );
  assertEquals(
    run("add-criterion", G, [
      "--rq",
      "RQ-1",
      "--pattern",
      "unwanted",
      "--if",
      "a notification for {input.channel} exceeds {max_length} characters",
      "--shall",
      "reject the notification with a length error",
      "--example",
      "input.channel=sms;max_length=160",
      "--example",
      "input.channel=push;max_length=240",
    ]).exitCode,
    0,
  );

  assertEquals(Deno.readTextFileSync(G), golden("notify.yamlet.yaml"));
});

Deno.test("upload: inputs + outputs, {input.X} and {output.X} refs", () => {
  const dir = Deno.makeTempDirSync();
  const H = `${dir}/upload.yamlet.yaml`;

  assertEquals(
    run("init", H, [
      "--system",
      "pdf-upload",
      "--topic",
      "PDF upload",
      "--summary",
      "Verifies and returns a PDF",
      "--description",
      "Verifies a file is a PDF and returns it.",
      "--blast-radius",
      "medium",
      "--front",
      "external",
      "--expose-name",
      "pdf-upload",
      "--expose-intent",
      "verify a file is a well-formed PDF and return it",
      "--input",
      "file",
      "--input",
      "filename",
      "--output",
      "pdf_file",
    ]).exitCode,
    0,
  );
  assertEquals(
    run("add-requirement", H, ["--description", "Returns the validated PDF"]).stdout,
    "RQ-1\n",
  );
  assertEquals(
    run("add-criterion", H, [
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      "{input.file} named {input.filename} is uploaded",
      "--shall",
      "verify {input.file} is a well-formed PDF",
      "--shall",
      "return {output.pdf_file} to the caller",
    ]).exitCode,
    0,
  );

  assertEquals(Deno.readTextFileSync(H), golden("upload.yamlet.yaml"));
});

Deno.test("composite: components + connections reproduce the frozen golden", () => {
  const dir = Deno.makeTempDirSync();

  // Ephemeral members — only their exposed contracts matter to resolution.
  assertEquals(
    run("init", `${dir}/up.yamlet.yaml`, [
      "--system",
      "pdf-upload",
      "--topic",
      "PDF upload",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "medium",
      "--front",
      "external",
      "--expose-name",
      "pdf-upload",
      "--expose-intent",
      "verify a PDF and return it",
      "--input",
      "file",
      "--input",
      "filename",
      "--output",
      "pdf_file",
    ]).exitCode,
    0,
  );
  assertEquals(
    run("init", `${dir}/mail.yamlet.yaml`, [
      "--system",
      "email-service",
      "--topic",
      "Mail send",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "high",
      "--front",
      "internal",
      "--expose-name",
      "mail-send",
      "--expose-intent",
      "send an email",
      "--input",
      "recipient",
      "--input",
      "subject",
      "--input",
      "content",
      "--input",
      "attachment",
    ]).exitCode,
    0,
  );

  const C = `${dir}/composite.yamlet.yaml`;
  assertEquals(
    run("init", C, [
      "--system",
      "pdf-archiver",
      "--topic",
      "PDF archiver",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "medium",
      "--front",
      "internal",
      "--expose-name",
      "pdf-archiver",
      "--expose-intent",
      "archive a PDF by e-mail",
      "--input",
      "file",
      "--input",
      "filename",
      "--input",
      "archive_address",
      "--input",
      "subject",
      "--input",
      "content",
    ]).exitCode,
    0,
  );
  assertEquals(run("add-component", C, ["uploads", "up.yamlet.yaml"]).exitCode, 0);
  assertEquals(run("add-component", C, ["mailer", "mail.yamlet.yaml"]).exitCode, 0);
  assertEquals(
    run("add-connection", C, ["uploads", "file=input.file", "filename=input.filename"]).exitCode,
    0,
  );
  assertEquals(
    run("add-connection", C, [
      "mailer",
      "recipient=input.archive_address",
      "subject=input.subject",
      "content=input.content",
      "attachment=uploads.pdf_file",
    ]).exitCode,
    0,
  );

  assertEquals(Deno.readTextFileSync(C), golden("composite.yamlet.yaml"));
});

Deno.test("rejection paths: same inputs rejected with exit 2, nothing written", () => {
  const dir = Deno.makeTempDirSync();

  // A valid base file to reject against (its own sequence is covered above).
  const F = `${dir}/svc.yamlet.yaml`;
  run("init", F, [
    "--system",
    "email-service",
    "--topic",
    "Email service",
    "--summary",
    "Sends email",
    "--description",
    "A service that sends email.",
    "--blast-radius",
    "high",
    "--front",
    "internal",
  ]);
  run("add-requirement", F, ["--description", "Connects to SMTP"]);
  run("add-requirement", F, ["--description", "Handles bounces"]); // now RQ-2 is latest
  const afterSetup = Deno.readTextFileSync(F);

  const reject = (cmd: string, file: string, args: string[]) => run(cmd, file, args).exitCode;

  // init rejections
  assertEquals(
    reject("init", F, [
      "--system",
      "x",
      "--topic",
      "x",
      "--summary",
      "x",
      "--description",
      "x",
      "--blast-radius",
      "low",
      "--front",
      "internal",
    ]),
    2,
    "refuses to overwrite",
  );
  assertEquals(
    reject("init", `${dir}/b.yamlet.yaml`, [
      "--system",
      "x",
      "--topic",
      "x",
      "--summary",
      "x",
      "--description",
      "x",
      "--blast-radius",
      "huge",
      "--front",
      "internal",
    ]),
    2,
    "bad blast-radius",
  );
  assertEquals(
    reject("init", `${dir}/b.yaml`, [
      "--system",
      "x",
      "--topic",
      "x",
      "--summary",
      "x",
      "--description",
      "x",
      "--blast-radius",
      "low",
      "--front",
      "internal",
    ]),
    2,
    "wrong extension",
  );
  assertEquals(
    reject("init", `${dir}/e1.yamlet.yaml`, [
      "--system",
      "s",
      "--topic",
      "t",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "low",
      "--front",
      "internal",
      "--expose-intent",
      "x",
    ]),
    2,
    "--expose-intent without --expose-name",
  );
  assertEquals(
    reject("init", `${dir}/e2.yamlet.yaml`, [
      "--system",
      "s",
      "--topic",
      "t",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "low",
      "--front",
      "internal",
      "--input",
      "foo",
    ]),
    2,
    "--input without --expose-name",
  );
  assertEquals(
    reject("init", `${dir}/e3.yamlet.yaml`, [
      "--system",
      "s",
      "--topic",
      "t",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "low",
      "--front",
      "internal",
      "--expose-name",
      "svc",
      "--expose-intent",
      "i",
      "--input",
      "Bad-Name",
    ]),
    2,
    "invalid --input token",
  );
  assertEquals(
    reject("init", `${dir}/e4.yamlet.yaml`, [
      "--system",
      "s",
      "--topic",
      "t",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "low",
      "--front",
      "internal",
      "--output",
      "foo",
    ]),
    2,
    "--output without --expose-name",
  );
  assertEquals(
    reject("init", `${dir}/e5.yamlet.yaml`, [
      "--system",
      "s",
      "--topic",
      "t",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "low",
      "--front",
      "internal",
      "--expose-name",
      "svc",
      "--expose-intent",
      "i",
      "--output",
      "Bad-Out",
    ]),
    2,
    "invalid --output token",
  );
  assertEquals(
    reject("init", `${dir}/e6.yamlet.yaml`, [
      "--system",
      "s",
      "--topic",
      "t",
      "--summary",
      "s",
      "--description",
      "d",
      "--blast-radius",
      "low",
      "--front",
      "internal",
      "--expose-name",
      "svc",
      "--expose-intent",
      "i",
      "--output",
      "dup",
      "--output",
      "dup",
    ]),
    2,
    "duplicate --output token",
  );

  // add-criterion rejections against F (RQ-2 latest)
  assertEquals(
    reject("add-criterion", F, ["--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "x"]),
    2,
    "criteria on an earlier requirement",
  );
  assertEquals(
    reject("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "ubiquitous",
      "--when",
      "x",
      "--shall",
      "y",
    ]),
    2,
    "ubiquitous with a clause",
  );
  assertEquals(
    reject("add-criterion", F, ["--rq", "RQ-2", "--pattern", "event", "--shall", "y"]),
    2,
    "event without --when",
  );
  assertEquals(
    reject("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "complex",
      "--while",
      "w",
      "--when",
      "a",
      "--if",
      "b",
      "--shall",
      "y",
    ]),
    2,
    "complex with both --when and --if",
  );
  assertEquals(
    reject("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "complex",
      "--while",
      "w",
      "--shall",
      "y",
    ]),
    2,
    "complex with neither --when nor --if",
  );
  assertEquals(
    reject("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "event",
      "--when",
      "after {timeout} ms",
      "--shall",
      "retry",
    ]),
    2,
    "placeholders without examples",
  );
  assertEquals(
    reject("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "event",
      "--when",
      "after {timeout} ms",
      "--shall",
      "retry",
      "--example",
      "other=1",
    ]),
    2,
    "example row missing a binding",
  );
  assertEquals(
    reject("add-criterion", F, [
      "--rq",
      "RQ-2",
      "--pattern",
      "ubiquitous",
      "--shall",
      "x",
      "--example",
      "n=1",
    ]),
    2,
    "examples with no placeholders",
  );
  assertEquals(
    reject("add-criterion", F, ["--rq", "RQ-2", "--pattern", "magic", "--shall", "x"]),
    2,
    "unknown pattern",
  );
  assertEquals(
    reject("add-criterion", F, ["--rq", "RQ-2", "--pattern", "ubiquitous"]),
    2,
    "no --shall",
  );
  assertEquals(
    reject("add-requirement", `${dir}/nope.yamlet.yaml`, ["--description", "x"]),
    2,
    "add-requirement before init",
  );

  // Not one rejected command may have mutated F, and no reject file was created.
  assertEquals(Deno.readTextFileSync(F), afterSetup, "F unchanged by rejections");
  for (
    const leftover of [
      "b.yamlet.yaml",
      "b.yaml",
      "e1.yamlet.yaml",
      "e2.yamlet.yaml",
      "e3.yamlet.yaml",
      "e4.yamlet.yaml",
      "e5.yamlet.yaml",
      "e6.yamlet.yaml",
      "nope.yamlet.yaml",
    ]
  ) {
    let created = true;
    try {
      Deno.statSync(`${dir}/${leftover}`);
    } catch {
      created = false;
    }
    assertEquals(created, false, `${leftover} must not be created`);
  }
});

Deno.test("undeclared {input.X} / {output.X} references are rejected", () => {
  const dir = Deno.makeTempDirSync();
  const G = `${dir}/notify.yamlet.yaml`;
  run("init", G, [
    "--system",
    "notification-service",
    "--topic",
    "Notify",
    "--summary",
    "Delivers notifications",
    "--description",
    "Delivers to a user over a channel.",
    "--blast-radius",
    "medium",
    "--front",
    "external",
    "--expose-name",
    "notification-service",
    "--expose-intent",
    "deliver a notification over a channel",
    "--input",
    "user_id",
    "--input",
    "channel",
    "--input",
    "message",
  ]);
  run("add-requirement", G, ["--description", "Delivered over the requested channel"]);
  assertEquals(
    run("add-criterion", G, [
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      "triggered for {input.nope}",
      "--shall",
      "x",
    ]).exitCode,
    2,
    "undeclared input ref",
  );

  const H = `${dir}/upload.yamlet.yaml`;
  run("init", H, [
    "--system",
    "pdf-upload",
    "--topic",
    "PDF upload",
    "--summary",
    "Verifies and returns a PDF",
    "--description",
    "Verifies a file is a PDF and returns it.",
    "--blast-radius",
    "medium",
    "--front",
    "external",
    "--expose-name",
    "pdf-upload",
    "--expose-intent",
    "verify a file is a well-formed PDF and return it",
    "--input",
    "file",
    "--input",
    "filename",
    "--output",
    "pdf_file",
  ]);
  run("add-requirement", H, ["--description", "Returns the validated PDF"]);
  assertEquals(
    run("add-criterion", H, [
      "--rq",
      "RQ-1",
      "--pattern",
      "event",
      "--when",
      "triggered",
      "--shall",
      "return {output.nope}",
    ]).exitCode,
    2,
    "undeclared output ref",
  );
});
