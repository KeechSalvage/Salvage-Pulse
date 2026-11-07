// ================= EMBEDDED MODE (Salvage Pulse iframe) =================
const EMBED_PARAMS = new URLSearchParams(window.location.search);
const EMBED_MODE = EMBED_PARAMS.get('embed') === '1';
const EMBED_USER = (EMBED_PARAMS.get('user') || '').trim();
const EMBED_ROLE = (EMBED_PARAMS.get('role') || '').trim();
const EMBED_ORG = (EMBED_PARAMS.get('org') || '').trim();

// Keep an uploaded report per yard/user so leaving the page does not discard
// it.  The old global key was shared by every login on the browser, so drop it.
const SAVED_SESSION_KEY = 'sp_saved_deliveries:' + (EMBED_ORG || EMBED_USER || 'standalone');
try {
  // Migrate the previous user-scoped key (created before the iframe passed the
  // org id) and remove the old cross-yard global key.
  if (EMBED_ORG && EMBED_USER) {
    const userKey = 'sp_saved_deliveries:' + EMBED_USER;
    const legacy = localStorage.getItem(userKey);
    if (legacy && !localStorage.getItem(SAVED_SESSION_KEY)) {
      localStorage.setItem(SAVED_SESSION_KEY, legacy);
    }
    localStorage.removeItem(userKey);
  }
  localStorage.removeItem('sp_saved_deliveries');
} catch (e) {}

if (EMBED_USER) {
  window.PULSE_USER = EMBED_USER;
  // Mirror into localStorage so the identity survives navigating within the frame.
  try { localStorage.setItem('sp_current_user', EMBED_USER); } catch (e) {}
}
if (EMBED_MODE) document.body.classList.add('embedded');

// ================= APP STATE =================
let allRows = [];
let activeMetricFilter = null; // null | 'deliveries' | 'assigned' | 'unassigned' | 'matches'
let editingRowPartId = null;   // row id whose part cell is being edited inline
let salespersonName = '';
let reportDate = '';
let hasUnsavedChanges = false;
let lastSavedSnapshot = null;
let lastSavedTime = null;

// ================= PLATFORM API =================
// All persistence (parts, customers, uploads, announcement calls) now goes
// through the authenticated same-origin API. The dashboard no longer holds a
// database URL or key in the browser.
const API_BASE = '/api/delivery';
const SB_CACHE_KEY = 'sp_delivery_parts_cache';
console.info('[delivery-dash] build 2026-11-07 — platform API');

function apiFailure(err) {
  if (err && err.name === 'TypeError' && /fetch/i.test(err.message || '')) {
    return new Error('Could not reach the platform API. Hard-refresh the page; if it persists, the dashboard bundle is stale or the server is offline.');
  }
  return err;
}

// Drop credentials cached by the old Supabase-backed build. They are no longer
// used, and leaving a database key in localStorage serves no purpose.
['sp_supabase_config', 'sp_supabase_parts_cache', 'sp_call_config'].forEach(key => {
  try { localStorage.removeItem(key); } catch (e) {}
});

let partRows = [];              // [{ name, id, tokens, norm, sorted }]
let partIndex = new Map();      // normalized token string -> record
let partSortedIndex = new Map();// alphabetically sorted tokens -> record
let partLastSynced = null;
let partSource = 'bundled';     // 'server' | 'cache' | 'bundled'
let partFetching = false;

const PART_ABBREVIATIONS = {
  assy: 'assembly', assem: 'assembly', comp: 'complete', pkg: 'package',
  pnl: 'panel', qtr: 'quarter', susp: 'suspension', trans: 'transmission',
  trk: 'truck', eng: 'engine', win: 'window', wdo: 'window',
  rf: 'front right', lf: 'front left', rr: 'rear right', lr: 'rear left',
  fr: 'front', fl: 'front left', w: 'with', wo: 'without'
};

// Last successful server payload, so refreshes survive a reload offline.
try {
  const cached = JSON.parse(localStorage.getItem(SB_CACHE_KEY) || 'null');
  if (cached && Array.isArray(cached.parts) && cached.parts.length) {
    partRows = cached.parts;
    partLastSynced = cached.fetchedAt || null;
    partSource = 'cache';
  }
} catch (e) {}

// Bundled copy shipped with the site (js/hollander-parts.js).
if (!partRows.length && Array.isArray(window.HOLLANDER_PARTS)) {
  partRows = window.HOLLANDER_PARTS.map(p => ({ name: p.name, id: String(p.id) }));
  partSource = 'bundled';
}

// ================= CUSTOMER LOOKUP STATE =================
const CUST_CACHE_KEY = 'sp_customers_cache_v3';
const CUST_CACHE_HOURS = 12;
let dbCustomers = [];        // [{ name, address1, address2, city, state, zip, phone, norm }]
let dbCustomerIndex = new Map();   // normalized shop name -> customer
let dbCustomerPhoneIndex = new Map(); // digits-only phone -> customer
let customersLastSynced = null;
let customersFetching = false;

try {
  const cachedCustomers = JSON.parse(localStorage.getItem(CUST_CACHE_KEY) || 'null');
  if (cachedCustomers && Array.isArray(cachedCustomers.customers) && cachedCustomers.customers.length) {
    dbCustomers = cachedCustomers.customers;
    customersLastSynced = cachedCustomers.fetchedAt || null;
  }
} catch (e) {}


// Team Reps (Rich Brauns is included as active salesperson)
const DEFAULT_REPS = [
  { id: "rich", name: "Rich Brauns", desk: "Desk #1", role: "Sales Counter", color: "#3A6AF0" },
  { id: "jake", name: "Jake Martinez", desk: "Desk #4", role: "Counter Sales Rep", color: "#34D399" },
  { id: "sarah", name: "Sarah Jenkins", desk: "Desk #2", role: "Commercial Accounts", color: "#A78BFA" },
  { id: "mike", name: "Mike Ross", desk: "Desk #3", role: "Drivetrain Specialist", color: "#fbbf24" },
  { id: "dave", name: "Dave Miller", desk: "Desk #5", role: "Sheet Metal & Collision", color: "#f87171" }
];

// Call Records matching phone numbers directly from the report attachment
const DEFAULT_CALLS = [
  { phone: "1 (860) 261-7542", customer: "Wrench Rite LLC.", rep: "Rich Brauns", time: "10/30, 8:15 AM", category: "Order/Sale", notes: "Window RF door order confirmed for morning run." },
  { phone: "1 (860) 528-9161", customer: "Crash Champions, LLC - East Hartford", rep: "Rich Brauns", time: "10/30, 9:20 AM", category: "Order/Sale", notes: "PO: 779004686 confirmed, rear bumper." },
  { phone: "1 (203) 932-2300", customer: "BRUNEAU'S GARAGE", rep: "Mike Ross", time: "10/30, 9:45 AM", category: "Order/Sale", notes: "Transmission pulled and tested, order 215737." },
  { phone: "1 (914) 723-9200", customer: "Curry Chevrolet", rep: "Sarah Jenkins", time: "10/30, 1:40 PM", category: "Part Inquiry/Quote", notes: "Quarter panel left, PO 206566." },
  { phone: "1 (845) 348-7777", customer: "SPECTRUM AUTO SALES", rep: "Rich Brauns", time: "10/30, 11:50 AM", category: "Order/Sale", notes: "Crossmember + Complete rear suspension." },
  { phone: "1 (203) 237-6464", customer: "Zoel's Body & Auto Center", rep: "Jake Martinez", time: "10/30, 10:00 AM", category: "Order/Sale", notes: "Headlamp R order & bumper reinforcement return RMA." }
];

let reps = JSON.parse(localStorage.getItem('sp_dashboard_reps')) || DEFAULT_REPS;
let calls = JSON.parse(localStorage.getItem('sp_dashboard_calls')) || DEFAULT_CALLS;
let targetUrl = localStorage.getItem('sp_target_url') || '';

// Salesperson matching and auto-assignment helpers
function findRepMatch(name) {
  if (!name) return null;
  const clean = name.trim().toLowerCase();
  // Exact match
  let found = reps.find(r => r.name.toLowerCase() === clean);
  if (found) return found;

  // Partial / contains match
  found = reps.find(r => r.name.toLowerCase().includes(clean) || clean.includes(r.name.toLowerCase()));
  if (found) return found;

  // First & last name match
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    found = reps.find(r => {
      const repParts = r.name.toLowerCase().split(/\s+/).filter(Boolean);
      return repParts[0] === parts[0] && repParts[repParts.length - 1] === parts[parts.length - 1];
    });
    if (found) return found;
  }
  return null;
}

function getOrAddRep(name) {
  if (!name) return null;
  const cleanName = name.replace(/["'|]/g, '').trim();
  if (!cleanName) return null;
  let rep = findRepMatch(cleanName);
  if (!rep) {
    const nextDeskNum = reps.length + 1;
    rep = {
      id: 'rep_' + Date.now(),
      name: cleanName,
      desk: `Desk #${nextDeskNum}`,
      role: 'Sales Rep',
      color: '#3A6AF0'
    };
    reps.push(rep);
    saveReps();
    if (typeof updateRepDropdowns === 'function') updateRepDropdowns();
  }
  return rep;
}

function detectRepFromFileName(filename) {
  if (!filename) return null;
  const cleanName = filename.toLowerCase().replace(/[^a-z0-9]/g, ' ');
  for (const rep of reps) {
    const repClean = rep.name.toLowerCase();
    if (cleanName.includes(repClean)) return rep.name;
    const parts = repClean.split(' ');
    if (parts.length > 1 && cleanName.includes(parts[0]) && cleanName.includes(parts[parts.length - 1])) {
      return rep.name;
    }
  }
  return null;
}

// DOM Elements
const dropZone = document.getElementById('dropZone');
const dropZoneContent = document.getElementById('dropZoneContent');
const fileInput = document.getElementById('fileInput');
const chooseReportBtn = document.getElementById('chooseReportBtn');
const results = document.getElementById('results');
const tableBody = document.getElementById('tableBody');
const searchInput = document.getElementById('search');
const repFilter = document.getElementById('repFilter');
const resetFiltersBtn = document.getElementById('resetFilters');

const activeFilterBanner = document.getElementById('activeFilterBanner');
const activeFilterName = document.getElementById('activeFilterName');
const activeFilterCount = document.getElementById('activeFilterCount');
const clearActiveFilterBtn = document.getElementById('clearActiveFilterBtn');

// Modals
const teamModal = document.getElementById('teamModal');
const metricDetailModal = document.getElementById('metricDetailModal');

// Setup Drag & Drop & Upload Button
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
if (chooseReportBtn) {
  chooseReportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });
}
resetDropZoneHTML();

// Filters (Only applied when 'Apply Filter' is clicked or Enter is pressed)
let appliedSearch = '';
let appliedRep = '';

function applyFilters() {
  appliedSearch = (searchInput ? searchInput.value : '').toLowerCase().trim();
  appliedRep = repFilter ? repFilter.value : '';
  renderTable();
}

const applyFiltersBtn = document.getElementById('applyFiltersBtn');
if (applyFiltersBtn) {
  applyFiltersBtn.addEventListener('click', applyFilters);
}

if (searchInput) {
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      applyFilters();
    }
  });
}

if (resetFiltersBtn) {
  resetFiltersBtn.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    if (repFilter) repFilter.value = '';
    appliedSearch = '';
    appliedRep = '';
    clearCardFilter();
  });
}
clearActiveFilterBtn.addEventListener('click', clearCardFilter);

function clearCardFilter() {
  activeMetricFilter = null;
  activeFilterBanner.classList.add('hidden');
  updateMetrics();
  renderTable();
}

// Bulk Actions
const autoAssignAllBtn = document.getElementById('autoAssignAllBtn');
if (autoAssignAllBtn) autoAssignAllBtn.addEventListener('click', autoAssignAllCallMatches);
const applyBulkRepBtn = document.getElementById('applyBulkRepBtn');
if (applyBulkRepBtn) applyBulkRepBtn.addEventListener('click', applyBulkRepAssignment);

// Save Changes Buttons & Workflow
const headerSaveBtn = document.getElementById('headerSaveBtn');
if (headerSaveBtn) headerSaveBtn.addEventListener('click', () => saveChanges());
const bulkSaveBtn = document.getElementById('bulkSaveBtn');
if (bulkSaveBtn) bulkSaveBtn.addEventListener('click', () => saveChanges());
const bottomSaveBtn = document.getElementById('bottomSaveBtn');
if (bottomSaveBtn) bottomSaveBtn.addEventListener('click', () => saveChanges());
const stickySaveBtn = document.getElementById('stickySaveBtn');
if (stickySaveBtn) stickySaveBtn.addEventListener('click', () => saveChanges());
const stickyDiscardBtn = document.getElementById('stickyDiscardBtn');
if (stickyDiscardBtn) stickyDiscardBtn.addEventListener('click', discardChanges);
const stickyDismissBtn = document.getElementById('stickyDismissBtn');
if (stickyDismissBtn) stickyDismissBtn.addEventListener('click', () => document.getElementById('stickySaveBar').classList.add('hidden'));

document.getElementById('newFile').addEventListener('click', () => {
  if (hasUnsavedChanges && !confirm('You have unsaved changes. Discard and upload another report?')) {
    return;
  }
  results.classList.add('hidden');
  dropZone.classList.remove('hidden');
  resetDropZoneHTML();
  if (fileInput) fileInput.value = '';
  allRows = [];
  activeMetricFilter = null;
  appliedSearch = '';
  appliedRep = '';
  if (searchInput) searchInput.value = '';
  if (repFilter) repFilter.value = '';
  hasUnsavedChanges = false;
  lastSavedSnapshot = null;
  lastSavedTime = null;
  updateSaveStatusUI();
  document.getElementById('reportMetaTag').classList.add('hidden');
});
document.getElementById('downloadCsv').addEventListener('click', () => downloadFile(generateCSV(getFiltered()), 'deliveries.csv', 'text/csv'));

const openTeamModalBtn = document.getElementById('openTeamModal');
if (openTeamModalBtn) openTeamModalBtn.addEventListener('click', openTeamModal);
const closeTeamModalBtn = document.getElementById('closeTeamModal');
if (closeTeamModalBtn) closeTeamModalBtn.addEventListener('click', () => teamModal && teamModal.classList.add('hidden'));
const doneTeamModalBtn = document.getElementById('doneTeamModalBtn');
if (doneTeamModalBtn) doneTeamModalBtn.addEventListener('click', () => teamModal && teamModal.classList.add('hidden'));

document.getElementById('closeMetricDetailModal').addEventListener('click', () => metricDetailModal.classList.add('hidden'));
document.getElementById('closeMetricDetailFooterBtn').addEventListener('click', () => metricDetailModal.classList.add('hidden'));

// Metric Drilldown Tabs
document.querySelectorAll('[data-metric-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-metric-tab]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('#metricDetailModal .tab-content').forEach(c => c.classList.add('hidden'));
    btn.classList.add('active');
    const tabId = btn.getAttribute('data-metric-tab');
    document.getElementById(tabId).classList.remove('hidden');
  });
});

// Metric Drilldown Filter Buttons
document.getElementById('applyFilterAllDeliveriesBtn').addEventListener('click', () => {
  setCardFilter('deliveries', 'All Deliveries');
  metricDetailModal.classList.add('hidden');
});
document.getElementById('applyFilterAssignedOnlyBtn').addEventListener('click', () => {
  setCardFilter('assigned', 'Assigned Reps Only');
  metricDetailModal.classList.add('hidden');
});
document.getElementById('applyFilterUnassignedOnlyBtn').addEventListener('click', () => {
  setCardFilter('unassigned', 'Unassigned Deliveries');
  metricDetailModal.classList.add('hidden');
});
document.getElementById('applyFilterCallMatchesBtn').addEventListener('click', () => {
  setCardFilter('matches', 'Call Matches Only');
  metricDetailModal.classList.add('hidden');
});
document.getElementById('modalAutoAssignAllMatchesBtn').addEventListener('click', () => {
  autoAssignAllCallMatches();
  renderMetricDetailModal('matches');
});

function setCardFilter(filterKey, filterLabel) {
  activeMetricFilter = filterKey;
  activeFilterBanner.classList.remove('hidden');
  activeFilterName.textContent = filterLabel;
  updateMetrics();
  renderTable();
}

// Team & Call Records actions
const addNewRepPromptBtn = document.getElementById('addNewRepPromptBtn');
if (addNewRepPromptBtn) addNewRepPromptBtn.addEventListener('click', promptAddNewRep);
const restoreDefaultsBtn = document.getElementById('restoreDefaultsBtn');
if (restoreDefaultsBtn) restoreDefaultsBtn.addEventListener('click', () => {
  if (confirm('Reset reps and call records to default sample data?')) {
    reps = [...DEFAULT_REPS];
    calls = [...DEFAULT_CALLS];
    saveReps();
    saveCalls();
    renderTeamModal();
    updateRepDropdowns();
    reevaluateSuggestions();
    renderTable();
    showToast('Reset to defaults!');
  }
});

const callCsvInput = document.getElementById('callCsvInput');
if (callCsvInput) callCsvInput.addEventListener('change', e => {
  if (e.target.files[0]) handleCallCsvUpload(e.target.files[0]);
});

