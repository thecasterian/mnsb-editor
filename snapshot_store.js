// Shared IndexedDB-backed snapshot store + cross-tab broadcast for the
// character-editor → scene-editor handoff. Both editors load this module via
// a dynamic import keyed by their BUILD_VERSION (cache-busting parity with
// app.js / scene.js).
//
// One database (`manosaba`) with one object store (`snapshots`) keyed by the
// record's `slug` field. Records:
//   { slug, name, character, variant, charType, width, height, blob, createdAt }
// `blob` is the cropped snapshot PNG as a Blob — stored binary, no base64
// inflation. The character editor writes; the scene editor reads + reacts to
// updates via the BroadcastChannel.
//
// IDB quota is browser/disk-dependent but typically hundreds of MB to GBs —
// we no longer cap snapshot resolution.

import { openDB } from 'https://cdn.jsdelivr.net/npm/idb@8/+esm';

const DB_NAME    = 'manosaba';
const DB_VERSION = 1;
const STORE      = 'snapshots';
const CHANNEL    = 'manosaba.scene.snapshots';

const dbPromise = openDB(DB_NAME, DB_VERSION, {
  upgrade(db) {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE, { keyPath: 'slug' });
    }
  },
});

export async function snapshotPut(record) {
  return (await dbPromise).put(STORE, record);
}
export async function snapshotGetAll() {
  return (await dbPromise).getAll(STORE);
}
export async function snapshotDelete(slug) {
  return (await dbPromise).delete(STORE, slug);
}

// Cross-tab notifier. Both editors listen for `{ type, slug }` messages and
// reload their in-memory state. Posting from the writer covers the same case
// localStorage's `storage` event covered before — minus the same-tab-no-self
// quirk (BroadcastChannel does not deliver messages back to the sender, so
// the writer page also needs to act locally on its own write).
export const snapshotChannel = new BroadcastChannel(CHANNEL);

// One-time migration from the v1 localStorage-backed store. Idempotent —
// only does work once per browser. Drops legacy entries rather than
// converting; data-URL → Blob conversion adds complexity for ephemeral test
// data that the user has already produced fresh ones to replace.
const LEGACY_PREFIX = 'manosaba.scene.snapshots.';
const _legacyKeys = [];
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (k && k.startsWith(LEGACY_PREFIX)) _legacyKeys.push(k);
}
for (const k of _legacyKeys) localStorage.removeItem(k);
