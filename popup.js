const authStatusEl = document.getElementById("vb-auth-status");
const toggle = document.getElementById("vb-enabled-toggle");
const label = document.getElementById("vb-enabled-label");
const saveLinkToggle = document.getElementById("vb-savelink-toggle");
const saveLinkLabel = document.getElementById("vb-savelink-label");
const lemmatizeToggle = document.getElementById("vb-lemmatize-toggle");
const lemmatizeLabel = document.getElementById("vb-lemmatize-label");

function render(enabled) {
  toggle.checked = enabled;
  label.textContent = enabled ? "Đang bật" : "Đang tắt";
}

function renderSaveLink(saveLink) {
  saveLinkToggle.checked = saveLink;
  saveLinkLabel.textContent = saveLink ? "Lưu link nguồn" : "Không lưu link nguồn";
}

function renderLemmatize(lemmatize) {
  lemmatizeToggle.checked = lemmatize;
  lemmatizeLabel.textContent = lemmatize ? "Chuẩn hoá từ (lemmatize)" : "Không chuẩn hoá từ (lemmatize)";
}

vbGetAuthUser().then((user) => {
  authStatusEl.textContent = "";
  if (user) {
    authStatusEl.textContent = "Đã đăng nhập: " + user.email;
    authStatusEl.classList.add("vb-auth-status--ok");
  } else {
    authStatusEl.classList.add("vb-auth-status--out");
    const link = document.createElement("a");
    link.href = VB_LOGIN_URL;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Đăng nhập";
    authStatusEl.append("Chưa đăng nhập — ", link, " để dùng được tính năng.");
  }
});

chrome.storage.local.get(
  { vbEnabled: true, vbSaveLink: true, vbLemmatize: true },
  ({ vbEnabled, vbSaveLink, vbLemmatize }) => {
    render(vbEnabled);
    renderSaveLink(vbSaveLink);
    renderLemmatize(vbLemmatize);
  }
);

toggle.addEventListener("change", () => {
  const enabled = toggle.checked;
  chrome.storage.local.set({ vbEnabled: enabled });
  render(enabled);
});

saveLinkToggle.addEventListener("change", () => {
  const saveLink = saveLinkToggle.checked;
  chrome.storage.local.set({ vbSaveLink: saveLink });
  renderSaveLink(saveLink);
});

lemmatizeToggle.addEventListener("change", () => {
  const lemmatize = lemmatizeToggle.checked;
  chrome.storage.local.set({ vbLemmatize: lemmatize });
  renderLemmatize(lemmatize);
});
