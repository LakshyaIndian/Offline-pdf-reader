/**
 * search.js — In-reader PDF text search for Offline PDF Reader
 *
 * ARCHITECTURE
 * ────────────
 * PDF pages are rendered as pixel bitmaps on a <canvas> element.  There is
 * no live DOM text layer.  Highlights are therefore drawn on a second
 * transparent <canvas> (the "overlay") that sits on top of the PDF canvas.
 *
 * Text extraction uses PDF.js page.getTextContent(), which returns an array
 * of TextItems.  Each TextItem carries:
 *   .str        — the text string for this run
 *   .transform  — 6-element affine matrix [a,b,c,d,e,f] in PDF user space
 *   .width      — advance width in text space units
 *
 * We concatenate all items on a page into a single string (fullText), record
 * where each item starts and ends (segments[]), and run a RegExp against
 * fullText.  Match character-positions are then mapped back to their source
 * TextItems, whose PDF-space bounding boxes are projected into canvas pixels
 * using the same viewport transform that PDF.js used when rendering.
 *
 * LIMITATION
 * ──────────
 * Scanned / image-only PDFs have no text layer.  getTextContent() returns an
 * empty item list, and the caller shows an appropriate message.
 * OCR is not performed.
 *
 * Character-width within a single TextItem is estimated proportionally
 * (charOffset / str.length × itemWidth).  This is accurate for monospaced
 * fonts and a good approximation for proportional fonts.
 */

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build an in-memory text index for the given PDF document, one page at a time.
 *
 * @param {PDFDocumentProxy} pdfDoc
 * @param {object}           [options]
 * @param {AbortSignal}      [options.signal]     — cancel mid-build
 * @param {function}         [options.onProgress] — called as (builtCount, totalPages)
 * @returns {Promise<{ pageIndex: PageEntry[], totalTextChars: number }>}
 */
export async function buildSearchIndex(pdfDoc, { signal, onProgress } = {}) {
  const total = pdfDoc.numPages;
  const pageIndex = [];
  let totalTextChars = 0;

  for (let pageNum = 1; pageNum <= total; pageNum++) {
    if (signal?.aborted) break;

    const page = await pdfDoc.getPage(pageNum);
    // normalizeWhitespace merges ligatures and normalises spacing
    const content = await page.getTextContent({ normalizeWhitespace: true });

    const entry = _buildPageEntry(pageNum, content.items);
    pageIndex.push(entry);
    totalTextChars += entry.fullText.length;

    onProgress?.(pageNum, total);
    // page.cleanup() is intentionally NOT called here — the user may be
    // viewing this page simultaneously and cleanup would drop render cache.
  }

  return { pageIndex, totalTextChars };
}

/**
 * Run a text search against the built index.
 *
 * @param {PageEntry[]} pageIndex  — from buildSearchIndex()
 * @param {string}      query
 * @param {object}      [options]
 * @param {boolean}     [options.matchCase=false]
 * @param {boolean}     [options.wholeWord=false]
 * @returns {Match[]}  sorted by page number, then by position within the page
 */
export function searchIndex(pageIndex, query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return [];

  const flags   = matchCase ? 'g' : 'gi';
  let   pattern = _escapeRegExp(query);
  if (wholeWord) pattern = `\\b${pattern}\\b`;

  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch {
    return []; // shouldn't happen given escapeRegExp, but be safe
  }

  const matches = [];

  for (const page of pageIndex) {
    regex.lastIndex = 0; // reset for each page (flag 'g' requires this)

    let m;
    while ((m = regex.exec(page.fullText)) !== null) {
      const start = m.index;
      const end   = start + m[0].length;

      // Guard against empty-string matches causing infinite loops
      if (m[0].length === 0) { regex.lastIndex++; continue; }

      const itemRanges = _mapToItemRanges(page.segments, start, end);
      if (!itemRanges.length) continue;

      // 40-char context snippet for possible future snippet display
      const sStart  = Math.max(0, start - 40);
      const sEnd    = Math.min(page.fullText.length, end + 40);
      const snippet = page.fullText.slice(sStart, sEnd).trim();

      matches.push({ pageNum: page.pageNum, start, end, snippet, itemRanges });
    }
  }

  return matches;
}

/**
 * Draw highlight rectangles for the given page on the overlay canvas.
 * Must be called after every renderPage() so the overlay stays in sync.
 *
 * @param {HTMLCanvasElement} overlayCanvas
 * @param {number}            pageNum        — page currently displayed
 * @param {Match[]}           matches        — full match list
 * @param {number}            activeIndex    — index of the focused match
 * @param {PDFPageViewport}   viewport       — viewport used to render the page
 * @param {PageEntry[]}       pageIndex      — full index from buildSearchIndex()
 */
