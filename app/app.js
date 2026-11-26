// QMAT Trips — iPhone / Web PWA sharing the exact QMAT Trips Google Sheets & Drive schema

const WEB_CLIENT_ID = '501018021150-m3g9dmh9nr98buj9muq4ao7aru89jto9.apps.googleusercontent.com';
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
  'profile'
].join(' ');

const STORAGE_KEY = 'qmat_trips_pwa_state_v1';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';

const PRESET_CORE = [
  { personId: 'p_donald', displayName: 'Donald', groupType: 'Core', linkedPartnerOf: '', active: true },
  { personId: 'p_eric', displayName: 'Eric', groupType: 'Core', linkedPartnerOf: '', active: true },
  { personId: 'p_ivan', displayName: 'Ivan', groupType: 'Core', linkedPartnerOf: '', active: true },
  { personId: 'p_andrew', displayName: 'Andrew', groupType: 'Core', linkedPartnerOf: '', active: true },
  { personId: 'p_jeff', displayName: 'Jeff', groupType: 'Core', linkedPartnerOf: '', active: true }
];
const PRESET_PARTNERS = [
  { personId: 'p_lauryn', displayName: 'Lauryn', groupType: 'Partner', linkedPartnerOf: '', active: true },
  { personId: 'p_anna', displayName: 'Anna', groupType: 'Partner', linkedPartnerOf: '', active: true },
  { personId: 'p_ana', displayName: 'Ana', groupType: 'Partner', linkedPartnerOf: '', active: true }
];
const ALL_PRESETS = [...PRESET_CORE, ...PRESET_PARTNERS];
const CATEGORIES = ['Food', 'Flights', 'Lodging', 'Transit', 'Activities', 'Drinks', 'Other'];
const VIDEO_EXTS = new Set(['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp', 'wmv', 'flv', 'mpeg', 'mpg']);
const ALLOWED_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

const state = {
  session: { email: '', displayName: '', accessToken: '', expiresAt: 0 },
  spreadsheetId: '',
  spreadsheetUrl: '',
  selectedIdentity: 'Donald',
  trips: [],
  workspaces: {},
  activeTripId: null,
  activeTab: 'expenses',
  agendaMode: 'daily',
  selectedAgendaDate: null,
  selectedPersonDraft: null,
  photoDayFilter: 'ALL',
  coupleView: false,
  syncStatus: 'idle', // idle | syncing | synced | error
  syncError: '',
  dismissedInstallBanner: false
};

let tokenClient = null;
let pendingTokenResolve = null;
let pendingTokenReject = null;

function loadStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.session) state.session = saved.session;
    if (saved.spreadsheetId) state.spreadsheetId = saved.spreadsheetId;
    if (saved.spreadsheetUrl) state.spreadsheetUrl = saved.spreadsheetUrl;
    if (saved.selectedIdentity) state.selectedIdentity = saved.selectedIdentity;
    if (saved.dismissedInstallBanner) state.dismissedInstallBanner = true;
  } catch (_) {}
}

function saveStored() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    session: state.session,
    spreadsheetId: state.spreadsheetId,
    spreadsheetUrl: state.spreadsheetUrl,
    selectedIdentity: state.selectedIdentity,
    dismissedInstallBanner: state.dismissedInstallBanner
  }));
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 3800);
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkifyHtml(text) {
  const safe = esc(text);
  return safe.replace(/(https?:\/\/[^\s<]+)/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  ).replace(/\n/g, '<br>');
}

function roundCents(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function formatMoney(amount, currency = 'USD') {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount || 0);
  } catch {
    return `${currency} ${(amount || 0).toFixed(2)}`;
  }
}

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function isStandaloneIos() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function isIosSafariBrowser() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) && !isStandaloneIos();
}

// --- Google OAuth via Google Identity Services ---
function ensureGsiClient() {
  if (tokenClient) return tokenClient;
  if (!window.google?.accounts?.oauth2) {
    throw new Error('Google Sign-In script is still loading. Try again in a moment.');
  }
  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: WEB_CLIENT_ID,
    scope: SCOPES,
    callback: async (resp) => {
      if (resp.error) {
        pendingTokenReject?.(new Error(resp.error_description || resp.error));
        pendingTokenResolve = pendingTokenReject = null;
        return;
      }
      const expiresAt = Date.now() + ((Number(resp.expires_in) || 3500) - 60) * 1000;
      state.session.accessToken = resp.access_token;
      state.session.expiresAt = expiresAt;
      try {
        const uResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${resp.access_token}` }
        });
        if (uResp.ok) {
          const info = await uResp.json();
          state.session.email = info.email || state.session.email || 'signed-in@google';
          state.session.displayName = info.name || info.email?.split('@')[0] || 'QMAT Member';
          const first = state.session.displayName.split(' ')[0].toLowerCase();
          const match = ALL_PRESETS.find((p) => p.displayName.toLowerCase() === first);
          if (match && (!state.selectedIdentity || state.selectedIdentity === 'Donald')) {
            state.selectedIdentity = match.displayName;
          }
        }
      } catch (_) {}
      saveStored();
      pendingTokenResolve?.(resp.access_token);
      pendingTokenResolve = pendingTokenReject = null;
    }
  });
  return tokenClient;
}

function signInWithGoogle(promptType = 'select_account') {
  return new Promise((resolve, reject) => {
    try {
      const client = ensureGsiClient();
      pendingTokenResolve = resolve;
      pendingTokenReject = reject;
      client.requestAccessToken({ prompt: promptType });
    } catch (err) {
      reject(err);
    }
  });
}

async function getValidToken() {
  if (state.session.accessToken && Date.now() < state.session.expiresAt) {
    return state.session.accessToken;
  }
  throw new Error('AUTH_EXPIRED');
}

async function apiFetch(url, options = {}) {
  const token = await getValidToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    state.session.accessToken = '';
    state.session.expiresAt = 0;
    saveStored();
    throw new Error('Google session expired. Tap Refresh Sign-In.');
  }
  if (!res.ok) {
    let msg = `API error (${res.status})`;
    try {
      const errJson = await res.json();
      if (errJson?.error?.message) msg = errJson.error.message;
    } catch (_) {}
    if (res.status === 403) msg = 'No edit permission on this Google Sheet. Ask Donald for Editor access.';
    throw new Error(msg);
  }
  return res.json();
}

// --- Sheets & Drive API Helpers ---
async function createSpreadsheet(title, tabTitles) {
  return apiFetch(SHEETS_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      properties: { title },
      sheets: tabTitles.map((t) => ({ properties: { title: t } }))
    })
  });
}

async function getSheetMap(spreadsheetId) {
  const data = await apiFetch(`${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`);
  const map = {};
  (data.sheets || []).forEach((s) => {
    map[s.properties.title] = s.properties.sheetId;
  });
  return map;
}

async function ensureTabsExist(spreadsheetId, requiredTabs) {
  const current = await getSheetMap(spreadsheetId);
  const missing = requiredTabs.filter((t) => !(t in current));
  if (missing.length === 0) return current;
  await apiFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: missing.map((title) => ({ addSheet: { properties: { title } } }))
    })
  });
  return getSheetMap(spreadsheetId);
}

async function getValues(spreadsheetId, rangeA1, valueRenderOption = 'UNFORMATTED_VALUE') {
  const encoded = encodeURIComponent(rangeA1);
  const data = await apiFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encoded}?valueRenderOption=${valueRenderOption}`);
  return (data.values || []).map((row) => row.map((c) => (c == null ? '' : String(c))));
}

async function updateValues(spreadsheetId, rangeA1, values) {
  const encoded = encodeURIComponent(rangeA1);
  return apiFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encoded}?valueInputOption=USER_ENTERED`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ range: rangeA1, majorDimension: 'ROWS', values })
  });
}

async function appendValues(spreadsheetId, rangeA1, values) {
  const encoded = encodeURIComponent(rangeA1);
  return apiFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encoded}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values })
  });
}

async function clearRange(spreadsheetId, rangeA1) {
  const encoded = encodeURIComponent(rangeA1);
  return apiFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${encoded}:clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
}

async function deleteRow(spreadsheetId, sheetId, oneBasedRow) {
  return apiFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: oneBasedRow - 1, endIndex: oneBasedRow }
        }
      }]
    })
  });
}

async function ensureDriveFolder(name, parentId = null) {
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and name='${name.replace(/'/g, "\\'")}'${parentId ? ` and '${parentId}' in parents` : ''}`;
  const res = await apiFetch(`${DRIVE_BASE}?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=5`);
  if (res.files?.length) return res.files[0].id;
  const created = await apiFetch(`${DRIVE_BASE}?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {})
    })
  });
  return created.id;
}

async function uploadImageToDrive(folderId, fileName, mimeType, fileOrBlob) {
  const token = await getValidToken();
  const metadata = new Blob([JSON.stringify({ name: fileName, parents: [folderId] })], { type: 'application/json' });
  const form = new FormData();
  form.append('metadata', metadata);
  form.append('file', fileOrBlob, fileName);

  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  if (!res.ok) throw new Error(`Drive upload failed (${res.status})`);
  const { id } = await res.json();

  await fetch(`${DRIVE_BASE}/${id}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  }).catch(() => {});

  return { fileId: id, imageUrl: `https://drive.google.com/uc?export=view&id=${id}` };
}

async function uploadToTripOrPersonalFolder(preferredFolderId, tripName, fileName, mimeType, fileBlob) {
  if (preferredFolderId) {
    try {
      return await uploadImageToDrive(preferredFolderId, fileName, mimeType, fileBlob);
    } catch (_) {}
  }
  const root = await ensureDriveFolder('QMAT Trips Photos');
  const tripFolder = await ensureDriveFolder(tripName, root);
  return uploadImageToDrive(tripFolder, fileName, mimeType, fileBlob);
}

// --- Schema & Ledger Engine (matches Android SheetSchemaBuilder + LedgerEngine) ---
function columnLetter(zeroIdx) {
  let idx = zeroIdx;
  let s = '';
  while (idx >= 0) {
    s = String.fromCharCode(65 + (idx % 26)) + s;
    idx = Math.floor(idx / 26) - 1;
  }
  return s;
}

function toTripCode(tripName, tripId) {
  const cleaned = tripName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'Trip';
  return `${cleaned}_${tripId.slice(-4) || '01'}`;
}

function extractSpreadsheetId(input) {
  const t = (input || '').trim();
  const m = t.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9-_]{20,}$/.test(t) ? t : null;
}

