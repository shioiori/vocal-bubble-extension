// Shared between background.js (service worker, via importScripts) and
// addword.js (page script, via a plain <script> tag) — classic functions
// only, no ES module syntax, so both contexts can load it as-is.

const VB_API_BASE_URL = "https://personal-blog-five-ruddy.vercel.app";
// Opened when the user needs to log in — the English page gates itself
// behind the same login dialog, so any locale works as a landing spot.
const VB_LOGIN_URL = VB_API_BASE_URL + "/en/english";

function vbEmptySense() {
  return { phonetic: "", partOfSpeech: "", cambridgeMeaning: "", meaningVi: "", example: "", synonyms: "", antonyms: "" };
}

function vbNormalizeForDedup(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

// Thrown by vbApiFetch on a 401 so every call site can tell "not logged in"
// apart from an ordinary API error without re-parsing the response.
class VbUnauthorizedError extends Error {
  constructor() {
    super("Bạn chưa đăng nhập.");
    this.name = "VbUnauthorizedError";
  }
}

async function vbApiFetch(path, options) {
  // credentials: "include" so the backend's session cookie (set by logging
  // in on the website) rides along on these extension-initiated requests —
  // without it the backend always sees an anonymous caller.
  const res = await fetch(VB_API_BASE_URL + path, { ...options, credentials: "include" });
  if (res.status === 401) throw new VbUnauthorizedError();
  let data;
  try {
    data = await res.json();
  } catch {
    data = undefined;
  }
  // Returned with HTTP 200 (same shape as any other AI-step failure), but
  // always worth surfacing verbatim rather than the generic per-call-site
  // failure message — the user needs to know to upgrade, not retry.
  if (data?.needsPremium) {
    throw new Error(data.error || "Bạn cần nâng cấp lên Premium để tiếp tục dùng tính năng AI hôm nay.");
  }
  if (!res.ok) {
    throw new Error(data?.error || "HTTP " + res.status);
  }
  return data;
}

// Checks login status without throwing — used to gate a feature's UI before
// the user even tries an action (vs. vbApiFetch's 401, which surfaces once
// they already did). Fails closed to "not logged in" on any network error.
async function vbGetAuthUser() {
  try {
    const data = await vbApiFetch("/api/auth/me");
    return data?.user ?? null;
  } catch {
    return null;
  }
}

// Rejects blank selections, then asks the web app's /api/english/lemmatize
// (a thin wrapper around its in-process, non-AI wink-lemmatizer) to reduce
// an inflected word/phrase to its dictionary base form ("unravels" ->
// "unravel") — the extension can't import that lemmatizer itself (plain
// content/background scripts, no bundler). Falls back to the trimmed/
// lowercased text on any network error so a hiccup never blocks an add.
// Returns { valid: true, normalized } or { valid: false, reason }.
async function vbValidateAndNormalize(wordText) {
  const trimmed = vbNormalizeForDedup(wordText);
  if (!trimmed) {
    return { valid: false, reason: "Không có từ nào được chọn." };
  }
  try {
    return await vbApiFetch("/api/english/lemmatize?word=" + encodeURIComponent(trimmed));
  } catch {
    return { valid: true, normalized: trimmed };
  }
}

// Same contract as vbValidateAndNormalize, but skips the lemmatize call
// entirely when the user has turned the feature off (vbLemmatize setting) —
// still rejects blank input, just never normalizes inflected forms.
async function vbMaybeValidateAndNormalize(wordText, lemmatizeEnabled) {
  const trimmed = vbNormalizeForDedup(wordText);
  if (!trimmed) {
    return { valid: false, reason: "Không có từ nào được chọn." };
  }
  if (!lemmatizeEnabled) return { valid: true, normalized: trimmed };
  return vbValidateAndNormalize(wordText);
}

// Cheap, non-AI duplicate check (exact word/alt-spelling match, server-side)
// — call this before any AI endpoint (lemmatize/gloss/ai-define) so an exact
// repeat add never spends tokens. Returns { exists, id?, word? }; fails
// closed to { exists: false } on any error so a network hiccup never blocks
// a legitimate add.
// Passing sourceUrl lets the server also group an already-existing word
// under THAT page's source group when it isn't grouped there yet (e.g.
// "honoured" on page B resolves to the already-saved "honour" from page A —
// "honour" should end up linked to page B's group too, not just page A's).
// Bug fixed: this was never actually sent before, so quickAddWord's
// duplicate path never grouped the existing word under the new page.
async function vbCheckDuplicate(wordText, sourceUrl) {
  try {
    const params = new URLSearchParams({ word: wordText });
    if (sourceUrl) params.set("sourceUrl", sourceUrl);
    return await vbApiFetch("/api/english/words/exists?" + params.toString());
  } catch {
    return { exists: false };
  }
}

// dictionaryapi.dev (behind /api/english/crawl) often returns duplicate
// entries (e.g. "mold"/"mould" merged) — collapse identical definition text
// before sending anything further downstream.
function vbFlattenDictDefs(dict) {
  const flatDefs = [];
  const seen = new Set();
  for (const sense of dict?.senses || []) {
    for (const def of sense.definitions || []) {
      if (!def.text) continue;
      const key = vbNormalizeForDedup(def.text);
      if (seen.has(key)) continue;
      seen.add(key);
      flatDefs.push({ partOfSpeech: sense.partOfSpeech || "", text: def.text, example: def.examples?.[0] || "" });
    }
  }
  return flatDefs;
}

function vbBuildSenseRows(picks, flatDefs, ipa, synonyms, antonyms) {
  return picks
    .map((p) => flatDefs[p.index] && { def: flatDefs[p.index], meaningVi: p.meaningVi, example: p.example })
    .filter(Boolean)
    .map(({ def, meaningVi, example }, i) => ({
      ...vbEmptySense(),
      // Pronunciation is a property of the word itself, not of one
      // particular sense — fill it on every row, not just the first.
      phonetic: ipa,
      partOfSpeech: def.partOfSpeech,
      cambridgeMeaning: def.text,
      meaningVi,
      // The gloss endpoint writes an example itself when the source had
      // none (see gloss/route.ts) — prefer that over the source's own.
      example: example || def.example,
      synonyms: i === 0 ? synonyms : "",
      antonyms: i === 0 ? antonyms : "",
    }));
}

// dictionaryapi.dev sometimes answers a request from the backend's server
// IP with an entry that has a part of speech but an EMPTY definitions list
// (seen in practice — the backend's own retry logic only covers "no entry
// at all", not this "entry but no definitions" shape). This can clear up on
// a fresh request, so try once more before giving up.
async function vbCrawlAndDedupe(wordText, attempt) {
  const params = new URLSearchParams({ word: wordText });
  const data = await vbApiFetch(`/api/english/crawl?${params.toString()}`);
  const dict = data?.crawlData;
  if (!dict) return null;

  const flatDefs = vbFlattenDictDefs(dict);
  if (flatDefs.length === 0 && !attempt) {
    return vbCrawlAndDedupe(wordText, 1);
  }

  return {
    flatDefs,
    ipa: dict.pronunciations?.find((p) => p.ipa)?.ipa || "",
    synonyms: (dict.synonyms || []).join(", "),
    antonyms: (dict.antonyms || []).join(", "),
  };
}

// Last resort when NEITHER dictionaryapi.dev nor the Wiktionary fallback
// (see /api/english/crawl) has anything — e.g. an uncommon phrasal verb
// like "creep into" that isn't indexed as its own entry anywhere free. Asks
// Groq to define it from its own knowledge instead of blocking the add
// outright; every row comes back tagged with a `note` so it's visible in
// the app that this wasn't dictionary-sourced and may be worth
// double-checking. Throws if the model isn't confident this is even a real
// English word/phrase (it's told to return nothing rather than invent one).
// `knownIpa` is the REAL phonetic already fetched from dictionaryapi.dev's
// own pronunciation data or the static IPA dataset (see crawl/route.ts) —
// that can exist even when the definitions themselves came back empty,
// since phonetics and definitions are reported independently. When
// present, it's trusted over whatever phonetic the model guesses on its
// own, since that's sourced data rather than an LLM approximation.
async function vbAiDefineFallback(wordText, knownIpa) {
  const res = await vbApiFetch("/api/english/ai-define", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word: wordText }),
  });
  const senses = res?.senses || [];
  if (senses.length === 0) {
    throw new Error(`Không tìm thấy định nghĩa nào cho "${wordText}", kể cả từ AI. Thử lại sau hoặc thêm thủ công.`);
  }
  return senses.map((s) => ({ ...vbEmptySense(), ...s, phonetic: knownIpa || s.phonetic || "" }));
}

