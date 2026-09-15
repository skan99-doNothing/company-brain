/**
 * The brain, drawn as a graph you can turn.
 *
 * Obsidian's graph view is 2D. This one is not, and it is written from scratch
 * rather than pulled from a CDN, because the rest of this repo has no
 * dependencies and a force layout plus a perspective projection is about two
 * hundred lines.
 *
 * How it works. Every node gets a position in 3D. Each frame applies three
 * forces: a repulsion between nodes so they do not collapse, a spring along
 * every edge so linked notes pull together, and a weak pull to the origin so
 * the whole thing does not drift off screen. Repulsion is the expensive part,
 * so it is sampled rather than computed against all pairs: with 600 nodes the
 * exact version is 180,000 comparisons a frame and the sampled one looks the
 * same.
 *
 * Then the points are rotated by the current drag angles, projected with a
 * simple perspective divide, sorted back to front, and drawn to a 2D canvas.
 * Depth becomes opacity and size, which is what makes it read as 3D.
 */

const TAU = Math.PI * 2;

/* How far a node is allowed to move in one frame. Two nodes landing on the same
   point is not rare, and the repulsion term hands the second one a velocity of
   26,000: a frame later it is five thousand units away and it never properly
   comes back. On the real link table that happened inside the first twenty
   frames every time. */
const MAX_STEP = 60;

/* The near plane. A node that drifts in front of the camera used to project at
   7.5x, which is a blob the size of the panel and, worse, a single point that
   the autofit then has to solve for. */
const NEAR = 320;

/* Where the ninetieth percentile of the cloud should sit, as a fraction of half
   the frame. Leaves the outer tenth of nodes room to run off the edge. */
const FRAME = 0.82;

// A colour per department id, so a node's department is readable at a glance.
// Add your own ids here; anything missing falls back to the neutral grey below.
const DEPT_COLOR = {
  growth: "#9B8CC4",
  product: "#4FB88A",
  revenue: "#D98CC4",
  memory: "#6FC6D6",
};

