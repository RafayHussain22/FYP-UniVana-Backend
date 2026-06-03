const express = require("express");
const auth = require("../middleware/auth");
const UserProfile = require("../models/userProfile");
const University = require("../models/university");
const Country = require("../models/country");
const Recommendation = require("../models/recommendation");
const { embedQuery, vectorSearch } = require("../lib/retrieval");

const router = express.Router();

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const SCHEMA_VERSION = 1;

// The 5 scraped countries — keeping this explicit (not querying DB on every
// request) makes ranking deterministic.
const COUNTRIES = [
  { code: "FR", name: "France",  slug: "france"  },
  { code: "DE", name: "Germany", slug: "germany" },
  { code: "IT", name: "Italy",   slug: "italy"   },
  { code: "NO", name: "Norway",  slug: "norway"  },
  { code: "SE", name: "Sweden",  slug: "sweden"  },
];

const SYSTEM_PROMPT = `You are UniVana's recommendation explainer. The user profile and a list of pre-ranked candidate countries and universities are provided. The ranking has already been computed from vector similarity. Your job is ONLY to write short, grounded reasons.

STRICT RULES:
1. Do NOT change the country ordering. You may slightly reorder universities within a country if a tie clearly resolves.
2. Every reason must reference a SPECIFIC profile field or candidate field. No generic praise.
3. Reasons must be 1 short sentence each. 2-3 reasons per country, 2-3 per university.
4. Do NOT invent facts not present in the profile or candidate data.
5. Return ONLY valid JSON matching the requested schema. No prose, no markdown.`;

// Build a focused "interests" blob for embedding. We deliberately EXCLUDE
// numbers (CGPA, budgets, English score) — those become filters/flags.
// Mixing them into the embedding dilutes the semantic signal that drives
// university matching.
function buildInterestsBlob(profile) {
  const parts = [
    (profile.targetFields || []).join(", "),
    profile.profileBio,
    (profile.studyPriorities || []).join(", "),
    profile.currentProgram,
    profile.targetDegreeLevel,
  ];
  return parts.filter((p) => p && String(p).trim()).join(". ");
}

// What fraction of the important profile fields are filled. Used both as
// a gate (refuse if too low) and as a UI signal.
function profileCompleteness(profile) {
  const keys = [
    "fullName", "currentCountry", "citizenshipCountry",
    "currentEducationLevel", "currentProgram", "currentCGPA",
    "targetDegreeLevel", "targetFields", "preferredCountries",
    "intendedIntakeYear", "tuitionBudgetMax", "englishTestTaken",
    "englishScore", "profileBio",
  ];
  let filled = 0;
  for (const k of keys) {
    const v = profile[k];
    if (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== "") {
      filled += 1;
    }
  }
  return Math.round((filled / keys.length) * 100);
}

// Required to generate ANY recommendation. Without these we have nothing
// to embed.
function profileGate(profile) {
  const missing = [];
  if (!profile.targetDegreeLevel) missing.push("targetDegreeLevel");
  if (!profile.targetFields || profile.targetFields.length === 0) missing.push("targetFields");
  const hasContext =
    (profile.profileBio && profile.profileBio.trim()) ||
    (profile.currentProgram && profile.currentProgram.trim()) ||
    (profile.studyPriorities && profile.studyPriorities.length > 0);
  if (!hasContext) missing.push("profileBio_or_currentProgram_or_studyPriorities");
  return missing;
}

// Trim a university doc to the fields the LLM actually needs. Smaller prompt
// = faster Groq + less hallucination surface.
function trimUni(u) {
  return {
    slug: u.slug,
    name: u.name,
    city: u.city || "",
    description: (u.description || "").slice(0, 300),
    tags: u.tags || [],
    students_total: u.students?.total || null,
    international_percent: u.students?.international_percent || null,
  };
}

// Deterministic fallback used when Groq is unreachable or returns invalid JSON.
function templatedReasons(profile, country) {
  const field = (profile.targetFields || [])[0] || "your target field";
  const out = [`Strong match in ${field} based on the country's program offerings.`];
  if ((profile.preferredCountries || []).includes(country.name)) {
    out.push(`${country.name} is in your preferred countries list.`);
  }
  return out;
}