// Crawls the dictionary for wordText, sends every deduped definition to the
// Groq-backed /api/english/gloss endpoint (which picks the common senses and
// writes a short Vietnamese gloss for each), and returns ready-to-save
// sense rows. No more silent fallback for the Vietnamese gloss step: a gloss
// failure (including a transient one not fixed by the single retry below)
// throws, so the caller reports it instead of quietly saving a word with
// blank meaningVi/example.
// Falls back further to vbAiDefineFallback if the dictionary itself
// returned no usable definitions at all.
// Only ever called for a brand-new word — callers check vbCheckDuplicate
// first and never reach this for a word the user already has.
async function vbBuildSensesFromDictionary(wordText) {
  const crawl = await vbCrawlAndDedupe(wordText);
  if (!crawl || crawl.flatDefs.length === 0) return vbAiDefineFallback(wordText, crawl?.ipa);
  const { flatDefs, ipa, synonyms, antonyms } = crawl;

  const requestGloss = () =>
    vbApiFetch("/api/english/gloss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        word: wordText,
        items: flatDefs.map((d) => ({ partOfSpeech: d.partOfSpeech, definition: d.text, example: d.example })),
      }),
    });

  let res = await requestGloss();
  // An `error` with no senses means the model/JSON step itself failed
  // server-side (e.g. a many-sense word like "trunk" exhausting the token
  // budget) rather than the model genuinely finding nothing — worth one
  // retry before giving up.
  if (res?.error && !(res?.senses || []).length) {
    res = await requestGloss();
  }
  const picks = res?.senses || [];
  if (picks.length === 0) {
    throw new Error(`Không tạo được nghĩa tiếng Việt cho "${wordText}" (AI gặp lỗi). Thử lại sau hoặc điền thủ công.`);
  }

  const built = vbBuildSenseRows(picks, flatDefs, ipa, synonyms, antonyms);
  if (built.length === 0) {
    throw new Error(`Không tạo được nghĩa tiếng Việt cho "${wordText}" (AI gặp lỗi). Thử lại sau hoặc điền thủ công.`);
  }
  return built;
}