// ================= EXACT PARSING FOR SALESPERSON DELIVERY REPORT =================
// Col 1: Customer & Phone
// Col 3: Order, Invoice, PO
// Col 4: Part
async function handleFile(file) {
  if (!file) return;
  const name = (file.name || '').toLowerCase();

  if (dropZoneContent) {
    dropZoneContent.innerHTML = `
      <div class="spinner" aria-hidden="true"></div>
      <h3 style="margin:0 0 0.4rem 0; font-size:1.05rem; font-weight:600;">Reading delivery report…</h3>
      <p style="color:var(--text-muted); font-size:0.85rem; margin:0;">
        Extracting customer deliveries, reference numbers, and parts...
      </p>
    `;
  }

  try {
    if (name.endsWith('.csv') || (file.type && file.type.includes('csv'))) {
      const text = await file.text();
      allRows = parseCSVReport(text);
    } else {
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      allRows = await extractAndParsePDF(pdf);
    }

    if (!allRows || allRows.length === 0) {
      alert('File was opened, but no delivery rows were detected.\n\nPlease make sure the report has customer delivery lines.');
      resetDropZoneHTML();
      return;
    }

    // Check if filename has salesperson name if not detected in report body
    if (!salespersonName && file && file.name) {
      const fnRep = detectRepFromFileName(file.name);
      if (fnRep) salespersonName = fnRep;
    }

    // Auto-assign to recognized salesperson from report header
    let targetRep = null;
    if (salespersonName) {
      targetRep = getOrAddRep(salespersonName);
    }

    allRows.forEach((r, idx) => {
      r.id = 'row_' + idx + '_' + Date.now();
      if (targetRep) {
        r.assignedRep = targetRep.name;
      } else if (!r.assignedRep) {
        r.assignedRep = '';
      }
      r.suggestion = findCallMatch(r.Customer, r.Phone);
    });

    applyDatabaseLookups(allRows);

    dropZone.classList.add('hidden');
    results.classList.remove('hidden');
    activeMetricFilter = null;
    activeFilterBanner.classList.add('hidden');
    appliedSearch = '';
    appliedRep = '';
    if (searchInput) searchInput.value = '';
    if (repFilter) repFilter.value = '';

    if (salespersonName) {
      document.getElementById('reportMetaTag').classList.remove('hidden');
      document.getElementById('reportMetaText').innerHTML = `
        Report for: <b>${esc(salespersonName)}</b>
        &bull; <span style="color:var(--success); font-weight:700;">Auto-Assigned to ${esc(targetRep ? targetRep.name : salespersonName)}</span>
        &bull; Date: ${esc(reportDate || 'Today')}
      `;
    }

    updateRepDropdowns();
    updateMetrics();
    renderTable();

    lastSavedSnapshot = JSON.stringify(allRows);
    hasUnsavedChanges = false;
    lastSavedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    updateSaveStatusUI();
    persistReportSession();

    if (targetRep) {
      showToast(`Loaded ${allRows.length} delivery items & auto-assigned to ${targetRep.name}!`);
    } else {
      showToast(`Loaded ${allRows.length} delivery items!`);
    }

    // Record this upload for manager utilization reporting.
    (async () => {
      let uploader = getCurrentUser();
      if (!uploader) uploader = await openUserModal(true);
      recordUpload(uploader || 'Unassigned', file.name);
    })();
  } catch (err) {
    console.error('Error reading report:', err);
    alert('Error reading report:\n' + err.message);
    resetDropZoneHTML();
  } finally {
    if (fileInput) fileInput.value = '';
  }
}

function restoreSavedSession(options = {}) {
  const saved = localStorage.getItem(SAVED_SESSION_KEY);
  if (!saved) return;
  try {
    const data = JSON.parse(saved);
    if (!data.rows || !data.rows.length) return;
    allRows = data.rows;
    salespersonName = data.salespersonName || 'Rich Brauns';
    reportDate = data.reportDate || 'Saved Session';
    applyDatabaseLookups(allRows);
    lastSavedSnapshot = JSON.stringify(allRows);
    hasUnsavedChanges = false;
    lastSavedTime = data.savedAt ? new Date(data.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Earlier';

    dropZone.classList.add('hidden');
    results.classList.remove('hidden');
    activeMetricFilter = null;
    activeFilterBanner.classList.add('hidden');
    appliedSearch = '';
    appliedRep = '';
    if (searchInput) searchInput.value = '';
    if (repFilter) repFilter.value = '';

    document.getElementById('reportMetaTag').classList.remove('hidden');
    document.getElementById('reportMetaText').innerHTML = `
      Restored Saved Session &bull; Salesperson: <b>${esc(salespersonName)}</b>
      &bull; Date: ${esc(reportDate)} &bull; Saved: ${esc(lastSavedTime)}
    `;

    updateRepDropdowns();
    updateMetrics();
    renderTable();
    updateSaveStatusUI();
    if (!options.silent) showToast(`Restored ${allRows.length} saved deliveries!`);
  } catch (e) {
    if (!options.silent) alert('Could not restore saved session: ' + e.message);
  }
}

function resetDropZoneHTML() {
  if (dropZoneContent) {
    const saved = localStorage.getItem(SAVED_SESSION_KEY);
    let hasSaved = false;
    let savedCount = 0;
    try {
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.rows && parsed.rows.length) {
          hasSaved = true;
          savedCount = parsed.rows.length;
        }
      }
    } catch (e) {}

    dropZoneContent.innerHTML = `
      <div style="display:flex; justify-content:center; margin-bottom:0.75rem; color:var(--text-muted);">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/>
        </svg>
      </div>
      <h3 style="margin:0 0 0.35rem 0; font-size:1.05rem; font-weight:600;">Upload a delivery report</h3>
      <p style="margin:0 0 1rem; color:var(--text-muted); font-size:0.84rem;">Drop a PDF or CSV here, or choose a file.</p>
      <div style="display:flex; justify-content:center; gap:0.5rem; flex-wrap:wrap;">
        <button class="btn" id="chooseReportBtnInner" type="button">Choose Report File</button>
        ${hasSaved ? `<button class="btn btn-outline" id="restoreSavedBtnInner" type="button">Restore Saved Session (${savedCount})</button>` : ''}
      </div>
    `;
    const btnInner = document.getElementById('chooseReportBtnInner');
    if (btnInner) btnInner.addEventListener('click', () => fileInput.click());
    const restoreInner = document.getElementById('restoreSavedBtnInner');
    if (restoreInner) restoreInner.addEventListener('click', restoreSavedSession);
  }
}

// Clean formatting for car part names (whole cell in Column 4 is one car part)
// Preserves automotive acronyms (RF, LF, RR, LR, R, L, ABS, AWD, PO, etc.)
function formatPartName(str) {
  if (!str) return '';
  let cleaned = str
    .replace(/&amp;/g, '&')
    .replace(/^(?:Delivery|Pickup)\s+/gi, '')
    .replace(/\b(?:Yes|No|Pending|Pickup|RMA)\b/gi, '')
    .replace(/LID\/\s*GATE/i, 'Lid/Gate')
    .replace(/\s+/g, ' ')
    .trim();

  const acronyms = new Set([
    'RF', 'LF', 'RR', 'LR', 'RH', 'LH',
    'R', 'L', 'FR', 'FL',
    'ABS', 'AWD', '4WD', '2WD', 'FWD', 'RWD',
    'OEM', 'AC', 'A/C', 'ECM', 'TCM', 'BCM', 'VIN', 'LED', 'HID',
    'PO'
  ]);
  const minorWords = new Set(['and', 'or', 'of', 'for', 'with', 'in', 'on', 'at', 'to', 'the', 'a', 'an']);

  return cleaned.split(/\s+/).map((word, idx) => {
    const m = word.match(/^([^a-zA-Z0-9]*)([a-zA-Z0-9\/\-]+)([^a-zA-Z0-9]*)$/);
    if (!m) return word;
    const [, lead, core, trail] = m;

    if (core.includes('/')) {
      const parts = core.split('/').map(p => {
        const up = p.toUpperCase();
        if (acronyms.has(up)) return up;
        return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
      });
      return lead + parts.join('/') + trail;
    }

    const up = core.toUpperCase();
    if (acronyms.has(up)) return lead + up + trail;

    const low = core.toLowerCase();
    if (idx > 0 && minorWords.has(low)) return lead + low + trail;

    return lead + core.charAt(0).toUpperCase() + core.slice(1).toLowerCase() + trail;
  }).join(' ');
}

// Customer name cleaners: strictly exclude any timestamps, arrival times, shipping locations, or phones
function isArrivalOrTime(str) {
  if (!str) return false;
  const s = String(str).trim();
  // Any arrival keywords
  if (/(?:actual|expected|estimated)?\s*arrival|arrive|\beta\b|window\b/i.test(s)) return true;
  // Any time format like 8:32, 12:45, 08:30 AM, 1:15 PM
  if (/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\b/i.test(s)) return true;
  // Isolated time indicators
  if (/^\s*(?:[ap]\.?m\.?|\d{1,2}\s*[ap]\.?m\.?)\s*$/i.test(s)) return true;
  return false;
}

function isShipping(str) {
  if (!str) return false;
  const s = String(str).trim();
  return /shipping\s*from|shipped|ding'?s\s*auto\s*parts|warehouse|route\s*\d|truck/i.test(s);
}

function isPhone(str) {
  if (!str) return false;
  return /(?:1\s*)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}/.test(str);
}

function isHeaderOrSystemLine(str) {
  if (!str) return false;
  return /Customer|Salesperson|Delivery\s*Report|Generated\s*on|Page\s*\d/i.test(str);
}

function extractCleanCustomerName(str) {
  if (!str) return '';
  const trimmed = String(str).trim();

  // If the line is an arrival/time, shipping line, or system line, it cannot be a customer name
  if (isArrivalOrTime(trimmed)) return '';
  if (isShipping(trimmed)) return '';
  if (isHeaderOrSystemLine(trimmed)) return '';
  if (isPhone(trimmed) && trimmed.replace(/[^a-zA-Z]/g, '').length < 3) return '';

  let clean = trimmed
    .replace(/(?:Actual|Expected|Estimated)?\s*Arrival:?.*$/gi, '')
    .replace(/Shipping\s*From:?.*$/gi, '')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\b/gi, '')
    .replace(/\b[ap]\.m\.\b/gi, '')
    .replace(/(?:1\s*)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

  // If after stripping it has fewer than 2 letters or matches arrival/shipping, ignore
  if (!/[a-zA-Z]{2,}/.test(clean) || isHeaderOrSystemLine(clean) || isArrivalOrTime(clean) || isShipping(clean)) {
    return '';
  }
  return clean;
}

// Extraction based directly on the attached PDF layout:
// Col 1: Customer (Bold business name at top of cell, Phone; arrival & shipping from excluded)
// Col 2: Type (Delivery / Pickup - excluded completely)
// Col 3: Reference Numbers (Order, Invoice, PO, RMA)
// Col 4: Part (Whole cell is one car part)
// Col 5: Complete (Status - excluded completely)
async function extractAndParsePDF(pdf) {
  const rows = [];
  let currentCustName = '';
  let currentPhone = '';

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();

    // Map text items with rounded coordinates
    const items = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => ({
        text: it.str.trim(),
        x: Math.round(it.transform[4]),
        y: Math.round(it.transform[5])
      }));

    // Group items into horizontal lines (Y within 3 pixels)
    const linesMap = new Map();
    items.forEach(it => {
      let foundKey = null;
      for (const key of linesMap.keys()) {
        if (Math.abs(key - it.y) <= 3) {
          foundKey = key;
          break;
        }
      }
      if (foundKey === null) {
        foundKey = it.y;
        linesMap.set(foundKey, []);
      }
      linesMap.get(foundKey).push(it);
    });

    // Sort lines top to bottom (Y descending)
    const sortedY = Array.from(linesMap.keys()).sort((a, b) => b - a);
    const pageLines = sortedY.map(y => {
      const lineItems = linesMap.get(y);
      lineItems.sort((a, b) => a.x - b.x);
      return {
        y: y,
        items: lineItems,
        fullText: lineItems.map(it => it.text).join(' ')
      };
    });

    // Check header for Salesperson and Date
    for (const line of pageLines) {
      if (/Salesperson Delivery Report/i.test(line.fullText)) {
        const m = line.fullText.match(/^([^|]+)\|\s*Salesperson Delivery Report(?:\s+for\s+([\d\/]+))?/i);
        if (m) {
          salespersonName = m[1].trim();
          if (m[2]) reportDate = m[2].trim();
        }
      }
    }

    // Dynamic column boundaries based on header positions
    let colBounds = {
      type: 210,
      ref: 255,
      part: 350,
      complete: 520
    };

    let headerY = -1;
    for (const line of pageLines) {
      if (/Customer/i.test(line.fullText) && /Part/i.test(line.fullText)) {
        headerY = line.y;
        line.items.forEach(it => {
          if (/^Type$/i.test(it.text)) colBounds.type = it.x - 5;
          if (/Reference/i.test(it.text)) colBounds.ref = it.x - 5;
          if (/^Part$/i.test(it.text)) colBounds.part = it.x - 5;
          if (/Complete/i.test(it.text)) colBounds.complete = it.x - 5;
        });
        break;
      }
    }

    // Only process data lines strictly below the table header
    const dataLines = pageLines.filter(l => {
      if (headerY !== -1 && l.y >= headerY) return false;
      if (/Generated on|Salesperson Delivery Report|DING'S AUTO PARTS/i.test(l.fullText)) return false;
      return true;
    });

    for (let i = 0; i < dataLines.length; i++) {
      const l = dataLines[i];
      const c1Items = l.items.filter(it => it.x < colBounds.type);
      const c2Items = l.items.filter(it => it.x >= colBounds.type && it.x < colBounds.ref);
      const c3Items = l.items.filter(it => it.x >= colBounds.ref && it.x < colBounds.part);
      const c4Items = l.items.filter(it => it.x >= colBounds.part && it.x < colBounds.complete);

      const c1Text = c1Items.map(it => it.text).join(' ').trim();
      const c2Text = c2Items.map(it => it.text).join(' ').trim();
      const c3Text = c3Items.map(it => it.text).join(' ').trim();
      const c4Text = c4Items.map(it => it.text).join(' ').trim();

      // Multi-page spillover check:
      // If line at top of page has PO without a part or new customer, attach to previous page's row
      const poSpill = c3Text.match(/PO:\s*([A-Za-z0-9\-]+)/i);
      if (poSpill && !c4Text && !/Order:/i.test(c3Text)) {
        if (!extractCleanCustomerName(c1Text) && rows.length > 0) {
          const lastRow = rows[rows.length - 1];
          if (!lastRow.PO || lastRow.PO === '—' || !lastRow.PO_RMA || lastRow.PO_RMA === '—') {
            lastRow.PO = poSpill[1].trim();
            lastRow.PO_RMA = poSpill[1].trim();
          }
          continue;
        }
      }

      // Customer Phone in Col 1
      const phMatch = c1Text.match(/(?:1\s*)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}/);
      if (phMatch) {
        currentPhone = phMatch[0].trim();
      }

      // Customer Name in Col 1 (Bold business name at top of cell)
      // Strictly excludes timestamps, arrival times, and shipping locations
      const possibleCust = extractCleanCustomerName(c1Text);
      if (possibleCust && !isHeaderOrSystemLine(c1Text)) {
        currentCustName = possibleCust;
      }

      // Strictly ignore ALL RMA and Pickup details per user instruction
      if (/pickup/i.test(c2Text) || /\brma\b/i.test(c3Text) || /\bpickup\b/i.test(c1Text)) {
        continue;
      }

      // Check if this line introduces a delivery item (Order # in Col 3 or Part description in Col 4)
      if (c4Text || /Order:/i.test(c3Text)) {
        let partFull = c4Text;
        let refFull = c3Text;

        // Look ahead within 30px for continuation lines (e.g. multi-line parts, PO)
        let j = i + 1;
        while (j < dataLines.length && (dataLines[i].y - dataLines[j].y) <= 30) {
          const nextL = dataLines[j];
          const nextC1 = nextL.items.filter(it => it.x < colBounds.type).map(it => it.text).join(' ').trim();
          const nextC2 = nextL.items.filter(it => it.x >= colBounds.type && it.x < colBounds.ref).map(it => it.text).join(' ').trim();
          const nextC3 = nextL.items.filter(it => it.x >= colBounds.ref && it.x < colBounds.part).map(it => it.text).join(' ').trim();
          const nextC4 = nextL.items.filter(it => it.x >= colBounds.part && it.x < colBounds.complete).map(it => it.text).join(' ').trim();

          const nextPh = nextC1.match(/(?:1\s*)?\(?\d{3}\)?[-\s.]?\d{3}[-\s.]?\d{4}/);
          if (nextPh) currentPhone = nextPh[0].trim();

          // If next line has Order:, Pickup, or RMA:, stop looking ahead
          if (/Order:|Pickup|RMA:/i.test(nextC3) || /Pickup/i.test(nextC2)) break;

          if (nextC3) refFull += ' ' + nextC3;
          if (nextC4 && !/Yes|No|Pending/i.test(nextC4)) partFull += ' ' + nextC4;
          j++;
        }

        let order = '', invoice = '', po = '';
        const ordMatch = refFull.match(/Order:\s*([A-Za-z0-9\-]+)/i);
        const invMatch = refFull.match(/Invoice:\s*([A-Za-z0-9\-]+)/i);
        const poMatch = refFull.match(/PO:\s*([A-Za-z0-9\-]+)/i);

        if (ordMatch) order = ordMatch[1].trim();
        if (invMatch) invoice = invMatch[1].trim();
        if (poMatch) po = poMatch[1].trim();
        // RMA details are completely ignored per user instruction

        // If line has no Order and no PO, and contains RMA or Pickup, skip completely
        if (!order && !po && /rma|pickup/i.test(refFull)) {
          continue;
        }

        const cleanCust = extractCleanCustomerName(currentCustName);
        const cleanPart = formatPartName(partFull);

        if (cleanPart) {
          rows.push({
            id: 'deliv_' + Math.random().toString(36).substr(2, 9),
            Customer: cleanCust || (order ? ('Customer on Order #' + order) : 'Unknown Customer'),
            Part: cleanPart,
            Order: order || '—',
            Invoice: invoice || '—',
            PO: po || '—',
            PO_RMA: po || '—',
            Phone: currentPhone,
            assignedRep: ''
          });
        }
      }
    }
  }

  // De-duplicate if needed
  const seen = new Set();
  return rows.filter(r => {
    if (!r.Part) return false;
    const key = `${r.Customer}|${r.Part}|${r.Order}|${r.Invoice}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// CSV Parsing: Column 1 = Customer, Column 3 = Reference Numbers, Column 4 = Part, Last Column = Phone
function parseCSVReport(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Check first few lines for Salesperson Delivery Report header
  for (let k = 0; k < Math.min(lines.length, 5); k++) {
    const l = lines[k];
    const m = l.match(/^"?([^|,"]+)[|,]\s*Salesperson Delivery Report(?:\s+for\s+([\d\/]+))?/i);
    if (m) {
      salespersonName = m[1].trim();
      if (m[2]) reportDate = m[2].trim();
      break;
    }
  }

  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 2) continue;

    const rowObj = {};
    headers.forEach((h, idx) => { rowObj[h] = values[idx] || ''; });

    const typeVal = rowObj['type'] || rowObj['delivery_type'] || '';
    if (/pickup/i.test(typeVal)) continue; // ignore pickups per user instruction

    let customer = rowObj['customer'] || rowObj['customer name'] || values[0] || '';
    let part = rowObj['part'] || rowObj['part description'] || values[2] || values[3] || '';
    let phone = rowObj['phone'] || rowObj['phone number'] || values[values.length - 1] || '';
    let order = rowObj['order'] || rowObj['order #'] || '';
    let invoice = rowObj['invoice'] || rowObj['invoice #'] || '';
    let po = rowObj['po'] || rowObj['po #'] || rowObj['po_number'] || rowObj['po_rma'] || '';
    let assigned = rowObj['assigned_rep'] || rowObj['rep'] || '';

    // Ignore RMA details completely
    if (/^rma/i.test(po) || (!order && /rma/i.test(rowObj['rma'] || ''))) continue;
    if (/^rma/i.test(po)) po = '';

    const cleanCust = extractCleanCustomerName(customer);
    const cleanPart = formatPartName(part);
    if (cleanPart) {
      rows.push({
        id: 'deliv_' + Math.random().toString(36).substr(2, 9),
        Customer: cleanCust || (order ? ('Customer on Order #' + order) : 'Unknown Customer'),
        Part: cleanPart,
        Order: order || '—',
        Invoice: invoice || '—',
        PO: po || '—',
        PO_RMA: po || '—',
        Phone: phone,
        assignedRep: assigned
      });
    }
  }

  return rows;
}

function parseCSVLine(text) {
  const result = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQuotes && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur);
  return result;
}

// ================= SMART CALL MATCHING =================
function normalizePhone(str) {
  if (!str) return '';
  const digits = str.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function findCallMatch(customerName, phone) {
  const normPhone = normalizePhone(phone);
  const cleanCust = (customerName || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const c of calls) {
    const callPhone = normalizePhone(c.phone);
    const callCust = (c.customer || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    if (normPhone && callPhone && (normPhone === callPhone || normPhone.slice(-7) === callPhone.slice(-7))) {
      return {
        callId: c.id || '',
        repName: c.rep,
        matchType: 'phone',
        details: `Spoke with ${c.rep} (${c.time}) - ${c.category}: ${c.notes}`
      };
    }

    if (cleanCust && callCust && (cleanCust.includes(callCust) || callCust.includes(cleanCust)) && cleanCust.length > 4) {
      return {
        callId: c.id || '',
        repName: c.rep,
        matchType: 'name',
        details: `Customer matched ${c.rep}'s call (${c.time}) - ${c.category}`
      };
    }
  }

  return null;
}