function enumerateDays(startDate, endDate) {
  if (!startDate) return [];
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate || startDate}T00:00:00`);
  if (isNaN(start.getTime())) return [startDate];
  const out = [];
  const cur = new Date(start);
  let guard = 0;
  while (cur <= end && guard < 180) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return out.length ? out : [startDate];
}

function selectAutoDate(startDate, endDate) {
  const days = enumerateDays(startDate, endDate);
  if (!days.length) return { date: startDate, phase: 'UPCOMING' };
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (todayStr < days[0]) return { date: days[0], phase: 'UPCOMING' };
  if (todayStr > days[days.length - 1]) return { date: days[0], phase: 'COMPLETED' };
  const idx = days.indexOf(todayStr);
  return { date: idx >= 0 ? days[idx] : days[0], phase: 'ACTIVE' };
}

function formatShortDate(iso) {
  const parts = (iso || '').split('-');
  if (parts.length !== 3) return iso;
  return `${Number(parts[1])}/${Number(parts[2])}`;
}

function latestFxRate(history, code, baseCurrency) {
  if ((code || '').toUpperCase() === (baseCurrency || 'USD').toUpperCase()) return 1.0;
  const matches = history.filter((r) => r.currencyCode.toUpperCase() === code.toUpperCase());
  if (!matches.length) return 1.0;
  matches.sort((a, b) => a.effectiveTimestamp.localeCompare(b.effectiveTimestamp));
  return matches[matches.length - 1].rateToBase;
}

function computeSplitAllocations(baseAmount, splitMode, beneficiaryIds, customValues = {}) {
  if (!beneficiaryIds.length) throw new Error('Select at least one person.');
  const totalCents = Math.round(baseAmount * 100);
  const alloc = {};

  if (splitMode === 'EQUAL') {
    const k = beneficiaryIds.length;
    const each = Math.floor(totalCents / k);
    const rem = totalCents - each * k;
    beneficiaryIds.forEach((pid, i) => {
      alloc[pid] = (i === 0 ? each + rem : each) / 100;
    });
    return alloc;
  }

  if (splitMode === 'DIRECT_PAYMENT') {
    if (beneficiaryIds.length !== 1) throw new Error('Payment must have one recipient.');
    alloc[beneficiaryIds[0]] = totalCents / 100;
    return alloc;
  }

  if (splitMode === 'EXACT_AMOUNTS') {
    let sumCents = 0;
    beneficiaryIds.forEach((pid) => {
      const c = Math.round((Number(customValues[pid]) || 0) * 100);
      alloc[pid] = c / 100;
      sumCents += c;
    });
    const diff = totalCents - sumCents;
    if (Math.abs(diff) > 2) {
      throw new Error(`Exact splits sum to ${(sumCents / 100).toFixed(2)}, expected ${(totalCents / 100).toFixed(2)}.`);
    }
    alloc[beneficiaryIds[0]] = roundCents(alloc[beneficiaryIds[0]] + diff / 100);
    return alloc;
  }

  if (splitMode === 'SHARES') {
    const totalW = beneficiaryIds.reduce((s, pid) => s + Math.max(0, Number(customValues[pid]) || 0), 0);
    if (totalW <= 0) throw new Error('Total shares must be > 0.');
    let sumCents = 0;
    let firstPos = beneficiaryIds[0];
    beneficiaryIds.forEach((pid) => {
      const w = Math.max(0, Number(customValues[pid]) || 0);
      if (w > 0 && (Number(customValues[firstPos]) || 0) <= 0) firstPos = pid;
      const c = Math.floor((totalCents * w) / totalW);
      alloc[pid] = c / 100;
      sumCents += c;
    });
    alloc[firstPos] = roundCents(alloc[firstPos] + (totalCents - sumCents) / 100);
    return alloc;
  }

  if (splitMode === 'PERCENTAGES') {
    const totalPct = beneficiaryIds.reduce((s, pid) => s + (Number(customValues[pid]) || 0), 0);
    if (Math.abs(totalPct - 100) > 0.05) {
      throw new Error(`Percentages sum to ${totalPct.toFixed(1)}%, must equal 100%.`);
    }
    let sumCents = 0;
    let firstPos = beneficiaryIds[0];
    beneficiaryIds.forEach((pid) => {
      const p = Number(customValues[pid]) || 0;
      if (p > 0 && (Number(customValues[firstPos]) || 0) <= 0) firstPos = pid;
      const c = Math.floor((totalCents * p) / 100);
      alloc[pid] = c / 100;
      sumCents += c;
    });
    alloc[firstPos] = roundCents(alloc[firstPos] + (totalCents - sumCents) / 100);
    return alloc;
  }

  return alloc;
}

function resolvePersonId(roster, personId, exactName) {
  if (personId) {
    const m = roster.find((p) => p.personId === personId);
    if (m) return m.personId;
  }
  if (exactName) {
    const exact = roster.find((p) => p.displayName === exactName);
    if (exact) return exact.personId;
    const ci = roster.find((p) => p.displayName.toLowerCase() === exactName.toLowerCase());
    if (ci) return ci.personId;
  }
  return null;
}

function computeBalances(roster, entries) {
  const map = {};
  roster.forEach((p) => {
    map[p.personId] = { person: p, expensePaid: 0, expenseShare: 0, paymentsSent: 0, paymentsReceived: 0, netBalance: 0 };
  });
  entries.forEach((e) => {
    const payerId = resolvePersonId(roster, e.paidByPersonId, e.paidByName);
    if (e.type === 'EXPENSE') {
      if (payerId && map[payerId]) map[payerId].expensePaid += e.baseAmount;
      Object.entries(e.allocationsByPersonId || {}).forEach(([pid, amt]) => {
        if (map[pid]) map[pid].expenseShare += amt;
      });
    } else {
      if (payerId && map[payerId]) map[payerId].paymentsSent += e.baseAmount;
      Object.entries(e.allocationsByPersonId || {}).forEach(([pid, amt]) => {
        if (map[pid]) map[pid].paymentsReceived += amt;
      });
    }
  });
  return roster.map((p) => {
    const b = map[p.personId];
    b.expensePaid = roundCents(b.expensePaid);
    b.expenseShare = roundCents(b.expenseShare);
    b.paymentsSent = roundCents(b.paymentsSent);
    b.paymentsReceived = roundCents(b.paymentsReceived);
    b.netBalance = roundCents(b.expensePaid - b.expenseShare + b.paymentsSent - b.paymentsReceived);
    return b;
  });
}

function computeCoupleBalances(roster, personBalances) {
  const groups = {};
  personBalances.forEach((pb) => {
    const link = (pb.person.linkedPartnerOf || '').trim();
    const target = link ? roster.find((r) => r.personId === link || r.displayName === link) : null;
    const key = target && target.personId !== pb.person.personId ? target.personId : pb.person.personId;
    if (!groups[key]) groups[key] = [];
    groups[key].push(pb);
  });
  return Object.entries(groups).map(([key, members]) => {
    const sorted = [...members].sort((a, b) => (a.person.groupType === 'Core' ? 0 : 1) - (b.person.groupType === 'Core' ? 0 : 1));
    return {
      coupleKey: key,
      displayLabel: sorted.map((m) => m.person.displayName).join(' + '),
      primaryPersonId: sorted[0].person.personId,
      expensePaid: roundCents(members.reduce((s, m) => s + m.expensePaid, 0)),
      expenseShare: roundCents(members.reduce((s, m) => s + m.expenseShare, 0)),
      netBalance: roundCents(members.reduce((s, m) => s + m.netBalance, 0))
    };
  });
}

function simplifyTransfers(nodes) {
  const debtors = nodes.filter((n) => n.net < -0.01).map((n) => ({ ...n, amt: Math.abs(n.net) })).sort((a, b) => b.amt - a.amt);
  const creditors = nodes.filter((n) => n.net > 0.01).map((n) => ({ ...n, amt: n.net })).sort((a, b) => b.amt - a.amt);
  const res = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i], c = creditors[j];
    const pay = roundCents(Math.min(d.amt, c.amt));
    if (pay >= 0.01) {
      res.push({ fromPersonId: d.id, fromName: d.name, toPersonId: c.id, toName: c.name, amount: pay });
    }
    d.amt = roundCents(d.amt - pay);
    c.amt = roundCents(c.amt - pay);
    if (d.amt < 0.01) i++;
    if (c.amt < 0.01) j++;
  }
  return res;
}

function buildExpensesTopBlock(tripName, baseCurrency, roster, settlements = []) {
  const fixedLen = 12;
  const blankFixed = () => Array(fixedLen).fill('');
  const row1 = [`QMAT Trips — ${tripName}`, 'Base Currency', baseCurrency];
  const row2 = blankFixed(); row2[0] = 'Summary';
  const row3 = blankFixed(); row3[0] = `Expense Paid (${baseCurrency})`;
  const row4 = blankFixed(); row4[0] = `Expense Share (${baseCurrency})`;
  const row5 = blankFixed(); row5[0] = `Payments Sent (${baseCurrency})`;
  const row6 = blankFixed(); row6[0] = `Payments Received (${baseCurrency})`;
  const row7 = blankFixed(); row7[0] = `Net Balance (${baseCurrency})`;
  const row8 = blankFixed(); row8[0] = `Total Outflow (${baseCurrency})`;
  const row13 = blankFixed(); row13[0] = 'PersonIDs';
  const row14 = ['EntryID', 'Date', 'Type', 'Title', 'Category', 'PaidBy', 'OriginalAmount', 'Currency', 'FXRateToBase', 'BaseAmount', 'SplitMode', 'Notes'];

  roster.forEach((p, idx) => {
    const col = columnLetter(fixedLen + idx);
    row2.push(p.displayName);
    row3.push(`=SUMIFS($J$15:$J, $C$15:$C, "EXPENSE", $F$15:$F, ${col}$2)`);
    row4.push(`=SUMIFS(${col}$15:${col}, $C$15:$C, "EXPENSE")`);
    row5.push(`=SUMIFS($J$15:$J, $C$15:$C, "PAYMENT", $F$15:$F, ${col}$2)`);
    row6.push(`=SUMIFS(${col}$15:${col}, $C$15:$C, "PAYMENT")`);
    row7.push(`=${col}3-${col}4+${col}5-${col}6`);
    row8.push(`=SUMIF($F$15:$F, ${col}$2, $J$15:$J)`);
    row13.push(p.personId);
    row14.push(p.displayName);
  });

  const rows = [row1, row2, row3, row4, row5, row6, row7, row8];
  rows.push(['Simplified Settlements (Who Owes Who)', 'From', 'To', `Amount (${baseCurrency})`]);
  for (let i = 0; i < 3; i++) {
    const t = settlements[i];
    rows.push(t ? [`Settlement ${i + 1}`, t.fromName, t.toName, t.amount.toFixed(2)] : [i === 0 && !settlements.length ? 'All settled up' : '']);
  }
  rows.push(row13, row14);
  return rows;
}

function buildExpenseSheetRow(entry, roster, rowNum) {
  const base = [
    entry.entryId, entry.date, entry.type, entry.title, entry.category, entry.paidByName,
    entry.originalAmount.toFixed(2), entry.currency, String(entry.fxRateToBase),
    `=G${rowNum}*I${rowNum}`, entry.splitMode, entry.notes || ''
  ];
  const benIds = Object.entries(entry.allocationsByPersonId || {}).filter(([, v]) => v > 0).map(([k]) => k);
  roster.forEach((p) => {
    if (entry.type === 'EXPENSE' && entry.splitMode === 'EQUAL' && benIds.includes(p.personId)) {
      const k = benIds.length;
      if (k === 1) base.push(`=IF(ISNUMBER($J${rowNum}), ROUND($J${rowNum}, 2), 0)`);
      else if (p.personId === benIds[0]) base.push(`=IF(ISNUMBER($J${rowNum}), ROUND($J${rowNum}/${k}, 2) + ($J${rowNum} - ROUND($J${rowNum}/${k}, 2)*${k}), 0)`);
      else base.push(`=IF(ISNUMBER($J${rowNum}), ROUND($J${rowNum}/${k}, 2), 0)`);
    } else {
      base.push(((entry.allocationsByPersonId || {})[p.personId] || 0).toFixed(2));
    }
  });
  return base;
}

function buildSettingsRows(summary, currencies, fxHistory, roster) {
  const rows = [
    ['Key', 'Value'],
    ['TripID', summary.tripId],
    ['TripName', summary.tripName],
    ['Destination', summary.destination],
    ['StartDate', summary.startDate],
    ['EndDate', summary.endDate],
    ['BaseCurrency', summary.baseCurrency],
    ['CoverPhotoUrl', summary.coverPhotoUrl],
    ['ActiveCurrencies', currencies.join(',')],
    ['DriveFolderId', summary.driveFolderId],
    ['Status', summary.status],
    [''],
    ['FX_RATES', 'CurrencyCode', 'RateToBase']
  ];
  fxHistory.forEach((r) => rows.push([r.effectiveTimestamp, r.currencyCode, String(r.rateToBase)]));
  rows.push([''], ['ROSTER', 'DisplayName', 'GroupType', 'LinkedPartnerOf', 'Active']);
  roster.forEach((p) => rows.push([p.personId, p.displayName, p.groupType, p.linkedPartnerOf || '', p.active ? 'TRUE' : 'FALSE']));
  return rows;
}

// --- Data Loaders & Mutators ---
async function connectMasterOrExisting(createNew, urlOrId = '') {
  state.syncStatus = 'syncing';
  render();
  try {
    if (createNew) {
      const created = await createSpreadsheet('QMAT Trips Master', ['Trips_Index']);
      const id = created.spreadsheetId;
      await updateValues(id, "'Trips_Index'!A1:L1", [[
        'TripID', 'TripName', 'Destination', 'StartDate', 'EndDate', 'BaseCurrency',
        'CoverPhotoUrl', 'DriveFolderId', 'ExpensesTabName', 'AgendaTabName', 'SettingsTabName', 'Status'
      ]]);
      state.spreadsheetId = id;
      state.spreadsheetUrl = created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`;
      showToast("Created 'QMAT Trips Master' Google Sheet!");
    } else {
      const id = extractSpreadsheetId(urlOrId);
      if (!id) throw new Error('Paste a valid Google Sheet URL.');
      const tabs = await ensureTabsExist(id, ['Trips_Index']);
      if ('Trips_Index' in tabs) {
        const hdr = await getValues(id, "'Trips_Index'!A1:L1");
        if (!hdr.length) {
          await updateValues(id, "'Trips_Index'!A1:L1", [[
            'TripID', 'TripName', 'Destination', 'StartDate', 'EndDate', 'BaseCurrency',
            'CoverPhotoUrl', 'DriveFolderId', 'ExpensesTabName', 'AgendaTabName', 'SettingsTabName', 'Status'
          ]]);
        }
      }
      state.spreadsheetId = id;
      state.spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${id}/edit`;
      showToast('Connected to shared QMAT Sheet!');
    }
    saveStored();
    await refreshAllTrips();
  } catch (err) {
    state.syncStatus = 'error';
    state.syncError = err.message;
    showToast(err.message);
    render();
  }
}

async function refreshAllTrips() {
  if (!state.spreadsheetId) return;
  state.syncStatus = 'syncing';
  render();
  try {
    const rows = await getValues(state.spreadsheetId, "'Trips_Index'!A2:L200");
    const trips = rows.map((r) => {
      const tripId = (r[0] || '').trim();
      const tripName = (r[1] || '').trim();
      if (!tripId || !tripName) return null;
      const expTab = r[8] || `${toTripCode(tripName, tripId)}_Expenses`;
      return {
        tripId, tripName, destination: r[2] || '', startDate: r[3] || '', endDate: r[4] || '',
        baseCurrency: r[5] || 'USD', coverPhotoUrl: r[6] || '', driveFolderId: r[7] || '',
        expensesTabName: expTab,
        agendaTabName: r[9] || `${toTripCode(tripName, tripId)}_Agenda`,
        settingsTabName: r[10] || `${toTripCode(tripName, tripId)}_Settings`,
        photosTabName: expTab.replace(/_Expenses$/, '') + '_Photos',
        status: (r[11] || 'Active').toLowerCase() === 'archived' ? 'Archived' : 'Active'
      };
    }).filter(Boolean);

    const todayStr = new Date().toISOString().slice(0, 10);
    trips.sort((a, b) => {
      const aAct = a.status === 'Active' && a.endDate >= todayStr ? 1 : 0;
      const bAct = b.status === 'Active' && b.endDate >= todayStr ? 1 : 0;
      if (aAct !== bAct) return bAct - aAct;
      return (a.startDate || '').localeCompare(b.startDate || '');
    });

    const workspaces = {};
    for (const t of trips) {
      try {
        workspaces[t.tripId] = await loadWorkspace(t);
      } catch (_) {}
    }
    state.trips = trips;
    state.workspaces = workspaces;
    state.syncStatus = 'synced';
    state.syncError = '';
  } catch (err) {
    state.syncStatus = 'error';
    state.syncError = err.message;
    showToast(err.message);
  }
  render();
}

async function loadWorkspace(summary) {
  await ensureTabsExist(state.spreadsheetId, [
    summary.settingsTabName, summary.expensesTabName, summary.agendaTabName, summary.photosTabName
  ]);
  const [sRows, eRows, aRows, pRows] = await Promise.all([
    getValues(state.spreadsheetId, `'${summary.settingsTabName}'!A1:F200`),
    getValues(state.spreadsheetId, `'${summary.expensesTabName}'!A1:AZ1000`),
    getValues(state.spreadsheetId, `'${summary.agendaTabName}'!A1:AZ200`),
    getValues(state.spreadsheetId, `'${summary.photosTabName}'!A2:H1000`)
  ]);

  // Parse settings
  const kv = {}, fxRateHistory = [], roster = [];
  let sec = 'META';
  sRows.forEach((row) => {
    const c0 = (row[0] || '').trim();
    if (!c0) return;
    if (c0 === 'Key') { sec = 'META'; return; }
    if (c0 === 'FX_RATES') { sec = 'FX'; return; }
    if (c0 === 'ROSTER') { sec = 'ROSTER'; return; }
    if (sec === 'META') kv[c0] = (row[1] || '').trim();
    if (sec === 'FX' && row[1] && !isNaN(Number(row[2]))) {
      fxRateHistory.push({ effectiveTimestamp: c0, currencyCode: row[1].trim().toUpperCase(), rateToBase: Number(row[2]) });
    }
    if (sec === 'ROSTER' && row[1]) {
      roster.push({
        personId: c0, displayName: row[1].trim(),
        groupType: (row[2] || '').toLowerCase() === 'partner' ? 'Partner' : 'Core',
        linkedPartnerOf: (row[3] || '').trim(),
        active: (row[4] || 'TRUE').toUpperCase() !== 'FALSE'
      });
    }
  });
  const baseCurrency = kv.BaseCurrency || summary.baseCurrency || 'USD';
  const activeCurrencies = (kv.ActiveCurrencies || `${baseCurrency},EUR`).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const updatedSummary = {
    ...summary,
    tripName: kv.TripName || summary.tripName,
    destination: kv.Destination || summary.destination,
    startDate: kv.StartDate || summary.startDate,
    endDate: kv.EndDate || summary.endDate,
    baseCurrency,
    coverPhotoUrl: kv.CoverPhotoUrl || summary.coverPhotoUrl,
    driveFolderId: kv.DriveFolderId || summary.driveFolderId,
    status: kv.Status || summary.status
  };
  const finalRoster = roster.length ? roster : [...PRESET_CORE];

  // Parse expenses
  const expenses = [];
  if (eRows.length >= 15) {
    const idRow = eRows[12] || [], hdrRow = eRows[13] || [];
    const colToPid = {};
    const maxC = Math.max(idRow.length, hdrRow.length);
    for (let c = 12; c < maxC; c++) {
      const pid = (idRow[c] || '').trim();
      const nm = (hdrRow[c] || '').trim();
      const found = finalRoster.find((p) => p.personId === pid) || finalRoster.find((p) => p.displayName === nm);
      if (found) colToPid[c] = found.personId;
    }
    for (let r = 14; r < eRows.length; r++) {
      const row = eRows[r];
      const entryId = (row[0] || '').trim();
      if (!entryId) continue;
      const paidByName = (row[5] || '').trim();
      const orig = Number(row[6]) || 0;
      const fx = Number(row[8]) || 1;
      const base = row[9] !== '' && !isNaN(Number(row[9])) ? Number(row[9]) : roundCents(orig * fx);
      const alloc = {};
      Object.entries(colToPid).forEach(([c, pid]) => {
        const v = Number(row[c]) || 0;
        if (v > 0) alloc[pid] = roundCents(v);
      });
      expenses.push({
        entryId, date: row[1] || '', type: (row[2] || 'EXPENSE').toUpperCase(),
        title: row[3] || '', category: row[4] || 'Other',
        paidByPersonId: resolvePersonId(finalRoster, '', paidByName) || '',
        paidByName, originalAmount: orig, currency: row[7] || baseCurrency,
        fxRateToBase: fx, baseAmount: roundCents(base),
        splitMode: row[10] || 'EQUAL', notes: row[11] || '',
        allocationsByPersonId: alloc, sheetRowNumber: r + 1
      });
    }
  }

  // Parse agenda
  const agendaDays = [];
  if (aRows.length >= 2) {
    const hdr = aRows[0];
    const linksIdx = hdr.indexOf('LinksAndNotes');
    for (let r = 1; r < aRows.length; r++) {
      const row = aRows[r];
      const date = (row[0] || '').trim();
      if (!date) continue;
      const personPlans = {};
      for (let c = 5; c < hdr.length; c++) {
        if (c !== linksIdx && hdr[c]) personPlans[hdr[c]] = row[c] || '';
      }
      finalRoster.forEach((p) => { if (!(p.displayName in personPlans)) personPlans[p.displayName] = ''; });
      agendaDays.push({
        date, dayNumber: Number(row[1]) || r, dayTitle: row[2] || `Day ${r}`,
        dayBannerImageUrl: row[3] || '', sharedPlan: row[4] || '',
        personPlans, linksAndNotes: linksIdx >= 0 ? (row[linksIdx] || '') : '',
        sheetRowNumber: r + 1
      });
    }
  }

  // Parse photos
  const photos = pRows.map((row) => {
    if (!row[0] || !row[6]) return null;
    return {
      photoId: row[0], uploadedAt: row[1] || '', uploadedBy: row[2] || '',
      dayDate: row[3] || '', caption: row[4] || '', driveFileId: row[5] || '',
      imageUrl: row[6], mimeType: row[7] || 'image/jpeg'
    };
  }).filter(Boolean);

  return { summary: updatedSummary, baseCurrency, activeCurrencies, fxRateHistory, roster: finalRoster, expenses, agendaDays, photos };
}

async function syncSettlementSummary(ws, entries) {
  const balances = computeBalances(ws.roster, entries);
  const transfers = simplifyTransfers(balances.map((b) => ({ id: b.person.personId, name: b.person.displayName, net: b.netBalance })));
  const topBlock = buildExpensesTopBlock(ws.summary.tripName, ws.baseCurrency, ws.roster, transfers);
  await updateValues(state.spreadsheetId, `'${ws.summary.expensesTabName}'!A1`, topBlock);
}

// --- Rendering & UI ---
function render() {
  const app = document.getElementById('app');
  if (!state.session.accessToken || !state.spreadsheetId) {
    app.innerHTML = renderOnboarding();
    bindOnboarding();
    return;
  }
  if (state.activeTripId && state.workspaces[state.activeTripId]) {
    app.innerHTML = renderWorkspace(state.workspaces[state.activeTripId]);
    bindWorkspace(state.workspaces[state.activeTripId]);
    return;
  }
  app.innerHTML = renderTripHub();
  bindTripHub();
}

function renderSyncPill() {
  const cls = state.syncStatus === 'syncing' ? 'sync-busy' : state.syncStatus === 'error' ? 'sync-err' : 'sync-ok';
  const txt = state.syncStatus === 'syncing' ? 'Syncing…' : state.syncStatus === 'error' ? 'Retry / Re-auth' : 'Synced';
  return `<button class="sync-pill ${cls}" id="syncBtn">${txt}</button>`;
}

function renderInstallBanner() {
  if (!isIosSafariBrowser() || state.dismissedInstallBanner) return '';
  return `<div class="banner-install">
    <span><strong>Make this an iPhone App:</strong> Tap Share &#x2191; &rarr; <strong>Add to Home Screen</strong></span>
    <button id="dismissInstallBtn">Got it</button>
  </div>`;
}

function renderOnboarding() {
  const signedIn = Boolean(state.session.accessToken && Date.now() < state.session.expiresAt);
  return `
    ${renderInstallBanner()}
    <div class="container" style="padding-top:28px;">
      <div style="text-align:center; margin-bottom:20px;">
        <img src="../qmat-trips-lockup.png" alt="QMAT Trips" style="width:128px; height:128px; object-fit:contain;" />
        <h1 style="margin:6px 0 4px; color:var(--cobalt);">QMAT Trips</h1>
        <p class="muted" style="margin:0;">Shared group expenses, daily itinerary, &amp; photos synced live with Android.</p>
      </div>

      <div class="card">
        <h3>Step 1 &middot; Sign in with Google</h3>
        <p class="muted">Connects your Google account to read/write the shared Google Sheet &amp; Drive photos.</p>
        ${signedIn
          ? `<div class="pill pill-green" style="display:block; padding:10px 12px; margin-bottom:8px;">Signed in as ${esc(state.session.displayName)} (${esc(state.session.email)})</div>
             <button class="btn-outline" id="switchGoogleBtn">Switch Google Account</button>`
          : `<button class="btn-primary" id="googleSignInBtn">Sign in with Google</button>`}
      </div>

      <div class="card">
        <h3>Step 2 &middot; Connect Shared Google Sheet</h3>
        <div class="field">
          <label>Paste Donald's Shared Google Sheet URL</label>
          <input id="sheetUrlInput" type="url" placeholder="https://docs.google.com/spreadsheets/d/..." ${signedIn ? '' : 'disabled'} />
        </div>
        <button class="btn-primary" id="joinSheetBtn" ${signedIn ? '' : 'disabled'}>Join Shared QMAT Sheet</button>
        <div style="text-align:center; margin:12px 0; font-size:12px; color:var(--muted); font-weight:700;">OR</div>
        <button class="btn-outline" id="createMasterBtn" ${signedIn ? '' : 'disabled'}>Create New 'QMAT Trips Master' Sheet</button>
      </div>
    </div>`;
}

function bindOnboarding() {
  document.getElementById('dismissInstallBtn')?.addEventListener('click', () => { state.dismissedInstallBanner = true; saveStored(); render(); });
  document.getElementById('googleSignInBtn')?.addEventListener('click', async () => {
    try { await signInWithGoogle('select_account'); showToast(`Signed in as ${state.session.displayName}`); render(); }
    catch (e) { showToast(e.message); }
  });
  document.getElementById('switchGoogleBtn')?.addEventListener('click', async () => {
    try { await signInWithGoogle('select_account'); render(); }
    catch (e) { showToast(e.message); }
  });
  document.getElementById('joinSheetBtn')?.addEventListener('click', () => {
    const val = document.getElementById('sheetUrlInput').value;
    connectMasterOrExisting(false, val);
  });
  document.getElementById('createMasterBtn')?.addEventListener('click', () => connectMasterOrExisting(true));
}

function renderTripHub() {
  return `
    ${renderInstallBanner()}
    <div class="topbar">
      <div class="brand">
        <img src="../qmat-trips-lockup.png" alt="QMAT" />
        <div>
          <div class="brand-title">QMAT TRIPS</div>
          <div class="brand-sub">Shared Sheet &amp; Drive</div>
        </div>
      </div>
      <div style="display:flex; gap:6px; align-items:center;">
        ${renderSyncPill()}
        <button class="icon-btn" id="globalSettingsBtn">Sheet</button>
      </div>
    </div>
    <div class="subbar">
      <span id="identityPickBtn" style="cursor:pointer;">Viewing balances as: <strong>${esc(state.selectedIdentity)}</strong> &#x25BE;</span>
      <span>${state.trips.length} trips</span>
    </div>
    <div class="container">
      ${state.trips.length === 0 ? `
        <div class="card" style="text-align:center; padding:28px 18px;">
          <h3>No Trips Yet</h3>
          <p class="muted">Tap "+ Create a New Trip" below or tap Synced to refresh.</p>
        </div>` : state.trips.map((t) => {
          const ws = state.workspaces[t.tripId];
          const roster = ws?.roster || PRESET_CORE;
          const totalSpend = (ws?.expenses || []).filter((e) => e.type === 'EXPENSE').reduce((s, e) => s + e.baseAmount, 0);
          const bals = ws ? computeBalances(ws.roster, ws.expenses) : [];
          const myBal = bals.find((b) => b.person.displayName.toLowerCase() === state.selectedIdentity.toLowerCase())?.netBalance || 0;
          const pillCls = myBal > 0.01 ? 'pill-green' : myBal < -0.01 ? 'pill-amber' : 'pill-ice';
          const pillTxt = myBal > 0.01 ? `You are owed ${formatMoney(myBal, t.baseCurrency)}` : myBal < -0.01 ? `You owe ${formatMoney(-myBal, t.baseCurrency)}` : 'Settled up';
          return `
            <div class="card trip-card" data-trip="${esc(t.tripId)}">
              <div class="trip-banner">
                ${t.coverPhotoUrl ? `<img src="${esc(t.coverPhotoUrl)}" alt="${esc(t.tripName)}" />` : ''}
                <div class="trip-scrim">
                  <div class="trip-title">${esc(t.tripName)}</div>
                  <div class="trip-meta">${esc([t.destination, `${t.startDate} – ${t.endDate}`].filter(Boolean).join(' · '))}</div>
                </div>
              </div>
              <div class="trip-body">
                <div class="chips-scroll" style="margin-bottom:10px;">
                  ${roster.map((p) => `<span class="chip ${p.displayName.toLowerCase() === state.selectedIdentity.toLowerCase() ? 'active' : ''}">${esc(p.displayName)}</span>`).join('')}
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <span class="pill ${pillCls}">${pillTxt}</span>
                  <span class="muted">Spend: ${formatMoney(totalSpend, t.baseCurrency)}</span>
                </div>
              </div>
            </div>`;
        }).join('')}
    </div>
    <button class="fab fab-hub" id="createTripBtn">+ Create a New Trip</button>`;
}

function bindTripHub() {
  document.getElementById('dismissInstallBtn')?.addEventListener('click', () => { state.dismissedInstallBanner = true; saveStored(); render(); });
  document.getElementById('syncBtn')?.addEventListener('click', async () => {
    if (Date.now() >= state.session.expiresAt) {
      try { await signInWithGoogle(''); } catch (e) { showToast(e.message); return; }
    }
    refreshAllTrips();
  });
  document.getElementById('identityPickBtn')?.addEventListener('click', openIdentityModal);
  document.getElementById('globalSettingsBtn')?.addEventListener('click', openGlobalSettingsModal);
  document.getElementById('createTripBtn')?.addEventListener('click', openCreateTripModal);
  document.querySelectorAll('.trip-card').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeTripId = el.dataset.trip;
      state.activeTab = 'expenses';
      state.selectedAgendaDate = null;
      render();
    });
  });
}

function renderWorkspace(ws) {
  return `
    <div class="topbar">
      <div style="display:flex; align-items:center; gap:8px;">
        <button class="icon-btn" id="backHubBtn">&larr; Trips</button>
        <div>
          <div class="brand-title" style="color:var(--slate);">${esc(ws.summary.tripName)}</div>
          <div class="brand-sub">${esc(ws.summary.destination)}</div>
        </div>
      </div>
      ${renderSyncPill()}
    </div>
    <div class="container">
      ${state.activeTab === 'expenses' ? renderExpensesTab(ws) : ''}
      ${state.activeTab === 'agenda' ? renderAgendaTab(ws) : ''}
      ${state.activeTab === 'photos' ? renderPhotosTab(ws) : ''}
      ${state.activeTab === 'settings' ? renderSettingsTab(ws) : ''}
    </div>
    <div class="bottom-nav">
      <button class="nav-item ${state.activeTab === 'expenses' ? 'active' : ''}" data-tab="expenses">&#x1F9FE;<span>Expenses</span></button>
      <button class="nav-item ${state.activeTab === 'agenda' ? 'active' : ''}" data-tab="agenda">&#x1F4C5;<span>Agenda</span></button>
      <button class="nav-item ${state.activeTab === 'photos' ? 'active' : ''}" data-tab="photos">&#x1F4F7;<span>Photos</span></button>
      <button class="nav-item ${state.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">&#x2699;&#xFE0F;<span>Settings</span></button>
    </div>`;
}

function bindWorkspace(ws) {
  document.getElementById('backHubBtn')?.addEventListener('click', () => { state.activeTripId = null; render(); });
  document.getElementById('syncBtn')?.addEventListener('click', async () => {
    if (Date.now() >= state.session.expiresAt) {
      try { await signInWithGoogle(''); } catch (e) { showToast(e.message); return; }
    }
    refreshAllTrips();
  });
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => { state.activeTab = btn.dataset.tab; render(); });
  });
  if (state.activeTab === 'expenses') bindExpensesTab(ws);
  if (state.activeTab === 'agenda') bindAgendaTab(ws);
  if (state.activeTab === 'photos') bindPhotosTab(ws);
  if (state.activeTab === 'settings') bindSettingsTab(ws);
}

// --- Tab A: Expenses ---
function renderExpensesTab(ws) {
  const bals = computeBalances(ws.roster, ws.expenses);
  const couples = computeCoupleBalances(ws.roster, bals);
  const transfers = state.coupleView
    ? simplifyTransfers(couples.map((c) => ({ id: c.primaryPersonId, name: c.displayLabel, net: c.netBalance })))
    : simplifyTransfers(bals.map((b) => ({ id: b.person.personId, name: b.person.displayName, net: b.netBalance })));

  const sorted = [...ws.expenses].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.sheetRowNumber || 0) - (a.sheetRowNumber || 0));
  const grouped = {};
  sorted.forEach((e) => { (grouped[e.date] ||= []).push(e); });

  return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <h3 style="margin:0;">Balances &amp; Who Owes Who</h3>
        <label style="font-size:12px; font-weight:600; display:flex; align-items:center; gap:5px; cursor:pointer;">
          <input type="checkbox" id="coupleToggle" ${state.coupleView ? 'checked' : ''} /> Couple View
        </label>
      </div>
      ${(state.coupleView ? couples : bals).map((b) => {
        const label = state.coupleView ? b.displayLabel : b.person.displayName;
        const net = b.netBalance;
        const cls = net > 0.01 ? 'pill-green' : net < -0.01 ? 'pill-amber' : 'pill-ice';
        const sign = net > 0.01 ? '+' : net < -0.01 ? '-' : '';
        return `<div class="bal-row">
          <div>
            <strong>${esc(label)}</strong>
            <div class="muted" style="font-size:12px;">Paid ${formatMoney(b.expensePaid, ws.baseCurrency)} &middot; Share ${formatMoney(b.expenseShare, ws.baseCurrency)}</div>
          </div>
          <span class="pill ${cls}">${sign}${formatMoney(Math.abs(net), ws.baseCurrency)}</span>
        </div>`;
      }).join('')}
      <hr style="border:none; border-top:1px solid var(--border); margin:10px 0;" />
      <div style="font-size:13px; font-weight:700; color:var(--cobalt); margin-bottom:6px;">Settle Up</div>
      ${transfers.length === 0 ? `<div class="muted" style="color:var(--green);">Everyone is all settled up!</div>` : transfers.map((t, idx) => `
        <div style="display:flex; justify-content:space-between; align-items:center; background:var(--ice); padding:8px 10px; border-radius:10px; margin-bottom:6px;">
          <span style="font-size:13px;"><strong>${esc(t.fromName)}</strong> &rarr; <strong>${esc(t.toName)}</strong></span>
          <div style="display:flex; align-items:center; gap:6px;">
            <strong style="color:var(--cobalt); font-size:13px;">${formatMoney(t.amount, ws.baseCurrency)}</strong>
            <button class="btn-outline btn-sm record-pay-btn" data-idx="${idx}">Record</button>
          </div>
        </div>`).join('')}
    </div>

    ${Object.keys(grouped).length === 0 ? `<div class="card" style="text-align:center;">No expenses logged yet.</div>` : Object.entries(grouped).map(([date, list]) => `
      <div class="muted" style="font-weight:700; margin:12px 0 6px;">${esc(date)}</div>
      ${list.map((e) => {
        const bens = Object.entries(e.allocationsByPersonId).filter(([, v]) => v > 0).map(([pid]) => ws.roster.find((p) => p.personId === pid)?.displayName).filter(Boolean);
        const adHoc = ['EXACT_AMOUNTS', 'SHARES', 'PERCENTAGES'].includes(e.splitMode);
        return `<div class="card exp-row" data-entry="${esc(e.entryId)}">
          <div>
            <strong>${esc(e.title)}</strong> ${adHoc ? `<span class="pill pill-amber">Ad-hoc</span>` : ''}
            <div class="muted" style="font-size:12px;">${e.type === 'PAYMENT' ? `${esc(e.paidByName)} paid ${esc(bens.join(', '))}` : `Paid by ${esc(e.paidByName)} &middot; For ${esc(bens.join(', '))}`}</div>
            ${e.notes ? `<div style="font-size:12px; color:var(--cobalt); margin-top:2px;">${esc(e.notes)}</div>` : ''}
          </div>
          <div style="text-align:right; white-space:nowrap;">
            <strong>${formatMoney(e.baseAmount, ws.baseCurrency)}</strong>
            ${e.currency !== ws.baseCurrency ? `<div class="muted" style="font-size:11px;">${formatMoney(e.originalAmount, e.currency)}</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    `).join('')}
    <button class="fab" id="addExpenseBtn">+ Add Expense</button>`;
}

function bindExpensesTab(ws) {
  document.getElementById('coupleToggle')?.addEventListener('change', () => { state.coupleView = !state.coupleView; render(); });
  document.getElementById('addExpenseBtn')?.addEventListener('click', () => openExpenseModal(ws, null, null));
  document.querySelectorAll('.exp-row').forEach((el) => {
    el.addEventListener('click', () => {
      const entry = ws.expenses.find((x) => x.entryId === el.dataset.entry);
      if (entry) openExpenseModal(ws, entry, null);
    });
  });
  const bals = computeBalances(ws.roster, ws.expenses);
  const couples = computeCoupleBalances(ws.roster, bals);
  const transfers = state.coupleView
    ? simplifyTransfers(couples.map((c) => ({ id: c.primaryPersonId, name: c.displayLabel, net: c.netBalance })))
    : simplifyTransfers(bals.map((b) => ({ id: b.person.personId, name: b.person.displayName, net: b.netBalance })));
  document.querySelectorAll('.record-pay-btn').forEach((btn) => {
    btn.addEventListener('click', () => openExpenseModal(ws, null, transfers[Number(btn.dataset.idx)]));
  });
}

// --- Tab B: Agenda ---
function renderAgendaTab(ws) {
  const days = ws.agendaDays.length ? ws.agendaDays : enumerateDays(ws.summary.startDate, ws.summary.endDate).map((d, i) => ({
    date: d, dayNumber: i + 1, dayTitle: `Day ${i + 1}`, dayBannerImageUrl: '', sharedPlan: '', personPlans: {}, linksAndNotes: ''
  }));
  const auto = selectAutoDate(ws.summary.startDate, ws.summary.endDate);
  if (!state.selectedAgendaDate || !days.some((d) => d.date === state.selectedAgendaDate)) {
    state.selectedAgendaDate = auto.date || days[0]?.date;
  }
  const day = days.find((d) => d.date === state.selectedAgendaDate) || days[0];
  if (!state.selectedPersonDraft || !ws.roster.some((p) => p.displayName === state.selectedPersonDraft)) {
    state.selectedPersonDraft = ws.roster[0]?.displayName || 'Donald';
  }

  return `
    <div class="seg">
      <button id="agendaDailyBtn" class="${state.agendaMode === 'daily' ? 'active' : ''}">Daily View</button>
      <button id="agendaOverviewBtn" class="${state.agendaMode === 'overview' ? 'active' : ''}">Quick Overview</button>
    </div>
    ${auto.phase === 'COMPLETED' ? `<div style="margin-bottom:8px;"><span class="pill pill-ice">Trip Completed</span></div>` : ''}
    ${state.agendaMode === 'overview' ? days.map((d) => `
      <div class="card overview-day" data-date="${esc(d.date)}" style="display:flex; gap:10px; align-items:center; cursor:pointer;">
        <div style="width:58px; height:58px; border-radius:10px; overflow:hidden; background:var(--ice); flex-shrink:0; display:flex; align-items:center; justify-content:center; font-weight:700; color:var(--cobalt);">
          ${d.dayBannerImageUrl ? `<img src="${esc(d.dayBannerImageUrl)}" style="width:100%; height:100%; object-fit:cover;" />` : `D${d.dayNumber}`}
        </div>
        <div>
          <strong>Day ${d.dayNumber} &middot; ${formatShortDate(d.date)} &mdash; ${esc(d.dayTitle)}</strong>
          <div class="muted" style="font-size:12px;">${esc((d.sharedPlan || 'Tap to view/edit').slice(0, 90))}</div>
        </div>
      </div>`).join('') : day ? `
      <div class="chips-scroll" style="margin-bottom:10px;">
        ${days.map((d) => `<button class="chip ${d.date === day.date ? 'active' : 'outline'} day-pill" data-date="${esc(d.date)}">Day ${d.dayNumber} &middot; ${formatShortDate(d.date)}</button>`).join('')}
      </div>
      <div class="card trip-card" style="margin-bottom:12px;">
        <div class="trip-banner" style="height:175px;">
          ${day.dayBannerImageUrl ? `<img src="${esc(day.dayBannerImageUrl)}" alt="${esc(day.dayTitle)}" />` : ''}
          <div class="trip-scrim">
            <div style="font-size:12px; opacity:0.9;">Day ${day.dayNumber} &middot; ${formatShortDate(day.date)}</div>
            <div class="trip-title">${esc(day.dayTitle || `Day ${day.dayNumber}`)}</div>
          </div>
          <button id="changeDayImgBtn" class="btn-outline btn-sm" style="position:absolute; top:10px; right:10px; background:rgba(255,255,255,0.92);">
            ${day.dayBannerImageUrl ? 'Change Image' : 'Add Day Image'}
          </button>
        </div>
      </div>
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <h3 style="margin:0; color:var(--cobalt);">Shared Group Plan</h3>
          <button id="editDayBtn" class="btn-outline btn-sm">Edit Day</button>
        </div>
        <div style="font-size:14px;">${day.sharedPlan ? linkifyHtml(day.sharedPlan) : `<span class="muted">No shared plan yet. Tap Edit Day to add details.</span>`}</div>
        ${day.linksAndNotes ? `<div style="margin-top:10px;"><strong style="font-size:12px; color:var(--muted);">Links &amp; Notes</strong><div style="font-size:14px;">${linkifyHtml(day.linksAndNotes)}</div></div>` : ''}
      </div>
      <div class="card">
        <h3>Per-Person Itinerary Drafts</h3>
        <div class="chips-scroll" style="margin-bottom:10px;">
          ${ws.roster.map((p) => `<button class="chip ${p.displayName === state.selectedPersonDraft ? 'active' : 'outline'} person-draft-pill" data-name="${esc(p.displayName)}">${esc(p.displayName)}${day.personPlans?.[p.displayName] ? ' &bull;' : ''}</button>`).join('')}
        </div>
        <div style="background:var(--ice); border-radius:12px; padding:12px; font-size:14px;">
          <strong style="color:var(--cobalt); font-size:13px;">${esc(state.selectedPersonDraft)}'s Draft</strong>
          <div style="margin-top:4px;">${day.personPlans?.[state.selectedPersonDraft] ? linkifyHtml(day.personPlans[state.selectedPersonDraft]) : `<span class="muted">No draft from ${esc(state.selectedPersonDraft)} yet.</span>`}</div>
        </div>
      </div>` : ''}`;
}

function bindAgendaTab(ws) {
  document.getElementById('agendaDailyBtn')?.addEventListener('click', () => { state.agendaMode = 'daily'; render(); });
  document.getElementById('agendaOverviewBtn')?.addEventListener('click', () => { state.agendaMode = 'overview'; render(); });
  document.querySelectorAll('.overview-day').forEach((el) => {
    el.addEventListener('click', () => { state.selectedAgendaDate = el.dataset.date; state.agendaMode = 'daily'; render(); });
  });
  document.querySelectorAll('.day-pill').forEach((el) => {
    el.addEventListener('click', () => { state.selectedAgendaDate = el.dataset.date; render(); });
  });
  document.querySelectorAll('.person-draft-pill').forEach((el) => {
    el.addEventListener('click', () => { state.selectedPersonDraft = el.dataset.name; render(); });
  });
  const days = ws.agendaDays.length ? ws.agendaDays : enumerateDays(ws.summary.startDate, ws.summary.endDate).map((d, i) => ({
    date: d, dayNumber: i + 1, dayTitle: `Day ${i + 1}`, dayBannerImageUrl: '', sharedPlan: '', personPlans: {}, linksAndNotes: ''
  }));
  const day = days.find((d) => d.date === state.selectedAgendaDate) || days[0];
  document.getElementById('changeDayImgBtn')?.addEventListener('click', () => openImageModal(ws, `Day ${day.dayNumber} Hero Image`, day.dayBannerImageUrl, `${ws.summary.destination} ${day.dayTitle}`, async (url) => {
    await saveAgendaDay(ws, { ...day, dayBannerImageUrl: url });
  }));
  document.getElementById('editDayBtn')?.addEventListener('click', () => openEditDayModal(ws, day));
}

// --- Tab C: Photos ---
function renderPhotosTab(ws) {
  const days = enumerateDays(ws.summary.startDate, ws.summary.endDate);
  const filtered = state.photoDayFilter === 'ALL' ? ws.photos : ws.photos.filter((p) => p.dayDate === state.photoDayFilter);
  return `
    <div class="chips-scroll" style="margin-bottom:10px;">
      <button class="chip ${state.photoDayFilter === 'ALL' ? 'active' : 'outline'} pday-pill" data-date="ALL">All Days (${ws.photos.length})</button>
      ${days.map((d) => `<button class="chip ${state.photoDayFilter === d ? 'active' : 'outline'} pday-pill" data-date="${esc(d)}">${formatShortDate(d)} (${ws.photos.filter((p) => p.dayDate === d).length})</button>`).join('')}
    </div>
    ${filtered.length === 0 ? `<div class="card" style="text-align:center; padding:28px;"><strong>Shared Trip Album (Photos Only)</strong><p class="muted">Tap "+ Add Photo" to upload. Videos are blocked.</p></div>` : `
      <div class="photo-grid">
        ${filtered.map((p) => `<div class="photo-tile" data-pid="${esc(p.photoId)}">
          <img src="${esc(p.imageUrl)}" alt="${esc(p.caption)}" />
          <div class="photo-caption">${esc(p.uploadedBy)}</div>
        </div>`).join('')}
      </div>`}
    <input type="file" id="photoFileInput" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" class="hidden" />
    <button class="fab" id="addPhotoBtn">+ Add Photo</button>`;
}

function bindPhotosTab(ws) {
  document.querySelectorAll('.pday-pill').forEach((el) => {
    el.addEventListener('click', () => { state.photoDayFilter = el.dataset.date; render(); });
  });
  const input = document.getElementById('photoFileInput');
  document.getElementById('addPhotoBtn')?.addEventListener('click', () => input.click());
  input?.addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    input.value = '';
    if (!file) return;
    const mime = (file.type || '').toLowerCase();
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (mime.startsWith('video/') || VIDEO_EXTS.has(ext) || (mime && !ALLOWED_MIMES.has(mime))) {
      showToast('Only photos are allowed in QMAT Trips.');
      return;
    }
    openPhotoUploadModal(ws, file);
  });
  document.querySelectorAll('.photo-tile').forEach((el) => {
    el.addEventListener('click', () => {
      const p = ws.photos.find((x) => x.photoId === el.dataset.pid);
      if (p) openPhotoViewerModal(p);
    });
  });
}

// --- Tab D: Settings ---
function renderSettingsTab(ws) {
  return `
    <div class="card">
      <h3>Trip Cover Photo</h3>
      ${ws.summary.coverPhotoUrl ? `<img src="${esc(ws.summary.coverPhotoUrl)}" style="width:100%; height:130px; object-fit:cover; border-radius:12px; margin-bottom:8px;" />` : ''}
      <button class="btn-outline" id="changeCoverBtn">Change Cover Photo</button>
    </div>

    <div class="card">
      <h3>Currency &amp; Mid-Trip FX Rates</h3>
      <p class="muted">Base Currency: <strong>${esc(ws.baseCurrency)}</strong></p>
      <div class="chips-wrap" style="margin-bottom:10px;">
        ${ws.activeCurrencies.map((c) => {
          const r = latestFxRate(ws.fxRateHistory, c, ws.baseCurrency);
          return `<span class="chip">${c === ws.baseCurrency ? `${c} (Base)` : `${c} · ${r}`}</span>`;
        }).join('')}
      </div>
      <div class="row-3">
        <div class="field"><label>Code</label><input id="fxCodeIn" maxlength="3" placeholder="EUR" /></div>
        <div class="field"><label>1 = ? ${esc(ws.baseCurrency)}</label><input id="fxRateIn" type="number" step="0.0001" placeholder="1.09" /></div>
        <div class="field"><label>&nbsp;</label><button class="btn-primary" id="saveFxBtn">Save</button></div>
      </div>
    </div>

    <div class="card">
      <h3>People &amp; Roster Manager</h3>
      <p class="muted">Adding someone updates columns &amp; formulas in ${esc(ws.summary.expensesTabName)} and ${esc(ws.summary.agendaTabName)}. Anna and Ana stay strictly separate.</p>
      <div class="chips-wrap" style="margin-bottom:10px;">
        ${ALL_PRESETS.map((p) => {
          const on = ws.roster.some((r) => r.personId === p.personId || r.displayName === p.displayName);
          return `<button class="chip ${on ? 'active' : 'outline'} preset-person-btn" data-pid="${p.personId}">${on ? `${p.displayName} ✓` : `+ ${p.displayName}`}</button>`;
        }).join('')}
      </div>
      <div class="row-3">
        <div class="field" style="grid-column:span 2;"><label>Custom Person Name</label><input id="newPersonNameIn" placeholder="Name" /></div>
        <div class="field"><label>&nbsp;</label><button class="btn-primary" id="addCustomPersonBtn">Add</button></div>
      </div>
    </div>

    <div class="card">
      <h3>Share &amp; Sheet Info</h3>
      <div class="muted" style="word-break:break-all; margin-bottom:8px;">${esc(state.spreadsheetUrl)}</div>
      <button class="btn-outline" id="copyInviteBtn" style="margin-bottom:8px;">Copy Friend Invite &amp; Sheet Link</button>
      <button class="btn-outline" id="archiveTripBtn">${ws.summary.status === 'Active' ? 'Archive Trip' : 'Unarchive Trip'}</button>
    </div>`;
}

function bindSettingsTab(ws) {
  document.getElementById('changeCoverBtn')?.addEventListener('click', () =>
    openImageModal(ws, 'Trip Cover Photo', ws.summary.coverPhotoUrl, ws.summary.destination || ws.summary.tripName, async (url) => {
      const updatedSummary = { ...ws.summary, coverPhotoUrl: url };
      await saveSettingsAndIndex(ws, updatedSummary, ws.activeCurrencies, ws.fxRateHistory, ws.roster, 'Cover photo updated.');
    })
  );
  document.getElementById('saveFxBtn')?.addEventListener('click', async () => {
    const code = document.getElementById('fxCodeIn').value.trim().toUpperCase();
    const rate = Number(document.getElementById('fxRateIn').value);
    if (code.length !== 3 || !(rate > 0)) { showToast('Enter a valid 3-letter currency & positive rate.'); return; }
    const currencies = [...new Set([...ws.activeCurrencies, code])];
    const history = [...ws.fxRateHistory, { effectiveTimestamp: new Date().toISOString(), currencyCode: code, rateToBase: rate }];
    await saveSettingsAndIndex(ws, ws.summary, currencies, history, ws.roster, `FX rate saved: 1 ${code} = ${rate} ${ws.baseCurrency}`);
  });
  document.querySelectorAll('.preset-person-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const preset = ALL_PRESETS.find((p) => p.personId === btn.dataset.pid);
      if (!preset || ws.roster.some((r) => r.personId === preset.personId || r.displayName === preset.displayName)) return;
      await addPersonAndExpand(ws, { ...preset });
    });
  });
  document.getElementById('addCustomPersonBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newPersonNameIn').value.trim();
    if (!name) return;
    if (ws.roster.some((r) => r.displayName === name)) { showToast(`${name} is already on this trip.`); return; }
    await addPersonAndExpand(ws, {
      personId: `p_${name.toLowerCase().replace(/[^a-z0-9]/g, '')}_${uuid().slice(0, 4)}`,
      displayName: name, groupType: 'Partner', linkedPartnerOf: '', active: true
    });
  });
  document.getElementById('copyInviteBtn')?.addEventListener('click', async () => {
    const txt = `Join our ${ws.summary.tripName} trip in QMAT Trips!\n1. Open https://donaldmfriend.github.io/qmat-trips-site/\n2. Sign in with Google and paste this Sheet URL:\n${state.spreadsheetUrl}`;
    await navigator.clipboard?.writeText(txt).catch(() => {});
    showToast('Invite instructions & Sheet link copied!');
  });
  document.getElementById('archiveTripBtn')?.addEventListener('click', async () => {
    const next = ws.summary.status === 'Active' ? 'Archived' : 'Active';
    await saveSettingsAndIndex(ws, { ...ws.summary, status: next }, ws.activeCurrencies, ws.fxRateHistory, ws.roster, `Trip marked ${next}.`);
  });
}

