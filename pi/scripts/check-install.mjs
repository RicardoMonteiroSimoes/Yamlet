// check-install.mjs — prove the package installs the way pi will load it.
//
// `pi install` only records a source in settings; nothing tells you whether the
// manifest resolved to the resources you meant to ship until a session starts.
// This asks pi's own resource loader, against a pi home the caller has already
// installed into, and fails unless the extension and all three skills resolved.
//
//   PI_CODING_AGENT_DIR=/tmp/pihome node pi/scripts/check-install.mjs
//
// Run it from anywhere the pi peer packages resolve (the CI workflow installs
// them at the repo root with --no-save). It changes into a fresh empty directory
// first so a project-local `.pi/` cannot leak into the result.

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) {
	console.error("check-install: set PI_CODING_AGENT_DIR to the pi home you installed into");
	process.exit(2);
}

const cwd = mkdtempSync(join(tmpdir(), "yamlet-check-install-"));
process.chdir(cwd);

const loader = new DefaultResourceLoader({ cwd, agentDir });
await loader.reload();

// Both getters return a result object ({ extensions|skills, errors }) rather
// than a bare list; unwrap either shape so a future pi that returns the list
// directly still works.
const unwrap = (r, key) => (Array.isArray(r) ? r : r?.[key] ?? []);
const extResult = loader.getExtensions();
const skillResult = loader.getSkills();
const extensions = unwrap(extResult, "extensions").map((e) => e.path ?? String(e));
const skills = new Map(unwrap(skillResult, "skills").map((s) => [s.name, s.filePath ?? s.path ?? ""]));
for (const err of [...(extResult?.errors ?? []), ...(skillResult?.errors ?? [])]) {
	console.error(`loader error: ${err.error ?? err.message ?? JSON.stringify(err)}`);
}

const failures = [];
const ext = extensions.filter((p) => p.replace(/\\/g, "/").endsWith("/pi/extensions/yamlet/index.ts"));
if (ext.length !== 1) failures.push(`expected exactly one yamlet extension, got: ${JSON.stringify(extensions)}`);
for (const name of ["yamlet-author", "yamlet-verifier", "yamlet-tester"]) {
	if (!skills.has(name)) failures.push(`skill not resolved: ${name}`);
}
const strays = [...skills.keys()].filter((n) => !n.startsWith("yamlet-"));
if (strays.length) failures.push(`unexpected skills resolved: ${strays.join(", ")}`);

console.log(`pi home: ${agentDir}`);
console.log(`extension: ${ext[0] ?? "(none)"}`);
for (const [name, path] of skills) console.log(`skill: ${name} <- ${path}`);

if (failures.length) {
	for (const f of failures) console.error(`FAIL  ${f}`);
	process.exit(1);
}
console.log("ok: extension and all three skills resolve");
