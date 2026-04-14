'use strict';

/**
 * routes/accounts.js
 * Full CRUD for accounts. Seeded from config.json on boot.
 */

const express = require('express');
const { getActiveDb, query, queryOne, run } = require('../db/connection');
const config = require('../../config.json');

const router = express.Router();

// ─── Seed from config (called at boot) ───────────────────────────────────────

function seedFromConfig() {
  const db = getActiveDb();
  for (const acc of (config.accounts ?? [])) {
    run(db, `
      INSERT OR IGNORE INTO accounts (id, name, bank, type, currency)
      VALUES (:id, :name, :bank, :type, :currency)
    `, { ':id': acc.id, ':name': acc.name, ':bank': acc.bank ?? null, ':type': acc.type, ':currency': acc.currency ?? 'INR' });
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

router.get('/', (req, res, next) => {
  try {
    const db   = getActiveDb();
    const rows = query(db, `
      SELECT a.*,
        COUNT(t.id) AS transaction_count,
        COALESCE(SUM(CASE WHEN t.type='credit' AND t.is_excluded=0 THEN t.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.type='debit'  AND t.is_excluded=0 THEN t.amount ELSE 0 END), 0)
          AS net_balance
      FROM accounts a
      LEFT JOIN transactions t ON t.account_id = a.id
      WHERE a.is_active = 1
      GROUP BY a.id
      ORDER BY a.name ASC
    `);
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── Create ───────────────────────────────────────────────────────────────────

router.post('/', (req, res, next) => {
  try {
    const { id, name, bank, type, currency = 'INR', notes } = req.body;
    const errors = [];
    if (!id?.trim())   errors.push('id is required');
    if (!name?.trim()) errors.push('name is required');
    if (!['savings','current','credit','cash','wallet'].includes(type)) errors.push('invalid type');
    if (errors.length) return res.status(400).json({ errors });

    const db = getActiveDb();
    run(db, `INSERT INTO accounts (id, name, bank, type, currency, notes) VALUES (:id, :name, :bank, :type, :currency, :notes)`,
      { ':id': id, ':name': name, ':bank': bank ?? null, ':type': type, ':currency': currency, ':notes': notes ?? null });

    res.status(201).json({ data: queryOne(db, 'SELECT * FROM accounts WHERE id = :id', { ':id': id }) });
  } catch (err) {
    next(err);
  }
});

// ─── Update ───────────────────────────────────────────────────────────────────

router.patch('/:id', (req, res, next) => {
  try {
    const db       = getActiveDb();
    const existing = queryOne(db, 'SELECT * FROM accounts WHERE id = :id', { ':id': req.params.id });
    if (!existing) return res.status(404).json({ error: 'Account not found' });

    const EDITABLE   = ['name', 'bank', 'type', 'currency', 'is_active', 'notes'];
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
    run(db, `UPDATE accounts SET ${setClauses.join(', ')} WHERE id = :id`, params);

    res.json({ data: queryOne(db, 'SELECT * FROM accounts WHERE id = :id', { ':id': req.params.id }) });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, seedFromConfig };
