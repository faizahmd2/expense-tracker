/* ─────────────────────────────────────────────────────────────────────────────
   app.js — Paisa PWA
   Single-file client app. No framework, no build step.
   Runs on iPhone (via WKWebView / Safari) and Mac browser identically.

   Architecture:
     State      → plain JS object, mutated by actions
     API        → fetch wrapper with offline queue fallback
     Offline    → IndexedDB queue, flushed on reconnect
     Render     → direct DOM, event delegation, no vdom
───────────────────────────────────────────────────────────────────────────── */

'use strict';

// ─── Config ──────────────────────────────────────────────────────────────────

const API_BASE    = '';          // Same-origin. iOS WKWebView also hits same host.
const STORE_KEY   = 'paisa_queue';
const SECRET_KEY  = 'paisa_secret';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  view:           'transactions',
  period:         'month',
  accountFilter:  '',
  searchQuery:    '',
  transactions:   [],
  categories:     [],
  accounts:       [],
  summary:        { debit: 0, credit: 0, net: 0 },
  reviewCount:    0,
  isOnline:       navigator.onLine,
  isSyncing:      false,
  lastSyncedAt:   localStorage.getItem('last_synced_at') ?? '1970-01-01T00:00:00.000Z',
  editingTxn:     null,   // transaction being edited in sheet
  catPickerTarget: null,  // callback waiting for category pick
  offlineQueue:   [],     // pending ops when offline
  secret:         localStorage.getItem(SECRET_KEY) ?? '',
};

// ─── API client ──────────────────────────────────────────────────────────────

const api = {
  async request(method, path, body = null) {
    const token = localStorage.getItem(SECRET_KEY) ?? '';

    if (!token) {
      logout("Not authenticated");
      return;
    }

    const opts = {
      method,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
    };
    if (body) opts.body = JSON.stringify(body);

    try {
      const res = await fetch(path, opts);

      if (res.status === 401 || res.status === 403) {
        logout("Session expired or invalid token");
        return;
      }

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      return await res.json();

    } catch (err) {
      console.error("❌ API ERROR:", err);

      throw err;  // let callers handle; offline fallbacks kick in
    }
  },

  get:    (path)        => api.request('GET',    path),
  post:   (path, body)  => api.request('POST',   path, body),
  patch:  (path, body)  => api.request('PATCH',  path, body),
  delete: (path)        => api.request('DELETE', path),
};

// ─── Offline queue (IndexedDB) ────────────────────────────────────────────────