// --- Sheet Write Operations ---
async function saveSettingsAndIndex(ws, summary, currencies, fxHistory, roster, toastMsg) {
  state.syncStatus = 'syncing'; render();
  try {
    await clearRange(state.spreadsheetId, `'${summary.settingsTabName}'!A1:F200`);
    await updateValues(state.spreadsheetId, `'${summary.settingsTabName}'!A1`, buildSettingsRows(summary, currencies, fxHistory, roster));
    const idxRows = await getValues(state.spreadsheetId, "'Trips_Index'!A1:A200");
    const rIdx = idxRows.findIndex((r) => (r[0] || '').trim() === summary.tripId);
    if (rIdx >= 1) {
      await updateValues(state.spreadsheetId, `'Trips_Index'!A${rIdx + 1}:L${rIdx + 1}`, [[
        summary.tripId, summary.tripName, summary.destination, summary.startDate, summary.endDate,
        summary.baseCurrency, summary.coverPhotoUrl, summary.driveFolderId,
        summary.expensesTabName, summary.agendaTabName, summary.settingsTabName, summary.status
      ]]);
    }
    state.workspaces[summary.tripId] = { ...ws, summary, activeCurrencies: currencies, fxRateHistory: fxHistory, roster };
    state.trips = state.trips.map((t) => t.tripId === summary.tripId ? summary : t);
    state.syncStatus = 'synced';
    showToast(toastMsg);
  } catch (e) {
    state.syncStatus = 'error'; showToast(e.message);
  }
  render();
}

