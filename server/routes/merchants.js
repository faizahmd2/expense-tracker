'use strict';

/**
 * routes/merchants.js
 * Read and manage the learned merchant → category map.
 * Users can correct wrong auto-mappings here.
 */

const express = require('express');
const { getActiveDb, query, queryOne, run } = require('../db/connection');

const router = express.Router();

// ─── List ─────────────────────────────────────────────────────────────────────

router.get('/', (req, res, next) => {
  try {
    const db      = getActiveDb();
    const { search, low_confidence } = req.query;

    const conditions = [];
    const params     = {};

    if (search) {
      conditions.push('(m.raw_name LIKE :search OR m.normalized_name LIKE :search)');
      params[':search'] = `%${search}%`;
    }
    if (low_confidence === '1') {
      conditions.push('m.confidence < 0.7');
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = query(db, `
      SELECT m.*, c.name AS category_name, c.icon AS category_icon
      FROM merchants m
      LEFT JOIN categories c ON c.id = m.category_id
      ${where}
      ORDER BY m.occurrence_count DESC, m.last_seen_at DESC
      LIMIT 200
    `, params);

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── Update (re-map merchant to a different category) ─────────────────────────

router.patch('/:id', (req, res, next) => {
  try {
    const db       = getActiveDb();
    const existing = queryOne(db, 'SELECT * FROM merchants WHERE id = :id', { ':id': req.params.id });
    if (!existing) return res.status(404).json({ error: 'Merchant not found' });

    const { category_id, normalized_name } = req.body;
    const setClauses = ["confidence = 1.0", "source = 'manual'", "updated_at = datetime('now')"];
    const params     = { ':id': req.params.id };

    if (category_id)      { setClauses.push('category_id = :category_id');           params[':category_id']      = category_id; }
    if (normalized_name)  { setClauses.push('normalized_name = :normalized_name');   params[':normalized_name']  = normalized_name; }

    run(db, `UPDATE merchants SET ${setClauses.join(', ')} WHERE id = :id`, params);
    res.json({ data: queryOne(db, 'SELECT * FROM merchants WHERE id = :id', { ':id': req.params.id }) });
  } catch (err) {
    next(err);
  }
});

// ─── Delete (forget this merchant mapping) ────────────────────────────────────

router.delete('/:id', (req, res, next) => {
  try {
    const db = getActiveDb();
    run(db, 'DELETE FROM merchants WHERE id = :id', { ':id': req.params.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
