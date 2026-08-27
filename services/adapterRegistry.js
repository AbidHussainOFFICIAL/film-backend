/**
 * backend/services/adapterRegistry.js
 *
 * Maps a Provider document's `name` to the storage adapter that actually
 * knows how to talk to that provider. Adapters are stateless singletons
 * (they read their own credentials from env at call time), so handing
 * back the same instance every time is safe.
 */

const R2Adapter = require("../adapters/R2Adapter");
const B2Adapter = require("../adapters/B2Adapter");
const StorjAdapter = require("../adapters/StorjAdapter");

const REGISTRY = {
  r2: R2Adapter,
  b2: B2Adapter,
  storj: StorjAdapter,
};

/**
 * @param {"r2"|"b2"|"storj"} providerName
 * @returns {import("../adapters/StorageAdapter")}
 */
function getAdapter(providerName) {
  const adapter = REGISTRY[providerName];
  if (!adapter) {
    throw new Error(`No storage adapter registered for provider "${providerName}"`);
  }
  return adapter;
}

module.exports = { getAdapter };