async function addPersonAndExpand(ws, newPerson) {
  state.syncStatus = 'syncing'; render();
  try {
    const updatedRoster = [...ws.roster, newPerson];
    await clearRange(state.spreadsheetId, `'${ws.summary.settingsTabName}'!A1:F200`);
    await updateValues(state.spreadsheetId, `'${ws.summary.settingsTabName}'!A1`, buildSettingsRows(ws.summary, ws.activeCurrencies, ws.fxRateHistory, updatedRoster));

    const bals = computeBalances(updatedRoster, ws.expenses);
    const transfers = simplifyTransfers(bals.map((b) => ({ id: b.person.personId, name: b.person.displayName, net: b.netBalance })));
    const topBlock = buildExpensesTopBlock(ws.summary.tripName, ws.baseCurrency, updatedRoster, transfers);
    const existingExp = await getValues(state.spreadsheetId, `'${ws.summary.expensesTabName}'!A1:AZ1000`, 'FORMULA');
    const totalCols = 12 + updatedRoster.length;
    const expandedExp = [...topBlock];
    for (let r = 14; r < existingExp.length; r++) {
      const row = [...existingExp[r]];
      while (row.length < totalCols) row.push('0.00');
      expandedExp.push(row);
    }
    await clearRange(state.spreadsheetId, `'${ws.summary.expensesTabName}'!A1:AZ1000`);
    await updateValues(state.spreadsheetId, `'${ws.summary.expensesTabName}'!A1`, expandedExp);

    const existingAg = await getValues(state.spreadsheetId, `'${ws.summary.agendaTabName}'!A1:AZ200`);
    const newHdr = ['Date', 'DayNumber', 'DayTitle', 'DayBannerImageUrl', 'SharedPlan', ...updatedRoster.map((p) => p.displayName), 'LinksAndNotes'];
    const oldHdr = existingAg[0] || [];
    const oldLinksIdx = oldHdr.indexOf('LinksAndNotes');
    const expandedAg = [newHdr];
    for (let r = 1; r < existingAg.length; r++) {
      const old = existingAg[r];
      const row = [old[0] || '', old[1] || String(r), old[2] || `Day ${r}`, old[3] || '', old[4] || ''];
      updatedRoster.forEach((p) => {
        const c = oldHdr.indexOf(p.displayName);
        row.push(c >= 5 && c !== oldLinksIdx ? (old[c] || '') : '');
      });
      row.push(oldLinksIdx >= 0 ? (old[oldLinksIdx] || '') : '');
      expandedAg.push(row);
    }
    await clearRange(state.spreadsheetId, `'${ws.summary.agendaTabName}'!A1:AZ200`);
    await updateValues(state.spreadsheetId, `'${ws.summary.agendaTabName}'!A1`, expandedAg);

    state.workspaces[ws.summary.tripId] = await loadWorkspace(ws.summary);
    state.syncStatus = 'synced';
    showToast(`${newPerson.displayName} added to trip & formulas!`);
  } catch (e) {
    state.syncStatus = 'error'; showToast(e.message);
  }
  render();
}

