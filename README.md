# Vocal Bubble

Chrome extension: select an English word/phrase on any page, right-click → **Add word**.
A small popup window opens, pre-filled with the selected text. If the word already exists
in your English Study list it loads in edit mode with its current data instead.

API calls point to `https://personal-blog-five-ruddy.vercel.app` (hardcoded in `addword.js`).

## Setup

1. Open `chrome://extensions`, enable "Developer mode".
2. "Load unpacked" → select this folder.

## Usage

1. Select a word/phrase on any page → right-click → "Add word".
2. Phiên âm / loại từ / nghĩa are auto-filled from the dictionary (and translate API)
   when adding a new word. Edit any field as needed.
3. Click **Lưu** to save and close the window.

Related-words linking is intentionally left out — add those from the main app.
