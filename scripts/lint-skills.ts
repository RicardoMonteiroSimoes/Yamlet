#!/usr/bin/env -S deno run --allow-read --allow-env
/**
 * lint-skills.ts — budget guard for the skills product.
 *
 * A skill's `description` is the only part of it that is ALWAYS in context, in
 * every session, whether or not the skill is ever used. Both harnesses cap it,
 * and both caps are silent — you do not find out you are over by reading the
 * file:
 *
 *   - pi caps a description at 1024 chars and emits a validation warning past it.
 *   - Claude Code truncates `description` + `when_to_use` at 1536 chars in the
 *     skill listing, mid-sentence, with no warning at all. Text past the cut is
 *     written but never read.
 *
 * We hold every skill to the tighter of the two (1024) so one description can
 * serve both ports, which is what `CLAUDE.md` asks for.
 *
 * The body cap is repo policy, not a harness limit. Claude Code's guidance is
 * "keep SKILL.md under 500 lines", but this repo ships the same skills twice and
 * the author skill has already grown from 9.5 KB back toward 10 KB once after
 * being split down from 27 KB. 200 lines is a budget that notices that drift
 * while leaving ample room; detail belongs in `references/`, which loads on
 * demand and costs nothing until it is read.
 *
 * Run: deno run --allow-read --allow-env scripts/lint-skills.ts
 */

/** pi's hard cap on `description`; the tighter of the two harnesses. */
const DESCRIPTION_MAX = 1024;
/** Claude Code truncates `description` + `when_to_use` here, silently. */
const LISTING_MAX = 1536;
/** Agent Skills spec cap on `name`, enforced by both harnesses. */
const NAME_MAX = 64;
/** Repo policy: lines of markdown after the frontmatter. */
const BODY_MAX_LINES = 200;
/** Report a file at or past this fraction of a cap before it fails. */
const WARN_AT = 0.9;

/** Directories whose markdown files carry skill/agent frontmatter. */
const SOURCES = [
  { dir: "plugins/yamlet-skills/skills", nested: true },
  { dir: "pi/skills", nested: true },
  { dir: "pi/agents", nested: false },
];

interface Finding {
  file: string;
  line: number;
  message: string;
}

/** A frontmatter value plus the line its key sits on, for annotations. */
interface Scalar {
  value: string;
  line: number;
}

/**
 * Read the scalar frontmatter keys we budget.
 *
 * Deliberately not a YAML parser: it understands exactly the scalar styles these
 * files use — plain, quoted, folded (`>`/`>-`) and literal (`|`/`|-`) — and
 * ignores everything else. A folded scalar is joined with single spaces, which
 * is the string the harness actually measures.
 */
function readFrontmatter(
  text: string,
): { keys: Map<string, Scalar>; bodyLine: number } | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const keys = new Map<string, Scalar>();
  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? "";
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(raw);
    if (!match) continue;
    const [, key, rest = ""] = match;
    if (key === undefined) continue;
    const keyLine = i + 1;
    const head = rest.trim();

    // Block scalar: gather the indented lines that follow.
    if (/^[>|][+-]?$/.test(head)) {
      const folded = head.startsWith(">");
      const parts: string[] = [];
      for (let j = i + 1; j < end; j++) {
        const line = lines[j] ?? "";
        if (line.trim() !== "" && !/^[ \t]/.test(line)) break;
        parts.push(line.trim());
        i = j;
      }
      const value = folded
        ? parts.filter((p) => p !== "").join(" ")
        : parts.join("\n").trim();
      // Point the annotation at the key, not at the last folded line.
      keys.set(key, { value, line: keyLine });
      continue;
    }

    keys.set(key, { value: unquote(head), line: keyLine });
  }

  return { keys, bodyLine: end + 2 };
}

/** Strip one layer of YAML quoting, leaving plain scalars untouched. */
function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = value.slice(1, -1);
      return first === '"'
        ? inner.replace(/\\"/g, '"')
        : inner.replace(/''/g, "'");
    }
  }
  return value;
}

