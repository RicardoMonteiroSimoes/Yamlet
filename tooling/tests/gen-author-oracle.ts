// Regenerate the author parity oracle by driving the TS runners through their
// success sequences and freezing the resulting files as golden bytes.
//
// The sh+awk reference author.sh was retired, so these goldens are a frozen
// snapshot of the TS author's output; `author_parity_test.ts` guards against
// drift and mirrors the same sequences. Keep the two in lock-step.
//
//   deno run --allow-read --allow-write tests/gen-author-oracle.ts

import {
  runAddComponent,
  runAddConnection,
  runAddCriterion,
  runAddRequirement,
  runInit,
} from "../src/author.ts";
import type { CmdResult } from "../src/types.ts";

const OUT = new URL("./oracle-author/", import.meta.url).pathname;

function must(r: CmdResult): void {
  if (r.exitCode !== 0) {
    throw new Error(`author command failed (exit ${r.exitCode}): ${r.stderr}`);
  }
}

const rq = (file: string, args: string[]) => must(runAddRequirement([file, ...args]));
const ac = (file: string, args: string[]) => must(runAddCriterion([file, ...args]));

try {
  Deno.removeSync(OUT, { recursive: true });
} catch { /* first run */ }
Deno.mkdirSync(OUT, { recursive: true });

const work = Deno.makeTempDirSync();

// ── svc: no exposed contract, every EARS pattern, quoting edge cases ──
const svc = `${work}/svc.yamlet.yaml`;
must(runInit([
  svc,
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
]));
rq(svc, ["--description", "Connects to SMTP"]);
ac(svc, [
  "--rq",
  "RQ-1",
  "--pattern",
  "event",
  "--when",
  "a login is attempted with valid credentials",
  "--shall",
  "authenticate over TLS",
]);
ac(svc, ["--rq", "RQ-1", "--pattern", "ubiquitous", "--shall", "log the actor identity"]);
ac(svc, [
  "--rq",
  "RQ-1",
  "--pattern",
  "state",
  "--while",
  "the connection is established",
  "--shall",
  "send a keepalive every 30s",
]);
ac(svc, [
  "--rq",
  "RQ-1",
  "--pattern",
  "optional",
  "--where",
  "the account is premium",
  "--shall",
  "expose funnel analytics",
]);
ac(svc, [
  "--rq",
  "RQ-1",
  "--pattern",
  "unwanted",
  "--if",
  "the gateway returns a non-retriable error",
  "--shall",
  "mark the transaction failed",
]);
ac(svc, [
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
]);
rq(svc, ["--description", "Handles bounces"]);
ac(svc, ["--rq", "RQ-2", "--pattern", "ubiquitous", "--shall", "record every bounce event"]);
ac(svc, [
  "--rq",
  "RQ-2",
  "--pattern",
  "event",
  "--when",
  "the field is present",
  "--shall",
  'log the "reason" field',
]);
ac(svc, [
  "--rq",
  "RQ-2",
  "--pattern",
  "event",
  "--when",
  "the field is present",
  "--shall",
  '"reason" must be recorded',
]);
Deno.copyFileSync(svc, `${OUT}svc.yamlet.yaml`);

// ── notify: exposed contract with inputs, {input.X} refs, input tabulation ──
const notify = `${work}/notify.yamlet.yaml`;
must(runInit([
  notify,
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
]));
rq(notify, ["--description", "Delivered over the requested channel"]);
ac(notify, [
  "--rq",
  "RQ-1",
  "--pattern",
  "event",
  "--when",
  "a notification is requested for {input.user_id} over {input.channel}",
  "--shall",
  "deliver the {input.message} to the user",
]);
ac(notify, [
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
]);
Deno.copyFileSync(notify, `${OUT}notify.yamlet.yaml`);

// ── upload: inputs + outputs, {input.X} and {output.X} refs ──
const upload = `${work}/upload.yamlet.yaml`;
must(runInit([
  upload,
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
]));
rq(upload, ["--description", "Returns the validated PDF"]);
ac(upload, [
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
]);
Deno.copyFileSync(upload, `${OUT}upload.yamlet.yaml`);

// ── composite: components + connections (multi-service wiring) ──
// Members are ephemeral — only their exposed contracts matter to resolution; just
// the composite is frozen. Its bytes are path-independent (paths stored verbatim).
const cUp = `${work}/up.yamlet.yaml`;
must(runInit([
  cUp,
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
]));
const cMail = `${work}/mail.yamlet.yaml`;
must(runInit([
  cMail,
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
]));
const composite = `${work}/composite.yamlet.yaml`;
must(runInit([
  composite,
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
]));
must(runAddComponent([composite, "uploads", "up.yamlet.yaml"]));
must(runAddComponent([composite, "mailer", "mail.yamlet.yaml"]));
must(runAddConnection([composite, "uploads", "file=input.file", "filename=input.filename"]));
must(runAddConnection([
  composite,
  "mailer",
  "recipient=input.archive_address",
  "subject=input.subject",
  "content=input.content",
  "attachment=uploads.pdf_file",
]));
Deno.copyFileSync(composite, `${OUT}composite.yamlet.yaml`);

Deno.removeSync(work, { recursive: true });
console.log(`wrote author goldens to ${OUT}`);
for (const e of Deno.readDirSync(OUT)) console.log(`  ${e.name}`);
