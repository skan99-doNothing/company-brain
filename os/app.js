/**
 * The OS front end.
 *
 * No framework and no build. Every panel is a fetch against bin/os.mjs and a
 * render into a section that already exists in the markup, which keeps the whole
 * client readable in one sitting and means a broken panel never takes the rest
 * of the window with it.
 */

import { createGraph } from "./graph.js";
import { bootAgents, loadAgents, reveal } from "./agents.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const api = async (path, body) => {
  const res = await fetch(path, body
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({ error: "bad response" }));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const short = (p) => String(p ?? "").replace(/^.*[\\/](?=(?:vaults|departments|state)[\\/])/, "");

const ago = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

/* ---------------------------------------------------------- navigation -- */

const TITLES = {
  overview: ["Overview", "what is up, what is indexed, what is running"],
  brain: ["Brain", "semantic search over every linked vault"],
  graph: ["Graph", "every note as a node, every wikilink as an edge"],
  chat: ["Agents", "Claude, ChatGPT and the box, all on plans you already pay for"],
  sessions: ["Sessions", "what Claude and Codex actually did"],
  dept: ["Department", ""],
  server: ["Server", "your box, if you have one, and the timers on it"],
  jobs: ["Jobs", "anything this window spawned"],
};

let current = "overview";
let currentDept = null;

function bindNav() {
  $$(".nav-item").forEach((b) => {
    if (b.dataset.bound) return;
    b.dataset.bound = "1";
    b.addEventListener("click", () => show(b.dataset.view, b.dataset.dept));
  });
}

function show(view, dept) {
  /* A name with no section behind it used to hide every view and leave the
     window blank with no way back except a reload. Anything can reach this:
     her table said "agents" and the section is called view-chat. */
  if (!document.getElementById(`view-${view}`)) {
    console.warn(`no view called ${view}`);
    return;
  }
  current = view;
  currentDept = dept || null;
  $$(".nav-item").forEach((b) =>
    b.classList.toggle("on", b.dataset.view === view && (b.dataset.dept || null) === currentDept));
  $$(".view").forEach((s) => { s.hidden = s.id !== `view-${view}`; });
  const [title, sub] = TITLES[view] || [view, ""];
  $("#view-title").textContent = view === "dept" ? (deptById(dept)?.name || "Department") : title;
  $("#view-sub").textContent = view === "dept" ? (deptById(dept)?.mission || "") : sub;
  load(view, view === "dept");
}

bindNav();
$("#btn-refresh").addEventListener("click", () => { health(); load(current, true); });

/* --------------------------------------------------------- departments -- */

/**
 * The eight departments in org.config.json are the real structure of this
 * company, so they are the primary navigation rather than a settings screen.
 * Everything else in the rail is a surface that one of them uses.
 */
let DEPTS = [];

const deptById = (id) => DEPTS.find((d) => d.id === id);

// A glyph per department id for the nav rail. Anything missing gets a dot.
const ICONS = {
  growth: "▲", product: "⬢", revenue: "◈", memory: "✧",
};

async function loadConfig() {
  try {
    const { departments } = await api("/api/config");
    DEPTS = departments || [];
  } catch {
    DEPTS = [];
  }

  $("#dept-nav").innerHTML = DEPTS.map((d) => `
    <button class="nav-item" data-view="dept" data-dept="${esc(d.id)}">
      <span class="nav-ico" style="color:${esc(d.color || "#9aa2b8")}">${ICONS[d.id] || "•"}</span>
      ${esc(d.name)}
      ${d.gaps.length ? `<span class="nav-badge">${d.gaps.length}</span>` : ""}
    </button>`).join("");
  bindNav();

  const sel = $("#dept");
  sel.innerHTML = `<option value="">every department</option>` +
    DEPTS.map((d) => `<option value="${esc(d.id)}">${esc(d.id)}</option>`).join("");
}