async function saveAgendaDay(ws, day) {
  state.syncStatus = 'syncing'; render();
  try {
    const tab = ws.summary.agendaTabName;
    const rows = await getValues(state.spreadsheetId, `'${tab}'!A1:A200`);
    const rIdx = rows.findIndex((r) => (r[0] || '').trim() === day.date);
    const values = [[
      day.date, String(day.dayNumber), day.dayTitle, day.dayBannerImageUrl || '', day.sharedPlan || '',
      ...ws.roster.map((p) => day.personPlans?.[p.displayName] || ''),
      day.linksAndNotes || ''
    ]];
    if (rIdx >= 1) await updateValues(state.spreadsheetId, `'${tab}'!A${rIdx + 1}`, values);
    else await appendValues(state.spreadsheetId, `'${tab}'!A1`, values);
    state.workspaces[ws.summary.tripId] = await loadWorkspace(ws.summary);
    state.syncStatus = 'synced';
    showToast(`Saved agenda for ${day.date}.`);
  } catch (e) {
    state.syncStatus = 'error'; showToast(e.message);
  }
  render();
}

// --- Modals ---
function showModal(html, bindFn) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-backdrop" id="modalBackdrop"><div class="modal-sheet">${html}</div></div>`;
  document.getElementById('modalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'modalBackdrop') closeModal();
  });
  bindFn();
}

