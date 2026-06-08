const express = require('express');
const router = express.Router();
const { fetchCart, addItem, removeItem } = require('../riakHttp');

/**
 * GET /api/cart/:userId
 * Retrieve the shopping cart for a user from Riak CRDT Map (via HTTP API).
 */
router.get('/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const { items } = await fetchCart(userId);
    res.json({ userId, items });
  } catch (err) {
    console.warn(`[Cart GET] Riak unavailable for user ${userId}:`, err.message);
    // Return empty cart — demonstrates HA: frontend still renders
    res.json({ userId, items: [], message: 'Riak cluster temporarily unavailable.' });
  }
});

/**
 * POST /api/cart/:userId
 * Add or increment an item in the shopping cart.
 * Body: { item: "ItemName", quantity: 1 }
 */
router.post('/:userId', async (req, res) => {
  const { userId } = req.params;
  const { item, quantity = 1 } = req.body;

  if (!item || typeof item !== 'string' || item.trim() === '') {
    return res.status(400).json({ error: 'Item name is required.' });
  }

  const itemName = item.trim();
  const qty = Math.max(1, parseInt(quantity) || 1);

  try {
    const { items } = await addItem(userId, itemName, qty);
    res.json({ userId, items, message: `"${itemName}" added to cart.` });
  } catch (err) {
    console.warn(`[Cart POST] Write warning for user ${userId}, item "${itemName}":`, err.message);
    // Return 200 OK for HA demo — item may have been written to quorum nodes
    res.json({
      userId,
      items: [],
      message: `"${itemName}" queued — Riak cluster is degraded but write may have succeeded.`,
      warning: err.message,
    });
  }
});

/**
 * DELETE /api/cart/:userId/:item
 * Remove an item from the cart using Riak map "remove" operation.
 */
router.delete('/:userId/:item', async (req, res) => {
  const { userId, item } = req.params;
  const itemName = decodeURIComponent(item);

  try {
    const { items } = await removeItem(userId, itemName);
    res.json({ userId, items, message: `"${itemName}" removed from cart.` });
  } catch (err) {
    console.warn(`[Cart DELETE] Remove failed for user ${userId}, item "${itemName}":`, err.message);
    // Refresh cart state from Riak on error
    try {
      const { items } = await fetchCart(userId);
      res.json({ userId, items, message: 'Remove may have failed — cluster degraded.', warning: err.message });
    } catch (_) {
      res.json({ userId, items: [], message: 'Riak cluster temporarily unavailable.', warning: err.message });
    }
  }
});

module.exports = router;