function templatedUniReasons(profile, uni) {
  const out = [];
  if (uni.city) out.push(`Located in ${uni.city}.`);
  if (uni.international_percent) {
    out.push(`International student share: ${uni.international_percent}%.`);
  }
  if (out.length === 0) out.push(`A relevant match based on your interests.`);
  return out;
}

// Ask Groq to write reasons. Single retry on invalid JSON; caller falls back
// to templated reasons on second failure.
async function callGroq(profile, payloadForLLM) {
  const user = {
    profile: {
      citizenshipCountry: profile.citizenshipCountry || null,
      targetDegreeLevel: profile.targetDegreeLevel || null,
      targetFields: profile.targetFields || [],
      preferredCountries: profile.preferredCountries || [],
      currentCGPA: profile.currentCGPA ?? null,
      currentProgram: profile.currentProgram || null,
      tuitionBudgetMax: profile.tuitionBudgetMax ?? null,
      livingBudgetMax: profile.livingBudgetMax ?? null,
      englishTestTaken: profile.englishTestTaken || null,
      englishScore: profile.englishScore ?? null,
      studyPriorities: profile.studyPriorities || [],
      profileBio: profile.profileBio || null,
    },
    candidates: payloadForLLM,
    expected_output: {
      countries: [
        {
          code: "string",
          reasons: ["string (2-3 items)"],
          universities: [
            { slug: "string", reasons: ["string (2-3 items)"] },
          ],
        },
      ],
    },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(user) },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error("[recommend] Groq error", resp.status, body.slice(0, 200));
      continue;
    }
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    try {
      const parsed = JSON.parse(text);
      if (parsed && Array.isArray(parsed.countries)) return parsed;
    } catch (_) {}
    console.warn("[recommend] Groq returned invalid JSON, attempt", attempt + 1);
  }
  return null;
}

// Run the full computation. Returns the payload to cache and return.
async function generate(profile) {
  const completeness = profileCompleteness(profile);
  const missing = profileGate(profile);
  if (missing.length) {
    return {
      status: "needs_more_info",
      missing,
      profileCompleteness: completeness,
    };
  }

  const interests = buildInterestsBlob(profile);
  const queryVec = await embedQuery(interests);

  // Per-country vector search. 15 candidates each so the mean-top-5 score
  // is stable.
  const perCountry = await Promise.all(
    COUNTRIES.map(async (c) => {
      const unis = await vectorSearch(University, queryVec, 15, { country_id: c.code });
      return { country: c, unis };
    })
  );

  // Score each country: mean of top-5 vecScores + boosts.
  const tuitionMax = profile.tuitionBudgetMax;
  const englishOK = profile.englishScore && profile.englishScore >= 6.5;
  const preferred = new Set((profile.preferredCountries || []).map((s) => s.toLowerCase()));

  const scored = perCountry.map(({ country, unis }) => {
    const top5 = unis.slice(0, 5);
    const baseScore = top5.length
      ? top5.reduce((s, u) => s + (u.vecScore || 0), 0) / top5.length
      : 0;
    const preferredBoost = preferred.has(country.name.toLowerCase()) ? 0.05 : 0;
    const score = Math.min(1, baseScore + preferredBoost);
    return { country, unis, score, baseScore, preferredBoost };
  });

  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  // Build the trimmed candidate payload for the LLM.
  const llmPayload = top3.map(({ country, unis }) => ({
    code: country.code,
    name: country.name,
    universities: unis.slice(0, 5).map(trimUni),
  }));

  let llmResult = null;
  try {
    llmResult = await callGroq(profile, llmPayload);
  } catch (err) {
    console.error("[recommend] Groq call threw", err.message);
  }

  const degraded = llmResult === null;

  // Look up the LLM's reasoning by country code / uni slug. Fall back to
  // templated reasons if missing.
  const llmByCode = new Map();
  if (llmResult) {
    for (const c of llmResult.countries || []) {
      const byUni = new Map();
      for (const u of c.universities || []) byUni.set(u.slug, u.reasons || []);
      llmByCode.set(c.code, { reasons: c.reasons || [], byUni });
    }
  }

  // Compute dataVersion = max meta.updated_at across surviving unis.
  let dataVersion = "";
  for (const { unis } of top3) {
    for (const u of unis) {
      const ts = u.meta?.updated_at;
      if (ts && (!dataVersion || String(ts) > dataVersion)) dataVersion = String(ts);
    }
  }

  // Assemble the final payload.
  const countries = top3.map(({ country, unis, score }) => {
    const llm = llmByCode.get(country.code);
    const top5Unis = unis.slice(0, 5);

    return {
      code: country.code,
      name: country.name,
      matchScore: Math.round(score * 100),
      budgetFit: tuitionMax ? top5Unis.length > 0 : null,
      englishMet: profile.englishScore ? englishOK : null,
      reasons: llm?.reasons?.length ? llm.reasons : templatedReasons(profile, country),
      universities: top5Unis.slice(0, 4).map((u) => ({
        slug: u.slug,
        name: u.name,
        city: u.city || "",
        matchScore: Math.round((u.vecScore || 0) * 100),
        reasons: llm?.byUni?.get(u.slug)?.length
          ? llm.byUni.get(u.slug)
          : templatedUniReasons(profile, u),
      })),
    };
  });

  return {
    status: "ok",
    schemaVersion: SCHEMA_VERSION,
    dataVersion,
    profileUpdatedAt: profile.lastProfileUpdatedAt,
    generatedAt: new Date().toISOString(),
    profileCompleteness: completeness,
    degraded,
    countries,
  };
}

