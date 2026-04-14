'use strict';

/**
 * routes/sync.js
 *
 * Handles bi-directional sync between the iPhone queue and Mac master DB.
 *
 * Protocol:
 *   1. Phone sends all pending ops (INSERT / UPDATE / DELETE)
 *      since its last_synced_at timestamp.
 *   2. Mac applies each op, detecting and logging conflicts.
 *   3. Mac returns all changes it made since phone's last_synced_at
 *      so the phone can update its local queue.
 *   4. Phone confirms receipt → sync complete.
 */

const express = require('express');
const { getActiveDb, getDbForYear, query, queryOne, run } = require('../db/connection');
const { learnMerchant } = require('../parser/notification');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// ─── Inbound sync (phone → Mac) ───────────────────────────────────────────────

/**
 * POST /api/sync/push
 *
 * Body:
 * {
 *   last_synced_at: ISO string,
 *   ops: [
 *     { op_id, entity, entity_id, op_type, payload, changed_at }
 *   ]
 * }
 */
router.post('/push', async (req, res, next) => {
  try {
    const { last_synced_at, ops = [] } = req.body;

    if (!Array.isArray(ops)) {
      return res.status(400).json({ error: 'ops must be an array' });
    }

    const results = { applied: [], skipped: [], conflicts: [] };

    for (const op of ops) {
      const result = await applyOp(op);
      results[result.status].push({ op_id: op.op_id, entity_id: op.entity_id, reason: result.reason });
    }

    // Return Mac-side changes the phone doesn't have yet
    const serverChanges = await getChangesSince(last_synced_at);

    res.json({
      sync_results:   results,
      server_changes: serverChanges,
      server_time:    new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

// ─── Outbound sync (Mac → phone) ──────────────────────────────────────────────

/**
 * GET /api/sync/pull
 * Query param: since (ISO timestamp)
 * Returns all transactions changed since that timestamp.
 */
router.get('/pull', async (req, res, next) => {
  try {
    const since = req.query.since ?? '1970-01-01T00:00:00.000Z';
    const changes = await getChangesSince(since);
    res.json({ data: changes, server_time: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

// ─── Apply a single op ────────────────────────────────────────────────────────

async function applyOp(op) {
  const { op_id, entity, entity_id, op_type, payload, changed_at } = op;

  if (!entity || !entity_id || !op_type || !payload) {
    return { status: 'skipped', reason: 'malformed op' };
  }

  const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;

  try {
    switch (entity) {
      case 'transaction': return applyTransactionOp(op_type, entity_id, parsedPayload, changed_at);
      case 'category':    return applyCategoryOp(op_type, entity_id, parsedPayload);
      case 'account':     return applyAccountOp(op_type, entity_id, parsedPayload);
      default:            return { status: 'skipped', reason: `unknown entity: ${entity}` };
    }
  } catch (err) {
    return { status: 'skipped', reason: err.message };
  }
}

// ─── Transaction ops ──────────────────────────────────────────────────────────

function applyTransactionOp(opType, entityId, payload, changedAt) {
  const db       = getActiveDb();
  const existing = queryOne(db, 'SELECT * FROM transactions WHERE id = :id', { ':id': entityId });

  if (opType === 'DELETE') {
    if (!existing) return { status: 'skipped', reason: 'already gone' };

    // Conflict: Mac has edits vs phone wants to delete → keep Mac's version, log conflict
    if (existing.updated_at > changedAt) {
      logConflict(db, 'transaction', entityId, existing, payload);
      return { status: 'conflicts', reason: 'delete-vs-edit conflict, kept mac version' };
    }

    run(db, 'DELETE FROM transactions WHERE id = :id', { ':id': entityId });
    return { status: 'applied' };
  }

  if (opType === 'INSERT') {
    if (existing) return { status: 'skipped', reason: 'already exists' };

    run(db, `
      INSERT INTO transactions
        (id, account_id, category_id, amount, type, merchant_raw, note,
         reference_number, tags, transacted_at, source, raw_notification,
         needs_review, is_verified, is_excluded, created_at, updated_at)
      VALUES
        (:id, :account_id, :category_id, :amount, :type, :merchant_raw, :note,
         :reference_number, :tags, :transacted_at, :source, :raw_notification,
         :needs_review, :is_verified, :is_excluded, :created_at, :updated_at)
    `, buildTransactionParams(payload));

    return { status: 'applied' };
  }

  if (opType === 'UPDATE') {
    if (!existing) {
      // Phone updated something Mac doesn't have — treat as insert
      run(db, `
        INSERT INTO transactions
          (id, account_id, category_id, amount, type, merchant_raw, note,
           reference_number, tags, transacted_at, source, raw_notification,
           needs_review, is_verified, is_excluded, created_at, updated_at)
        VALUES
          (:id, :account_id, :category_id, :amount, :type, :merchant_raw, :note,
           :reference_number, :tags, :transacted_at, :source, :raw_notification,
           :needs_review, :is_verified, :is_excluded, :created_at, :updated_at)
      `, buildTransactionParams(payload));
      return { status: 'applied', reason: 'inserted (was missing on mac)' };
    }

    // Last-write-wins: whichever updated_at is newer wins
    if (existing.updated_at >= (payload.updated_at ?? changedAt)) {
      return { status: 'skipped', reason: 'mac version is newer' };
    }

    const params = buildTransactionParams(payload);
    run(db, `
      UPDATE transactions SET
        account_id = :account_id, category_id = :category_id,
        amount = :amount, type = :type, merchant_raw = :merchant_raw,
        note = :note, reference_number = :reference_number, tags = :tags,
        transacted_at = :transacted_at, needs_review = :needs_review,
        is_verified = :is_verified, is_excluded = :is_excluded,
        updated_at = :updated_at
      WHERE id = :id
    `, params);

    // Learn merchant category changes from phone edits too
    if (payload.merchant_raw && payload.category_id && payload.category_id !== existing.category_id) {
      learnMerchant(payload.merchant_raw, payload.merchant_raw, payload.category_id, 'manual');
    }

    return { status: 'applied' };
  }

  return { status: 'skipped', reason: `unknown op_type: ${opType}` };
}

// ─── Category ops ─────────────────────────────────────────────────────────────

function applyCategoryOp(opType, entityId, payload) {
  const db       = getActiveDb();
  const existing = queryOne(db, 'SELECT * FROM categories WHERE id = :id', { ':id': entityId });

  if (opType === 'INSERT' && !existing) {
    run(db, `INSERT INTO categories (id, name, icon, color, is_income, sort_order) VALUES (:id, :name, :icon, :color, :is_income, :sort_order)`,
      { ':id': entityId, ':name': payload.name, ':icon': payload.icon, ':color': payload.color, ':is_income': payload.is_income ?? 0, ':sort_order': payload.sort_order ?? 50 });
    return { status: 'applied' };
  }

  if (opType === 'UPDATE' && existing) {
    run(db, `UPDATE categories SET name = :name, icon = :icon, color = :color, is_income = :is_income, sort_order = :sort_order, updated_at = datetime('now') WHERE id = :id`,
      { ':id': entityId, ':name': payload.name, ':icon': payload.icon, ':color': payload.color, ':is_income': payload.is_income ?? 0, ':sort_order': payload.sort_order ?? 50 });
    return { status: 'applied' };
  }

  return { status: 'skipped', reason: 'no-op' };
}

// ─── Account ops ──────────────────────────────────────────────────────────────

function applyAccountOp(opType, entityId, payload) {
  const db       = getActiveDb();
  const existing = queryOne(db, 'SELECT * FROM accounts WHERE id = :id', { ':id': entityId });

  if (opType === 'UPDATE' && existing) {
    run(db, `UPDATE accounts SET name = :name, notes = :notes, is_active = :is_active, updated_at = datetime('now') WHERE id = :id`,
      { ':id': entityId, ':name': payload.name, ':notes': payload.notes ?? null, ':is_active': payload.is_active ?? 1 });
    return { status: 'applied' };
  }

  return { status: 'skipped', reason: 'no-op' };
}

// ─── Server changes ───────────────────────────────────────────────────────────

async function getChangesSince(since) {
  const db = getActiveDb();
  return query(db, `
    SELECT * FROM transactions
    WHERE updated_at > :since
    ORDER BY updated_at ASC
  `, { ':since': since });
}

// ─── Conflict logging ─────────────────────────────────────────────────────────

function logConflict(db, entity, entityId, macRow, phonePayload) {
  run(db, `
    INSERT INTO conflicts (id, entity, entity_id, mac_payload, phone_payload)
    VALUES (:id, :entity, :entity_id, :mac_payload, :phone_payload)
  `, {
    ':id':            uuidv4(),
    ':entity':        entity,
    ':entity_id':     entityId,
    ':mac_payload':   JSON.stringify(macRow),
    ':phone_payload': JSON.stringify(phonePayload),
  });
}

// ─── Param builder ────────────────────────────────────────────────────────────

function buildTransactionParams(p) {
  return {
    ':id':               p.id,
    ':account_id':       p.account_id,
    ':category_id':      p.category_id ?? 'uncategorized',
    ':amount':           p.amount,
    ':type':             p.type,
    ':merchant_raw':     p.merchant_raw ?? null,
    ':note':             p.note ?? null,
    ':reference_number': p.reference_number ?? null,
    ':tags':             typeof p.tags === 'string' ? p.tags : JSON.stringify(p.tags ?? []),
    ':transacted_at':    p.transacted_at,
    ':source':           p.source ?? 'manual',
    ':raw_notification': p.raw_notification ?? null,
    ':needs_review':     p.needs_review ? 1 : 0,
    ':is_verified':      p.is_verified  ? 1 : 0,
    ':is_excluded':      p.is_excluded  ? 1 : 0,
    ':created_at':       p.created_at ?? new Date().toISOString(),
    ':updated_at':       p.updated_at ?? new Date().toISOString(),
  };
}

module.exports = router;