/** Every markdown file under the configured sources, sorted for stable output. */
async function collect(): Promise<string[]> {
  const found: string[] = [];
  for (const { dir, nested } of SOURCES) {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      continue; // a source that has not been created yet is not a failure
    }
    for (const entry of entries) {
      if (nested && entry.isDirectory) {
        const candidate = `${dir}/${entry.name}/SKILL.md`;
        try {
          await Deno.stat(candidate);
          found.push(candidate);
        } catch {
          // a directory without a SKILL.md is not a skill
        }
      } else if (!nested && entry.isFile && entry.name.endsWith(".md")) {
        found.push(`${dir}/${entry.name}`);
      }
    }
  }
  return found.sort();
}

const errors: Finding[] = [];
const warnings: Finding[] = [];

/** Report `actual` against `cap`: an error past it, a warning approaching it. */
function budget(
  file: string,
  line: number,
  label: string,
  actual: number,
  cap: number,
  unit: string,
  why: string,
) {
  if (actual > cap) {
    errors.push({
      file,
      line,
      message: `${label} is ${actual} ${unit}, over the ${cap} cap by ${
        actual - cap
      }. ${why}`,
    });
  } else if (actual >= Math.floor(cap * WARN_AT)) {
    warnings.push({
      file,
      line,
      message: `${label} is ${actual} ${unit}, within ${
        cap - actual
      } of the ${cap} cap.`,
    });
  }
}

const files = await collect();
if (files.length === 0) {
  console.error("error: no skill files found — has the layout moved?");
  Deno.exit(1);
}

const rows: string[][] = [];

for (const file of files) {
  const parsed = readFrontmatter(await Deno.readTextFile(file));
  if (!parsed) {
    errors.push({ file, line: 1, message: "no `---` frontmatter block" });
    continue;
  }
  const { keys, bodyLine } = parsed;

  // `name` is optional in both harnesses — Claude Code falls back to the skill's
  // directory name, and a pi agent is named by its filename and titled by
  // `display_name`. Only its length is budgeted.
  const name = keys.get("name");
  if (name && name.value !== "") {
    budget(file, name.line, "name", name.value.length, NAME_MAX, "chars", "");
  }

  const description = keys.get("description");
  if (!description || description.value === "") {
    errors.push({
      file,
      line: 1,
      message:
        "frontmatter has no `description` — a skill without one is not loaded",
    });
  } else {
    budget(
      file,
      description.line,
      "description",
      description.value.length,
      DESCRIPTION_MAX,
      "chars",
      "It is always in context; move procedure into the body or references/, and keep only the signal that decides whether to load the skill.",
    );
    const whenToUse = keys.get("when_to_use")?.value ?? "";
    if (whenToUse !== "") {
      budget(
        file,
        description.line,
        "description + when_to_use",
        description.value.length + whenToUse.length,
        LISTING_MAX,
        "chars",
        "Claude Code truncates the skill listing here, mid-sentence and silently.",
      );
    }
  }

  const bodyLines = (await Deno.readTextFile(file)).split("\n").length -
    bodyLine + 1;
  budget(
    file,
    bodyLine,
    "body",
    bodyLines,
    BODY_MAX_LINES,
    "lines",
    "Detail belongs in references/, which loads on demand.",
  );

  rows.push([
    file,
    String(description?.value.length ?? 0),
    String(bodyLines),
  ]);
}

const width = Math.max(...rows.map((r) => r[0]?.length ?? 0));
console.log(
  `${"file".padEnd(width)}  ${"desc".padStart(5)}  ${"body".padStart(5)}`,
);
for (const [file = "", desc = "", body = ""] of rows) {
  console.log(
    `${file.padEnd(width)}  ${desc.padStart(5)}  ${body.padStart(5)}`,
  );
}
console.log(
  `\ncaps: description ${DESCRIPTION_MAX} chars (pi; Claude Code truncates ` +
    `description+when_to_use at ${LISTING_MAX}), body ${BODY_MAX_LINES} lines.`,
);

const annotate = Deno.env.get("GITHUB_ACTIONS") === "true";
const emit = (kind: "error" | "warning", findings: Finding[]) => {
  for (const { file, line, message } of findings) {
    console.log(
      annotate
        ? `::${kind} file=${file},line=${line}::${message}`
        : `${kind}: ${file}:${line}: ${message}`,
    );
  }
};

if (warnings.length > 0) {
  console.log("");
  emit("warning", warnings);
}
if (errors.length > 0) {
  console.log("");
  emit("error", errors);
  console.log(`\n${errors.length} skill budget violation(s).`);
  Deno.exit(1);
}
console.log("\nAll skills are within budget.");
