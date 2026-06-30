const express = require("express");
const axios = require("axios");

const router = express.Router();

// In-memory LRU-ish cache. Keyed by `${targetLang}|${text}`. We re-insert on
// hit so the oldest unused entries fall off first when we exceed CACHE_MAX.
const CACHE_MAX = 5000;
const cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const val = cache.get(key);
  cache.delete(key);
  cache.set(key, val);
  return val;
}

function cacheSet(key, val) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

// MyMemory's free tier is ~1000 words/day per anonymous IP. Once it's gone,
// every call returns a 429 (HTTP or inline `responseStatus`). Hammering it
// while quota is exhausted floods the Render logs and accomplishes nothing,
// so we back off until midnight UTC (when the quota resets).
let cooldownUntil = 0;
let warnedThisCooldown = false;

function inCooldown() {
  return Date.now() < cooldownUntil;
}

function startCooldown(reason) {
  // Reset at next UTC midnight — that's when MyMemory's daily counter rolls.
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  cooldownUntil = next.getTime();
  if (!warnedThisCooldown) {
    console.warn(`[translation] quota exhausted (${reason}); skipping MyMemory until ${next.toISOString()}`);
    warnedThisCooldown = true;
  }
}

function clearCooldownIfElapsed() {
  if (cooldownUntil && Date.now() >= cooldownUntil) {
    cooldownUntil = 0;
    warnedThisCooldown = false;
  }
}

router.post("/translate", async (req, res) => {
  const { text, targetLang } = req.body || {};

  if (!text || !targetLang) {
    return res.status(400).json({ message: "Text and target language are required" });
  }

  if (targetLang === "en") {
    return res.json({ translatedText: text });
  }

  const key = `${targetLang}|${text}`;
  const cached = cacheGet(key);
  if (cached !== undefined) {
    return res.json({ translatedText: cached });
  }

  clearCooldownIfElapsed();
  if (inCooldown()) {
    return res.json({ translatedText: text });
  }

  try {
    const response = await axios.get("https://api.mymemory.translated.net/get", {
      params: { q: text, langpair: `en|${targetLang}` },
      timeout: 8000,
    });

    const data = response.data || {};
    const status = data.responseStatus;
    const details = data.responseDetails || "";
    const translated = data.responseData?.translatedText;

    // MyMemory signals quota exhaustion via either responseStatus=429 or a
    // `MYMEMORY WARNING` string in responseDetails/translatedText.
    const quotaHit =
      status === 429 ||
      data.quotaFinished === true ||
      /MYMEMORY WARNING/i.test(details) ||
      (typeof translated === "string" && /MYMEMORY WARNING/i.test(translated));

    if (quotaHit) {
      startCooldown("inline 429");
      return res.json({ translatedText: text });
    }

    const finalText = typeof translated === "string" && translated.length > 0
      ? translated
      : text;

    cacheSet(key, finalText);
    return res.json({ translatedText: finalText });
  } catch (error) {
    const httpStatus = error.response?.status;
    if (httpStatus === 429) {
      startCooldown("http 429");
      return res.json({ translatedText: text });
    }
    // Anything else (timeout, network, 5xx): fall back silently with the
    // original text. Frontend already treats this as a no-op.
    return res.json({ translatedText: text });
  }
});

module.exports = router;
