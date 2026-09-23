/* yamlet trace viewer — renders a `yamlet.trace/v1` model: every spec's progress
   (the verdicts its tech spec records), and a navigable trace graph at three
   levels — the overview (specs and the decisions that bind them), one spec
   (RQ → AC → ADR → obligation → task) and one decision (what it arises from,
   what it assumes, what discharges it).

   Layout is ELK's layered algorithm with one partition per column, so a level
   always reads left to right in trace order however the edges point. Hovering
   a node lights its upstream and downstream trace; clicking inspects it in the
   drawer, and a spec or ADR also drills into its own level.

   Globals expected on the page (injected before this script): `ELK`
   (elk.bundled.js), `window.YamletViewer` (common.js) and
   `window.__YAMLET_TRACE__` (the model). */
(function () {
  "use strict";

  var M = window.__YAMLET_TRACE__;
  var YV = window.YamletViewer;
  var hue = YV.hue, measure = YV.measure, el = YV.el, esc = YV.esc;
  var smoothPath = YV.smoothPath, edgePoints = YV.edgePoints, installPanZoom = YV.installPanZoom;
  var elk = new ELK();

  // ── model indexes ────────────────────────────────────────────────────────
  var NODES = {}, OUT = {}, IN = {}, ROLL = {}, OPEN = {};
  M.nodes.forEach(function (n) {
    NODES[n.id] = n;
  });
  M.edges.forEach(function (e) {
    (OUT[e.from] = OUT[e.from] || []).push(e);
    (IN[e.to] = IN[e.to] || []).push(e);
  });
  M.specs.forEach(function (r) {
    ROLL[r.node] = r;
    r.uncovered.concat(r.openObligations).forEach(function (id) {
      OPEN[id] = true;
    });
  });

  function outs(id, kind) {
    return (OUT[id] || []).filter(function (e) {
      return !kind || e.kind === kind;
    }).map(function (e) {
      return e.to;
    });
  }
  function ins(id, kind) {
    return (IN[id] || []).filter(function (e) {
      return !kind || e.kind === kind;
    }).map(function (e) {
      return e.from;
    });
  }
  function uniq(list) {
    var seen = {};
    return list.filter(function (x) {
      if (seen[x]) return false;
      seen[x] = true;
      return true;
    });
  }

  // ── labels & colours ─────────────────────────────────────────────────────
  var F_BADGE = "700 10.5px ui-monospace, Menlo, monospace";
  var F_LABEL = "12.5px system-ui, sans-serif";
  var PAD = 12, NODE_H = 50, MIN_W = 140, MAX_LABEL = 40;
  var MIN_SCALE = 0.72; // below this the labels stop being legible

  function base(file) {
    return String(file || "").split("/").pop().replace(/\.(yamlet|techspec|adr)\.yaml$/, "");
  }
  function clip(s, n) {
    s = String(s || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }
  function verdictClass(v) {
    return v === "met" ? "met" : v === "unmet" ? "unmet" : v === "unrecorded" ? "unrec" : "";
  }
  function retired(n) {
    return n.type === "adr" && (n.adrStatus === "superseded" || n.adrStatus === "rejected");
  }
  function color(n) {
    if (n.type === "spec") return hue(n.system || n.file);
    if (n.type === "requirement") return "var(--req)";
    if (n.type === "criterion") {
      var v = verdictClass(n.verdict);
      return v === "unrec" ? "var(--unrec)" : v ? "var(--" + v + ")" : "var(--faint)";
    }
    if (n.type === "adr") return retired(n) ? "var(--faint)" : "var(--adr)";
    if (n.type === "obligation") return "var(--obl)";
    return "var(--task)";
  }
  function specBase(specId) {
    var s = NODES[specId];
    return s ? base(s.file) : "?";
  }
  // `withSpec` prefixes a requirement/criterion with its spec, for levels that span specs.
  function badge(n, withSpec) {
    var pre = withSpec && n.spec ? specBase(n.spec) + " · " : "";
    switch (n.type) {
      case "spec":
        return "spec · " + (n.system || "?");
      case "requirement":
        return pre + n.rq;
      case "criterion":
        return pre + n.ac + (n.verdict ? " · " + n.verdict : "");
      case "adr":
        return (n.adr || "ADR-?") + (n.adrStatus ? " · " + n.adrStatus : "");
      case "obligation":
        return n.ref;
      case "task":
        return n.task;
    }
    return n.id;
  }
  function label(n) {
    if (n.missing) {
      return "missing" + (n.file ? " — " + base(n.file) : "");
    }
    switch (n.type) {
      case "spec":
        return n.topic || base(n.file);
      case "requirement":
        return n.description;
      case "criterion":
        return (n.shalls && n.shalls[0]) ? "shall " + n.shalls[0] : trigger(n);
      case "adr":
        return n.title;
      case "obligation":
        return n.must;
      case "task":
        return n.title || n.why;
    }
    return "";
  }
  function trigger(n) {
    return n.when ? "when " + n.when : n.if ? "if " + n.if : "";
  }
  // The EARS sentence rebuilt from the clauses (same shape as `yamlet tests`).
  function earsHtml(n) {
    var cond = [];
    if (n.where) cond.push("where " + n.where);
    if (n.whiles && n.whiles.length) cond.push("while " + n.whiles.join(" and "));
    if (trigger(n)) cond.push(trigger(n));
    var lead = cond.length ? cond.join(", ") + ", the system shall:" : "The system shall:";
    lead = lead.charAt(0).toUpperCase() + lead.slice(1);
    return '<div class="ears">' + esc(lead) + "<ul>" + (n.shalls || []).map(function (s) {
      return "<li>" + esc(s) + "</li>";
    }).join("") + "</ul></div>";
  }

  // ── levels: which nodes, which column each sits in ───────────────────────
  // A level is {nodes: [id], rank: {id: column}, spanSpecs}. Edges are every model
  // edge between two of its nodes.
  function overviewLevel(openOnly) {
    var ids = [], rank = {};
    M.nodes.forEach(function (n) {
      if (n.type === "spec") {
        var r = ROLL[n.id];
        if (openOnly && r && isDone(r)) return;
        ids.push(n.id);
        rank[n.id] = 0;
      }
    });
    M.nodes.forEach(function (n) {
      if (n.type !== "adr") return;
      if (openOnly && retired(n)) return;
      ids.push(n.id);
      rank[n.id] = 1;
    });
    return { nodes: ids, rank: rank, spanSpecs: true, overview: true };
  }

  function specLevel(specId, openOnly) {
    var rank = {}, ids = [];
    function add(id, r) {
      if (!NODES[id] || id in rank) return;
      rank[id] = r;
      ids.push(id);
    }
    var blocks = M.nodes.filter(function (n) {
      return (n.type === "requirement" || n.type === "criterion") && n.spec === specId;
    });
    blocks.forEach(function (n) {
      if (openOnly && n.type === "criterion" && n.verdict === "met") return;
      if (openOnly && n.type === "requirement") {
        var acs = outs(n.id, "has").map(function (id) {
          return NODES[id];
        });
        if (
          acs.length && acs.every(function (a) {
            return a.verdict === "met";
          })
        ) return;
      }
      add(n.id, n.type === "requirement" ? 0 : 1);
    });
    var adrs = [];
    blocks.forEach(function (n) {
      adrs = adrs.concat(outs(n.id, "decided_by"), ins(n.id, "arises_from"));
    });
    var tasks = M.nodes.filter(function (n) {
      return n.type === "task" && n.spec === specId;
    });
    tasks.forEach(function (t) {
      outs(t.id, "covers").forEach(function (c) {
        if (NODES[c] && NODES[c].type === "obligation") adrs.push(NODES[c].adrNode);
      });
    });
    uniq(adrs).forEach(function (a) {
      if (openOnly && retired(NODES[a])) return;
      add(a, 2);
      outs(a, "has").forEach(function (o) {
        add(o, 3);
      });
    });
    tasks.forEach(function (t) {
      add(t.id, 4);
    });
    return { nodes: ids, rank: rank, spanSpecs: false };
  }

  function adrLevel(adrId, openOnly) {
    var rank = {}, ids = [];
    function add(id, r) {
      if (!NODES[id] || id in rank) return;
      if (openOnly && id !== adrId && retired(NODES[id])) return;
      rank[id] = r;
      ids.push(id);
    }
    add(adrId, 1);
    ins(adrId, "decided_by").concat(outs(adrId, "arises_from")).forEach(function (b) {
      if (openOnly && NODES[b] && NODES[b].verdict === "met") return;
      add(b, 0);
    });
    outs(adrId, "assumes").concat(ins(adrId, "assumes"), outs(adrId, "superseded_by"))
      .concat(ins(adrId, "superseded_by")).forEach(function (a) {
        add(a, 1);
      });
    outs(adrId, "has").forEach(function (o) {
      add(o, 2);
      ins(o, "covers").forEach(function (t) {
        add(t, 3);
      });
      ins(o, "cites").forEach(function (a) {
        add(a, 1);
      });
    });
    outs(adrId, "cites").forEach(function (o) {
      add(o, 2);
    });
    return { nodes: ids, rank: rank, spanSpecs: true };
  }

  // A spec whose tech spec leaves nothing to do.
  function isDone(r) {
    return !!r.techspec && r.criteria.total > 0 && r.criteria.met === r.criteria.total &&
      r.openObligations.length === 0;
  }

  // Overview edges are the model's, lifted to spec level: a spec ↔ ADR link
  // exists when any of its blocks is decided by, or gives rise to, that ADR.
  function levelEdges(level) {
    var inLevel = {};
    level.nodes.forEach(function (id) {
      inLevel[id] = true;
    });
    var seen = {}, out = [];
    function push(kind, from, to) {
      var key = kind + "|" + from + "|" + to;
      if (seen[key] || !inLevel[from] || !inLevel[to] || from === to) return;
      seen[key] = true;
      out.push({ kind: kind, from: from, to: to });
    }
    M.edges.forEach(function (e) {
      if (level.overview) {
        var f = NODES[e.from], t = NODES[e.to];
        if (e.kind === "decided_by" && f && f.spec) return push("decides", f.spec, e.to);
        if (e.kind === "arises_from" && t && t.spec) return push("decides", t.spec, e.from);
        if (e.kind === "assumes" || e.kind === "superseded_by") push(e.kind, e.from, e.to);
        return;
      }
      push(e.kind, e.from, e.to);
    });
    return out;
  }

  // ── level → ELK graph ────────────────────────────────────────────────────
  function buildElk(level, edges) {
    var children = level.nodes.map(function (id) {
      var n = NODES[id];
      var b = badge(n, level.spanSpecs), l = clip(label(n), MAX_LABEL);
      var w = Math.max(
        MIN_W,
        Math.round(Math.max(measure(b, F_BADGE), measure(l, F_LABEL))) + 2 * PAD,
      );
      return {
        id: id,
        width: w,
        height: NODE_H,
        layoutOptions: { "elk.partitioning.partition": String(level.rank[id]) },
        _badge: b,
        _label: l,
      };
    });
    // Orient every edge along the columns for layout; drawing ignores direction.
    var elkEdges = edges.map(function (e, i) {
      var fwd = level.rank[e.from] <= level.rank[e.to];
      return {
        id: "e" + i,
        kind: e.kind,
        model: e,
        sources: [fwd ? e.from : e.to],
        targets: [fwd ? e.to : e.from],
      };
    });
    return {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "SPLINES",
        "elk.partitioning.activate": "true",
        // One layered drawing, not a packed grid of components: an RQ with no
        // decisions must still sit in the requirement column.
        "elk.separateConnectedComponents": "false",
        "elk.layered.spacing.nodeNodeBetweenLayers": "56",
        "elk.spacing.nodeNode": "16",
        "elk.layered.spacing.edgeNodeBetweenLayers": "20",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      },
      children: children,
      edges: elkEdges,
    };
  }

  // ── ELK result → SVG ─────────────────────────────────────────────────────
  function renderSvg(laid, level) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    laid.children.forEach(function (c) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.width);
      maxY = Math.max(maxY, c.y + c.height);
    });
    var m = 24;
    var vb = { x: minX - m, y: minY - m, w: maxX - minX + 2 * m, h: maxY - minY + 2 * m };
    var viewport = el("g", { class: "viewport" });
    var svg = el("svg", { xmlns: YV.SVGNS, preserveAspectRatio: "xMidYMid meet" }, [viewport]);

    var edgeEls = [];
    (laid.edges || []).forEach(function (e) {
      var pts = edgePoints(e);
      if (!pts.length) return;
      var p = el("path", { class: "te " + e.kind, d: smoothPath(pts) });
      viewport.appendChild(p);
      edgeEls.push({ el: p, from: e.model.from, to: e.model.to });
    });

    var nodeEls = {};
    laid.children.forEach(function (c) {
      var n = NODES[c.id], col = color(n);
      var cls = "tn " + n.type + (n.missing ? " missing" : "") + (retired(n) ? " retired" : "") +
        (OPEN[c.id] ? " open" : "") + (c.id === top().id ? " focus" : "");
      var g = el("g", { class: cls });
      g.dataset.id = c.id;
      g.appendChild(el("rect", {
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        rx: n.type === "adr" || n.type === "spec" ? 11 : 7,
        style: "stroke:" + col + ";fill:" + col,
      }));
      g.appendChild(el("text", {
        class: "tn-badge",
        x: c.x + PAD,
        y: c.y + 19,
        style: "fill:" + col,
      }, [document.createTextNode(c._badge)]));
      g.appendChild(el("text", { class: "tn-label", x: c.x + PAD, y: c.y + 37 }, [
        document.createTextNode(c._label),
      ]));
      var title = el("title", {}, [document.createTextNode(label(n))]);
      g.appendChild(title);
      g.addEventListener("click", function () {
        pick(c.id);
      });
      g.addEventListener("mouseenter", function () {
        light(svg, c.id, level, nodeEls, edgeEls);
      });
      g.addEventListener("mouseleave", function () {
        svg.classList.remove("tracing");
      });
      viewport.appendChild(g);
      nodeEls[c.id] = g;
    });
    return { svg: svg, viewport: viewport, bbox: vb };
  }

  // Hover tracing: walk the level's edges downstream (towards later columns) and
  // upstream from the node, and light what each walk reaches.
  function light(svg, id, level, nodeEls, edgeEls) {
    var down = {}, up = {};
    function dir(e) {
      var fwd = level.rank[e.from] <= level.rank[e.to];
      return fwd ? [e.from, e.to] : [e.to, e.from];
    }
    function walk(start, set, forward) {
      var stack = [start];
      while (stack.length) {
        var cur = stack.pop();
        edgeEls.forEach(function (e) {
          var d = dir(e), a = forward ? d[0] : d[1], b = forward ? d[1] : d[0];
          if (a === cur && !set[b]) {
            set[b] = true;
            stack.push(b);
          }
        });
      }
    }
    walk(id, down, true);
    walk(id, up, false);
    down[id] = up[id] = true;
    Object.keys(nodeEls).forEach(function (k) {
      nodeEls[k].classList.toggle("lit", !!(down[k] || up[k]));
    });
    edgeEls.forEach(function (e) {
      var d = dir(e);
      e.el.classList.toggle("lit", !!((down[d[0]] && down[d[1]]) || (up[d[0]] && up[d[1]])));
    });
    svg.classList.add("tracing");
  }

  // ── navigation ───────────────────────────────────────────────────────────
  var NAV = { stack: [{ kind: "overview" }], gen: 0, fit: null, openOnly: false };

  function frameName(fr) {
    if (fr.kind === "overview") return "overview";
    var n = NODES[fr.id];
    return fr.kind === "spec" ? base(n.file) : (n.adr || "ADR-?");
  }
  function drill(kind, id) {
    for (var i = 0; i < NAV.stack.length; i++) {
      if (NAV.stack[i].kind === kind && NAV.stack[i].id === id) {
        NAV.stack = NAV.stack.slice(0, i + 1);
        return renderLevel();
      }
    }
    NAV.stack.push({ kind: kind, id: id });
    renderLevel();
  }
  function pick(id) {
    var n = NODES[id], top = NAV.stack[NAV.stack.length - 1];
    if (n.type === "spec" && !n.missing) return drill("spec", id);
    if (n.type === "adr" && !n.missing && top.id !== id) {
      drill("adr", id);
      return openDrawer(id);
    }
    openDrawer(id);
  }

  function renderBreadcrumb() {
    var bc = document.getElementById("breadcrumb");
    bc.innerHTML = NAV.stack.map(function (fr, i) {
      var last = i === NAV.stack.length - 1;
      return '<button class="crumb' + (last ? " current" : "") + '" data-i="' + i + '">' +
        esc(frameName(fr)) + "</button>" + (last ? "" : '<span class="crumb-sep">›</span>');
    }).join("");
    bc.querySelectorAll(".crumb").forEach(function (b) {
      b.addEventListener("click", function () {
        NAV.stack = NAV.stack.slice(0, Number(b.dataset.i) + 1);
        renderLevel();
      });
    });
  }

  function levelHead(fr, level) {
    if (fr.kind === "overview") {
      var nspec = 0, nadr = 0;
      level.nodes.forEach(function (id) {
        if (NODES[id].type === "spec") nspec++;
        else nadr++;
      });
      return "<strong>Specs and the decisions that bind them</strong><span>" + nspec + " spec" +
        (nspec === 1 ? "" : "s") + " · " + nadr + " decision record" + (nadr === 1 ? "" : "s") +
        " · click a spec or an ADR to drill in</span>";
    }
    var n = NODES[fr.id];
    if (fr.kind === "spec") {
      var r = ROLL[fr.id];
      var ts = n.techspec
        ? 'tech spec <span class="mono">' + esc(base(n.techspec)) + "</span>" +
          (n.commit ? ' @ <span class="mono">' + esc(n.commit) + "</span>" : "")
        : (r && r.techspecIssue ? esc(r.techspecIssue) : "no tech spec — verdicts unknown");
      return "<strong>" + esc(n.topic || base(n.file)) + '</strong><span class="mono">' +
        esc(n.file) + "</span><span>" + ts + "</span>";
    }
    return "<strong>" + esc((n.adr || "ADR-?") + " — " + (n.title || "missing")) + "</strong>" +
      "<span>" + esc(n.adrStatus || "") + (n.kind ? " · " + esc(n.kind) : "") +
      (n.date ? " · " + esc(n.date) : "") + "</span>";
  }

  function renderLevel() {
    closeDrawer();
    renderBreadcrumb();
    var fr = NAV.stack[NAV.stack.length - 1];
    var level = fr.kind === "overview"
      ? overviewLevel(NAV.openOnly)
      : fr.kind === "spec"
      ? specLevel(fr.id, NAV.openOnly)
      : adrLevel(fr.id, NAV.openOnly);
    var edges = levelEdges(level);

    document.querySelectorAll(".spec-card").forEach(function (c) {
      c.classList.toggle("current", fr.kind === "spec" && c.dataset.id === fr.id);
    });
    document.getElementById("level-head").innerHTML = levelHead(fr, level);
    renderLegend(level, edges);

    var host = document.getElementById("trace-svg");
    host.innerHTML = "";
    NAV.fit = null;
    var gen = ++NAV.gen;
    if (!level.nodes.length) {
      host.innerHTML = '<div class="trace-empty">' +
        (NAV.openOnly ? "No open work at this level." : "Nothing to trace here.") + "</div>";
      return;
    }
    elk.layout(buildElk(level, edges)).then(function (laid) {
      if (NAV.gen !== gen) return; // a newer level superseded this layout
      var view = renderSvg(laid, level);
      host.appendChild(view.svg);
      // Tall enough to read: at least MIN_SCALE, however wide the level is.
      var cw = host.clientWidth || 900;
      var k = Math.max(MIN_SCALE, Math.min(1, cw / view.bbox.w));
      view.svg.style.height = Math.max(240, Math.min(820, Math.round(view.bbox.h * k) + 24)) + "px";
      var pz = installPanZoom(view.svg, view.viewport, view.bbox, MIN_SCALE);
      requestAnimationFrame(pz.open);
      NAV.fit = pz.fit;
    });
  }

  // ── legend (only what the level shows) ───────────────────────────────────
  var EDGE_TEXT = {
    has: ["var(--border)", "", "contains"],
    decides: ["var(--adr)", "", "spec ↔ decision"],
    decided_by: ["var(--adr)", "", "decided by (spec adrs:)"],
    arises_from: ["var(--adr)", "dotted", "arises from"],
    assumes: ["var(--adr)", "", "assumes"],
    superseded_by: ["var(--faint)", "dashed", "superseded by"],
    cites: ["var(--obl)", "dotted", "force cites obligation"],
    covers: ["var(--task)", "", "task covers"],
    depends_on: ["var(--task)", "dashed", "task depends on"],
  };
  function renderLegend(level, edges) {
    var types = {}, kinds = {};
    level.nodes.forEach(function (id) {
      var n = NODES[id];
      types[n.type === "criterion" ? "crit-" + (n.verdict || "none") : n.type] = true;
      if (n.missing) types.missing = true;
    });
    edges.forEach(function (e) {
      kinds[e.kind] = true;
    });
    var box = function (c, t, dashed) {
      return '<span><i class="bx" style="border-color:' + c +
        (dashed ? ";border-style:dashed" : "") +
        '"></i>' + t + "</span>";
    };
    var parts = [];
    if (types.spec) parts.push(box("var(--muted)", "spec"));
    if (types.requirement) parts.push(box("var(--req)", "requirement"));
    if (types["crit-met"]) parts.push(box("var(--met)", "criterion met"));
    if (types["crit-unmet"]) parts.push(box("var(--unmet)", "criterion unmet"));
    if (types["crit-unrecorded"]) parts.push(box("var(--unrec)", "criterion unrecorded"));
    if (types["crit-none"]) parts.push(box("var(--faint)", "criterion — no tech spec"));
    if (types.adr) parts.push(box("var(--adr)", "decision record"));
    if (types.obligation) parts.push(box("var(--obl)", "obligation (R-n)"));
    if (types.task) parts.push(box("var(--task)", "task"));
    if (types.missing) parts.push(box("var(--faint)", "missing reference", true));
    Object.keys(EDGE_TEXT).forEach(function (k) {
      if (!kinds[k]) return;
      var t = EDGE_TEXT[k];
      parts.push(
        '<span><i class="ln" style="border-top-color:' + t[0] +
          (t[1] ? ";border-top-style:" + t[1] : "") + '"></i>' + t[2] + "</span>",
      );
    });
    parts.push(
      "<span>thick outline = open work (unmet and untasked, or an undischarged obligation)</span>",
    );
    document.getElementById("legend").innerHTML = parts.join("");
  }

  // ── progress cards ───────────────────────────────────────────────────────
  function renderProgress() {
    var host = document.getElementById("progress");
    var bySys = {}, order = [];
    M.specs.forEach(function (r) {
      var k = r.system || "(no system)";
      if (!bySys[k]) {
        bySys[k] = [];
        order.push(k);
      }
      bySys[k].push(r);
    });
    if (!order.length) {
      host.innerHTML = '<div class="trace-empty">No specs found under ' + esc(M.root) + ".</div>";
      return;
    }
    host.innerHTML = order.map(function (sys) {
      return '<div class="sys-head"><i style="background:' + hue(sys) +
        '"></i><span class="mono">' +
        esc(sys) + "</span></div>" + bySys[sys].map(card).join("");
    }).join("");
    host.querySelectorAll(".spec-card").forEach(function (c) {
      c.addEventListener("click", function () {
        NAV.stack = [{ kind: "overview" }];
        drill("spec", c.dataset.id);
        document.getElementById("diagram").scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
  }
  function card(r) {
    var c = r.criteria, tot = c.total || 1;
    var bar = r.techspec
      ? '<div class="bar" title="' + c.met + " met · " + c.unmet + " unmet · " + c.unrecorded +
        ' unrecorded"><span class="met" style="width:' + (100 * c.met / tot) +
        '%"></span><span class="unmet" style="width:' + (100 * c.unmet / tot) +
        '%"></span><span class="unrec" style="width:' + (100 * c.unrecorded / tot) +
        '%"></span></div>'
      : '<div class="bar"></div>';
    var gaps = [];
    if (!r.techspec) {
      gaps.push(
        '<span class="gap warn">' + (r.techspecIssue ? "ambiguous tech spec" : "no tech spec") +
          "</span>",
      );
    } else {
      if (r.uncovered.length) {
        gaps.push('<span class="gap">' + r.uncovered.length + " unmet, no task</span>");
      }
      if (r.openObligations.length) {
        gaps.push(
          '<span class="gap">' + r.openObligations.length + " obligation" +
            (r.openObligations.length === 1 ? "" : "s") + " undischarged</span>",
        );
      }
      if (c.unrecorded) gaps.push('<span class="gap warn">' + c.unrecorded + " unrecorded</span>");
      if (isDone(r)) gaps.push('<span class="gap ok">all criteria met</span>');
    }
    if (NODES[r.node] && NODES[r.node].outside) {
      gaps.push('<span class="gap warn">outside ' + esc(M.name) + "</span>");
    }
    return '<button class="spec-card' + (isDone(r) ? " done" : "") + '" data-id="' + esc(r.node) +
      '">' +
      '<div class="file mono">' + esc(base(r.file)) + "</div>" +
      (r.topic ? '<div class="topic">' + esc(r.topic) + "</div>" : "") + bar +
      '<div class="stats">' +
      (r.techspec
        ? "<span><b>" + c.met + "/" + c.total + "</b> met</span>"
        : "<span><b>" + c.total + "</b> criteria</span>") +
      "<span><b>" + r.tasks + "</b> task" + (r.tasks === 1 ? "" : "s") + "</span>" +
      "<span><b>" + r.adrs.length + "</b> ADR" + (r.adrs.length === 1 ? "" : "s") +
      "</span></div>" +
      (gaps.length ? '<div class="gaps">' + gaps.join("") + "</div>" : "") + "</button>";
  }

  // ── drawer ───────────────────────────────────────────────────────────────
  var drawer;
  function closeDrawer() {
    if (drawer) drawer.classList.remove("open");
  }
  function refBtn(id, withSpec) {
    var n = NODES[id];
    if (!n) return "";
    return '<button class="ref' + (n.missing ? " missing" : "") + '" data-ref="' + esc(id) + '">' +
      '<span class="mono">' + esc(badge(n, withSpec)) + "</span>" + esc(clip(label(n), 90)) +
      "</button>";
  }
  function group(title, ids, withSpec) {
    ids = uniq(ids);
    if (!ids.length) return "";
    return '<div class="grp"><h4>' + esc(title) + '</h4><div class="refs">' +
      ids.map(function (id) {
        return refBtn(id, withSpec);
      }).join("") + "</div></div>";
  }
  function list(title, items) {
    if (!items || !items.length) return "";
    return '<div class="grp"><h4>' + esc(title) + '</h4><ul class="plain">' +
      items.map(function (s) {
        return "<li>" + esc(s) + "</li>";
      }).join("") + "</ul></div>";
  }
  function prose(title, text) {
    if (!text) return "";
    return '<div class="grp"><h4>' + esc(title) + '</h4><p class="prose">' + esc(text) +
      "</p></div>";
  }
  function chip(text, cls) {
    return '<span class="chip ' + (cls || "") + '">' + esc(text) + "</span>";
  }

  function openDrawer(id) {
    var n = NODES[id];
    if (!n) return;
    var h = "", chips = [], sub = "", file = "";
    if (n.missing) chips.push(chip("missing — could not be read"));
    switch (n.type) {
      case "spec": {
        var r = ROLL[id];
        sub = n.system;
        file = n.file;
        if (n.outside) chips.push(chip("outside " + M.name));
        h += prose("intent", n.intent);
        if (r) {
          h += '<dl><dt>tech spec</dt><dd class="mono">' +
            esc(n.techspec || r.techspecIssue || "none") +
            "</dd>" +
            (n.commit ? '<dt>analysed at</dt><dd class="mono">' + esc(n.commit) + "</dd>" : "") +
            "<dt>criteria</dt><dd>" + r.criteria.met + " met · " + r.criteria.unmet + " unmet · " +
            r.criteria.unrecorded + " unrecorded</dd><dt>tasks</dt><dd>" + r.tasks + "</dd></dl>";
          h += group("unmet, no task", r.uncovered) +
            group("undischarged obligations", r.openObligations) +
            group("decision records", r.adrs);
        }
        if (!n.missing && top().id !== id) {
          h += '<button class="drill" data-drill="spec">open this spec’s trace</button>';
        }
        break;
      }
      case "requirement":
        sub = specBase(n.spec);
        h += prose("description", n.description);
        h += group("criteria", outs(id, "has")) + group("decided by", outs(id, "decided_by")) +
          group("gave rise to", ins(id, "arises_from"));
        break;
      case "criterion": {
        sub = specBase(n.spec) + " · " + n.rq;
        var v = verdictClass(n.verdict);
        chips.push(n.verdict ? chip(n.verdict, v) : chip("no tech spec"));
        if (OPEN[id]) chips.push(chip("no task covers it", "unmet"));
        if (n.pattern) chips.push(chip(n.pattern));
        if (!n.missing) h += earsHtml(n);
        h += list("evidence", n.evidence) + prose("note", n.note);
        var owner = n.rq ? [n.spec + "#" + n.rq] : [];
        var decided = outs(id, "decided_by").concat(
          owner.length ? outs(owner[0], "decided_by") : [],
        );
        h += group("decided by", decided) + group("gave rise to", ins(id, "arises_from")) +
          group("covered by", ins(id, "covers")) + group("requirement", owner);
        break;
      }
      case "adr":
        sub = n.title;
        file = n.file;
        if (n.adrStatus) {
          chips.push(
            chip(n.adrStatus, n.adrStatus === "accepted" ? "met" : retired(n) ? "" : "unrec"),
          );
        }
        if (n.kind) chips.push(chip(n.kind));
        if (n.date) chips.push(chip(n.date));
        h += prose("question", n.question);
        var chosen = (n.options || []).filter(function (o) {
          return o.id === n.decision;
        })[0];
        if (n.decision) h += prose("decision", n.decision + (chosen ? " — " + chosen.summary : ""));
        h += list(
          "options",
          (n.options || []).map(function (o) {
            return o.id + (o.id === n.decision ? " (chosen)" : "") + ": " + o.summary +
              (o.reversibility ? " [" + o.reversibility + "]" : "");
          }),
        );
        h += group("obligations", outs(id, "has")) +
          group("decides", ins(id, "decided_by"), true) +
          group("arises from", outs(id, "arises_from"), true) +
          group("assumes", outs(id, "assumes")) + group("assumed by", ins(id, "assumes")) +
          group("superseded by", outs(id, "superseded_by")) +
          group("supersedes", ins(id, "superseded_by"));
        h += list("forces", n.forces) + list("accepts", n.accepts) +
          list("revisit when", n.revisit);
        if (!n.missing && top().id !== id) {
          h += '<button class="drill" data-drill="adr">open this decision’s trace</button>';
        }
        break;
      case "obligation":
        sub = NODES[n.adrNode] ? NODES[n.adrNode].title : "";
        if (OPEN[id]) chips.push(chip("no task discharges it", "unmet"));
        h += prose("must", n.must);
        h += group("decision", [n.adrNode]) + group("discharged by", ins(id, "covers")) +
          group("cited by", ins(id, "cites"));
        break;
      case "task":
        sub = specBase(n.spec) + " · " + base(n.techspec);
        h += prose("title", n.title) + prose("why (enabler)", n.why);
        h += group("covers", outs(id, "covers")) + group("depends on", outs(id, "depends_on")) +
          group("needed by", ins(id, "depends_on"));
        break;
    }
    drawer.innerHTML = '<button class="close" aria-label="close">✕</button>' +
      "<h2>" +
      esc(n.type === "spec" ? (n.topic || base(n.file)) : badge(n, false).split(" · ")[0]) +
      "</h2>" +
      (sub ? '<div class="sub">' + esc(sub) + "</div>" : "") +
      (chips.length ? '<div class="chips">' + chips.join("") + "</div>" : "") + h +
      (file ? '<div class="file">' + esc(file) + "</div>" : "");
    drawer.querySelector(".close").addEventListener("click", closeDrawer);
    drawer.querySelectorAll(".ref").forEach(function (b) {
      b.addEventListener("click", function () {
        openDrawer(b.dataset.ref);
      });
    });
    var d = drawer.querySelector(".drill");
    if (d) {
      d.addEventListener("click", function () {
        drill(d.dataset.drill, id);
        if (n.type === "adr") openDrawer(id);
      });
    }
    drawer.classList.add("open");
  }
  function top() {
    return NAV.stack[NAV.stack.length - 1];
  }

  // ── page assembly ────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    drawer = document.getElementById("panel");
    var count = function (t) {
      return M.nodes.filter(function (n) {
        return n.type === t && !n.missing;
      }).length;
    };
    var met = 0, total = 0, withTs = 0;
    M.specs.forEach(function (r) {
      if (!r.techspec) return; // no verdicts to count
      met += r.criteria.met;
      total += r.criteria.total;
      withTs++;
    });
    var rootName = M.name || M.root;
    document.getElementById("eyebrow").textContent = "yamlet trace · " + rootName;
    document.getElementById("title").textContent = rootName + " — decisions & plan";
    var ns = M.specs.length, na = count("adr"), nt = count("task");
    document.getElementById("lede").textContent = ns + " spec" + (ns === 1 ? "" : "s") + ", " +
      withTs + " with a tech spec, " + na + " decision record" + (na === 1 ? "" : "s") + ", " + nt +
      " task" + (nt === 1 ? "" : "s") + ". " +
      (withTs ? met + " of " + total + " recorded criteria met. " : "") +
      "Follow a criterion to the decisions that shape it and the tasks that close it.";

    renderProgress();

    if (M.skipped && M.skipped.length) {
      document.getElementById("foot").innerHTML += " <strong>Skipped:</strong> " +
        M.skipped.map(function (k) {
          return esc(base(k.file) || k.file) + " (" + esc(k.reason) + ")";
        }).join(", ") + ".";
    }

    document.getElementById("fit").addEventListener("click", function () {
      if (NAV.fit) NAV.fit();
    });
    document.getElementById("openonly").addEventListener("change", function (e) {
      NAV.openOnly = e.target.checked;
      renderLevel();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });

    renderLevel();
  });
})();
