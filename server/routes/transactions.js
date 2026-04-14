'use strict';

/**
 * routes/transactions.js
 *
 * Full CRUD for transactions.
 * When a user updates a category, the merchant map is updated automatically
 * so future notifications for the same merchant are categorised correctly.
 */

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const { format, parseISO, isValid } = require('date-fns');

const { getActiveDb, getDbForYear, query, queryOne, run, queryAcrossYears } = require('../db/connection');
const { parseNotification, learnMerchant } = require('../parser/notification');
const config = require('../../config.json');

const router = express.Router();

// ─── List / search transactions ───────────────────────────────────────────────

/**
 * GET /api/transactions
 * Query params:
 *   from        - ISO date  (default: start of current month)
 *   to          - ISO date  (default: today)
 *   account_id  - filter by account
 *   category_id - filter by category
 *   type        - debit | credit | transfer
 *   needs_review - 1 to show only review-needed
 *   search      - text search on note + merchant
 *   limit       - default 100
 *   offset      - default 0
 */
router.get('/', async (req, res, next) => {
  try {
    const {
      from,
      to,
      account_id,
      category_id,
      type,
      needs_review,
      search,
      limit  = 100,
      offset = 0,
    } = req.query;

    const fromDate = from ?? format(startOfMonth(), "yyyy-MM-dd'T'00:00:00");
    const toDate   = to   ?? format(new Date(),     "yyyy-MM-dd'T'23:59:59");

    // Determine which year files to open
    const years = yearsInRange(fromDate, toDate);

    // Build dynamic WHERE clauses
    const conditions = [
      't.transacted_at >= :from',
      't.transacted_at <= :to',
    ];
    const params = { ':from': fromDate, ':to': toDate };

    if (account_id)   { conditions.push('t.account_id = :account_id');   params[':account_id']   = account_id; }
    if (category_id)  { conditions.push('t.category_id = :category_id'); params[':category_id']  = category_id; }
    if (type)         { conditions.push('t.type = :type');               params[':type']          = type; }
    if (needs_review) { conditions.push('t.needs_review = 1'); }
    if (search) {
      conditions.push("(t.note LIKE :search OR t.merchant_raw LIKE :search)");
      params[':search'] = `%${search}%`;
    }

    const where = conditions.join(' AND ');

    const sql = `
      SELECT
        t.id, t.account_id, t.category_id, t.merchant_id,
        t.amount, t.type, t.currency, t.transfer_pair_id,
        t.merchant_raw, t.note, t.reference_number, t.tags,
        t.transacted_at, t.created_at, t.updated_at,
        t.source, t.is_verified, t.is_excluded, t.needs_review,
        c.name  AS category_name,
        c.icon  AS category_icon,
        c.color AS category_color,
        a.name  AS account_name
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts   a ON a.id = t.account_id
      WHERE ${where}
      ORDER BY t.transacted_at DESC
      LIMIT :limit OFFSET :offset
    `;
    params[':limit']  = parseInt(limit, 10);
    params[':offset'] = parseInt(offset, 10);

    const rows = years.length === 1
      ? query(getActiveDb(), sql, params)
      : await queryAcrossYears(years, sql, params);

    // Parse JSON tags field
    const transactions = rows.map(deserialise);

    res.json({ data: transactions, meta: { limit, offset, count: transactions.length } });
  } catch (err) {
    next(err);
  }
});

// ─── Get single transaction ───────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const db  = getActiveDb();
    const row = queryOne(db, `
      SELECT
        t.*,
        c.name  AS category_name,
        c.icon  AS category_icon,
        c.color AS category_color,
        a.name  AS account_name
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN accounts   a ON a.id = t.account_id
      WHERE t.id = :id
    `, { ':id': req.params.id });

    if (!row) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ data: deserialise(row) });
  } catch (err) {
    next(err);
  }
});

// ─── Create transaction (manual entry) ───────────────────────────────────────

