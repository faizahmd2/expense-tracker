'use strict';

/**
 * parser/notification.js
 *
 * Parses raw Indian bank / UPI notification text into structured transactions.
 *
 * Strategy (in order of preference):
 *   1. Rule-based regex  — fast, zero network, handles 90% of cases
 *   2. Merchant map      — learned from past transactions in SQLite
 *   3. LLM fallback      — Anthropic API for ambiguous notifications
 *   4. Needs-review flag — if confidence still low, flag for user
 */

const { getActiveDb, query, queryOne } = require('../db/connection');

// ─── Bank notification patterns ───────────────────────────────────────────────

/**
 * Each rule produces: { type, amount, merchant, account_hint, reference }
 * type: 'debit' | 'credit' | 'transfer'
 */
const BANK_RULES = [

  // ── HDFC ──────────────────────────────────────────────────────────────────
  {
    bank: 'HDFC',
    pattern: /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{2})?)\s+(?:debited|deducted)\s+(?:from|in)\s+(?:A\/c\s+)?(?:\*+(\d+))?\s*(?:on\s+\S+)?\s*(?:to\s+([A-Za-z0-9 .&'-]+?))?(?:\s*UPI|Ref|\.)/i,
    extract: (m) => ({ type: 'debit', amount: parseAmount(m[1]), account_hint: m[2], merchant: cleanMerchant(m[3]) }),
  },
  {
    bank: 'HDFC',
    pattern: /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{2})?)\s+(?:credited|received)\s+(?:to|in)\s+(?:A\/c\s+)?(?:\*+(\d+))?\s*(?:on\s+\S+)?\s*(?:from\s+([A-Za-z0-9 .&'-]+?))?(?:\s*UPI|Ref|\.)/i,
    extract: (m) => ({ type: 'credit', amount: parseAmount(m[1]), account_hint: m[2], merchant: cleanMerchant(m[3]) }),
  },

  // ── ICICI ─────────────────────────────────────────────────────────────────
  {
    bank: 'ICICI',
    pattern: /ICICI Bank Acct\s+\w*(\d{4})\s+(?:debited|credited)\s+(?:with\s+)?(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{2})?)\s+(?:on|at)\s+\S+\s+(?:to|from|by)\s+([A-Za-z0-9 .&@'-]+?)(?:\s+on|\s+Ref|\.)/i,
    extract: (m) => ({
      type: m[0].toLowerCase().includes('debit') ? 'debit' : 'credit',
      account_hint: m[1], amount: parseAmount(m[2]), merchant: cleanMerchant(m[3]),
    }),
  },

  // ── SBI ───────────────────────────────────────────────────────────────────
  {
    bank: 'SBI',
    pattern: /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{2})?)\s+(?:debited|withdrawn)\s+(?:from|in)\s+(?:a\/c\s+)?(?:\w*(\d{4}))?\s*(?:on\s+\S+)?\s*(?:to\s+([A-Za-z0-9 .&'-]+?))?(?:\s*Ref|UPI|Avl|\.)/i,
    extract: (m) => ({ type: 'debit', amount: parseAmount(m[1]), account_hint: m[2], merchant: cleanMerchant(m[3]) }),
  },
  {
    bank: 'SBI',
    pattern: /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{2})?)\s+credited\s+(?:to|in)\s+(?:a\/c\s+)?(?:\w*(\d{4}))?\s*(?:on\s+\S+)?\s*(?:from\s+([A-Za-z0-9 .&'-]+?))?(?:\s*Ref|UPI|Avl|\.)/i,
    extract: (m) => ({ type: 'credit', amount: parseAmount(m[1]), account_hint: m[2], merchant: cleanMerchant(m[3]) }),
  },

  // ── Axis ──────────────────────────────────────────────────────────────────
  {
    bank: 'Axis',
    pattern: /(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{2})?)\s+(?:has been\s+)?(?:debited|deducted)\s+from\s+(?:your\s+)?(?:Axis\s+)?(?:Bank\s+)?(?:[Aa]\/[Cc]\s+)?(?:\w*(\d{4}))?\s*(?:on|at)\s+\S+\s+(?:to|towards)\s+([A-Za-z0-9 .&'-]+?)(?:\s+Ref|UPI|\.)/i,
    extract: (m) => ({ type: 'debit', amount: parseAmount(m[1]), account_hint: m[2], merchant: cleanMerchant(m[3]) }),
  },

  // ── PhonePe ───────────────────────────────────────────────────────────────
  {
    bank: 'PhonePe',
    pattern: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:paid|sent|debited)\s+(?:to|for)\s+([A-Za-z0-9 .&@'-]+?)(?:\s+via|\s+on|\s+Ref|$)/i,
    extract: (m) => ({ type: 'debit', amount: parseAmount(m[1]), merchant: cleanMerchant(m[2]) }),
  },
  {
    bank: 'PhonePe',
    pattern: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+received\s+from\s+([A-Za-z0-9 .&@'-]+?)(?:\s+via|\s+on|\s+Ref|$)/i,
    extract: (m) => ({ type: 'credit', amount: parseAmount(m[1]), merchant: cleanMerchant(m[2]) }),
  },

  // ── Google Pay ────────────────────────────────────────────────────────────
  {
    bank: 'GPay',
    pattern: /(?:You paid|Paid)\s+(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+to\s+([A-Za-z0-9 .&@'-]+?)(?:\s+using|\s+via|\s+on|$)/i,
    extract: (m) => ({ type: 'debit', amount: parseAmount(m[1]), merchant: cleanMerchant(m[2]) }),
  },
  {
    bank: 'GPay',
    pattern: /(?:You received|Received)\s+(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+from\s+([A-Za-z0-9 .&@'-]+?)(?:\s+on|$)/i,
    extract: (m) => ({ type: 'credit', amount: parseAmount(m[1]), merchant: cleanMerchant(m[2]) }),
  },

  // ── Paytm ─────────────────────────────────────────────────────────────────
  {
    bank: 'Paytm',
    pattern: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:paid|debited)\s+(?:to|for|at)\s+([A-Za-z0-9 .&@'-]+?)(?:\s+TID|\s+on|$)/i,
    extract: (m) => ({ type: 'debit', amount: parseAmount(m[1]), merchant: cleanMerchant(m[2]) }),
  },

  // ── Generic UPI fallback ──────────────────────────────────────────────────
  {
    bank: 'UPI',
    pattern: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:debited|paid|sent)\s+(?:to|towards|for)?\s+([A-Za-z0-9 .&@'-]+?)(?:\s+UPI|\s+Ref|\s+on|\.|$)/i,
    extract: (m) => ({ type: 'debit', amount: parseAmount(m[1]), merchant: cleanMerchant(m[2]) }),
  },
  {
    bank: 'UPI',
    pattern: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:credited|received)\s+(?:from)?\s+([A-Za-z0-9 .&@'-]+?)(?:\s+UPI|\s+Ref|\s+on|\.|$)/i,
    extract: (m) => ({ type: 'credit', amount: parseAmount(m[1]), merchant: cleanMerchant(m[2]) }),
  },
];

// Reference number extraction (UTR, Ref, TID)
const REFERENCE_PATTERN = /(?:Ref(?:erence)?(?:\s*No\.?)?|UTR|TID)[:\s]+([A-Z0-9]+)/i;

// ─── Category rules (keyword → category_id) ──────────────────────────────────
// Applied to the normalized merchant name. Order matters — first match wins.

const CATEGORY_RULES = [
  // Food & Dining
  { pattern: /swiggy|zomato|domino|pizza|burger|mcdonald|kfc|subway|biryani|restaurant|cafe|diner|eatery|food|snack|bakery|haldiram|barbeque|bbq/i, category: 'food' },
  // Groceries
  { pattern: /bigbasket|grofers|blinkit|zepto|dunzo|dmart|reliance fresh|more supermarket|spencers|natures basket|licious|milkbasket|jiomart|grocer|supermarket/i, category: 'groceries' },
  // Transport
  { pattern: /uber|ola|rapido|namma yatri|blablacar|redbus|irctc|makemytrip.*bus|metro|bmtc|best bus|rickshaw|auto|cab|taxi|petrol|fuel|hp petrol|indian oil|bharat petrol/i, category: 'transport' },
  // Travel
  { pattern: /makemytrip|goibibo|yatra|ixigo|airtel.*flight|indigo|spicejet|air india|vistara|akasa|hotel|oyo|treebo|fabhotel|airbnb|cleartrip|booking\.com/i, category: 'travel' },
  // Entertainment
  { pattern: /netflix|amazon prime|hotstar|disney|zee5|sonyliv|bookmyshow|pvr|inox|moviemax|spotify|gaana|jio saavn|youtube premium|apple tv|gaming/i, category: 'entertainment' },
  // Shopping
  { pattern: /amazon|flipkart|myntra|ajio|meesho|snapdeal|nykaa|tata cliq|croma|vijay sales|reliance digital|ikea|pepperfry|urban ladder|shopify|shopclues/i, category: 'shopping' },
  // Health
  { pattern: /apollo|medplus|netmeds|1mg|pharmeasy|healthkart|thyrocare|lal path|dr lal|hospital|clinic|pharmacy|medical|doctor|diagnostic|pathlab/i, category: 'health' },
  // Utilities & Bills
  { pattern: /airtel|jio|vodafone|vi |bsnl|act fiber|you broadband|tata play|dish tv|d2h|electricity|bescom|msedcl|tneb|tata power|adani electric|water bill|gas bill|lpg|indane|bharat gas|hp gas/i, category: 'utilities' },
  // Education
  { pattern: /unacademy|byju|vedantu|coursera|udemy|upgrad|simplilearn|school|college|university|tuition|coaching/i, category: 'education' },
  // Personal Care
  { pattern: /salon|spa|parlour|nykaa.*beauty|sugar cosmetic|lakme|mamaearth|wow skin|plum|personal care|grooming/i, category: 'personal' },
  // Home & Rent
  { pattern: /rent|nobroker|housing\.com|99acres|magicbricks|pg payment|maintenance|society|apartment|maid|cook|house help/i, category: 'home' },
  // Investments
  { pattern: /zerodha|groww|upstox|angel broking|sharekhan|motilal|hdfc securities|icicidirect|mutual fund|sip|nps|ppf|fd|fixed deposit/i, category: 'investment' },
  // Transfer signals
  { pattern: /transfer|neft|rtgs|imps|upi.*self|own account/i, category: 'transfer' },
  // Salary / Income
  { pattern: /salary|payroll|stipend|wage/i, category: 'salary' },
  // Refunds
  { pattern: /refund|cashback|reversal|chargeback/i, category: 'refund' },
];

// ─── Main parse function ───────────────────────────────────────────────────────

/**
 * Parse a raw notification string into a structured transaction draft.
 *
 * @param {string} rawText
 * @returns {Promise<ParseResult>}
 *
 * @typedef {object} ParseResult
 * @property {boolean} success
 * @property {'debit'|'credit'|'transfer'|null} type
 * @property {number|null}  amount
 * @property {string|null}  merchant        - normalized merchant name
 * @property {string|null}  merchant_raw    - original as seen in notification
 * @property {string|null}  account_hint    - last 4 digits of account
 * @property {string|null}  reference       - UTR / Ref number
 * @property {string|null}  category_id     - best guess
 * @property {number}       confidence      - 0.0–1.0
 * @property {boolean}      needs_review    - true if confidence < threshold
 * @property {string}       parse_method    - 'rule'|'merchant_map'|'llm'|'failed'
 */
async function parseNotification(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return failedResult();
  }

  const text = rawText.trim();

  // ── Step 1: Rule-based parsing ────────────────────────────────────────────
  const ruleResult = applyRules(text);

  if (ruleResult.success) {
    // ── Step 2: Enrich category from merchant map or keyword rules ──────────
    const enriched = await enrichCategory(ruleResult);
    return enriched;
  }

  // ── Step 3: LLM fallback ──────────────────────────────────────────────────
  if (process.env.ANTHROPIC_API_KEY && process.env.LLM_FALLBACK_ENABLED === 'true') {
    const llmResult = await parsWithLLM(text);
    if (llmResult.success) return llmResult;
  }

  // ── Step 4: Give up, flag for manual review ───────────────────────────────
  return { ...failedResult(), needs_review: true };
}

// ─── Rule-based parser ────────────────────────────────────────────────────────

function applyRules(text) {
  for (const rule of BANK_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;

    const extracted = rule.extract(match);
    if (!extracted.amount || extracted.amount <= 0) continue;

    const refMatch = text.match(REFERENCE_PATTERN);

    return {
      success:      true,
      type:         extracted.type,
      amount:       extracted.amount,
      merchant:     extracted.merchant ?? null,
      merchant_raw: extracted.merchant ?? null,
      account_hint: extracted.account_hint ?? null,
      reference:    refMatch ? refMatch[1] : null,
      category_id:  null,     // filled by enrichCategory
      confidence:   0.85,
      needs_review: false,
      parse_method: 'rule',
    };
  }

  return { success: false };
}

// ─── Category enrichment ──────────────────────────────────────────────────────

/**
 * Try to assign category_id using (in order):
 *   1. Merchant map table (learned from user's past transactions)
 *   2. Keyword rules above
 *   3. Type-based fallback (credit → other-income, debit → uncategorized)
 */
async function enrichCategory(result) {
  const db = getActiveDb();

  // 1. Check merchant map
  if (result.merchant) {
    const saved = queryOne(db,
      `SELECT category_id, confidence
       FROM merchants
       WHERE raw_name = :raw_name`,
      { ':raw_name': result.merchant_raw }
    );

    if (saved?.category_id) {
      return {
        ...result,
        category_id:  saved.category_id,
        confidence:   Math.min(result.confidence, saved.confidence),
        parse_method: 'merchant_map',
      };
    }
  }

  // 2. Keyword rules
  if (result.merchant) {
    for (const rule of CATEGORY_RULES) {
      if (rule.pattern.test(result.merchant)) {
        return {
          ...result,
          category_id:  rule.category,
          confidence:   0.75,
          parse_method: 'rule',
        };
      }
    }
  }

  // 3. Type fallback
  const fallbackCategory = result.type === 'credit' ? 'other-income' : 'uncategorized';
  return {
    ...result,
    category_id:  fallbackCategory,
    confidence:   0.4,
    needs_review: true,
    parse_method: 'rule',
  };
}

// ─── LLM fallback ─────────────────────────────────────────────────────────────

async function parsWithLLM(rawText) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: `You parse Indian bank SMS/notification text into JSON.
Return ONLY a JSON object with these fields:
  type: "debit" | "credit" | "transfer"
  amount: number (in INR, no commas)
  merchant: string or null
  reference: string or null
  category: one of: food, groceries, transport, travel, entertainment, shopping, health, utilities, education, personal, home, investment, transfer, salary, refund, other-income, uncategorized

Return null for unknown fields. No explanation, no markdown.`,
        messages: [{ role: 'user', content: rawText }],
      }),
    });

    const data  = await response.json();
    const text  = data.content?.[0]?.text?.trim();
    if (!text) return { success: false };

    const parsed = JSON.parse(text);

    return {
      success:      true,
      type:         parsed.type         ?? null,
      amount:       typeof parsed.amount === 'number' ? parsed.amount : null,
      merchant:     parsed.merchant     ?? null,
      merchant_raw: parsed.merchant     ?? null,
      account_hint: null,
      reference:    parsed.reference    ?? null,
      category_id:  parsed.category     ?? 'uncategorized',
      confidence:   0.70,
      needs_review: false,
      parse_method: 'llm',
    };
  } catch {
    return { success: false };
  }
}

// ─── Merchant learning ────────────────────────────────────────────────────────

/**
 * After a user confirms or changes a transaction's category,
 * call this to update the merchant map so future notifications
 * for the same merchant get the right category automatically.
 *
 * @param {string} rawMerchantName
 * @param {string} normalizedName
 * @param {string} categoryId
 * @param {'manual'|'rule'|'llm'|'aa'} source
 */
function learnMerchant(rawMerchantName, normalizedName, categoryId, source = 'manual') {
  if (!rawMerchantName) return;

  const db = getActiveDb();
  const { v4: uuidv4 } = require('uuid');

  db.run(`
    INSERT INTO merchants (id, raw_name, normalized_name, category_id, confidence, source, occurrence_count, last_seen_at)
    VALUES (:id, :raw_name, :normalized_name, :category_id, :confidence, :source, 1, datetime('now'))
    ON CONFLICT(raw_name) DO UPDATE SET
      normalized_name  = excluded.normalized_name,
      category_id      = excluded.category_id,
      confidence       = CASE WHEN excluded.source = 'manual' THEN 1.0 ELSE confidence END,
      source           = excluded.source,
      occurrence_count = occurrence_count + 1,
      last_seen_at     = datetime('now'),
      updated_at       = datetime('now')
  `, {
    ':id':              uuidv4(),
    ':raw_name':        rawMerchantName,
    ':normalized_name': normalizedName,
    ':category_id':     categoryId,
    ':confidence':      source === 'manual' ? 1.0 : 0.75,
    ':source':          source,
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseAmount(str) {
  if (!str) return null;
  const n = parseFloat(str.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function cleanMerchant(str) {
  if (!str) return null;
  return str
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s.&@'-]/g, '')
    .trim() || null;
}

function failedResult() {
  return {
    success:      false,
    type:         null,
    amount:       null,
    merchant:     null,
    merchant_raw: null,
    account_hint: null,
    reference:    null,
    category_id:  null,
    confidence:   0,
    needs_review: true,
    parse_method: 'failed',
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  parseNotification,
  learnMerchant,
  CATEGORY_RULES,
};