function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

function openIdentityModal() {
  showModal(`
    <h3>Who are you in QMAT Trips?</h3>
    <div class="chips-wrap" style="margin-bottom:12px;">
      ${ALL_PRESETS.map((p) => `<button class="chip ${p.displayName === state.selectedIdentity ? 'active' : 'outline'} id-opt" data-name="${esc(p.displayName)}">${esc(p.displayName)}</button>`).join('')}
    </div>
    <div class="field"><label>Or custom name</label><input id="customIdIn" placeholder="Name" /></div>
    <div class="row-2">
      <button class="btn-outline" id="closeModBtn">Cancel</button>
      <button class="btn-primary" id="saveCustomIdBtn">Save</button>
    </div>`, () => {
    document.querySelectorAll('.id-opt').forEach((b) => b.addEventListener('click', () => {
      state.selectedIdentity = b.dataset.name; saveStored(); closeModal(); render();
    }));
    document.getElementById('closeModBtn').addEventListener('click', closeModal);
    document.getElementById('saveCustomIdBtn').addEventListener('click', () => {
      const v = document.getElementById('customIdIn').value.trim();
      if (v) { state.selectedIdentity = v; saveStored(); }
      closeModal(); render();
    });
  });
}

function openGlobalSettingsModal() {
  showModal(`
    <h3>Global Sheet &amp; Account</h3>
    <p class="muted">Signed in: <strong>${esc(state.session.email)}</strong></p>
    <p class="muted" style="word-break:break-all;">Sheet: ${esc(state.spreadsheetUrl)}</p>
    <button class="btn-outline" id="copySheetUrlBtn" style="margin-bottom:10px;">Copy Shareable Sheet URL</button>
    <div class="field"><label>Switch to another Sheet URL</label><input id="switchUrlIn" placeholder="https://docs.google.com/spreadsheets/d/..." /></div>
    <button class="btn-primary" id="switchSheetBtn" style="margin-bottom:8px;">Connect New Sheet</button>
    <div class="row-2">
      <button class="btn-outline" id="changeSheetBtn">Change Sheet</button>
      <button class="btn-outline" id="signOutBtn" style="color:var(--red);">Sign Out</button>
    </div>`, () => {
    document.getElementById('copySheetUrlBtn').addEventListener('click', async () => {
      await navigator.clipboard?.writeText(state.spreadsheetUrl).catch(() => {});
      showToast('Sheet URL copied!');
    });
    document.getElementById('switchSheetBtn').addEventListener('click', () => {
      const u = document.getElementById('switchUrlIn').value;
      closeModal(); connectMasterOrExisting(false, u);
    });
    document.getElementById('changeSheetBtn').addEventListener('click', () => {
      state.spreadsheetId = ''; state.spreadsheetUrl = ''; saveStored(); closeModal(); render();
    });
    document.getElementById('signOutBtn').addEventListener('click', () => {
      state.session = { email: '', displayName: '', accessToken: '', expiresAt: 0 };
      saveStored(); closeModal(); render();
    });
  });
}

