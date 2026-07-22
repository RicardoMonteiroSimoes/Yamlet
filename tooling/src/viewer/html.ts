// Assemble the interactive graph viewer as a single, self-contained HTML document
// from a `yamlet.graph/v1` model — the renderer behind `yamlet graph --format=html`.
//
// The viewer's own CSS/JS are ALWAYS inlined; only the layout engine (elkjs) varies:
//
//   --libs=embed  inline elk.bundled.js — one offline file, no network (~1.6 MB).
//   --libs=cdn    reference a pinned, SRI-guarded elk from jsDelivr — a small file
//                 that fetches the engine at load time (needs network + that origin
//                 allowed; e.g. blocked inside a strict artifact/CSP sandbox).
//
// Assets are read relative to this module so it works both from source and from the
// compiled binary — `deno compile` must `--include` them (see deno.json).

export type Libs = "embed" | "cdn";

// Pin the engine. The SRI is of elkjs@0.12.0/lib/elk.bundled.js, which is byte-identical
// to the vendored copy served verbatim by jsDelivr. If the vendored elk is ever bumped,
// regenerate BOTH the version and the hash together:
//   openssl dgst -sha384 -binary elk.bundled.js | openssl base64 -A
const ELK_VERSION = "0.12.0";
const ELK_CDN = `https://cdn.jsdelivr.net/npm/elkjs@${ELK_VERSION}/lib/elk.bundled.js`;
const ELK_SRI = "sha384-ww57TDqx4cGknIavPm0QKO+aygLUR1BLSn2Vhbnt1XdYKWcwLyWTFKX7aZMaKIi2";

/** Read a viewer asset relative to this module (source tree or `--include`d in the binary). */
function asset(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, import.meta.url));
}

/** Neutralize any `</script` inside inlined JS/JSON so it cannot close the host tag. */
function safeInline(s: string): string {
  return s.replace(/<\/script/gi, "<\\/script");
}

/** The `<script>` that loads the layout engine, embedded or referenced. */
function libsBlock(libs: Libs): string {
  if (libs === "cdn") {
    return `<script src="${ELK_CDN}" integrity="${ELK_SRI}" crossorigin="anonymous"></script>`;
  }
  return `<script>\n${safeInline(asset("vendor/elk.bundled.js"))}\n</script>`;
}

/** Render a model (leaf | composite | forest, already JSON-encoded) into a standalone page. */
export function renderViewerHtml(modelJson: string, title: string, libs: Libs): string {
  return asset("template.html")
    .replace("__TITLE__", title || "graph")
    .replace("/*__CSS__*/", () => asset("viewer.css"))
    .replace("<!--__LIBS__-->", () => libsBlock(libs))
    .replace("/*__MODEL__*/ null", () => safeInline(modelJson))
    .replace("/*__VIEWER__*/", () => safeInline(asset("viewer.js")));
}
