'use strict';

/**
 * routes/categories.js
 * Full CRUD for categories. User owns these completely.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getActiveDb, query, queryOne, run } = require('../db/connection');

const router = express.Router();

// ─── List ─────────────────────────────────────────────────────────────────────

router.get('/', (req, res, next) => {
  try {
    const db   = getActiveDb();
    const rows = query(db, `
      SELECT c.*, COUNT(t.id) AS transaction_count
      FROM categories c
      LEFT JOIN transactions t ON t.category_id = c.id
      GROUP BY c.id
      ORDER BY c.is_income ASC, c.sort_order ASC, c.name ASC
    `);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── Create ───────────────────────────────────────────────────────────────────

router.post('/', (req, res, next) => {
  try {
    const { name, icon = '💰', color = '#6B7280', is_income = 0, sort_order = 50 } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const db = getActiveDb();
    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    run(db, `
      INSERT INTO categories (id, name, icon, color, is_income, sort_order)
      VALUES (:id, :name, :icon, :color, :is_income, :sort_order)
    `, { ':id': id, ':name': name.trim(), ':icon': icon, ':color': color, ':is_income': is_income ? 1 : 0, ':sort_order': sort_order });

    res.status(201).json({ data: queryOne(db, 'SELECT * FROM categories WHERE id = :id', { ':id': id }) });
  } catch (err) {
    next(err);
  }
});

// ─── Update ───────────────────────────────────────────────────────────────────

router.patch('/:id', (req, res, next) => {
  try {
    const db       = getActiveDb();
    const existing = queryOne(db, 'SELECT * FROM categories WHERE id = :id', { ':id': req.params.id });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    const EDITABLE   = ['name', 'icon', 'color', 'is_income', 'sort_order'];
    const setClauses = [];
    const params     = { ':id': req.params.id };

    for (const field of EDITABLE) {
      if (req.body[field] !== undefined) {
        setClauses.push(`${field} = :${field}`);
        params[`:${field}`] = req.body[field];
      }
    }

    if (!setClauses.length) return res.status(400).json({ error: 'No fields to update' });
    setClauses.push("updated_at = datetime('now')");

    run(db, `UPDATE categories SET ${setClauses.join(', ')} WHERE id = :id`, params);
    res.json({ data: queryOne(db, 'SELECT * FROM categories WHERE id = :id', { ':id': req.params.id }) });
  } catch (err) {
    next(err);
  }
});

// ─── Delete ───────────────────────────────────────────────────────────────────

router.delete('/:id', (req, res, next) => {
  try {
    const db       = getActiveDb();
    const existing = queryOne(db, 'SELECT id FROM categories WHERE id = :id', { ':id': req.params.id });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    // Reassign transactions to uncategorized before deleting
    run(db, `UPDATE transactions SET category_id = 'uncategorized' WHERE category_id = :id`, { ':id': req.params.id });
    run(db, `DELETE FROM categories WHERE id = :id`, { ':id': req.params.id });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
