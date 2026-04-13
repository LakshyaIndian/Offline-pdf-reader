/**
 * db.js — IndexedDB wrapper for Offline PDF Reader
 * Stores PDF blobs and metadata locally in the browser.
 */

const DB_NAME = 'OfflinePDFReader';
const DB_VERSION = 1;
const STORE_NAME = 'pdfs';

let _db = null;

/** Open (or create) the IndexedDB database. Returns a Promise<IDBDatabase>. */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('dateAdded', 'dateAdded', { unique: false });
        store.createIndex('lastOpened', 'lastOpened', { unique: false });
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

/** Save a PDF to the database. Returns the generated numeric id. */
export async function savePDF({ name, size, blob }) {
  const db = await openDB();
  const now = Date.now();
  const record = {
    name,
    size,
    blob,
    dateAdded: now,
    lastOpened: null,
    lastPage: 1,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.add(record);

    req.onsuccess = () => resolve(req.result); // req.result = generated id
    req.onerror = () => reject(new Error(`Failed to save PDF: ${req.error}`));
  });
}

/** Retrieve all PDF metadata (without blob) from the database. */
export async function getAllPDFsMeta() {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();

    req.onsuccess = () => {
      // Strip the blob from results to keep memory usage low in the library view
      const records = req.result.map(({ blob: _blob, ...meta }) => meta);
      resolve(records);
    };
    req.onerror = () => reject(new Error(`Failed to read PDFs: ${req.error}`));
  });
}

/** Retrieve a single PDF record (including blob) by id. */
export async function getPDFById(id) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(new Error(`Failed to get PDF: ${req.error}`));
  });
}

/** Update last-opened timestamp and last-read page for a PDF. */
export async function updatePDFProgress(id, lastPage) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);

    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return reject(new Error('PDF not found'));
      record.lastOpened = Date.now();
      record.lastPage = lastPage;
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(new Error(`Failed to update progress: ${putReq.error}`));
    };
    getReq.onerror = () => reject(new Error(`Failed to get PDF for update: ${getReq.error}`));
  });
}

/** Delete a PDF record (and its blob) by id. */
export async function deletePDFById(id) {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onsuccess = () => resolve();
    req.onerror = () => reject(new Error(`Failed to delete PDF: ${req.error}`));
  });
}
