/**
 * Markdown parsing and chunking.
 *
 * Chunks are cut on heading boundaries and carry the heading path with them, so
 * a search hit can be cited as "file > section > subsection" rather than as a
 * naked paragraph. Frontmatter and wikilinks are pulled out into their own
 * fields instead of being embedded as text: "tags: [trading, options]" adds
 * noise to a vector and nothing to meaning.
 */

/** Rough token count. Good enough for sizing chunks; no tokenizer dependency. */
export const estimateTokens = (s) => Math.ceil(s.length / 4);

const FENCE = /^(```|~~~)/;

/** Split leading YAML frontmatter from the body. */
export function splitFrontmatter(text) {
  if (!text.startsWith("---")) return { frontmatter: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: text };
  const raw = text.slice(4, end);
  const rest = text.slice(end + 4).replace(/^\r?\n/, "");
  return { frontmatter: parseFrontmatter(raw), body: rest };
}

/**
 * A deliberately small YAML subset: scalars, inline arrays, and dash lists.
 * Anything more exotic is kept as a raw string rather than guessed at.
 */
function parseFrontmatter(raw) {
  const out = {};
  let key = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && key) {
      if (!Array.isArray(out[key])) out[key] = out[key] ? [out[key]] : [];
      out[key].push(unquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    key = kv[1];
    const value = kv[2].trim();
    if (value === "") { out[key] = ""; continue; }
    if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
      continue;
    }
    out[key] = unquote(value);
  }
  return out;
}

const unquote = (s) => s.replace(/^["'](.*)["']$/, "$1").trim();

/** Title: frontmatter wins, then the first H1, then the filename. */
export function titleFor(frontmatter, body, filename) {
  if (typeof frontmatter.title === "string" && frontmatter.title.trim()) return frontmatter.title.trim();
  const h1 = body.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return filename.replace(/\.md$/i, "");
}

/**
 * Obsidian wikilinks plus relative markdown links to .md files. Aliases and
 * heading anchors are stripped down to the target note.
 */
export function extractLinks(body) {
  const targets = new Set();

  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = m[1].split("|")[0].split("#")[0].trim();
    if (target) targets.add(target);
  }
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+\.md)(?:\s[^)]*)?\)/gi)) {
    const target = decodeURIComponent(m[1]).split("#")[0].trim();
    if (target && !/^https?:/i.test(target)) targets.add(target);
  }
  return [...targets];
}

/**
 * Cut the body into chunks of roughly `target` tokens.
 *
 * Headings reset the accumulator, so a chunk never spans two sections. Inside a
 * long section, paragraphs accumulate until the budget is reached and then the
 * last paragraph is carried into the next chunk as overlap. Fenced code blocks
 * are treated as single indivisible paragraphs.
 */
/**
 * Break a paragraph that busts the hard cap.
 *
 * Markdown lists have no blank lines between items, so a long list arrives here
 * as one "paragraph". Some of these ran to 21,000 tokens, which is both a poor
 * unit to embed and larger than a single throttled request may carry. Splitting
 * on line boundaries is exactly right for a list; the character fallback only
 * fires for one pathologically long line.
 */
function splitOversized(text, maxTokens) {
  if (estimateTokens(text) <= maxTokens) return [text];

  const out = [];
  let cur = [];
  let size = 0;

  for (const line of text.split("\n")) {
    const t = estimateTokens(line);
    if (t > maxTokens) {
      if (cur.length) { out.push(cur.join("\n")); cur = []; size = 0; }
      const step = maxTokens * 4;
      for (let i = 0; i < line.length; i += step) out.push(line.slice(i, i + step));
      continue;
    }
    if (size && size + t > maxTokens) { out.push(cur.join("\n")); cur = []; size = 0; }
    cur.push(line);
    size += t;
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

export function chunkMarkdown(body, { target = 800, maxTokens = 1000, overlapTokens = 100, docTitle = "" } = {}) {
  const lines = body.split("\n");
  const chunks = [];

  let stack = [];               // heading texts by level
  let paragraphs = [];          // pending paragraphs for the current section
  let buf = [];
  let inFence = false;

  const headingPath = () => [docTitle, ...stack].filter(Boolean).join(" > ");

  const flushParagraph = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (text) paragraphs.push(...splitOversized(text, maxTokens));
  };

  const emit = (paras, path) => {
    const text = paras.join("\n\n").trim();
    if (!text) return;
    chunks.push({ content: text, heading_path: path, token_count: estimateTokens(text) });
  };

  /** Pack the pending paragraphs into as many chunks as the budget needs. */
  const flushSection = (path) => {
    flushParagraph();
    if (paragraphs.length === 0) return;

    let current = [];
    let size = 0;
    for (const p of paragraphs) {
      const t = estimateTokens(p);
      if (size > 0 && size + t > target) {
        emit(current, path);
        // Carry the tail back in as overlap, so a fact split across the cut is
        // still retrievable from the second chunk.
        const carry = [];
        let carried = 0;
        for (let i = current.length - 1; i >= 0 && carried < overlapTokens; i--) {
          carry.unshift(current[i]);
          carried += estimateTokens(current[i]);
        }
        current = carry;
        size = carried;
      }
      current.push(p);
      size += t;
    }
    emit(current, path);
    paragraphs = [];
  };

  for (const line of lines) {
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (inFence) { buf.push(line); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushSection(headingPath());
      const level = heading[1].length;
      // Holes are fine when a document skips a level (h1 then h3); headingPath
      // filters them out. Compacting the array here would shift the levels.
      stack = stack.slice(0, level - 1);
      stack[level - 1] = heading[2].trim();
      continue;
    }
    if (line.trim() === "") { flushParagraph(); continue; }
    buf.push(line);
  }
  flushSection(headingPath());

  return chunks.map((c, i) => ({ ...c, ord: i }));
}