// AI-only expansion (no dictionary crawl): asks the backend to suggest up to
// one related word per other part of speech (v/n/adj/phrase) in the same
// word family as wordText, and to write a full entry (phonetic, "ý cảnh"
// -grouped senses, synonyms, antonyms) for the main word and every related
// word in a single Groq call — see gloss/route.ts's handleExpandRelated.
// Each returned entry is checked against the user's existing dictionary
// (vbCheckDuplicate) so the caller can grey out ones already saved instead
// of creating a duplicate. Every sense here is AI-generated, not crawled —
// callers should tag rows with a "please verify" note, same as
// vbAiDefineFallback does.
function vbExpandEntryToSenses(e) {
  return (e.senses || []).map((s, i) => ({
    ...vbEmptySense(),
    phonetic: e.phonetic || "",
    partOfSpeech: e.pos || "",
    cambridgeMeaning: s.definitionEn || "",
    meaningVi: s.meaningVi || "",
    example: s.example || "",
    synonyms: i === 0 ? e.synonyms || "" : "",
    antonyms: i === 0 ? e.antonyms || "" : ""
  }));
}

async function vbSuggestRelatedWordEntries(wordText, partOfSpeech) {
  const res = await vbApiFetch("/api/english/gloss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word: wordText, expandRelated: { word: wordText, partOfSpeech } })
  });
  const entries = (res?.entries || []).filter((e) => vbNormalizeForDedup(e.word) !== vbNormalizeForDedup(wordText));

  return Promise.all(
    entries.map(async (e) => {
      const dup = await vbCheckDuplicate(e.word);
      return { word: e.word, pos: e.pos, isExisting: dup.exists, existingId: dup.id, senses: vbExpandEntryToSenses(e) };
    })
  );
}

