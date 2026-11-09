const SENSE_FIELDS = [
  { key: "phonetic", label: "Phiên âm (IPA)", type: "input" },
  { key: "partOfSpeech", label: "Loại từ (noun, verb...)", type: "input" },
  { key: "cambridgeMeaning", label: "Nghĩa Cambridge (tiếng Anh)", type: "textarea" },
  { key: "meaningVi", label: "Nghĩa tiếng Việt", type: "textarea" },
  { key: "example", label: "Ví dụ", type: "textarea" },
  { key: "synonyms", label: "Từ đồng nghĩa (phân cách bởi dấu phẩy)", type: "input" },
  { key: "antonyms", label: "Từ trái nghĩa (phân cách bởi dấu phẩy)", type: "input" }
];

function emptySense() {
  return { phonetic: "", partOfSpeech: "", cambridgeMeaning: "", meaningVi: "", example: "", synonyms: "", antonyms: "" };
}

const apiFetch = vbApiFetch;
let existingWord = null; // full EnglishWord when editing
let senses = [emptySense()];
let sourceUrl = null; // URL of the page the word was captured from, if any

// When embedded as an inline iframe (content.js on the page), there is no
// real window to close — tell the parent page to remove the iframe instead.
function closeAddWordUi() {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: "vb-close-add-word" }, "*");
  } else {
    window.close();
  }
}

const wordInput = document.querySelector("#wordInput");
const sensesEl = document.querySelector("#senses");
const modeTitle = document.querySelector("#modeTitle");
const statusEl = document.querySelector("#status");
const loadErrorEl = document.querySelector("#loadError");
const saveBtn = document.querySelector("#saveBtn");
const cancelBtn = document.querySelector("#cancelBtn");
const addSenseBtn = document.querySelector("#addSenseBtn");
const autoFillBtn = document.querySelector("#autoFillBtn");
const suggestRelatedBtn = document.querySelector("#suggestRelatedBtn");
const relatedListEl = document.querySelector("#relatedList");
let relatedSuggestions = [];
let relatedSelected = new Set();

function setStatus(text) {
  statusEl.textContent = text || "";
}

function showLoadError(text) {
  loadErrorEl.hidden = !text;
  loadErrorEl.textContent = text || "";
}

function renderSenses() {
  sensesEl.innerHTML = "";
  senses.forEach((sense, i) => {
    const card = document.createElement("div");
    card.className = "ewqa-sense";

    if (senses.length > 1) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "ewqa-remove-sense";
      removeBtn.textContent = "×";
      removeBtn.title = "Xoá nghĩa này";
      removeBtn.addEventListener("click", () => {
        senses = senses.filter((_, idx) => idx !== i);
        renderSenses();
      });
      card.appendChild(removeBtn);
    }

    const grid = document.createElement("div");
    grid.className = "ewqa-sense-grid2";
    ["phonetic", "partOfSpeech"].forEach((key) => {
      const field = SENSE_FIELDS.find((f) => f.key === key);
      grid.appendChild(buildField(sense, i, field));
    });
    card.appendChild(grid);

    ["cambridgeMeaning", "meaningVi", "example"].forEach((key) => {
      const field = SENSE_FIELDS.find((f) => f.key === key);
      card.appendChild(buildField(sense, i, field));
    });

    const grid2 = document.createElement("div");
    grid2.className = "ewqa-sense-grid2";
    ["synonyms", "antonyms"].forEach((key) => {
      const field = SENSE_FIELDS.find((f) => f.key === key);
      grid2.appendChild(buildField(sense, i, field));
    });
    card.appendChild(grid2);

    sensesEl.appendChild(card);
  });
}

function buildField(sense, index, field) {
  const wrap = document.createElement("div");
  wrap.className = "ewqa-field";
  const label = document.createElement("label");
  label.textContent = field.label;
  wrap.appendChild(label);

  const el = document.createElement(field.type === "textarea" ? "textarea" : "input");
  if (field.type === "input") el.type = "text";
  if (field.type === "textarea") el.rows = 2;
  el.value = sense[field.key] || "";
  el.addEventListener("input", (e) => {
    senses[index][field.key] = e.target.value;
  });
  wrap.appendChild(el);
  return wrap;
}

