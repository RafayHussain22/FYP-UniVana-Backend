// Shared retrieval helpers used by both the chatbot and the recommendation
// engine. Embed user-supplied text with Jina, run Atlas vector search, and
// (for the chatbot) merge with lexical results.

const JINA_URL = "https://api.jina.ai/v1/embeddings";
const JINA_MODEL = "jina-embeddings-v3";

// Embed a single string in "retrieval.query" mode. Docs were embedded in
// "retrieval.passage" mode; v3 uses paired projections per task.
async function embedQuery(text) {
  const resp = await fetch(JINA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: JINA_MODEL,
      task: "retrieval.query",
      input: [text],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Jina embed failed: ${resp.status} ${body.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.data[0].embedding;
}

// Run an Atlas $vectorSearch on a Mongoose model and tag each doc with vecScore.
async function vectorSearch(Model, vector, limit, filter) {
  const stage = {
    $vectorSearch: {
      index: "vector_index",
      path: "embedding",
      queryVector: vector,
      numCandidates: Math.max(100, limit * 10),
      limit,
    },
  };
  if (filter) stage.$vectorSearch.filter = filter;
  return Model.aggregate([
    stage,
    { $addFields: { vecScore: { $meta: "vectorSearchScore" } } },
  ]);
}

// Merge a lexical result set with a vector result set, dedupe by _id,
// and rank by a 50/50 combined score (lexical normalized to 0..1).
function mergeResults(lex, vec, topN) {
  const maxLex = Math.max(0, ...lex.map((d) => d.score || 0)) || 1;
  const byId = new Map();
  for (const d of lex) {
    byId.set(String(d._id), { doc: d, lex: (d.score || 0) / maxLex, vec: 0 });
  }
  for (const d of vec) {
    const id = String(d._id);
    const existing = byId.get(id);
    if (existing) existing.vec = d.vecScore || 0;
    else byId.set(id, { doc: d, lex: 0, vec: d.vecScore || 0 });
  }
  return [...byId.values()]
    .map((x) => ({ ...x.doc, combined: 0.5 * x.lex + 0.5 * x.vec }))
    .sort((a, b) => b.combined - a.combined)
    .slice(0, topN);
}

module.exports = { embedQuery, vectorSearch, mergeResults };