function reevaluateSuggestions() {
  allRows.forEach(r => {
    r.suggestion = findCallMatch(r.Customer, r.Phone);
  });
}

function autoAssignAllCallMatches() {
  let count = 0;
  allRows.forEach(r => {
    if (!r.assignedRep && r.suggestion && r.suggestion.repName) {
      r.assignedRep = r.suggestion.repName;
      count++;
    }
  });
  if (count > 0) markChangesMade();
  updateMetrics();
  renderTable();
  showToast(`Auto-assigned ${count} deliveries based on call matches!`);
}


function applyBulkRepAssignment() {
  const bulkRepEl = document.getElementById('bulkRepSelect');
  if (!bulkRepEl) return;
  const selectedRep = bulkRepEl.value;
  if (!selectedRep) {
    alert('Please select a rep to assign to.');
    return;
  }
  const filtered = getFiltered();
  filtered.forEach(r => {
    r.assignedRep = selectedRep;
  });
  markChangesMade();
  updateMetrics();
  renderTable();
  showToast(`Assigned ${filtered.length} items to ${selectedRep}!`);
}

// ================= RENDERING & FILTERS =================
function getFiltered() {
  const q = appliedSearch;
  const rep = appliedRep;

  return allRows.filter(r => {
    if (rep === '__unassigned__' && r.assignedRep) return false;
    if (rep === '__assigned__' && !r.assignedRep) return false;
    if (rep && rep !== '__unassigned__' && rep !== '__assigned__' && r.assignedRep !== rep) return false;

    if (activeMetricFilter === 'assigned' && !r.assignedRep) return false;
    if (activeMetricFilter === 'unassigned' && r.assignedRep) return false;
    if (activeMetricFilter === 'matches' && !r.suggestion) return false;

    if (q) {
      const hay = (
        (r.Customer || '') + ' ' +
        (r.Phone || '') + ' ' +
        (r.Order || '') + ' ' +
        (r.Invoice || '') + ' ' +
        (r.PO_RMA || '') + ' ' +
        (r.Part || '') + ' ' +
        (r.HollanderID || '') + ' ' +
        (r.assignedRep || '')
      ).toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
}

function updateMetrics() {
  const total = allRows.length;
  const assigned = allRows.filter(r => !!r.assignedRep).length;
  const unassigned = total - assigned;
  const callMatches = allRows.filter(r => !!r.suggestion).length;

  document.getElementById('metrics').innerHTML = `
    <div class="metric ${activeMetricFilter === 'deliveries' ? 'is-active-filter' : ''}" data-card="deliveries">
      <div class="value">${total}</div>
      <div class="label">Total Deliveries</div>
      <div class="subtext">Uploaded report items</div>
      <div class="click-hint">Click to view data & breakdown &rarr;</div>
    </div>

    <div class="metric ${activeMetricFilter === 'assigned' ? 'is-active-filter' : ''}" data-card="assigned">
      <div class="value" style="color:${assigned === total && total > 0 ? 'var(--success)' : 'var(--accent)'}">${assigned}</div>
      <div class="label">Assigned Reps</div>
      <div class="subtext">${reps.length} active team reps</div>
      <div class="click-hint">Click to view workload &rarr;</div>
    </div>

    <div class="metric ${activeMetricFilter === 'unassigned' ? 'is-active-filter' : ''}" data-card="unassigned">
      <div class="value" style="color:${unassigned > 0 ? 'var(--warning)' : 'var(--success)'}">${unassigned}</div>
      <div class="label">Unassigned</div>
      <div class="subtext">${unassigned > 0 ? 'Awaiting rep dispatch' : 'All dispatched'}</div>
      <div class="click-hint">Click to assign items &rarr;</div>
    </div>

    <div class="metric ${activeMetricFilter === 'matches' ? 'is-active-filter' : ''}" data-card="matches">
      <div class="value" style="color:#fbbf24">${callMatches}</div>
      <div class="label">Call Matches</div>
      <div class="subtext">Matched from customer calls</div>
      <div class="click-hint">Click to review call notes &rarr;</div>
    </div>
  `;

  document.getElementById('callMatchesFoundCount').textContent =
    callMatches > 0 ? `(${callMatches} call matches detected)` : '';
}

window.handleCardClick = function(sectionKey) {
  openMetricDetailModal(sectionKey);
};

function openMetricDetailModal(sectionKey) {
  metricDetailModal.classList.remove('hidden');
  renderMetricDetailModal(sectionKey);
}

function renderMetricDetailModal(sectionKey) {
  const total = allRows.length;
  const assigned = allRows.filter(r => !!r.assignedRep).length;
  const unassigned = total - assigned;
  const matches = allRows.filter(r => !!r.suggestion).length;

  document.getElementById('tabCountDeliveries').textContent = total;
  document.getElementById('tabCountAssigned').textContent = assigned;
  document.getElementById('tabCountUnassigned').textContent = unassigned;
  document.getElementById('tabCountMatches').textContent = matches;

  const tabBtnMap = {
    deliveries: 'tab-metric-deliveries',
    assigned: 'tab-metric-assigned',
    unassigned: 'tab-metric-unassigned',
    matches: 'tab-metric-matches'
  };
  const targetTabId = tabBtnMap[sectionKey] || 'tab-metric-deliveries';

  document.querySelectorAll('[data-metric-tab]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-metric-tab') === targetTabId);
  });
  document.querySelectorAll('#metricDetailModal .tab-content').forEach(c => {
    c.classList.toggle('hidden', c.id !== targetTabId);
  });

  // 1. Deliveries Tab (Grouped by Customer / Business)
  document.getElementById('modalDeliveryTotalSummary').textContent = `${total} Deliveries`;
  document.getElementById('modalCoverageSummary').textContent = total > 0 ? `${Math.round((assigned / total) * 100)}% Assigned` : '0%';
  document.getElementById('modalCallMatchSummary').textContent = total > 0 ? `${Math.round((matches / total) * 100)}% Matched` : '0%';

  const custMap = {};
  allRows.forEach(r => {
    const cust = r.Customer || 'Unknown Customer';
    if (!custMap[cust]) custMap[cust] = [];
    custMap[cust].push(r);
  });

  const custGroupEl = document.getElementById('modalCustomerGroupList');
  if (custGroupEl) {
    custGroupEl.innerHTML = Object.entries(custMap).map(([cust, items]) => `
      <div style="background:#0D1424; border:1px solid var(--border); border-radius:6px; padding:0.5rem 0.75rem; font-size:0.82rem; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <span style="font-weight:600; color:#e2e8f0;">${esc(cust)}</span>
          <span style="color:var(--text-muted); margin-left:0.5rem;">(${items.length} ${items.length === 1 ? 'item' : 'items'})</span>
        </div>
        <div style="font-size:0.75rem; color:var(--text-muted); max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
          ${items.map(i => esc(i.Part)).join(', ')}
        </div>
      </div>
    `).join('');
  }

  // 2. Assigned Reps Tab
  const repWorkloadMap = {};
  reps.forEach(rep => { repWorkloadMap[rep.name] = 0; });
  allRows.forEach(r => {
    if (r.assignedRep && repWorkloadMap[r.assignedRep] !== undefined) {
      repWorkloadMap[r.assignedRep]++;
    }
  });

  document.getElementById('modalAssignedCountTag').textContent = `${assigned} of ${total} assigned`;

  const workloadBarsEl = document.getElementById('modalRepWorkloadBars');
  workloadBarsEl.innerHTML = reps.map(rep => {
    const count = repWorkloadMap[rep.name] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <div>
        <div style="display:flex; justify-content:space-between; font-size:0.83rem; font-weight:600; margin-bottom:0.25rem;">
          <span>${esc(rep.name)} <span style="color:var(--text-muted); font-size:0.75rem;">(${esc(rep.desk)})</span></span>
          <span style="color:var(--accent);">${count} items (${pct}%)</span>
        </div>
        <div class="progress-track" style="margin:0; height:8px;">
          <div class="progress-fill" style="width:${pct}%; background:${rep.color || 'var(--accent)'};"></div>
        </div>
      </div>
    `;
  }).join('');

  // 3. Unassigned Tab
  document.getElementById('modalUnassignedAlert').textContent =
    unassigned > 0 ? `${unassigned} unassigned deliveries` : 'All deliveries assigned!';

  const unassignedListEl = document.getElementById('modalUnassignedItemsList');
  const unassignedRows = allRows.filter(r => !r.assignedRep);
  if (unassignedRows.length === 0) {
    unassignedListEl.innerHTML = `<div style="color:var(--success); font-size:0.85rem; padding:1.5rem; text-align:center;">Great job! All deliveries have been assigned to sales reps.</div>`;
  } else {
    unassignedListEl.innerHTML = unassignedRows.map(r => `
      <div style="background:#0D1424; border:1px solid var(--border); border-radius:6px; padding:0.6rem 0.85rem; display:flex; justify-content:space-between; align-items:center; font-size:0.82rem;">
        <div>
          <div style="font-weight:600; font-size:0.88rem;">${esc(r.Customer)}</div>
          <div style="color:#cbd5e1; font-size:0.78rem; margin-top:2px;"><b>Part:</b> ${esc(r.Part)} &bull; Order #${esc(r.Order || '—')}</div>
          <div style="color:var(--accent); font-size:0.75rem;">${esc(r.Phone || 'No Phone')}</div>
        </div>
        <div>
          <select data-assign-select="${escAttr(r.id)}" style="background:#0B0F19; border:1px solid var(--border); color:#fff; font-size:0.8rem; padding:0.3rem 0.5rem; border-radius:5px;">
            <option value="">Assign to...</option>
            ${reps.map(rep => `<option value="${esc(rep.name)}">${esc(rep.name)}</option>`).join('')}
          </select>
        </div>
      </div>
    `).join('');
  }

  // 4. Matches Tab
  const matchesListEl = document.getElementById('modalCallMatchesList');
  const matchedRows = allRows.filter(r => !!r.suggestion);
  if (matchedRows.length === 0) {
    matchesListEl.innerHTML = `<div style="color:var(--text-muted); font-size:0.85rem; padding:1.5rem; text-align:center;">No call matches found. Try uploading a Call Log CSV.</div>`;
  } else {
    matchesListEl.innerHTML = matchedRows.map(r => `
      <div style="background:#0D1424; border:1px solid rgba(251, 191, 36, 0.3); border-radius:8px; padding:0.75rem 0.9rem; font-size:0.82rem;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <span style="font-weight:700; font-size:0.88rem; color:#fde68a;">${esc(r.Customer)}</span>
            <span style="color:var(--accent); margin-left:0.5rem;">${esc(r.Phone)}</span>
          </div>
          <div>
            ${r.assignedRep === r.suggestion.repName ?
              `<span style="color:var(--success); font-weight:600; font-size:0.76rem;">✓ Assigned to ${esc(r.assignedRep)}</span>` :
              `<button class="btn btn-sm btn-outline" data-assign-button="${escAttr(r.id)}" data-assign-rep="${escAttr(r.suggestion.repName)}" style="color:#fbbf24; border-color:#fbbf24; padding:0.2rem 0.5rem; font-size:0.74rem;">Accept & Assign to ${esc(r.suggestion.repName)}</button>`
            }
          </div>
        </div>
        <div style="color:#cbd5e1; margin-top:0.35rem; font-size:0.78rem;">
          <b>Part:</b> ${esc(r.Part)} &bull; Order #${esc(r.Order || '—')} &bull; Invoice #${esc(r.Invoice || '—')}
        </div>
        <div style="background:rgba(251,191,36,0.08); border-radius:4px; padding:0.35rem 0.55rem; margin-top:0.35rem; font-size:0.76rem; color:#fef08a;">
          <b>Call Match:</b> ${esc(r.suggestion.details)}
        </div>
      </div>
    `).join('');
  }
}

window.assignFromModal = function(rowId, repName) {
  if (!repName) return;
  const row = allRows.find(r => r.id === rowId);
  if (row) {
    row.assignedRep = repName;
    markChangesMade();
    updateMetrics();
    renderTable();
    renderMetricDetailModal('unassigned');
    showToast(`Assigned to ${repName}!`);
  }
};

function updateRepDropdowns() {
  const repFilterEl = document.getElementById('repFilter');
  const bulkRepSelectEl = document.getElementById('bulkRepSelect');

  const curFilter = repFilterEl ? repFilterEl.value : '';
  const curBulk = bulkRepSelectEl ? bulkRepSelectEl.value : '';

  if (repFilterEl) {
    repFilterEl.innerHTML = `
      <option value="">All Reps</option>
      <option value="__unassigned__">Unassigned Only</option>
      <option value="__assigned__">Assigned Only</option>
      ${reps.map(r => `<option value="${esc(r.name)}">${esc(r.name)} (${esc(r.desk)})</option>`).join('')}
    `;
    repFilterEl.value = curFilter;
  }

  if (bulkRepSelectEl) {
    bulkRepSelectEl.innerHTML = `
      <option value="">Choose Rep...</option>
      ${reps.map(r => `<option value="${esc(r.name)}">${esc(r.name)}</option>`).join('')}
    `;
    bulkRepSelectEl.value = curBulk;
  }
}

function renderTable() {
  updatePartIdStatusUI();
  updateCustomerMatchUI();
  const filtered = getFiltered();
  const fc = document.getElementById('filteredCountText');
  if (fc) fc.textContent = filtered.length;

  if (activeMetricFilter) {
    activeFilterCount.textContent = `(Showing ${filtered.length} of ${allRows.length})`;
  }

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align:center; padding:2.5rem; color:var(--text-muted);">
          No delivery records match the current filters or search term.
        </td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = filtered.map(r => {
    const cleanCustomerName = extractCleanCustomerName(r.Customer) || r.Customer || 'Unknown Customer';
    const displayPhone = r.CustomerPhone || r.Phone || '';
    const phoneDisplay = esc(formatPhoneDisplay(displayPhone));
    const phoneCell = displayPhone
      ? `<button type="button" class="phone-call-btn" data-phone="${escAttr(displayPhone)}" data-customer="${escAttr(cleanCustomerName)}" title="Call and play the delivery announcement">${phoneDisplay}</button>`
      : '<span style="color:#64748b">—</span>';
    const addressLine = r.CustomerAddress
      ? `<div style="font-weight:400; color:var(--text-muted); font-size:0.72rem; margin-top:3px; white-space:normal;">${esc(r.CustomerAddress)}</div>`
      : '';

    const isAssigned = !!r.assignedRep;
    let repSelectHTML = `
      <select class="rep-select ${isAssigned ? 'is-assigned' : ''}" data-rep-select="${escAttr(r.id)}">
        <option value="">-- Unassigned --</option>
        ${reps.map(rep => `
          <option value="${esc(rep.name)}" ${r.assignedRep === rep.name ? 'selected' : ''}>
            ${esc(rep.name)} (${esc(rep.desk)})
          </option>
        `).join('')}
      </select>
    `;

    let suggestionHTML = '';
    if (!r.assignedRep && r.suggestion) {
      suggestionHTML = `
        <div class="smart-suggestion-pill" title="${esc(r.suggestion.details)}">
          <span>Match: <b>${esc(r.suggestion.repName)}</b></span>
          <button data-accept-suggestion="${escAttr(r.id)}" data-accept-rep="${escAttr(r.suggestion.repName)}">Accept</button>
        </div>
      `;
    }
    const callLinkHTML = r.suggestion && r.suggestion.callId
      ? `<button class="btn btn-outline btn-micro" type="button" data-view-call="${escAttr(r.suggestion.callId)}" title="Open the matched call in the platform" style="margin-top:0.35rem;">View call</button>`
      : '';

    return `
      <tr>
        <td style="font-weight:600; color:#f8fafc;">
          ${esc(cleanCustomerName)}
          ${addressLine}
        </td>
        <td class="rep-cell">
          ${repSelectHTML}
          ${suggestionHTML}
          ${callLinkHTML}
        </td>
        <td style="max-width:300px; color:#e2e8f0; font-weight:500;">
          ${editingRowPartId === r.id ? `
            <div style="display:flex; flex-direction:column; gap:0.3rem;">
              <input id="rowPartName_${escAttr(r.id)}" type="text" value="${escAttr(r.Part)}" spellcheck="false"
                style="background:#0D1424; border:1px solid var(--border); color:var(--text); padding:0.3rem 0.45rem; border-radius:6px; font-size:0.8rem; width:100%;">
              <div style="display:flex; gap:0.3rem; align-items:center;">
                <input id="rowPartNum_${escAttr(r.id)}" type="text" inputmode="numeric" value="${escAttr(r.HollanderID)}" placeholder="ID" spellcheck="false"
                  style="background:#0D1424; border:1px solid var(--border); color:var(--text); padding:0.3rem 0.45rem; border-radius:6px; font-size:0.8rem; width:74px;">
                <button class="btn btn-outline btn-micro" type="button" data-save-part="${escAttr(r.id)}">Save</button>
                <button class="btn btn-outline btn-micro" type="button" data-cancel-part="1">Cancel</button>
              </div>
            </div>
          ` : `
            <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:0.4rem;">
              <span>${esc(r.Part)}${r.HollanderID
                ? ` <span style="color:#34d399; font-weight:700; white-space:nowrap;" title="Hollander part number from the part catalog">- ${esc(r.HollanderID)}</span>`
                : (partRows.length ? ` <span style="color:#64748b; font-size:0.72rem;" title="No Hollander part number matched">(no ID)</span>` : '')}</span>
              <button class="btn btn-outline btn-micro" type="button" title="Edit this part / Hollander number" data-edit-part="${escAttr(r.id)}" style="flex-shrink:0;">Edit</button>
            </div>
          `}
        </td>
        <td><code>${esc(r.Order) || '—'}</code></td>
        <td><code>${esc(r.Invoice) || '—'}</code></td>
        <td><code>${esc(r.PO || r.PO_RMA) || '—'}</code></td>
        <td>${phoneCell}</td>
      </tr>
    `;
  }).join('');

  tableBody.querySelectorAll('.phone-call-btn').forEach(btn => {
    btn.addEventListener('click', () => openCallModal(btn.dataset.phone, btn.dataset.customer));
  });
}

window.handleRepChange = function(rowId, repName) {
  const row = allRows.find(r => r.id === rowId);
  if (row) {
    row.assignedRep = repName;
    markChangesMade();
    updateMetrics();
    renderTable();
  }
};

window.acceptSuggestion = function(rowId, repName) {
  const row = allRows.find(r => r.id === rowId);
  if (row) {
    row.assignedRep = repName;
    markChangesMade();
    updateMetrics();
    renderTable();
    showToast(`Assigned to ${repName}!`);
  }
};

// Inline part/number edit on an uploaded delivery row.
window.editRowPart = function(rowId) {
  editingRowPartId = rowId;
  renderTable();
};

window.cancelRowPart = function() {
  editingRowPartId = null;
  renderTable();
};

window.saveRowPart = function(rowId) {
  const row = allRows.find(r => r.id === rowId);
  if (!row) return;
  const name = (document.getElementById(`rowPartName_${rowId}`)?.value || '').trim();
  const num = (document.getElementById(`rowPartNum_${rowId}`)?.value || '').trim();

  if (!name) { showToast('Part name cannot be empty.'); return; }
  if (num && !/^\d{1,6}$/.test(num)) { showToast('Hollander number must be digits only.'); return; }

  row.Part = name;
  row.HollanderID = num;
  row.ManualPart = true;
  row.PartIDMatchedName = '';
  row.PartIDMatchType = 'manual';
  editingRowPartId = null;

  markChangesMade();
  updateMetrics();
  renderTable();
  showToast(num ? `Part set to ${name} - ${num}.` : `Part set to ${name}.`);
};

// ================= SAVE & REVIEW WORKFLOW =================
function markChangesMade() {
  hasUnsavedChanges = true;
  updateSaveStatusUI();
}

function updateSaveStatusUI(showSavedConfirmation = false) {
  const badge = document.getElementById('saveStatusBadge');
  const headerBtn = document.getElementById('headerSaveBtn');
  const bulkBtn = document.getElementById('bulkSaveBtn');
  const bottomBtn = document.getElementById('bottomSaveBtn');
  const stickyBar = document.getElementById('stickySaveBar');
  const modalTag = document.getElementById('modalSaveCheckTag');

  if (hasUnsavedChanges) {
    if (badge) {
      badge.className = 'save-status-pill unsaved';
      badge.innerHTML = 'Unsaved Changes Pending';
    }
    if (headerBtn) {
      headerBtn.classList.remove('hidden');
      headerBtn.classList.add('btn-save-dirty');
      headerBtn.textContent = 'Save Changes *';
    }
    if (bulkBtn) {
      bulkBtn.classList.add('btn-save-dirty');
      bulkBtn.textContent = 'Save Changes *';
    }
    if (bottomBtn) {
      bottomBtn.classList.add('btn-save-dirty');
      bottomBtn.textContent = 'Save Changes *';
    }
    if (stickyBar) {
      stickyBar.classList.remove('hidden');
      stickyBar.classList.remove('is-saved');
      document.getElementById('stickySaveIcon').textContent = '!';
      document.getElementById('stickySaveIcon').style.color = 'var(--warning)';
      document.getElementById('stickySaveTitle').textContent = 'Unsaved Changes Pending';
      document.getElementById('stickySaveTitle').style.color = '#fbbf24';
      document.getElementById('stickySaveSubtitle').textContent = 'You modified rep assignments. Click Save Changes to lock them in.';
      document.getElementById('stickyDiscardBtn').classList.remove('hidden');
      document.getElementById('stickySaveBtn').classList.remove('hidden');
      document.getElementById('stickyDismissBtn').classList.add('hidden');
    }
    if (modalTag) {
      modalTag.innerHTML = `<span style="color:var(--warning); font-weight:600;">Unsaved Changes Auto-Saved</span>`;
    }
  } else {
    const timeLabel = lastSavedTime ? `(${lastSavedTime})` : '';
    if (badge) {
      badge.className = 'save-status-pill saved';
      badge.innerHTML = `All Changes Saved ${timeLabel}`;
    }
    if (headerBtn) {
      headerBtn.classList.remove('btn-save-dirty');
      headerBtn.textContent = 'Saved';
    }
    if (bulkBtn) {
      bulkBtn.classList.remove('btn-save-dirty');
      bulkBtn.textContent = 'Saved';
    }
    if (bottomBtn) {
      bottomBtn.classList.remove('btn-save-dirty');
      bottomBtn.textContent = 'Saved';
    }
    if (stickyBar) {
      if (showSavedConfirmation && lastSavedTime) {
        stickyBar.classList.remove('hidden');
        stickyBar.classList.add('is-saved');
        document.getElementById('stickySaveIcon').textContent = '✓';
        document.getElementById('stickySaveIcon').style.color = 'var(--success)';
        document.getElementById('stickySaveTitle').textContent = 'All Changes Saved!';
        document.getElementById('stickySaveTitle').style.color = '#34d399';
        document.getElementById('stickySaveSubtitle').textContent = `Saved at ${lastSavedTime}.`;
        document.getElementById('stickyDiscardBtn').classList.add('hidden');
        document.getElementById('stickySaveBtn').classList.add('hidden');
        document.getElementById('stickyDismissBtn').classList.remove('hidden');
      } else {
        stickyBar.classList.add('hidden');
      }
    }
    if (modalTag) {
      modalTag.innerHTML = `<span style="color:var(--success); font-weight:600;">Changes Saved</span>`;
    }
  }
}

function persistReportSession() {
  const payload = {
    savedAt: new Date().toISOString(),
    salespersonName: salespersonName || 'Rich Brauns',
    reportDate: reportDate || '',
    rows: allRows
  };
  try {
    localStorage.setItem(SAVED_SESSION_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('LocalStorage save error:', e);
  }
}

function saveChanges(silent = false) {
  persistReportSession();
  lastSavedSnapshot = JSON.stringify(allRows);
  hasUnsavedChanges = false;
  lastSavedTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  updateSaveStatusUI(true);
  if (!silent) {
    showToast(`All changes saved at ${lastSavedTime}!`);
  }
}

function discardChanges() {
  if (!confirm('Discard all unsaved rep changes and revert to the last saved state?')) return;
  if (lastSavedSnapshot) {
    try {
      allRows = JSON.parse(lastSavedSnapshot);
    } catch (e) {}
  }
  hasUnsavedChanges = false;
  updateMetrics();
  renderTable();
  updateSaveStatusUI();
  showToast('Unsaved changes reverted to last saved state.');
}

window.addEventListener('beforeunload', (e) => {
  if (hasUnsavedChanges) {
    e.preventDefault();
    e.returnValue = '';
  }
});

function generateCSV(rows) {
  if (!rows.length) return '';
  const headers = ['Customer', 'Assigned_Rep', 'Part', 'Order', 'Invoice', 'PO', 'Phone_Contact'];
  const csv = [
    headers.join(','),
    ...rows.map(r => [
      extractCleanCustomerName(r.Customer) || r.Customer || '',
      r.assignedRep || 'Unassigned',
      partWithId(r),
      r.Order || '',
      r.Invoice || '',
      r.PO || r.PO_RMA || '',
      r.CustomerPhone || r.Phone || ''
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
  ];
  return csv.join('\n');
}

function downloadFile(content, filename, mimeType) {
  if (!content) return;
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ================= TEAM & CALL LOGS MANAGEMENT =================
function openTeamModal() {
  if (teamModal) {
    teamModal.classList.remove('hidden');
    renderTeamModal();
  }
}

function renderTeamModal() {
  const teamCountEl = document.getElementById('teamCount');
  if (teamCountEl) teamCountEl.textContent = reps.length;
  const callCountEl = document.getElementById('callCount');
  if (callCountEl) callCountEl.textContent = calls.length;

  const repsListEl = document.getElementById('repsList');
  if (repsListEl) {
    repsListEl.innerHTML = reps.map((r, idx) => `
      <div style="background:#0D1424; border:1px solid var(--border); border-radius:8px; padding:0.6rem 0.85rem; display:flex; justify-content:space-between; align-items:center;">
        <div>
          <div style="font-weight:600; font-size:0.88rem; color:${r.color || 'var(--accent)'};">${esc(r.name)}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">${esc(r.desk)} &bull; ${esc(r.role || 'Sales Rep')}</div>
        </div>
        <div>
          <button class="btn-micro btn-outline" data-remove-rep="${idx}" style="color:var(--danger); border-color:rgba(248,113,113,0.3);">&times; Delete</button>
        </div>
      </div>
    `).join('');
  }

  const callsListEl = document.getElementById('callsList');
  if (callsListEl) {
    callsListEl.innerHTML = calls.map(c => `
      <div style="background:#0D1424; border:1px solid var(--border); border-radius:6px; padding:0.45rem 0.65rem; font-size:0.78rem;">
        <div style="display:flex; justify-content:space-between; font-weight:600;">
          <span>${esc(c.customer)}</span>
          <span style="color:var(--accent);">${esc(c.rep)}</span>
        </div>
        <div style="color:var(--text-muted); display:flex; justify-content:space-between; margin-top:2px;">
          <span>${esc(c.phone)}</span>
          <span>${esc(c.time || '')}</span>
        </div>
        ${c.notes ? `<div style="color:#94a3b8; font-size:0.72rem; margin-top:3px; font-style:italic;">"${esc(c.notes)}"</div>` : ''}
      </div>
    `).join('');
  }
}

window.removeRep = function(index) {
  if (confirm(`Remove ${reps[index].name} from team?`)) {
    reps.splice(index, 1);
    saveReps();
    renderTeamModal();
    updateRepDropdowns();
    renderTable();
  }
};

function promptAddNewRep() {
  const name = prompt('Enter Salesperson / User Name:');
  if (!name || !name.trim()) return;
  const desk = prompt('Enter Desk / Extension (e.g. Desk #5):') || 'Counter';
  const role = prompt('Enter Role (e.g. Inside Sales):') || 'Sales Rep';

  reps.push({
    id: 'rep_' + Date.now(),
    name: name.trim(),
    desk: desk.trim(),
    role: role.trim(),
    color: '#3A6AF0'
  });
  saveReps();
  renderTeamModal();
  updateRepDropdowns();
  renderTable();
  showToast(`Added ${name.trim()} to team!`);
}

function handleCallCsvUpload(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const text = e.target.result;
      const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) return;

      const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
      const newCalls = [];

      for (let i = 1; i < lines.length; i++) {
        const val = parseCSVLine(lines[i]);
        if (val.length < 2) continue;
        const row = {};
        headers.forEach((h, idx) => { row[h] = val[idx] || ''; });

        const phone = row['phone'] || row['phone number'] || val[0];
        const cust = row['customer'] || row['customer name'] || row['caller'] || val[1] || '';
        const rep = row['rep'] || row['salesperson'] || row['agent'] || val[2] || 'Unassigned';
        const time = row['time'] || row['date'] || 'Recent Call';
        const category = row['category'] || 'Call Inquiry';
        const notes = row['notes'] || row['summary'] || '';

        if (phone || cust) {
          newCalls.push({ phone, customer: cust, rep, time, category, notes });
        }
      }

      if (newCalls.length) {
        calls = [...newCalls, ...calls];
        saveCalls();
        renderTeamModal();
        reevaluateSuggestions();
        updateMetrics();
        renderTable();
        showToast(`Imported ${newCalls.length} call records!`);
      }
    } catch (err) {
      alert('Error parsing call CSV: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function saveReps() {
  localStorage.setItem('sp_dashboard_reps', JSON.stringify(reps));
}
function saveCalls() {
  localStorage.setItem('sp_dashboard_calls', JSON.stringify(calls));
}

// ================= PART-ID LOOKUP =================
function normalizePartText(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function partTokens(str) {
  const raw = normalizePartText(str).split(' ').filter(Boolean);
  const out = [];
  raw.forEach(t => {
    const expanded = PART_ABBREVIATIONS[t] || t;
    expanded.split(' ').forEach(x => { if (x) out.push(x); });
  });
  return out;
}

function buildPartIndex() {
  partIndex = new Map();
  partSortedIndex = new Map();
  partRows.forEach(p => {
    const tokens = partTokens(p.name);
    if (!tokens.length) return;
    p.tokens = tokens;
    p.norm = tokens.join(' ');
    p.sorted = [...tokens].sort().join(' ');
    if (!partIndex.has(p.norm)) partIndex.set(p.norm, p);
    if (!partSortedIndex.has(p.sorted)) partSortedIndex.set(p.sorted, p);
  });
}

function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}

function textSimilarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max ? 1 - editDistance(a, b) / max : 0;
}

// Smart match: exact -> word-order-insensitive -> qualifier-insensitive -> token overlap -> typo tolerance
function findPartRecord(partName) {
  if (!partName || !partRows.length) return null;
  const tokens = partTokens(partName);
  if (!tokens.length) return null;

  // A trailing side letter ("Headlamp, R") is not part of the Hollander number.
  const coreTokens = (tokens.length > 1 && (tokens[tokens.length - 1] === 'r' || tokens[tokens.length - 1] === 'l'))
    ? tokens.slice(0, -1)
    : tokens;

  const norm = tokens.join(' ');
  const sorted = [...tokens].sort().join(' ');

  if (partIndex.has(norm)) return { ...partIndex.get(norm), matchType: 'exact' };
  if (partSortedIndex.has(sorted)) return { ...partSortedIndex.get(sorted), matchType: 'words' };

  const tokSet = new Set(tokens);
  const coreSet = new Set(coreTokens);
  let best = null;
  let bestScore = 0;

  partRows.forEach(rec => {
    if (!rec.tokens) return;
    let inter = 0;
    tokSet.forEach(t => { if (rec.tokens.indexOf(t) !== -1) inter++; });
    const union = new Set([...tokens, ...rec.tokens]).size;
    let score = union ? inter / union : 0;

    // Every meaningful word of the report part appears in this Hollander name
    // (e.g. "Bumper, Rear" -> "Bumper Assembly, Rear").
    if (coreTokens.length >= 2 && [...coreSet].every(t => rec.tokens.indexOf(t) !== -1)) {
      const extra = rec.tokens.length - coreSet.size;
      score = Math.max(score, 0.9 - extra * 0.05);
    }

    // A bare noun ("Headlamp, R") resolves to the generic "... Assembly" entry.
    if (coreTokens.length === 1 && rec.tokens.length === 2 &&
        rec.tokens[0] === coreTokens[0] && rec.tokens[1] === 'assembly') {
      score = Math.max(score, 0.85);
    }

    if (Math.min(norm.length, rec.norm.length) >= 5) {
      score = Math.max(score, textSimilarity(norm, rec.norm));
    }

    if (score > bestScore) { bestScore = score; best = rec; }
  });

  if (best && bestScore >= 0.8) return { ...best, matchType: 'fuzzy', score: bestScore };
  return null;
}

function partWithId(row) {
  if (!row) return '';
  const base = row.Part || '';
  return row.HollanderID ? `${base} - ${row.HollanderID}` : base;
}

// Fills row.HollanderID for every row. Returns number of matches.
function applyPartLookups(rows) {
  if (!rows || !rows.length) return 0;
  let matched = 0;
  rows.forEach(r => {
    if (r.ManualPart) {
      if (r.HollanderID) matched++;
      return;
    }
    const rec = findPartRecord(r.Part);
    if (rec && rec.id) {
      r.HollanderID = String(rec.id);
      r.PartIDMatchedName = rec.name;
      r.PartIDMatchType = rec.matchType || 'exact';
      matched++;
    } else {
      r.HollanderID = '';
      r.PartIDMatchedName = '';
      r.PartIDMatchType = '';
    }
  });
  return matched;
}

// ================= CUSTOMER LOOKUP (address + phone from the platform) =================
function normalizeCustomerName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited)\b\.?/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CUSTOMER_STOPWORDS = new Set(['of', 'the', 'and', 'at', 'on', 'for', 'inc', 'llc', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'incorporated', 's']);

function buildCustomerIndex() {
  dbCustomerIndex = new Map();
  dbCustomerPhoneIndex = new Map();
  dbCustomers.forEach(c => {
    const norm = normalizeCustomerName(c.name);
    c.norm = norm;
    c.tokens = norm ? norm.split(' ').filter(t => t && !CUSTOMER_STOPWORDS.has(t)) : [];
    if (norm && !dbCustomerIndex.has(norm)) dbCustomerIndex.set(norm, c);
    const digits = String(c.phone || '').replace(/\D/g, '');
    if (digits.length >= 10 && !dbCustomerPhoneIndex.has(digits.slice(-10))) {
      dbCustomerPhoneIndex.set(digits.slice(-10), c);
    }
  });
}

function normalizeAddressPart(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(rd|rte)\b/g, 'road')
    .replace(/\brte\b/g, 'route')
    .replace(/\bs\b/g, 'south')
    .replace(/\bn\b/g, 'north')
    .replace(/\be\b/g, 'east')
    .replace(/\bw\b/g, 'west')
    .replace(/\bmt\b/g, 'mount')
    .replace(/\bst\b/g, 'street')
    .replace(/\bave\b/g, 'avenue')
    .replace(/\bblvd\b/g, 'boulevard')
    .replace(/\bdr\b/g, 'drive')
    .replace(/\bln\b/g, 'lane')
    .replace(/\bct\b/g, 'court')
    .replace(/\s+/g, ' ')
    .trim();
}

function customerIdentityKey(name, address1, phone) {
  return normalizeCustomerName(name) + '|' + normalizeAddressPart(address1) + '|' + String(phone || '').replace(/\D/g, '').slice(-10);
}

function formatCustomerAddress(c) {
  if (!c) return '';
  const line1 = [c.address1, c.address2].filter(Boolean).join(', ');
  const cityState = [c.city, c.state, c.zip].filter(Boolean).join(' ');
  return [line1, cityState].filter(Boolean).join(', ');
}

// Phone match first (most precise), then exact shop name, then typo-tolerant similarity.
function findCustomerRecord(row) {
  if (!row || !dbCustomers.length) return null;
  const name = extractCleanCustomerName(row.Customer) || row.Customer || '';
  const norm = normalizeCustomerName(name);

  const digits = String(row.Phone || '').replace(/\D/g, '');
  if (digits.length >= 10 && dbCustomerPhoneIndex.has(digits.slice(-10))) {
    return { ...dbCustomerPhoneIndex.get(digits.slice(-10)), matchType: 'phone' };
  }

  if (norm && dbCustomerIndex.has(norm)) return { ...dbCustomerIndex.get(norm), matchType: 'exact' };

  if (!norm) return null;
  const qTokens = norm.split(' ').filter(t => t && !CUSTOMER_STOPWORDS.has(t));
  if (!qTokens.length) return null;

  let best = null;
  let bestScore = 0;
  dbCustomers.forEach(c => {
    if (!c.tokens || !c.tokens.length) return;
    const inter = qTokens.filter(t => c.tokens.includes(t)).length;
    const union = new Set([...qTokens, ...c.tokens]).size;
    let score = union ? inter / union : 0;

    // One name is fully contained in the other, same brand word, and at least
    // three words agree (e.g. "Darien Auto Body" -> "Darien Auto Body Center").
    const contained = inter === qTokens.length || inter === c.tokens.length;
    if (contained && inter >= 3 && qTokens[0] === c.tokens[0]) {
      score = Math.max(score, 0.9);
    }

    if (score > bestScore) { bestScore = score; best = c; }
  });
  if (best && bestScore >= 0.85) return { ...best, matchType: 'fuzzy' };
  return null;
}

// Fills row.CustomerAddress / CustomerPhone from the database. Returns match count.
function applyCustomerLookups(rows) {
  if (!rows || !rows.length) return 0;
  let matched = 0;
  rows.forEach(r => {
    const rec = findCustomerRecord(r);
    if (rec) {
      r.CustomerMatchName = rec.name;
      r.CustomerAddress = formatCustomerAddress(rec);
      r.CustomerPhone = rec.phone || '';
      r.CustomerMatchType = rec.matchType || 'exact';
      matched++;
    } else {
      r.CustomerMatchName = '';
      r.CustomerAddress = '';
      r.CustomerPhone = '';
      r.CustomerMatchType = '';
    }
  });
  return matched;
}

function applyDatabaseLookups(rows) {
  const partsMatched = applyPartLookups(rows);
  applyCustomerLookups(rows);
  return partsMatched;
}

function updateCustomerMatchUI() {
  const el = document.getElementById('customerMatchStatus');
  if (!el) return;
  if (!dbCustomers.length) { el.textContent = ''; return; }
  const total = allRows.length;
  const matched = allRows.filter(r => r.CustomerPhone || r.CustomerAddress).length;
  el.innerHTML = `<b style="color:var(--text);">${matched}/${total}</b> customers matched`;
}

async function syncCustomers(options = {}) {
  const silent = !!options.silent;
  if (customersFetching) return;
  customersFetching = true;

  try {
    const pageSize = 1000;
    const collected = [];
    let offset = 0;

    while (true) {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(offset));

      const res = await fetch(`${API_BASE}/customers?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error('Your session has expired. Reload the page and sign in again.');
        if (res.status === 403) throw new Error('Your account does not have access to the customer list.');
        throw new Error(`Customer load failed (${res.status}).`);
      }

      const rows = await res.json();
      if (!Array.isArray(rows) || !rows.length) break;
      collected.push(...rows);
      if (rows.length < pageSize) break;
      offset += pageSize;
      if (collected.length > 50000) break; // safety valve
    }

    dbCustomers = collected.map(r => ({
      id: r.id,
      name: String(r.shop_name || '').trim(),
      address1: String(r.address1 || '').trim(),
      address2: String(r.address2 || '').trim(),
      city: String(r.city || '').trim(),
      state: String(r.state || '').trim(),
      zip: String(r.zip || '').trim(),
      phone: String(r.phone || '').trim()
    })).filter(c => c.name);

    customersLastSynced = Date.now();
    buildCustomerIndex();
    try {
      localStorage.setItem(CUST_CACHE_KEY, JSON.stringify({
        fetchedAt: customersLastSynced,
        customers: dbCustomers
      }));
    } catch (e) { /* storage full: keep in memory */ }

    applyCustomerLookups(allRows);
    if (!hasUnsavedChanges) lastSavedSnapshot = JSON.stringify(allRows);
    renderTable();
    updateCustomerMatchUI();

    if (!silent) showToast(collected.length
      ? `Loaded ${dbCustomers.length} customers.`
      : 'The customer directory is empty. Add customers or run the importer.');
  } catch (err) {
    console.warn('Customer lookup load failed:', err);
    if (!silent) showToast(`Customers: ${err.message}`);
  } finally {
    customersFetching = false;
  }
}

