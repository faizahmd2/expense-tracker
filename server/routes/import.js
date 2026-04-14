'use strict';

/**
 * routes/import.js
 *
 * Bulk import transactions from bank CSV statements.
 * Supports common Indian bank export formats.
 * Each row is parsed and enriched just like a notification.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getActiveDb, run, queryOne } = require('../db/connection');
const { parseNotification, learnMerchant, CATEGORY_RULES } = require('../parser/notification');

const router = express.Router();

// ─── POST /api/import/csv ─────────────────────────────────────────────────────
// Body: { rows: [...], account_id, format }
// format: 'hdfc' | 'icici' | 'axis' | 'sbi' | 'generic'
//
// For 'generic', each row must have:
//   { date, description, debit, credit, reference? }

router.post('/csv', async (req, res, next) => {
  try {
    const { rows = [], account_id, format = 'generic' } = req.body;

    if (!account_id)    return res.status(400).json({ error: 'account_id is required' });
    if (!rows.length)   return res.status(400).json({ error: 'rows array is empty' });

    const db      = getActiveDb();
    const results = { inserted: 0, skipped_duplicate: 0, failed: 0, rows: [] };

    for (const row of rows) {
      try {
        const normalised = normaliseRow(row, format);
        if (!normalised) { results.failed++; continue; }

        // Duplicate check: same account + amount + date within 60s
        const existing = queryOne(db, `
          SELECT id FROM transactions
          WHERE account_id = :account_id
            AND amount = :amount
            AND type = :type
            AND ABS(strftime('%s', transacted_at) - strftime('%s', :transacted_at)) < 60
        `, {
          ':account_id':    account_id,
          ':amount':        normalised.amount,
          ':type':          normalised.type,
          ':transacted_at': normalised.transacted_at,
        });

        if (existing) { results.skipped_duplicate++; continue; }

        // Auto-categorise
        let category_id = 'uncategorized';
        if (normalised.description) {
          for (const rule of CATEGORY_RULES) {
            if (rule.pattern.test(normalised.description)) {
              category_id = rule.category;
              break;
            }
          }
        }

        const id = uuidv4();
        run(db, `
          INSERT INTO transactions
            (id, account_id, category_id, amount, type, merchant_raw,
             reference_number, transacted_at, source, needs_review, is_verified)
          VALUES
            (:id, :account_id, :category_id, :amount, :type, :merchant_raw,
             :reference_number, :transacted_at, 'import', :needs_review, 0)
        `, {
          ':id':               id,
          ':account_id':       account_id,
          ':category_id':      category_id,
          ':amount':           normalised.amount,
          ':type':             normalised.type,
          ':merchant_raw':     normalised.description,
          ':reference_number': normalised.reference ?? null,
          ':transacted_at':    normalised.transacted_at,
          ':needs_review':     category_id === 'uncategorized' ? 1 : 0,
        });

        results.inserted++;
        results.rows.push({ id, merchant: normalised.description, amount: normalised.amount, type: normalised.type });

      } catch (rowErr) {
        results.failed++;
      }
    }

    res.json({ data: results });
  } catch (err) {
    next(err);
  }
});

// ─── Row normalisers per bank format ──────────────────────────────────────────

function normaliseRow(row, format) {
  try {
    switch (format) {
      case 'hdfc':    return normaliseHDFC(row);
      case 'icici':   return normaliseICICI(row);
      case 'axis':    return normaliseAxis(row);
      case 'sbi':     return normaliseSBI(row);
      default:        return normaliseGeneric(row);
    }
  } catch {
    return null;
  }
}

// HDFC CSV: Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance
function normaliseHDFC(row) {
  const debit  = parseFloat((row['Withdrawal Amt.'] ?? row.debit ?? '0').replace(/,/g,''));
  const credit = parseFloat((row['Deposit Amt.']    ?? row.credit ?? '0').replace(/,/g,''));
  if (!debit && !credit) return null;

  return {
    transacted_at: parseDate(row['Date'] ?? row.date),
    description:   (row['Narration'] ?? row.description ?? '').trim(),
    amount:        debit > 0 ? debit : credit,
    type:          debit > 0 ? 'debit' : 'credit',
    reference:     row['Chq./Ref.No.'] ?? row.reference ?? null,
  };
}

// ICICI CSV: S No., Value Date, Transaction Date, Cheque Number, Transaction Remarks, Withdrawal Amount (INR ), Deposit Amount (INR ), Balance (INR )
function normaliseICICI(row) {
  const debit  = parseFloat((row['Withdrawal Amount (INR )'] ?? '0').replace(/,/g,''));
  const credit = parseFloat((row['Deposit Amount (INR )']    ?? '0').replace(/,/g,''));
  if (!debit && !credit) return null;

  return {
    transacted_at: parseDate(row['Transaction Date'] ?? row['Value Date']),
    description:   (row['Transaction Remarks'] ?? '').trim(),
    amount:        debit > 0 ? debit : credit,
    type:          debit > 0 ? 'debit' : 'credit',
    reference:     row['Cheque Number'] ?? null,
  };
}

// Axis CSV: Tran Date, CHQNO, PARTICULARS, DR, CR, BAL
function normaliseAxis(row) {
  const debit  = parseFloat((row['DR'] ?? '0').replace(/,/g,''));
  const credit = parseFloat((row['CR'] ?? '0').replace(/,/g,''));
  if (!debit && !credit) return null;

  return {
    transacted_at: parseDate(row['Tran Date']),
    description:   (row['PARTICULARS'] ?? '').trim(),
    amount:        debit > 0 ? debit : credit,
    type:          debit > 0 ? 'debit' : 'credit',
    reference:     row['CHQNO'] ?? null,
  };
}

// SBI CSV: Txn Date, Value Date, Description, Ref No./Cheque No., Debit, Credit, Balance
function normaliseSBI(row) {
  const debit  = parseFloat((row['Debit'] ?? '0').replace(/,/g,''));
  const credit = parseFloat((row['Credit'] ?? '0').replace(/,/g,''));
  if (!debit && !credit) return null;

  return {
    transacted_at: parseDate(row['Txn Date'] ?? row['Value Date']),
    description:   (row['Description'] ?? '').trim(),
    amount:        debit > 0 ? debit : credit,
    type:          debit > 0 ? 'debit' : 'credit',
    reference:     row['Ref No./Cheque No.'] ?? null,
  };
}

// Generic: expects { date, description, debit?, credit?, amount?, type?, reference? }
function normaliseGeneric(row) {
  let amount = parseFloat(String(row.amount ?? '0').replace(/,/g,''));
  let type   = row.type;

  if (!amount) {
    const debit  = parseFloat(String(row.debit  ?? '0').replace(/,/g,''));
    const credit = parseFloat(String(row.credit ?? '0').replace(/,/g,''));
    amount = debit > 0 ? debit : credit;
    type   = debit > 0 ? 'debit' : 'credit';
  }

  if (!amount) return null;

  return {
    transacted_at: parseDate(row.date),
    description:   String(row.description ?? '').trim(),
    amount,
    type:          type ?? 'debit',
    reference:     row.reference ?? null,
  };
}

// ─── Date parser ──────────────────────────────────────────────────────────────

function parseDate(raw) {
  if (!raw) return new Date().toISOString();

  // Try common Indian formats: DD/MM/YYYY, DD-MM-YYYY, DD MMM YYYY
  const cleaned = String(raw).trim();

  const dmy = cleaned.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = y.length === 2 ? '20' + y : y;
    return new Date(`${year}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00`).toISOString();
  }

  const iso = new Date(cleaned);
  return isNaN(iso) ? new Date().toISOString() : iso.toISOString();
}

module.exports = router;
