importScripts("shared.js");

// Fully automatic add, used by the floating "+" button — never shows any UI.
// Per explicit decision: no dictionaryapi.dev crawl, no wink-lemmatizer —
// ONE Groq call (vbFullyAiAdd) validates the raw selection is a real English
// word/phrase, normalizes it to its dictionary base form, and writes full
// entries (phonetic, senses, synonyms/antonyms) for it AND its word family
// (related verb/noun/adj/phrase forms), all at once. A word already in the
// user's list is never touched — checked BEFORE the AI call (by raw text)
// and again AFTER (by the AI-decided lemma, which can differ from the raw
// text), so a repeat add never spends tokens and is just reported back as
// "duplicate" (to add more senses to an existing word, edit it manually via
// the add-word form instead).
async function quickAddWord(wordText, sourceUrl) {
  const trimmed = (wordText || "").trim();
  if (!trimmed) return { status: "error", message: "Không có từ nào được chọn." };

  // Gate every call up front, not just on whichever API call happens to hit
  // a 401 first — a logged-out user shouldn't spend a lemmatize/AI call
  // just to find out they need to log in.
  const user = await vbGetAuthUser();
  if (!user) return { status: "unauthorized" };

  const { vbSaveLink = true } = await chrome.storage.local.get({ vbSaveLink: true });
  if (!vbSaveLink) sourceUrl = null;

  // Passing sourceUrl here is what actually groups an already-existing word
  // under the new page too (server-side, inside the GET itself) — a prior
  // bug had this call never send sourceUrl at all, so re-adding a word from
  // a different page's group silently did nothing.
  const rawDup = await vbCheckDuplicate(trimmed, sourceUrl);
  if (rawDup.exists) return { status: "duplicate", word: rawDup.word };

  const result = await vbFullyAiAdd(trimmed);
  if (!result.valid) return { status: "rejected", message: result.reason };
  const { lemma, mainSenses, related } = result;

  // The AI-decided lemma can differ from the raw selection (e.g. "went" ->
  // "go") — check again before saving, same as the old lemmatize path did.
  if (vbNormalizeForDedup(lemma) !== vbNormalizeForDedup(trimmed)) {
    const lemmaDup = await vbCheckDuplicate(lemma, sourceUrl);
    if (lemmaDup.exists) return { status: "duplicate", word: lemmaDup.word };
  }

  // Cross-link lemma <-> each newly-saved related word (and the related
  // words to each other) via the relatedWords field, same as the add-word
  // form's own related-word flow — otherwise e.g. "draw" and "draw up" get
  // saved as two unconnected entries with no visible link between them.
  // Already-existing related words are left untouched (same limitation the
  // form flow has): we'd need to merge into their current relatedWords via
  // a PUT, not attempted here.
  const newRelated = related.filter((e) => !e.isExisting);

  await vbApiFetch("/api/english/words", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      word: lemma,
      senses: mainSenses.map(vbSenseToInput),
      relatedWords: newRelated.map((e) => e.word).join(", ") || null,
      sourceUrl: sourceUrl || null
    })
  });

  const relatedAdded = [];
  for (const entry of newRelated) {
    const linkedWords = [lemma, ...newRelated.filter((o) => o !== entry).map((o) => o.word)].join(", ");
    try {
      await vbApiFetch("/api/english/words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ word: entry.word, senses: entry.senses.map(vbSenseToInput), relatedWords: linkedWords })
      });
      relatedAdded.push(entry.word);
    } catch {
      // best effort — one related word failing to save never blocks the rest
    }
  }

  return { status: "added", word: lemma, relatedAdded };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "openLoginTab") {
    chrome.tabs.create({ url: VB_LOGIN_URL });
    return false;
  }
  if (msg?.type === "quickAddWord") {
    quickAddWord(msg.word, _sender.tab?.url)
      .then(sendResponse)
      .catch((err) => {
        if (err instanceof VbUnauthorizedError) sendResponse({ status: "unauthorized" });
        else sendResponse({ status: "error", message: err?.message || String(err) });
      });
    return true; // keep the message channel open for the async response
  }
});