// GET / — cache-only read. NEVER triggers Jina or Groq. Returns the cached
// payload if it's still fresh; otherwise returns a status flag so the
// frontend can show a "Generate" button.
router.get("/", auth, async (req, res) => {
  try {
    const profile = await UserProfile.findOne({ userId: req.user.id }).lean();
    if (!profile) {
      return res.status(404).json({
        ok: false,
        status: "needs_profile",
        message: "Create a profile first to get recommendations.",
      });
    }

    const cached = await Recommendation.findOne({ userId: req.user.id }).lean();
    const profileTs = profile.lastProfileUpdatedAt
      ? new Date(profile.lastProfileUpdatedAt).getTime()
      : 0;
    const cachedTs = cached?.profileUpdatedAt
      ? new Date(cached.profileUpdatedAt).getTime()
      : -1;

    if (!cached) {
      console.log(`[recommend] user=${req.user.id} cached=none`);
      return res.json({ ok: true, status: "none" });
    }

    const fresh =
      cached.schemaVersion === SCHEMA_VERSION && cachedTs === profileTs;

    console.log(
      `[recommend] user=${req.user.id} cached=hit fresh=${fresh}`
    );

    // Always return the cached payload so users see their last result
    // even if it's stale. Frontend uses `cacheStatus` to decide whether
    // to show a "Regenerate" prompt.
    return res.json({
      ok: true,
      cacheStatus: fresh ? "fresh" : "stale",
      ...cached.payload,
    });
  } catch (err) {
    console.error("[recommend] error", err.message);
    res.status(500).json({ ok: false, message: "Failed to read recommendations" });
  }
});

// POST /refresh — the ONLY path that hits Jina + Groq. Frontend triggers
// this on explicit user action (button click) to keep API costs predictable.
router.post("/refresh", auth, async (req, res) => {
  try {
    const t0 = Date.now();
    const profile = await UserProfile.findOne({ userId: req.user.id }).lean();
    if (!profile) {
      return res.status(404).json({ ok: false, status: "needs_profile" });
    }
    const payload = await generate(profile);

    if (payload.status === "ok") {
      await Recommendation.findOneAndUpdate(
        { userId: req.user.id },
        {
          $set: {
            profileUpdatedAt: profile.lastProfileUpdatedAt || new Date(),
            schemaVersion: SCHEMA_VERSION,
            dataVersion: payload.dataVersion,
            generatedAt: new Date(),
            payload,
          },
        },
        { upsert: true }
      );
    }

    const top = payload.countries?.[0];
    console.log(
      `[recommend] user=${req.user.id} refresh status=${payload.status} topCountry=${top?.code || "-"} topScore=${top?.matchScore || 0} latencyMs=${Date.now() - t0} degraded=${payload.degraded || false}`
    );

    res.json({ ok: true, cacheStatus: "fresh", ...payload });
  } catch (err) {
    console.error("[recommend] refresh error", err.message);
    res.status(500).json({ ok: false, message: "Failed to refresh recommendations" });
  }
});

module.exports = router;