function openCreateTripModal() {
  const today = new Date();
  const sDef = new Date(today.getTime() + 14 * 86400000).toISOString().slice(0, 10);
  const eDef = new Date(today.getTime() + 21 * 86400000).toISOString().slice(0, 10);
  const selectedIds = new Set(PRESET_CORE.map((p) => p.personId));

  showModal(`
    <h3>Create a New Trip</h3>
    <div class="field"><label>Trip Name</label><input id="ctName" placeholder="e.g., Madeira 2027" /></div>
    <div class="field"><label>Destination</label><input id="ctDest" placeholder="e.g., Funchal, Portugal" /></div>
    <div class="row-2">
      <div class="field"><label>Start Date</label><input id="ctStart" type="date" value="${sDef}" /></div>
      <div class="field"><label>End Date</label><input id="ctEnd" type="date" value="${eDef}" /></div>
    </div>
    <div class="row-3">
      <div class="field"><label>Base</label><input id="ctBase" value="USD" maxlength="3" /></div>
      <div class="field"><label>Trip FX</label><input id="ctFx" value="EUR" maxlength="3" /></div>
      <div class="field"><label>To Base</label><input id="ctRate" type="number" step="0.0001" value="1.09" /></div>
    </div>
    <div class="field"><label>Cover Photo URL (optional)</label><input id="ctCover" placeholder="https://..." /></div>
    <div class="field"><label>Friends &amp; Partners</label>
      <div class="chips-wrap" id="ctRosterChips">
        ${ALL_PRESETS.map((p) => `<button type="button" class="chip ${selectedIds.has(p.personId) ? 'active' : 'outline'}" data-pid="${p.personId}">${esc(p.displayName)}</button>`).join('')}
      </div>
    </div>
    <div class="row-2">
      <button class="btn-outline" id="ctCancelBtn">Cancel</button>
      <button class="btn-primary" id="ctSaveBtn">Create Trip</button>
    </div>`, () => {
    document.querySelectorAll('#ctRosterChips .chip').forEach((b) => {
      b.addEventListener('click', () => {
        if (selectedIds.has(b.dataset.pid)) selectedIds.delete(b.dataset.pid);
        else selectedIds.add(b.dataset.pid);
        b.classList.toggle('active'); b.classList.toggle('outline');
      });
    });
    document.getElementById('ctCancelBtn').addEventListener('click', closeModal);
    document.getElementById('ctSaveBtn').addEventListener('click', async () => {
      const tripName = document.getElementById('ctName').value.trim();
      const destination = document.getElementById('ctDest').value.trim();
      const startDate = document.getElementById('ctStart').value;
      const endDate = document.getElementById('ctEnd').value;
      const baseCurrency = document.getElementById('ctBase').value.trim().toUpperCase() || 'USD';
      const extraCurrency = document.getElementById('ctFx').value.trim().toUpperCase();
      const extraRate = Number(document.getElementById('ctRate').value) || 1;
      const coverPhotoUrl = document.getElementById('ctCover').value.trim();
      const roster = ALL_PRESETS.filter((p) => selectedIds.has(p.personId));
      if (!tripName || !roster.length) { showToast('Enter trip name and select at least one person.'); return; }

      closeModal();
      state.syncStatus = 'syncing'; render();
      try {
        const tripId = uuid().slice(0, 8);
        const code = toTripCode(tripName, tripId);
        const expTab = `${code}_Expenses`, agTab = `${code}_Agenda`, setTab = `${code}_Settings`, phTab = `${code}_Photos`;
        let folderId = '';
        try {
          const root = await ensureDriveFolder('QMAT Trips Photos');
          folderId = await ensureDriveFolder(tripName, root);
        } catch (_) {}
        const summary = {
          tripId, tripName, destination, startDate, endDate, baseCurrency, coverPhotoUrl,
          driveFolderId: folderId, expensesTabName: expTab, agendaTabName: agTab,
          settingsTabName: setTab, photosTabName: phTab, status: 'Active'
        };
        await ensureTabsExist(state.spreadsheetId, [setTab, expTab, agTab, phTab]);
        const currencies = [...new Set([baseCurrency, ...(extraCurrency.length === 3 ? [extraCurrency] : [])])];
        const now = new Date().toISOString();
        const rates = [{ effectiveTimestamp: now, currencyCode: baseCurrency, rateToBase: 1.0 }];
        if (extraCurrency.length === 3 && extraCurrency !== baseCurrency && extraRate > 0) {
          rates.push({ effectiveTimestamp: now, currencyCode: extraCurrency, rateToBase: extraRate });
        }
        await updateValues(state.spreadsheetId, `'${setTab}'!A1`, buildSettingsRows(summary, currencies, rates, roster));
        await updateValues(state.spreadsheetId, `'${expTab}'!A1`, buildExpensesTopBlock(tripName, baseCurrency, roster, []));
        const days = enumerateDays(startDate, endDate);
        const agRows = [
          ['Date', 'DayNumber', 'DayTitle', 'DayBannerImageUrl', 'SharedPlan', ...roster.map((p) => p.displayName), 'LinksAndNotes'],
          ...days.map((d, i) => [d, String(i + 1), `Day ${i + 1}`, '', '', ...roster.map(() => ''), ''])
        ];
        await updateValues(state.spreadsheetId, `'${agTab}'!A1`, agRows);
        await updateValues(state.spreadsheetId, `'${phTab}'!A1:H1`, [['PhotoID', 'UploadedAt', 'UploadedBy', 'DayDate', 'Caption', 'DriveFileId', 'ImageUrl', 'MimeType']]);
        await appendValues(state.spreadsheetId, "'Trips_Index'!A:L", [[
          summary.tripId, summary.tripName, summary.destination, summary.startDate, summary.endDate,
          summary.baseCurrency, summary.coverPhotoUrl, summary.driveFolderId,
          summary.expensesTabName, summary.agendaTabName, summary.settingsTabName, summary.status
        ]]);
        await refreshAllTrips();
        state.activeTripId = summary.tripId;
        showToast(`Created ${tripName}!`);
      } catch (e) {
        state.syncStatus = 'error'; showToast(e.message);
      }
      render();
    });
  });
}

