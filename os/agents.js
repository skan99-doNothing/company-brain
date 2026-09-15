/**
 * The Agents panel.
 *
 * Three things that used to be missing. Threads survive a reload and sit in a
 * list you can go back through. Each thread carries the files and folders the
 * agent actually named while it worked, which is a better summary of a session
 * than any title. And there is a tree on the left, so a folder the agent
 * touched can be opened and walked through without leaving the window, or
 * handed to Explorer when you want the real thing.
 *
 * The workspace side is a toggle rather than always on, because most of the
 * time the transcript is the whole job and a file tree beside it is clutter.
 */

let ctx = null;             // { $, $$, api, esc, ago }
let agent = "claude";
let threadId = null;        // the open thread, or null for a fresh one
let threads = [];
let openThread = null;      // the full record of the open thread
let polling = null;

const AGENTS = {
  claude: "the Claude Code CLI in print mode, resuming one session",
  chatgpt: "codex exec on the ChatGPT plan, gpt-6-astra",
  vps: "ssh root@the box, which is answering only when the VPS dot is green",
};

/** The CLIs print their own housekeeping. None of it belongs in a transcript. */
const NOISE = [
  /^Ignoring \d+ permissions\.allow entries/,
  /^OpenAI Codex v/,
  /^-{4,}$/,
  /^(workdir|model|provider|approval|sandbox|reasoning \w+):/,
  /^session id: /,
  /^tokens used$/,
  /^\d+,?\d*$/,
  /^user$/,
  /^codex$/,
  /ERROR rmcp::transport/,
];

