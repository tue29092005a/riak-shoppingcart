#!/bin/bash
# setup-cluster.sh — Initializes the Riak KV 3-node cluster and CRDT bucket types.
#
# Root cause of "Node riak@riak-node-X is not reachable":
#   - riak-admin status returns OK before the Erlang distribution is ready
#   - We must wait for the HTTP /ping endpoint AND verify the node name
#
# Run from the project root:  bash infrastructure/setup-cluster.sh

set -e

RIAK_NODE1="riak-node-1"
RIAK_NODE2="riak-node-2"
RIAK_NODE3="riak-node-3"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; }

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Riak KV Cluster Setup                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── Step 0: Verify containers are running ──────────────────────────────────
info "Checking containers are up..."
for node in $RIAK_NODE1 $RIAK_NODE2 $RIAK_NODE3; do
  if ! docker ps --format '{{.Names}}' | grep -q "^${node}$"; then
    error "Container '$node' is not running. Run: docker compose up -d"
    exit 1
  fi
done
ok "All 3 containers are running."

# ─── Step 1: Wait for each Riak node to be ready ───────────────────────────
# Strategy (two-stage):
#   1. "riak ping" — Riak's own built-in Erlang connectivity test.
#      Does NOT require curl inside the container. Returns 0 ("pong") when
#      the Erlang VM and distribution are up.
#   2. Host-side curl on the mapped port — confirms the HTTP listener is up.
#      Requires curl on the HOST machine (standard on Linux/macOS/Git Bash).
#
# Do NOT use:  docker exec <node> curl ...  (curl not in basho/riak-kv image)
wait_for_riak_ready() {
  local node=$1
  local host_port=$2   # mapped port on the host (8098 / 8198 / 8298)
  local max_attempts=36  # 36 x 5s = 3 minutes max per node

  info "Waiting for $node to be ready (host port $host_port)..."

  for i in $(seq 1 $max_attempts); do
    # Primary check: riak ping (built-in, no curl needed inside container)
    if docker exec "$node" riak ping > /dev/null 2>&1; then
      ok "$node: 'riak ping' returned pong — Erlang VM is up."

      # Secondary check: HTTP /ping via host-mapped port (confirms HTTP listener)
      if curl -sf --max-time 3 "http://localhost:${host_port}/ping" > /dev/null 2>&1; then
        ok "$node: HTTP /ping OK on localhost:${host_port}."
        return 0
      else
        echo "    $node Erlang up, waiting for HTTP listener on :${host_port}..."
      fi
    else
      echo "    attempt $i/$max_attempts — $node not ready yet, sleeping 5s..."
    fi
    sleep 5
  done

  error "$node did not become ready after $((max_attempts * 5))s."
  error "Check logs with:  docker logs $node"
  error "Check status:     docker exec $node riak ping"
  exit 1
}

# Host-mapped ports: node-1→8098, node-2→8198, node-3→8298
wait_for_riak_ready $RIAK_NODE1 8098
wait_for_riak_ready $RIAK_NODE2 8198
wait_for_riak_ready $RIAK_NODE3 8298

# ─── Step 2: Verify actual Erlang node names ─────────────────────────────────
# The node name must be riak@<hostname>. With hostname: set in docker-compose
# this will be riak@riak-node-1, riak@riak-node-2, riak@riak-node-3.
echo ""
info "Verifying Erlang node names..."
for node in $RIAK_NODE1 $RIAK_NODE2 $RIAK_NODE3; do
  NODENAME=$(docker exec "$node" riak-admin status 2>/dev/null | grep "^nodename" | awk '{print $3}')
  if [ -z "$NODENAME" ]; then
    # Fallback: read from riak.conf / vm.args
    NODENAME=$(docker exec "$node" cat /etc/riak/riak.conf 2>/dev/null | grep "^nodename" | awk -F= '{print $2}' | tr -d ' ')
  fi
  if [ -z "$NODENAME" ]; then
    NODENAME="riak@${node}"
    warn "Could not auto-detect node name for $node, assuming: $NODENAME"
  else
    ok "$node → $NODENAME"
  fi
done