function renderDept() {
  const d = deptById(currentDept);
  const box = $("#dept-body");
  if (!d) {
    box.innerHTML = `<div class="empty">No department selected.</div>`;
    return;
  }
  box.innerHTML = `
    <div class="grid g2">
      <div class="card">
        <h3>Where the work lives</h3>
        ${d.paths.length
          ? d.paths.map((p) => `<div class="hit-path" style="padding:4px 0">${esc(short(p))}</div>`).join("")
          : `<div class="empty">No paths declared in org.config.json.</div>`}
      </div>
      <div class="card">
        <h3>Open gaps</h3>
        ${d.gaps.length
          ? d.gaps.map((g) => `<div class="timer-row"><span class="swatch" style="background:${esc(d.color || "#e8a33d")}"></span> ${esc(g)}</div>`).join("")
          : `<div class="empty">Nothing marked as a gap.</div>`}
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="row">
        <input type="search" id="dept-q" class="grow" placeholder="search only ${esc(d.name)}">
        <button class="btn primary" id="dept-go">Search</button>
      </div>
      <div class="stat-note" style="margin-top:11px">
        Same retrieval as the Brain panel, filtered to this department.
      </div>
    </div>`;

  const go = () => {
    const q = $("#dept-q").value.trim();
    if (!q) return;
    show("brain");
    $("#q").value = q;
    $("#dept").value = d.id;
    search();
  };
  $("#dept-go").addEventListener("click", go);
  $("#dept-q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

/* -------------------------------------------------------------- agents -- */

/*
 * The Agents panel moved into its own file when it grew a thread list, a file
 * tree and a preview pane. Everything it needs from here is passed in, same as
 * the shell, so there is no import cycle between the two.
 */

/* -------------------------------------------------------------- health -- */

function probe(name, result) {
  const dot = $(`#dot-${name}`);
  const ms = $(`#ms-${name}`);
  dot.className = "dot " + (result?.ok ? "up" : "down");
  ms.textContent = result ? `${result.ms}ms` : "";
  dot.title = result?.ok ? String(result.value) : String(result?.error || "unknown");
}

let lastHealth = null;

async function health() {
  try {
    const h = await api("/api/health");
    lastHealth = h;
    probe("supabase", h.supabase);
    probe("ollama", h.ollama);
    probe("vps", h.vps);
    renderTiles(h);
    if (current === "server") renderServer(h);
  } catch (err) {
    $("#stat-tiles").innerHTML = `<div class="card"><div class="bad">${esc(err.message)}</div></div>`;
  }
}

function renderTiles(h) {
  const b = h.brain?.[0] ?? h.brain ?? null;
  const tile = (label, value, unit, note) => `
    <div class="card">
      <h3>${esc(label)}</h3>
      <div class="stat">${esc(value)}<span class="unit">${esc(unit || "")}</span></div>
      <div class="stat-note">${note || ""}</div>
    </div>`;

  if (!b) {
    $("#stat-tiles").innerHTML = tile("Brain", "offline", "", esc(h.brainError || "no stats"));
    return;
  }
  const broken = b.broken ?? 0;
  $("#stat-tiles").innerHTML = [
    tile("Documents", (b.documents ?? 0).toLocaleString(), "", `${(b.passages ?? 0).toLocaleString()} passages`),
    tile("Vaults", b.vaults ?? 0, "", `${b.folders ?? 0} folders`),
    tile("Sessions", (b.sessions ?? 0).toLocaleString(), "", "Claude and Codex, one table"),
    tile("Links", (b.wikilinks ?? 0).toLocaleString(), "",
      broken ? `<span class="warn">${broken.toLocaleString()} point at nothing indexed</span>` : "all resolved"),
    tile("Newest", b.newest ?? "unknown", "", "most recent document mtime"),
    tile("VPS", h.vps.ok ? "up" : "down", "",
      h.vps.ok ? esc(String(h.vps.value)) : `<span class="bad">${esc(h.vps.error || "")}</span>`),
  ].join("");
}