export function cleanReply(text, who = agent) {
  let body = String(text || "");

  // Codex prints a header, echoes the prompt under a "user" marker, then the
  // answer under a "codex" marker. Only the last block is the reply.
  if (who === "chatgpt") {
    const marks = [...body.matchAll(/^codex$/gm)];
    if (marks.length) body = body.slice(marks[marks.length - 1].index + 5);
    const end = body.search(/^tokens used$/m);
    if (end > 0) body = body.slice(0, end);
  }

  const kept = body.split(/\r?\n/).filter((l) => !NOISE.some((re) => re.test(l.trim())));
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* --------------------------------------------------------------- boot -- */

export function bootAgents(deps) {
  ctx = deps;
  const { $, $$ } = ctx;

  $("#btn-chat").addEventListener("click", send);
  $("#chat-in").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  $$("#chat-tabs .tab").forEach((t) => t.addEventListener("click", () => {
    agent = t.dataset.agent;
    $$("#chat-tabs .tab").forEach((x) => x.classList.toggle("on", x === t));
    $("#chat-note").textContent = AGENTS[agent];
    $("#chat-in").placeholder = agent === "vps"
      ? "a shell command, run as root on the box"
      : "Enter sends, shift and enter for a new line";
  }));

  $("#btn-chat-new").addEventListener("click", async () => {
    const t = await ctx.api("/api/thread/new", { agent });
    threadId = t.id;
    openThread = t;
    await loadThreads();
    drawThread();
  });

  $("#btn-chat-threads").addEventListener("click", () => {
    document.body.classList.toggle("agents-threads-hidden");
  });

  // The workspace panel. Hidden by default, and its state is worth remembering
  // between visits because it is a preference, not a mode.
  const ws = $("#btn-chat-workspace");
  const remembered = localStorage.getItem("agents-workspace") === "on";
  document.body.classList.toggle("agents-workspace", remembered);
  ws.classList.toggle("on", remembered);
  ws.addEventListener("click", () => {
    const on = !document.body.classList.contains("agents-workspace");
    document.body.classList.toggle("agents-workspace", on);
    ws.classList.toggle("on", on);
    try { localStorage.setItem("agents-workspace", on ? "on" : "off"); } catch {}
    if (on) drawWorkspace();
  });

  $("#tree-up").addEventListener("click", () => {
    if (treeState.parent) openFolder(treeState.parent);
  });
  $("#tree-home").addEventListener("click", () => openFolder(null));
  $("#peek-close").addEventListener("click", () => { $("#peek").hidden = true; });
}

/** Called when the view opens. */
export async function loadAgents() {
  ctx.$("#chat-note").textContent = AGENTS[agent];
  await loadThreads();
  if (!threadId && threads.length) threadId = threads[0].id;
  await drawThread();
  if (!treeState.path) openFolder(null);
}

/* ------------------------------------------------------------ threads -- */

async function loadThreads() {
  const { $, esc, ago } = ctx;
  try {
    threads = (await ctx.api("/api/threads")).threads || [];
  } catch {
    threads = [];
  }
  const list = $("#thread-list");
  if (!threads.length) {
    list.innerHTML = `<div class="empty">No threads yet. Ask something.</div>`;
    return;
  }
  list.innerHTML = threads.map((t) => `
    <button class="thread ${t.id === threadId ? "on" : ""}" data-id="${esc(t.id)}">
      <span class="thread-top">
        <span class="thread-agent ag-${esc(t.agent)}">${esc(t.agent)}</span>
        <span class="thread-when">${esc(ago(t.updated))}</span>
      </span>
      <span class="thread-title">${esc(t.title)}</span>
      <span class="thread-meta">${t.messages} turns${t.files ? ` · ${t.files} files` : ""}</span>
      <span class="thread-x" data-del="${esc(t.id)}" title="Delete this thread">×</span>
    </button>`).join("");

  list.querySelectorAll(".thread").forEach((el) => {
    el.addEventListener("click", async (e) => {
      if (e.target.dataset.del) {
        e.stopPropagation();
        await ctx.api("/api/thread/delete", { id: e.target.dataset.del }).catch(() => {});
        if (threadId === e.target.dataset.del) { threadId = null; openThread = null; }
        await loadThreads();
        return drawThread();
      }
      threadId = el.dataset.id;
      await loadThreads();
      drawThread();
    });
  });
}

async function drawThread() {
  const { $, esc } = ctx;
  const log = $("#chat-log");
  // A preview left open from the last thread is just confusing.
  $("#peek").hidden = true;

  if (!threadId) {
    openThread = null;
    log.innerHTML = `<div class="empty">
      Claude and Codex both run on the subscriptions you already pay for, so nothing
      here bills per token. The VPS tab is a shell on the box. Whatever you ask starts
      a thread, and the thread stays.</div>`;
    drawWorkspace();
    return;
  }

  try {
    openThread = await ctx.api(`/api/thread?id=${encodeURIComponent(threadId)}`);
  } catch {
    threadId = null;
    return drawThread();
  }

  // The tab follows the thread. Answering a Claude thread from the ChatGPT tab
  // would silently start a second conversation.
  if (openThread.agent && openThread.agent !== agent) {
    agent = openThread.agent;
    ctx.$$("#chat-tabs .tab").forEach((x) => x.classList.toggle("on", x.dataset.agent === agent));
    $("#chat-note").textContent = AGENTS[agent];
  }

  log.innerHTML = openThread.messages.map((m) => {
    const mine = m.role === "you";
    const body = mine ? m.text : cleanReply(m.text, openThread.agent);
    return `<div class="msg ${mine ? "me" : "them" + (openThread.agent === "vps" ? " shell" : "")}">
      <div class="who">${esc(m.role)}</div>
      <div class="body">${esc(body || (mine ? "" : "no output"))}</div>
    </div>`;
  }).join("") || `<div class="empty">Fresh thread with ${esc(openThread.agent)}.</div>`;
  log.scrollTop = log.scrollHeight;
  drawWorkspace();
}

/* -------------------------------------------------------------- sending -- */

async function send() {
  const { $, esc } = ctx;
  const input = $("#chat-in");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";

  const log = $("#chat-log");
  log.querySelector(".empty")?.remove();
  log.insertAdjacentHTML("beforeend",
    `<div class="msg me"><div class="who">you</div><div class="body">${esc(message)}</div></div>`);
  log.insertAdjacentHTML("beforeend",
    `<div class="msg them ${agent === "vps" ? "shell" : ""}" id="chat-live">
       <div class="who">${esc(agent)}</div><div class="body">thinking</div></div>`);
  log.scrollTop = log.scrollHeight;

  const btn = $("#btn-chat");
  btn.disabled = true;
  const target = $("#chat-live .body");

  try {
    const r = await ctx.api("/api/chat", { agent, message, thread: threadId });
    threadId = r.thread;
    const tick = async () => {
      const state = await ctx.api(`/api/job?id=${encodeURIComponent(r.job)}`);
      target.textContent = cleanReply(state.out) || "thinking";
      log.scrollTop = log.scrollHeight;
      if (state.state === "running") return (polling = setTimeout(tick, 1200));
      target.textContent = cleanReply(state.out) || `[${state.state}, exit ${state.code}]`;
      $("#chat-live")?.removeAttribute("id");
      btn.disabled = false;
      log.scrollTop = log.scrollHeight;
      // The server has written the turn and mined the paths out of it by now,
      // so the thread list and the workspace are both a reload behind.
      await loadThreads();
      try {
        openThread = await ctx.api(`/api/thread?id=${encodeURIComponent(threadId)}`);
        drawWorkspace();
      } catch {}
    };
    tick();
  } catch (err) {
    target.textContent = err.message;
    btn.disabled = false;
  }
}

export function stopAgentPolling() {
  if (polling) clearTimeout(polling);
  polling = null;
}

/* ------------------------------------------------------------ workspace -- */

const fileName = (p) => String(p).split(/[\\/]/).pop();

function drawWorkspace() {
  const { $, esc } = ctx;
  const box = $("#ws-touched");
  if (!box) return;

  if (!openThread || (!openThread.files.length && !openThread.folders.length)) {
    box.innerHTML = `<div class="empty">Nothing named yet. Files and folders the agent
      mentions show up here as it works.</div>`;
    return;
  }

  const files = openThread.files.slice(0, 40);
  const folders = openThread.folders.slice(0, 12);

  box.innerHTML = `
    ${folders.length ? `<div class="ws-group">
      <div class="ws-head">Folders</div>
      ${folders.map((f) => `
        <div class="ws-row" data-folder="${esc(f.path)}" title="${esc(f.path)}">
          <span class="ws-ico">▸</span>
          <span class="ws-name">${esc(fileName(f.path))}</span>
          <span class="ws-n">${f.count}</span>
        </div>`).join("")}
    </div>` : ""}
    ${files.length ? `<div class="ws-group">
      <div class="ws-head">Files</div>
      ${files.map((f) => `
        <div class="ws-row" data-file="${esc(f.path)}" title="${esc(f.path)}">
          <span class="ws-ico">·</span>
          <span class="ws-name">${esc(fileName(f.path))}</span>
          <span class="ws-n">${f.count}</span>
          <span class="ws-where" data-reveal="${esc(f.path)}" title="Show it in Explorer">↗</span>
        </div>`).join("")}
    </div>` : ""}`;

  box.querySelectorAll("[data-folder]").forEach((el) =>
    el.addEventListener("click", () => openFolder(el.dataset.folder)));
  box.querySelectorAll("[data-file]").forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.dataset.reveal) return reveal(e.target.dataset.reveal);
      previewFile(el.dataset.file);
    }));
}

