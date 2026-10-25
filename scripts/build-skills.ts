#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * build-skills.ts — generates both harness builds of every skill from `skills/`.
 *
 * `skills/` is the one source. Each unit is `skills/<name>/SKILL.md` (plus an
 * optional `references/`), and renders to:
 *
 *   kind: skill → plugins/yamlet-skills/skills/<name>/  (Claude Code)
 *                 pi/skills/<name>/                     (pi)
 *   kind: agent → plugins/yamlet-skills/skills/<name>/  (a `context: fork` skill)
 *                 pi/agents/<name>.md                   (a pi-subagents agent)
 *
 * The generated files are committed — they are what the marketplace and
 * `pi install git:…` read, and what review sees. `--check` writes nothing and
 * fails if any of them differs from what its source renders to; CI runs it.
 * See `skills/README.md` for the directive syntax.
 *
 * Run:   deno run --allow-read --allow-write scripts/build-skills.ts
 * Check: deno run --allow-read scripts/build-skills.ts --check
 */

import { COMMANDS } from "./skills/commands.ts";
import {
  type Harness,
  parse,
  renderReference,
  renderSkill,
  SourceError,
} from "./skills/render.ts";

const SOURCE = "skills";
const CLAUDE = "plugins/yamlet-skills/skills";
const PI_SKILLS = "pi/skills";
const PI_AGENTS = "pi/agents";
const EXTENSION = "pi/extensions/yamlet/index.ts";
/** Every generated file carries this; a file with it and no source is an orphan. */
const MARK = "by scripts/build-skills.ts — edit the source";

const check = Deno.args.includes("--check");

function dirs(path: string): string[] {
  try {
    return [...Deno.readDirSync(path)].filter((e) => e.isDirectory).map((e) =>
      e.name
    ).sort();
  } catch {
    return [];
  }
}

function files(path: string, ext = ".md"): string[] {
  try {
    return [...Deno.readDirSync(path)]
      .filter((e) => e.isFile && e.name.endsWith(ext))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function read(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}

/** Every output path → its rendered content. */
const outputs = new Map<string, string>();
const problems: string[] = [];

for (const name of dirs(SOURCE)) {
  const sourcePath = `${SOURCE}/${name}/SKILL.md`;
  const text = read(sourcePath);
  if (text === undefined) continue;
  try {
    const src = parse(sourcePath, text);
    if (src.name !== name) {
      throw new SourceError(
        `${sourcePath}: name '${src.name}' does not match its directory`,
      );
    }
    const targets: [Harness, string][] = [
      ["claude", `${CLAUDE}/${name}/SKILL.md`],
      [
        "pi",
        src.kind === "agent"
          ? `${PI_AGENTS}/${name}.md`
          : `${PI_SKILLS}/${name}/SKILL.md`,
      ],
    ];
    for (const [harness, out] of targets) {
      outputs.set(out, renderSkill(src, sourcePath, harness));
    }
    const refs = files(`${SOURCE}/${name}/references`);
    if (refs.length > 0 && src.kind === "agent") {
      throw new SourceError(`${sourcePath}: an agent cannot carry references/`);
    }
    for (const ref of refs) {
      const refPath = `${SOURCE}/${name}/references/${ref}`;
      const refText = read(refPath)!;
      outputs.set(
        `${CLAUDE}/${name}/references/${ref}`,
        renderReference(refText, refPath, "claude"),
      );
      outputs.set(
        `${PI_SKILLS}/${name}/references/${ref}`,
        renderReference(refText, refPath, "pi"),
      );
    }
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    problems.push(
      e.message.startsWith(SOURCE) ? e.message : `${sourcePath}: ${e.message}`,
    );
  }
}

// The command table must name only tools and parameters the extension registers.
const extension = read(EXTENSION);
if (extension === undefined) {
  problems.push(`${EXTENSION}: not found — has the extension moved?`);
} else {
  // Each registration's text, by tool name. A `textTool("yamlet_…", …)` call
  // registers exactly `file` and `text`; `...target` spreads `id`/`list`/`position`.
  const registered = new Map<string, string>();
  for (const block of extension.split(/pi\.registerTool\(\{/).slice(1)) {
    const name = /name: "(yamlet_[a-z_]+)"/.exec(block)?.[1];
    if (name) registered.set(name, block);
  }
  for (const m of extension.matchAll(/textTool\(\s*"(yamlet_[a-z_]+)"/g)) {
    registered.set(m[1]!, "file: text:");
  }
  for (const [sub, command] of Object.entries(COMMANDS)) {
    const block = registered.get(command.tool);
    if (block === undefined) {
      problems.push(
        `scripts/skills/commands.ts: '${sub}' maps to ${command.tool}, which ${EXTENSION} does not register`,
      );
      continue;
    }
    const spread = block.includes("...target") ? "id: list: position:" : "";
    for (
      const arg of [...command.positionals, ...Object.values(command.flags)]
    ) {
      if (!new RegExp(`\\b${arg.param}:`).test(block + spread)) {
        problems.push(
          `scripts/skills/commands.ts: ${command.tool} has no parameter '${arg.param}' in ${EXTENSION}`,
        );
      }
    }
  }
}

// A generated file whose source is gone is an orphan.
const candidates = [
  ...dirs(CLAUDE).flatMap((d) => [
    `${CLAUDE}/${d}/SKILL.md`,
    ...files(`${CLAUDE}/${d}/references`).map((f) =>
      `${CLAUDE}/${d}/references/${f}`
    ),
  ]),
  ...dirs(PI_SKILLS).flatMap((d) => [
    `${PI_SKILLS}/${d}/SKILL.md`,
    ...files(`${PI_SKILLS}/${d}/references`).map((f) =>
      `${PI_SKILLS}/${d}/references/${f}`
    ),
  ]),
  ...files(PI_AGENTS).map((f) => `${PI_AGENTS}/${f}`),
];
for (const path of candidates) {
  if (outputs.has(path)) continue;
  if (read(path)?.includes(MARK)) {
    problems.push(
      `${path}: generated, but its source is gone — delete it or restore the source`,
    );
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`error: ${p}`);
  Deno.exit(1);
}

const stale: string[] = [];
for (
  const [path, content] of [...outputs].sort(([a], [b]) => a.localeCompare(b))
) {
  if (read(path) === content) continue;
  stale.push(path);
  if (!check) {
    Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(path, content);
  }
}

if (check) {
  if (stale.length > 0) {
    for (const path of stale) {
      console.error(`stale: ${path}`);
    }
    console.error(
      `\n${stale.length} generated file(s) differ from skills/. Edit the source, not the output, then run:\n` +
        "  deno run --allow-read --allow-write scripts/build-skills.ts",
    );
    Deno.exit(1);
  }
  console.log(`All ${outputs.size} generated skill files match skills/.`);
} else {
  for (const path of stale) console.log(`wrote ${path}`);
  console.log(`${outputs.size} generated, ${stale.length} changed.`);
}