function setPartsDbStatus(message, tone) {
  const el = document.getElementById('sbStatusText');
  if (!el) return;
  el.textContent = message;
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function updatePartIdStatusUI() {
  const bar = document.getElementById('partIdStatusBar');
  const text = document.getElementById('partIdStatusText');
  const dot = document.getElementById('partIdsStatusDot');

  if (dot) dot.style.color = partSource === 'server' ? '#34d399' : partRows.length ? '#fbbf24' : '#64748b';
  if (!bar || !text) return;

  if (!partRows.length && !allRows.length) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');

  if (!partRows.length) {
    text.innerHTML = 'Hollander IDs: no part list loaded — open Parts in the header';
    return;
  }

  const total = allRows.length;
  const matched = allRows.filter(r => r.HollanderID).length;
  const missing = total - matched;
  const synced = partLastSynced ? new Date(partLastSynced).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

  let html = `Hollander IDs: <b style="color:var(--text);">${matched}/${total}</b> deliveries matched`;
  if (missing > 0) html += ` &bull; <span style="color:var(--warning); font-weight:600;">${missing} missing</span>`;
  html += ` &bull; Last Synced: ${synced ? esc(synced) : '—'}`;
  text.innerHTML = html;
}

function openPartIdsModal() {
  if (partSource === 'server' && partLastSynced) {
    setPartsDbStatus(`${partRows.length} part IDs loaded for this yard. Last synced ${new Date(partLastSynced).toLocaleString()}.`, 'success');
  } else if (partRows.length) {
    setPartsDbStatus(`Using the ${partRows.length}-part bundled list. Click "Refresh Part IDs" to load the yard catalog.`, 'muted');
  } else {
    setPartsDbStatus('No part list loaded yet. Click "Refresh Part IDs".', 'muted');
  }
  document.getElementById('partIdsModal').classList.remove('hidden');
}

async function syncParts(options = {}) {
  const silent = !!options.silent;
  if (partFetching) return;

  partFetching = true;
  const syncBtn = document.getElementById('syncPartIdsBtn');
  const refreshBtn = document.getElementById('refreshPartIdsBtn');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = '⏳ Syncing…'; }
  if (refreshBtn) refreshBtn.disabled = true;
  setPartsDbStatus('⏳ Loading part IDs…', 'muted');

  try {
    const res = await fetch(`${API_BASE}/parts`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
      let msg = `Part lookup failed (${res.status}).`;
      if (res.status === 401) msg = 'Your session has expired. Reload the page and sign in again.';
      else if (res.status === 403) msg = 'Your account does not have access to the part catalog.';
      throw new Error(msg);
    }

    const rows = await res.json();
    const collected = (Array.isArray(rows) ? rows : [])
      .map(r => ({
        name: String(r.part_name || '').trim(),
        id: r.hollander_id === null || r.hollander_id === undefined ? '' : String(r.hollander_id).trim()
      }))
      .filter(p => p.name && p.id);

    if (!collected.length) throw new Error('The part catalog is empty. Add a part or use the bundled list.');

    partRows = collected;
    partSource = 'server';
    partLastSynced = Date.now();
    persistPartCache();
    buildPartIndex();

    const matched = applyDatabaseLookups(allRows);
    if (!hasUnsavedChanges) lastSavedSnapshot = JSON.stringify(allRows);
    updateMetrics();
    renderTable();
    updatePartIdStatusUI();
    updateSaveStatusUI();

    setPartsDbStatus(`Loaded ${partRows.length} part IDs. ${matched}/${allRows.length} current deliveries matched.`, 'success');
    if (!silent) showToast(`${partRows.length} part IDs loaded — ${matched}/${allRows.length} deliveries matched.`);
  } catch (err) {
    console.error('Part sync failed:', err);
    setPartsDbStatus(`${err.message}`, 'error');
    if (!silent) showToast(err.message);
  } finally {
    partFetching = false;
    if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = 'Refresh Part IDs'; }
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function useBundledParts() {
  localStorage.removeItem(SB_CACHE_KEY);
  partLastSynced = null;
  partSource = 'bundled';
  partRows = Array.isArray(window.HOLLANDER_PARTS)
    ? window.HOLLANDER_PARTS.map(p => ({ name: p.name, id: String(p.id) }))
    : [];
  buildPartIndex();
  applyDatabaseLookups(allRows);
  if (!hasUnsavedChanges) lastSavedSnapshot = JSON.stringify(allRows);
  updateMetrics();
  renderTable();
  updatePartIdStatusUI();
  updateSaveStatusUI();
  setPartsDbStatus(`Using the ${partRows.length}-part bundled list.`, 'muted');
  showToast('Using the bundled part list.');
}

// ================= PARTS MANAGER =================
let partSearchTimer = null;
let partSearchSeq = 0;
let lastPartTerm = '';
let editingPartOldId = null;
let editingPartOldName = '';

function escAttr(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Two-step delete: first click arms the button for four seconds.
function armDelete(btn, onConfirm, label) {
  const text = label || 'Delete';
  if (!btn) { onConfirm(); return; }
  if (btn.dataset.armed === '1') {
    clearTimeout(btn._armTimer);
    btn.dataset.armed = '0';
    btn.disabled = true;
    btn.textContent = '⏳';
    Promise.resolve().then(onConfirm).catch(err => {
      console.error(err);
      disarmDelete(btn, text);
    });
    return;
  }
  btn.dataset.armed = '1';
  btn.textContent = 'Confirm?';
  btn.style.color = '#f87171';
  btn.style.borderColor = 'rgba(248, 113, 113, 0.6)';
  clearTimeout(btn._armTimer);
  btn._armTimer = setTimeout(() => disarmDelete(btn, text), 4000);
}

function disarmDelete(btn, label) {
  if (!btn) return;
  clearTimeout(btn._armTimer);
  btn.dataset.armed = '0';
  btn.disabled = false;
  btn.textContent = label || 'Delete';
  btn.style.color = '';
  btn.style.borderColor = '';
}

function setPartsStatus(message, tone) {
  const el = document.getElementById('partSearchStatus');
  if (!el) return;
  el.textContent = message;
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function setPartFormStatus(message, tone) {
  const el = document.getElementById('partFormStatus');
  if (!el) return;
  el.textContent = message;
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function persistPartCache() {
  try {
    localStorage.setItem(SB_CACHE_KEY, JSON.stringify({
      fetchedAt: partLastSynced || Date.now(),
      parts: partRows.map(p => ({ name: p.name, id: p.id }))
    }));
  } catch (e) {}
}

// Rebuild the lookup index, re-match the open report and refresh every surface.
function commitPartChange() {
  partSource = 'server';
  partLastSynced = Date.now();
  persistPartCache();
  buildPartIndex();

  const matched = applyDatabaseLookups(allRows);
  if (!hasUnsavedChanges) lastSavedSnapshot = JSON.stringify(allRows);
  updateMetrics();
  renderTable();
  updatePartIdStatusUI();
  updateSaveStatusUI();
  return matched;
}

function updateLocalPart(oldId, oldName, name, number) {
  let idx = partRows.findIndex(p => String(p.id) === String(oldId));
  if (idx === -1) idx = partRows.findIndex(p => normalizePartText(p.name) === normalizePartText(oldName));
  if (idx !== -1) partRows[idx] = { name, id: number };
  else partRows.push({ name, id: number });
  return commitPartChange();
}

function openPartsModal() {
  document.getElementById('partsModal').classList.remove('hidden');
  const input = document.getElementById('partSearchInput');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 30); }
  searchPartRecords('');
}

function closePartsModal() {
  document.getElementById('partsModal').classList.add('hidden');
}

function schedulePartSearch(value) {
  clearTimeout(partSearchTimer);
  partSearchTimer = setTimeout(() => searchPartRecords(value), 250);
}

async function searchPartRecords(rawTerm) {
  const resultsEl = document.getElementById('partSearchResults');
  if (!resultsEl) return;
  const term = String(rawTerm || '').trim();
  lastPartTerm = term;

  const seq = ++partSearchSeq;
  setPartsStatus('⏳ Searching parts…', 'muted');

  try {
    const params = new URLSearchParams();
    params.set('limit', term ? '40' : '25');
    if (term) params.set('q', term);

    const res = await fetch(`${API_BASE}/parts?${params.toString()}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });

    if (seq !== partSearchSeq) return;
    if (!res.ok) {
      if (res.status === 401) throw new Error('Your session has expired. Reload the page and sign in again.');
      throw new Error(`Search failed (${res.status}).`);
    }

    const rows = await res.json();
    if (seq !== partSearchSeq) return;
    renderPartResults(Array.isArray(rows) ? rows : [], term);
  } catch (err) {
    if (seq !== partSearchSeq) return;
    resultsEl.innerHTML = '';
    setPartsStatus(`${apiFailure(err).message}`, 'error');
  }
}

function renderPartResults(rows, term) {
  const resultsEl = document.getElementById('partSearchResults');
  if (!resultsEl) return;

  const parts = rows.map(r => ({
    name: String(r.part_name || ''),
    id: r.hollander_id === null || r.hollander_id === undefined ? '' : String(r.hollander_id)
  })).filter(p => p.name && p.id);

  if (!parts.length) {
    resultsEl.innerHTML = '';
    setPartsStatus(term ? `No parts match "${term}".` : 'No parts in the database yet.', 'muted');
    return;
  }

  const syncedAt = partLastSynced ? new Date(partLastSynced).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  setPartsStatus(`${parts.length} part${parts.length === 1 ? '' : 's'} ${term ? 'matching' : 'shown'} — Last Synced: ${syncedAt}`, 'muted');

  resultsEl.innerHTML = parts.map(p => `
    <div class="part-row" data-id="${escAttr(p.id)}"
      style="display:flex; justify-content:space-between; gap:0.75rem; align-items:flex-start; padding:0.55rem 0; border-bottom:1px solid var(--border);">
      <div style="min-width:0;">
        <div style="font-weight:600; color:#f8fafc; font-size:0.88rem;">${esc(p.name)}</div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px;">Hollander <b style="color:#34d399;">${esc(p.id)}</b></div>
      </div>
      <div style="display:flex; gap:0.3rem; flex-shrink:0;">
        <button class="btn btn-outline btn-micro part-edit-btn" type="button">Edit</button>
        <button class="btn btn-outline btn-micro part-del-btn" type="button">Delete</button>
      </div>
    </div>
  `).join('');

  resultsEl.querySelectorAll('.part-row').forEach(rowEl => {
    const id = rowEl.dataset.id;
    const part = parts.find(p => String(p.id) === String(id));
    if (!part) return;
    const editBtn = rowEl.querySelector('.part-edit-btn');
    const delBtn = rowEl.querySelector('.part-del-btn');
    if (editBtn) editBtn.addEventListener('click', () => openPartForm(part));
    if (delBtn) delBtn.addEventListener('click', () => armDelete(delBtn, () => deletePartRecord(part, delBtn)));
  });
}

function openPartForm(part) {
  editingPartOldId = part ? String(part.id) : null;
  editingPartOldName = part ? String(part.name) : '';
  document.getElementById('partFormTitle').textContent = part ? 'Edit Part' : 'Add Part';

  const nameEl = document.getElementById('partFormName');
  const numEl = document.getElementById('partFormNumber');
  if (nameEl) nameEl.value = part ? part.name : '';
  if (numEl) numEl.value = part ? part.id : '';

  setPartFormStatus(part ? 'Edit the name and/or number, then press Save Part.' : 'Enter a part name and its Hollander number.', 'muted');
  document.getElementById('partFormModal').classList.remove('hidden');
  setTimeout(() => { if (nameEl) nameEl.focus(); }, 30);
}

function closePartFormModal() {
  document.getElementById('partFormModal').classList.add('hidden');
  editingPartOldId = null;
  editingPartOldName = '';
}

async function savePartForm() {
  const name = (document.getElementById('partFormName')?.value || '').trim();
  const number = (document.getElementById('partFormNumber')?.value || '').trim();

  if (!name || !number) {
    setPartFormStatus('Both the part name and the Hollander number are required.', 'error');
    return;
  }
  if (!/^\d{1,6}$/.test(number)) {
    setPartFormStatus('The Hollander number must be digits only, for example 100.', 'error');
    return;
  }
  const editing = editingPartOldId !== null;
  const normName = normalizePartText(name);
  const sameName = partRows.find(p => normalizePartText(p.name) === normName && String(p.id) !== String(editingPartOldId));
  if (sameName) {
    setPartFormStatus(`"${sameName.name}" is already in the database as ${sameName.id}.`, 'error');
    return;
  }
  const sameNumber = partRows.find(p => String(p.id) === number && String(p.id) !== String(editingPartOldId));
  if (sameNumber) {
    setPartFormStatus(`Number ${number} is already used by "${sameNumber.name}".`, 'error');
    return;
  }
  if (editing && name === editingPartOldName && number === editingPartOldId) {
    setPartFormStatus('No changes to save for that part.', 'muted');
    return;
  }

  const btn = document.getElementById('savePartFormBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  setPartFormStatus(`⏳ Saving "${name} - ${number}"…`, 'muted');

  try {
    const url = editing
      ? `${API_BASE}/parts/${encodeURIComponent(editingPartOldId)}`
      : `${API_BASE}/parts`;

    const res = await fetch(url, {
      method: editing ? 'PATCH' : 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ part_name: name, hollander_id: number })
    });

    if (!res.ok) {
      let msg = `The part could not be saved (${res.status}).`;
      if (res.status === 409) msg = 'That part name or Hollander number already exists.';
      else if (res.status === 401) msg = 'Your session has expired. Reload the page and sign in again.';
      else if (res.status === 403) msg = 'Your account cannot edit the part catalog.';
      else if (res.status === 400) msg = 'Enter a part name and a 1-6 digit Hollander number.';
      throw new Error(msg);
    }

    const matched = editing
      ? updateLocalPart(editingPartOldId, editingPartOldName, name, number)
      : (partRows.push({ name, id: number }), commitPartChange());

    const wasEditing = editing;
    closePartFormModal();
    await searchPartRecords(lastPartTerm);
    setPartsStatus(`${wasEditing ? 'Updated' : 'Added'} "${name} - ${number}". ${matched}/${allRows.length} deliveries matched.`, 'success');
    showToast(`${wasEditing ? 'Updated' : 'Added'} ${name} - ${number}`);
  } catch (err) {
    console.error('Save part failed:', err);
    setPartFormStatus(`${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Part'; }
  }
}

async function deletePartRecord(part, btn) {
  setPartsStatus(`⏳ Deleting "${part.name} - ${part.id}"…`, 'muted');

  try {
    const res = await fetch(`${API_BASE}/parts/${encodeURIComponent(part.id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
      let msg = `The part could not be deleted (${res.status}).`;
      if (res.status === 401) msg = 'Your session has expired. Reload the page and sign in again.';
      else if (res.status === 403) msg = 'Your account cannot edit the part catalog.';
      else if (res.status === 404) msg = 'That part no longer exists.';
      throw new Error(msg);
    }

    partRows = partRows.filter(p => String(p.id) !== String(part.id));
    const matched = commitPartChange();
    await searchPartRecords(lastPartTerm);
    setPartsStatus(`Deleted "${part.name} - ${part.id}". ${matched}/${allRows.length} deliveries matched.`, 'success');
    showToast(`Deleted ${part.name} - ${part.id}`);
  } catch (err) {
    console.error('Delete part failed:', err);
    setPartsStatus(`${apiFailure(err).message}`, 'error');
    disarmDelete(btn);
  }
}

// ================= CUSTOMERS =================
let customerSearchTimer = null;
let customerSearchSeq = 0;
let customerResults = [];
let lastCustomerTerm = '';
let editingCustomerId = null;

function setCustomerStatus(message, tone) {
  const el = document.getElementById('customerSearchStatus');
  if (!el) return;
  el.textContent = message;
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function setCustomerFormStatus(message, tone) {
  const el = document.getElementById('customerFormStatus');
  if (!el) return;
  el.textContent = message;
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function openCustomersModal() {
  document.getElementById('customersModal').classList.remove('hidden');
  const input = document.getElementById('customerSearchInput');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 30); }
  searchCustomers('');
}

function closeCustomersModal() {
  document.getElementById('customersModal').classList.add('hidden');
}

function scheduleCustomerSearch(value) {
  clearTimeout(customerSearchTimer);
  customerSearchTimer = setTimeout(() => searchCustomers(value), 250);
}

function customerDetailLine(c) {
  const bits = [];
  if (c.main_contact) bits.push(c.main_contact);
  const addr = [c.address1, c.address2].filter(Boolean).join(', ');
  if (addr) bits.push(addr);
  const cityLine = [c.city, c.state, c.zip].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (cityLine) bits.push(cityLine);
  if (c.phone) bits.push(formatPhoneDisplay(c.phone));
  if (c.notes) bits.push(c.notes);
  return bits.join(' • ');
}

function customerPayloadFromForm() {
  const val = id => (document.getElementById(id)?.value || '').trim();
  const nullIfEmpty = v => (v ? v : null);
  return {
    shop_name: val('custShopName'),
    main_contact: nullIfEmpty(val('custContact')),
    phone: nullIfEmpty(val('custPhone')),
    address1: nullIfEmpty(val('custAddress1')),
    address2: nullIfEmpty(val('custAddress2')),
    city: nullIfEmpty(val('custCity')),
    state: nullIfEmpty(val('custState').toUpperCase()),
    zip: nullIfEmpty(val('custZip')),
    notes: nullIfEmpty(val('custNotes'))
  };
}

async function searchCustomers(rawTerm) {
  const resultsEl = document.getElementById('customerSearchResults');
  if (!resultsEl) return;
  const term = String(rawTerm || '').trim();
  lastCustomerTerm = term;

  const seq = ++customerSearchSeq;
  setCustomerStatus(term ? '⏳ Searching customers…' : '⏳ Loading all customers…', 'muted');

  try {
    const fetchPage = async (params) => {
      const res = await fetch(`${API_BASE}/customers?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) {
        if (res.status === 401) throw new Error('Your session has expired. Reload the page and sign in again.');
        if (res.status === 403) throw new Error('Your account does not have access to the customer list.');
        throw new Error(`Search failed (${res.status}).`);
      }
      return await res.json();
    };

    const collected = [];
    if (term) {
      const params = new URLSearchParams({ limit: '40', q: term });
      const rows = await fetchPage(params);
      if (seq !== customerSearchSeq) return;
      collected.push(...(Array.isArray(rows) ? rows : []));
    } else {
      // Opening Customers shows the whole directory, not just the first page.
      const pageSize = 1000;
      let offset = 0;
      while (true) {
        const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) });
        const rows = await fetchPage(params);
        if (seq !== customerSearchSeq) return;
        if (!Array.isArray(rows) || !rows.length) break;
        collected.push(...rows);
        if (rows.length < pageSize) break;
        offset += pageSize;
        if (collected.length >= 20000) break;
      }
    }

    customerResults = collected;
    renderCustomerResults(customerResults, term);
  } catch (err) {
    if (seq !== customerSearchSeq) return;
    resultsEl.innerHTML = '';
    setCustomerStatus(`${apiFailure(err).message}`, 'error');
  }
}

