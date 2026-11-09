(() => {
  let btnEl = null;
  let currentWord = "";
  let currentRange = null;
  let vbEnabled = true;
  const VIEWPORT_MARGIN = 8;
  const MAX_WORD_LENGTH = 80;

  chrome.storage.local.get({ vbEnabled: true }, (res) => {
    vbEnabled = res.vbEnabled;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "vbEnabled" in changes) {
      vbEnabled = changes.vbEnabled.newValue;
      if (!vbEnabled) removeBtn();
    }
  });

  const removeBtn = () => {
    if (btnEl) {
      btnEl.remove();
      btnEl = null;
    }
  };

  document.addEventListener("mouseup", (e) => {
    if (!vbEnabled) return;
    if (btnEl && btnEl.contains(e.target)) return;
    // Defer so window.getSelection() reflects the just-finished drag.
    setTimeout(() => {
      removeBtn();
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      if (!text || text.length > MAX_WORD_LENGTH) return;
      showButtonForSelection(sel, text);
    }, 0);
  });

  document.addEventListener("mousedown", (e) => {
    if (btnEl && !btnEl.contains(e.target)) removeBtn();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") removeBtn();
  });

  // Selection usually disappears once the page scrolls; drop the stale button.
  document.addEventListener("scroll", removeBtn, true);

  function showButtonForSelection(sel, text) {
    currentWord = text;
    let range;
    let rect;
    try {
      range = sel.getRangeAt(0).cloneRange();
      rect = range.getBoundingClientRect();
    } catch {
      return;
    }
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    currentRange = range;

    const btn = document.createElement("div");
    btnEl = btn;
    btn.className = "vb-add-btn";
    btn.textContent = "+ Thêm: " + (text.length > 24 ? text.slice(0, 24) + "…" : text);

    const top = rect.bottom + 6;
    const left = rect.left;
    btn.style.top = top + "px";
    btn.style.left = left + "px";

    btn.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    });
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      highlightRange(currentRange);
      runQuickAdd(currentWord);
      removeBtn();
    });

    document.body.appendChild(btn);
    keepInViewport(btn, top, left);
  }

  function runQuickAdd(word) {
    if (!chrome.runtime?.id) {
      showToast("Lỗi: extension vừa reload", "error");
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "quickAddWord", word }, (resp) => {
        if (chrome.runtime.lastError) {
          showToast("Lỗi: extension vừa reload", "error");
        } else if (resp?.status === "added") {
          const extra = resp.relatedAdded?.length ? ` (+${resp.relatedAdded.length} từ liên đới: ${resp.relatedAdded.join(", ")})` : "";
          showToast("✓ Đã thêm: " + resp.word + extra, "ok");
        } else if (resp?.status === "duplicate") {
          showToast("Đã có từ: " + resp.word, "dup");
        } else if (resp?.status === "rejected") {
          showToast(resp.message || "Không thể thêm.", "error");
        } else if (resp?.status === "unauthorized") {
          showLoginToast();
        } else {
          showToast("Lỗi: " + (resp?.message || "không rõ"), "error");
        }
      });
    } catch (e) {
      showToast("Lỗi: extension vừa reload", "error");
    }
  }

  // Corner toast for the quick-add result — the button itself disappears
  // immediately on click, so the outcome is reported here instead.
  let toastEl = null;
  let toastTimer = null;
  function showToast(message, kind) {
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);

    const toast = document.createElement("div");
    toastEl = toast;
    toast.className = "vb-toast vb-toast--" + kind;
    toast.textContent = message;
    document.body.appendChild(toast);

    toastTimer = setTimeout(() => {
      if (toastEl === toast) {
        toast.remove();
        toastEl = null;
      }
    }, 3000);
  }

  // Same toast, but for the "not logged in" case: stays up longer and is
  // itself clickable to open the login page in a new tab, since the content
  // script has no chrome.tabs access of its own (relayed via background.js).
  function showLoginToast() {
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);

    const toast = document.createElement("div");
    toastEl = toast;
    toast.className = "vb-toast vb-toast--error vb-toast--clickable";
    toast.textContent = "Bạn chưa đăng nhập. Bấm để đăng nhập trên web.";
    toast.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openLoginTab" });
      toast.remove();
      toastEl = null;
    });
    document.body.appendChild(toast);

    toastTimer = setTimeout(() => {
      if (toastEl === toast) {
        toast.remove();
        toastEl = null;
      }
    }, 6000);
  }

  // Marks the just-added word yellow right where it was selected on the
  // page, so it's visually obvious which word was just captured.
  function highlightRange(range) {
    if (!range) return;
    try {
      const mark = document.createElement("mark");
      mark.className = "vb-highlight-added";
      range.surroundContents(mark);
    } catch {
      // Range spans multiple elements unevenly (surroundContents requires a
      // range that doesn't partially select a non-text node) — wrap each
      // text node inside the range individually instead.
      try {
        const contents = range.extractContents();
        const mark = document.createElement("mark");
        mark.className = "vb-highlight-added";
        mark.appendChild(contents);
        range.insertNode(mark);
      } catch {
        // best effort, skip highlighting rather than break the page
      }
    }
  }

  function keepInViewport(el, preferredTop, preferredLeft) {
    const rect = el.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN);
    const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(preferredLeft, VIEWPORT_MARGIN), maxLeft);
    const top = Math.min(Math.max(preferredTop, VIEWPORT_MARGIN), maxTop);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }
})();