/**
 * POST /api/transactions
 * Body: { account_id, amount, type, transacted_at, category_id?,
 *         note?, merchant_raw?, tags?, is_excluded?, reference_number? }
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      account_id,
      amount,
      type,
      transacted_at,
      category_id    = 'uncategorized',
      note           = null,
      merchant_raw   = null,
      tags           = [],
      is_excluded    = 0,
      reference_number = null,
    } = req.body;

    // ── Validation ────────────────────────────────────────────────────────────
    const errors = [];
    if (!account_id)               errors.push('account_id is required');
    if (!amount || amount <= 0)    errors.push('amount must be a positive number');
    if (!['debit','credit','transfer'].includes(type)) errors.push('type must be debit | credit | transfer');
    if (!transacted_at)            errors.push('transacted_at is required');
    if (errors.length) return res.status(400).json({ errors });

    const db = getActiveDb();
    const id = uuidv4();

    run(db, `
      INSERT INTO transactions
        (id, account_id, category_id, amount, type, merchant_raw,
         note, reference_number, tags, transacted_at, source, is_excluded, is_verified)
      VALUES
        (:id, :account_id, :category_id, :amount, :type, :merchant_raw,
         :note, :reference_number, :tags, :transacted_at, 'manual', :is_excluded, 1)
    `, {
      ':id':               id,
      ':account_id':       account_id,
      ':category_id':      category_id,
      ':amount':           amount,
      ':type':             type,
      ':merchant_raw':     merchant_raw,
      ':note':             note,
      ':reference_number': reference_number,
      ':tags':             JSON.stringify(tags),
      ':transacted_at':    transacted_at,
      ':is_excluded':      is_excluded ? 1 : 0,
    });

    const created = queryOne(db, 'SELECT * FROM transactions WHERE id = :id', { ':id': id });
    res.status(201).json({ data: deserialise(created) });
  } catch (err) {
    next(err);
  }
});

// ─── Update transaction ───────────────────────────────────────────────────────

/**
 * PATCH /api/transactions/:id
 * Accepts any subset of editable fields.
 * If category_id changes, the merchant map is updated automatically.
 */