function renderCustomerResults(rows, term) {
  const resultsEl = document.getElementById('customerSearchResults');
  if (!resultsEl) return;

  const list = (rows || []).filter(c => c && c.shop_name);
  if (!list.length) {
    resultsEl.innerHTML = '';
    setCustomerStatus(term ? `No customers match "${term}".` : 'No customers in this yard yet. Add one or import the customer CSV.', 'muted');
    return;
  }

  setCustomerStatus(`${list.length.toLocaleString()} customer${list.length === 1 ? '' : 's'} ${term ? 'matching' : 'shown'}.`, 'muted');

  resultsEl.innerHTML = list.map(c => `
    <div class="customer-row" data-id="${escAttr(c.id)}"
      style="display:flex; justify-content:space-between; gap:0.75rem; align-items:flex-start; padding:0.55rem 0; border-bottom:1px solid var(--border);">
      <div style="min-width:0;">
        <div style="font-weight:600; color:#f8fafc; font-size:0.88rem;">${esc(c.shop_name)}</div>
        <div style="font-size:0.78rem; color:var(--text-muted); margin-top:2px; line-height:1.45;">${esc(customerDetailLine(c))}</div>
      </div>
      <div style="display:flex; gap:0.3rem; flex-shrink:0;">
        <button class="btn btn-outline btn-micro cust-edit-btn" type="button">Edit</button>
        <button class="btn btn-outline btn-micro cust-del-btn" type="button">Delete</button>
      </div>
    </div>
  `).join('');

  const byId = new Map(list.map(c => [String(c.id), c]));
  resultsEl.querySelectorAll('.customer-row').forEach(rowEl => {
    const customer = byId.get(rowEl.dataset.id);
    if (!customer) return;

    const editBtn = rowEl.querySelector('.cust-edit-btn');
    const delBtn = rowEl.querySelector('.cust-del-btn');
    if (editBtn) editBtn.addEventListener('click', () => openCustomerForm(customer));
    if (delBtn) delBtn.addEventListener('click', () => armDelete(delBtn, () => deleteCustomer(customer, delBtn)));
  });
}