/* ---------------------------------------------------------------- tree -- */

const treeState = { path: null, parent: null };

export async function openFolder(path) {
  const { $, esc } = ctx;
  const body = $("#tree-body");
  body.innerHTML = `<div class="empty">reading</div>`;
  try {
    const d = await ctx.api(`/api/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`);
    treeState.path = d.path;
    treeState.parent = d.parent;
    $("#tree-path").textContent = d.path;
    $("#tree-path").title = d.path;
    $("#tree-up").disabled = !d.parent;
    body.innerHTML = d.entries.length
      ? d.entries.map((e) => `
          <div class="tree-row ${e.dir ? "is-dir" : ""}" data-path="${esc(e.path)}"
               data-dir="${e.dir ? 1 : 0}" data-kind="${esc(e.kind)}" title="${esc(e.path)}">
            <span class="tree-ico">${e.dir ? "▸" : e.kind === "image" ? "▣" : "·"}</span>
            <span class="tree-name">${esc(e.name)}</span>
            <span class="tree-where" data-reveal="${esc(e.path)}" title="Show it in Explorer">↗</span>
          </div>`).join("")
      : `<div class="empty">empty</div>`;

    body.querySelectorAll(".tree-row").forEach((el) =>
      el.addEventListener("click", (ev) => {
        if (ev.target.dataset.reveal) return reveal(ev.target.dataset.reveal);
        if (el.dataset.dir === "1") return openFolder(el.dataset.path);
        previewFile(el.dataset.path, el.dataset.kind);
      }));
  } catch (err) {
    body.innerHTML = `<div class="empty bad">${esc(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------- preview -- */

/** Show a file in the panel. Images render, text is read, anything else opens. */
export async function previewFile(path, kind) {
  const { $, esc } = ctx;
  const box = $("#peek");
  const body = $("#peek-body");
  $("#peek-name").textContent = fileName(path);
  $("#peek-path").textContent = path;
  $("#peek-path").title = path;
  $("#peek-open").onclick = () => reveal(path, false);
  $("#peek-where").onclick = () => reveal(path, true);
  box.hidden = false;

  if (kind === "image" || /\.(png|jpe?g|webp|gif|svg)$/i.test(path)) {
    body.innerHTML = `<img src="/api/file?path=${encodeURIComponent(path)}" alt="${esc(fileName(path))}">`;
    return;
  }
  body.innerHTML = `<div class="empty">reading</div>`;
  try {
    const d = await ctx.api(`/api/peek?path=${encodeURIComponent(path)}`);
    body.innerHTML = d.text === null
      ? `<div class="empty">Not a text file. Open it to see it properly.</div>`
      : `<pre>${esc(d.text)}${d.truncated ? "\n\n[truncated]" : ""}</pre>`;
  } catch (err) {
    body.innerHTML = `<div class="empty bad">${esc(err.message)}</div>`;
  }
}

/**
 * Hand it to Windows.
 *
 * `where` is Explorer with the file already selected, which answers "where is
 * this" in the only way that is actually useful. Without it, the file opens in
 * whatever program owns the extension.
 */
export async function reveal(path, where = true) {
  try {
    await ctx.api("/api/open", { path, reveal: where });
  } catch (err) {
    const line = ctx.$("#dock-reply");
    if (line) { line.textContent = err.message; line.classList.add("bad"); }
  }
}
