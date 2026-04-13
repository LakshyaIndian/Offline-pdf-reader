/**
 * db.js — IndexedDB wrapper for Offline PDF Reader
 *
 * WHY TWO STORES?
 * ───────────────
 * The original single-store design had a critical bug: progress updates
 * (lastPage, lastOpened) required reading the full record — including the
 * stored Blob — and then writing the whole thing back in a *new* transaction.
 *
 * Firefox and Safari mark a Blob read from IndexedDB as "detached" once its
 * originating read-transaction closes. Feeding that detached Blob into a
 * write-transaction throws:
 *   UnknownError: Error preparing Blob/File data to be stored in object store
 *
 * FIX: split into two stores so progress writes never touch the blob store.
 *
 *  ┌─────────────────────────────────────────────────────────┐
 *  │  documents  { id*, name, size, blob, dateAdded }        │  ← written once on import
 *  │  progress   { docId*, lastPage, lastOpened }            │  ← updated on every page turn
 *  └─────────────────────────────────────────────────────────┘
 *  * = keyPath
 *
 * SERIALISATION RULE:
 *   Only plain JS primitives + Blob are safe in IndexedDB.
 *   Never store: File objects, PDF.js page/doc objects, DOM nodes,
 *   canvas elements, event objects, or functions.
 */

const DB_NAME      = 'OfflinePDFReader';
const DB_VERSION   = 2;           // bumped from 1 to trigger onupgradeneeded
const STORE_DOCS   = 'documents'; // blob + static metadata
const STORE_PROG   = 'progress';  // reading progress only — no blob

let _db = null;

// ── Debug helper ─────────────────────────────────────────────────────────────
/**
 * Log what is about to be written to IndexedDB.
 * Warns loudly if a Blob or File appears in a store where it is unexpected.
 *
 * @param {string} storeName
 * @param {object} obj  — the plain object about to be passed to store.add/put
 */
function dbDebug(storeName, obj) {
  const keys     = Object.keys(obj);
  const blobKeys = keys.filter((k) => obj[k] instanceof Blob || obj[k] instanceof File);
  const hasBlob  = blobKeys.length > 0;

  console.debug(`[DB] write → ${storeName}`, { keys, hasBlob });

  if (hasBlob && storeName !== STORE_DOCS) {
    console.warn(
      `[DB] ⚠ Unexpected Blob/File in "${storeName}" store — ` +
      `this will fail in Firefox/Safari. Offending keys: ${blobKeys.join(', ')}`
    );
  }
}

// ── Open / upgrade ───────────────────────────────────────────────────────────
/**
 * Open (or upgrade) the IndexedDB database.
 * Safe to call multiple times — returns the cached connection after first open.
 *
 * @returns {Promise<IDBDatabase>}
 */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db         = event.target.result;
      const oldVersion = event.oldVersion; // 0 = fresh install

      // ── Create documents store ──────────────────────────────────────────────
      // Holds PDF blob + static metadata.  Written ONCE on import; never
      // rewritten during progress updates.
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        const docsStore = db.createObjectStore(STORE_DOCS, {
          keyPath: 'id',
          autoIncrement: true,
        });
        docsStore.createIndex('name',      'name',      { unique: false });
        docsStore.createIndex('dateAdded', 'dateAdded', { unique: false });
      }

      // ── Create progress store ───────────────────────────────────────────────
      // Holds ONLY reading progress — no blob, no File.
      // keyPath is docId so store.put() naturally upserts by document id.
      if (!db.objectStoreNames.contains(STORE_PROG)) {
        const progressStore = db.createObjectStore(STORE_PROG, { keyPath: 'docId' });
        progressStore.createIndex('lastOpened', 'lastOpened', { unique: false });
      }

      // ── Migrate from schema v1 ──────────────────────────────────────────────
      // v1 used a single 'pdfs' store that stored blob + progress together,
      // causing the Blob-rewrite bug on progress updates.
      //
      // Migration strategy: attempt to copy records into the new split stores.
      // If anything fails the user will need to re-import their PDFs (this is
      // a one-time migration for a newly released app with a critical bug).
      if (oldVersion === 1 && db.objectStoreNames.contains('pdfs')) {
        const upgradeTx  = event.target.transaction;
        const oldStore   = upgradeTx.objectStore('pdfs');
        const docsStore  = upgradeTx.objectStore(STORE_DOCS);
        const progStore  = upgradeTx.objectStore(STORE_PROG);

        oldStore.getAll().onsuccess = (e) => {
          for (const old of e.target.result) {
            // Copy blob + metadata into documents store, preserving the id
            const docRecord = {
              id:        old.id,
              name:      old.name,
              size:      old.size,
              blob:      old.blob,
              dateAdded: old.dateAdded ?? Date.now(),
            };
            dbDebug(STORE_DOCS, docRecord);
            docsStore.add(docRecord);

            // Copy progress into progress store (only if there was any)
            if ((old.lastPage ?? 1) > 1 || old.lastOpened) {
              const progRecord = {
                docId:      old.id,
                lastPage:   old.lastPage   ?? 1,
                lastOpened: old.lastOpened ?? null,
              };
              dbDebug(STORE_PROG, progRecord);
              progStore.put(progRecord);
            }
          }

          // Delete old store now that data is copied
          db.deleteObjectStore('pdfs');
          console.info('[DB] Migrated from schema v1 → v2 (split stores).');
        };

        oldStore.getAll().onerror = () => {
          // Migration failed — drop old store anyway to unblock the app.
          // User will need to re-import their PDFs.
          db.deleteObjectStore('pdfs');
          console.warn('[DB] v1 → v2 migration failed; old PDFs cleared. Please re-import.');
        };
      }
    };

    req.onsuccess = (event) => {
      _db = event.target.result;
      resolve(_db);
    };

    req.onerror = (event) => {
      reject(new Error(`IndexedDB open failed: ${event.target.error}`));
    };
  });
}