export function createGraph(canvas, opts = {}) {
  const ctx = canvas.getContext("2d");

  let nodes = [];
  let edges = [];
  let byId = new Map();

  let yaw = 0.6;
  let pitch = -0.25;
  let zoom = 1;                   // what the wheel controls
  let fit = 1;                    // what keeps the cloud inside the frame
  let overflow = 0;               // how far past the frame the last projection went
  let spin = 0.0012;              // a slow idle rotation, stopped while dragging
  let dragging = false;
  let lastX = 0, lastY = 0;
  let hover = null;
  let selected = null;
  let raf = null;
  let alpha = 1;                  // simulated annealing: motion decays to stillness
  let labelCut = Infinity;        // the degree at which a node earns a standing label

  const onSelect = opts.onSelect || (() => {});

  /* ------------------------------------------------------------- layout -- */

  function seed(rawNodes, rawEdges) {
    byId = new Map();
    nodes = rawNodes.map((n, i) => {
      // Start on a sphere rather than at random, so the first few frames
      // untangle instead of exploding.
      const phi = Math.acos(1 - 2 * (i + 0.5) / rawNodes.length);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 150 + rawNodes.length * 0.55;
      const node = {
        ...n,
        x: r * Math.sin(phi) * Math.cos(theta),
        y: r * Math.sin(phi) * Math.sin(theta),
        z: r * Math.cos(phi),
        vx: 0, vy: 0, vz: 0,
        radius: 2.2 + Math.min(7, Math.sqrt(n.degree || 0) * 1.5),
        color: DEPT_COLOR[n.department] || "#6b7288",
      };
      byId.set(n.id, node);
      return node;
    });
    edges = rawEdges
      .map(([a, b]) => [byId.get(a), byId.get(b)])
      .filter(([a, b]) => a && b);

    // Only the top of the degree distribution gets a permanent label. A fixed
    // cut looked fine on one department and buried the canvas on all of them.
    const sorted = [...nodes].map((p) => p.degree || 0).sort((a, b) => b - a);
    labelCut = sorted[Math.min(sorted.length - 1, 24)] ?? 0;
    alpha = 1;
  }

  function step() {
    if (alpha < 0.005) return;
    const n = nodes.length;
    if (!n) return;

    const repulsion = 26_000;
    const sample = Math.min(n - 1, 30);

    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let s = 0; s < sample; s++) {
        const b = nodes[(i + 1 + ((Math.random() * (n - 1)) | 0)) % n];
        if (a === b) continue;
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; dz = Math.random() - 0.5; d2 = 1; }
        const f = repulsion / d2;
        const d = Math.sqrt(d2);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f; a.vz += (dz / d) * f;
      }
      // Everything drifts home, so a disconnected node still has a place.
      a.vx -= a.x * 0.0009; a.vy -= a.y * 0.0009; a.vz -= a.z * 0.0009;
    }

    for (const [a, b] of edges) {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const f = (d - 150) * 0.004;
      const ux = (dx / d) * f, uy = (dy / d) * f, uz = (dz / d) * f;
      a.vx += ux; a.vy += uy; a.vz += uz;
      b.vx -= ux; b.vy -= uy; b.vz -= uz;
    }

    // Capped, so one collision cannot throw a node clear of the cloud for good.
    // It costs nothing while the layout is behaving.
    for (const p of nodes) {
      const v = Math.sqrt(p.vx * p.vx + p.vy * p.vy + p.vz * p.vz);
      const k = v > MAX_STEP ? MAX_STEP / v : 1;
      p.x += p.vx * k * alpha; p.y += p.vy * k * alpha; p.z += p.vz * k * alpha;
      p.vx *= 0.82; p.vy *= 0.82; p.vz *= 0.82;
    }
    alpha *= 0.993;
  }

  /* ------------------------------------------------------------ drawing -- */

  function project(p, w, h) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const x1 = p.x * cy - p.z * sy;
    const z1 = p.x * sy + p.z * cy;
    const y1 = p.y * cp - z1 * sp;
    const z2 = p.y * sp + z1 * cp;
    const depth = 900 + z2;
    const scale = (900 / Math.max(NEAR, depth)) * zoom * fit;
    return { sx: w / 2 + x1 * scale, sy: h / 2 + y1 * scale, scale, z: z2 };
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    // A frame drawn while the panel is still hidden measures a zero width
    // canvas, and every overflow ratio below is then a divide by zero that
    // poisons the fit for every frame after it.
    if (!w || !h) return;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr; canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!dragging) yaw += spin;

    // The cloud's size depends on node count and on how far the layout has
    // spread, so a fixed zoom either crops it or leaves it a dot. Fit it to the
    // frame every frame, and let the wheel multiply that rather than replace it.
    // Measured on the previous frame's projection rather than on world
    // coordinates, because perspective makes the near half of the cloud larger
    // than its radius suggests and a world-space estimate always crops.
    if (overflow > 0) {
      const want = Math.max(0.05, Math.min(12, fit * (FRAME / overflow)));
      // Out fast, in slowly. A spike that clips the cloud for half a second is
      // worth fixing quickly; the opposite correction, applied at the same
      // speed, makes the frame breathe every time the idle spin swings a far
      // node toward the camera.
      fit += (want - fit) * (want < fit ? 0.25 : 0.06);
    }

    const points = nodes.map((p) => ({ p, ...project(p, w, h) }));
    const proj = new Map(points.map((q) => [q.p, q]));

    ctx.lineWidth = 1;
    for (const [a, b] of edges) {
      const qa = proj.get(a), qb = proj.get(b);
      const near = (qa.scale + qb.scale) / 2;
      const lit = selected && (a.id === selected || b.id === selected);
      ctx.strokeStyle = lit
        ? "rgba(232,163,61,.55)"
        : `rgba(120,132,168,${Math.min(0.16, near * 0.09)})`;
      ctx.beginPath();
      ctx.moveTo(qa.sx, qa.sy);
      ctx.lineTo(qb.sx, qb.sy);
      ctx.stroke();
    }

    // Back to front, so near nodes sit on top of the ones behind them.
    points.sort((a, b) => b.z - a.z);
    for (const q of points) {
      const r = Math.max(1, q.p.radius * q.scale);
      const fade = Math.min(1, Math.max(0.22, q.scale * 0.85));
      const isHit = q.p.id === selected || q.p === hover;
      ctx.globalAlpha = isHit ? 1 : fade;
      ctx.fillStyle = q.p.color;
      if (isHit) {
        ctx.shadowColor = q.p.color;
        ctx.shadowBlur = 18;
      }
      ctx.beginPath();
      ctx.arc(q.sx, q.sy, isHit ? r * 1.5 : r, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
      q.r = r;
    }
    ctx.globalAlpha = 1;

    // Only the big nodes get a label, otherwise it is unreadable.
    ctx.font = "11px ui-monospace, Consolas, monospace";
    ctx.textAlign = "center";
    for (const q of points) {
      const big = q.p.degree >= labelCut || q.p === hover || q.p.id === selected;
      if (!big || q.scale < 0.55) continue;
      ctx.fillStyle = q.p === hover || q.p.id === selected ? "#e7e9f0" : "rgba(231,233,240,.45)";
      ctx.fillText(q.p.title.slice(0, 34), q.sx, q.sy - q.r - 6);
    }

    /*
     * How far outside the frame this projection landed, as a ratio. The next
     * frame divides it back in.
     *
     * The ninetieth percentile rather than the furthest point, which is what
     * this used to take and what made the graph a dot in the middle of the
     * canvas. On the real link table the furthest projected node sits between
     * five and nine times the median, so solving for it put every other node
     * inside a tenth of the frame. A percentile ignores the handful of fliers
     * and frames what there is to look at. The fliers still get drawn. They
     * just run off the edge, which is the correct place for them.
     */
    const spread = points
      .map((q) => Math.max(
        Math.abs(q.sx - w / 2) / (w / 2),
        Math.abs(q.sy - h / 2) / (h / 2),
      ))
      .sort((a, b) => a - b);
    overflow = spread[Math.floor((spread.length - 1) * 0.9)] || 0;

    lastPoints = points;
  }

  let lastPoints = [];

  function frame() {
    step();
    draw();
    raf = requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------- input -- */

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    let best = null, bestD = 16;
    for (const q of lastPoints) {
      const d = Math.hypot(q.sx - x, q.sy - y);
      if (d < Math.max(bestD, q.r + 4)) { best = q.p; bestD = d; }
    }
    return best;
  }

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (dragging) {
      yaw += (e.clientX - lastX) * 0.006;
      pitch += (e.clientY - lastY) * 0.006;
      pitch = Math.max(-1.4, Math.min(1.4, pitch));
      lastX = e.clientX; lastY = e.clientY;
      return;
    }
    const hit = pick(e);
    if (hit !== hover) {
      hover = hit;
      canvas.style.cursor = hit ? "pointer" : "grab";
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    dragging = false;
    const moved = Math.hypot(e.clientX - lastX, e.clientY - lastY);
    if (moved < 4) {
      const hit = pick(e);
      selected = hit ? hit.id : null;
      onSelect(hit || null);
    }
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoom = Math.max(0.25, Math.min(4, zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
  }, { passive: false });

  /* -------------------------------------------------------------- api -- */

  return {
    load(data) {
      seed(data.nodes, data.edges);
      selected = null;
      if (!raf) frame();
    },
    stop() { if (raf) cancelAnimationFrame(raf); raf = null; },
    reheat() { alpha = 1; },
    setSpin(on) { spin = on ? 0.0012 : 0; },
    colors: DEPT_COLOR,
  };
}
