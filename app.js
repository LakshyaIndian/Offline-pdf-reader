/**
 * app.js — Offline PDF Reader
 * Main application logic: library management, PDF rendering,
 * UI interactions, service-worker registration.
 *
 * Depends on:
 *  - db.js      (IndexedDB helpers, loaded as ES module)
 *  - PDF.js     (loaded from CDN, sets globalThis.pdfjsLib)
 */

import {
  saveDocument,
  getAllDocumentsMeta,
  getDocumentById,
  getProgress,
  saveProgress,
  deleteDocument,
} from './db.js';

import {
  buildSearchIndex,
  searchIndex,
  renderHighlights,
  itemToCanvasRect,
} from './search.js';

// ── PDF.js worker source (loaded from same CDN) ──────────────────────────────
// We delay setting this until pdfjsLib is confirmed available.
const PDFJS_VERSION = '3.11.174';
const PDFJS_CDN = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}`;

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  /** All PDF metadata records from IndexedDB (no blobs) */
  pdfs: [],
  /** Currently rendered PDF document (PDFDocumentProxy) */
  currentDoc: null,
  /** ID of the currently open PDF in the reader */
  currentPdfId: null,
  /** Current page number (1-based) */
  currentPage: 1,
  /** Total pages in current document */
  totalPages: 0,
  /** Current zoom scale (1.0 = 100 %) */
  zoomScale: 1.0,
  /** 'fit-width' | 'fit-page' | number */
  zoomMode: 'fit-width',
  /** Reading theme: 'default' | 'dim' | 'warm' | 'invert' */
  theme: 'default',
  /** Whether a render is in progress (prevents double-renders) */
  rendering: false,
  /** Library search filter string */
  searchQuery: '',
  /** Library sort order */
  sortOrder: 'newest',
  /** PDF viewport from the last renderPage() call — used for highlight geometry */
  currentViewport: null,

  /** In-reader text search state (session-only, never persisted) */
  search: {
    /** Text index built from the current PDF's getTextContent() calls */
    pageIndex: null,
    /** Whether the index is currently being built */
    indexBuilding: false,
    /** AbortController for cancelling an in-progress index build */
    indexAbort: null,
    /** All matches found by the most recent search */
    matches: [],
    /** Index into matches[] of the currently highlighted match */
    activeIndex: -1,
    /** The query string that produced current matches */
    query: '',
  },
};

// ── DOM references ───────────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const libraryScreen  = $('#library-screen');
const readerScreen   = $('#reader-screen');
const pdfList        = $('#pdf-list');
const emptyState     = $('#empty-state');
const dropZone       = $('#drop-zone');
const searchInput    = $('#search-input');
const sortSelect     = $('#sort-select');
const fileInput      = $('#file-input');

const readerFilename   = $('#reader-filename');
const btnBack          = $('#btn-back');
const btnPrevPage      = $('#btn-prev-page');
const btnNextPage      = $('#btn-next-page');
const pageInput        = $('#page-input');
const pageTotal        = $('#page-total');
const btnZoomIn        = $('#btn-zoom-in');
const btnZoomOut       = $('#btn-zoom-out');
const btnFitWidth      = $('#btn-fit-width');
const btnFitPage       = $('#btn-fit-page');
const zoomSelect       = $('#zoom-select');
const btnAppearance    = $('#btn-appearance');
const appearancePanel  = $('#appearance-panel');
const pdfCanvas        = $('#pdf-canvas');
const overlayCanvas    = $('#search-overlay');
const pdfPageWrap      = $('#pdf-page-wrap');
const canvasContainer  = $('#canvas-container');
const readerLoading    = $('#reader-loading');

// Search bar elements
const searchBar          = $('#search-bar');
const btnSearchToggle    = $('#btn-search-toggle');
const readerSearchInput  = $('#reader-search-input');
const btnSearchClear     = $('#btn-search-clear');
const searchCountEl      = $('#search-count');
const btnSearchPrev      = $('#btn-search-prev');
const btnSearchNext      = $('#btn-search-next');
const searchMatchCase    = $('#search-match-case');
const searchWholeWord    = $('#search-whole-word');
const searchStatusEl     = $('#search-status');

const deleteModal      = $('#delete-modal');
const deleteModalName  = $('#delete-modal-name');
const btnDeleteConfirm = $('#btn-delete-confirm');
const btnDeleteCancel  = $('#btn-delete-cancel');

const importLoading    = $('#import-loading');
const toastContainer   = $('#toast-container');

// ── Initialise ───────────────────────────────────────────────────────────────
async function init() {
  registerServiceWorker();
  setupEventListeners();
  // Restore previously chosen theme before rendering anything
  const savedTheme = localStorage.getItem('pdfReaderTheme') || 'default';
  applyTheme(savedTheme);
  await loadLibrary();
  showScreen('library');
}

// ── Service Worker ────────────────────────────────────────────────────────────
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    // Use relative path so it works on GH Pages sub-paths
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => console.log('[SW] Registered, scope:', reg.scope))
      .catch((err) => console.warn('[SW] Registration failed:', err));
  }
}

// ── Screen navigation ─────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  if (name === 'library') libraryScreen.classList.add('active');
  if (name === 'reader')  readerScreen.classList.add('active');
}

// ── Library ───────────────────────────────────────────────────────────────────
async function loadLibrary() {
  try {
    state.pdfs = await getAllDocumentsMeta();
    renderLibrary();
  } catch (err) {
    showToast('Failed to load library: ' + err.message, 'error');
  }
}

function renderLibrary() {
  const query  = state.searchQuery.toLowerCase();
  const order  = state.sortOrder;

  let list = query
    ? state.pdfs.filter((p) => p.name.toLowerCase().includes(query))
    : [...state.pdfs];

  list.sort((a, b) => {
    switch (order) {
      case 'newest':      return b.dateAdded - a.dateAdded;
      case 'oldest':      return a.dateAdded - b.dateAdded;
      case 'name':        return a.name.localeCompare(b.name);
      case 'last-opened': {
        const la = a.lastOpened ?? 0;
        const lb = b.lastOpened ?? 0;
        return lb - la;
      }
      default: return 0;
    }
  });

  pdfList.innerHTML = '';

  if (list.length === 0) {
    emptyState.classList.add('visible');
    dropZone.classList.add('visible');
  } else {
    emptyState.classList.remove('visible');
    dropZone.classList.remove('visible');
    list.forEach((pdf) => pdfList.appendChild(createPDFCard(pdf)));
  }
}

function createPDFCard(pdf) {
  const card = document.createElement('article');
  card.className = 'pdf-card';
  card.dataset.id = pdf.id;

  const sizeStr   = formatBytes(pdf.size);
  const addedStr  = formatDate(pdf.dateAdded);
  const openedStr = pdf.lastOpened ? formatDate(pdf.lastOpened) : 'Never';
  const pageStr   = pdf.lastPage > 1 ? `p.${pdf.lastPage}` : null;

  card.innerHTML = `
    ${pageStr ? `<span class="pdf-card__page-badge">${pageStr}</span>` : ''}
    <div class="pdf-card__name" title="${escapeHtml(pdf.name)}">${escapeHtml(pdf.name)}</div>
    <div class="pdf-card__meta">
      <span>${svgIcon('file', 12)} ${sizeStr}</span>
      <span>${svgIcon('calendar', 12)} ${addedStr}</span>
      <span>${svgIcon('clock', 12)} ${openedStr}</span>
    </div>
    <div class="pdf-card__actions">
      <button class="btn-open" aria-label="Open ${escapeHtml(pdf.name)}">
        ${svgIcon('book-open', 14)} Open
      </button>
      <button class="btn-delete-card" aria-label="Delete ${escapeHtml(pdf.name)}">
        ${svgIcon('trash', 14)}
      </button>
    </div>
  `;

  card.querySelector('.btn-open').addEventListener('click', () => openPDF(pdf.id));
  card.querySelector('.btn-delete-card').addEventListener('click', () => confirmDelete(pdf.id, pdf.name));

  return card;
}

// ── Import PDF ────────────────────────────────────────────────────────────────
async function importFile(file) {
  if (!file || file.type !== 'application/pdf') {
    showToast('Only PDF files are accepted.', 'error');
    return;
  }

  // 50 MB soft warning — IndexedDB has no hard cap but browsers vary
  const MAX_WARN = 50 * 1024 * 1024;
  if (file.size > MAX_WARN) {
    showToast(`Large file (${formatBytes(file.size)}) — import may be slow.`, 'info');
  }

  showImportLoading(true);

  try {
    const arrayBuffer = await file.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
    const id = await saveDocument({ name: file.name, size: file.size, blob });
    await loadLibrary();
    showToast(`"${file.name}" imported successfully.`, 'success');
    // Optionally open immediately
    // openPDF(id);
  } catch (err) {
    if (err.name === 'QuotaExceededError' || (err.message && err.message.includes('quota'))) {
      showToast('Storage quota exceeded. Delete some PDFs to free space.', 'error');
    } else {
      showToast('Import failed: ' + err.message, 'error');
    }
  } finally {
    showImportLoading(false);
    fileInput.value = ''; // reset so same file can be re-imported
  }
}

// ── Open / Reader ─────────────────────────────────────────────────────────────
async function openPDF(id) {
  showReaderLoading(true);
  showScreen('reader');

  try {
    // Ensure PDF.js is ready
    await ensurePDFjs();

    // Read blob and progress separately — never combine them in one write later.
    // getDocumentById fetches the blob from the documents store (read-only).
    // getProgress fetches lastPage from the progress store (read-only).
    // These are two independent reads; no transaction spans both.
    const doc      = await getDocumentById(id);
    if (!doc) throw new Error('PDF not found in storage.');
    const progress = await getProgress(id);

    const blobUrl = URL.createObjectURL(doc.blob);

    // Load document
    const loadingTask = pdfjsLib.getDocument({
      url: blobUrl,
      cMapUrl: `${PDFJS_CDN}/cmaps/`,
      cMapPacked: true,
    });
    const pdfDoc = await loadingTask.promise;

    // Clean up previous document
    if (state.currentDoc) {
      state.currentDoc.destroy();
      if (state._blobUrl) URL.revokeObjectURL(state._blobUrl);
    }

    state.currentDoc   = pdfDoc;
    state.currentPdfId = id;
    state.totalPages   = pdfDoc.numPages;
    state.currentPage  = progress?.lastPage || 1;
    state._blobUrl     = blobUrl;

    readerFilename.textContent = doc.name;
    pageTotal.textContent      = `/ ${state.totalPages}`;

    await renderPage(state.currentPage);
    updateNavButtons();

    // Record that the PDF was opened — writes ONLY { docId, lastPage, lastOpened }
    // to the progress store.  The blob in the documents store is never touched.
    await saveProgress({ docId: id, lastPage: state.currentPage });
    await loadLibrary(); // refresh card last-opened date

    // Reset search state for the newly opened document, then start building
    // the text index in the background so search is ready quickly.
    _resetSearchState();
    _buildIndexInBackground(pdfDoc);
  } catch (err) {
    showToast('Failed to open PDF: ' + err.message, 'error');
    showScreen('library');
  } finally {
    showReaderLoading(false);
  }
}

async function renderPage(pageNum) {
  if (!state.currentDoc || state.rendering) return;
  state.rendering = true;

  try {
    const page     = await state.currentDoc.getPage(pageNum);
    const viewport = computeViewport(page);

    // Resize both canvases to match the viewport
    pdfCanvas.width     = viewport.width;
    pdfCanvas.height    = viewport.height;
    overlayCanvas.width  = viewport.width;
    overlayCanvas.height = viewport.height;

    const ctx = pdfCanvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    state.currentPage    = pageNum;
    state.currentViewport = viewport;
    pageInput.value       = pageNum;
    updateNavButtons();

    // Re-apply search highlights on top of the freshly rendered page.
    // This runs after every page turn, zoom change, and window resize,
    // so highlights always stay aligned with the visible content.
    _applyHighlights();

    if (state.currentPdfId) {
      saveProgress({ docId: state.currentPdfId, lastPage: pageNum }).catch((err) => {
        console.warn('[Reader] Failed to save progress:', err);
      });
    }
  } finally {
    state.rendering = false;
  }
}

/** Draw (or clear) the search highlight overlay for the current page. */
function _applyHighlights() {
  if (!state.currentViewport || !state.search.pageIndex) {
    // Clear overlay if there's nothing to draw
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    return;
  }
  renderHighlights(
    overlayCanvas,
    state.currentPage,
    state.search.matches,
    state.search.activeIndex,
    state.currentViewport,
    state.search.pageIndex,
  );
}

function computeViewport(page) {
  const containerW = canvasContainer.clientWidth - 32; // 1rem padding each side
  const containerH = canvasContainer.clientHeight - 48;
  const naturalVP  = page.getViewport({ scale: 1 });

  let scale;
  if (state.zoomMode === 'fit-width') {
    scale = containerW / naturalVP.width;
  } else if (state.zoomMode === 'fit-page') {
    const sw = containerW / naturalVP.width;
    const sh = containerH / naturalVP.height;
    scale = Math.min(sw, sh);
  } else {
    scale = state.zoomScale;
  }

  return page.getViewport({ scale });
}

function updateNavButtons() {
  btnPrevPage.disabled = state.currentPage <= 1;
  btnNextPage.disabled = state.currentPage >= state.totalPages;
}

// ── PDF.js lazy load ──────────────────────────────────────────────────────────
function ensurePDFjs() {
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `${PDFJS_CDN}/pdf.worker.min.js`;
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${PDFJS_CDN}/pdf.min.js`;
    script.onload = () => {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        `${PDFJS_CDN}/pdf.worker.min.js`;
      resolve();
    };
    script.onerror = () => reject(new Error('Failed to load PDF.js from CDN.'));
    document.head.appendChild(script);
  });
}