function openCustomerForm(customer) {
  editingCustomerId = customer && customer.id !== undefined ? customer.id : null;
  document.getElementById('customerFormTitle').textContent = editingCustomerId ? 'Edit Customer' : 'Add Customer';

  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = (v === null || v === undefined) ? '' : v; };
  set('custShopName', customer ? customer.shop_name : '');
  set('custContact', customer ? customer.main_contact : '');
  set('custPhone', customer ? customer.phone : '');
  set('custAddress1', customer ? customer.address1 : '');
  set('custAddress2', customer ? customer.address2 : '');
  set('custCity', customer ? customer.city : '');
  set('custState', customer ? customer.state : '');
  set('custZip', customer ? customer.zip : '');
  set('custNotes', customer ? customer.notes : '');

  setCustomerFormStatus(editingCustomerId ? 'Edit the fields and press Save Customer.' : 'Shop name is required.', 'muted');
  document.getElementById('customerFormModal').classList.remove('hidden');
  setTimeout(() => { const el = document.getElementById('custShopName'); if (el) el.focus(); }, 30);
}

function closeCustomerForm() {
  document.getElementById('customerFormModal').classList.add('hidden');
  editingCustomerId = null;
}

async function saveCustomer() {
  const payload = customerPayloadFromForm();
  if (!payload.shop_name) {
    setCustomerFormStatus('Shop name is required.', 'error');
    return;
  }

  const savingId = editingCustomerId;

  // Normalised duplicate guard (name + address + phone), ignores LLC/Inc, punctuation and address abbreviations.
  const duplicateKey = customerIdentityKey(payload.shop_name, payload.address1, payload.phone);
  const duplicate = dbCustomers.find(c =>
    String(c.id) !== String(savingId) && customerIdentityKey(c.name, c.address1, c.phone) === duplicateKey
  );
  if (duplicate) {
    setCustomerFormStatus(`"${duplicate.name}" at that address and phone is already in the list${duplicate.id ? ` (ID ${duplicate.id})` : ''}.`, 'error');
    return;
  }

  const btn = document.getElementById('saveCustomerBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  setCustomerFormStatus(`⏳ Saving "${payload.shop_name}"…`, 'muted');

  try {
    const url = savingId === null
      ? `${API_BASE}/customers`
      : `${API_BASE}/customers/${encodeURIComponent(savingId)}`;

    const res = await fetch(url, {
      method: savingId === null ? 'POST' : 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      let msg = `The customer could not be saved (${res.status}).`;
      if (res.status === 409) msg = 'A customer with that shop name, address and phone already exists.';
      else if (res.status === 401) msg = 'Your session has expired. Reload the page and sign in again.';
      else if (res.status === 403) msg = 'Your account cannot edit the customer list.';
      else if (res.status === 404) msg = 'That customer no longer exists.';
      else if (res.status === 400) msg = 'Shop name is required.';
      throw new Error(msg);
    }

    const savedRow = await res.json().catch(() => null);
    const entry = {
      id: savingId === null ? (savedRow ? savedRow.id : 'local-' + Date.now()) : savingId,
      name: payload.shop_name,
      address1: payload.address1 || '',
      address2: payload.address2 || '',
      city: payload.city || '',
      state: payload.state || '',
      zip: payload.zip || '',
      phone: payload.phone || ''
    };
    const idx = dbCustomers.findIndex(c => String(c.id) === String(entry.id));
    if (idx !== -1) dbCustomers[idx] = entry;
    else dbCustomers.push(entry);
    buildCustomerIndex();
    applyCustomerLookups(allRows);
    renderTable();

    closeCustomerForm();
    await searchCustomers(lastCustomerTerm);
    setCustomerStatus(`${savingId === null ? 'Added' : 'Updated'} "${payload.shop_name}".`, 'success');
    showToast(`${savingId === null ? 'Added' : 'Updated'} ${payload.shop_name}`);
  } catch (err) {
    console.error('Save customer failed:', err);
    setCustomerFormStatus(`${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Customer'; }
  }
}

async function deleteCustomer(customer, btn) {
  setCustomerStatus(`⏳ Deleting "${customer.shop_name}"…`, 'muted');

  try {
    const res = await fetch(`${API_BASE}/customers/${encodeURIComponent(customer.id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
      let msg = `The customer could not be deleted (${res.status}).`;
      if (res.status === 401) msg = 'Your session has expired. Reload the page and sign in again.';
      else if (res.status === 403) msg = 'Your account cannot edit the customer list.';
      else if (res.status === 404) msg = 'That customer no longer exists.';
      throw new Error(msg);
    }

    customerResults = customerResults.filter(c => String(c.id) !== String(customer.id));
    dbCustomers = dbCustomers.filter(c => String(c.id) !== String(customer.id));
    buildCustomerIndex();
    applyCustomerLookups(allRows);
    renderTable();
    renderCustomerResults(customerResults, lastCustomerTerm);
    setCustomerStatus(`Deleted "${customer.shop_name}".`, 'success');
    showToast(`Deleted ${customer.shop_name}`);
  } catch (err) {
    console.error('Delete customer failed:', err);
    setCustomerStatus(`${err.message}`, 'error');
    disarmDelete(btn);
  }
}

async function importCustomersCsv(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name || '')) {
    setCustomerStatus('Choose a .csv customer export.', 'error');
    return;
  }

  const btn = document.getElementById('importCustomersBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  setCustomerStatus(`Importing ${file.name}…`, 'muted');

  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/customers/import`, {
      method: 'POST',
      credentials: 'same-origin',
      body: form
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.detail || `Import failed (${res.status}).`);

    // Pull the merged list back so report matching sees the new addresses
    // immediately, then refresh the visible modal results.
    await syncCustomers({ silent: true });
    await searchCustomers(lastCustomerTerm);

    const bits = [`${data.added || 0} added`, `${data.updated || 0} updated`];
    if (data.skipped) bits.push(`${data.skipped} skipped`);
    setCustomerStatus(`Imported ${file.name}: ${bits.join(', ')}.`, 'success');
    showToast('Customer import complete.');
  } catch (err) {
    setCustomerStatus(`❌ ${apiFailure(err).message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import CSV'; }
  }
}

// ================= USER IDENTITY & UPLOAD ACTIVITY =================
const CURRENT_USER_KEY = 'sp_current_user';
let uploadRows = [];
let uploadsLoading = false;
let userModalResolver = null;

function getCurrentUser() {
  if (window.PULSE_USER) return String(window.PULSE_USER);
  try { return localStorage.getItem(CURRENT_USER_KEY) || ''; } catch (e) { return ''; }
}

function setCurrentUser(name) {
  try { localStorage.setItem(CURRENT_USER_KEY, name); } catch (e) {}
  updateUserButton();
}

function updateUserButton() {
  const btn = document.getElementById('userBtn');
  if (!btn) return;
  if (EMBED_MODE) {
    btn.classList.add('hidden');
    return;
  }
  const name = getCurrentUser();
  btn.textContent = name ? `${name}` : 'Set user';
}

function populateUserOptions() {
  const dl = document.getElementById('userNameOptions');
  if (!dl) return;
  const names = new Set();
  (typeof reps !== 'undefined' ? reps : []).forEach(r => { if (r.name) names.add(r.name); });
  uploadRows.forEach(u => { if (u.uploader) names.add(u.uploader); });
  const current = getCurrentUser();
  if (current) names.add(current);
  dl.innerHTML = [...names].sort().map(n => `<option value="${escAttr(n)}"></option>`).join('');
}

function setUserModalStatus(msg, tone) {
  const el = document.getElementById('userModalStatus');
  if (!el) return;
  el.textContent = msg;
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function openUserModal(forUpload) {
  const input = document.getElementById('userNameInput');
  const title = document.getElementById('userModalTitle');
  if (input) input.value = getCurrentUser();
  if (title) title.textContent = forUpload ? 'Who is uploading this report?' : 'Set current user';
  setUserModalStatus(forUpload
    ? 'This upload will be recorded under this name so managers can track usage.'
    : 'Choose the person using this browser. Accounts will replace this later.', 'muted');
  populateUserOptions();
  document.getElementById('userModal').classList.remove('hidden');
  setTimeout(() => { if (input) { input.focus(); input.select(); } }, 30);
  return new Promise(resolve => { userModalResolver = resolve; });
}

function finishUserModal(value) {
  document.getElementById('userModal').classList.add('hidden');
  const resolve = userModalResolver;
  userModalResolver = null;
  if (resolve) resolve(value);
}

function saveUserFromModal() {
  const value = (document.getElementById('userNameInput')?.value || '').trim();
  if (!value) {
    setUserModalStatus('Enter a name or email first.', 'error');
    return;
  }
  setCurrentUser(value);
  finishUserModal(value);
}

const PENDING_UPLOADS_KEY = 'sp_pending_uploads';

function readPendingUploads() {
  try {
    const list = JSON.parse(localStorage.getItem(PENDING_UPLOADS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function writePendingUploads(list) {
  try { localStorage.setItem(PENDING_UPLOADS_KEY, JSON.stringify(list)); } catch (e) {}
}

async function postUploadPayload(payload) {
  try {
    const res = await fetch(`${API_BASE}/uploads`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.warn('Upload was not logged:', res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('Upload log failed:', e);
    return false;
  }
}

// Uploads that could not reach the server are kept locally and retried, so an
// outage never loses the record.
async function flushPendingUploads() {
  const list = readPendingUploads();
  if (!list.length) return 0;
  const remaining = [];
  let sent = 0;
  for (const payload of list) {
    const ok = await postUploadPayload(payload);
    if (ok) sent++;
    else remaining.push(payload);
  }
  writePendingUploads(remaining);
  return sent;
}

async function recordUpload(uploader, fileName) {
  const payload = {
    uploader: uploader || 'Unassigned',
    file_name: fileName || '',
    salesperson: salespersonName || '',
    report_date: reportDate || '',
    row_count: allRows.length,
    matched_customers: allRows.filter(r => r.CustomerPhone || r.CustomerAddress).length,
    matched_parts: allRows.filter(r => r.HollanderID).length
  };

  const saved = await postUploadPayload(payload);
  if (saved) {
    flushPendingUploads();
    return;
  }

  payload.uploaded_at = new Date().toISOString();
  const pending = readPendingUploads();
  pending.push(payload);
  writePendingUploads(pending);
  console.warn('Upload saved locally; it will be sent to the platform when the log is reachable.');
}

function setUploadsStatus(msg, tone) {
  const el = document.getElementById('uploadsStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function formatUploadTime(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value || '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function populateUploadsUserFilter() {
  const select = document.getElementById('uploadsUser');
  if (!select) return;
  const previous = select.value;
  const names = new Set();
  (typeof reps !== 'undefined' ? reps : []).forEach(r => { if (r.name) names.add(r.name); });
  uploadRows.forEach(u => { if (u.uploader) names.add(u.uploader); });
  select.innerHTML = '<option value="">All users</option>' + [...names].sort()
    .map(n => `<option value="${escAttr(n)}">${esc(n)}</option>`).join('');
  if (previous && names.has(previous)) select.value = previous;
}

function effectiveUploadStatus(lastUpload) {
  if (!lastUpload) return { label: 'No uploads', color: '#64748b' };
  const days = (Date.now() - new Date(lastUpload).getTime()) / 86400000;
  if (days <= 7) return { label: 'Active', color: '#34d399' };
  if (days <= 30) return { label: 'Low activity', color: '#fbbf24' };
  return { label: 'Idle', color: '#f87171' };
}

function renderUploads() {
  const rangeEl = document.getElementById('uploadsRange');
  const userEl = document.getElementById('uploadsUser');
  if (!rangeEl || !userEl) return;

  const days = parseInt(rangeEl.value, 10) || 0;
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  const userFilter = userEl.value;

  const filtered = uploadRows.filter(u => {
    const t = new Date(u.uploaded_at).getTime();
    if (cutoff && !(t >= cutoff)) return false;
    if (userFilter && u.uploader !== userFilter) return false;
    return true;
  });

  const uniqueUsers = new Set(filtered.map(u => u.uploader).filter(Boolean));
  const todayCount = filtered.filter(u => {
    const d = new Date(u.uploaded_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  }).length;
  const last = filtered[0] ? formatUploadTime(filtered[0].uploaded_at) : '—';

  const summary = document.getElementById('uploadsSummary');
  if (summary) {
    const card = (label, value, color) => `
      <div style="flex:1 1 150px; background:#0D1424; border:1px solid var(--border); border-radius:8px; padding:0.6rem 0.8rem;">
        <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">${label}</div>
        <div style="font-size:1.25rem; font-weight:700; color:${color || 'var(--text)'};">${value}</div>
      </div>`;
    summary.innerHTML = card('Uploads', filtered.length) + card('Users', uniqueUsers.size) + card('Today', todayCount) + card('Last upload', last);
  }

  setUploadsStatus(filtered.length ? `${filtered.length} upload${filtered.length === 1 ? '' : 's'} in this range.` : 'No uploads in this range yet.', 'muted');

  // Utilization: every rep plus anyone who has uploaded.
  const names = new Set();
  (typeof reps !== 'undefined' ? reps : []).forEach(r => { if (r.name) names.add(r.name); });
  uploadRows.forEach(u => { if (u.uploader) names.add(u.uploader); });
  if (userFilter) {
    names.clear();
    names.add(userFilter);
  }

  const utilisation = [...names].map(name => {
    const own = uploadRows.filter(u => u.uploader === name);
    const lastUpload = own.reduce((max, u) => {
      const t = new Date(u.uploaded_at).getTime();
      return t > max ? t : max;
    }, 0);
    const inRange = filtered.filter(u => u.uploader === name).length;
    return { name, inRange, lastUpload: lastUpload ? new Date(lastUpload).toISOString() : null, ownCount: own.length };
  }).sort((a, b) => {
    if (b.inRange !== a.inRange) return b.inRange - a.inRange;
    return a.name.localeCompare(b.name);
  });

  const utilEl = document.getElementById('uploadsUtilization');
  if (utilEl) {
    const header = `
      <div style="display:grid; grid-template-columns:1.5fr 90px 1.3fr 110px; gap:0.5rem; padding:0.45rem 0.75rem; background:#0D1424; font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">
        <span>User</span><span>Uploads</span><span>Last upload</span><span>Status</span>
      </div>`;
    const rowsHtml = utilisation.map(u => {
      const st = effectiveUploadStatus(u.lastUpload);
      return `
        <div style="display:grid; grid-template-columns:1.5fr 90px 1.3fr 110px; gap:0.5rem; padding:0.45rem 0.75rem; border-top:1px solid var(--border); font-size:0.8rem; align-items:center;">
          <span style="font-weight:600; color:#f8fafc;">${esc(u.name)}</span>
          <span>${u.inRange}</span>
          <span style="color:var(--text-muted);">${u.lastUpload ? formatUploadTime(u.lastUpload) : '—'}</span>
          <span style="color:${st.color}; font-weight:600;">${st.label}</span>
        </div>`;
    }).join('');
    utilEl.innerHTML = header + (rowsHtml || '<div style="padding:0.7rem; color:var(--text-muted); font-size:0.8rem;">No reps or uploads yet.</div>');
  }

  // Recent uploads.
  const listEl = document.getElementById('uploadsList');
  if (listEl) {
    const recent = filtered.slice(0, 100);
    if (!recent.length) {
      listEl.innerHTML = '<div style="padding:0.8rem; color:var(--text-muted); font-size:0.8rem;">No uploads to show.</div>';
    } else {
      const header = `
        <div style="display:grid; grid-template-columns:1.1fr 1fr 1.4fr 1.1fr 60px 90px; gap:0.5rem; padding:0.45rem 0.75rem; background:#0D1424; font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; position:sticky; top:0;">
          <span>When</span><span>User</span><span>File</span><span>Report for</span><span>Rows</span><span>Matched</span>
        </div>`;
      const rowsHtml = recent.map(u => `
        <div style="display:grid; grid-template-columns:1.1fr 1fr 1.4fr 1.1fr 60px 90px; gap:0.5rem; padding:0.45rem 0.75rem; border-top:1px solid var(--border); font-size:0.78rem; align-items:center;">
          <span style="color:var(--text-muted);">${esc(formatUploadTime(u.uploaded_at))}</span>
          <span style="font-weight:600; color:#f8fafc;">${esc(u.uploader || 'Unassigned')}${u._pending ? ' <span style="color:#fbbf24; font-size:0.68rem;" title="Saved in this browser, waiting to sync">• pending</span>' : ''}</span>
          <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escAttr(u.file_name || '')}">${esc(u.file_name || '—')}</span>
          <span>${esc(u.salesperson || u.report_date || '—')}</span>
          <span>${u.row_count || 0}</span>
          <span style="color:var(--text-muted);">${u.matched_customers || 0}c / ${u.matched_parts || 0}p</span>
        </div>`).join('');
      listEl.innerHTML = header + rowsHtml;
    }
  }
}

async function loadUploads() {
  if (uploadsLoading) return;

  uploadsLoading = true;
  setUploadsStatus('⏳ Loading upload activity…', 'muted');

  try {
    await flushPendingUploads();

    const collected = [];
    let offset = 0;

    while (true) {
      const params = new URLSearchParams({ limit: '1000', offset: String(offset) });

      const res = await fetch(`${API_BASE}/uploads?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });

      if (!res.ok) {
        if (res.status === 401) throw new Error('Your session has expired. Reload the page and sign in again.');
        if (res.status === 403) throw new Error('Only managers can view upload activity.');
        throw new Error(`Could not load uploads (${res.status}).`);
      }

      const page = await res.json();
      if (!Array.isArray(page) || !page.length) break;
      collected.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
      if (collected.length >= 10000) break;
    }

    const pending = readPendingUploads().map(p => ({ ...p, _pending: true }));
    uploadRows = collected.concat(pending).sort((a, b) => {
      return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
    });
    populateUploadsUserFilter();
    populateUserOptions();
    renderUploads();

    if (pending.length) {
      setUploadsStatus(`${collected.length} upload${collected.length === 1 ? '' : 's'} on record • ${pending.length} waiting to sync from this browser.`, 'muted');
    }
  } catch (err) {
    console.warn('Upload log load failed:', err);
    // Still show this browser's queued uploads so nothing appears lost.
    const pending = readPendingUploads().map(p => ({ ...p, _pending: true }));
    if (pending.length) {
      uploadRows = pending;
      populateUploadsUserFilter();
      renderUploads();
      setUploadsStatus(`${pending.length} upload${pending.length === 1 ? '' : 's'} saved in this browser only — ${apiFailure(err).message}`, 'error');
    } else {
      setUploadsStatus(`${apiFailure(err).message}`, 'error');
    }
  } finally {
    uploadsLoading = false;
  }
}

function openUploadsModal() {
  document.getElementById('uploadsModal').classList.remove('hidden');
  loadUploads();
}

function closeUploadsModal() {
  document.getElementById('uploadsModal').classList.add('hidden');
}

// ================= DELIVERY ANNOUNCEMENT CALLS =================
// Twilio credentials and the spoken script live on the server. The browser
// only asks the platform to place the call, so no key or endpoint is exposed.
const CALL_COOLDOWN_MS = 10 * 60 * 1000;

let callConfig = {
  yardName: '',
  callbackNumber: '',
  testMode: true,
  configured: false
};

async function loadCallSettings() {
  try {
    const res = await fetch(`${API_BASE}/announce/settings`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return;
    const data = await res.json();
    callConfig = {
      yardName: String(data.yard_name || ''),
      callbackNumber: String(data.callback_number || ''),
      testMode: data.test_mode !== false,
      configured: !!data.configured
    };
    refreshCallModal();
  } catch (e) {
    console.warn('Call settings could not be loaded:', e);
  }
}

let currentCall = { phone: '', customer: '' };

function announcementScript() {
  const yard = (callConfig.yardName || '').trim() || 'our parts yard';
  const callback = (callConfig.callbackNumber || '').trim();
  let script = `Hello! This is ${yard} letting you know your delivery is expected today.`;
  if (callback) script += ` Call us at ${callback} if you have any questions.`;
  script += ' Thank you!';
  return script;
}

function toE164(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '';
}

function setCallStatus(message, tone) {
  const el = document.getElementById('callStatus');
  if (!el) return;
  el.textContent = message || '';
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function setCallSettingsStatus(message, tone) {
  const el = document.getElementById('callSettingsStatus');
  if (!el) return;
  el.textContent = message;
  el.style.color = tone === 'error' ? '#f87171' : tone === 'success' ? '#34d399' : 'var(--text-muted)';
}

function callModeBadge() {
  return callConfig.testMode
    ? '<span style="background:rgba(251,191,36,0.15); color:#fbbf24; border:1px solid rgba(251,191,36,0.35); padding:3px 10px; border-radius:12px; font-size:0.72rem; font-weight:700;">TEST MODE — NO CALL WILL BE PLACED</span>'
    : '<span style="background:rgba(248,113,113,0.15); color:#f87171; border:1px solid rgba(248,113,113,0.4); padding:3px 10px; border-radius:12px; font-size:0.72rem; font-weight:700;">LIVE — THIS PLACES A REAL PHONE CALL</span>';
}

function refreshCallModal() {
  const numberEl = document.getElementById('callTargetNumber');
  const customerEl = document.getElementById('callTargetCustomer');
  const scriptEl = document.getElementById('callScriptPreview');
  const badgeEl = document.getElementById('callModeBadge');
  const callBtn = document.getElementById('placeCallBtn');

  if (numberEl) numberEl.textContent = formatPhoneDisplay(currentCall.phone) || currentCall.phone;
  if (customerEl) customerEl.textContent = currentCall.customer || 'this customer';
  if (scriptEl) scriptEl.textContent = announcementScript();
  if (badgeEl) badgeEl.innerHTML = callModeBadge();
  if (callBtn) callBtn.textContent = callConfig.testMode ? 'Simulate call' : 'Place call';

  if (!callConfig.testMode && !callConfig.configured) {
    setCallStatus('Live calling is enabled, but the platform is missing Twilio credentials. Ask an administrator to configure them.', 'error');
  }
}

function openCallModal(phone, customer) {
  currentCall = { phone: String(phone || ''), customer: String(customer || '') };
  setCallStatus(callConfig.testMode
    ? 'Test mode is on: pressing the button only previews the call.'
    : 'This will place a real automated call.', 'muted');
  refreshCallModal();
  document.getElementById('callModal').classList.remove('hidden');
}

function closeCallModal() {
  document.getElementById('callModal').classList.add('hidden');
}

function openCallSettings() {
  const badge = document.getElementById('callSettingsBadge');
  if (badge) badge.innerHTML = callModeBadge();
  const scriptEl = document.getElementById('callSettingsScript');
  if (scriptEl) scriptEl.textContent = announcementScript();
  setCallSettingsStatus(
    callConfig.testMode
      ? 'Test mode is on. The platform will build the script and log the attempt without placing a call.'
      : (callConfig.configured
        ? 'Live mode is on. Pressing the call button places a real automated call.'
        : 'Live mode is on, but Twilio credentials are missing. Ask an administrator to configure them.'),
    callConfig.testMode ? 'muted' : (callConfig.configured ? 'error' : 'error')
  );
  document.getElementById('callSettingsModal').classList.remove('hidden');
  loadCallSettings();
}

function closeCallSettings() {
  document.getElementById('callSettingsModal').classList.add('hidden');
}

async function placeAnnouncementCall() {
  const to = toE164(currentCall.phone);
  if (!to) {
    setCallStatus('That number is not a valid 10-digit US phone number, so no call was placed.', 'error');
    return;
  }

  const cooldownKey = 'sp_call_' + to;
  const last = Number(localStorage.getItem(cooldownKey) || 0);
  if (last && Date.now() - last < CALL_COOLDOWN_MS) {
    const mins = Math.ceil((CALL_COOLDOWN_MS - (Date.now() - last)) / 60000);
    setCallStatus(`This number was already called recently. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 'error');
    return;
  }

  const btn = document.getElementById('placeCallBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Calling…'; }

  try {
    const res = await fetch(`${API_BASE}/announce`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ to })
    });

    let data = {};
    try { data = await res.json(); } catch (e) {}

    if (!res.ok || data.error) {
      throw new Error(data.detail || data.error || `Call service rejected the request (${res.status}).`);
    }

    localStorage.setItem(cooldownKey, String(Date.now()));
    if (data.test) {
      callConfig.testMode = true;
      setCallStatus('Test mode — no call was placed. The text above is exactly what the yard would say.', 'success');
    } else {
      setCallStatus(`Call placed to ${formatPhoneDisplay(currentCall.phone)}.`, 'success');
    }
  } catch (err) {
    console.error('Announcement call failed:', err);
    setCallStatus(`${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = callConfig.testMode ? 'Simulate call' : 'Place call';
    }
  }
}

// Helpers
function formatPhoneDisplay(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

function makeTelLink(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return '';
  const core = digits.length > 10 ? digits.slice(-10) : digits;
  return `tel:+1${core}`;
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(msg) {
  const toast = document.getElementById('toastMessage');
  document.getElementById('toastText').textContent = msg;
  toast.classList.remove('hidden');
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.classList.add('hidden'), 300);
  }, 2500);
}

// ================= PART-ID WIRING =================
buildPartIndex();
buildCustomerIndex();
updatePartIdStatusUI();
updateCustomerMatchUI();

const partIdsModalEl = document.getElementById('partIdsModal');
if (document.getElementById('closePartIdsModal')) {
  document.getElementById('closePartIdsModal').addEventListener('click', () => partIdsModalEl.classList.add('hidden'));
}
if (document.getElementById('syncPartIdsBtn')) {
  document.getElementById('syncPartIdsBtn').addEventListener('click', () => syncParts());
}
if (document.getElementById('useBundledPartsBtn')) {
  document.getElementById('useBundledPartsBtn').addEventListener('click', useBundledParts);
}
if (document.getElementById('refreshPartIdsBtn')) {
  document.getElementById('refreshPartIdsBtn').addEventListener('click', () => syncParts());
}

// Parts manager
const partsModalEl = document.getElementById('partsModal');
const partFormModalEl = document.getElementById('partFormModal');
if (document.getElementById('partsBtn')) {
  document.getElementById('partsBtn').addEventListener('click', openPartsModal);
}
['closePartsModal', 'closePartsFooterBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closePartsModal);
});
if (document.getElementById('partSearchInput')) {
  document.getElementById('partSearchInput').addEventListener('input', e => schedulePartSearch(e.target.value));
}
if (document.getElementById('addPartBtn')) {
  document.getElementById('addPartBtn').addEventListener('click', () => openPartForm(null));
}
if (document.getElementById('partSettingsBtn')) {
  document.getElementById('partSettingsBtn').addEventListener('click', openPartIdsModal);
}
['closePartFormModal', 'cancelPartFormBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closePartFormModal);
});
if (document.getElementById('savePartFormBtn')) {
  document.getElementById('savePartFormBtn').addEventListener('click', savePartForm);
}
['partFormName', 'partFormNumber'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); savePartForm(); }
  });
});
if (partsModalEl) {
  partsModalEl.addEventListener('click', e => { if (e.target === partsModalEl) closePartsModal(); });
}
if (partFormModalEl) {
  partFormModalEl.addEventListener('click', e => { if (e.target === partFormModalEl) closePartFormModal(); });
}

// Customers modal
const customersModalEl = document.getElementById('customersModal');
const customerFormModalEl = document.getElementById('customerFormModal');
if (document.getElementById('customersBtn')) {
  document.getElementById('customersBtn').addEventListener('click', openCustomersModal);
}
['closeCustomersModal', 'closeCustomersFooterBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closeCustomersModal);
});
if (document.getElementById('customerSearchInput')) {
  document.getElementById('customerSearchInput').addEventListener('input', e => scheduleCustomerSearch(e.target.value));
}
if (document.getElementById('addCustomerBtn')) {
  document.getElementById('addCustomerBtn').addEventListener('click', () => openCustomerForm(null));
}
if (document.getElementById('importCustomersBtn')) {
  document.getElementById('importCustomersBtn').addEventListener('click', () => {
    const input = document.getElementById('customerCsvInput');
    if (input) input.click();
  });
}
if (document.getElementById('customerCsvInput')) {
  document.getElementById('customerCsvInput').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) importCustomersCsv(file);
  });
}
['closeCustomerFormModal', 'cancelCustomerFormBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closeCustomerForm);
});
if (document.getElementById('saveCustomerBtn')) {
  document.getElementById('saveCustomerBtn').addEventListener('click', saveCustomer);
}
if (customersModalEl) {
  customersModalEl.addEventListener('click', e => { if (e.target === customersModalEl) closeCustomersModal(); });
}
if (customerFormModalEl) {
  customerFormModalEl.addEventListener('click', e => { if (e.target === customerFormModalEl) closeCustomerForm(); });
}

// ================= USER IDENTITY & UPLOAD ACTIVITY WIRING =================
updateUserButton();
flushPendingUploads();
loadCallSettings();

const userModalEl = document.getElementById('userModal');
if (document.getElementById('userBtn')) {
  document.getElementById('userBtn').addEventListener('click', () => { openUserModal(false); });
}
if (document.getElementById('saveUserBtn')) {
  document.getElementById('saveUserBtn').addEventListener('click', saveUserFromModal);
}
['cancelUserBtn', 'closeUserModal'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => finishUserModal(''));
});
if (userModalEl) {
  userModalEl.addEventListener('click', e => { if (e.target === userModalEl) finishUserModal(''); });
}
if (document.getElementById('userNameInput')) {
  document.getElementById('userNameInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); saveUserFromModal(); }
  });
}

const uploadsModalEl = document.getElementById('uploadsModal');
if (document.getElementById('uploadsBtn')) {
  document.getElementById('uploadsBtn').addEventListener('click', openUploadsModal);
}
['closeUploadsModal', 'closeUploadsFooterBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closeUploadsModal);
});
if (uploadsModalEl) {
  uploadsModalEl.addEventListener('click', e => { if (e.target === uploadsModalEl) closeUploadsModal(); });
}
['uploadsRange', 'uploadsUser'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', renderUploads);
});
if (document.getElementById('refreshUploadsBtn')) {
  document.getElementById('refreshUploadsBtn').addEventListener('click', loadUploads);
}

// Delivery announcement call modals
const callModalEl = document.getElementById('callModal');
const callSettingsModalEl = document.getElementById('callSettingsModal');
['closeCallModal', 'cancelCallBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closeCallModal);
});
if (document.getElementById('openCallSettingsBtn')) {
  document.getElementById('openCallSettingsBtn').addEventListener('click', openCallSettings);
}
if (document.getElementById('placeCallBtn')) {
  document.getElementById('placeCallBtn').addEventListener('click', placeAnnouncementCall);
}
['closeCallSettingsModal', 'cancelCallSettingsBtn'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', closeCallSettings);
});
if (callModalEl) {
  callModalEl.addEventListener('click', e => { if (e.target === callModalEl) closeCallModal(); });
}
if (callSettingsModalEl) {
  callSettingsModalEl.addEventListener('click', e => { if (e.target === callSettingsModalEl) closeCallSettings(); });
}

// Auto-sync from the platform when the cache is missing or older than 12 hours.
// The bundled part list is the offline fallback while this runs.
const partsStale = !partLastSynced || (Date.now() - partLastSynced > 12 * 60 * 60 * 1000);
if (partsStale) syncParts({ silent: true });

const customersStale = !customersLastSynced || (Date.now() - customersLastSynced > CUST_CACHE_HOURS * 60 * 60 * 1000);
if (customersStale) syncCustomers({ silent: true });

// ================= EMBEDDED MODE: ROLE-AWARE UI =================
function applyEmbeddedRoleUI() {
  if (!EMBED_MODE) return;
  const managerRoles = ['owner', 'sales_manager', 'manager'];
  if (!managerRoles.includes(EMBED_ROLE)) {
    const uploadsBtn = document.getElementById('uploadsBtn');
    if (uploadsBtn) uploadsBtn.classList.add('hidden');
    const importBtn = document.getElementById('importCustomersBtn');
    if (importBtn) importBtn.classList.add('hidden');
  }
  const userBtn = document.getElementById('userBtn');
  if (userBtn) userBtn.classList.add('hidden');
}
applyEmbeddedRoleUI();

// Restore the last report for this yard/user so navigating away from the
// Delivery Dashboard does not discard an uploaded report.
try {
  const savedReport = localStorage.getItem(SAVED_SESSION_KEY);
  if (savedReport) {
    const data = JSON.parse(savedReport);
    if (data && Array.isArray(data.rows) && data.rows.length) {
      restoreSavedSession({ silent: true });
    }
  }
} catch (e) {
  console.warn('Saved report could not be restored:', e);
}

// PDF.js worker is bundled locally so parsing works offline and without CDNs.
if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('js/pdf.worker.min.js', document.baseURI).href;
}

// ================= DELEGATED EVENT HANDLERS (CSP-safe) =================
// Generated HTML cannot use inline on* handlers under the app's CSP, so all
// interactions are wired through data-* attributes on the document.
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const card = target.closest('[data-card]');
  if (card) {
    window.handleCardClick(card.getAttribute('data-card'));
    return;
  }

  const assignBtn = target.closest('[data-assign-button]');
  if (assignBtn) {
    window.assignFromModal(assignBtn.getAttribute('data-assign-button'), assignBtn.getAttribute('data-assign-rep'));
    return;
  }

  const acceptBtn = target.closest('[data-accept-suggestion]');
  if (acceptBtn) {
    window.acceptSuggestion(acceptBtn.getAttribute('data-accept-suggestion'), acceptBtn.getAttribute('data-accept-rep'));
    return;
  }

  const viewCallBtn = target.closest('[data-view-call]');
  if (viewCallBtn) {
    const callId = viewCallBtn.getAttribute('data-view-call');
    if (callId && window.parent && window.parent !== window) {
      // Keep the current dispatch board (including unsaved assignments) so it
      // is still there when the user comes back from the call detail page.
      if (hasUnsavedChanges) saveChanges(true);
      window.parent.postMessage({ type: 'sp-open-call', callId }, window.location.origin);
    } else {
      showToast('Open this dashboard inside the platform to view the call.');
    }
    return;
  }

  const savePartBtn = target.closest('[data-save-part]');
  if (savePartBtn) {
    window.saveRowPart(savePartBtn.getAttribute('data-save-part'));
    return;
  }

  if (target.closest('[data-cancel-part]')) {
    window.cancelRowPart();
    return;
  }

  const editPartBtn = target.closest('[data-edit-part]');
  if (editPartBtn) {
    window.editRowPart(editPartBtn.getAttribute('data-edit-part'));
    return;
  }

  const removeRepBtn = target.closest('[data-remove-rep]');
  if (removeRepBtn) {
    window.removeRep(Number(removeRepBtn.getAttribute('data-remove-rep')));
  }
});

document.addEventListener('change', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const assignSelect = target.closest('[data-assign-select]');
  if (assignSelect) {
    window.assignFromModal(assignSelect.getAttribute('data-assign-select'), assignSelect.value);
    return;
  }

  const repSelect = target.closest('[data-rep-select]');
  if (repSelect) {
    window.handleRepChange(repSelect.getAttribute('data-rep-select'), repSelect.value);
  }
});

// ================= LIVE DATA FROM THE PULSE CONSOLE =================
// The React shell posts the yard's real reps and recent calls so matching and
// dispatch use live data instead of the bundled demo records.
window.addEventListener('message', event => {
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'sp-delivery-calls' && Array.isArray(data.calls)) {
    calls = data.calls;
    saveCalls();
    reevaluateSuggestions();
    updateMetrics();
    renderTable();
    return;
  }

  if (data.type === 'sp-delivery-reps' && Array.isArray(data.reps)) {
    reps = data.reps;
    saveReps();
    updateRepDropdowns();
    updateMetrics();
    renderTable();
  }
});

// Announce readiness so the console can push data as soon as the frame boots.
if (window.parent && window.parent !== window) {
  try { window.parent.postMessage({ type: 'sp-delivery-ready' }, window.location.origin); } catch (e) {}
}
