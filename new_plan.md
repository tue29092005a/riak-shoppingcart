**Context:**
I am building a High Availability (HA) Shopping Cart demo using a 3-node Riak KV cluster (Dockerized), a Node.js/Express backend (using native `fetch` over Riak's HTTP API on port 8098), and a React frontend. The cluster uses CRDT Maps with `N=3` and `W=1`/`R=1`.

**The Issue:**
When I simulate a node failure (e.g., `docker stop riak-node-3`), the application loses its HA capabilities. Instead of seamlessly failing over to Node 1 or Node 2, the frontend experiences a ~12-second latency (12091ms) and eventually throws an error: `"All Riak nodes failed. Last error: timeout of 4000ms exceeded"`.

**Identified Root Causes:**

1. **Backend Bottleneck (Sequential Timeout):**
The Express backend attempts to connect to the Riak nodes sequentially with a hardcoded 4000ms timeout. When the cluster is degraded or a node is unreachable, it waits 4000ms *per node* before throwing an error ($4000\text{ms} \times 3 \text{ nodes} \approx 12000\text{ms}$ latency).
2. **Frontend Compounding Errors (The Catch-Block Trap):**
In the React frontend, the `catch` blocks for `handleAdd` and `handleRemove` blindly trigger `await refreshCart()` after a failed write attempt. This forces the UI to endure another 12-second backend timeout loop right after the first one fails, locking the UI for 24+ seconds.
3. **Frontend Request Avalanche (Interval Polling):**
The frontend uses a blind `setInterval` (every 2 seconds) to poll the `/api/health` endpoint. When the backend hangs for 12 seconds due to the downed node, these health check requests pile up in the browser (Request Avalanche), exhausting the browser's HTTP connection limit and blocking valid reads/writes.

**Required Actions (Your Task):**

Please refactor the provided code focusing on the following fixes:

* **Action 1 (Backend):** Rewrite the Riak connection logic in the Node.js backend. Replace the sequential loop with `Promise.any()` (so it races the requests and returns the fastest successful response) or implement a fast-failover loop with a strict, short timeout (e.g., 500ms - 1000ms max per node).
* **Action 2 (Frontend):** Remove the redundant `await refreshCart()` calls from the `catch` blocks of the write operations.
* **Action 3 (Frontend):** Replace the `setInterval` health polling mechanism with a recursive `setTimeout` pattern (ensuring the next poll only fires *after* the previous one resolves/rejects). If possible, implement a simple Exponential Backoff strategy for the polling when errors are detected.