# Extra grace period: let Erlang distribution fully stabilize
info "Giving nodes 10s extra to stabilize Erlang distribution..."
sleep 10

# ─── Step 3: Check if cluster is already formed ──────────────────────────────
echo ""
info "Checking current cluster membership..."
MEMBER_STATUS=$(docker exec $RIAK_NODE1 riak-admin member-status 2>/dev/null || true)
MEMBER_COUNT=$(echo "$MEMBER_STATUS" | grep -c "valid\|joining\|leaving\|exiting\|down" || true)

if [ "$MEMBER_COUNT" -ge 3 ] 2>/dev/null; then
  ok "Cluster already has $MEMBER_COUNT members. Skipping join steps."
  SKIP_JOIN=true
else
  SKIP_JOIN=false
fi

# ─── Step 4: Join nodes into cluster ────────────────────────────────────────
if [ "$SKIP_JOIN" = false ]; then
  echo ""
  echo -e "────────────────────────────────────────────"
  info "Joining riak-node-2 → riak@riak-node-1..."
  if docker exec $RIAK_NODE2 riak-admin cluster join "riak@${RIAK_NODE1}"; then
    ok "riak-node-2 join command sent."
  else
    warn "Join for riak-node-2 returned non-zero (may already be joined). Continuing..."
  fi

  sleep 2

  info "Joining riak-node-3 → riak@riak-node-1..."
  if docker exec $RIAK_NODE3 riak-admin cluster join "riak@${RIAK_NODE1}"; then
    ok "riak-node-3 join command sent."
  else
    warn "Join for riak-node-3 returned non-zero (may already be joined). Continuing..."
  fi

  # ─── Step 5: Plan and commit ──────────────────────────────────────────────
  echo ""
  echo -e "────────────────────────────────────────────"
  info "Planning cluster changes..."
  docker exec $RIAK_NODE1 riak-admin cluster plan

  info "Committing cluster plan..."
  docker exec $RIAK_NODE1 riak-admin cluster commit

  ok "Cluster plan committed."
fi

# ─── Step 6: Wait for ring to stabilize ─────────────────────────────────────
echo ""
info "Waiting for ring to stabilize (up to 60s)..."
for i in $(seq 1 12); do
  RING_READY=$(docker exec $RIAK_NODE1 riak-admin ring-status 2>/dev/null | grep "Ring Ready" | grep -c "true" || true)
  if [ "$RING_READY" -ge 1 ] 2>/dev/null; then
    ok "Ring is ready."
    break
  fi
  echo "    attempt $i/12 — ring not ready yet, sleeping 5s..."
  sleep 5
done

echo ""
info "Current member status:"
docker exec $RIAK_NODE1 riak-admin member-status || true

# ─── Step 7: CRDT bucket types ──────────────────────────────────────────────
echo ""
echo -e "────────────────────────────────────────────"
info "Setting up CRDT Map bucket type..."

# Check if already exists
EXISTING=$(docker exec $RIAK_NODE1 riak-admin bucket-type status maps 2>&1 || true)
if echo "$EXISTING" | grep -q "active"; then
  ok "Bucket type 'maps' is already active. Skipping."
else
  info "Creating bucket type 'maps' with datatype=map..."
  docker exec $RIAK_NODE1 riak-admin bucket-type create maps '{"props":{"datatype":"map"}}'

  info "Activating bucket type 'maps'..."
  docker exec $RIAK_NODE1 riak-admin bucket-type activate maps

  ok "Bucket type 'maps' activated."
fi

# ─── Step 8: Final verification ─────────────────────────────────────────────
echo ""
echo -e "────────────────────────────────────────────"
info "Final verification:"
docker exec $RIAK_NODE1 riak-admin bucket-type status maps | head -5

echo ""
echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✓ Riak cluster is ready!               ║${NC}"
echo -e "${GREEN}║                                          ║${NC}"
echo -e "${GREEN}║   HTTP:  localhost:8098  (node 1)        ║${NC}"
echo -e "${GREEN}║          localhost:8198  (node 2)        ║${NC}"
echo -e "${GREEN}║          localhost:8298  (node 3)        ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
