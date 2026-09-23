/* yamlet graph viewer — renders a `yamlet.graph/v1` model as a hand-designed page:
   a service map, a completeness ledger, and a composition that navigates by system.
   Each level shows every scope sharing a `system:` slug, drawn as live SVG laid out
   by ELK (elkjs) with pan/zoom. Click a member card to drill into its system; the
   breadcrumb climbs back; a terminal leaf opens its contract in a drawer.

   Why bespoke SVG rather than a graph library: the design bar is a record-style
   member card (title · service badge · divider · socket rows with hollow inputs
   and filled outputs) plus smooth wires — shapes a canvas graph lib can't render
   faithfully. elkjs gives us layout + exact port coordinates; we draw the rest.

   Globals expected on the page (injected before this script): `ELK`
   (elk.bundled.js), `window.YamletViewer` (common.js — the helpers shared with
   the trace viewer) and `window.__YAMLET_GRAPH__` (the model). */
(function () {
  "use strict";

  var MODEL = window.__YAMLET_GRAPH__;
  var IN = "__boundary_in", OUT = "__boundary_out";
  var SVGNS = "http://www.w3.org/2000/svg";
  var YV = window.YamletViewer;
  var hue = YV.hue, measure = YV.measure, el = YV.el, esc = YV.esc;
  var smoothPath = YV.smoothPath, edgePoints = YV.edgePoints, installPanZoom = YV.installPanZoom;
  var elk = new ELK();

  // ── geometry constants (card internals) ─────────────────────────────────
  var ROW_H = 24, HEADER_H = 46, PAD_X = 14, CARD_MIN_W = 172;
  var BND_W = 10; // boundary bank node width

  var F_TITLE = "600 14px system-ui, sans-serif";
  var F_BADGE = "700 10.5px ui-monospace, Menlo, monospace";
  var F_SOCK = "11px ui-monospace, Menlo, monospace";

  function socketId(node, dir, socket) {
    return node + "::" + dir + "::" + socket;
  }

  // ── model → ELK graph ────────────────────────────────────────────────────
  // Build the ELK graph for one composite body. Members become nodes with
  // fixed-position ports (inputs west, outputs east) aligned to our socket rows;
  // the boundary in/out banks become thin nodes pinned to the first/last layer.
  function buildElk(spec, body) {
    var children = [], edges = [];

    function cardDims(name, system, inputs, outputs) {
      var rows = Math.max(inputs.length, outputs.length);
      var inW = inputs.reduce(function (m, s) {
        return Math.max(m, measure(s, F_SOCK));
      }, 0);
      var outW = outputs.reduce(function (m, s) {
        return Math.max(m, measure(s, F_SOCK));
      }, 0);
      var head = Math.max(measure(name, F_TITLE), measure(system, F_BADGE));
      var innerW = Math.max(head, inW + outW + 46);
      return {
        w: Math.max(CARD_MIN_W, Math.round(innerW) + 2 * PAD_X),
        h: HEADER_H + Math.max(rows, 1) * ROW_H + 12,
        rows: rows,
      };
    }

    function memberPorts(id, inputs, outputs, w) {
      var ports = [];
      inputs.forEach(function (s, i) {
        ports.push({
          id: socketId(id, "in", s),
          x: 0,
          y: HEADER_H + i * ROW_H + ROW_H / 2,
          layoutOptions: { "port.side": "WEST" },
        });
      });
      outputs.forEach(function (s, i) {
        ports.push({
          id: socketId(id, "out", s),
          x: w,
          y: HEADER_H + i * ROW_H + ROW_H / 2,
          layoutOptions: { "port.side": "EAST" },
        });
      });
      return ports;
    }

    // Boundary banks (the composite's own exposed contract).
    if (spec.inputs && spec.inputs.length) {
      children.push({
        id: IN,
        width: BND_W,
        height: spec.inputs.length * ROW_H,
        layoutOptions: {
          "elk.portConstraints": "FIXED_POS",
          "elk.layered.layering.layerConstraint": "FIRST",
        },
        ports: spec.inputs.map(function (s, i) {
          return {
            id: socketId(IN, "in", s),
            x: BND_W,
            y: i * ROW_H + ROW_H / 2,
            layoutOptions: { "port.side": "EAST" },
          };
        }),
        _bank: "in",
        _sockets: spec.inputs,
      });
    }
    if (spec.outputs && spec.outputs.length) {
      children.push({
        id: OUT,
        width: BND_W,
        height: spec.outputs.length * ROW_H,
        layoutOptions: {
          "elk.portConstraints": "FIXED_POS",
          "elk.layered.layering.layerConstraint": "LAST",
        },
        ports: spec.outputs.map(function (s, i) {
          return {
            id: socketId(OUT, "out", s),
            x: 0,
            y: i * ROW_H + ROW_H / 2,
            layoutOptions: { "port.side": "WEST" },
          };
        }),
        _bank: "out",
        _sockets: spec.outputs,
      });
    }

    // Members.
    body.members.forEach(function (m) {
      var inputs = m.inputs || [], outputs = m.outputs || [];
      var d = cardDims(m.alias, m.system, inputs, outputs);
      children.push({
        id: m.alias,
        width: d.w,
        height: d.h,
        layoutOptions: { "elk.portConstraints": "FIXED_POS" },
        ports: memberPorts(m.alias, inputs, outputs, d.w),
        _member: m,
      });
    });

    // Wires.
    (body.wires || []).forEach(function (w, i) {
      edges.push({
        id: "w" + i,
        kind: w.kind,
        sources: [socketId(w.from.node, w.from.dir, w.from.socket)],
        targets: [socketId(w.to.node, w.to.dir, w.to.socket)],
      });
    });

    return {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "SPLINES",
        "elk.layered.spacing.nodeNodeBetweenLayers": "64",
        "elk.spacing.nodeNode": "30",
        "elk.layered.spacing.edgeNodeBetweenLayers": "22",
        "elk.spacing.edgeEdge": "12",
        "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      },
      children: children,
      edges: edges,
    };
  }

  // ── ELK result → SVG ─────────────────────────────────────────────────────
  // Render the laid-out graph into an <svg>. Returns {svg, bbox, viewport}.
  function renderSvg(laid, rootName, onPick) {
    var members = {}, banks = {};
    laid.children.forEach(function (c) {
      if (c._member) members[c.id] = c;
      else if (c._bank) banks[c.id] = c;
    });

    // Overall bounds of everything ELK placed, then a framed viewBox with room
    // for boundary labels in the left/right margins.
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    laid.children.forEach(function (c) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x + c.width);
      maxY = Math.max(maxY, c.y + c.height);
    });
    var mL = 132, mR = 132, mT = 46, mB = 24;
    var vb = { x: minX - mL, y: minY - mT, w: (maxX - minX) + mL + mR, h: (maxY - minY) + mT + mB };

    var viewport = el("g", { class: "viewport" });
    var svg = el("svg", { xmlns: SVGNS, preserveAspectRatio: "xMidYMid meet" }, [viewport]);

    // composite boundary box + title (skip for a lone leaf card).
    var isComposite = Object.keys(members).length > 1 || Object.keys(banks).length > 0;
    if (isComposite) {
      viewport.appendChild(el("rect", {
        class: "composite-box",
        x: vb.x + 18,
        y: vb.y + 18,
        width: vb.w - 36,
        height: vb.h - 36,
        rx: 14,
      }));
      viewport.appendChild(
        el("text", { class: "card-title", x: vb.x + 36, y: vb.y + 44 }, [
          document.createTextNode(rootName),
        ]),
      );
      var badge = el("text", {
        class: "card-badge",
        x: vb.x + 36,
        y: vb.y + 60,
        opacity: "0.8",
        fill: "var(--muted)",
      }, [document.createTextNode("composite · boundary box")]);
      viewport.appendChild(badge);
    }

    // wires (under the cards).
    var wireEls = [];
    // Centres of "assembly" labels already drawn. Wires sharing a source (a member
    // that fans out to several inputs) have near-coincident midpoints, so their
    // labels would stack into an unreadable smudge — skip any that would overlap
    // one already placed (approx label box: 46×16px).
    var placedLabels = [];
    (laid.edges || []).forEach(function (e) {
      var pts = edgePoints(e);
      if (!pts.length) return;
      var path = el("path", { class: "wire-" + (e.kind || "assembly"), d: smoothPath(pts) });
      path.dataset.edge = e.id;
      viewport.appendChild(path);
      wireEls.push({ path: path, edge: e });
      if (e.kind === "assembly") {
        var mid = pts[Math.floor(pts.length / 2)];
        var lx = mid.x, ly = mid.y - 7;
        var clash = placedLabels.some(function (p) {
          return Math.abs(p.x - lx) < 46 && Math.abs(p.y - ly) < 16;
        });
        if (!clash) {
          placedLabels.push({ x: lx, y: ly });
          viewport.appendChild(
            el("text", { class: "wire-label", x: lx, y: ly, "text-anchor": "middle" }, [
              document.createTextNode("assembly"),
            ]),
          );
        }
      }
    });

    // boundary banks: dots + labels in the margins.
    Object.keys(banks).forEach(function (id) {
      var b = banks[id];
      b.ports.forEach(function (p, i) {
        var px = b.x + p.x, py = b.y + p.y, sys = hue(rootName);
        viewport.appendChild(el("circle", { cx: px, cy: py, r: 5, fill: sys }));
        var isIn = b._bank === "in";
        viewport.appendChild(el("text", {
          class: "bnd-label",
          x: px + (isIn ? -12 : 12),
          y: py + 4,
          "text-anchor": isIn ? "end" : "start",
        }, [document.createTextNode(b._sockets[i])]));
      });
    });

    // member cards.
    var cardEls = {};
    Object.keys(members).forEach(function (id) {
      var c = members[id], m = c._member, col = hue(m.system);
      var g = el("g", { class: "card-g" + (m.status === "missing" ? " card-missing" : "") });
      g.dataset.alias = id;
      var rect = el("rect", {
        class: "card-rect",
        x: c.x,
        y: c.y,
        width: c.width,
        height: c.height,
        rx: 10,
        stroke: col,
        fill: col,
        "fill-opacity": "0.06",
      });
      g.appendChild(rect);
      g.appendChild(
        el("text", { class: "card-title", x: c.x + PAD_X, y: c.y + 22 }, [
          document.createTextNode(m.alias),
        ]),
      );
      g.appendChild(
        el("text", { class: "card-badge", x: c.x + PAD_X, y: c.y + 38, fill: col }, [
          document.createTextNode(m.system || "?"),
        ]),
      );
      g.appendChild(
        el("line", {
          class: "card-div",
          x1: c.x,
          y1: c.y + HEADER_H - 2,
          x2: c.x + c.width,
          y2: c.y + HEADER_H - 2,
        }),
      );

      (m.inputs || []).forEach(function (s, i) {
        var y = c.y + HEADER_H + i * ROW_H + ROW_H / 2;
        g.appendChild(el("circle", { class: "sock-in", cx: c.x, cy: y, r: 4.5 }));
        g.appendChild(
          el("text", { class: "sock-label", x: c.x + 12, y: y + 4 }, [document.createTextNode(s)]),
        );
      });
      (m.outputs || []).forEach(function (s, i) {
        var y = c.y + HEADER_H + i * ROW_H + ROW_H / 2;
        g.appendChild(el("circle", { cx: c.x + c.width, cy: y, r: 4.5, fill: col }));
        g.appendChild(
          el(
            "text",
            { class: "sock-label", x: c.x + c.width - 12, y: y + 4, "text-anchor": "end" },
            [document.createTextNode(s)],
          ),
        );
      });

      g.addEventListener("click", function () {
        onPick(m, g);
      });
      viewport.appendChild(g);
      cardEls[id] = g;
    });

    return { svg: svg, viewport: viewport, bbox: vb, cards: cardEls, wires: wireEls };
  }

  // ── contract drawer ──────────────────────────────────────────────────────
  var drawer;
  function openDrawer(m) {
    var chips = "";
    if (m.front === "external") chips += '<span class="chip">external-facing</span>';
    if (m.blastRadius === "high") chips += '<span class="chip">high blast radius</span>';
    if (m.kind === "composite") chips += '<span class="chip">composite</span>';
    if (m.truncated) chips += '<span class="chip">cycle — not expanded</span>';
    if (m.status && m.status !== "ok") chips += '<span class="chip">' + esc(m.status) + "</span>";

    function socks(list) {
      if (!list || !list.length) return '<span class="sub">none</span>';
      return '<div class="socks">' + list.map(function (s) {
        return '<span class="sk">' + esc(s) + "</span>";
      }).join("") + "</div>";
    }

    drawer.innerHTML = '<button class="close" aria-label="close">✕</button>' +
      "<h2>" + esc(m.alias || m.name || "?") + "</h2>" +
      '<div class="sub mono">' + esc(m.system || "") + "</div>" +
      (chips ? '<div class="chips">' + chips + "</div>" : "") +
      "<dl>" +
      (m.intent ? "<dt>intent</dt><dd>" + esc(m.intent) + "</dd>" : "") +
      "<dt>front</dt><dd>" + esc(m.front || "—") + "</dd>" +
      "<dt>blast&nbsp;radius</dt><dd>" + esc(m.blastRadius || "—") + "</dd>" +
      "<dt>requirements</dt><dd>" + (m.requirements || 0) + "</dd>" +
      "</dl>" +
      '<div class="grp"><h4>inputs</h4>' + socks(m.inputs) + "</div>" +
      '<div class="grp"><h4>outputs</h4>' + socks(m.outputs) + "</div>" +
      (m.file ? '<div class="file">' + esc(m.file) + "</div>" : "");
    drawer.querySelector(".close").addEventListener("click", closeDrawer);
    drawer.classList.add("open");
  }
  function closeDrawer() {
    drawer.classList.remove("open");
  }

  // ── service map (grouped by system across the whole model) ───────────────
  function collectServices(roots) {
    var svc = {}; // system -> { front, blast, scopes:[{name,kind,intent,file}] }
    function add(spec, kind) {
      if (!spec || !spec.system) return;
      var s = svc[spec.system] ||
        (svc[spec.system] = {
          system: spec.system,
          front: spec.front,
          blast: spec.blastRadius,
          scopes: [],
          seen: {},
        });
      var key = spec.file || spec.name;
      if (s.seen[key]) return;
      s.seen[key] = true;
      s.scopes.push({
        name: spec.name || spec.system,
        kind: kind,
        intent: spec.intent,
        file: spec.file,
      });
    }
    function walk(model) {
      add(model.spec, model.kind === "composite" ? "composite" : "leaf");
      if (model.graph) {
        model.graph.members.forEach(function (m) {
          add(m, m.kind === "composite" ? "composite" : "leaf");
          if (m.graph) walk({ spec: m, kind: m.kind, graph: m.graph });
        });
      }
    }
    roots.forEach(walk);
    return Object.keys(svc).map(function (k) {
      return svc[k];
    });
  }

  function renderServices(host, services) {
    host.innerHTML = services.map(function (s) {
      var scopes = s.scopes.map(function (sc) {
        var base = (sc.file || "").split("/").pop().replace(/\.yamlet\.yaml$/, "") || sc.name;
        return '<div class="scope"><div class="scope-file mono">' + esc(base) +
          '<span class="kind ' + sc.kind + '">' + sc.kind + "</span></div>" +
          (sc.intent ? '<div class="scope-sum">' + esc(sc.intent) + "</div>" : "") + "</div>";
      }).join("");
      var n = s.scopes.length;
      return '<div class="svc"><div class="stripe" style="background:' + hue(s.system) +
        '"></div>' +
        '<div class="svc-body"><div class="svc-slug mono">' + esc(s.system) + "</div>" +
        '<div class="svc-meta"><span class="pill">' + n + " scope" + (n === 1 ? "" : "s") +
        "</span>" +
        "<span>" + esc(s.front || "—") + " · " + esc(s.blast || "—") + " blast</span></div>" +
        scopes + "</div></div>";
    }).join("");
  }

  // ── completeness ledger (derived, honest counts) ─────────────────────────
  function renderLedger(host, spec, body) {
    if (!body) {
      host.parentNode.style.display = "none";
      return;
    }
    host.parentNode.style.display = "";
    var wires = body.wires || [];
    var deleg = wires.filter(function (w) {
      return w.kind === "delegation";
    }).length;
    var asm = wires.filter(function (w) {
      return w.kind === "assembly";
    }).length;

    var memberInputs = 0, boundInSet = {};
    body.members.forEach(function (m) {
      memberInputs += (m.inputs || []).length;
    });
    var boundInputsBound = {}; // member input sockets that are a wire target
    wires.forEach(function (w) {
      if (w.to.node !== IN && w.to.node !== OUT && w.to.dir === "in") {
        boundInputsBound[w.to.node + "::" + w.to.socket] = true;
      }
      if (w.from.node === IN) boundInSet[w.from.socket] = true;
    });
    var memberBound = Object.keys(boundInputsBound).length;
    var boundInputs = (spec.inputs || []).length;
    var boundUsed = Object.keys(boundInSet).length;

    function card(h3, big, ok, p) {
      return '<div class="card"><h3>' + h3 + '</h3><div class="big' + (ok ? " ok" : "") + '">' +
        big + "</div><p>" + p + "</p></div>";
    }
    var allBound = memberBound === memberInputs && memberInputs > 0;
    var allUsed = boundUsed === boundInputs;
    host.innerHTML = card(
      "Member inputs bound",
      memberBound + " / " + memberInputs,
      allBound,
      (allBound ? '<span class="check">✓</span> ' : "") +
        "Every member input socket wired to a source (E609).",
    ) +
      card(
        "Boundary inputs used",
        boundUsed + " / " + boundInputs,
        allUsed,
        (allUsed ? '<span class="check">✓</span> ' : "") +
          "Composite inputs that drive at least one member — the rest are dead surface (E506).",
      ) +
      card(
        "Wiring",
        deleg + " + " + asm,
        false,
        deleg + " delegation (boundary ↔ member) + " + asm + " assembly (member → member).",
      ) +
      card(
        "Requirements",
        String(spec.requirements || 0),
        false,
        "Emergent obligations declared on this composite — the behaviour no single wire expresses.",
      );
  }

  // ── page assembly ────────────────────────────────────────────────────────
  function pickView(model) {
    return model.kind === "forest"
      ? { roots: model.roots || [], skipped: model.skipped || [], root: model.root }
      : { roots: [model], skipped: [], root: null };
  }

  // ── scope harvest (every scope, grouped by system) ───────────────────────
  // Walk the (recursively expanded) forest and index every scope by its
  // `system:` slug, deduped by file. A composite scope keeps its `graph` so we
  // can drill into it; a leaf scope has none. This is what lets a level show
  // ALL scopes of a system — the wired one plus its sibling variants. Depends on
  // `-r`: without it, member subtrees aren't expanded, so composite scopes reached
  // only through wiring render as opaque single cards rather than their internals.
  function scopeFromSpec(spec, kind, graph) {
    return {
      system: spec.system,
      file: spec.file,
      name: spec.name,
      topic: spec.topic,
      intent: spec.intent,
      front: spec.front,
      blastRadius: spec.blastRadius,
      requirements: spec.requirements,
      inputs: spec.inputs,
      outputs: spec.outputs,
      status: spec.status,
      kind: kind,
      graph: graph || null,
    };
  }
  function harvest(roots) {
    var bySystem = {}, seen = {};
    function walk(sc) {
      if (!sc.system) return;
      var key = sc.file || sc.name || sc.system;
      if (seen[key]) return; // already indexed — and so is its subtree, so stop
      seen[key] = true;
      (bySystem[sc.system] = bySystem[sc.system] || []).push(sc);
      if (sc.graph) {
        sc.graph.members.forEach(function (m) {
          walk(scopeFromSpec(m, m.kind, m.graph));
        });
      }
    }
    roots.forEach(function (r) {
      walk(scopeFromSpec(r.spec, r.kind, r.graph));
    });
    return bySystem;
  }

  // ── system-keyed drill navigation ────────────────────────────────────────
  // NAV.stack is a breadcrumb of frames; the top frame is the level on screen.
  // A frame names a system (all its scopes are shown together) and the file of
  // the scope reached to get here — marked "entry" at the root, "wired here" once
  // a parent member wired it. `fits` collects each panel's fit-to-view fn.
  var NAV = { bySystem: {}, stack: [], fits: [], gen: 0 };

  function drillFrom(member) {
    // The scope-self card of a leaf panel only inspects — it doesn't point elsewhere.
    if (member._self) return openDrawer(member);
    var targets = NAV.bySystem[member.system] || [];
    var hasMore = targets.length > 1 || targets.some(function (t) {
      return !!t.graph;
    });
    if (hasMore && member.system) {
      NAV.stack.push({ system: member.system, wiredFile: member.file });
      renderLevel();
    } else {
      openDrawer(member); // terminal leaf — nothing deeper to reveal
    }
  }
  function gotoCrumb(i) {
    NAV.stack = NAV.stack.slice(0, i + 1);
    renderLevel();
  }
  function resetTo(system) {
    NAV.stack = [{ system: system, wiredFile: null }];
    renderLevel();
  }

  function renderBreadcrumb() {
    var bc = document.getElementById("breadcrumb");
    if (!bc) return;
    bc.innerHTML = NAV.stack.map(function (fr, i) {
      var last = i === NAV.stack.length - 1;
      return '<button class="crumb' + (last ? " current" : "") + '" data-i="' + i + '">' +
        esc(fr.system) + "</button>" + (last ? "" : '<span class="crumb-sep">›</span>');
    }).join("");
    bc.querySelectorAll(".crumb").forEach(function (b) {
      b.addEventListener("click", function () {
        gotoCrumb(Number(b.dataset.i));
      });
    });
  }

  // A leaf renders as a single card (no boundary box) — reuse the member path.
  // `_self` marks it as the scope itself (not a member wiring out), so a click
  // inspects its contract instead of drilling into its own system again.
  function leafGraph(sc) {
    return buildElk({ inputs: [], outputs: [] }, {
      members: [{
        alias: sc.name || sc.system,
        status: sc.status || "ok",
        kind: sc.kind || "leaf",
        system: sc.system,
        name: sc.name,
        intent: sc.intent,
        front: sc.front,
        blastRadius: sc.blastRadius,
        file: sc.file,
        requirements: sc.requirements,
        inputs: sc.inputs,
        outputs: sc.outputs,
        _self: true,
      }],
      wires: [],
    });
  }

  function renderScopePanel(wrap, sc, frame, gen) {
    var panel = document.createElement("div");
    panel.className = "scope-panel";
    var base = (sc.file || "").split("/").pop().replace(/\.yamlet\.yaml$/, "") ||
      sc.name || sc.system;
    var kind = sc.kind === "composite" ? "composite" : "leaf";
    var badge = frame.wiredFile && sc.file === frame.wiredFile ? "wired here" : "";
    // Per-panel wiring counts — the drill shows several scopes at once, so this
    // stands in for the single-composite ledger, which stays gated in renderLevel.
    var wires = "";
    if (sc.graph) {
      var ws = sc.graph.wires || [];
      var deleg = ws.filter(function (w) {
        return w.kind === "delegation";
      }).length;
      wires = '<span class="panel-wires">' + deleg + " delegation · " +
        (ws.length - deleg) + " assembly</span>";
    }
    var head = document.createElement("div");
    head.className = "panel-head";
    head.innerHTML = '<span class="panel-file mono">' + esc(base) + "</span>" +
      '<span class="kind ' + kind + '">' + kind + "</span>" +
      (badge ? '<span class="wired-badge">' + badge + "</span>" : "") +
      wires +
      (sc.intent ? '<span class="panel-intent">' + esc(sc.intent) + "</span>" : "");
    panel.appendChild(head);
    var holder = document.createElement("div");
    holder.className = "panel-svg";
    panel.appendChild(holder);
    wrap.appendChild(panel);

    var graph = sc.graph ? buildElk(sc, sc.graph) : leafGraph(sc);
    var rootName = sc.name || sc.system || "graph";
    elk.layout(graph).then(function (laid) {
      if (NAV.gen !== gen) return; // a newer level superseded this layout — drop it
      var view = renderSvg(laid, rootName, function (m) {
        drillFrom(m);
      });
      holder.appendChild(view.svg);
      // Size to the graph's aspect so a small diagram doesn't float in a void;
      // cap it so several stacked panels stay navigable.
      var cw = holder.clientWidth || 820;
      var ideal = Math.max(240, Math.min(460, Math.round(cw * view.bbox.h / view.bbox.w) + 32));
      view.svg.style.height = ideal + "px";
      var pz = installPanZoom(view.svg, view.viewport, view.bbox);
      requestAnimationFrame(pz.fit);
      NAV.fits.push(pz.fit);
    });
  }

  function renderLevel() {
    closeDrawer();
    var frame = NAV.stack[NAV.stack.length - 1];
    var scopes = NAV.bySystem[frame.system] || [];
    renderBreadcrumb();

    var note = document.getElementById("wire-note");
    if (note) {
      note.textContent = frame.system + " · " + scopes.length + " scope" +
        (scopes.length === 1 ? "" : "s");
    }

    // keep the service switcher reflecting the level on screen
    var sel = document.getElementById("rootsel");
    if (sel && sel.options.length) sel.value = frame.system;

    var host = document.getElementById("diagram");
    var wrap = host.querySelector(".panels");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "panels";
      host.insertBefore(wrap, host.firstChild);
    }
    wrap.innerHTML = "";
    NAV.fits = [];
    var gen = ++NAV.gen; // stamps this level so stale async layouts can bail
    window.__fit = function () {
      NAV.fits.forEach(function (f) {
        f();
      });
    };

    // Ledger stays honest: only shown when the level is a single composite scope,
    // where its completeness counts are unambiguous.
    var ledger = document.getElementById("ledger");
    if (ledger) {
      if (scopes.length === 1 && scopes[0].graph) {
        ledger.parentNode.style.display = "";
        renderLedger(ledger, scopes[0], scopes[0].graph);
      } else {
        ledger.parentNode.style.display = "none";
      }
    }

    scopes.forEach(function (sc) {
      renderScopePanel(wrap, sc, frame, gen);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    drawer = document.getElementById("panel");
    var view = pickView(MODEL);
    var first = view.roots[0];
    if (!first) {
      document.getElementById("title").textContent = "empty graph";
      return;
    }

    // header copy.
    var name = first.spec.topic || first.spec.system || "graph";
    document.getElementById("eyebrow").textContent = "yamlet · " +
      (view.root ? view.root.split("/").pop() : (first.spec.system || "graph"));
    document.getElementById("title").textContent = name + " — " +
      (MODEL.kind === "forest"
        ? "systems & composition"
        : (first.kind === "composite" ? "composition" : "contract"));
    var nroots = view.roots.length;
    document.getElementById("lede").textContent = MODEL.kind === "forest"
      ? nroots + " root spec" + (nroots === 1 ? "" : "s") + " expanded from " + (view.root || ".") +
        ". Drill by system: each level shows every scope that shares a system: slug — the wired one and its sibling variants. Click a member to descend, the breadcrumb to climb back."
      : (first.spec.intent || "A single component contract.");

    // service map.
    renderServices(document.getElementById("services"), collectServices(view.roots));

    // scope index for the drill.
    NAV.bySystem = harvest(view.roots);

    // service switcher — every system is an entry point, leaf or composite, so a
    // single simple service can be viewed on its own, not only by drilling into a
    // composite. Selecting one resets the drill to that system's level.
    var sel = document.getElementById("rootsel");
    var systems = Object.keys(NAV.bySystem);
    if (MODEL.kind === "forest" && systems.length > 1) {
      systems.forEach(function (sysName) {
        var n = NAV.bySystem[sysName].length;
        var o = document.createElement("option");
        o.value = sysName;
        o.textContent = sysName + " · " + n + " scope" + (n === 1 ? "" : "s");
        sel.appendChild(o);
      });
      sel.style.display = "";
      sel.addEventListener("change", function () {
        resetTo(sel.value);
      });
    }

    // skipped-files footnote.
    if (view.skipped.length) {
      var foot = document.getElementById("foot");
      foot.innerHTML += " <strong>Skipped:</strong> " + view.skipped.map(function (k) {
        return esc((k.file || "").split("/").pop()) + " (" + esc(k.reason) + ")";
      }).join(", ") + ".";
    }

    // controls.
    document.getElementById("fit").addEventListener("click", function () {
      if (window.__fit) window.__fit();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });

    resetTo(first.spec.system);
  });
})();
