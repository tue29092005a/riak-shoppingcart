/**
 * riakHttp.js — HTTP-based client for Riak CRDT Map operations.
 *
 * Uses Riak's REST API (axios). basho-riak-client is incompatible with Node 18+.
 *
 * Features:
 *  - Parallel race across all live nodes via Promise.any()
 *    → fastest node wins; dead nodes don't add latency
 *  - Dead-node blacklist: failed nodes are skipped for 30 s
 *  - Short per-attempt timeout (500 ms) for rapid failover
 */

const axios = require('axios');

// ── Node pool ────────────────────────────────────────────────────────────────
const RIAK_NODES = [
  { host: process.env.RIAK_NODE1_HOST || 'riak-node-1', port: parseInt(process.env.RIAK_HTTP_PORT || '8098') },
  { host: process.env.RIAK_NODE2_HOST || 'riak-node-2', port: parseInt(process.env.RIAK_HTTP_PORT || '8098') },
  { host: process.env.RIAK_NODE3_HOST || 'riak-node-3', port: parseInt(process.env.RIAK_HTTP_PORT || '8098') },
];

// Dead-node blacklist: skip recently-failed nodes for BLACKLIST_TTL ms.
// 30 s lets a restarted node (docker start riak-node-3) re-enter the pool quickly.
const BLACKLIST_TTL = 30_000; // 30 seconds
const _deadUntil = {}; // { "host:port": timestamp }

function isAlive(node) {
  const key = `${node.host}:${node.port}`;
  return !_deadUntil[key] || Date.now() > _deadUntil[key];
}

function markDead(node) {
  const key = `${node.host}:${node.port}`;
  _deadUntil[key] = Date.now() + BLACKLIST_TTL;
  console.warn(`[riakHttp] Marked ${key} as dead for ${BLACKLIST_TTL / 1000}s`);
}

function markAlive(node) {
  const key = `${node.host}:${node.port}`;
  if (_deadUntil[key]) {
    console.log(`[riakHttp] ${key} is back online — removing from blacklist`);
    delete _deadUntil[key];
  }
}

// ── URL builder ──────────────────────────────────────────────────────────────
function mapUrl(base, key) {
  return `${base}/types/maps/buckets/shopping_carts/datatypes/${encodeURIComponent(key)}`;
}

// ── Response parser ──────────────────────────────────────────────────────────
function parseMapValue(data) {
  const items = [];
  if (!data || !data.value) return items;
  for (const [key, value] of Object.entries(data.value)) {
    if (key.endsWith('_counter') && typeof value === 'number' && value > 0) {
      items.push({ name: key.slice(0, -8), quantity: value });
    }
  }
  return items;
}

// ── Special sentinel for 404 (empty cart) ────────────────────────────────────
// Promise.any() treats all rejections as failures. To propagate a 404 cleanly
// through the race, we resolve with this sentinel instead of rejecting.
const NOT_FOUND = Symbol('NOT_FOUND');

/**
 * Race requestFn across all live nodes in parallel (Promise.any).
 * The first node to succeed wins. Dead nodes are skipped.
 * If all fail, throws an AggregateError with the last message.
 *
 * Special handling: HTTP 404 is resolved as NOT_FOUND sentinel so it
 * propagates correctly without being swallowed by the race.
 */
async function withFallback(requestFn) {
  // Prefer live nodes; fall back to all nodes if blacklist covers everything
  const targets = RIAK_NODES.filter(isAlive);
  const pool = targets.length > 0 ? targets : RIAK_NODES;

  const racePromises = pool.map(async (node) => {
    const base = `http://${node.host}:${node.port}`;
    try {
      const result = await requestFn(base);
      markAlive(node);
      return result;
    } catch (err) {
      // 404 → empty cart. Resolve with sentinel so the race surfaces it.
      if (err.response && err.response.status === 404) {
        markAlive(node); // node is reachable, just key missing
        return NOT_FOUND;
      }

      // 400 → bucket type not activated. Surface immediately.
      if (err.response && err.response.status === 400) {
        markAlive(node);
        throw new Error(
          `Riak HTTP 400: The 'maps' CRDT bucket type is not activated. ` +
          `Run: bash infrastructure/setup-cluster.sh`
        );
      }

      // Network/timeout errors → blacklist this node, reject this race slot
      if (
        err.code === 'ECONNREFUSED' ||
        err.code === 'ENOTFOUND' ||
        err.code === 'ECONNABORTED' ||
        err.code === 'ETIMEDOUT'
      ) {
        markDead(node);
      }

      console.warn(
        `[riakHttp] ${node.host}:${node.port} failed:`,
        err.code || err.message
      );
      throw err; // reject this slot — Promise.any tries next
    }
  });

  let result;
  try {
    result = await Promise.any(racePromises);
  } catch (aggregateErr) {
    // All slots rejected — surface a clear error
    const last = aggregateErr.errors
      ? aggregateErr.errors[aggregateErr.errors.length - 1]
      : aggregateErr;
    throw new Error(`All Riak nodes failed. Last error: ${last.message}`);
  }

  // Propagate 404 sentinel as a real error for the caller to handle
  if (result === NOT_FOUND) {
    const err = new Error('Not Found');
    err.response = { status: 404 };
    throw err;
  }

  return result;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Fetch a user's cart. Returns { items: [...] } */
async function fetchCart(userId) {
  try {
    const data = await withFallback(async (base) => {
      const { data } = await axios.get(mapUrl(base, userId), {
        params: { r: 1, timeout: 400 },
        timeout: 500,
      });
      return data;
    });
    return { items: parseMapValue(data) };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return { items: [] }; // Empty cart — key doesn't exist yet
    }
    throw err;
  }
}

/** Increment an item counter. Returns { items: [...] } */
async function addItem(userId, itemName, quantity = 1) {
  const data = await withFallback(async (base) => {
    // w=1, dw=1: only 1 node needs to ack the write → high availability
    const { data } = await axios.post(
      mapUrl(base, userId),
      { update: { [`${itemName}_counter`]: { increment: quantity } } },
      {
        params: { returnbody: 'true', w: 1, dw: 1, timeout: 400 },
        headers: { 'Content-Type': 'application/json' },
        timeout: 500,
      }
    );
    return data;
  });
  return { items: parseMapValue(data) };
}

/** Remove an item from the map. Returns { items: [...] } */
async function removeItem(userId, itemName) {
  const data = await withFallback(async (base) => {
    const { data } = await axios.post(
      mapUrl(base, userId),
      { remove: [`${itemName}_counter`] },
      {
        params: { returnbody: 'true', w: 1, dw: 1, timeout: 400 },
        headers: { 'Content-Type': 'application/json' },
        timeout: 500,
      }
    );
    return data;
  });
  return { items: parseMapValue(data) };
}

module.exports = { fetchCart, addItem, removeItem };