// ── Delete confirmation ───────────────────────────────────────────────────────
let _pendingDeleteId = null;

function confirmDelete(id, name) {
  _pendingDeleteId = id;
  deleteModalName.textContent = name;
  deleteModal.classList.add('open');
}

async function executeDelete() {
  if (_pendingDeleteId === null) return;
  const id = _pendingDeleteId;
  _pendingDeleteId = null;
  deleteModal.classList.remove('open');

  try {
    // deleteDocument removes from both stores atomically in one transaction
    await deleteDocument(id);
    await loadLibrary();
    showToast('PDF deleted from local library.', 'success');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Appearance / theme ────────────────────────────────────────────────────────
// CSS filter classes are placed on #reader-screen (not on body or the canvas).
// This makes the selectors explicit and stable — they survive canvas redraws,
// zoom changes, and page turns without any re-application needed.
//
// body.theme-dim is kept for UI-chrome dimming only (sidebar, toolbar, etc.)
//
// Available themes:
//   'default' — dark app chrome, PDF rendered as-is (no canvas filter)
//   'dim'     — dark chrome + brightness(0.62) on canvas for night reading
//   'warm'    — sepia(28%) + brightness(0.90) warm paper tone on canvas
//   'invert'  — invert(1) hue-rotate(180deg) experimental dark-page mode
//               (may distort colour images/charts — opt-in only)

const READER_THEME_CLASSES = ['reader-theme-dim', 'reader-theme-warm', 'reader-theme-invert'];

function applyTheme(theme) {
  state.theme = theme;

  // 1. Canvas-level filter: toggle class on #reader-screen.
  //    CSS rules in styles.css target #pdf-canvas inside these classes.
  readerScreen.classList.remove(...READER_THEME_CLASSES);
  if (theme !== 'default') {
    readerScreen.classList.add(`reader-theme-${theme}`);
  }

  // 2. UI chrome: only 'dim' darkens the surrounding interface
  document.body.classList.toggle('theme-dim', theme === 'dim');

  // 3. Update active indicator in the appearance panel
  document.querySelectorAll('.appearance-option').forEach((el) => {
    el.classList.toggle('active', el.dataset.theme === theme);
  });

  // 4. Persist selection so it survives page reloads
  try { localStorage.setItem('pdfReaderTheme', theme); } catch (_) {}
}

// ── Event listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  // Library search & sort
  searchInput.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    renderLibrary();
  });
  sortSelect.addEventListener('change', () => {
    state.sortOrder = sortSelect.value;
    renderLibrary();
  });

  // File import button
  $('#btn-import-header').addEventListener('click', () => fileInput.click());
  $('#btn-import-empty').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    files.forEach(importFile);
  });

  // Drag and drop on the whole library screen & dedicated zone
  [libraryScreen, dropZone].forEach((el) => {
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files);
      files.forEach(importFile);
    });
  });
  dropZone.addEventListener('click', () => fileInput.click());

  // Reader: back
  btnBack.addEventListener('click', () => {
    // Close search bar and clear state before leaving the reader
    _closeSearchBar();
    showScreen('library');
    if (state.currentDoc) {
      state.currentDoc.destroy();
      state.currentDoc = null;
    }
    if (state._blobUrl) {
      URL.revokeObjectURL(state._blobUrl);
      state._blobUrl = null;
    }
    // Abort any in-progress index build
    state.search.indexAbort?.abort();
  });

  // Reader: page navigation
  btnPrevPage.addEventListener('click', () => {
    if (state.currentPage > 1) renderPage(state.currentPage - 1);
  });
  btnNextPage.addEventListener('click', () => {
    if (state.currentPage < state.totalPages) renderPage(state.currentPage + 1);
  });
  pageInput.addEventListener('change', () => {
    const n = parseInt(pageInput.value, 10);
    if (!isNaN(n) && n >= 1 && n <= state.totalPages) renderPage(n);
    else pageInput.value = state.currentPage;
  });
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') pageInput.blur();
  });

  // Reader: zoom
  btnZoomIn.addEventListener('click',  () => setZoom(Math.min(state.zoomScale * 1.2, 4)));
  btnZoomOut.addEventListener('click', () => setZoom(Math.max(state.zoomScale / 1.2, 0.25)));
  btnFitWidth.addEventListener('click', () => { state.zoomMode = 'fit-width'; renderPage(state.currentPage); });
  btnFitPage.addEventListener('click',  () => { state.zoomMode = 'fit-page';  renderPage(state.currentPage); });
  zoomSelect.addEventListener('change', () => {
    const val = zoomSelect.value;
    if (val === 'fit-width' || val === 'fit-page') {
      state.zoomMode = val;
      renderPage(state.currentPage);
    } else {
      setZoom(parseFloat(val));
    }
  });

  // Reader: keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (!readerScreen.classList.contains('active')) return;

    // Ctrl+F / Cmd+F → open search
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      _openSearchBar();
      return;
    }

    // Escape: close search bar first; if already closed, go back to library
    if (e.key === 'Escape') {
      if (!searchBar.hidden) {
        _closeSearchBar();
      } else {
        btnBack.click();
      }
      return;
    }

    // Don't hijack arrow keys when the search input has focus
    const searchFocused = document.activeElement === readerSearchInput;
    if (searchFocused) return;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
      e.preventDefault();
      if (state.currentPage < state.totalPages) renderPage(state.currentPage + 1);
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
      e.preventDefault();
      if (state.currentPage > 1) renderPage(state.currentPage - 1);
    }
  });

  // Search: toggle bar open/closed
  btnSearchToggle.addEventListener('click', () => {
    if (searchBar.hidden) {
      _openSearchBar();
    } else {
      _closeSearchBar();
    }
  });

  // Search: input (debounced)
  let _searchDebounce;
  readerSearchInput.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    btnSearchClear.hidden = !readerSearchInput.value;
    if (!readerSearchInput.value.trim()) {
      // Clear immediately — no need to wait
      _executeSearch();
    } else {
      _searchDebounce = setTimeout(_executeSearch, 300);
    }
  });

  // Search: Enter key navigates to next/previous match
  readerSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.search.matches.length) {
      e.preventDefault();
      _jumpToMatch(state.search.activeIndex + (e.shiftKey ? -1 : 1));
    }
  });

  // Search: clear button
  btnSearchClear.addEventListener('click', () => {
    readerSearchInput.value = '';
    btnSearchClear.hidden = true;
    _executeSearch();
    readerSearchInput.focus();
  });

  // Search: navigation
  btnSearchNext.addEventListener('click', () => _jumpToMatch(state.search.activeIndex + 1));
  btnSearchPrev.addEventListener('click', () => _jumpToMatch(state.search.activeIndex - 1));

  // Search: option checkboxes re-run search immediately
  searchMatchCase.addEventListener('change', _executeSearch);
  searchWholeWord.addEventListener('change', _executeSearch);

  // Appearance panel
  btnAppearance.addEventListener('click', (e) => {
    e.stopPropagation();
    appearancePanel.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!appearancePanel.contains(e.target) && e.target !== btnAppearance) {
      appearancePanel.classList.remove('open');
    }
  });
  document.querySelectorAll('.appearance-option').forEach((el) => {
    el.addEventListener('click', () => {
      applyTheme(el.dataset.theme);
      appearancePanel.classList.remove('open');
    });
  });

  // Delete modal
  btnDeleteConfirm.addEventListener('click', executeDelete);
  btnDeleteCancel.addEventListener('click', () => {
    _pendingDeleteId = null;
    deleteModal.classList.remove('open');
  });
  deleteModal.addEventListener('click', (e) => {
    if (e.target === deleteModal) {
      _pendingDeleteId = null;
      deleteModal.classList.remove('open');
    }
  });

  // Re-render on resize (for fit modes)
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (readerScreen.classList.contains('active') && state.currentDoc) {
        renderPage(state.currentPage);
      }
    }, 200);
  });
}

