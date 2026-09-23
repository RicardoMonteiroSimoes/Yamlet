// Assemble an interactive viewer as a single HTML document from a model — the
// renderer behind `yamlet graph --format=html` (a `yamlet.graph/v1` model) and
// `yamlet trace --format=html` (a `yamlet.trace/v1` model). Each page is a
// template plus its stylesheets and scripts; `common.js` carries the helpers both
// viewers share.
//
// The viewer's own CSS/JS are ALWAYS inlined; only the layout engine (elkjs) varies:
//
//   --libs=cdn    (default) reference a pinned, SRI-guarded elk from jsDelivr — a
//                 small file that fetches the engine at load time (needs network +
//                 that origin allowed; e.g. blocked inside a strict artifact/CSP
//                 sandbox).
//   --libs=embed  inline elk.bundled.js — one offline file, no network (~1.6 MB).
//
// Assets are read relative to this module so it works both from source and from the
// compiled binary — `deno compile` must `--include` them (see deno.json).

export type Libs = "cdn" | "embed";

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

/** One kind of page: its template and the assets inlined into it, in order. */
interface Page {
  template: string;
  css: string[];
  scripts: string[];
}

const GRAPH_PAGE: Page = {
  template: "template.html",
  css: ["viewer.css"],
  scripts: ["common.js", "viewer.js"],
};
const TRACE_PAGE: Page = {
  template: "trace.html",
  css: ["viewer.css", "trace.css"],
  scripts: ["common.js", "trace.js"],
};

function renderPage(page: Page, modelJson: string, title: string, libs: Libs): string {
  const css = page.css.map(asset).join("\n");
  const js = page.scripts.map((s) => safeInline(asset(s))).join("\n");
  return asset(page.template)
    .replace("__TITLE__", title || "graph")
    .replace("/*__CSS__*/", () => css)
    .replace("<!--__LIBS__-->", () => libsBlock(libs))
    .replace("/*__MODEL__*/ null", () => safeInline(modelJson))
    .replace("/*__VIEWER__*/", () => js);
}

/** Render a graph model (leaf | composite | forest, already JSON-encoded) into a standalone page. */
export function renderViewerHtml(modelJson: string, title: string, libs: Libs): string {
  return renderPage(GRAPH_PAGE, modelJson, title, libs);
}

/** Render a trace model (already JSON-encoded) into a standalone page. */
export function renderTraceHtml(modelJson: string, title: string, libs: Libs): string {
  return renderPage(TRACE_PAGE, modelJson, title, libs);
}
