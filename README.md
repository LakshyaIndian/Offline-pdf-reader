# Offline PDF Reader

A fully static, dark-mode PWA for reading PDF files locally in your browser.  
No server, no cloud storage — all PDFs are stored in your browser's IndexedDB.

## Features

- **Offline-first** — works after first load with no internet connection
- **Local storage** — PDFs never leave your device; stored in IndexedDB
- **Dark Kindle-like UI** — warm dark theme with extra-dim and warm-tint variants
- **Library** — see all imported PDFs with size, date added, last opened, last page
- **Reader** — page-by-page navigation, zoom (fit-width, fit-page, custom %), keyboard shortcuts
- **Reading progress** — automatically resumes from the last page you read
- **Import** — drag-and-drop or file picker; accepts only PDF files
- **Delete** — remove PDFs from local storage with confirmation
- **Search & sort** — filter by name, sort by newest / oldest / name / last-opened
- **Installable PWA** — add to home screen on mobile or desktop

---

## Running locally

No build step required — it's plain HTML/CSS/JS.

### Option A — Python HTTP server (recommended)

```bash
cd offline-pdf-reader
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

> **Why a server?** Service workers and ES modules require a `http://` or `https://` origin.  
> Opening `index.html` directly via `file://` will not work correctly.

### Option B — Node http-server

```bash
npx http-server . -p 8080 -c-1
```

### Option C — VS Code Live Server extension

Right-click `index.html` → *Open with Live Server*.

---

## Deploying to GitHub Pages

### 1. Create a GitHub repository

```bash
git init
git add .
git commit -m "Initial commit: Offline PDF Reader PWA"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Enable GitHub Pages

1. Go to **Settings → Pages** in your repository.
2. Set **Source** to `Deploy from a branch`.
3. Choose branch `main` (or `gh-pages`) and root folder `/`.
4. Click **Save**.

Your site will be live at:
```
https://YOUR_USERNAME.github.io/YOUR_REPO/
```

### 3. Sub-path note

All asset paths in this project use `./` relative paths (e.g. `./styles.css`,
`./sw.js`), so they work correctly on both:

- Root deployment: `https://example.github.io/`
- Sub-path deployment: `https://example.github.io/my-repo/`

No configuration changes are needed.

### 4. HTTPS requirement

GitHub Pages serves over HTTPS automatically, which is required for:
- Service workers (offline caching)
- PWA installation prompts

---

## Project structure

```
offline-pdf-reader/
├── index.html        # App shell: library + reader screens
├── styles.css        # Dark-mode styles, responsive layout
├── app.js            # Main logic: library, reader, UI events
├── db.js             # IndexedDB wrapper (open, save, get, update, delete)
├── sw.js             # Service worker: app-shell caching
├── manifest.json     # PWA manifest (icons, theme, display mode)
├── icons/
│   ├── icon-192.png  # PWA icon 192×192
│   └── icon-512.png  # PWA icon 512×512
└── README.md
```

---

## Browser storage limitations

| Browser | IndexedDB quota | Notes |
|---------|----------------|-------|
| Chrome / Edge | ~80 % of available disk | Generous; large PDF collections work fine |
| Firefox | ~50 % of available disk | Good capacity |
| Safari / iOS | ~1 GB per origin (may vary) | Safari may prompt the user for extra quota |
| All | Cleared by "Clear site data" | Warn users not to clear browsing data |

### Quota exceeded

If storage is full the app shows a user-friendly toast:

> *Storage quota exceeded. Delete some PDFs to free space.*

### Persistence hint

Stored data can survive browser restarts but may be cleared if the browser needs
space (in non-persistent mode). To request persistent storage (Chrome/Firefox):

```js
// Already called in db.js on first open
navigator.storage.persist().then(granted => { … });
```

---

## Keyboard shortcuts (Reader)

| Key | Action |
|-----|--------|
| `→` / `↓` / `Page Down` | Next page |
| `←` / `↑` / `Page Up`   | Previous page |
| `Escape`                 | Back to library |

---

## Offline behaviour

1. **First visit** — the service worker installs and caches the app shell.
2. **Subsequent visits (offline)** — the app shell is served from cache; PDFs
   are served from IndexedDB.
3. **PDF.js CDN** — PDF.js is loaded from cdnjs.cloudflare.com and cached on
   first use. If the device has never been online the reader will not work until
   the CDN files are in cache.

---

## Limitations

- PDFs are stored per-browser per-device. They do not sync across devices.
- Clearing "site data" or "cached files" in browser settings will delete all stored PDFs.
- Very large PDFs (> 200 MB) may be slow to import or render depending on device memory.
- PDF forms and annotations are not supported (display-only rendering via PDF.js).