// ── Search: index building ────────────────────────────────────────────────────

/** Reset all search state for a newly opened document. */
function _resetSearchState() {
  // Abort previous build if still running
  state.search.indexAbort?.abort();

  state.search.pageIndex    = null;
  state.search.indexBuilding = false;
  state.search.indexAbort   = null;
  state.search.matches      = [];
  state.search.activeIndex  = -1;
  state.search.query        = '';

  // Clear UI
  readerSearchInput.value = '';
  btnSearchClear.hidden   = true;
  _updateCountUI();
  _setSearchStatus('');
}

/**
 * Build the text index for `pdfDoc` in the background.
 * Updates UI with progress, then re-runs any pending query when done.
 *
 * @param {PDFDocumentProxy} pdfDoc
 */
async function _buildIndexInBackground(pdfDoc) {
  state.search.indexAbort    = new AbortController();
  state.search.indexBuilding = true;
  const signal = state.search.indexAbort.signal;

  _setSearchStatus(`Indexing… 0 / ${pdfDoc.numPages}`);

  try {
    const { pageIndex, totalTextChars } = await buildSearchIndex(pdfDoc, {
      signal,
      onProgress: (built, total) => {
        if (!signal.aborted) {
          _setSearchStatus(`Indexing… ${built} / ${total}`);
        }
      },
    });

    if (signal.aborted) return;

    state.search.pageIndex    = pageIndex;
    state.search.indexBuilding = false;

    const avgCharsPerPage = pdfDoc.numPages > 0
      ? totalTextChars / pdfDoc.numPages
      : 0;

    if (avgCharsPerPage < 10) {
      _setSearchStatus(
        'This PDF appears to be scanned or image-based — text search is not available.',
        'warn',
      );
    } else {
      _setSearchStatus('');
      // If the user already typed a query while we were indexing, run it now
      if (state.search.query) {
        _executeSearch();
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      _setSearchStatus('Indexing failed: ' + err.message);
    }
  }
}

// ── Search: query execution ───────────────────────────────────────────────────

/** Run the current search query against the index and update UI + highlights. */
async function _executeSearch() {
  const query = readerSearchInput.value.trim();
  state.search.query = query;

  if (!query) {
    state.search.matches     = [];
    state.search.activeIndex = -1;
    _updateCountUI();
    _applyHighlights();
    return;
  }

  if (!state.search.pageIndex) {
    // Index is still being built — the query will re-run when done
    _setSearchStatus(
      state.search.indexBuilding ? 'Indexing in progress…' : 'No text index available.',
    );
    return;
  }

  const matches = searchIndex(state.search.pageIndex, query, {
    matchCase: searchMatchCase.checked,
    wholeWord: searchWholeWord.checked,
  });

  state.search.matches     = matches;
  state.search.activeIndex = matches.length > 0 ? 0 : -1;

  _updateCountUI();
  _setSearchStatus('');

  if (matches.length > 0) {
    await _jumpToMatch(0);
  } else {
    _applyHighlights(); // clears the overlay
  }
}

// ── Search: navigation ────────────────────────────────────────────────────────

/**
 * Navigate to the match at `index` (wraps around).
 * Navigates to the correct page, re-renders if needed, then scrolls.
 *
 * @param {number} index
 */
async function _jumpToMatch(index) {
  const total = state.search.matches.length;
  if (!total) return;

  // Wrap around in both directions
  const i = ((index % total) + total) % total;
  state.search.activeIndex = i;
  _updateCountUI();

  const match = state.search.matches[i];

  if (match.pageNum !== state.currentPage) {
    // renderPage() calls _applyHighlights() internally, so highlights will
    // be drawn on the new page automatically.
    await renderPage(match.pageNum);
  } else {
    // Same page — just redraw overlay with the new active match
    _applyHighlights();
  }

  _scrollToActiveMatch();
}

/** Scroll the canvas container so the active match rect is centred vertically. */
function _scrollToActiveMatch() {
  const match = state.search.matches[state.search.activeIndex];
  if (!match || !state.currentViewport || !state.search.pageIndex) return;

  const page = state.search.pageIndex.find((p) => p.pageNum === match.pageNum);
  if (!page || !match.itemRanges.length) return;

  const item = page.items[match.itemRanges[0].itemIndex];
  const rect = itemToCanvasRect(item, state.currentViewport);
  if (!rect) return;

  // rect.y is relative to the canvas top-left.
  // The canvas sits inside #pdf-page-wrap which is inside #canvas-container
  // (with padding).  We offset by the container's padding-top so the
  // calculation is in the scroll coordinate space.
  const paddingTop   = parseFloat(getComputedStyle(canvasContainer).paddingTop) || 24;
  const scrollTarget = paddingTop + rect.y - canvasContainer.clientHeight / 2 + rect.height / 2;

  canvasContainer.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
}

// ── Search: UI helpers ────────────────────────────────────────────────────────

function _updateCountUI() {
  const total = state.search.matches.length;
  const query = state.search.query;

  if (!query) {
    searchCountEl.textContent = '';
    searchCountEl.className   = 'search-count';
    btnSearchPrev.disabled    = true;
    btnSearchNext.disabled    = true;
    return;
  }

  if (total === 0) {
    searchCountEl.textContent = 'No results';
    searchCountEl.className   = 'search-count no-results';
    btnSearchPrev.disabled    = true;
    btnSearchNext.disabled    = true;
  } else {
    searchCountEl.textContent = `${state.search.activeIndex + 1} / ${total}`;
    searchCountEl.className   = 'search-count has-results';
    btnSearchPrev.disabled    = false;
    btnSearchNext.disabled    = false;
  }
}

function _setSearchStatus(msg, cls = '') {
  searchStatusEl.textContent = msg;
  searchStatusEl.className   = 'search-status' + (cls ? ` ${cls}` : '');
}

// ── Search: bar open / close ──────────────────────────────────────────────────

function _openSearchBar() {
  searchBar.hidden = false;
  btnSearchToggle.classList.add('active');
  readerSearchInput.focus();
  readerSearchInput.select();
}

function _closeSearchBar() {
  searchBar.hidden = true;
  btnSearchToggle.classList.remove('active');

  // Clear query + highlights
  readerSearchInput.value  = '';
  btnSearchClear.hidden    = true;
  state.search.query       = '';
  state.search.matches     = [];
  state.search.activeIndex = -1;
  _updateCountUI();
  _applyHighlights();
}

// ── Zoom helper ───────────────────────────────────────────────────────────────
function setZoom(scale) {
  state.zoomMode  = 'manual';
  state.zoomScale = scale;
  zoomSelect.value = 'custom'; // may not match any option — that's fine
  renderPage(state.currentPage);
}

// ── Loading states ─────────────────────────────────────────────────────────────
function showReaderLoading(visible) {
  readerLoading.classList.toggle('visible', visible);
}
function showImportLoading(visible) {
  importLoading.classList.toggle('visible', visible);
}

// ── Toast notifications ───────────────────────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const icons = {
    success: svgIcon('check-circle', 16),
    error:   svgIcon('alert-circle', 16),
    info:    svgIcon('info', 16),
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast__icon">${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Inline SVG icons (Feather-style, hand-rolled minimal versions) ─────────────
function svgIcon(name, size = 18) {
  const s = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  const paths = {
    'book-open':    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    'file':         '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
    'calendar':     '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    'clock':        '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'trash':        '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>',
    'plus':         '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    'upload':       '<polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right':'<polyline points="9 18 15 12 9 6"/>',
    'zoom-in':      '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
    'zoom-out':     '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
    'maximize-2':   '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
    'minimize-2':   '<polyline points="5 15 3 21 9 19"/><polyline points="19 9 21 3 15 5"/><line x1="3" y1="21" x2="10" y2="14"/><line x1="21" y1="3" x2="14" y2="10"/>',
    'sun':          '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    'arrow-left':   '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
    'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    'alert-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    'info':         '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    'layers':       '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  };
  const inner = paths[name] || '<circle cx="12" cy="12" r="10"/>';
  return `<svg ${s} aria-hidden="true">${inner}</svg>`;
}

// ── Boot ─────────────────────────────────────────────────────────────────────
init().catch((err) => {
  console.error('Initialisation error:', err);
});
