# Riak KV Shopping Cart Demo

> A fully containerized demonstration of **Riak KV** with **CRDT Maps**, simulating an e-commerce shopping cart with real-time cluster health monitoring and chaos engineering.

## 🏗️ Architecture

```
React Frontend (port 3000)
    ↕ REST API
Node.js Express Backend (port 3001)
    ↕ Protocol Buffers
Riak KV 3-node Cluster (ports 8087–8287)
```

## 📁 Project Structure

```
riak-shoppingcart/
├── infrastructure/
│   ├── docker-compose.yml    # 3-node Riak + backend + fronten\d
│   └── setup-cluster.sh      # Cluster init + CRDT bucket types
├── backend/
│   ├── src/
│   │   ├── server.js         # Express entry point
│   │   ├── riakClient.js     # Riak client + health ping
│   │   └── routes/
│   │       ├── cart.js       # CRDT Map operations
│   │       └── health.js     # Node health endpoints
│   ├── package.json
│   └── Dockerfile
├── frontend/
│   ├── src/
│   │   ├── App.js            # Main app with polling
│   │   ├── api.js            # Axios API client
│   │   ├── index.css         # Dark theme + Tailwind
│   │   └── components/
│   │       ├── CartPanel.jsx       # Cart UI
│   │       └── ClusterVisualizer.jsx  # Node health cards
│   └── Dockerfile
├── DEMO_GUIDE.md             # Chaos engineering walkthrough
└── .env.example
```

## 🚀 Quick Start

```bash
# 1. Start everything
cd infrastructure
docker compose up -d

# 2. Initialize cluster (wait ~30s after up)
bash setup-cluster.sh

# 3. Open browser
open http://localhost:3000
```

## 🔥 Chaos Demo

### VIDEO DEMO

https://drive.google.com/file/d/1jHcNKemysJlesTQLu3glMCy6eAOKbatZ/view?usp=sharing

## 1. Open the Dashboard

Navigate to **http://localhost:3000** in your browser.

You should see:
- 🛍️ **Shopping Cart** panel at the top
- 🖥️ **Cluster Visualizer** with **3 green (Online)** node cards at the bottom

---

## 2. Chaos Engineering Steps

### Step A — Add items normally

1. Type an item name (e.g., `Laptop`) in the input field
2. Click **Add**
3. Observe the item appear in the cart with quantity `×1`
4. Add a few more items: `Mouse`, `Headphones`, `Coffee`

All 3 nodes should remain **Online** (green) in the visualizer.

---

### Step B — Kill Node 3

Open a new terminal and run:

```bash
docker stop riak-node-3
```

After 10s check the ring status by below command
```bash
#check status of each node in riak ring
curl -s http://localhost:3001/api/health | python -m json.tool

# View transfer operations (Riak balancing data)
docker exec riak-node-1 riak-admin transfers
```


---

### Step C — Observe Node 3 going Offline

Within **≤ 2 seconds**, the Cluster Visualizer will update:

- `riak-node-3` turns **gray (Offline)**
- The cluster status badge changes from `✦ Cluster Healthy` → `⚠ Cluster Degraded`
- The node health progress bar drops from 3/3 → 2/3

> The app is still fully functional. Riak KV requires only a **quorum** (2 of 3 nodes) for reads and writes.

---

### Step D — Add an item while a node is down

1. In the Shopping Cart input, type `Keyboard`
2. Click **Add**
3. Observe: `Keyboard` appears in the cart ✓

**What happened under the hood:**
- The backend sent the CRDT Map update to the cluster
- Riak accepted the write with **W=2 (quorum)**; the update was replicated to Node 1 and Node 2
- Node 3 **missed** this write (it's offline) — it has a **stale replica**

---

### Step E — Bring Node 3 back online

```bash
docker start riak-node-3
```

Node 3 restarts. Within a few seconds, the visualizer shows it back as **Online**.

---

### Step F — Read Repair (Eventual Consistency in action)

1. Click **Refresh** or simply wait for the next auto-poll (the cart refreshes on every add/remove)
2. Observe: `Keyboard` is present in the cart — it was already consistent

**How Read Repair works:**
When any Riak node receives a read request for a key, it compares the value across all replicas using **vector clocks**. If a replica (e.g., Node 3) returns a stale value, Riak:
1. Detects the discrepancy via the vector clock
2. Returns the most recent value to the client
3. **Asynchronously updates** the stale replica (Node 3) with the latest value

Because we use **CRDT Maps**, Riak automatically **merges** concurrent writes — there are no conflicts, only monotonically growing state. `Keyboard` is guaranteed to appear once Node 3 rejoins.

---

## 3. Understanding the Architecture

```
Browser (React)
    │  polling /api/health every 2–16s (adaptive exponential backoff)
    │  cart operations → /api/cart/:userId
    ▼
Node.js Express Backend (port 3001)
    │  uses parallel-race failover client (riakHttp.js)
    │  races all live nodes via Promise.any() — fastest wins
    ├──▶ riak-node-1 (HTTP: 8098)
    ├──▶ riak-node-2 (HTTP: 8198)
    └──▶ riak-node-3 (HTTP: 8298)
         │
         Riak KV Cluster (3 nodes, bucket type: maps)
         CRDT Map per user key: { "ItemName_counter": N }
```

### Key Riak concepts demonstrated

| Concept | In this demo |
|---|---|
| **CRDTs** | Shopping cart stored as a CRDT Map with Counter fields |
| **Eventual Consistency** | Writes propagate asynchronously after node restart |
| **Read Repair** | Riak detects stale replicas on read and repairs in background |
| **High Availability** | Backend returns 200 OK even when cluster is degraded |
| **Quorum** | Default W=quorum means 2/3 nodes must ack a write |

---

## 5. API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/health` | Returns status of all 3 nodes |
| `GET`  | `/api/cart/:userId` | Get cart for a user |
| `POST` | `/api/cart/:userId` | Add/increment item `{ item, quantity }` |
| `DELETE` | `/api/cart/:userId/:item` | Remove item from cart |

---

## 6. Useful Commands

```bash
# Is the cluster healthy?
curl -s http://localhost:3001/api/health | python -m json.tool

# View transfer operations (Riak balancing data)
docker exec riak-node-1 riak-admin transfers

# View Riak cluster ring status
docker exec riak-node-1 riak-admin ring-status

# Check member status
docker exec riak-node-1 riak-admin member-status

# List bucket types
docker exec riak-node-1 riak-admin bucket-type list

# View bucket type properties
docker exec riak-node-1 riak-admin bucket-type status maps

# Stop/start individual nodes
docker stop riak-node-2
docker start riak-node-2

# View backend logs
docker logs -f riak-backend

# Tear everything down
cd infrastructure && docker compose down -v
```

---

## 7. Troubleshooting


| Issue | Solution |
|---|---|
| Visualizer shows all nodes offline | Backend can't reach Riak — wait 30s after `docker compose up` or run `setup-cluster.sh` |
| Cart shows empty after adding items | CRDT bucket type not activated — re-run `setup-cluster.sh` |
| `setup-cluster.sh` fails with "not ready" | Riak nodes need more time — wait 60s and retry |
| Frontend shows CORS errors | Ensure backend is on port 3001 and `REACT_APP_API_URL` is set correctly |

---

*Built with Riak KV 3-node cluster · Node.js Express · React · Docker*

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Database | Riak KV 3-node cluster, CRDT Maps |
| Backend | Node.js, Express, Axios (HTTP REST) |
| Frontend | React, Tailwind CSS |
| Infra | Docker, Docker Compose |