/* --------------------------------------------------------------- brain -- */

/**
 * Questions that a panel answers better than a passage does.
 *
 * Retrieval returns the chunk that reads most like the question, which for
 * "how many clients do I owe a build" is a chunk mentioning clients, not a
 * count. Where a real view exists, offer it above the hits rather than instead
 * of them: the search still runs, and the number comes from the roster.
 */
// Queries that deserve a view rather than a list of passages. Add your own:
// a regex, the view it should open, and one line saying where the number on
// that view actually comes from.
const INTENTS = [];

async function search() {
  const q = $("#q").value.trim();
  if (!q) return;
  const box = $("#brain-results");

  const intent = INTENTS.find((i) => i.test.test(q));
  const banner = intent
    ? `<div class="banner ok" style="margin-bottom:14px">
         <strong>There is a view for this.</strong> ${esc(intent.why)}.
         <button class="btn" style="margin-left:10px" data-goto="${esc(intent.view)}">${esc(intent.label)}</button>
       </div>`
    : "";
  box.innerHTML = `<div class="empty">Embedding the question, then asking Postgres.</div>`;
  try {
    const { hits } = await api("/api/search", { q, department: $("#dept").value, k: 12 });
    if (!hits.length) {
      box.innerHTML = banner +
        `<div class="empty">Nothing came back. Either it is not written down, or it is not indexed yet.</div>`;
      bindGoto();
      return;
    }
    box.innerHTML = banner + hits.map((h) => `
      <div class="hit">
        <div class="hit-top">
          <span class="hit-title">${esc(h.title || "untitled")}</span>
          ${h.department ? `<span class="tag">${esc(h.department)}</span>` : ""}
          <span class="score">${Number(h.score ?? 0).toFixed(3)}</span>
        </div>
        <div class="hit-path">${esc(short(h.source_path))}</div>
        <div class="hit-body">${esc((h.content || "").slice(0, 420))}</div>
      </div>`).join("");
    bindGoto();
  } catch (err) {
    box.innerHTML = banner + `<div class="empty bad">${esc(err.message)}</div>`;
    bindGoto();
  }
}

function bindGoto() {
  $$("[data-goto]").forEach((b) =>
    b.addEventListener("click", () => show(b.dataset.goto)));
}

