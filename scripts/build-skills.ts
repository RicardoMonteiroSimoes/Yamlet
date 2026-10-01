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
 * It also keeps `.claude/skills/<name>` — tracked symlinks into the Claude Code
 * build — in step with the units, so this repo dogfoods every skill.
 *
 * Run:   deno run --allow-read --allow-write scripts/build-skills.ts
 * Check: deno run --allow-read scripts/build-skills.ts --check
 */

import { COMMANDS } from "./skills/commands.ts";
import {
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
/** Where this repo's own Claude Code sessions pick the skills up. */
const DEV_LINKS = ".claude/skills";
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

/** yamlet_guide topic → the file pi serves it from, relative to the pi package. */
const guides = new Map<string, string>();
/** The agents the extension must offer to install. */
const agents: string[] = [];
/** Every `{{ref TOPIC}}` a source uses, with where. */
const refsUsed: [string, string][] = [];

for (const name of dirs(SOURCE)) {
  const sourcePath = `${SOURCE}/${name}/SKILL.md`;
  let current = sourcePath;
  try {
    const text = read(sourcePath);
    if (text === undefined) throw new SourceError("no SKILL.md");
    const src = parse(sourcePath, text);
    {
      if (src.name !== name) {
        throw new SourceError(
          `name '${src.name}' does not match its directory`,
        );
      }
      const pi = src.kind === "agent"
        ? `${PI_AGENTS}/${name}.md`
        : `${PI_SKILLS}/${name}/SKILL.md`;
      outputs.set(
        `${CLAUDE}/${name}/SKILL.md`,
        renderSkill(src, sourcePath, "claude"),
      );
      outputs.set(pi, renderSkill(src, sourcePath, "pi"));
      if (src.kind === "agent") {
        agents.push(`${name}.md`);
        if (!src.guide) {
          throw new SourceError(
            "an agent needs `guide:` — the yamlet_guide topic pi serves its checklist under",
          );
        }
        guides.set(src.guide, `agents/${name}.md`);
      }
      for (const m of text.matchAll(/\{\{ref\s+(\S+?)\s*\}\}/g)) {
        refsUsed.push([m[1]!, sourcePath]);
      }
    }
    const refs = files(`${SOURCE}/${name}/references`);
    if (refs.length > 0 && src.kind === "agent") {
      throw new SourceError("an agent cannot carry references/");
    }
    for (const ref of refs) {
      current = `${SOURCE}/${name}/references/${ref}`;
      const refText = read(current)!;
      outputs.set(
        `${CLAUDE}/${name}/references/${ref}`,
        renderReference(refText, current, "claude"),
      );
      outputs.set(
        `${PI_SKILLS}/${name}/references/${ref}`,
        renderReference(refText, current, "pi"),
      );
      const topic = ref.replace(/\.md$/, "");
      if (guides.has(topic)) {
        throw new SourceError(
          `topic '${topic}' is already served from ${guides.get(topic)}`,
        );
      }
      guides.set(topic, `skills/${name}/references/${ref}`);
      for (const m of refText.matchAll(/\{\{ref\s+(\S+?)\s*\}\}/g)) {
        refsUsed.push([m[1]!, current]);
      }
    }
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    problems.push(`${current}: ${e.message}`);
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

// What the extension serves and installs must be exactly what skills/ generates.
if (extension !== undefined) {
  const table = /const GUIDE_FILES = \{([\s\S]*?)\} as const;/.exec(extension)
    ?.[1];
  const served = new Map<string, string>();
  for (
    const m of (table ?? "").matchAll(
      /"?([a-z-]+)"?: \["([^"]+)", "([^"]+)"\]/g,
    )
  ) {
    served.set(m[1]!, `${m[2]}/${m[3]}`);
  }
  if (served.size === 0) problems.push(`${EXTENSION}: cannot find GUIDE_FILES`);
  for (const [topic, path] of guides) {
    const at = served.get(topic);
    if (at === undefined) {
      problems.push(
        `${EXTENSION}: GUIDE_FILES has no '${topic}' (generated at pi/${path})`,
      );
    } else if (at !== path) {
      problems.push(
        `${EXTENSION}: GUIDE_FILES serves '${topic}' from ${at}, but skills/ generates pi/${path}`,
      );
    }
  }
  for (const topic of served.keys()) {
    if (!guides.has(topic)) {
      problems.push(
        `${EXTENSION}: GUIDE_FILES serves '${topic}', which skills/ no longer generates`,
      );
    }
  }
  const listed = /const AGENT_FILES = \[([\s\S]*?)\];/.exec(extension)?.[1] ??
    "";
  const installs = [...listed.matchAll(/"([^"]+\.md)"/g)].map((m) => m[1]!)
    .sort();
  const expected = [...agents].sort();
  if (expected.some((a) => !installs.includes(a))) {
    problems.push(
      `${EXTENSION}: AGENT_FILES lists ${
        installs.join(", ")
      }; skills/ generates agents ${expected.join(", ")}`,
    );
  }
  for (const [topic, where] of refsUsed) {
    if (!served.has(topic)) {
      problems.push(`${where}: {{ref ${topic}}} — no such yamlet_guide topic`);
    }
  }
}

// Every Markdown file in an output directory must be generated. One that
// carries the banner but has no source left is an orphan, and a rebuild deletes
// it; one without the banner is a hand edit in the wrong place.
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
const orphans: string[] = [];
for (const path of candidates) {
  if (outputs.has(path)) continue;
  const text = read(path);
  if (text === undefined) continue;
  if (!text.includes(MARK)) {
    problems.push(
      `${path}: not generated — its source belongs in ${SOURCE}/ (see ${SOURCE}/README.md)`,
    );
  } else orphans.push(path);
}

// The repo dogfoods the Claude Code build through tracked symlinks, so a fresh
// clone has every skill without a build step. One per unit, nothing else.
const want = new Map(
  dirs(SOURCE).map((name) => [name, `../../${CLAUDE}/${name}`]),
);
const links: { add: string[]; drop: string[] } = { add: [], drop: [] };
for (const [name, target] of want) {
  let at: string | undefined;
  try {
    at = Deno.readLinkSync(`${DEV_LINKS}/${name}`);
  } catch {
    at = undefined;
  }
  if (at !== target) links.add.push(name);
}
for (
  const entry of (() => {
    try {
      return [...Deno.readDirSync(DEV_LINKS)];
    } catch {
      return [];
    }
  })()
) {
  if (entry.isSymlink && !want.has(entry.name)) links.drop.push(entry.name);
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

for (const path of orphans) {
  stale.push(path);
  if (!check) Deno.removeSync(path);
}
for (const name of links.add) {
  stale.push(`${DEV_LINKS}/${name}`);
  if (!check) {
    Deno.mkdirSync(DEV_LINKS, { recursive: true });
    try {
      Deno.removeSync(`${DEV_LINKS}/${name}`);
    } catch {
      // not there yet
    }
    Deno.symlinkSync(want.get(name)!, `${DEV_LINKS}/${name}`);
  }
}
for (const name of links.drop) {
  stale.push(`${DEV_LINKS}/${name}`);
  if (!check) Deno.removeSync(`${DEV_LINKS}/${name}`);
}

if (check) {
  if (stale.length > 0) {
    for (const path of stale) {
      console.error(`stale: ${path}`);
    }
    console.error(
      `\n${stale.length} generated path(s) are out of step with skills/. Edit the source, not the output, then run:\n` +
        "  deno run --allow-read --allow-write scripts/build-skills.ts",
    );
    Deno.exit(1);
  }
  console.log(`All ${outputs.size} generated skill files match skills/.`);
} else {
  for (const path of stale) console.log(`updated ${path}`);
  console.log(`${outputs.size} generated, ${stale.length} changed.`);
}
