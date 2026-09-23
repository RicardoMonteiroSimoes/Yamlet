/* yamlet viewer common — helpers shared by the graph viewer (viewer.js) and the
   trace viewer (trace.js). Inlined into the page before either, it publishes one
   global, `window.YamletViewer`; each viewer aliases what it uses. Pure helpers
   only: no page layout, no model knowledge. */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";

  // ── per-service colour assignment ───────────────────────────────────────
  // Distinct hues that read on both light and dark grounds. Assigned by stable
  // order of first appearance so a service keeps its colour across re-renders.
  var HUES = [
    "#6366f1",
    "#d97706",
    "#0d9488",
    "#e11d48",
    "#7c3aed",
    "#0284c7",
    "#65a30d",
    "#db2777",
    "#0891b2",
    "#ca8a04",
  ];
  var hueBySystem = {};
  function hue(system) {
    if (!(system in hueBySystem)) {
      hueBySystem[system] = HUES[Object.keys(hueBySystem).length % HUES.length];
    }
    return hueBySystem[system];
  }

  // ── text measurement (canvas) for card sizing ───────────────────────────
  var _ctx = document.createElement("canvas").getContext("2d");
  function measure(text, font) {
    _ctx.font = font;
    return _ctx.measureText(String(text || "")).width;
  }

  // ── small DOM helpers ────────────────────────────────────────────────────
  function el(tag, attrs, kids) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) {
      n.appendChild(c);
    });
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ── ELK edge → smooth SVG path ─────────────────────────────────────────
  function smoothPath(pts) {
    if (pts.length < 2) return "";
    if (pts.length === 2) return "M" + pts[0].x + "," + pts[0].y + "L" + pts[1].x + "," + pts[1].y;
    // Catmull-Rom → cubic bezier for a flowing wire through the ELK points.
    var d = "M" + pts[0].x + "," + pts[0].y;
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      var c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
      var c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
      d += "C" + c1x + "," + c1y + " " + c2x + "," + c2y + " " + p2.x + "," + p2.y;
    }
    return d;
  }
  function edgePoints(edge) {
    var s = edge.sections && edge.sections[0];
    if (!s) return [];
    return [s.startPoint].concat(s.bendPoints || [], [s.endPoint]);
  }

  // ── pan / zoom (group transform) ─────────────────────────────────────────
  // `minScale` (optional) is a floor for `open()`: a graph too big to read at
  // fit opens at that scale, anchored top-left, and `fit()` still shows it all.
  function installPanZoom(svg, viewport, bbox, minScale) {
    var t = { x: 0, y: 0, k: 1 };
    function apply() {
      viewport.setAttribute("transform", "translate(" + t.x + "," + t.y + ") scale(" + t.k + ")");
    }
    function fit() {
      var r = svg.getBoundingClientRect();
      var k = Math.min(r.width / bbox.w, r.height / bbox.h) * 0.94;
      t.k = k;
      t.x = (r.width - bbox.w * k) / 2 - bbox.x * k;
      t.y = (r.height - bbox.h * k) / 2 - bbox.y * k;
      apply();
    }
    function open() {
      fit();
      if (!minScale || t.k >= minScale) return;
      t.k = minScale;
      t.x = 12 - bbox.x * t.k;
      t.y = 12 - bbox.y * t.k;
      apply();
    }
    svg.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = svg.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;
      var f = Math.exp(-e.deltaY * 0.0015), nk = Math.min(4, Math.max(0.05, t.k * f));
      var g = nk / t.k;
      t.x = mx - (mx - t.x) * g;
      t.y = my - (my - t.y) * g;
      t.k = nk;
      apply();
    }, { passive: false });
    // Capture the pointer only once it has actually moved: capturing on
    // pointerdown retargets the click to the <svg>, so a card under the pointer
    // would never see it. A press that stays put is a click, not a pan.
    var drag = null;
    svg.addEventListener("pointerdown", function (e) {
      drag = { x: e.clientX, y: e.clientY, tx: t.x, ty: t.y, id: e.pointerId, moved: false };
    });
    svg.addEventListener("pointermove", function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved) {
        if (dx * dx + dy * dy < 16) return;
        drag.moved = true;
        svg.classList.add("grabbing");
        svg.setPointerCapture(drag.id);
      }
      t.x = drag.tx + dx;
      t.y = drag.ty + dy;
      apply();
    });
    function end() {
      drag = null;
      svg.classList.remove("grabbing");
    }
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);
    return { fit: fit, open: open };
  }

  window.YamletViewer = {
    SVGNS: SVGNS,
    HUES: HUES,
    hue: hue,
    measure: measure,
    el: el,
    esc: esc,
    smoothPath: smoothPath,
    edgePoints: edgePoints,
    installPanZoom: installPanZoom,
  };
})();
