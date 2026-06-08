/**
 * riakClient.js — Node health monitoring via Riak HTTP API.
 *
 * NOTE: basho-riak-client (Protocol Buffers) requires Node ~0.12 and is
 * incompatible with Node 18+. All CRDT data operations now use riakHttp.js
 * (REST API). This file only handles the /ping health checks.
 *
 * Uses Node.js 18's built-in fetch (undici) with AbortSignal.timeout() for
 * reliable per-node timeouts. To bypass Docker's notorious 20-second DNS
 * timeout when a container is stopped, we use an in-memory IP cache and
 * resolve DNS asynchronously using c-ares (dns.resolve4) which doesn't block
 * the libuv threadpool.
 */

const dns = require('dns').promises;

const HTTP_NODES = [
  { host: process.env.RIAK_NODE1_HOST || 'riak-node-1', port: parseInt(process.env.RIAK_HTTP_PORT || '8098') },
  { host: process.env.RIAK_NODE2_HOST || 'riak-node-2', port: parseInt(process.env.RIAK_HTTP_PORT || '8098') },
  { host: process.env.RIAK_NODE3_HOST || 'riak-node-3', port: parseInt(process.env.RIAK_HTTP_PORT || '8098') },
];

const PING_TIMEOUT_MS = 800;
const DNS_FAST_TIMEOUT_MS = 100; // Fast timeout if we have a cached IP
const DNS_COLD_TIMEOUT_MS = 750; // Longer timeout for initial cold start

// Cache IPs to bypass Docker DNS hangs when a node goes down
const ipCache = {}; // { 'riak-node-1': '172.18.0.x' }

/**
 * Attempts to resolve the IP of a hostname quickly.
 * Falls back to the last known good IP if DNS hangs or fails.
 * Returns null if resolution fails completely and there is no cache.
 */
async function getTargetHost(hostname) {
  // If we have no cache, we MUST give DNS a chance to resolve, otherwise
  // we'll never discover the IP. We give it almost the full ping window.
  const timeoutMs = ipCache[hostname] ? DNS_FAST_TIMEOUT_MS : DNS_COLD_TIMEOUT_MS;

  try {
    const ips = await Promise.race([
      dns.resolve4(hostname),
      new Promise((_, reject) => setTimeout(() => reject(new Error('DNS Timeout')), timeoutMs))
    ]);
    if (ips && ips[0]) {
      ipCache[hostname] = ips[0];
      return ips[0];
    }
  } catch (err) {
    // DNS failed or timed out (expected when container is stopped or DNS is slow).
    // Fall through to cache.
  }
  
  // NEVER fall back to hostname to avoid the 20s Docker DNS hang.
  return ipCache[hostname] || null;
}

/**
 * Ping each Riak node individually via HTTP GET /ping.
 * All 3 nodes are pinged in parallel (Promise.all).
 * Returns: [{ name, host, port, status: 'online'|'offline', latency }]
 */
async function pingAllNodes() {
  const pingNode = async (node, index) => {
    const name  = `riak-node-${index + 1}`;
    const start = Date.now();
    
    // 1. Get the actual IP (or null if total failure)
    const targetHost = await getTargetHost(node.host);

    if (!targetHost) {
      // Cold start failure: No cache and DNS timed out. Treat as offline immediately.
      return { name, host: node.host, port: node.port, status: 'offline', latency: null };
    }

    // 2. Fetch via IP, completely bypassing fetch's internal DNS resolution
    try {
      const res = await fetch(`http://${targetHost}:${node.port}/ping`, {
        // Strict compliance: preserve original hostname in HTTP headers
        headers: { 'Host': node.host },
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      
      return {
        name,
        host: node.host,
        port: node.port,
        status: res.ok ? 'online' : 'offline',
        latency: Date.now() - start,
      };
    } catch {
      // Covers: AbortError (timeout), TypeError (network fail), ECONNREFUSED, EHOSTUNREACH
      
      // Cache Invalidation: The cached IP is dead or timed out. 
      // Purge it so we don't hold onto stale IPs (Docker IP Shuffle).
      delete ipCache[node.host];
      
      return { name, host: node.host, port: node.port, status: 'offline', latency: null };
    }
  };

  return Promise.all(HTTP_NODES.map((node, i) => pingNode(node, i)));
}

module.exports = { pingAllNodes, HTTP_NODES };