// Fully AI-driven add (per explicit user decision): no dictionaryapi.dev
// crawl, no wink-lemmatizer — one Groq call validates rawWord is a real
// English word/phrase, normalizes it to its dictionary base form (lemma),
// and writes full entries (phonetic, ý-cảnh-grouped senses, synonyms,
// antonyms) for the lemma AND its word family, all at once. Mirrors
// gloss/route.ts's handleFullyAiAdd.
// Returns { valid: false, reason } when the model rejects the input (not a
// real word, a full sentence, gibberish, non-English...), or
// { valid: true, lemma, mainSenses, related } on success — mainSenses is
// ready to save as-is, related is the same shape vbSuggestRelatedWordEntries
// returns (each already duplicate-checked).
async function vbFullyAiAdd(rawWord) {
  const res = await vbApiFetch("/api/english/gloss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ word: rawWord, fullyAiAdd: true })
  });
  if (!res?.valid) {
    return { valid: false, reason: res?.reason || "Không nhận diện được đây là từ tiếng Anh hợp lệ." };
  }
  const lemma = res.lemma;
  const entries = res.entries || [];
  const mainEntry = entries.find((e) => vbNormalizeForDedup(e.word) === vbNormalizeForDedup(lemma));
  const mainSenses = mainEntry ? vbExpandEntryToSenses(mainEntry) : [];
  if (mainSenses.length === 0) {
    return { valid: false, reason: `AI không tạo được nghĩa cho "${lemma}". Thử lại sau hoặc thêm thủ công.` };
  }
  const relatedEntries = entries.filter((e) => e !== mainEntry);
  const related = await Promise.all(
    relatedEntries.map(async (e) => {
      const dup = await vbCheckDuplicate(e.word);
      return { word: e.word, pos: e.pos, isExisting: dup.exists, existingId: dup.id, senses: vbExpandEntryToSenses(e) };
    })
  );
  return { valid: true, lemma, mainSenses, related };
}

function vbSenseToInput(s) {
  return {
    phonetic: s.phonetic ?? "",
    partOfSpeech: s.partOfSpeech ?? "",
    cambridgeMeaning: s.cambridgeMeaning ?? "",
    meaningVi: s.meaningVi ?? "",
    example: s.example ?? "",
    synonyms: s.synonyms ?? "",
    antonyms: s.antonyms ?? ""
  };
}

// Called right after a duplicate is detected, with the page's sourceUrl (if
// any). Same link already stored -> do nothing. Different (or no) link
// stored -> update the word with the new one. Best-effort: a link isn't
// essential to the word already being saved, so this never throws.
async function vbSyncSourceUrl(existingWord, sourceUrl) {
  if (!sourceUrl) return;
  if ((existingWord.sourceUrl || null) === sourceUrl) return;
  try {
    await vbApiFetch(`/api/english/words/${existingWord.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        word: existingWord.word,
        senses: (existingWord.senses || []).map(vbSenseToInput),
        sourceUrl
      })
    });
  } catch {
    // best effort — never block the duplicate report on a link-update failure
  }
}

if (typeof module !== "undefined") {
  module.exports = {
    VB_LOGIN_URL,
    VbUnauthorizedError,
    vbEmptySense,
    vbNormalizeForDedup,
    vbApiFetch,
    vbGetAuthUser,
    vbValidateAndNormalize,
    vbMaybeValidateAndNormalize,
    vbCheckDuplicate,
    vbFlattenDictDefs,
    vbSenseToInput,
    vbSyncSourceUrl,
    vbBuildSensesFromDictionary,
    vbSuggestRelatedWordEntries,
    vbFullyAiAdd,
  };
}