$("#btn-search").addEventListener("click", search);
$("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });

/* ------------------------------------------------------------ sessions -- */

/**
 * A session as a case file.
 *
 * The backfill already records what each one touched and what it left open, and
 * that is the interesting part: a summary tells you what happened, a file list
 * tells you where to pick it up. Both are folded away until you look at the
 * card, because twenty sessions with their contents spilled out is a wall.
 *
 * Every file is a click from Explorer, same as everywhere else in here.
 */
const fileTail = (p) => String(p).split(/[\\/]/).pop();

/* A scratchpad path is the model's own workings, not his project. Worth keeping
   in the count, not worth putting at the top of the list. */
const isScratch = (p) => /[\\/](scratchpad|Temp)[\\/]/i.test(p);

function dossier(s) {
  const dept = deptById(s.department);
  const tint = dept?.color || "#9aa2b8";
  const files = (s.files_touched || []).slice().sort((a, b) => isScratch(a) - isScratch(b));
  const open = s.open_threads || [];

  return `<article class="dossier" tabindex="0" style="--tint:${esc(tint)}">
    <span class="dossier-spine"></span>
    <span class="dossier-tab"><i></i>${esc(s.department || "unrouted")}</span>

    <div class="dossier-head">
      <span class="dossier-src">${esc(s.source || "claude")}</span>
      <span class="dossier-when">${esc(ago(s.started_at))}</span>
    </div>
    ${s.cwd ? `<div class="dossier-where" data-reveal="${esc(s.cwd)}"
      title="Open this folder">${esc(short(s.cwd))}</div>` : ""}
    <div class="dossier-sum">${esc(s.summary || "No summary was written for this one.")}</div>
    <div class="dossier-counts">
      <span><b>${files.length}</b> files</span>
      <span><b>${open.length}</b> left open</span>
    </div>

    <div class="dossier-open"><div>
      ${files.length ? `<div class="dossier-sec">
        <h5>Touched</h5>
        ${files.slice(0, 8).map((f) => `
          <div class="dossier-file" data-reveal="${esc(f)}" title="${esc(f)}">
            <span>${esc(fileTail(f))}</span><em>show</em>
          </div>`).join("")}
        ${files.length > 8 ? `<div class="dossier-thread">and ${files.length - 8} more</div>` : ""}
      </div>` : ""}
      ${open.length ? `<div class="dossier-sec">
        <h5>Left open</h5>
        ${open.slice(0, 5).map((t) => `<div class="dossier-thread">${esc(t)}</div>`).join("")}
      </div>` : ""}
    </div></div>
  </article>`;
}

async function loadSessions() {
  const box = $("#session-list");
  try {
    const { sessions } = await api("/api/sessions?limit=20");
    if (!sessions.length) {
      box.innerHTML = `<div class="empty">No sessions recorded yet.</div>`;
      return;
    }
    box.innerHTML = sessions.map(dossier).join("");
    box.onclick = (e) => {
      const el = e.target.closest("[data-reveal]");
      if (el) reveal(el.dataset.reveal, true);
    };
  } catch (err) {
    box.innerHTML = `<div class="empty bad">${esc(err.message)}</div>`;
  }
}

/* --------------------------------------------------------------- graph -- */

let graph = null;
let graphLoaded = false;

async function loadGraph(force = false) {
  if (!graph) {
    graph = createGraph($("#graph-canvas"), {
      onSelect(node) {
        const card = $("#graph-card");
        if (!node) { card.hidden = true; return; }
        card.hidden = false;
        card.innerHTML = `
          <h4>${esc(node.title)}</h4>
          <div class="meta">
            ${node.department ? `department ${esc(node.department)}<br>` : ""}
            ${node.vault ? `vault ${esc(node.vault)}<br>` : ""}
            ${node.degree} link${node.degree === 1 ? "" : "s"}
          </div>`;
      },
    });

    $("#graph-reheat").addEventListener("click", () => graph.reheat());
    $("#graph-spin").addEventListener("change", (e) => graph.setSpin(e.target.checked));
    $("#graph-dept").addEventListener("change", () => loadGraph(true));
    $("#graph-limit").addEventListener("change", () => loadGraph(true));

    $("#graph-legend").innerHTML = Object.entries(graph.colors)
      .map(([name, hex]) => `<span><i style="background:${hex}"></i>${esc(name)}</span>`).join("");
  }

  if (graphLoaded && !force) return;
  $("#graph-note").textContent = "reading the link table";
  try {
    const dept = $("#graph-dept").value;
    const limit = $("#graph-limit").value;
    const data = await api(`/api/graph?dept=${encodeURIComponent(dept)}&limit=${limit}`);

    const sel = $("#graph-dept");
    if (sel.options.length <= 1) {
      sel.innerHTML = `<option value="">every department</option>` +
        data.departments.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
      sel.value = dept;
    }

    $("#graph-card").hidden = true;
    $("#graph-note").textContent =
      `${data.shown.toLocaleString()} of ${data.totals.documents.toLocaleString()} documents, ` +
      `${data.edges.length.toLocaleString()} of ${data.totals.links.toLocaleString()} links drawn`;
    graph.load(data);
    graphLoaded = true;
  } catch (err) {
    $("#graph-note").textContent = err.message;
  }
}

/* -------------------------------------------------------------- server -- */

/**
 * The timers you expect to be running on your box.
 *
 * A hand-kept list rather than a live systemctl read, so the panel still says
 * something useful when the server is not answering. Fill it in with your own
 * units, or leave it empty and the panel simply shows nothing to compare.
 *
 *   ["unit-name", "when it runs", "which app it belongs to"]
 */
const TIMERS = [];

function renderServer(h) {
  const up = h?.vps?.ok;
  $("#vps-banner").innerHTML = `
    <div class="banner ${up ? "ok" : ""}">
      <strong>${up ? "The box is answering." : "The box is not answering."}</strong><br>
      ${up
        ? `HTTPS on ${esc(h.vps.host)} returned ${esc(String(h.vps.value))} in ${h.vps.ms}ms.`
        : `Nothing on 443 at ${esc(h.vps.host)} after ${h.vps.ms}ms. Caddy answers even with
           zero model credit, so this is the machine, not a spent token budget.
           Every timer below is therefore not running.`}
    </div>`;
  $("#timer-list").innerHTML = TIMERS.map(([name, sched, project]) => `
    <div class="timer-row">
      <code>${esc(name)}</code>
      <span class="tag">${esc(project)}</span>
      <span class="sched">${esc(sched)}</span>
    </div>`).join("");
}

/* ---------------------------------------------------------------- jobs -- */

/** Poll one job until it stops, painting its output into a target element. */
function follow(id, target, done) {
  const el = $(target);
  const tick = async () => {
    try {
      const job = await api(`/api/job?id=${encodeURIComponent(id)}`);
      el.textContent = job.out || "(no output yet)";
      el.scrollTop = el.scrollHeight;
      if (job.state === "running") return setTimeout(tick, 1400);
      el.textContent = (job.out || "") + `\n[${job.state}, exit ${job.code}]`;
      done?.(job);
      loadJobs();
    } catch (err) {
      el.textContent = err.message;
      done?.(null);
    }
  };
  tick();
}

async function loadJobs() {
  try {
    const { jobs } = await api("/api/jobs");
    $("#job-count").textContent = jobs.length ? String(jobs.length) : "";
    const html = jobs.length
      ? jobs.map((j) => `
        <div class="job" data-id="${esc(j.id)}">
          <span class="dot ${j.state === "done" ? "up" : j.state === "running" ? "" : "down"}"></span>
          <span>${esc(j.label)}</span>
          <span class="when">${esc(ago(j.started))}</span>
        </div>`).join("")
      : `<div class="empty">Nothing run yet this session.</div>`;
    $("#job-list").innerHTML = html;
    $("#overview-jobs").innerHTML = html;
    $$(".job").forEach((el) => el.addEventListener("click", () => {
      show("jobs");
      follow(el.dataset.id, "#job-out");
    }));
  } catch {
    /* the jobs panel is a convenience, not worth an error banner */
  }
}

$$("[data-run]").forEach((btn) => btn.addEventListener("click", async () => {
  btn.disabled = true;
  try {
    const { job } = await api(`/api/${btn.dataset.run}`, {});
    show("jobs");
    follow(job, "#job-out", () => { btn.disabled = false; });
  } catch (err) {
    alert(err.message);
    btn.disabled = false;
  }
}));

/* ---------------------------------------------------------------- boot -- */

const loaded = new Set();

function load(view, force = false) {
  // The agents panel is the one view whose contents change while you are not
  // looking at it, because a thread can finish after you navigate away.
  if (loaded.has(view) && !force && view !== "chat") return;
  loaded.add(view);
  if (view === "graph") loadGraph();
  if (view === "chat") loadAgents();
  if (view === "sessions") loadSessions();
  if (view === "dept") renderDept();
  if (view === "server") renderServer(lastHealth);
  if (view === "jobs") loadJobs();
}

show("overview");
loadConfig();
health();
loadJobs();
setInterval(health, 60_000);
setInterval(loadJobs, 5_000);
// Everything app.js owns, handed over rather than exported, so the two files
// do not import each other.
bootAgents({ $, $$, api, esc, ago });