function openExpenseModal(ws, existing, prefill) {
  let type = existing ? existing.type : prefill ? 'PAYMENT' : 'EXPENSE';
  let splitMode = existing ? existing.splitMode : prefill ? 'DIRECT_PAYMENT' : 'EQUAL';
  let paidBy = existing
    ? (ws.roster.find((p) => p.personId === existing.paidByPersonId || p.displayName === existing.paidByName) || ws.roster[0])
    : prefill
      ? (ws.roster.find((p) => p.personId === prefill.fromPersonId) || ws.roster[0])
      : (ws.roster.find((p) => p.displayName.toLowerCase() === state.selectedIdentity.toLowerCase()) || ws.roster[0]);
  const benSet = new Set(
    existing ? Object.entries(existing.allocationsByPersonId).filter(([, v]) => v > 0).map(([k]) => k)
      : prefill ? [prefill.toPersonId]
      : ws.roster.map((p) => p.personId)
  );
  const customMap = { ...(existing?.allocationsByPersonId || {}) };
  const initCurrency = existing?.currency || ws.baseCurrency;
  const initFx = existing?.fxRateToBase || latestFxRate(ws.fxRateHistory, initCurrency, ws.baseCurrency);

  showModal(`
    <div style="display:flex; justify-content:space-between; align-items:center;">
      <h3 style="margin:0;">${existing ? 'Edit Entry' : 'Add Expense / Payment'}</h3>
      ${existing ? `<button class="btn-outline btn-sm" id="delExpBtn" style="color:var(--red);">Delete</button>` : ''}
    </div>
    <div class="seg" style="margin-top:10px;">
      <button id="mTypeExp" class="${type === 'EXPENSE' ? 'active' : ''}">Expense</button>
      <button id="mTypePay" class="${type === 'PAYMENT' ? 'active' : ''}">Payment</button>
    </div>
    <div class="row-2">
      <div class="field"><label>Amount</label><input id="expAmt" type="number" step="0.01" value="${existing ? existing.originalAmount : prefill ? prefill.amount : ''}" /></div>
      <div class="field"><label>Currency</label>
        <select id="expCurr">${ws.activeCurrencies.map((c) => `<option value="${c}" ${c === initCurrency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
    </div>
    <div class="field" id="fxRow" style="${initCurrency === ws.baseCurrency ? 'display:none;' : ''}">
      <label>FX Rate (1 <span id="fxCurrLbl">${initCurrency}</span> = ? ${esc(ws.baseCurrency)})</label>
      <input id="expFx" type="number" step="0.0001" value="${initFx}" />
    </div>
    <div class="row-2">
      <div class="field"><label>Title</label><input id="expTitle" value="${esc(existing?.title || (prefill ? `Settle up: ${prefill.fromName} → ${prefill.toName}` : ''))}" placeholder="Dinner, Hotel..." /></div>
      <div class="field"><label>Date</label><input id="expDate" type="date" value="${existing?.date || new Date().toISOString().slice(0, 10)}" /></div>
    </div>
    <div class="field" id="catRow" style="${type === 'PAYMENT' ? 'display:none;' : ''}">
      <label>Category</label>
      <select id="expCat">${CATEGORIES.map((c) => `<option ${c === existing?.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Paid By</label>
      <div class="chips-wrap" id="paidByChips">${ws.roster.map((p) => `<button type="button" class="chip ${p.personId === paidBy.personId ? 'active' : 'outline'}" data-pid="${p.personId}">${esc(p.displayName)}</button>`).join('')}</div>
    </div>
    <div class="field"><label id="benLbl">${type === 'PAYMENT' ? 'Paid To' : 'Split With'}</label>
      <div class="chips-wrap" id="benChips">${ws.roster.map((p) => `<button type="button" class="chip ${benSet.has(p.personId) ? 'active' : 'outline'}" data-pid="${p.personId}">${esc(p.displayName)}</button>`).join('')}</div>
    </div>
    <div class="field" id="splitModeRow" style="${type === 'PAYMENT' ? 'display:none;' : ''}">
      <label>Split Mode</label>
      <select id="expSplitMode">
        <option value="EQUAL" ${splitMode === 'EQUAL' ? 'selected' : ''}>Equal</option>
        <option value="EXACT_AMOUNTS" ${splitMode === 'EXACT_AMOUNTS' ? 'selected' : ''}>Exact Amounts (${esc(ws.baseCurrency)})</option>
        <option value="SHARES" ${splitMode === 'SHARES' ? 'selected' : ''}>Shares (1x, 2x)</option>
        <option value="PERCENTAGES" ${splitMode === 'PERCENTAGES' ? 'selected' : ''}>Percentages (%)</option>
      </select>
    </div>
    <div id="customSplitInputs"></div>
    <div class="field"><label>Notes</label><input id="expNotes" value="${esc(existing?.notes || '')}" placeholder="Optional" /></div>
    <div class="row-2">
      <button class="btn-outline" id="expCancelBtn">Cancel</button>
      <button class="btn-primary" id="expSaveBtn">Save</button>
    </div>`, () => {
    const renderCustom = () => {
      const box = document.getElementById('customSplitInputs');
      if (type === 'PAYMENT' || splitMode === 'EQUAL') { box.innerHTML = ''; return; }
      box.innerHTML = [...benSet].map((pid) => {
        const nm = ws.roster.find((p) => p.personId === pid)?.displayName || pid;
        return `<div class="field"><label>${esc(nm)} (${splitMode === 'PERCENTAGES' ? '%' : splitMode === 'SHARES' ? 'shares' : ws.baseCurrency})</label>
          <input class="custom-split-in" data-pid="${pid}" type="number" step="0.01" value="${customMap[pid] ?? ''}" /></div>`;
      }).join('');
      box.querySelectorAll('.custom-split-in').forEach((inp) => inp.addEventListener('input', () => { customMap[inp.dataset.pid] = inp.value; }));
    };
    renderCustom();

    document.getElementById('mTypeExp').addEventListener('click', () => {
      type = 'EXPENSE'; if (splitMode === 'DIRECT_PAYMENT') splitMode = 'EQUAL';
      document.getElementById('mTypeExp').classList.add('active');
      document.getElementById('mTypePay').classList.remove('active');
      document.getElementById('catRow').style.display = '';
      document.getElementById('splitModeRow').style.display = '';
      document.getElementById('benLbl').textContent = 'Split With';
      renderCustom();
    });
    document.getElementById('mTypePay').addEventListener('click', () => {
      type = 'PAYMENT'; splitMode = 'DIRECT_PAYMENT';
      document.getElementById('mTypePay').classList.add('active');
      document.getElementById('mTypeExp').classList.remove('active');
      document.getElementById('catRow').style.display = 'none';
      document.getElementById('splitModeRow').style.display = 'none';
      document.getElementById('benLbl').textContent = 'Paid To';
      renderCustom();
    });
    document.getElementById('expCurr').addEventListener('change', (e) => {
      const c = e.target.value;
      document.getElementById('fxCurrLbl').textContent = c;
      document.getElementById('fxRow').style.display = c === ws.baseCurrency ? 'none' : '';
      document.getElementById('expFx').value = latestFxRate(ws.fxRateHistory, c, ws.baseCurrency);
    });
    document.getElementById('expSplitMode').addEventListener('change', (e) => { splitMode = e.target.value; renderCustom(); });
    document.querySelectorAll('#paidByChips .chip').forEach((b) => b.addEventListener('click', () => {
      paidBy = ws.roster.find((p) => p.personId === b.dataset.pid);
      document.querySelectorAll('#paidByChips .chip').forEach((x) => { x.classList.toggle('active', x === b); x.classList.toggle('outline', x !== b); });
    }));
    document.querySelectorAll('#benChips .chip').forEach((b) => b.addEventListener('click', () => {
      if (type === 'PAYMENT') {
        benSet.clear(); benSet.add(b.dataset.pid);
        document.querySelectorAll('#benChips .chip').forEach((x) => { x.classList.toggle('active', x === b); x.classList.toggle('outline', x !== b); });
      } else {
        if (benSet.has(b.dataset.pid)) benSet.delete(b.dataset.pid); else benSet.add(b.dataset.pid);
        b.classList.toggle('active'); b.classList.toggle('outline');
      }
      renderCustom();
    }));
    document.getElementById('expCancelBtn').addEventListener('click', closeModal);
    document.getElementById('delExpBtn')?.addEventListener('click', async () => {
      closeModal(); state.syncStatus = 'syncing'; render();
      try {
        const tab = ws.summary.expensesTabName;
        const map = await getSheetMap(state.spreadsheetId);
        const ids = await getValues(state.spreadsheetId, `'${tab}'!A1:A1000`);
        const idx = ids.findIndex((r) => (r[0] || '').trim() === existing.entryId);
        if (idx >= 14) {
          await deleteRow(state.spreadsheetId, map[tab], idx + 1);
          const rem = ws.expenses.filter((x) => x.entryId !== existing.entryId);
          if (rem.length) {
            await updateValues(state.spreadsheetId, `'${tab}'!A15`, rem.map((e, i) => buildExpenseSheetRow(e, ws.roster, 15 + i)));
          }
          await syncSettlementSummary(ws, rem);
          state.workspaces[ws.summary.tripId] = await loadWorkspace(ws.summary);
        }
        state.syncStatus = 'synced'; showToast('Entry deleted.');
      } catch (e) { state.syncStatus = 'error'; showToast(e.message); }
      render();
    });

    document.getElementById('expSaveBtn').addEventListener('click', async () => {
      const origAmt = Number(document.getElementById('expAmt').value);
      const curr = document.getElementById('expCurr').value;
      const fx = curr === ws.baseCurrency ? 1.0 : (Number(document.getElementById('expFx').value) || 1.0);
      const baseAmt = roundCents(origAmt * fx);
      if (!(origAmt > 0)) { showToast('Enter a positive amount.'); return; }
      let allocations;
      try {
        allocations = computeSplitAllocations(baseAmt, type === 'PAYMENT' ? 'DIRECT_PAYMENT' : splitMode, [...benSet], customMap);
      } catch (e) { showToast(e.message); return; }

      const entry = {
        entryId: existing?.entryId || uuid(),
        date: document.getElementById('expDate').value,
        type,
        title: document.getElementById('expTitle').value.trim() || (type === 'PAYMENT' ? 'Payment' : 'Expense'),
        category: type === 'PAYMENT' ? 'Settlement' : document.getElementById('expCat').value,
        paidByPersonId: paidBy.personId,
        paidByName: paidBy.displayName,
        originalAmount: roundCents(origAmt),
        currency: curr,
        fxRateToBase: fx,
        baseAmount: baseAmt,
        splitMode: type === 'PAYMENT' ? 'DIRECT_PAYMENT' : splitMode,
        notes: document.getElementById('expNotes').value.trim(),
        allocationsByPersonId: allocations
      };

      closeModal(); state.syncStatus = 'syncing'; render();
      try {
        const tab = ws.summary.expensesTabName;
        const rowsA = await getValues(state.spreadsheetId, `'${tab}'!A1:A1000`);
        let matchRow = null;
        for (let i = 14; i < rowsA.length; i++) {
          if ((rowsA[i][0] || '').trim() === entry.entryId) { matchRow = i + 1; break; }
        }
        if (matchRow) {
          await updateValues(state.spreadsheetId, `'${tab}'!A${matchRow}`, [buildExpenseSheetRow(entry, ws.roster, matchRow)]);
        } else {
          const nextRow = Math.max(rowsA.length + 1, 15);
          await appendValues(state.spreadsheetId, `'${tab}'!A14`, [buildExpenseSheetRow(entry, ws.roster, nextRow)]);
          const verify = await getValues(state.spreadsheetId, `'${tab}'!A15:A1000`);
          const fIdx = verify.findIndex((r) => (r[0] || '').trim() === entry.entryId);
          if (fIdx < 0) throw new Error('Read-after-write verification failed.');
          if (15 + fIdx !== nextRow) {
            await updateValues(state.spreadsheetId, `'${tab}'!A${15 + fIdx}`, [buildExpenseSheetRow(entry, ws.roster, 15 + fIdx)]);
          }
        }
        const nextEntries = matchRow ? ws.expenses.map((x) => x.entryId === entry.entryId ? entry : x) : [...ws.expenses, entry];
        await syncSettlementSummary(ws, nextEntries);
        state.workspaces[ws.summary.tripId] = await loadWorkspace(ws.summary);
        state.syncStatus = 'synced'; showToast('Saved & verified.');
      } catch (e) { state.syncStatus = 'error'; showToast(e.message); }
      render();
    });
  });
}

function openEditDayModal(ws, day) {
  let author = ws.roster[0]?.displayName || 'Donald';
  const plans = { ...(day.personPlans || {}) };
  showModal(`
    <h3>Edit Day ${day.dayNumber} (${formatShortDate(day.date)})</h3>
    <div class="field"><label>Day Title</label><input id="edTitle" value="${esc(day.dayTitle)}" /></div>
    <div class="field"><label>Shared Group Plan</label><textarea id="edShared" rows="3">${esc(day.sharedPlan)}</textarea></div>
    <div class="field"><label>Links &amp; Notes</label><textarea id="edLinks" rows="2">${esc(day.linksAndNotes)}</textarea></div>
    <div class="field"><label>Person Column Draft</label>
      <div class="chips-scroll" id="edAuthorChips">${ws.roster.map((p) => `<button type="button" class="chip ${p.displayName === author ? 'active' : 'outline'}" data-name="${esc(p.displayName)}">${esc(p.displayName)}</button>`).join('')}</div>
    </div>
    <div class="field"><label id="edAuthorLbl">${esc(author)}'s Notes / Links</label><textarea id="edAuthorTxt" rows="3">${esc(plans[author] || '')}</textarea></div>
    <div class="row-2">
      <button class="btn-outline" id="edCancel">Cancel</button>
      <button class="btn-primary" id="edSave">Save to Sheet</button>
    </div>`, () => {
    document.querySelectorAll('#edAuthorChips .chip').forEach((b) => b.addEventListener('click', () => {
      plans[author] = document.getElementById('edAuthorTxt').value;
      author = b.dataset.name;
      document.getElementById('edAuthorLbl').textContent = `${author}'s Notes / Links`;
      document.getElementById('edAuthorTxt').value = plans[author] || '';
      document.querySelectorAll('#edAuthorChips .chip').forEach((x) => { x.classList.toggle('active', x === b); x.classList.toggle('outline', x !== b); });
    }));
    document.getElementById('edCancel').addEventListener('click', closeModal);
    document.getElementById('edSave').addEventListener('click', () => {
      plans[author] = document.getElementById('edAuthorTxt').value;
      const updated = {
        ...day,
        dayTitle: document.getElementById('edTitle').value.trim(),
        sharedPlan: document.getElementById('edShared').value.trim(),
        linksAndNotes: document.getElementById('edLinks').value.trim(),
        personPlans: plans
      };
      closeModal(); saveAgendaDay(ws, updated);
    });
  });
}

function openImageModal(ws, title, initialUrl, defaultQuery, onConfirm) {
  showModal(`
    <h3>${esc(title)}</h3>
    <div class="field"><label>Image URL</label><input id="imgUrlIn" value="${esc(initialUrl)}" placeholder="https://..." /></div>
    <div class="row-2" style="margin-bottom:10px;">
      <a class="btn-outline" style="text-align:center; text-decoration:none;" target="_blank" rel="noopener noreferrer" href="https://www.google.com/search?tbm=isch&q=${encodeURIComponent(defaultQuery || 'travel')}">Search Google Images</a>
      <button type="button" class="btn-outline" id="imgUpBtn">Upload Photo</button>
      <input type="file" id="imgUpIn" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" class="hidden" />
    </div>
    <div style="height:140px; border-radius:12px; background:var(--ice); overflow:hidden; margin-bottom:12px; display:flex; align-items:center; justify-content:center;">
      <img id="imgPrev" src="${esc(initialUrl)}" style="width:100%; height:100%; object-fit:cover; ${initialUrl ? '' : 'display:none;'}" />
    </div>
    <div class="row-2">
      <button class="btn-outline" id="imgCancel">Cancel</button>
      <button class="btn-primary" id="imgSave">Save Image</button>
    </div>`, () => {
    const inp = document.getElementById('imgUrlIn');
    const prev = document.getElementById('imgPrev');
    inp.addEventListener('input', () => { prev.src = inp.value; prev.style.display = inp.value ? '' : 'none'; });
    document.getElementById('imgUpBtn').addEventListener('click', () => document.getElementById('imgUpIn').click());
    document.getElementById('imgUpIn').addEventListener('change', async (ev) => {
      const f = ev.target.files?.[0]; if (!f) return;
      if ((f.type || '').startsWith('video/')) { showToast('Only photos are allowed in QMAT Trips.'); return; }
      try {
        showToast('Uploading image...');
        const up = await uploadToTripOrPersonalFolder(ws.summary.driveFolderId, ws.summary.tripName, f.name, f.type || 'image/jpeg', f);
        inp.value = up.imageUrl; prev.src = up.imageUrl; prev.style.display = '';
      } catch (e) { showToast(e.message); }
    });
    document.getElementById('imgCancel').addEventListener('click', closeModal);
    document.getElementById('imgSave').addEventListener('click', () => { const u = inp.value.trim(); closeModal(); onConfirm(u); });
  });
}

function openPhotoUploadModal(ws, file) {
  const days = enumerateDays(ws.summary.startDate, ws.summary.endDate);
  let dayDate = state.photoDayFilter !== 'ALL' ? state.photoDayFilter : (days[0] || ws.summary.startDate);
  const previewUrl = URL.createObjectURL(file);
  showModal(`
    <h3>Upload Trip Photo</h3>
    <img src="${previewUrl}" style="width:100%; height:170px; object-fit:cover; border-radius:12px; margin-bottom:10px;" />
    <div class="field"><label>Caption (optional)</label><input id="phCap" placeholder="View from the ridge..." /></div>
    <div class="field"><label>Trip Day</label>
      <div class="chips-scroll" id="phDayChips">${days.map((d) => `<button type="button" class="chip ${d === dayDate ? 'active' : 'outline'}" data-d="${d}">${formatShortDate(d)}</button>`).join('')}</div>
    </div>
    <div class="row-2">
      <button class="btn-outline" id="phCancel">Cancel</button>
      <button class="btn-primary" id="phUpload">Upload Photo</button>
    </div>`, () => {
    document.querySelectorAll('#phDayChips .chip').forEach((b) => b.addEventListener('click', () => {
      dayDate = b.dataset.d;
      document.querySelectorAll('#phDayChips .chip').forEach((x) => { x.classList.toggle('active', x === b); x.classList.toggle('outline', x !== b); });
    }));
    document.getElementById('phCancel').addEventListener('click', closeModal);
    document.getElementById('phUpload').addEventListener('click', async () => {
      const caption = document.getElementById('phCap').value.trim();
      closeModal(); state.syncStatus = 'syncing'; render();
      try {
        const { fileId, imageUrl } = await uploadToTripOrPersonalFolder(ws.summary.driveFolderId, ws.summary.tripName, file.name, file.type || 'image/jpeg', file);
        const photo = {
          photoId: uuid().slice(0, 8), uploadedAt: new Date().toISOString(),
          uploadedBy: state.selectedIdentity || state.session.displayName,
          dayDate, caption, driveFileId: fileId, imageUrl, mimeType: file.type || 'image/jpeg'
        };
        await appendValues(state.spreadsheetId, `'${ws.summary.photosTabName}'!A:H`, [[
          photo.photoId, photo.uploadedAt, photo.uploadedBy, photo.dayDate, photo.caption, photo.driveFileId, photo.imageUrl, photo.mimeType
        ]]);
        state.workspaces[ws.summary.tripId] = { ...ws, photos: [photo, ...ws.photos] };
        state.syncStatus = 'synced'; showToast('Photo uploaded!');
      } catch (e) { state.syncStatus = 'error'; showToast(e.message); }
      render();
    });
  });
}

function openPhotoViewerModal(photo) {
  const dlUrl = photo.driveFileId ? `https://drive.google.com/uc?export=download&id=${photo.driveFileId}` : photo.imageUrl;
  showModal(`
    <div style="text-align:center;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
        <strong>By ${esc(photo.uploadedBy)} &middot; ${formatShortDate(photo.dayDate)}</strong>
        <button class="btn-outline btn-sm" id="pvClose">Close</button>
      </div>
      <img src="${esc(photo.imageUrl)}" style="max-width:100%; max-height:62vh; border-radius:12px; object-fit:contain; background:#000;" />
      ${photo.caption ? `<p style="margin:8px 0;">${esc(photo.caption)}</p>` : ''}
      <a class="btn-primary" style="display:inline-block; text-decoration:none; margin-top:10px;" href="${esc(dlUrl)}" target="_blank" rel="noopener noreferrer" download>Download / Save Photo</a>
    </div>`, () => {
    document.getElementById('pvClose').addEventListener('click', closeModal);
  });
}

// --- Boot ---
loadStored();
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
render();
if (state.session.accessToken && Date.now() < state.session.expiresAt && state.spreadsheetId) {
  refreshAllTrips();
} else if (state.session.accessToken && state.spreadsheetId) {
  state.syncStatus = 'error';
  state.syncError = 'Session expired. Tap Retry / Re-auth.';
  render();
}
