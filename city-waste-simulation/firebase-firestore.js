/**
 * Optional Firestore persistence for game state (server-side only).
 * Local: GOOGLE_APPLICATION_CREDENTIALS = path to service account JSON.
 * Cloud: FIREBASE_SERVICE_ACCOUNT_JSON = full JSON string (one line), or FIRESTORE_DISABLED=1.
 * @see https://firebase.google.com/docs/admin/setup
 */

let firestore = null;
let saveTimer = null;
const SAVE_DEBOUNCE_MS = 15000;

function tryInitFirestore() {
  if (process.env.FIRESTORE_DISABLED === '1') {
    console.log('[Firestore] Disabled (FIRESTORE_DISABLED=1).');
    return null;
  }
  const jsonStr = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const hasPath = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  if (!jsonStr && !hasPath) {
    console.log(
      '[Firestore] Not configured: locally set GOOGLE_APPLICATION_CREDENTIALS; on cloud set FIREBASE_SERVICE_ACCOUNT_JSON, or FIRESTORE_DISABLED=1.'
    );
    return null;
  }
  try {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      if (jsonStr && String(jsonStr).trim()) {
        const parsed = JSON.parse(String(jsonStr).trim());
        admin.initializeApp({ credential: admin.credential.cert(parsed) });
      } else {
        admin.initializeApp({ credential: admin.credential.applicationDefault() });
      }
    }
    firestore = admin.firestore();
    console.log('[Firestore] Connected. Snapshots will be saved to games/current (debounced).');
    return firestore;
  } catch (e) {
    console.warn('[Firestore] Init failed:', e.message || e);
    return null;
  }
}

/**
 * Debounced write so we do not hit Firestore write limits on every tick.
 * @param {object} gameState - full server gameState object (must be JSON-serializable)
 */
function scheduleGameStateSave(gameState) {
  if (!firestore || !gameState) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const ref = firestore.collection('games').doc('current');
    let plain;
    try {
      plain = JSON.parse(JSON.stringify(gameState));
    } catch (e) {
      console.warn('[Firestore] Skip save: gameState is not JSON-serializable.', e.message || e);
      return;
    }
    const payload = {
      updatedAt: new Date().toISOString(),
      gameState: plain
    };
    ref
      .set(payload)
      .then(() => {
        console.log('[Firestore] Saved games/current');
      })
      .catch((err) => {
        console.warn('[Firestore] Save failed:', err.message || err);
      });
  }, SAVE_DEBOUNCE_MS);
}

module.exports = { tryInitFirestore, scheduleGameStateSave };
