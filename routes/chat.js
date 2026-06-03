const express = require("express");
const jwt = require("jsonwebtoken");
const University = require("../models/university");
const Program = require("../models/program");
const Country = require("../models/country");
const ChatHistory = require("../models/chatHistory");
const auth = require("../middleware/auth");
const { embedQuery, vectorSearch, mergeResults } = require("../lib/retrieval");

const router = express.Router();

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// If the best vector match has cosine < this, we refuse instead of calling
// Groq. 0.55 is a starting value — log lines below help tune it.
const THRESHOLD = 0.55;

const REFUSAL =
  "I don't have that in my database. Try searching for universities or countries directly, or ask about France, Germany, Italy, Norway, or Sweden.";

// Strict prompt for Policy B — the model is told NOT to use general knowledge.
const SYSTEM_PROMPT = `You are UniVana Assistant, a chatbot for UniVana — a study abroad platform focused on European universities (France, Germany, Italy, Norway, Sweden).

STRICT RULES:
1. Answer ONLY using the DATABASE CONTEXT below. Do not use general knowledge.
2. If the DATABASE CONTEXT does not contain enough information to answer the user's question, reply with exactly: "I don't have that in my database."
3. Do NOT invent universities, programs, cities, or facts.
4. Keep responses concise (2-4 sentences for simple questions, more for detailed ones).
5. Be friendly and encouraging.`;

const COUNTRIES = {
  france:  { slug: "france",  iso2: "FR" },
  germany: { slug: "germany", iso2: "DE" },
  italy:   { slug: "italy",   iso2: "IT" },
  norway:  { slug: "norway",  iso2: "NO" },
  sweden:  { slug: "sweden",  iso2: "SE" },
};

function detectCountry(message) {
  const lower = message.toLowerCase();
  for (const [name, data] of Object.entries(COUNTRIES)) {
    if (lower.includes(name)) return data;
  }
  return null;
}

// Minimal greeting allow-list — these skip retrieval entirely.
const GREETING_RE = /^(hi|hello|hey|thanks|thank you|bye|goodbye|who are you|what can you do)[\s!.?]*$/i;

function greetingReply(msg) {
  const m = msg.toLowerCase().replace(/[\s!.?]+$/, "").trim();
  if (m === "hi" || m === "hello" || m === "hey") {
    return "Hi! I'm the UniVana Assistant. Ask me about universities, programs, or countries — France, Germany, Italy, Norway, or Sweden.";
  }
  if (m.startsWith("thank")) return "You're welcome!";
  if (m === "bye" || m === "goodbye") return "Goodbye — happy studying!";
  if (m === "who are you") {
    return "I'm UniVana Assistant — I help you discover European universities and study programs.";
  }
  if (m === "what can you do") {
    return "I can help you explore universities, study programs, and countries (France, Germany, Italy, Norway, Sweden). Just ask!";
  }
  return "Hello!";
}

// Soft auth — tries to authenticate but doesn't block if no token
function softAuth(req, res, next) {
  const token = req.cookies?.univanaAuthToken;
  if (!token) return next();
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    // ignore invalid token
  }
  next();
}

async function persist(userId, userMsg, assistantMsg) {
  await ChatHistory.findOneAndUpdate(
    { userId },
    {
      $push: {
        messages: {
          $each: [
            { role: "user", content: userMsg },
            { role: "assistant", content: assistantMsg },
          ],
        },
      },
    },
    { upsert: true }
  );
}

// GET / — load chat history (requires login)
router.get("/", auth, async (req, res) => {
  try {
    const history = await ChatHistory.findOne({ userId: req.user.id }).lean();
    res.json({ ok: true, messages: history?.messages || [] });
  } catch (err) {
    console.error("Chat history load error:", err.message);
    res.status(500).json({ ok: false, message: "Failed to load chat history" });
  }
});

