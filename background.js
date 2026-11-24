importScripts("shared.js");

// Fully automatic add, used by the floating "+" button — never shows any UI.
// Per explicit decision, lemmatize and lookup are separate steps so a word
// already in the user's list never reaches the (expensive) lookup call:
//   1. AI lemmatize (vbAiLemmatize): validates the raw selection is a real
//      English word/phrase and normalizes it to its dictionary base form.
//      Skipped entirely — no validation either, per explicit decision — when
//      the popup's lemmatize toggle (vbLemmatize) is off; the raw text is
//      then used as-is.
//   2. Duplicate check on the lemma (vbCheckDuplicate) — reported back as
//      "duplicate" and never touched (to add more senses to an existing
//      word, edit it manually via the add-word form instead).
//   3. Only for a new word: AI lookup (vbAiLookup) writes full entries
//      (phonetic, senses, synonyms/antonyms) for it AND its word family.
// A cheap raw-text duplicate check also runs before step 1 so an exact
// repeat add never spends any AI tokens at all.
async function quickAddWord(wordText, sourceUrl) {
  const trimmed = (wordText || "").trim();
  if (!trimmed) return { status: "error", message: "Không có từ nào được chọn." };

  // Gate every call up front, not just on whichever API call happens to hit
  // a 401 first — a logged-out user shouldn't spend a lemmatize/AI call
  // just to find out they need to log in.
  const user = await vbGetAuthUser();
  if (!user) return { status: "unauthorized" };

  const { vbSaveLink = true, vbLemmatize = true } = await chrome.storage.local.get({ vbSaveLink: true, vbLemmatize: true });
  if (!vbSaveLink) sourceUrl = null;

  // Passing sourceUrl here is what actually groups an already-existing word
  // under the new page too (server-side, inside the GET itself) — a prior
  // bug had this call never send sourceUrl at all, so re-adding a word from
  // a different page's group silently did nothing.
  const rawDup = await vbCheckDuplicate(trimmed, sourceUrl);
  if (rawDup.exists) return { status: "duplicate", word: rawDup.word };

  // Step 1: lemmatize (or keep the raw text when the toggle is off).
  let lemma = trimmed;
  if (vbLemmatize) {
    const check = await vbAiLemmatize(trimmed);
    if (!check.valid) return { status: "rejected", message: check.reason };
    lemma = check.lemma;
  }

  // Step 2: the lemma can differ from the raw selection (e.g. "went" ->
  // "go") — check the DB again before looking anything up.
  if (vbNormalizeForDedup(lemma) !== vbNormalizeForDedup(trimmed)) {
    const lemmaDup = await vbCheckDuplicate(lemma, sourceUrl);
    if (lemmaDup.exists) return { status: "duplicate", word: lemmaDup.word };
  }

  // Step 3: look the new word up.
  const { mainSenses, related } = await vbAiLookup(lemma);
  if (mainSenses.length === 0) {
    return { status: "rejected", message: `AI không tạo được nghĩa cho "${lemma}". Thử lại sau hoặc thêm thủ công.` };
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