function hasAnyContent(sense) {
  return Object.values(sense).some((v) => v && String(v).trim());
}

function senseToDraft(s) {
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

// dictionaryapi.dev often returns duplicate entries (e.g. "mold" and "mould"
// both resolve to the same merged list) and orders definitions by etymology,
// not by how common they are — the everyday "mould" (fungus) sense can land
// far down the list behind an obsolete "mold" (shaping container) sense, and
// the actual crawl+dedupe+gloss work is shared with background.js's quick-add
// path — see shared.js (vbBuildSensesFromDictionary).

// Only used for a brand-new word (never when editing): fills the sense rows
// from the dictionary + Groq gloss. Never touches rows the user has already
// typed content into.
async function autoFillFromDictionary(wordText) {
  try {
    setStatus("Đang chọn nghĩa thường dùng và sinh nghĩa tiếng Việt...");
    const built = await vbBuildSensesFromDictionary(wordText);
    if (built.length === 0) return true;

    const wasUntouched = senses.length === 1 && !hasAnyContent(senses[0]);
    senses = wasUntouched ? built : [...senses, ...built];
    renderSenses();
    return true;
  } catch (err) {
    setStatus(err?.message || "Không tự động điền được, hãy nhập thủ công.");
    return false;
  }
}

async function loadForWord(rawWordText) {
  setStatus("Đang kiểm tra...");

  // Cheap, non-AI check first — skip lemmatize entirely on an exact repeat.
  let dup = await vbCheckDuplicate(rawWordText);
  let wordText = rawWordText;

  if (!dup.exists) {
    // Reject blank/gibberish, non-English, or full-sentence selections
    // before anything else. Also normalizes inflected forms ("depends" ->
    // "depend") so it lands on the same entry as other inflections.
    const { vbLemmatize = true } = await chrome.storage.local.get({ vbLemmatize: true });
    const check = await vbMaybeValidateAndNormalize(rawWordText, vbLemmatize);
    if (!check.valid) {
      showLoadError(check.reason);
      setStatus("");
      return;
    }
    wordText = check.normalized;

    // Normalization can reveal a duplicate the raw-text check missed (e.g.
    // "went up" -> "go up" already exists).
    if (wordText.toLowerCase() !== rawWordText.toLowerCase()) {
      dup = await vbCheckDuplicate(wordText);
    }
  }

  if (dup.exists) {
    setStatus("Từ này đã có trong từ điển — đang mở để sửa.");
    try {
      existingWord = await apiFetch(`/api/english/words/${dup.id}`);
    } catch (err) {
      showLoadError("Không kết nối được tới trang web: " + (err?.message || err));
      setStatus("");
      return;
    }
    await vbSyncSourceUrl(existingWord, sourceUrl);
    modeTitle.textContent = "Sửa từ (đã tồn tại)";
    wordInput.value = existingWord.word;
    senses = existingWord.senses.length > 0 ? existingWord.senses.map(senseToDraft) : [emptySense()];
    renderSenses();
    autoFillBtn.hidden = true;
    suggestRelatedBtn.hidden = true;
    setStatus("Từ này đã có trong từ điển — đang mở để sửa.");
    return;
  }

  modeTitle.textContent = "Thêm từ mới";
  wordInput.value = wordText;
  senses = [emptySense()];
  renderSenses();
  setStatus("Đang tự động điền và sinh nghĩa tiếng Việt...");
  // Runs alongside the dictionary auto-fill (not after it) so the extra AI
  // call doesn't add its own latency on top of the main add flow — both are
  // independent lookups keyed only on the word text itself.
  const relatedPromise = handleSuggestRelated(wordText, true);
  if (await autoFillFromDictionary(wordText)) setStatus("");
  await relatedPromise;
}

async function handleSave() {
  const wordText = wordInput.value.trim();
  if (!wordText) return;

  // Re-validate right before saving in case the user typed/edited the word
  // field themselves after the form loaded — never save a blank/gibberish,
  // non-English, or full-sentence entry, regardless of how it got here.
  // Skipped only when editing an existing word without changing its text,
  // since that already passed this check when it was first added.
  const isUnchangedExisting = existingWord && wordText.toLowerCase() === existingWord.word.trim().toLowerCase();
  if (!isUnchangedExisting) {
    setStatus("Đang kiểm tra...");
    const { vbLemmatize = true } = await chrome.storage.local.get({ vbLemmatize: true });
    const check = await vbMaybeValidateAndNormalize(wordText, vbLemmatize);
    if (!check.valid) {
      setStatus(check.reason);
      return;
    }
  }

  saveBtn.disabled = true;
  setStatus("Đang lưu...");
  try {
    // Related words the user kept checked get the reverse link folded into
    // the main word's own relatedWords field too, so the link is two-way —
    // not just the related word pointing back at this one.
    const toLinkBack = relatedSuggestions.filter((e) => !e.isExisting && relatedSelected.has(e.word)).map((e) => e.word);
    const relatedWords = toLinkBack.length > 0 ? toLinkBack.join(", ") : existingWord?.relatedWords || undefined;

    const payload = {
      word: wordText,
      senses: senses.filter(hasAnyContent).map((s) => ({
        phonetic: s.phonetic || null,
        partOfSpeech: s.partOfSpeech || null,
        cambridgeMeaning: s.cambridgeMeaning || null,
        meaningVi: s.meaningVi || null,
        example: s.example || null,
        synonyms: s.synonyms || null,
        antonyms: s.antonyms || null
      })),
      ...(relatedWords !== undefined ? { relatedWords } : {})
    };

    if (existingWord) {
      await apiFetch(`/api/english/words/${existingWord.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      await apiFetch("/api/english/words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, sourceUrl })
      });
    }
    await saveSelectedRelated(wordText);
    closeAddWordUi();
  } catch (err) {
    setStatus("Lỗi: " + (err?.message || err));
    saveBtn.disabled = false;
  }
}

function renderRelatedSuggestions() {
  relatedListEl.innerHTML = "";
  relatedListEl.hidden = relatedSuggestions.length === 0;
  relatedSuggestions.forEach((entry) => {
    const item = document.createElement("label");
    item.className = "ewqa-related-item" + (entry.isExisting ? " ewqa-related-existing" : "");

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.disabled = entry.isExisting;
    checkbox.checked = relatedSelected.has(entry.word);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) relatedSelected.add(entry.word);
      else relatedSelected.delete(entry.word);
    });
    item.appendChild(checkbox);

    const info = document.createElement("div");
    const title = document.createElement("div");
    const wordSpan = document.createElement("span");
    wordSpan.className = "ewqa-related-word";
    wordSpan.textContent = entry.word;
    title.appendChild(wordSpan);
    const posSpan = document.createElement("span");
    posSpan.className = "ewqa-related-pos";
    posSpan.textContent = "(" + entry.pos + ")" + (entry.isExisting ? " — đã có trong từ điển" : "");
    title.appendChild(posSpan);
    info.appendChild(title);
    (entry.senses || []).forEach((s) => {
      const p = document.createElement("p");
      p.className = "ewqa-related-sense";
      p.textContent = s.meaningVi;
      info.appendChild(p);
    });
    item.appendChild(info);

    relatedListEl.appendChild(item);
  });
}

// `silent` is used when this runs automatically alongside the dictionary
// auto-fill on load (loadForWord) so it doesn't fight that flow's own status
// messages — the button click path still reports its own status.
async function handleSuggestRelated(explicitWordText, silent) {
  const wordText = explicitWordText ?? wordInput.value.trim();
  if (!wordText) return;
  suggestRelatedBtn.disabled = true;
  if (!silent) setStatus("Đang tìm từ liên đới...");
  try {
    const partOfSpeech = senses[0]?.partOfSpeech || "";
    relatedSuggestions = await vbSuggestRelatedWordEntries(wordText, partOfSpeech);
    relatedSelected = new Set(relatedSuggestions.filter((e) => !e.isExisting).map((e) => e.word));
    renderRelatedSuggestions();
    if (!silent) setStatus(relatedSuggestions.length === 0 ? "AI không tìm thấy từ liên đới phù hợp." : "");
  } catch (err) {
    if (!silent) setStatus(err?.message || "Không tìm được từ liên đới.");
  } finally {
    suggestRelatedBtn.disabled = false;
  }
}

// Saves every selected (non-existing) related-word suggestion as its own
// full word entry, same request shape handleSave uses for the main word.
// Fire-and-continue per word so one failure doesn't block the rest; failures
// are reported in the status line, not thrown, since the main word's own
// save is unaffected by this.
// Returns the comma-separated relatedWords list this related word should be
// saved with: the main word plus every sibling in this same batch, so the
// group forms a mesh (concentrate <-> concentration, not just both pointing
// at "concentrated" alone).
function relatedWordsFieldFor(entry, mainWordText, toSave) {
  return [mainWordText, ...toSave.filter((o) => o !== entry).map((o) => o.word)].join(", ");
}

async function saveSelectedRelated(mainWordText) {
  const toSave = relatedSuggestions.filter((e) => !e.isExisting && relatedSelected.has(e.word));
  if (toSave.length === 0) return [];
  const saved = [];
  for (const entry of toSave) {
    try {
      await apiFetch("/api/english/words", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          word: entry.word,
          senses: entry.senses.map((s) => ({
            phonetic: s.phonetic || null,
            partOfSpeech: s.partOfSpeech || null,
            cambridgeMeaning: s.cambridgeMeaning || null,
            meaningVi: s.meaningVi || null,
            example: s.example || null,
            synonyms: s.synonyms || null,
            antonyms: s.antonyms || null
          })),
          relatedWords: relatedWordsFieldFor(entry, mainWordText, toSave)
        })
      });
      saved.push(entry.word);
    } catch (err) {
      setStatus("Không lưu được từ liên đới \"" + entry.word + "\": " + (err?.message || err));
    }
  }
  return saved;
}

function disableForm() {
  saveBtn.disabled = true;
  addSenseBtn.disabled = true;
  autoFillBtn.disabled = true;
  suggestRelatedBtn.disabled = true;
  wordInput.disabled = true;
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const wordText = (params.get("word") || "").trim();
  sourceUrl = params.get("sourceUrl") || null;

  renderSenses();

  const user = await vbGetAuthUser();
  if (!user) {
    disableForm();
    const link = document.createElement("a");
    link.href = VB_LOGIN_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Đăng nhập trên web";
    loadErrorEl.replaceChildren("Bạn chưa đăng nhập — ", link, " rồi thử lại.");
    loadErrorEl.hidden = false;
    return;
  }

  if (!wordText) {
    showLoadError("Không có từ nào được chọn.");
    return;
  }

  await loadForWord(wordText);
}

addSenseBtn.addEventListener("click", () => {
  senses.push(emptySense());
  renderSenses();
});

autoFillBtn.addEventListener("click", async () => {
  const wordText = wordInput.value.trim();
  if (!wordText) return;
  autoFillBtn.disabled = true;
  setStatus("Đang tự động điền và sinh nghĩa tiếng Việt...");
  if (await autoFillFromDictionary(wordText)) setStatus("");
  autoFillBtn.disabled = false;
});

suggestRelatedBtn.addEventListener("click", () => handleSuggestRelated());
saveBtn.addEventListener("click", handleSave);
cancelBtn.addEventListener("click", () => closeAddWordUi());

init();
