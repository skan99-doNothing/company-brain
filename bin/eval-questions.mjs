/**
 * eval-questions.mjs — the questions retrieval is scored against.
 *
 * Replace these with your own. They are deliberately few and they all target the
 * files this template ships, so `npm run eval` says something true the moment you
 * have indexed, before you have written anything. That also makes them a worked
 * example of the format rather than a benchmark: a real set is thirty to a
 * hundred questions drawn from lookups you have actually needed.
 *
 * Rules that keep a set honest, and they matter more than the questions:
 *
 *   Ask it the way you would ask it. A question that quotes the document's own
 *   title is a keyword test, not a retrieval test, and it will pass forever while
 *   search rots underneath it.
 *
 *   Expect a path fragment, never a filename, so a correct answer that lives in
 *   an unexpected file still counts. List more than one when more than one
 *   document genuinely answers.
 *
 *   Keep the fragment specific. This is the one that bites. A fragment broad
 *   enough to match a whole directory will be satisfied by any file in it, so the
 *   question passes without ever finding the answer and the score flatters you. If
 *   a fragment names a folder, make sure nothing else in that folder could match
 *   by accident.
 *
 *   Never index two copies of the same file. A duplicate of your own notes is
 *   worse than noise: it matches the fragment, scores as correct, and hides a
 *   real failure underneath. Keep vendored copies out of the index with
 *   `index.exclude` in org.config.json.
 *
 *   Run `npm run eval -- --audit` after anything that moves files. A question
 *   whose expected answer no longer exists scores zero forever and reads as a
 *   search regression, which is a slow and expensive way to be lied to by your
 *   own instrument.
 *
 * Tune `search_chunks` against these numbers. Never against one query you happen
 * to be looking at.
 */

/** [question, path fragments that count as correct, optional department filter] */
export const QUESTIONS = [
  // ------------------------------------------------------- the one rule --
  ["what happens if a session changes something and writes nothing down", ["claude.md"]],
  ["where do I record a choice that would be expensive to reverse", ["decisions.md", "claude.md"]],
  ["why is there no vector database for the notes", ["decisions.md"]],
  ["what would have to be true to change the markdown decision back", ["decisions.md"]],

  // ------------------------------------------------------------ routing --
  ["which department owns how the vault is organised", ["departments/memory", "state/memory"]],
  ["which department owns the things that charge money", ["departments/product", "departments/revenue"]],
  ["where should a new file for growth work go", ["departments/growth"]],
  ["what is not built yet in memory", ["departments/memory"]],

  // ------------------------------------------------------------ ledgers --
  ["what is in flight right now", ["state/"]],
  ["what keeps getting in the way", ["state/"]],
  ["how do I hand a department over to someone starting cold", ["state/", "claude.md"]],

  // ------------------------------------------------- the mechanism itself --
  ["why does a search from this folder find nothing in my vaults", ["claude.md"]],
  ["am I allowed to reorganise files inside the linked folders", ["claude.md"]],
  ["which files here are generated and which ones did I write", ["claude.md", "home.md"]],
  ["where am I supposed to open Claude from", ["home.md", "claude.md"]],
];