export function renderHighlights(overlayCanvas, pageNum, matches, activeIndex, viewport, pageIndex) {
  const ctx = overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  if (!matches.length) return;

  const page        = pageIndex.find((p) => p.pageNum === pageNum);
  if (!page) return;

  const activeMatch = matches[activeIndex] ?? null;

  for (const match of matches) {
    if (match.pageNum !== pageNum) continue;

    const isActive = match === activeMatch;

    for (const range of match.itemRanges) {
      const item     = page.items[range.itemIndex];
      const fullRect = itemToCanvasRect(item, viewport);
      if (!fullRect) continue;

      const rect = _charRangeToRect(fullRect, item.str.length, range.charStart, range.charEnd);

      if (isActive) {
        // Active match — warm amber, border for extra visibility
        ctx.fillStyle = 'rgba(255, 165, 0, 0.65)';
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx.strokeStyle = 'rgba(220, 100, 0, 0.9)';
        ctx.lineWidth   = 1.5;
        ctx.strokeRect(rect.x + 0.75, rect.y + 0.75, rect.width - 1.5, rect.height - 1.5);
      } else {
        // Inactive match — subtle yellow
        ctx.fillStyle = 'rgba(255, 230, 60, 0.28)';
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
    }
  }
}

/**
 * Project a TextItem's bounding box into canvas pixel coordinates.
 * Exported so callers can scroll the active match into view.
 *
 * PDF coordinate system: origin bottom-left, y increases upward.
 * Canvas coordinate system: origin top-left, y increases downward.
 * The viewport.transform handles the axis flip.
 *
 * @param {TextItem}        item
 * @param {PDFPageViewport} viewport
 * @returns {{ x, y, width, height } | null}
 */
export function itemToCanvasRect(item, viewport) {
  if (!item?.transform || !viewport?.transform) return null;

  const [a, b, c, d, e, f]        = item.transform;
  const [v0, v1, v2, v3, v4, v5]  = viewport.transform;

  // Apply viewport transform to the glyph origin (e, f in PDF space)
  const canvasX = v0 * e + v2 * f + v4;
  const canvasY = v1 * e + v3 * f + v5;

  // Font height: |d * v3| handles the y-axis flip between PDF and canvas.
  // The small bias 'b*v2' is non-zero only for rotated text.
  const fontH = Math.max(4, Math.abs(d * v3 - b * v2));

  // Item advance width projected to canvas pixels
  const fontW = Math.abs(item.width * v0);

  return {
    x:      canvasX,
    y:      canvasY - fontH,  // canvasY is at glyph baseline; shift to top-left
    width:  fontW,
    height: fontH + 2,        // +2 px to cover descenders
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * @typedef {object} PageEntry
 * @property {number}    pageNum
 * @property {string}    fullText  — concatenated text of all items on the page
 * @property {Segment[]} segments  — maps fullText ranges back to TextItems
 * @property {TextItem[]} items    — raw TextItems from getTextContent()
 */

/**
 * @typedef {object} Segment
 * @property {number} itemIndex  — index into items[]
 * @property {number} start      — start position in fullText (inclusive)
 * @property {number} end        — end position in fullText (exclusive)
 */

/**
 * @typedef {object} Match
 * @property {number}      pageNum
 * @property {number}      start      — start in fullText
 * @property {number}      end        — end in fullText
 * @property {string}      snippet    — surrounding text context
 * @property {ItemRange[]} itemRanges — which parts of which items to highlight
 */

/**
 * @typedef {object} ItemRange
 * @property {number} itemIndex
 * @property {number} charStart  — start char offset within item.str
 * @property {number} charEnd    — end char offset within item.str (exclusive)
 */

function _buildPageEntry(pageNum, rawItems) {
  // Only real text runs (exclude whitespace-only PDFImageItem etc.)
  const items = rawItems.filter((item) => typeof item.str === 'string' && item.str.length > 0);

  const segments = [];
  let fullText   = '';

  for (let i = 0; i < items.length; i++) {
    const str   = items[i].str;
    const start = fullText.length;

    fullText += str;
    segments.push({ itemIndex: i, start, end: start + str.length });

    // Separate adjacent items with a space unless the item already ends in whitespace.
    // This lets phrase searches match across item boundaries.
    if (i < items.length - 1 && str[str.length - 1] !== ' ') {
      fullText += ' ';
    }
  }

  return { pageNum, fullText, segments, items };
}

function _mapToItemRanges(segments, matchStart, matchEnd) {
  const ranges = [];
  for (const seg of segments) {
    if (seg.end  <= matchStart) continue; // segment is entirely before match
    if (seg.start >= matchEnd)  break;    // segment is entirely after match

    const charStart = Math.max(0, matchStart - seg.start);
    const charEnd   = Math.min(seg.end - seg.start, matchEnd - seg.start);

    if (charStart < charEnd) {
      ranges.push({ itemIndex: seg.itemIndex, charStart, charEnd });
    }
  }
  return ranges;
}

function _charRangeToRect(fullRect, strLen, charStart, charEnd) {
  if (!strLen) return fullRect;
  // Proportional subdivision: assumes uniform character spacing within the item.
  // This is an approximation; it works well for most Latin-script fonts.
  const x     = fullRect.x + (charStart / strLen) * fullRect.width;
  const width = Math.max(4, ((charEnd - charStart) / strLen) * fullRect.width);
  return { x, y: fullRect.y, width, height: fullRect.height };
}

function _escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