// ── Internal helper ───────────────────────────────────────────────────────────
/** Run a simple getAll() inside a readonly transaction. */
function _getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(new Error(`Failed to read ${storeName}: ${req.error}`));
  });
}

// ── Documents store API ───────────────────────────────────────────────────────

/**
 * Save a new PDF document.  The blob is stored ONCE here and never written
 * again — all future updates go to the progress store.
 *
 * @param {{ name: string, size: number, blob: Blob }} param
 * @returns {Promise<number>}  the auto-generated document id
 */
export async function saveDocument({ name, size, blob }) {
  const db = await openDB();

  const record = {
    // id is omitted — auto-generated by IndexedDB
    name,
    size,
    blob,
    dateAdded: Date.now(),
  };

  dbDebug(STORE_DOCS, record);

  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_DOCS, 'readwrite');
    const store = tx.objectStore(STORE_DOCS);
    const req   = store.add(record);

    req.onsuccess = () => resolve(req.result); // generated numeric id
    req.onerror   = () => {
      let msg = `Failed to save document: ${req.error}`;
      if (req.error?.name === 'QuotaExceededError') {
        msg = 'Storage quota exceeded. Delete some PDFs to free space.';
      }
      reject(new Error(msg));
    };
  });
}

/**
 * Return metadata for all stored documents merged with their progress.
 * Blobs are intentionally excluded to keep memory usage low.
 *
 * Merged shape per item:
 *   { id, name, size, dateAdded, lastPage, lastOpened }
 *
 * @returns {Promise<Array>}
 */
export async function getAllDocumentsMeta() {
  const db = await openDB();

  const [docs, progressList] = await Promise.all([
    _getAll(db, STORE_DOCS),
    _getAll(db, STORE_PROG),
  ]);

  // Build a fast lookup map: docId → progress record
  const progressMap = new Map(progressList.map((p) => [p.docId, p]));

  return docs.map(({ blob: _blob, ...doc }) => {
    const prog = progressMap.get(doc.id);
    return {
      ...doc,
      lastPage:   prog?.lastPage   ?? 1,
      lastOpened: prog?.lastOpened ?? null,
    };
  });
}

/**
 * Retrieve a single document record INCLUDING its blob.
 * Used only when the user opens a PDF in the reader.
 *
 * @param {number} id
 * @returns {Promise<{id, name, size, blob, dateAdded} | null>}
 */
export async function getDocumentById(id) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_DOCS, 'readonly');
    const store = tx.objectStore(STORE_DOCS);
    const req   = store.get(id);

    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(new Error(`Failed to get document: ${req.error}`));
  });
}

// ── Progress store API ────────────────────────────────────────────────────────

/**
 * Read the progress record for a document.
 *
 * @param {number} docId
 * @returns {Promise<{docId, lastPage, lastOpened} | null>}
 */
export async function getProgress(docId) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_PROG, 'readonly');
    const store = tx.objectStore(STORE_PROG);
    const req   = store.get(docId);

    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => reject(new Error(`Failed to get progress: ${req.error}`));
  });
}

/**
 * Upsert reading progress for a document.
 * This is the ONLY function called during page turns — it never touches the
 * documents store and therefore never reads or writes any Blob.
 *
 * Safe object written: { docId: number, lastPage: number, lastOpened: number }
 *
 * @param {{ docId: number, lastPage: number }} param
 * @returns {Promise<void>}
 */
export async function saveProgress({ docId, lastPage }) {
  const db = await openDB();

  const record = {
    docId,
    lastPage,
    lastOpened: Date.now(),
  };

  // Guard: ensure nothing non-serialisable crept in
  dbDebug(STORE_PROG, record);

  return new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE_PROG, 'readwrite');
    const store = tx.objectStore(STORE_PROG);
    // store.put upserts by keyPath (docId)
    const req   = store.put(record);

    req.onsuccess = () => resolve();
    req.onerror   = () => reject(new Error(`Failed to save progress: ${req.error}`));
  });
}

// ── Delete ────────────────────────────────────────────────────────────────────

/**
 * Permanently delete a document and its progress record.
 * Opens a single transaction spanning both stores for atomicity.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteDocument(id) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_DOCS, STORE_PROG], 'readwrite');

    tx.objectStore(STORE_DOCS).delete(id); // removes blob + metadata
    tx.objectStore(STORE_PROG).delete(id); // removes progress (docId === id)

    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(new Error(`Failed to delete document: ${tx.error}`));
    tx.onabort    = () => reject(new Error(`Delete transaction aborted: ${tx.error}`));
  });
}
