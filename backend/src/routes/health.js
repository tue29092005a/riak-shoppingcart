const express = require('express');
const router = express.Router();
const { pingAllNodes } = require('../riakClient');

/**
 * GET /api/health
 * Ping all 3 Riak nodes and return their status.
 */
router.get('/', async (req, res) => {
  try {
    const nodes = await pingAllNodes();
    const onlineCount = nodes.filter(n => n.status === 'online').length;
    const clusterStatus = onlineCount >= 2 ? 'healthy' : onlineCount === 1 ? 'degraded' : 'down';

    res.json({
      cluster: clusterStatus,
      onlineNodes: onlineCount,
      totalNodes: nodes.length,
      nodes,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Health] Error pinging nodes:', err.message);
    res.status(500).json({
      cluster: 'unknown',
      error: err.message,
      nodes: [],
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