const queue = (() => {
  let db = null;

  async function open() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('paisa_offline', 1);
      req.onupgradeneeded = e => {
        e.target.result.createObjectStore('ops', { keyPath: 'op_id' });
        e.target.result.createObjectStore('txns', { keyPath: 'id' });
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function idb(storeName, mode, fn) {
    const d   = await open();
    return new Promise((resolve, reject) => {
      const tx    = d.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      const req   = fn(store);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  return {
    // Pending ops (to sync to Mac)
    async addOp(op) {
      return idb('ops', 'readwrite', s => s.put(op));
    },
    async allOps() {
      return new Promise(async (resolve, reject) => {
        const d   = await open();
        const tx  = d.transaction('ops', 'readonly');
        const req = tx.objectStore('ops').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    },
    async clearOp(opId) {
      return idb('ops', 'readwrite', s => s.delete(opId));
    },

    // Local transaction cache (read while offline)
    async putTxn(txn) {
      return idb('txns', 'readwrite', s => s.put(txn));
    },
    async allTxns() {
      return new Promise(async (resolve, reject) => {
        const d   = await open();
        const tx  = d.transaction('txns', 'readonly');
        const req = tx.objectStore('txns').getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
    },
    async deleteTxn(id) {
      return idb('txns', 'readwrite', s => s.delete(id));
    },
  };
})();

// ─── Offline-aware actions ────────────────────────────────────────────────────
// These try the API; if offline, queue locally and apply optimistically.

const actions = {

  async loadTransactions() {
    const { from, to } = periodRange(state.period);
    const params = new URLSearchParams({ from, to, limit: 200 });
    if (state.accountFilter) params.set('account_id', state.accountFilter);
    if (state.searchQuery)   params.set('search', state.searchQuery);

    try {
      const res = await api.get(`/api/transactions?${params}`);
      state.transactions = res.data;

      // Cache locally
      for (const t of res.data) await queue.putTxn(t);

      computeSummary();
      renderTransactionList();
    } catch {
      // Offline — use cached
      const cached = await queue.allTxns();
      state.transactions = cached.sort((a, b) => b.transacted_at.localeCompare(a.transacted_at));
      computeSummary();
      renderTransactionList();
      showToast('Showing cached data', 'info');
    }
  },

  async loadCategories() {
    try {
      const res = await api.get('/api/categories');
      state.categories = res.data;
      localStorage.setItem('paisa_categories', JSON.stringify(res.data));
    } catch {
      const cached = localStorage.getItem('paisa_categories');
      if (cached) state.categories = JSON.parse(cached);
    }
  },

  async loadAccounts() {
    try {
      const res = await api.get('/api/accounts');
      state.accounts = res.data;
      localStorage.setItem('paisa_accounts', JSON.stringify(res.data));
      renderAccountFilter();
    } catch {
      const cached = localStorage.getItem('paisa_accounts');
      if (cached) { state.accounts = JSON.parse(cached); renderAccountFilter(); }
    }
  },

  async createTransaction(data) {
    const tempId = 'local_' + Date.now();
    const optimistic = { ...data, id: tempId, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), is_verified: 1, needs_review: 0, tags: data.tags ?? [] };

    // Optimistic insert
    state.transactions.unshift(optimistic);
    await queue.putTxn(optimistic);
    computeSummary();
    renderTransactionList();

    if (!state.isOnline) {
      await queue.addOp({ op_id: 'op_' + tempId, entity: 'transaction', entity_id: tempId, op_type: 'INSERT', payload: JSON.stringify(optimistic), changed_at: new Date().toISOString() });
      updateSyncBadge(true);
      showToast('Saved offline — will sync later');
      return optimistic;
    }

    try {
      const res = await api.post('/api/transactions', data);
      // Replace optimistic with real
      const idx = state.transactions.findIndex(t => t.id === tempId);
      if (idx !== -1) state.transactions[idx] = res.data;
      await queue.putTxn(res.data);
      await queue.deleteTxn(tempId);
      computeSummary();
      renderTransactionList();
      showToast('Transaction saved', 'success');
      return res.data;
    } catch (err) {
      showToast(err.message, 'error');
      return optimistic;
    }
  },

  async updateTransaction(id, updates) {
    // Optimistic update
    const idx = state.transactions.findIndex(t => t.id === id);
    if (idx !== -1) {
      state.transactions[idx] = { ...state.transactions[idx], ...updates, updated_at: new Date().toISOString() };
      await queue.putTxn(state.transactions[idx]);
    }
    computeSummary();
    renderTransactionList();

    if (!state.isOnline) {
      await queue.addOp({ op_id: 'op_upd_' + id + '_' + Date.now(), entity: 'transaction', entity_id: id, op_type: 'UPDATE', payload: JSON.stringify({ id, ...updates }), changed_at: new Date().toISOString() });
      updateSyncBadge(true);
      showToast('Saved offline — will sync later');
      return;
    }

    // Learn merchant locally whenever category changes
    const existing = state.transactions.find(t => t.id === id);
    if (updates.category_id && existing?.merchant_raw &&
        updates.category_id !== existing.category_id) {
      learnMerchantLocally(existing.merchant_raw, updates.category_id);
    }

    try {
      const res = await api.patch(`/api/transactions/${id}`, updates);
      const i = state.transactions.findIndex(t => t.id === id);
      if (i !== -1) { state.transactions[i] = res.data; await queue.putTxn(res.data); }
      computeSummary();
      renderTransactionList();
      showToast('Updated', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async deleteTransaction(id) {
    state.transactions = state.transactions.filter(t => t.id !== id);
    await queue.deleteTxn(id);
    computeSummary();
    renderTransactionList();

    if (!state.isOnline) {
      await queue.addOp({ op_id: 'op_del_' + id, entity: 'transaction', entity_id: id, op_type: 'DELETE', payload: JSON.stringify({ id }), changed_at: new Date().toISOString() });
      updateSyncBadge(true);
      return;
    }

    try {
      await api.delete(`/api/transactions/${id}`);
      showToast('Deleted', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async syncToMac() {
    if (!state.isOnline || state.isSyncing) return;

    const ops = await queue.allOps();
    if (!ops.length) return;

    state.isSyncing = true;
    updateSyncBadge(true);

    try {
      const res = await api.post('/api/sync/push', {
        last_synced_at: state.lastSyncedAt,
        ops,
      });

      // Apply server changes
      for (const serverTxn of (res.server_changes ?? [])) {
        const idx = state.transactions.findIndex(t => t.id === serverTxn.id);
        if (idx !== -1) state.transactions[idx] = serverTxn;
        else state.transactions.push(serverTxn);
        await queue.putTxn(serverTxn);
      }

      // Clear synced ops
      for (const op of ops) await queue.clearOp(op.op_id);

      state.lastSyncedAt = res.server_time ?? new Date().toISOString();
      localStorage.setItem('last_synced_at', state.lastSyncedAt);

      updateSyncBadge(false);
      computeSummary();
      renderTransactionList();
    } catch (err) {
      console.warn('[sync] Failed:', err.message);
    } finally {
      state.isSyncing = false;
    }
  },
};

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderTransactionList() {
  const container = document.getElementById('txn-list');
  if (!container) return;

  if (!state.transactions.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📭</div>
        <h3>No transactions</h3>
        <p>Tap the + button to add one,<br>or wait for a notification to come in.</p>
      </div>`;
    renderReviewBanner([]);
    return;
  }

  const reviewItems = state.transactions.filter(t => t.needs_review);
  state.reviewCount = reviewItems.length;
  document.getElementById('review-count')?.classList.toggle('hidden', !reviewItems.length);
  if (!document.getElementById('review-count')?.classList.contains('hidden')) {
    document.getElementById('review-count').textContent = reviewItems.length;
  }

  renderReviewBanner(reviewItems);

  // Group by date
  const groups = {};
  for (const txn of state.transactions) {
    const date = txn.transacted_at?.slice(0, 10) ?? 'Unknown';
    if (!groups[date]) groups[date] = [];
    groups[date].push(txn);
  }

  const html = Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, txns], groupIdx) => `
      <div class="txn-date-header">${formatDateHeader(date)}</div>
      ${txns.map((t, i) => renderTxnRow(t, groupIdx * 100 + i)).join('')}
    `).join('');

  container.innerHTML = html;
}

function renderReviewBanner(reviewItems) {
  const existing = document.querySelector('.review-section');
  if (existing) existing.remove();

  if (!reviewItems.length) return;

  const banner = document.createElement('div');
  banner.className = 'review-section';
  banner.innerHTML = `
    <div class="review-section-title">
      ⚠ ${reviewItems.length} transaction${reviewItems.length > 1 ? 's' : ''} need review
    </div>
    ${reviewItems.map(t => renderTxnRow(t, 0, true)).join('')}
  `;
  document.getElementById('txn-list').before(banner);
}

function renderTxnRow(t, idx = 0, compact = false) {
  const cat    = state.categories.find(c => c.id === t.category_id);
  const icon   = cat?.icon ?? '💰';
  const color  = cat?.color ?? '#6B7280';
  const catName = cat?.name ?? 'Uncategorized';
  const amount  = formatAmount(t.amount);
  const sign    = t.type === 'credit' ? '+' : t.type === 'transfer' ? '↔' : '−';
  const time    = t.transacted_at ? formatTime(t.transacted_at) : '';

  return `
    <div class="txn-row${t.needs_review ? ' needs-review' : ''}"
         data-id="${t.id}"
         style="animation-delay:${idx * 25}ms">
      <div class="txn-icon" style="background:${color}22;">${icon}</div>
      <div class="txn-main">
        <div class="txn-merchant">${escHtml(t.merchant_raw ?? 'Unknown')}</div>
        <div class="txn-meta">
          <span class="txn-cat-chip"
                data-cat-for="${t.id}"
                style="border-left: 2px solid ${color};">${icon} ${escHtml(catName)}</span>
          ${time ? `<span>${time}</span>` : ''}
        </div>
        ${t.note ? `<div class="txn-note">${escHtml(t.note)}</div>` : ''}
      </div>
      <div class="txn-amount-col">
        <span class="txn-amount ${t.type}">${sign}${amount}</span>
        ${t.needs_review ? '<div class="txn-review-dot" title="Needs review"></div>' : ''}
      </div>
    </div>
  `;
}

function renderAccountFilter() {
  const sel = document.getElementById('account-filter');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">All accounts</option>' +
    state.accounts.map(a => `<option value="${a.id}"${a.id === current ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('');
}

function renderCategoryList() {
  const container = document.getElementById('category-list');
  if (!container) return;
  container.innerHTML = state.categories.map(c => `
    <div class="cat-row" data-cat-id="${c.id}">
      <div class="cat-icon-badge">${c.icon}</div>
      <div class="cat-info">
        <div class="cat-name">${escHtml(c.name)}</div>
        <div class="cat-count">${c.transaction_count ?? 0} transactions</div>
      </div>
      <span class="cat-arrow">›</span>
    </div>
  `).join('');
}

function renderDashboard() {
  const container = document.getElementById('dash-grid');
  if (!container) return;

  const { debit, credit } = state.summary;

  // Category breakdown (expense only)
  const byCat = {};
  for (const t of state.transactions) {
    if (t.type !== 'debit' || t.is_excluded) continue;
    if (!byCat[t.category_id]) byCat[t.category_id] = 0;
    byCat[t.category_id] += t.amount;
  }
  const catEntries = Object.entries(byCat)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);
  const maxCat = catEntries[0]?.[1] ?? 1;

  const catBars = catEntries.map(([catId, total]) => {
    const cat   = state.categories.find(c => c.id === catId);
    const pct   = Math.round((total / maxCat) * 100);
    return `
      <div class="cat-bar-row">
        <div class="cat-bar-label">
          <span class="cat-bar-name">${cat?.icon ?? '?'} ${escHtml(cat?.name ?? catId)}</span>
          <span class="cat-bar-amount">${formatAmount(total)}</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${pct}%; background:${cat?.color ?? 'var(--accent)'}"></div>
        </div>
      </div>
    `;
  }).join('');

  // Transaction count stats
  const txnCount  = state.transactions.filter(t => t.type === 'debit').length;
  const avgSpend  = txnCount ? (debit / txnCount) : 0;
  const net       = credit - debit;
  const netColor  = net >= 0 ? 'up' : 'down';

  container.innerHTML = `
    <div class="dash-card">
      <div class="dash-card-title">Period overview</div>
      <div class="stat-row">
        <div class="stat-item">
          <div class="stat-label">Spent</div>
          <div class="stat-num down">₹${formatAmount(debit)}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Received</div>
          <div class="stat-num up">₹${formatAmount(credit)}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Net</div>
          <div class="stat-num ${netColor}">₹${formatAmount(Math.abs(net))}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">Avg / txn</div>
          <div class="stat-num">₹${formatAmount(avgSpend)}</div>
        </div>
      </div>
    </div>

    ${catBars ? `
    <div class="dash-card">
      <div class="dash-card-title">Spending by category</div>
      <div class="cat-bar-list">${catBars}</div>
    </div>
    ` : ''}

    <div class="dash-card">
      <div class="dash-card-title">Accounts</div>
      ${state.accounts.map(a => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);">
          <span style="font-size:0.9rem;font-weight:600;">${escHtml(a.name)}</span>
          <span style="font-family:var(--font-mono);font-size:0.88rem;color:${(a.net_balance ?? 0) >= 0 ? 'var(--credit)' : 'var(--debit)'}">
            ${(a.net_balance ?? 0) >= 0 ? '+' : ''}₹${formatAmount(Math.abs(a.net_balance ?? 0))}
          </span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderSettings() {
  const container = document.getElementById('settings-content');
  if (!container) return;

  const ops = state.offlineQueue.length;
  const syncStatusClass = !state.isOnline ? 'offline' : state.isSyncing ? 'syncing' : 'online';
  const syncStatusText  = !state.isOnline ? 'Offline' : state.isSyncing ? 'Syncing…' : 'Connected';

  container.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Sync</div>
      <div style="margin-bottom:10px;">
        <div class="sync-status">
          <div class="sync-dot ${syncStatusClass}"></div>
          ${syncStatusText}
          ${ops > 0 ? `<span style="margin-left:auto;font-size:0.75rem;color:var(--warning)">${ops} pending</span>` : ''}
        </div>
      </div>
      <div class="settings-row" id="btn-sync-now">
        <div class="settings-row-info">
          <div class="settings-row-label">Sync now</div>
          <div class="settings-row-sub">Last synced: ${formatLastSync(state.lastSyncedAt)}</div>
        </div>
        <span class="settings-row-right">↑↓</span>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Authentication</div>
      <div class="settings-row">
        <div class="settings-row-info">
          <div class="settings-row-label">API Secret</div>
          <div class="settings-row-sub">${state.secret ? '●●●●●●●●' : 'Not set'}</div>
        </div>
        <button class="btn-ghost" id="btn-set-secret">Edit</button>
      </div>
    </div>

    <div class="settings-section">
      <div class="settings-section-title">Accounts</div>
      ${state.accounts.map(a => `
        <div class="settings-row" data-account-id="${a.id}">
          <div class="settings-row-info">
            <div class="settings-row-label">${escHtml(a.name)}</div>
            <div class="settings-row-sub">${a.bank ?? a.type}</div>
          </div>
          <span class="settings-row-right">›</span>
        </div>
      `).join('')}
      <div class="settings-row" id="btn-add-account">
        <div class="settings-row-info">
          <div class="settings-row-label" style="color:var(--accent)">+ Add account</div>
        </div>
      </div>
    </div>

    <div style="padding:16px 0;text-align:center;">
      <div style="font-size:0.72rem;color:var(--text-3);letter-spacing:0.05em;">PAISA · LOCAL FIRST</div>
    </div>
  `;

  document.getElementById('btn-sync-now')?.addEventListener('click', () => actions.syncToMac());
  document.getElementById('btn-set-secret')?.addEventListener('click', setSecretDialog);
}

// ─── Transaction sheet ────────────────────────────────────────────────────────

function openTxnSheet(txn = null) {
  state.editingTxn = txn;

  const isEdit = !!txn;
  const defaults = {
    type:           txn?.type        ?? 'debit',
    amount:         txn?.amount      ?? '',
    merchant_raw:   txn?.merchant_raw ?? '',
    category_id:    txn?.category_id ?? 'uncategorized',
    account_id:     txn?.account_id  ?? (state.accounts[0]?.id ?? ''),
    note:           txn?.note        ?? '',
    reference_number: txn?.reference_number ?? '',
    transacted_at:  txn?.transacted_at ? txn.transacted_at.slice(0, 16) : localDatetimeNow(),
    is_excluded:    txn?.is_excluded ?? false,
  };

  document.getElementById('sheet-title').textContent = isEdit ? 'Edit Transaction' : 'New Transaction';

  const cat = state.categories.find(c => c.id === defaults.category_id);

  document.getElementById('sheet-body').innerHTML = `
    <div class="txn-form">

      <div class="type-toggle">
        <button class="type-btn${defaults.type === 'debit'    ? ' active' : ''}" data-type="debit">Debit</button>
        <button class="type-btn${defaults.type === 'credit'   ? ' active' : ''}" data-type="credit">Credit</button>
        <button class="type-btn${defaults.type === 'transfer' ? ' active' : ''}" data-type="transfer">Transfer</button>
      </div>

      <div class="amount-row">
        <span class="amount-currency">₹</span>
        <input class="amount-input" id="f-amount" type="number" inputmode="decimal"
               placeholder="0.00" value="${defaults.amount}" step="0.01" min="0.01" />
      </div>

      <div class="field">
        <label>Category</label>
        <button class="cat-field-btn" id="f-cat-btn">
          <span class="cat-field-icon" id="f-cat-icon">${cat?.icon ?? '💰'}</span>
          <span class="cat-field-name" id="f-cat-name">${cat?.name ?? 'Uncategorized'}</span>
          <span class="cat-field-arrow">›</span>
        </button>
        <input type="hidden" id="f-category" value="${defaults.category_id}" />
      </div>

      <div class="field">
        <label>Merchant / Description</label>
        <input id="f-merchant" type="text" placeholder="e.g. Swiggy" value="${escHtml(defaults.merchant_raw)}" />
      </div>

      <div class="field-row-2">
        <div class="field">
          <label>Account</label>
          <select id="f-account">
            ${state.accounts.map(a => `<option value="${a.id}"${a.id === defaults.account_id ? ' selected' : ''}>${escHtml(a.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Date &amp; Time</label>
          <input id="f-datetime" type="datetime-local" value="${defaults.transacted_at}" />
        </div>
      </div>

      <div class="field">
        <label>Note</label>
        <textarea id="f-note" placeholder="What was this for?">${escHtml(defaults.note)}</textarea>
      </div>

      <div class="field">
        <label>Reference / UTR</label>
        <input id="f-ref" type="text" placeholder="Optional" value="${escHtml(defaults.reference_number)}" />
      </div>

      <div class="toggle-row">
        <span class="toggle-label">Exclude from totals</span>
        <label class="toggle">
          <input type="checkbox" id="f-excluded" ${defaults.is_excluded ? 'checked' : ''} />
          <span class="toggle-slider"></span>
        </label>
      </div>

      <button class="btn-submit" id="btn-txn-submit">
        ${isEdit ? 'Save Changes' : 'Add Transaction'}
      </button>

      ${isEdit ? `<button class="btn-delete" id="btn-txn-delete">Delete Transaction</button>` : ''}

    </div>
  `;

  // Type toggle
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Category picker trigger
  document.getElementById('f-cat-btn')?.addEventListener('click', () => {
    openCatPicker(defaults.category_id, (picked) => {
      document.getElementById('f-category').value = picked.id;
      document.getElementById('f-cat-icon').textContent  = picked.icon;
      document.getElementById('f-cat-name').textContent  = picked.name;
    });
  });

  // Submit
  document.getElementById('btn-txn-submit')?.addEventListener('click', async () => {
    const type      = document.querySelector('.type-btn.active')?.dataset.type ?? 'debit';
    const amount    = parseFloat(document.getElementById('f-amount').value);
    const merchant  = document.getElementById('f-merchant').value.trim();
    const catId     = document.getElementById('f-category').value;
    const accountId = document.getElementById('f-account').value;
    const datetime  = document.getElementById('f-datetime').value;
    const note      = document.getElementById('f-note').value.trim();
    const ref       = document.getElementById('f-ref').value.trim();
    const excluded  = document.getElementById('f-excluded').checked ? 1 : 0;

    if (!amount || amount <= 0) { showToast('Enter a valid amount', 'error'); return; }
    if (!accountId)             { showToast('Select an account', 'error'); return; }

    const payload = {
      type, amount, merchant_raw: merchant || null,
      category_id: catId, account_id: accountId,
      transacted_at: datetime ? new Date(datetime).toISOString() : new Date().toISOString(),
      note: note || null, reference_number: ref || null, is_excluded: excluded,
    };

    document.getElementById('btn-txn-submit').disabled = true;

    if (isEdit) {
      await actions.updateTransaction(txn.id, payload);
    } else {
      await actions.createTransaction(payload);
    }

    closeTxnSheet();
  });

  // Delete
  document.getElementById('btn-txn-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this transaction?')) return;
    await actions.deleteTransaction(txn.id);
    closeTxnSheet();
  });

  openSheet('sheet-txn');
}

function closeTxnSheet() {
  closeSheet('sheet-txn');
  state.editingTxn = null;
}

// ─── Category picker sheet ────────────────────────────────────────────────────

function openCatPicker(currentCatId, onPick) {
  state.catPickerTarget = onPick;

  const grid = document.getElementById('cat-picker-grid');
  const expense = state.categories.filter(c => !c.is_income);
  const income  = state.categories.filter(c =>  c.is_income);

  const renderGroup = (label, cats) => `
    <div style="grid-column:1/-1;padding:8px 0 4px;font-size:0.68rem;font-weight:700;
                text-transform:uppercase;letter-spacing:0.1em;color:var(--text-3);">${label}</div>
    ${cats.map(c => `
      <div class="cat-picker-item${c.id === currentCatId ? ' selected' : ''}" data-cat-id="${c.id}">
        <span class="cat-picker-icon">${c.icon}</span>
        <span class="cat-picker-name">${escHtml(c.name)}</span>
      </div>
    `).join('')}
  `;

  grid.innerHTML = renderGroup('Expenses', expense) + renderGroup('Income', income);

  grid.querySelectorAll('.cat-picker-item').forEach(item => {
    item.addEventListener('click', () => {
      const catId = item.dataset.catId;
      const cat   = state.categories.find(c => c.id === catId);
      if (cat && state.catPickerTarget) state.catPickerTarget(cat);
      closeSheet('sheet-catpicker');
    });
  });

  openSheet('sheet-catpicker');
}

// ─── Sheet open / close ───────────────────────────────────────────────────────

function openSheet(sheetId) {
  document.getElementById('sheet-overlay')?.classList.remove('hidden');
  document.getElementById(sheetId)?.classList.add('open');
  document.getElementById(sheetId)?.removeAttribute('aria-hidden');
}

function closeSheet(sheetId) {
  document.getElementById(sheetId)?.classList.remove('open');
  document.getElementById(sheetId)?.setAttribute('aria-hidden', 'true');

  // Only hide overlay if all sheets are closed
  const anyOpen = document.querySelector('.bottom-sheet.open');
  if (!anyOpen) document.getElementById('sheet-overlay')?.classList.add('hidden');
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${viewName}`)?.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-btn[data-view="${viewName}"]`)?.classList.add('active');

  state.view = viewName;

  switch (viewName) {
    case 'transactions': actions.loadTransactions(); break;
    case 'dashboard':    renderDashboard(); break;
    case 'categories':   renderCategoryList(); break;
    case 'settings':     renderSettings(); break;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeSummary() {
  let debit = 0, credit = 0;
  for (const t of state.transactions) {
    if (t.is_excluded || t.type === 'transfer') continue;
    if (t.type === 'debit')  debit  += t.amount;
    if (t.type === 'credit') credit += t.amount;
  }
  state.summary = { debit, credit, net: credit - debit };

  const fmt = v => `₹${formatAmount(v)}`;
  const netEl = document.getElementById('sum-net');
  document.getElementById('sum-debit').textContent  = fmt(debit);
  document.getElementById('sum-credit').textContent = fmt(credit);
  if (netEl) {
    const net = credit - debit;
    netEl.textContent = fmt(Math.abs(net));
    netEl.className   = `summary-value ${net >= 0 ? 'credit' : 'debit'}`;
  }
}

function updateSyncBadge(show) {
  document.getElementById('sync-badge')?.classList.toggle('hidden', !show);
}

function periodRange(period) {
  const now  = new Date();
  const from = new Date(now);
  switch (period) {
    case 'week':    from.setDate(now.getDate() - 7);  break;
    case 'month':   from.setDate(1);                  break;
    case '3months': from.setMonth(now.getMonth() - 3); break;
    case 'year':    from.setMonth(0); from.setDate(1); break;
    default:        from.setDate(1);
  }
  from.setHours(0, 0, 0, 0);
  return { from: from.toISOString(), to: now.toISOString() };
}

function formatAmount(n) {
  if (!n && n !== 0) return '0';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDateHeader(dateStr) {
  if (!dateStr || dateStr === 'Unknown') return 'Unknown date';
  const d    = new Date(dateStr + 'T00:00:00');
  const now  = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatLastSync(iso) {
  if (!iso || iso === '1970-01-01T00:00:00.000Z') return 'Never';
  const d    = new Date(iso);
  const diff = Date.now() - d;
  if (diff < 60000)   return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function localDatetimeNow() {
  const now    = new Date();
  const offset = now.getTimezoneOffset();
  const local  = new Date(now.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  const toast     = document.createElement('div');
  toast.className = `toast${type ? ' ' + type : ''}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function setSecretDialog() {
  const action = prompt("Enter API secret OR type 'logout' to clear:");

  if (!action) return;

  if (action.toLowerCase() === 'logout') {
    localStorage.removeItem('paisa_secret');
    state.secret = '';
    alert('Logged out');
    location.reload();
    return;
  }

  localStorage.setItem('paisa_secret', action);
  state.secret = action;
  alert('Secret updated');
}

function logout(reason = "Session expired") {
  console.warn("🚪 Logging out:", reason);

  localStorage.removeItem('paisa_secret');

  alert(reason);

  // Hard reset app
  location.reload();
}

// ─── Event wiring ─────────────────────────────────────────────────────────────

function initEvents() {

  // Bottom nav
  document.getElementById('bottom-nav').addEventListener('click', e => {
    const btn = e.target.closest('.nav-btn');
    if (btn?.dataset.view) switchView(btn.dataset.view);
  });

  // FAB — open add sheet
  document.getElementById('btn-quick-add').addEventListener('click', () => openTxnSheet());

  // Overlay click → close top sheet
  document.getElementById('sheet-overlay').addEventListener('click', () => {
    const catOpen = document.getElementById('sheet-catpicker').classList.contains('open');
    if (catOpen) { closeSheet('sheet-catpicker'); return; }
    closeTxnSheet();
  });

  // Sheet close buttons
  document.getElementById('btn-sheet-close').addEventListener('click', closeTxnSheet);
  document.getElementById('btn-catpicker-close').addEventListener('click', () => closeSheet('sheet-catpicker'));

  // Transaction list — delegate clicks
  document.getElementById('txn-list').addEventListener('click', e => {
    // Category chip → quick category change
    const catChip = e.target.closest('.txn-cat-chip');
    if (catChip) {
      e.stopPropagation();
      const txnId  = catChip.dataset.catFor;
      const txn    = state.transactions.find(t => t.id === txnId);
      if (txn) {
        openCatPicker(txn.category_id, async (cat) => {
          await actions.updateTransaction(txnId, { category_id: cat.id });
        });
      }
      return;
    }

    // Row click → open edit sheet
    const row = e.target.closest('.txn-row');
    if (row) {
      const txn = state.transactions.find(t => t.id === row.dataset.id);
      if (txn) openTxnSheet(txn);
    }
  });

  // Review banner delegate
  document.querySelector('#view-transactions').addEventListener('click', e => {
    const row = e.target.closest('.review-section .txn-row');
    if (row) {
      const txn = state.transactions.find(t => t.id === row.dataset.id);
      if (txn) openTxnSheet(txn);
    }
  });

  // Period chips
  document.getElementById('period-chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.period = chip.dataset.period;
    actions.loadTransactions();
  });

  // Account filter
  document.getElementById('account-filter').addEventListener('change', e => {
    state.accountFilter = e.target.value;
    actions.loadTransactions();
  });

  // Search toggle
  document.getElementById('btn-search-toggle').addEventListener('click', () => {
    const bar = document.getElementById('search-bar');
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) document.getElementById('search-input').focus();
  });

  document.getElementById('btn-search-close').addEventListener('click', () => {
    document.getElementById('search-bar').classList.add('hidden');
    state.searchQuery = '';
    actions.loadTransactions();
  });

  let searchTimer;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.searchQuery = e.target.value.trim();
      actions.loadTransactions();
    }, 300);
  });

  // Review button
  document.getElementById('btn-review').addEventListener('click', () => {
    const reviewItems = state.transactions.filter(t => t.needs_review);
    if (reviewItems[0]) openTxnSheet(reviewItems[0]);
  });

  // Add category button
  document.getElementById('btn-add-category').addEventListener('click', () => {
    const name = prompt('Category name:');
    if (!name?.trim()) return;
    const icon  = prompt('Icon (emoji):', '💰') || '💰';
    const color = prompt('Color (hex):', '#6B7280') || '#6B7280';
    api.post('/api/categories', { name: name.trim(), icon, color }).then(() => {
      actions.loadCategories().then(renderCategoryList);
    }).catch(e => showToast(e.message, 'error'));
  });

  // Theme toggle
  document.getElementById('btn-theme')?.addEventListener('click', toggleTheme);

  // Online / offline events
  window.addEventListener('online',  () => {
    state.isOnline = true;
    updateSyncBadge(false);
    updateConnPill();
    actions.syncToMac();
  });
  window.addEventListener('offline', () => {
    state.isOnline = false;
    updateSyncBadge(true);
    updateConnPill();
  });

  // Swipe down to close sheet
  let touchStartY = 0;
  document.querySelectorAll('.bottom-sheet').forEach(sheet => {
    sheet.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener('touchmove',  e => {
      const delta = e.touches[0].clientY - touchStartY;
      if (delta > 60) {
        const catOpen = document.getElementById('sheet-catpicker').classList.contains('open');
        if (catOpen) closeSheet('sheet-catpicker');
        else closeTxnSheet();
      }
    }, { passive: true });
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

// ─── Theme ────────────────────────────────────────────────────────────────────

const THEME_KEY = 'paisa_theme';

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) ?? 'dark';
  applyTheme(saved);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') ?? 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ─── Connection status ────────────────────────────────────────────────────────
// Three states: 'mac' (server reachable), 'local' (offline, using IndexedDB),
// 'offline' (no network at all)

const connState = { mode: 'local' };   // start pessimistic

async function checkMacReachable() {
  if (!state.secret) return false;
  try {
    const res = await fetch('/health', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${state.secret}` },
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function updateConnPill() {
  const pill = document.getElementById('conn-pill');
  if (!pill) return;
  if (!navigator.onLine) {
    connState.mode = 'offline';
    pill.className = 'conn-pill offline';
    pill.innerHTML = '<span class="conn-pill-dot"></span>Offline';
  } else {
    const reachable = await checkMacReachable();
    if (reachable) {
      connState.mode = 'mac';
      pill.className = 'conn-pill';
      pill.innerHTML = '<span class="conn-pill-dot"></span>Mac';
    } else {
      connState.mode = 'local';
      pill.className = 'conn-pill local';
      pill.innerHTML = '<span class="conn-pill-dot"></span>Local';
    }
  }
}

// ─── Client-side notification parser ─────────────────────────────────────────
// Mirror of server/parser/notification.js — runs entirely in-browser.
// Used when Mac is not reachable but iOS extension has queued raw notifications.

const CLIENT_BANK_RULES = [
  { p: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:debited|deducted|withdrawn)\s+(?:from|in)[^.]*?(?:to\s+([A-Za-z0-9 .&'-]+?))?(?:\s*UPI|Ref|Avl|$)/i,   t: 'debit'  },
  { p: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:credited|received)\s+(?:to|in)[^.]*?(?:from\s+([A-Za-z0-9 .&'-]+?))?(?:\s*UPI|Ref|Avl|$)/i,            t: 'credit' },
  { p: /(?:You paid|Paid)\s+(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+to\s+([A-Za-z0-9 .&@'-]+?)(?:\s+using|\s+via|$)/i,                                    t: 'debit'  },
  { p: /(?:You received|Received)\s+(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+from\s+([A-Za-z0-9 .&@'-]+?)(?:\s+on|$)/i,                                     t: 'credit' },
  { p: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:paid|sent|debited)\s+(?:to|for|towards)\s+([A-Za-z0-9 .&@'-]+?)(?:\s+via|\s+Ref|$)/i,                  t: 'debit'  },
  { p: /(?:Rs\.?|INR|₹)\s*([\d,]+(?:\.\d{2})?)\s+(?:debited|paid)\s+(?:to|at)\s+([A-Za-z0-9 .&@'-]+?)(?:\s+TID|\s+on|$)/i,                                 t: 'debit'  },
];

const CLIENT_CAT_RULES = [
  { p: /swiggy|zomato|domino|pizza|burger|mcdonald|kfc|restaurant|cafe|food|bakery/i,    c: 'food' },
  { p: /bigbasket|blinkit|zepto|dmart|grocer|supermarket|jiomart/i,                       c: 'groceries' },
  { p: /uber|ola|rapido|metro|petrol|fuel|cab|taxi|auto|irctc|redbus/i,                   c: 'transport' },
  { p: /makemytrip|goibibo|ixigo|indigo|spicejet|air india|hotel|oyo/i,                   c: 'travel' },
  { p: /netflix|spotify|hotstar|disney|bookmyshow|pvr|inox/i,                             c: 'entertainment' },
  { p: /amazon|flipkart|myntra|ajio|meesho|nykaa|croma/i,                                 c: 'shopping' },
  { p: /apollo|medplus|1mg|pharmeasy|hospital|clinic|pharmacy|doctor/i,                   c: 'health' },
  { p: /airtel|jio|vodafone|electricity|water bill|gas bill|broadband/i,                  c: 'utilities' },
  { p: /salary|payroll|stipend/i,                                                          c: 'salary' },
  { p: /refund|cashback|reversal/i,                                                        c: 'refund' },
  { p: /rent|maintenance|society/i,                                                        c: 'home' },
];

function parseNotificationLocally(rawText) {
  if (!rawText) return null;

  for (const rule of CLIENT_BANK_RULES) {
    const m = rawText.match(rule.p);
    if (!m) continue;

    const amount = parseFloat((m[1] ?? '0').replace(/,/g, ''));
    if (!amount) continue;

    const merchantRaw = (m[2] ?? '').replace(/\s+/g, ' ').trim() || null;
    let categoryId = merchantRaw ? 'uncategorized' : (rule.t === 'credit' ? 'other-income' : 'uncategorized');
    let needsReview = true;
    let confidence = 0.7;

    if (merchantRaw) {
      for (const cr of CLIENT_CAT_RULES) {
        if (cr.p.test(merchantRaw)) {
          categoryId  = cr.c;
          needsReview = false;
          confidence  = 0.75;
          break;
        }
      }
    }

    // Check merchant map in memory (categories learned by user)
    const learnedMap = JSON.parse(localStorage.getItem('paisa_merchant_map') ?? '{}');
    if (merchantRaw && learnedMap[merchantRaw.toLowerCase()]) {
      categoryId  = learnedMap[merchantRaw.toLowerCase()];
      needsReview = false;
      confidence  = 1.0;
    }

    const refMatch = rawText.match(/(?:Ref(?:erence)?(?:\s*No\.?)?|UTR|TID)[:\s]+([A-Z0-9]+)/i);

    return {
      id:           'local_notif_' + Date.now() + '_' + Math.random().toString(36).slice(2),
      type:         rule.t,
      amount,
      merchant_raw: merchantRaw,
      category_id:  categoryId,
      reference_number: refMatch ? refMatch[1] : null,
      source:       'notification',
      raw_notification: rawText,
      needs_review: needsReview,
      confidence,
      transacted_at: new Date().toISOString(),
      created_at:   new Date().toISOString(),
      updated_at:   new Date().toISOString(),
      is_verified:  0,
      is_excluded:  0,
      tags:         [],
      account_id:   state.accounts[0]?.id ?? 'cash',
    };
  }

  return null;
}

// Learn merchant → category mapping in localStorage (mirrors server merchant map)
function learnMerchantLocally(merchantRaw, categoryId) {
  if (!merchantRaw) return;
  const map = JSON.parse(localStorage.getItem('paisa_merchant_map') ?? '{}');
  map[merchantRaw.toLowerCase()] = categoryId;
  localStorage.setItem('paisa_merchant_map', JSON.stringify(map));
}

// Process any raw notification payloads queued by the Swift extension
// (queued in App Group JSON → injected into localStorage by ContentView.swift)
async function processQueuedRawNotifications() {
  const raw = localStorage.getItem('paisa_raw_notif_queue');
  if (!raw) return;

  let notifications;
  try { notifications = JSON.parse(raw); } catch { return; }
  if (!Array.isArray(notifications) || !notifications.length) return;

  let created = 0;
  for (const item of notifications) {
    const text = typeof item === 'string' ? item : item.raw_notification;
    if (!text) continue;

    const parsed = parseNotificationLocally(text);
    if (!parsed) continue;

    // Store locally
    await queue.putTxn(parsed);
    await queue.addOp({
      op_id:      'op_notif_' + parsed.id,
      entity:     'transaction',
      entity_id:  parsed.id,
      op_type:    'INSERT',
      payload:    JSON.stringify(parsed),
      changed_at: parsed.created_at,
    });
    created++;
  }

  // Clear processed queue
  localStorage.removeItem('paisa_raw_notif_queue');

  if (created > 0) {
    showToast(`📱 ${created} notification${created > 1 ? 's' : ''} parsed locally`, 'info');
    updateSyncBadge(true);
    await actions.loadTransactions();
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Apply saved theme immediately (before paint)
  initTheme();

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Check if secret is set; if not, prompt on first load
  if (!state.secret) {
    setTimeout(() => {
      const s = prompt('Enter your API secret to connect:\n(Find it in your secrets.env file)');
      if (s) { state.secret = s.trim(); localStorage.setItem(SECRET_KEY, state.secret); }
      bootData();
    }, 500);
  } else {
    await bootData();
  }

  initEvents();

  // Periodically check Mac reachability (every 30s)
  setInterval(updateConnPill, 30_000);
}

async function bootData() {
  // Check Mac reachability first
  updateConnPill();  // async, non-blocking

  await Promise.all([
    actions.loadCategories(),
    actions.loadAccounts(),
  ]);
  renderAccountFilter();
  await actions.loadTransactions();

  // Process any raw notifications queued by iOS extension
  await processQueuedRawNotifications();

  // Check for pending offline ops
  const ops = await queue.allOps();
  if (ops.length > 0) {
    updateSyncBadge(true);
    if (state.isOnline) actions.syncToMac();
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);