// POST / — send a message and get an AI reply
router.post("/", softAuth, async (req, res) => {
  try {
    const message = String(req.body.message || "").trim();
    const history = Array.isArray(req.body.history) ? req.body.history : [];

    if (!message) {
      return res.status(400).json({ ok: false, message: "Message is required" });
    }

    // 1. Greeting fast-path — skip retrieval and Groq entirely.
    if (GREETING_RE.test(message)) {
      const reply = greetingReply(message);
      if (req.user) await persist(req.user.id, message, reply);
      return res.json({ ok: true, reply });
    }

    // 2. Detect country mention (used to filter both lexical and vector).
    const detected = detectCountry(message);

    // 3. Embed the query + (if a country was detected) look up its uni slugs
    //    so program search can be scoped to that country.
    const [queryVec, uniSlugs] = await Promise.all([
      embedQuery(message),
      detected
        ? University.find({ country_id: detected.iso2 }, { slug: 1 })
            .lean()
            .then((rows) => rows.map((u) => u.slug))
        : Promise.resolve(null),
    ]);

    // 4. Build lexical queries.
    const textQ = { $text: { $search: message } };
    const uniLexQ = detected ? { ...textQ, country_id: detected.iso2 } : textQ;
    const progLexQ =
      detected && uniSlugs?.length
        ? { ...textQ, university_slug: { $in: uniSlugs } }
        : textQ;
    const countryLexQ = detected ? { ...textQ, _id: detected.iso2 } : textQ;

    // 5. Build vector filters (must use fields declared as filter on the index).
    const uniVecFilter = detected ? { country_id: detected.iso2 } : null;
    const progVecFilter =
      detected && uniSlugs?.length ? { university_slug: { $in: uniSlugs } } : null;

    // 6. Fire all six retrievals in parallel.
    const [
      uniLex, uniVec,
      progLex, progVec,
      countryLex, countryVec,
    ] = await Promise.all([
      University.find(uniLexQ, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .limit(10)
        .lean(),
      vectorSearch(University, queryVec, 10, uniVecFilter),
      Program.find(progLexQ, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .limit(20)
        .lean(),
      vectorSearch(Program, queryVec, 20, progVecFilter),
      Country.find(countryLexQ, { score: { $meta: "textScore" } })
        .sort({ score: { $meta: "textScore" } })
        .limit(5)
        .lean(),
      vectorSearch(Country, queryVec, 5, null),
    ]);

    // 7. Threshold gate — based on the best raw vector score across all
    //    three collections. Cosine similarity is the only signal that's
    //    directly comparable to a fixed threshold.
    const maxVec = Math.max(
      0,
      ...uniVec.map((d) => d.vecScore || 0),
      ...progVec.map((d) => d.vecScore || 0),
      ...countryVec.map((d) => d.vecScore || 0)
    );

    console.log(
      `[chat] q="${message.slice(0, 60)}" maxVec=${maxVec.toFixed(
        3
      )} country=${detected?.slug || "-"} gate=${maxVec >= THRESHOLD ? "PASS" : "REFUSE"}`
    );

    if (maxVec < THRESHOLD) {
      if (req.user) await persist(req.user.id, message, REFUSAL);
      return res.json({ ok: true, reply: REFUSAL });
    }

    // 8. Merge lexical + vector per collection for ranking quality.
    const universities = mergeResults(uniLex, uniVec, 10);
    const programs = mergeResults(progLex, progVec, 20);
    const countries = mergeResults(countryLex, countryVec, 5);

    // 9. Build the context string for the LLM.
    let context = "";
    if (universities.length) {
      context += "UNIVERSITIES:\n";
      universities.forEach((u) => {
        context += `- ${u.name} | City: ${u.city || "N/A"} | Country: ${u.country_id} | Founded: ${u.founded_year || "N/A"} | Students: ${u.students?.total || "N/A"} (${u.students?.international_percent || "N/A"}% international)\n`;
      });
    }
    if (programs.length) {
      context += "\nPROGRAMS:\n";
      programs.forEach((p) => {
        context += `- ${p.name} | Degree: ${p.degree || "N/A"} | Discipline: ${p.discipline || "N/A"} | Duration: ${p.duration || "N/A"} | University: ${p.university_slug || "N/A"}\n`;
      });
    }
    if (countries.length) {
      context += "\nCOUNTRIES:\n";
      countries.forEach((c) => {
        context += `- ${c.name} | Region: ${c.region || "N/A"} | ${(c.description || "").slice(0, 200)}\n`;
      });
    }

    // 10. Call Groq with the last 6 turns + new message.
    const recentHistory = history.slice(-6);
    const groqMessages = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\nDATABASE CONTEXT:\n${context}` },
      ...recentHistory.map((msg) => ({ role: msg.role, content: msg.content })),
      { role: "user", content: message },
    ];

    const groqRes = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: groqMessages,
      }),
    });

    const data = await groqRes.json();
    if (!groqRes.ok) {
      console.error("Groq API error:", data);
      return res.status(500).json({ ok: false, message: "AI service error" });
    }

    const reply =
      data.choices?.[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    if (req.user) await persist(req.user.id, message, reply);
    res.json({ ok: true, reply });
  } catch (err) {
    console.error("Chat error:", err.message);
    res.status(500).json({ ok: false, message: "Something went wrong" });
  }
});

module.exports = router;