router.patch('/:id', async (req, res, next) => {
  try {
    const db  = getActiveDb();
    const existing = queryOne(db, 'SELECT * FROM transactions WHERE id = :id', { ':id': req.params.id });

    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    const EDITABLE = [
      'account_id', 'category_id', 'amount', 'type',
      'merchant_raw', 'note', 'reference_number', 'tags',
      'transacted_at', 'is_excluded', 'is_verified', 'needs_review',
    ];

    const updates   = {};
    const setClauses = [];

    for (const field of EDITABLE) {
      if (req.body[field] !== undefined) {
        updates[field] = field === 'tags'
          ? JSON.stringify(req.body[field])
          : req.body[field];
        setClauses.push(`${field} = :${field}`);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No editable fields provided' });
    }

    setClauses.push("updated_at = datetime('now')");

    const params = { ':id': req.params.id };
    for (const [k, v] of Object.entries(updates)) params[`:${k}`] = v;

    run(db, `UPDATE transactions SET ${setClauses.join(', ')} WHERE id = :id`, params);

    // ── Merchant learning: if user changed category, remember it ─────────────
    const categoryChanged = updates.category_id && updates.category_id !== existing.category_id;
    const merchantName    = updates.merchant_raw ?? existing.merchant_raw;

    if (categoryChanged && merchantName) {
      learnMerchant(merchantName, merchantName, updates.category_id, 'manual');
    }

    // ── Auto-clear needs_review when user edits ───────────────────────────────
    if (existing.needs_review && !updates.hasOwnProperty('needs_review')) {
      run(db, `UPDATE transactions SET needs_review = 0 WHERE id = :id`, { ':id': req.params.id });
    }

    const updated = queryOne(db, 'SELECT * FROM transactions WHERE id = :id', { ':id': req.params.id });
    res.json({ data: deserialise(updated) });
  } catch (err) {
    next(err);
  }
});

// ─── Delete transaction ───────────────────────────────────────────────────────

router.delete('/:id', async (req, res, next) => {
  try {
    const db = getActiveDb();
    const existing = queryOne(db, 'SELECT id FROM transactions WHERE id = :id', { ':id': req.params.id });

    if (!existing) return res.status(404).json({ error: 'Transaction not found' });

    run(db, 'DELETE FROM transactions WHERE id = :id', { ':id': req.params.id });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Parse notification (called by iOS app) ───────────────────────────────────

/**
 * POST /api/transactions/parse
 * Body: { raw_notification: string, account_id?: string, received_at?: string }
 *
 * Parses and creates a draft transaction. Returns it with needs_review flag.
 * The iOS app shows this instantly — user reviews and saves.
 */
router.post('/parse', async (req, res, next) => {
  try {
    const { raw_notification, account_id, received_at } = req.body;

    if (!raw_notification) {
      return res.status(400).json({ error: 'raw_notification is required' });
    }

    const parsed = await parseNotification(raw_notification);

    if (!parsed.success || !parsed.amount) {
      // Even failed parses are stored for manual completion
      return res.status(200).json({
        data: null,
        parse_result: parsed,
        message: 'Could not parse notification. Please add transaction manually.',
      });
    }

    // Resolve account from hint if not provided
    const resolvedAccountId = account_id
      ?? resolveAccountFromHint(parsed.account_hint)
      ?? 'cash';

    const db = getActiveDb();
    const id = uuidv4();

    run(db, `
      INSERT INTO transactions
        (id, account_id, category_id, amount, type, merchant_raw,
         reference_number, transacted_at, source, raw_notification,
         needs_review, is_verified)
      VALUES
        (:id, :account_id, :category_id, :amount, :type, :merchant_raw,
         :reference_number, :transacted_at, 'notification', :raw_notification,
         :needs_review, 0)
    `, {
      ':id':               id,
      ':account_id':       resolvedAccountId,
      ':category_id':      parsed.category_id,
      ':amount':           parsed.amount,
      ':type':             parsed.type,
      ':merchant_raw':     parsed.merchant_raw,
      ':reference_number': parsed.reference,
      ':transacted_at':    received_at ?? new Date().toISOString(),
      ':raw_notification': raw_notification,
      ':needs_review':     parsed.needs_review ? 1 : 0,
    });

    const created = queryOne(db, 'SELECT * FROM transactions WHERE id = :id', { ':id': id });
    res.status(201).json({ data: deserialise(created), parse_result: parsed });
  } catch (err) {
    next(err);
  }
});

// ─── Summary / analytics ──────────────────────────────────────────────────────

/**
 * GET /api/transactions/summary
 * Returns monthly totals by category for a given month.
 * Query params: year (default current), month (default current, 1-12)
 */
router.get('/summary/monthly', async (req, res, next) => {
  try {
    const year  = parseInt(req.query.year  ?? new Date().getFullYear(), 10);
    const month = parseInt(req.query.month ?? new Date().getMonth() + 1, 10);

    const from = `${year}-${String(month).padStart(2,'0')}-01T00:00:00`;
    const to   = `${year}-${String(month).padStart(2,'0')}-31T23:59:59`;

    const db = await getDbForYear(year);

    const byCategory = query(db, `
      SELECT
        t.category_id,
        c.name  AS category_name,
        c.icon  AS category_icon,
        c.color AS category_color,
        t.type,
        COUNT(*) AS count,
        SUM(t.amount) AS total
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.transacted_at BETWEEN :from AND :to
        AND t.is_excluded = 0
        AND t.type != 'transfer'
      GROUP BY t.category_id, t.type
      ORDER BY total DESC
    `, { ':from': from, ':to': to });

    const totals = query(db, `
      SELECT
        type,
        SUM(amount) AS total,
        COUNT(*)    AS count
      FROM transactions
      WHERE transacted_at BETWEEN :from AND :to
        AND is_excluded = 0
        AND type != 'transfer'
      GROUP BY type
    `, { ':from': from, ':to': to });

    res.json({ data: { by_category: byCategory, totals } });
  } catch (err) {
    next(err);
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function deserialise(row) {
  if (!row) return null;
  return {
    ...row,
    tags:        row.tags ? JSON.parse(row.tags) : [],
    is_verified: Boolean(row.is_verified),
    is_excluded: Boolean(row.is_excluded),
    needs_review: Boolean(row.needs_review),
  };
}

function startOfMonth() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function yearsInRange(from, to) {
  const fromYear = new Date(from).getFullYear();
  const toYear   = new Date(to).getFullYear();
  const years    = [];
  for (let y = fromYear; y <= toYear; y++) years.push(y);
  return years;
}

function resolveAccountFromHint(hint) {
  if (!hint) return null;
  const accounts = config.accounts ?? [];
  const match    = accounts.find(a => a.id.includes(hint) || a.name.includes(hint));
  return match?.id ?? null;
}

module.exports = router;
