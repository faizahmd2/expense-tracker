// sw.js — Paisa Service Worker v2
// Offline-first: caches app shell, queues API writes, parses notifications locally.

const CACHE   = 'paisa-v2';
const SHELL   = ['/', '/index.html', '/app.js', '/style.css', '/manifest.json'];

// ─── Install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

// ─── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ─── Fetch strategy ───────────────────────────────────────────────────────────

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API: network-first, never cache
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      })
    ));
    return;
  }

  // App shell: cache-first, fall back to network
  e.respondWith(
    caches.match(e.request).then(cached => cached ?? fetch(e.request))
  );
});

// ─── Push notification handler ────────────────────────────────────────────────
// If the server sends a raw push (e.g., background sync from Mac),
// parse it locally and show the enriched notification.

self.addEventListener('push', e => {
  if (!e.data) return;

  let payload;
  try { payload = e.data.json(); } catch { return; }

  // If already parsed by server, show directly
  if (payload.title && payload.body) {
    e.waitUntil(
      self.registration.showNotification(payload.title, {
        body:    payload.body,
        icon:    '/icon-192.png',
        badge:   '/icon-192.png',
        tag:     payload.transaction_id ?? 'paisa',
        data:    payload,
        vibrate: [100, 50, 100],
      })
    );
    return;
  }

  // Try local parse
  const rawText = payload.raw_notification ?? payload.body ?? '';
  const parsed  = parseNotificationLocally(rawText);

  const sign      = parsed?.type === 'credit' ? '+' : '−';
  const amtStr    = parsed?.amount ? `${sign}₹${formatAmountSW(parsed.amount)}` : '';
  const merchant  = parsed?.merchant_raw ?? 'Unknown';

  e.waitUntil(
    self.registration.showNotification(
      amtStr ? `${amtStr} · ${merchant}` : 'New transaction',
      {
        body:    parsed ? `Tap to review` : rawText.slice(0, 80),
        icon:    '/icon-192.png',
        badge:   '/icon-192.png',
        tag:     'paisa-notif',
        data:    { raw: rawText, parsed },
        vibrate: [100, 50, 100],
      }
    )
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cls => {
      // If app is open, focus it
      const open = cls.find(c => c.url.includes(self.location.origin));
      if (open) return open.focus();
      // Otherwise open it
      return clients.openWindow('/');
    })
  );
});

// ─── Background sync ──────────────────────────────────────────────────────────
// When network comes back, wake up all open clients so they can flush their queue

self.addEventListener('sync', e => {
  if (e.tag === 'paisa-sync') {
    e.waitUntil(
      clients.matchAll({ type: 'window' }).then(cls => {
        cls.forEach(c => c.postMessage({ type: 'SYNC_NOW' }));
      })
    );
  }
});

// ─── Local notification parser (mirrors server/parser/notification.js) ────────

const SW_BANK_RULES = [
  { p: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:debited|deducted|withdrawn)\s+(?:from|in)[^.]*?(?:to\s+([A-Za-z0-9 .&'-]+?))?(?:\s*UPI|Ref|Avl|$)/i,   t: 'debit'  },
  { p: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:credited|received)\s+(?:to|in)[^.]*?(?:from\s+([A-Za-z0-9 .&'-]+?))?(?:\s*UPI|Ref|Avl|$)/i,            t: 'credit' },
  { p: /(?:You paid|Paid)\s+(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+to\s+([A-Za-z0-9 .&@'-]+?)(?:\s+using|\s+via|$)/i,                                    t: 'debit'  },
  { p: /(?:You received|Received)\s+(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+from\s+([A-Za-z0-9 .&@'-]+?)(?:\s+on|$)/i,                                     t: 'credit' },
  { p: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:paid|sent|debited)\s+(?:to|for|towards)\s+([A-Za-z0-9 .&@'-]+?)(?:\s+via|\s+Ref|$)/i,                  t: 'debit'  },
];

const SW_CAT_RULES = [
  { p: /swiggy|zomato|domino|pizza|burger|restaurant|cafe|food/i, c: 'food' },
  { p: /bigbasket|blinkit|zepto|dmart|grocer|supermarket/i,        c: 'groceries' },
  { p: /uber|ola|rapido|metro|petrol|fuel|cab|taxi/i,               c: 'transport' },
  { p: /amazon|flipkart|myntra|ajio|meesho|nykaa/i,                 c: 'shopping' },
  { p: /netflix|spotify|hotstar|disney|bookmyshow/i,                c: 'entertainment' },
  { p: /salary|payroll|stipend/i,                                   c: 'salary' },
  { p: /refund|cashback|reversal/i,                                 c: 'refund' },
];

function parseNotificationLocally(rawText) {
  if (!rawText) return null;

  for (const rule of SW_BANK_RULES) {
    const m = rawText.match(rule.p);
    if (!m) continue;

    const amount = parseFloat((m[1] ?? '0').replace(/,/g, ''));
    if (!amount) continue;

    const merchantRaw = (m[2] ?? '').replace(/\s+/g, ' ').trim() || null;
    let categoryId = rule.t === 'credit' ? 'other-income' : 'uncategorized';

    if (merchantRaw) {
      for (const cr of SW_CAT_RULES) {
        if (cr.p.test(merchantRaw)) { categoryId = cr.c; break; }
      }
    }

    return { type: rule.t, amount, merchant_raw: merchantRaw, category_id: categoryId };
  }

  return null;
}

function formatAmountSW(n) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}