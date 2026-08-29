/**
 * backend/utils/withTimeout.js
 *
 * Races a promise against a timeout, rejecting if the promise hasn't
 * settled within `ms`. Used to put a hard ceiling around any single
 * best-effort side effect (Telegram, WhatsApp, Archive.org backup) that
 * runs as part of a sequential chain — a try/catch alone only protects
 * against a THROW, not a HANG, and a hung step would otherwise silently
 * block every step scheduled after it, forever, with no error ever
 * logged. See controllers/adminController.js and
 * controllers/serviceController.js's runPostApprovalSideEffects for
 * where this matters concretely: postFilmToChannel() (WhatsApp) awaits
 * a persistent connection with no internal timeout of its own — if that
 * connection isn't currently live, it can hang indefinitely and silently
 * prevent the Archive.org backup step scheduled after it from ever
 * running.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };