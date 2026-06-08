#!/bin/bash
# auto-down-watcher.sh — Automatically detects stopped Riak containers and marks them down in the cluster.
#
# Run this in a separate terminal during your demo:
#   bash infrastructure/auto-down-watcher.sh

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[WATCHER]${NC} $*"; }
ok()      { echo -e "${GREEN}[WATCHER]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WATCHER]${NC} $*"; }

echo -e "${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Riak Cluster Auto-Down Watcher                          ║${NC}"
echo -e "${CYAN}║  Monitors containers & automates 'riak-admin down'       ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Get mapping of container names to IP addresses
get_node_ips() {
  docker inspect -f '{{.Name}} {{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' riak-node-1 riak-node-2 riak-node-3 2>/dev/null | sed 's/\///'
}

# Find a healthy node to coordinate the "riak-admin down" command
get_healthy_node() {
  for node in riak-node-1 riak-node-2 riak-node-3; do
    if docker ps --format '{{.Names}}' | grep -q "^${node}$"; then
      echo "$node"
      return 0
    fi
  done
  return 1
}

# Track down status to avoid repeating commands
declare -A DOWN_NODES

while true; do
  HEALTHY_NODE=$(get_healthy_node || true)
  
  if [ -z "$HEALTHY_NODE" ]; then
    warn "All Riak containers are offline. Waiting..."
    sleep 3
    continue
  fi

  # Get current IP mappings
  MAPPINGS=$(get_node_ips || true)
  if [ -z "$MAPPINGS" ]; then
    sleep 3
    continue
  fi

  for node in riak-node-1 riak-node-2 riak-node-3; do
    # Check if container is running
    IS_RUNNING=$(docker ps --format '{{.Names}}' | grep -q "^${node}$" && echo "true" || echo "false")
    
    if [ "$IS_RUNNING" = "false" ]; then
      # Container is stopped. Find its IP address to construct Erlang nodename.
      IP=$(echo "$MAPPINGS" | grep "^${node} " | awk '{print $2}')
      if [ -n "$IP" ]; then
        NODENAME="riak@${IP}"
        if [ "${DOWN_NODES[$node]}" != "true" ]; then
          warn "Detected container '$node' is STOPPED."
          info "Automatically marking Erlang node '$NODENAME' as down via '$HEALTHY_NODE'..."
          
          if docker exec "$HEALTHY_NODE" riak-admin down "$NODENAME" >/dev/null 2>&1; then
            ok "Successfully marked '$NODENAME' as down in the cluster ring."
            DOWN_NODES[$node]="true"
          else
            warn "Failed to mark '$NODENAME' as down (it may already be down or unreachable)."
          fi
        fi
      fi
    else
      # Container is running. Reset down state tracking if it came back up
      if [ "${DOWN_NODES[$node]}" = "true" ]; then
        ok "Detected container '$node' has RESTARTED. Clearing blacklist state."
        DOWN_NODES[$node]="false"
      fi
    fi
  done

  sleep 2
done
