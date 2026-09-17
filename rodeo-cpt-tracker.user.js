// ==UserScript==
// @name         Rodeo CPT Tracker - MQJ4
// @namespace    rodeo-iad.amazon.com
// @version      1.41.0
// @description  Auto-captures work pool values at every CPT. Floating panel on Rodeo.
// @match        *://rodeo-iad.amazon.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      rodeo-iad.amazon.com
// @run-at       document-start
// @updateURL    https://raw.githubusercontent.com/Emmanuel-Dunmade/My-First-Project/master/rodeo-cpt-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/Emmanuel-Dunmade/My-First-Project/master/rodeo-cpt-tracker.user.js
// ==/UserScript==

(function () {
'use strict';

// =============================================================================
// CONFIGURATION
// =============================================================================

const CPT_TIMES = ['21:00', '22:00', '00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '10:00', '13:00', '17:00'];

// Shift starts at 18:00. CPT_SHIFT_MINS are minutes elapsed since 18:00
// for each CPT, in the same order as CPT_TIMES:
//   21:00 = 180 min, 22:00 = 240, 00:00 = 360, 01:00 = 420,
//   02:00 = 480, 03:00 = 540, 04:00 = 600, 10:00 = 960
const SHIFT_START_HOUR = 18;
const CPT_SHIFT_MINS   = [180, 240, 360, 420, 480, 540, 600, 660, 960, 1140, 1380];

// Each display pool lists every Rodeo sub-pool section that contributes to it.
// scanDOM finds each sub-pool heading in the DOM and sums their Total-row values.
// Late Assign = PickingNotYetPickedNotPrioritized (standalone LateAssign never renders).
const POOL_GROUPS = {
  'Grand Total'            : ['row:Total'],
  'Pending Inventory'      : ['PendingInventoryBinding'],
  'Ready To Pick'          : ['ReadyToPick'],
  'Late Assign'            : ['section:PickingNotYetPicked:PPLateAssignCR', 'section:PickingNotYetPicked:PPLateAssignOP'],
  'Picking Not Yet Picked' : ['PickingNotYetPicked'],
  'Picking Picked'         : ['PickingPicked', 'PickingPickedRouting'],
  'In Progress'            : ['PickingPickedInProgress'],
  'In Transit'             : ['PickingPickedInTransit'],
  'At Destination'         : ['PickingPickedAtDestination'],
  'Cross Dock'             : ['Crossdock', 'CrossdockNotYetPicked'],
  'Palletized'             : ['Palletized', 'PalletizedStaged'],
  'Manual Sort'            : [
    'section:PickingPickedAtDestination:PPHOVReserveManualGrouping',
    'section:PickingPickedAtDestination:PPTransLUK2Manual',
    'section:PickingPickedInTransit:PPHOVReserveManualGrouping',
  ],
};

// Visual style overrides per pool label.
// grand-total = prominent top row; sub-metric = indented breakdown row.
const POOL_STYLE = {
  'Grand Total': 'metric-row grand-total',
  'In Progress': 'metric-row sub-metric',
  'In Transit' : 'metric-row sub-metric',
};

// Maps a CPT label to a different column to read from the DOM.
// 05:00 is in CPT_TIMES (so the countdown targets it), but we read the 10:00 column.
const CPT_COLUMN_MAP = {
  '05:00': '10:00',
};

// Risk engine thresholds — alert fires when PNYP exceeds ALERT_PNYP_THRESHOLD
// AND the CPT is within ALERT_MINS_TO_CPT minutes. Adjust per site.
const ALERT_PNYP_THRESHOLD = 300;
const ALERT_MINS_TO_CPT    = 45;

// =============================================================================
// ▼▼▼  CHANGE THIS to your FC code if deploying to a different building  ▼▼▼
const DEFAULT_FC = 'MQJ4';
// ▲▲▲  You can also click the FC chip in the panel header to switch live  ▲▲▲
// =============================================================================

const ALL_POOLS    = Object.values(POOL_GROUPS).flat().filter(function(p){ return !p.startsWith('section:') && !p.startsWith('row:'); });
const SORTED_POOLS = ALL_POOLS.slice().sort(function(a,b){ return b.length - a.length; });
const MONTHS       = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

let histSelectMode = false;

// Drag state: set true during a drag so badge onclick doesn't also toggle panel.
var _didDrag = false;

// Per-CPT live PNYP cache for the Overview tab.
// Populated by scanFuturePnyp() so each row shows its own column value,
// not the global "current PNYP" from the latest capture (which is 0 once cleared).
var _ovPnypCache = {};  // { cptHHMM: pnypValue | null }
var _ovPnypAge   = 0;   // Date.now() when cache was last populated

// =============================================================================
// MULTI-SITE — FC detection, per-FC storage, runtime FC switching
// =============================================================================

// Auto-detect FC from URL params; fall back to stored setting or 'MQJ4'.
// Click the FC chip in the panel header to switch FCs at any time.
var currentFC = (function() {
  var stored = GM_getValue('cpt_fc_name', '');
  if (stored) return stored;
  var params = new URLSearchParams(window.location.search);
  var keys = ['fc', 'fcCode', 'warehouseId', 'site', 'building', 'warehouse'];
  for (var i = 0; i < keys.length; i++) {
    var v = params.get(keys[i]);
    if (v && /^[A-Z0-9]{2,8}$/i.test(v.trim())) return v.trim().toUpperCase();
  }
  var hm = window.location.href.match(/[?&/]([A-Z]{2,4}\d[A-Z0-9]{0,3})\b/);
  if (hm) return hm[1].toUpperCase();
  return DEFAULT_FC; // falls back to the constant above
})();

// Storage key namespaced by FC so captures from different sites never mix.
function capturesKey() { return 'cpt_captures_' + currentFC; }

// One-time migration: move legacy unified key into the FC-specific key.
function migrateCaptures() {
  var newKey = capturesKey();
  if (GM_getValue(newKey, '') !== '') return; // already migrated
  var old = GM_getValue('cpt_captures', '');
  if (!old) return;
  GM_setValue(newKey, old);
  console.log('[CPT v1.33.0] Captures migrated -> ' + newKey);
}

// =============================================================================
// ICON — inline SVG cartoon Amazon box character (Amazon FC-themed)
// =============================================================================
var CPT_ICON_SVG = '<svg id="cpt-icon" width="30" height="30" viewBox="0 0 30 30" xmlns="http://www.w3.org/2000/svg">' +
  // Box flaps (top)
  '<path d="M4 12 L15 10 L26 12 L26 13 L4 13 Z" fill="#d97706"/>' +
  // Box body
  '<rect x="4" y="13" width="22" height="14" rx="2.5" fill="#f59e0b"/>' +
  // Tape stripe
  '<rect x="13" y="13" width="4" height="14" fill="#fde68a" opacity="0.8" rx="0.5"/>' +
  // Box crease line
  '<line x1="4" y1="15.5" x2="26" y2="15.5" stroke="#d97706" stroke-width="0.7" opacity="0.45"/>' +
  // Eyes (white bg)
  '<circle cx="11" cy="20" r="2.4" fill="white"/>' +
  '<circle cx="19" cy="20" r="2.4" fill="white"/>' +
  // Pupils
  '<circle cx="11.6" cy="20.5" r="1.2" fill="#1c2444"/>' +
  '<circle cx="19.6" cy="20.5" r="1.2" fill="#1c2444"/>' +
  // Eye shine dots
  '<circle cx="12.1" cy="19.8" r="0.45" fill="white"/>' +
  '<circle cx="20.1" cy="19.8" r="0.45" fill="white"/>' +
  // Amazon smile curve
  '<path d="M9.5 24.5 Q15 27.8 20.5 24.5" stroke="#92400e" stroke-width="1.6" fill="none" stroke-linecap="round"/>' +
  // Smile arrow tip
  '<path d="M19 24 L21 24.5 L19.8 26.2" stroke="#92400e" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
'</svg>';

// =============================================================================
// DATE HELPERS
// =============================================================================

// The date the current shift started on.
// Before SHIFT_START_HOUR the shift began yesterday; at/after it began today.
function shiftAnchorDate() {
  var d = new Date();
  if (d.getHours() < SHIFT_START_HOUR) d.setDate(d.getDate() - 1);
  return d;
}

// Returns the calendar date a CPT column belongs to.
// Evening CPTs (21:00, 22:00) are on the shift anchor date.
// Overnight/morning CPTs (00:00-10:00) are on anchor + 1 day.
function cptDate(cptHHMM) {
  var h = parseInt(cptHHMM.split(':')[0], 10);
  var d = shiftAnchorDate();
  if (h < SHIFT_START_HOUR) d.setDate(d.getDate() + 1);
  return d;
}

function rodeoDateStr(d) {
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

function cptColumnLabel(cptHHMM) {
  return rodeoDateStr(cptDate(cptHHMM)) + ' ' + cptHHMM;
}

// How many minutes into the current shift we are (0 = 18:00 sharp).
function shiftRelativeMinutes() {
  var now = new Date();
  var rel = now.getHours() * 60 + now.getMinutes() - SHIFT_START_HOUR * 60;
  if (rel < 0) rel += 1440; // overnight — before 18:00 clock time
  return rel;
}

// Returns the next CPT time string ('21:00', '22:00', etc.) in shift order.
// CPT_SHIFT_MINS and CPT_TIMES are parallel arrays so index always matches.
function nextCptTime() {
  var rel = shiftRelativeMinutes();
  for (var i = 0; i < CPT_SHIFT_MINS.length; i++) {
    if (CPT_SHIFT_MINS[i] > rel) return CPT_TIMES[i];
  }
  return CPT_TIMES[0]; // past last CPT — wrap to 21:00 of next shift
}

// =============================================================================
// STORAGE
// =============================================================================

function loadCaptures() {
  try   { return JSON.parse(GM_getValue(capturesKey(), '[]')); }
  catch { return []; }
}
function saveCaptures(list) {
  GM_setValue(capturesKey(), JSON.stringify(list.slice(0, 500)));
}

// Network intercept removed (v1.41.0) — was patching window.fetch and XHR
// prototype in page world, conflicting with 1DC CaseView script.
// Named CPT auto-captures always use DOM scan. Manual captures fall back to GM_xmlhttpRequest.

// =============================================================================
// CPT SCHEDULER
// =============================================================================

setInterval(function() {
  var now  = new Date();
  if (now.getSeconds() > 45) return;
  var hhmm = pad(now.getHours()) + ':' + pad(now.getMinutes());
  if (!CPT_TIMES.includes(hhmm)) return;
  // Retry every 20 s until a successful auto-capture exists for this CPT today.
  // Old fired_ key approach permanently blocked retries when the DOM scan failed.
  var today = dateStr();
  var already = loadCaptures().some(function(c) {
    return c.cpt === hhmm && c.status === 'ok' && c.timestamp.startsWith(today) && c.source === 'auto';
  });
  if (already) return;
  captureAndSave(hhmm, 'auto');
}, 20000);

// =============================================================================
// CAPTURE
// FIX v1.11: Named CPT captures always use DOM scan so they read the specific
// CPT column from the table, not the aggregated JSON total.
// Manual captures fall back to GM_xmlhttpRequest (no page-world fetch/XHR patching).
// =============================================================================

function captureAndSave(cptLabel, source) {
  setStatus('Capturing\u2026');
  var isNamedCpt = CPT_TIMES.includes(cptLabel);


  setStatus('Scanning Rodeo table\u2026');
  var domData = scanDOM(cptLabel);
  if (domData) {
    doSave(cptLabel, source, domData);
    return;
  }

  // For manual captures only, fall back to a direct request
  if (!isNamedCpt) {
    setStatus('Trying direct request\u2026');
    var pageUrl = window.location.href;
    var attempts = [
      { url: pageUrl, accept: 'application/json' },
      { url: pageUrl, accept: 'application/json, text/javascript, */*; q=0.01' },
    ];
    tryGMRequest(attempts, 0, function(data, usedUrl) {
      if (data) {
        doSave(cptLabel, source, data);
        return;
      }
      setStatus('Could not read data \u2014 click \uD83D\uDD0D for debug info.');
      showDebugHint();
    });
    return;
  }

  // Named CPT: DOM scan found nothing — show debug hint
  setStatus('CPT column not found in DOM \u2014 click \uD83D\uDD0D for debug info.');
  showDebugHint();
}

function tryGMRequest(attempts, i, cb) {
  if (i >= attempts.length) { cb(null, null); return; }
  var a = attempts[i];
  GM_xmlhttpRequest({
    method: 'GET', url: a.url,
    headers: { 'Accept': a.accept, 'X-Requested-With': 'XMLHttpRequest' },
    withCredentials: true,
    onload: function(resp) {
      if (resp.status === 200) {
        try { var d = JSON.parse(resp.responseText); if (d && typeof d === 'object') { cb(d, a.url); return; } } catch(_) {}
      }
      tryGMRequest(attempts, i + 1, cb);
    },
    onerror: function() { tryGMRequest(attempts, i + 1, cb); }
  });
}

// =============================================================================
// DOM SCANNER v1.22.0
//
// Every table is cloned and stripped of non-Rodeo columns before scanning.
// This makes the scanner immune to any columns injected by third-party scripts
// (e.g. the 1DC Case View script that adds Cases, Pickers, PUPPY, Target HC…).
// Only Rodeo-native columns survive: blank name col, Total variants, date+time.
// =============================================================================

function cellNum(td) {
  if (!td) return NaN;
  var a   = td.querySelector('a');
  var raw = (a ? a.textContent : td.textContent).replace(/,/g, '').trim();
  return parseInt(raw, 10);
}

// Returns true for column headers that belong to a Rodeo-native table.
function isRodeoHeader(text) {
  if (!text) return true;                                          // blank (name col placeholder)
  if (/\btotal\b/i.test(text)) return true;                       // Total / Earlier Total / Range Total
  if (/^\d{2}:\d{2}$/.test(text)) return true;                    // 21:00
  if (/^[a-z]{3}\s+\d{1,2}$/i.test(text)) return true;           // Aug 3
  if (/^[a-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}$/i.test(text)) return true; // Aug 3 21:00
  return false;
}

// Returns a deep clone of `table` with every non-Rodeo column removed.
// Correctly handles colspan/rowspan across header rows.
function rodeoTableClone(table) {
  var rows = Array.from(table.rows);
  if (!rows.length) return table.cloneNode(true);

  // Pass 1 — determine which logical column indices to keep.
  // Scan first 4 rows with full colspan/rowspan accounting.
  var p1occ  = {};
  var keepCol = {};

  function markOcc(occ, r, c, rs, cs) {
    for (var rr = r; rr < r + rs; rr++) {
      if (!occ[rr]) occ[rr] = {};
      for (var cc = c; cc < c + cs; cc++) occ[rr][cc] = true;
    }
  }

  for (var r1 = 0; r1 < Math.min(rows.length, 4); r1++) {
    if (!p1occ[r1]) p1occ[r1] = {};
    var lc1 = 0;
    Array.from(rows[r1].children).forEach(function(cell) {
      if (cell.tagName !== 'TH' && cell.tagName !== 'TD') return;
      while (p1occ[r1][lc1]) lc1++;
      var text = cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase();
      var cs1  = parseInt(cell.getAttribute('colspan') || '1', 10);
      var rs1  = parseInt(cell.getAttribute('rowspan') || '1', 10);
      markOcc(p1occ, r1, lc1, rs1, cs1);
      if (lc1 === 0 || isRodeoHeader(text)) {
        for (var kc = lc1; kc < lc1 + cs1; kc++) keepCol[kc] = true;
      }
      lc1 += cs1;
    });
  }
  keepCol[0] = true; // always keep the label/name column

  // Pass 2 — strip non-kept cells from ALL rows with full colspan/rowspan accounting.
  var clone = table.cloneNode(true);
  var p2occ = {};

  Array.from(clone.rows).forEach(function(row, ri) {
    if (!p2occ[ri]) p2occ[ri] = {};
    var lc2 = 0;
    var toRemove = [];
    Array.from(row.children).forEach(function(cell) {
      if (cell.tagName !== 'TH' && cell.tagName !== 'TD') return;
      while (p2occ[ri][lc2]) lc2++;
      var cs2 = parseInt(cell.getAttribute('colspan') || '1', 10);
      var rs2 = parseInt(cell.getAttribute('rowspan') || '1', 10);
      markOcc(p2occ, ri, lc2, rs2, cs2);
      var anyKeep = false;
      for (var kc2 = lc2; kc2 < lc2 + cs2; kc2++) {
        if (keepCol[kc2]) { anyKeep = true; break; }
      }
      if (!anyKeep) toRemove.push(cell);
      lc2 += cs2;
    });
    for (var j = toRemove.length - 1; j >= 0; j--) {
      if (toRemove[j].parentNode) toRemove[j].parentNode.removeChild(toRemove[j]);
    }
  });

  return clone;
}

// Walk next siblings at each ancestor level (up to 6 levels up).
// Handles deeply-nested headings like: b > div > div > section.
function findTableAfter(el) {
  var current = el;
  for (var level = 0; level < 6; level++) {
    var node  = current.nextElementSibling;
    var limit = (level === 0) ? 8 : 5;
    for (var i = 0; i < limit && node; i++) {
      if (node.tagName === 'TABLE') return node;
      var t = node.querySelector('table');
      if (t) return t;
      node = node.nextElementSibling;
    }
    if (!current.parentElement) break;
    current = current.parentElement;
  }
  return null;
}

// Returns the nearest TABLE ancestor of el (heading embedded inside a table).
function findTableOf(el) {
  var node = el.parentElement;
  while (node && node !== document.body) {
    if (node.tagName === 'TABLE') return node;
    node = node.parentElement;
  }
  return null;
}

// When a pool heading is a row INSIDE a table (section header row),
// find the next subtotal/total row that belongs to that section.
function findSectionTotalRowAfter(headingEl, table) {
  var rows       = Array.from(table.querySelectorAll('tr'));
  var headingRow = null;
  for (var r = 0; r < rows.length; r++) {
    if (rows[r].contains(headingEl)) { headingRow = rows[r]; break; }
  }
  if (!headingRow) return null;
  var start = rows.indexOf(headingRow) + 1;
  for (var i = start; i < rows.length; i++) {
    var cells = rows[i].querySelectorAll('td');
    if (!cells.length) continue;
    if (cells[0].textContent.trim().toLowerCase() === 'total') return rows[i];
    if (rows[i].querySelector('td.subtotal, th.subtotal')) return rows[i];
  }
  return null;
}

// Sum data rows in a clean-cloned table starting from `startRow` index.
function sumSectionDataRowsByIdx(table, startRow, colIdx) {
  var rows = Array.from(table.rows);
  var sum = 0; var found = false;
  for (var i = startRow; i < rows.length; i++) {
    var rc = Array.from(rows[i].querySelectorAll('td, th'));
    if (!rc.length) continue;
    if (rc[0].tagName === 'TH') break;
    if (rc[0].textContent.trim().toLowerCase() === 'total') continue;
    var n;
    if (colIdx >= 0) {
      n = rc[colIdx] ? cellNum(rc[colIdx]) : NaN;
    } else {
      n = NaN;
      for (var ci = 1; ci < rc.length && isNaN(n); ci++) {
        var nn = cellNum(rc[ci]);
        if (!isNaN(nn) && nn >= 0) n = nn;
      }
    }
    if (!isNaN(n) && n >= 0) { sum += n; found = true; }
  }
  return found ? sum : NaN;
}

function findTotalRow(table) {
  var rows = Array.from(table.querySelectorAll('tr'));
  for (var i = 0; i < rows.length; i++) {
    var cells = rows[i].querySelectorAll('td, th');
    if (!cells.length) continue;
    if (cells[0].textContent.trim().toLowerCase() === 'total') return rows[i];
  }
  var last = null;
  rows.forEach(function(r) { if (r.querySelector('td.subtotal')) last = r; });
  return last;
}

// Find the logical column index for a given date+time label (e.g. "Jul 30 02:00").
function findCptColumn(table, targetLabel) {
  // Strip leading zero from day number: "aug 02 21:00" -> "aug 2 21:00"
  function normDay(s) { return s.replace(/ 0(\d)(?= |$)/, ' $1'); }

  var target   = normDay(targetLabel.toLowerCase().trim());
  var parts    = target.split(' ');
  var wantDate = parts[0] + ' ' + parts[1];
  var wantTime = parts[2];

  var rows     = Array.from(table.querySelectorAll('tr'));
  var occupied = {};
  var colDate  = {};
  var colTime  = {};

  function markOccupied(r, c, rs, cs) {
    for (var rr = r; rr < r + rs; rr++) {
      if (!occupied[rr]) occupied[rr] = {};
      for (var cc = c; cc < c + cs; cc++) occupied[rr][cc] = true;
    }
  }

  for (var r = 0; r < Math.min(rows.length, 6); r++) {
    if (!occupied[r]) occupied[r] = {};
    var col = 0;
    // Direct children only — avoids counting cells from nested tables
    var children = Array.from(rows[r].children);
    for (var ci = 0; ci < children.length; ci++) {
      var cell = children[ci];
      if (cell.tagName !== 'TH' && cell.tagName !== 'TD') continue;
      while (occupied[r][col]) col++;
      // Normalize day number in cell text to match our target
      var text    = normDay(cell.textContent.replace(/\s+/g, ' ').trim().toLowerCase());
      var colspan = parseInt(cell.getAttribute('colspan') || '1', 10);
      var rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10);
      markOccupied(r, col, rowspan, colspan);

      // Direct hit: full label in one cell e.g. "aug 2 21:00"
      if (text === target) return col;

      // Combined pattern: "aug 2 21:00"
      if (/^[a-z]+ \d+ \d{2}:\d{2}$/.test(text)) {
        var tp = text.split(' ');
        colDate[col] = tp[0] + ' ' + tp[1];
        colTime[col] = tp[2];
      }
      // Two-row layout: date spanning multiple columns e.g. "aug 2"
      if (/^[a-z]+ \d+$/.test(text)) {
        for (var c2 = col; c2 < col + colspan; c2++) colDate[c2] = text;
      }
      // Two-row layout: time in its own row e.g. "21:00"
      if (/^\d{2}:\d{2}$/.test(text)) {
        colTime[col] = text;
      }
      col += colspan;
    }
  }

  var fallback = -1;
  for (var idx in colTime) {
    if (colTime[idx] === wantTime) {
      if (colDate[idx] === wantDate) return parseInt(idx, 10);
      if (!colDate[idx] && fallback < 0) fallback = parseInt(idx, 10);
    }
  }
  return fallback;
}

function scanDOM(cptLabel) {
  var isNamedCpt = CPT_TIMES.includes(cptLabel);
  var colTarget  = isNamedCpt ? cptColumnLabel(CPT_COLUMN_MAP[cptLabel] || cptLabel) : null;
  var usingTotal = !isNamedCpt;

  console.log('[CPT v1.40.0] Scan cpt="' + cptLabel + '" colTarget="' + colTarget + '"');

  var byLabel = {};
  Object.keys(POOL_GROUPS).forEach(function(lbl) { byLabel[lbl] = 0; });
  var hits = 0;

  var allElements = Array.from(document.querySelectorAll(
    'b, strong, h1, h2, h3, h4, h5, h6, th, td, div, span, p'
  ));

  // Check every sub-pool for every group and sum all — never stop early.
  Object.keys(POOL_GROUPS).forEach(function(lbl) {
    POOL_GROUPS[lbl].forEach(function(subPool) {

      // --- row: prefix — scan a named process-path row in the main table ---
      if (subPool.startsWith('row:')) {
        var ppName    = subPool.slice(4);
        var rawMain   = document.querySelector('table');
        if (!rawMain) return;
        var cleanMain = rodeoTableClone(rawMain);
        var ppAllRows = Array.from(cleanMain.querySelectorAll('tr'));
        for (var rr = 0; rr < ppAllRows.length; rr++) {
          var ppCells = Array.from(ppAllRows[rr].querySelectorAll('td, th'));
          if (!ppCells.length) continue;
          if (ppCells[0].textContent.trim() !== ppName) continue;
          if (usingTotal) {
            for (var pci = 0; pci < ppCells.length; pci++) {
              var ppn = cellNum(ppCells[pci]);
              if (!isNaN(ppn) && ppn >= 0) { byLabel[lbl] += ppn; hits++; break; }
            }
          } else {
            var ppIdx = findCptColumn(cleanMain, colTarget);
            if (ppIdx >= 0 && ppCells[ppIdx]) {
              var ppn2 = cellNum(ppCells[ppIdx]);
              if (!isNaN(ppn2) && ppn2 >= 0) { byLabel[lbl] += ppn2; hits++; }
              console.log('[CPT v1.40.0] "' + lbl + '" row=' + ppName + ' idx=' + ppIdx + ' val=' + ppn2);
            }
          }
          break;
        }
        return;
      }

      // --- section:SectionName:RowName — named row within a specific section ---
      if (subPool.startsWith('section:')) {
        var sParts   = subPool.split(':');
        var sSection = sParts[1].toLowerCase();
        var sRow     = sParts[2];
        for (var si = 0; si < allElements.length; si++) {
          var sel = allElements[si];
          if (sel.textContent.trim().toLowerCase() !== sSection) continue;
          if (sel.children.length > 2) continue;
          if (sel.closest && sel.closest('#cpt-root')) continue;
          if (sel.closest && sel.closest('form')) continue;
          var rawStbl  = findTableAfter(sel) || findTableOf(sel);
          if (!rawStbl) continue;
          var cleanStbl = rodeoTableClone(rawStbl);
          var stRows    = Array.from(cleanStbl.querySelectorAll('tr'));
          for (var sr = 0; sr < stRows.length; sr++) {
            var srCells = Array.from(stRows[sr].querySelectorAll('td, th'));
            if (!srCells.length) continue;
            if (srCells[0].textContent.trim() !== sRow) continue;
            if (usingTotal) {
              for (var sc = 0; sc < srCells.length; sc++) {
                var sn = cellNum(srCells[sc]);
                if (!isNaN(sn) && sn >= 0) { byLabel[lbl] += sn; hits++; break; }
              }
            } else {
              var sIdx = findCptColumn(cleanStbl, colTarget);
              if (sIdx >= 0 && srCells[sIdx]) {
                var sn2 = cellNum(srCells[sIdx]);
                if (!isNaN(sn2) && sn2 >= 0) { byLabel[lbl] += sn2; hits++; }
                console.log('[CPT v1.40.0] "' + lbl + '" section=' + sSection + ' row=' + sRow + ' idx=' + sIdx + ' val=' + sn2);
              }
            }
            break;
          }
          break;
        }
        return;
      }

      // --- Normal work-pool section scan ---
      var alias = subPool.toLowerCase();

      for (var i = 0; i < allElements.length; i++) {
        var el   = allElements[i];
        var text = el.textContent.trim().toLowerCase();
        // TH section-heading cells may have 1DC nested elements appended, inflating
        // textContent. Fall back to checking direct text nodes only for TH elements.
        if (text !== alias) {
          if (el.tagName !== 'TH') continue;
          var ownTxt = '';
          for (var tni = 0; tni < el.childNodes.length; tni++) {
            if (el.childNodes[tni].nodeType === 3) ownTxt += el.childNodes[tni].nodeValue;
          }
          if (ownTxt.trim().toLowerCase() !== alias) continue;
        }
        // Relax children limit for TH — 1DC may inject nested elements into section headings.
        if (el.tagName !== 'TH' && el.children.length > 2) continue;
        if (el.closest && el.closest('#cpt-root')) continue;
        // Skip filter checkboxes in the Rodeo sidebar — inside <form> tags, not section headings.
        if (el.closest && el.closest('form')) continue;

        var rawTable   = null;
        var embedded   = false;
        var headRowIdx = -1;

        if (el.tagName !== 'TH' && el.tagName !== 'TD') {
          rawTable = findTableAfter(el);
        }
        if (!rawTable) {
          rawTable = findTableOf(el);
          if (rawTable) {
            embedded = true;
            var origRowArr = Array.from(rawTable.rows);
            for (var rri = 0; rri < origRowArr.length; rri++) {
              if (origRowArr[rri].contains(el)) { headRowIdx = rri; break; }
            }
          }
        }
        if (!rawTable) continue;

        if (!embedded) {
          for (var tskip = 0; tskip < 4; tskip++) {
            if (rawTable.rows[0] && rawTable.rows[0].cells.length >= 5) break;
            var nextT = findTableAfter(rawTable);
            if (!nextT || nextT === rawTable) break;
            console.log('[CPT v1.40.0] "' + lbl + '" sub=' + subPool + ' skipped narrow table (cols=' + rawTable.rows[0].cells.length + '), trying next');
            rawTable = nextT;
          }
        }

        // Build clean clone — strips 1DC-injected columns before any index math.
        var cleanTbl = rodeoTableClone(rawTable);

        if (embedded) {
          var ftHdr = (cleanTbl.rows[0] && cleanTbl.rows[0].cells[0])
            ? cleanTbl.rows[0].cells[0].textContent.replace(/\s+/g, ' ').trim().toLowerCase()
            : '';
          if (/^planned/.test(ftHdr)) continue;
        }

        var totalRow = null;
        if (!embedded) {
          totalRow = findTotalRow(cleanTbl);
        } else if (headRowIdx >= 0) {
          var cleanRows = Array.from(cleanTbl.rows);
          if (el.tagName === 'TH') {
            totalRow = cleanRows[headRowIdx];
          } else {
            for (var cri = headRowIdx + 1; cri < cleanRows.length; cri++) {
              var cfc = cleanRows[cri].cells[0];
              if (!cfc) continue;
              if (cfc.tagName === 'TH') break;
              if (cfc.textContent.trim().toLowerCase() === 'total' ||
                  cleanRows[cri].querySelector('td.subtotal, th.subtotal')) {
                totalRow = cleanRows[cri]; break;
              }
            }
          }
        }

        var cells  = totalRow ? Array.from(totalRow.querySelectorAll('td, th')) : [];
        var colIdx = usingTotal ? -1 : findCptColumn(cleanTbl, colTarget);

        if (usingTotal) {
          var gotU = false;
          for (var c = 0; c < cells.length; c++) {
            var nu = cellNum(cells[c]);
            if (!isNaN(nu) && nu >= 0) {
              byLabel[lbl] += nu; hits++; gotU = true;
              console.log('[CPT v1.40.0] "' + lbl + '" sub=' + subPool + ' Total col' + c + '=' + nu + (embedded ? ' (emb)' : ''));
              break;
            }
          }
          if (!gotU && embedded && headRowIdx >= 0) {
            var fbU = sumSectionDataRowsByIdx(cleanTbl, headRowIdx + 1, -1);
            if (!isNaN(fbU)) { byLabel[lbl] += fbU; hits++; console.log('[CPT v1.40.0] "' + lbl + '" sub=' + subPool + ' Total fallback rows=' + fbU); }
          }
        } else {
          var gotC = false;
          if (colIdx >= 0 && cells[colIdx]) {
            var nc = cellNum(cells[colIdx]);
            if (!isNaN(nc) && nc >= 0) {
              byLabel[lbl] += nc; hits++; gotC = true;
              console.log('[CPT v1.40.0] "' + lbl + '" sub=' + subPool + ' col="' + colTarget + '" idx=' + colIdx + ' val=' + nc + (embedded ? ' (emb)' : ''));
            }
          }
          if (!gotC && embedded && colIdx >= 0 && headRowIdx >= 0) {
            var fbC = sumSectionDataRowsByIdx(cleanTbl, headRowIdx + 1, colIdx);
            if (!isNaN(fbC)) { byLabel[lbl] += fbC; hits++; console.log('[CPT v1.40.0] "' + lbl + '" sub=' + subPool + ' col=' + colIdx + ' fallback rows=' + fbC); }
          } else if (!gotC && colIdx < 0) {
            console.warn('[CPT v1.40.0] "' + lbl + '" sub=' + subPool + ' col="' + colTarget + '" NOT FOUND');
          }
        }

        if (usingTotal || colIdx >= 0) break;
      }
    });
  });

  if (hits > 0) {
    byLabel['Picking Not Yet Picked'] = Math.max(0,
      byLabel['Picking Not Yet Picked'] - byLabel['Late Assign']);
    console.log('[CPT v1.40.0] DOM scan ok. hits=' + hits, byLabel);
    return { __domScan: true, byLabel: byLabel, colTarget: colTarget };
  }

  if (!isNamedCpt) {
    console.log('[CPT v1.40.0] Section scan empty, trying href fallback\u2026');
    var allRows  = Array.from(document.querySelectorAll('table tr'));
    var grandRow = null; var maxSub = 0;
    allRows.forEach(function(tr) {
      var cnt = tr.querySelectorAll('td.subtotal').length;
      if (cnt > maxSub) { maxSub = cnt; grandRow = tr; }
    });
    if (grandRow && maxSub >= 2) {
      Array.from(grandRow.querySelectorAll('a')).forEach(function(a) {
        var href = (a.getAttribute('href') || '').toLowerCase();
        var n    = parseInt(a.textContent.replace(/,/g,'').trim(), 10);
        if (!href || isNaN(n) || n <= 0) return;
        var matched = false;
        for (var i = 0; i < SORTED_POOLS.length; i++) {
          if (href.includes(SORTED_POOLS[i].toLowerCase())) {
            for (var lbl in POOL_GROUPS) {
              if (POOL_GROUPS[lbl].indexOf(SORTED_POOLS[i]) >= 0 && !matched) {
                byLabel[lbl] += n; hits++; matched = true;
              }
            }
            break;
          }
        }
      });
    }
    return hits > 0 ? { __domScan: true, byLabel: byLabel, colTarget: null } : null;
  }

  return null; // named CPT with no matching column found
}

// =============================================================================
// DEBUG OVERLAY
// =============================================================================

function elChainStr(el) {
  var chain = el.tagName.toLowerCase();
  var p = el.parentElement;
  for (var pi = 0; pi < 4 && p && p.tagName !== 'BODY'; pi++) {
    var cls = (p.className && typeof p.className === 'string') ? (p.className.split(' ').filter(Boolean)[0] || '') : '';
    chain = p.tagName.toLowerCase() + (cls ? '.' + cls : '') + ' > ' + chain;
    p = p.parentElement;
  }
  return chain;
}

function buildDebugReport() {
  var lines = ['=== CPT Tracker v1.40.0 Debug ===', 'URL: ' + window.location.href, ''];
  var now = new Date();
  lines.push('Current time: ' + pad(now.getHours()) + ':' + pad(now.getMinutes()));
  lines.push('Shift relative: ' + shiftRelativeMinutes() + ' min since ' + pad(SHIFT_START_HOUR) + ':00');
  lines.push('Next CPT: ' + nextCptTime() + '  ->  column "' + cptColumnLabel(nextCptTime()) + '"');
  lines.push('');
  lines.push('--- Column targets for each CPT ---');
  CPT_TIMES.forEach(function(t) { lines.push('  ' + t + '  -> column "' + cptColumnLabel(t) + '"'); });
  lines.push('');
  lines.push('--- Header cells in first table found ---');
  var firstTable = document.querySelector('table');
  if (firstTable) {
    var hrows = Array.from(firstTable.querySelectorAll('tr')).slice(0, 4);
    hrows.forEach(function(row, ri) {
      var cells = Array.from(row.children).filter(function(c){ return c.tagName==='TH'||c.tagName==='TD'; });
      lines.push('  row ' + ri + ': ' + cells.map(function(c){ return '"' + c.textContent.trim() + '"'; }).join(' | '));
    });
  } else {
    lines.push('  (no table found)');
  }
  lines.push('');
  lines.push('--- Sub-pool scan (per POOL_GROUPS) — mirrors scanDOM logic exactly ---');
  var allEls    = Array.from(document.querySelectorAll('b,strong,h1,h2,h3,h4,h5,h6,th,td,div,span'));
  var colTarget = cptColumnLabel(nextCptTime());
  Object.keys(POOL_GROUPS).forEach(function(lbl) {
    lines.push(lbl + ':');
    POOL_GROUPS[lbl].forEach(function(subPool) {

      // --- row: prefix ---
      if (subPool.startsWith('row:')) {
        var ppName   = subPool.slice(4);
        var mainTbl  = document.querySelector('table');
        var cleanM   = mainTbl ? rodeoTableClone(mainTbl) : null;
        var ppIdx    = cleanM ? findCptColumn(cleanM, colTarget) : -1;
        var ppVal    = null;
        if (cleanM) {
          var dbRows = Array.from(cleanM.querySelectorAll('tr'));
          for (var rr = 0; rr < dbRows.length; rr++) {
            var dbCells = Array.from(dbRows[rr].querySelectorAll('td, th'));
            if (!dbCells.length) continue;
            if (dbCells[0].textContent.trim() !== ppName) continue;
            ppVal = ppIdx >= 0 ? cellNum(dbCells[ppIdx]) : null;
            break;
          }
        }
        lines.push('  sub="' + subPool + '" [process-path row scan]');
        lines.push('    col="' + colTarget + '" idx=' + ppIdx + (ppVal !== null ? ' val=' + ppVal : ' (row not found in table)'));
        return;
      }

      // --- section: prefix (mirrors scanDOM section: logic exactly) ---
      if (subPool.startsWith('section:')) {
        var sParts   = subPool.split(':');
        var sSection = sParts[1].toLowerCase();
        var sRow     = sParts[2];
        var secFound = false;
        for (var si = 0; si < allEls.length; si++) {
          var sel = allEls[si];
          if (sel.textContent.trim().toLowerCase() !== sSection) continue;
          if (sel.children.length > 2) continue;
          if (sel.closest && sel.closest('#cpt-root')) continue;
          if (sel.closest && sel.closest('form')) continue;
          var rawStbl   = findTableAfter(sel) || findTableOf(sel);
          if (!rawStbl) continue;
          var cleanStbl = rodeoTableClone(rawStbl);
          var sIdx      = findCptColumn(cleanStbl, colTarget);
          var stRows    = Array.from(cleanStbl.querySelectorAll('tr'));
          var sVal      = null;
          for (var sr = 0; sr < stRows.length; sr++) {
            var srCells = Array.from(stRows[sr].querySelectorAll('td, th'));
            if (!srCells.length) continue;
            if (srCells[0].textContent.trim() !== sRow) continue;
            sVal = (sIdx >= 0 && srCells[sIdx]) ? cellNum(srCells[sIdx]) : null;
            break;
          }
          lines.push('  sub="' + subPool + '"');
          lines.push('    section <' + elChainStr(sel) + '> col="' + colTarget + '" idx=' + sIdx + (sVal !== null ? ' val=' + sVal : ' (row "' + sRow + '" not in section table)'));
          secFound = true;
          break;
        }
        if (!secFound) lines.push('  sub="' + subPool + '" -> section heading "' + sSection + '" not found in DOM');
        return;
      }

      // --- Normal pool scan (mirrors scanDOM embedded/after logic exactly) ---
      var alias    = subPool.toLowerCase();
      var matchNum = 0;
      for (var i = 0; i < allEls.length; i++) {
        var el   = allEls[i];
        var text = el.textContent.trim().toLowerCase();
        if (text !== alias) {
          if (el.tagName !== 'TH') continue;
          var ownTxtD = '';
          for (var tniD = 0; tniD < el.childNodes.length; tniD++) {
            if (el.childNodes[tniD].nodeType === 3) ownTxtD += el.childNodes[tniD].nodeValue;
          }
          if (ownTxtD.trim().toLowerCase() !== alias) continue;
        }
        if (el.tagName !== 'TH' && el.children.length > 2) continue;
        if (el.closest && el.closest('#cpt-root')) continue;
        if (el.closest && el.closest('form')) continue;
        matchNum++;

        var rawTable   = null;
        var dbEmbedded = false;
        var headRowIdx = -1;
        if (el.tagName !== 'TH' && el.tagName !== 'TD') {
          rawTable = findTableAfter(el);
        }
        if (!rawTable) {
          rawTable = findTableOf(el);
          if (rawTable) {
            dbEmbedded = true;
            var origRowArr = Array.from(rawTable.rows);
            for (var rri = 0; rri < origRowArr.length; rri++) {
              if (origRowArr[rri].contains(el)) { headRowIdx = rri; break; }
            }
          }
        }
        if (!rawTable) { lines.push('  sub="' + subPool + '" <' + elChainStr(el) + '> no table found'); break; }

        if (!dbEmbedded) {
          for (var tskipD = 0; tskipD < 4; tskipD++) {
            if (rawTable.rows[0] && rawTable.rows[0].cells.length >= 5) break;
            var nextTD = findTableAfter(rawTable);
            if (!nextTD || nextTD === rawTable) {
              lines.push('  sub="' + subPool + '" [narrow table (' + rawTable.rows[0].cells.length + ' cols), no next table found]');
              break;
            }
            lines.push('  sub="' + subPool + '" [skipped narrow table (' + rawTable.rows[0].cells.length + ' cols), trying next]');
            rawTable = nextTD;
          }
        }

        var cleanTbl  = rodeoTableClone(rawTable);
        var cleanRows = Array.from(cleanTbl.rows);

        if (dbEmbedded) {
          var ftHdrD = (cleanTbl.rows[0] && cleanTbl.rows[0].cells[0])
            ? cleanTbl.rows[0].cells[0].textContent.replace(/\s+/g, ' ').trim().toLowerCase()
            : '';
          if (/^planned/.test(ftHdrD)) {
            lines.push('  sub="' + subPool + '" <' + elChainStr(el) + '> [skipped — Planned/forecast table]');
            continue;
          }
        }

        var colIdx    = findCptColumn(cleanTbl, colTarget);
        var strategy  = dbEmbedded ? 'embedded' : 'after';

        var totalRow = null;
        if (!dbEmbedded) {
          totalRow = findTotalRow(cleanTbl);
        } else if (headRowIdx >= 0) {
          if (el.tagName === 'TH') {
            totalRow = cleanRows[headRowIdx];
          } else {
            for (var cri = headRowIdx + 1; cri < cleanRows.length; cri++) {
              var cfc = cleanRows[cri].cells[0];
              if (!cfc) continue;
              if (cfc.tagName === 'TH') break;
              if (cfc.textContent.trim().toLowerCase() === 'total' ||
                  cleanRows[cri].querySelector('td.subtotal, th.subtotal')) {
                totalRow = cleanRows[cri]; break;
              }
            }
          }
        }

        var cells  = totalRow ? Array.from(totalRow.querySelectorAll('td, th')) : [];
        var val    = (colIdx >= 0 && cells[colIdx]) ? cellNum(cells[colIdx]) : null;
        var first6 = cells.slice(0,6).map(function(td){ var a=td.querySelector('a'); return (a?a.textContent:td.textContent).trim(); }).join(' | ');
        lines.push('  sub="' + subPool + '" <' + elChainStr(el) + '>');
        lines.push('    strategy=' + strategy + (el.tagName==='TH'?' [TH→headRow]':'') + ' col="' + colTarget + '" idx=' + colIdx + (val !== null ? ' val=' + val : ' (no data)'));
        lines.push('    row[0..5]: ' + (first6 || '(none)'));
        if (colIdx < 0 && rawTable) {
          var dbHdrRows = Array.from(rawTable.querySelectorAll('tr')).slice(0, 2);
          dbHdrRows.forEach(function(hr, hri) {
            var hcells = Array.from(hr.children).filter(function(c){ return c.tagName==='TH'||c.tagName==='TD'; });
            lines.push('    section hdr row ' + hri + ' (' + hcells.length + ' cols): ' + hcells.slice(0,12).map(function(c){ return '"' + c.textContent.replace(/\s+/g,' ').trim() + '"'; }).join(' | '));
          });
        }
        if (rawTable && totalRow && colIdx >= 0) break;
        if (matchNum >= 6) break;
      }
      if (matchNum === 0) lines.push('  sub="' + subPool + '" -> not found in DOM (row absent when empty)');
    });
    lines.push('');
  });
  return lines.join('\n');
}


function showDebugOverlay() {
  var existing = document.getElementById('cpt-debug-overlay');
  if (existing) { existing.remove(); return; }
  var overlay = document.createElement('div');
  overlay.id = 'cpt-debug-overlay';
  overlay.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483646;background:#0f172a;border:2px solid #4ade80;border-radius:10px;padding:16px;width:660px;max-height:78vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.9);font-family:monospace;font-size:11px;color:#e2e8f0';
  overlay.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px"><span style="color:#4ade80;font-weight:700;font-size:13px">&#128269; Debug v1.39.1</span><button id="cpt-debug-close" style="background:#374151;border:none;color:#e2e8f0;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px">Close</button></div><pre style="white-space:pre-wrap;word-break:break-all;margin:0;line-height:1.5">' + escHtml(buildDebugReport()) + '</pre>';
  document.body.appendChild(overlay);
  document.getElementById('cpt-debug-close').onclick = function() { overlay.remove(); };
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function showDebugHint() {
  var btn = document.getElementById('cpt-debug-btn');
  if (btn) { btn.style.background='#7f1d1d'; btn.style.borderColor='#ef4444'; btn.style.color='#fca5a5'; }
}

// =============================================================================
// SAVE + METRICS
// =============================================================================

function doSave(cptLabel, source, raw) {
  var metrics  = buildMetrics(raw);
  var colUsed  = (raw && raw.colTarget) ? raw.colTarget : 'Total';
  var snapshot = { fc: currentFC, cpt: cptLabel, timestamp: new Date().toISOString(), status: 'ok', source: source, metrics: metrics, col: colUsed };
  var existing = loadCaptures().filter(function(c) {
    return !(source === 'auto' && c.source === 'auto' && c.cpt === cptLabel && c.timestamp.startsWith(dateStr()));
  });
  existing.unshift(snapshot);
  saveCaptures(existing);
  showCurrentSnapshot(snapshot);
  setStatus('Saved \u2014 CPT ' + cptLabel + ' (' + colUsed + ') at ' + fmtTime(snapshot.timestamp) + (source === 'auto' ? ' (auto)' : ' (manual)'));
  flashDot();
  checkAndShowAlerts();
  _ovPnypAge = 0; // invalidate per-CPT cache so Overview reflects latest data
  refreshOverviewIfVisible();
}

function buildMetrics(raw) {
  if (raw && raw.__domScan && raw.byLabel) {
    var out2 = {};
    Object.keys(POOL_GROUPS).forEach(function(label) { out2[label] = raw.byLabel[label] || 0; });
    return out2;
  }
  var raw2 = {};
  ALL_POOLS.forEach(function(k) { raw2[k] = 0; });
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    Object.keys(obj).forEach(function(k) {
      if (k in raw2 && typeof obj[k] === 'number') raw2[k] += obj[k];
      else walk(obj[k]);
    });
  }
  walk(raw);
  var out = {};
  Object.keys(POOL_GROUPS).forEach(function(label) {
    out[label] = POOL_GROUPS[label].reduce(function(s, p) { return s + (raw2[p] || 0); }, 0);
  });
  return out;
}


// =============================================================================
// RISK ENGINE — clearance rate, per-CPT projection, alert management
// =============================================================================

// Minutes until a CPT fires in this shift (negative = already passed).
function minsUntilCpt(cptHHMM) {
  var idx = CPT_TIMES.indexOf(cptHHMM);
  if (idx < 0) return null;
  return CPT_SHIFT_MINS[idx] - shiftRelativeMinutes();
}

// Today's ok captures sorted oldest first (for rate / trend maths).
function shiftCapturesForFC() {
  var today = dateStr();
  return loadCaptures()
    .filter(function(c) { return c.status === 'ok' && c.timestamp.startsWith(today); })
    .reverse();
}

// Units per minute being cleared from PNYP across the last 4 captures.
function clearanceRate() {
  var caps = shiftCapturesForFC();
  if (caps.length < 2) return null;
  var recent = caps.slice(-4);
  var a = recent[0];
  var b = recent[recent.length - 1];
  var pa = (a.metrics && a.metrics['Picking Not Yet Picked']) || 0;
  var pb = (b.metrics && b.metrics['Picking Not Yet Picked']) || 0;
  var dtMin = (new Date(b.timestamp) - new Date(a.timestamp)) / 60000;
  if (dtMin < 10) return null;
  return (pa - pb) / dtMin;
}

// Risk level for one CPT.
// For future CPTs, prefers the per-CPT live column PNYP from _ovPnypCache
// over the latest capture's global PNYP — captures reflect current cleared
// state, not the inventory specifically committed to each future CPT column.
function cptRisk(cptHHMM) {
  var minsLeft = minsUntilCpt(cptHHMM);
  var caps     = shiftCapturesForFC();

  // CPT has passed — report what was captured at that time
  if (minsLeft !== null && minsLeft <= 0) {
    var doneCap = null;
    for (var di = caps.length - 1; di >= 0; di--) {
      if (caps[di].cpt === cptHHMM) { doneCap = caps[di]; break; }
    }
    if (!doneCap) return { level: 'future', pnyp: null, minsLeft: minsLeft };
    var dp = (doneCap.metrics && doneCap.metrics['Picking Not Yet Picked']) || 0;
    return { level: dp === 0 ? 'done-clean' : 'done-units', pnyp: dp, minsLeft: minsLeft };
  }

  // Use per-CPT column PNYP from live scan when available.
  // Falls back to latest-capture PNYP if scan hasn't run yet.
  var livePnyp     = _ovPnypCache[cptHHMM];
  var hasCachePnyp = livePnyp !== undefined && livePnyp !== null;

  if (!caps.length && !hasCachePnyp) return { level: 'future', pnyp: null, minsLeft: minsLeft };

  var pnyp = hasCachePnyp
    ? livePnyp
    : ((caps[caps.length - 1].metrics && caps[caps.length - 1].metrics['Picking Not Yet Picked']) || 0);
  var rate = clearanceRate();

  if (pnyp === 0)     return { level: 'green', pnyp: 0,    rate: rate, minsLeft: minsLeft };
  if (minsLeft > 180) return { level: 'green', pnyp: pnyp, rate: rate, minsLeft: minsLeft };

  if (rate === null) {
    if (minsLeft > ALERT_MINS_TO_CPT)    return { level: 'green', pnyp: pnyp, minsLeft: minsLeft };
    if (pnyp > ALERT_PNYP_THRESHOLD)     return { level: 'red',   pnyp: pnyp, minsLeft: minsLeft };
    if (pnyp > 100)                      return { level: 'amber', pnyp: pnyp, minsLeft: minsLeft };
    return { level: 'green', pnyp: pnyp, minsLeft: minsLeft };
  }

  if (rate <= 0) return { level: 'red', pnyp: pnyp, rate: rate, minsLeft: minsLeft, note: 'PNYP stalled' };

  var minsToZero = pnyp / rate;
  var buffer     = minsLeft - minsToZero;
  if (buffer > 30) return { level: 'green', pnyp: pnyp, rate: rate, minsLeft: minsLeft, minsToZero: minsToZero };
  if (buffer > 0)  return { level: 'amber', pnyp: pnyp, rate: rate, minsLeft: minsLeft, minsToZero: minsToZero };
  return           { level: 'red',   pnyp: pnyp, rate: rate, minsLeft: minsLeft, minsToZero: minsToZero };
}

// =============================================================================
// OVERVIEW TAB
// =============================================================================

var OV_ICON  = { 'green':'🟢', 'amber':'🟡', 'red':'🔴', 'done-clean':'✅', 'done-units':'🟠', 'future':'⚪' };
var OV_CLASS = { 'green':'ov-green', 'amber':'ov-amber', 'red':'ov-red', 'done-clean':'ov-done', 'done-units':'ov-done-units', 'future':'' };

function renderOverview() {
  var rate     = clearanceRate();
  var rateDisp = rate === null
    ? 'Need 2+ captures for clearance rate'
    : rate <= 0
      ? '\u26A0 PNYP not clearing (' + (rate * 60).toFixed(0) + ' /hr)'
      : '\u25B2 ' + (rate * 60).toFixed(0) + ' units/hr clearing';

  var rows = CPT_TIMES.map(function(cpt) {
    var risk     = cptRisk(cpt);
    var minsLeft = minsUntilCpt(cpt);
    var icon     = OV_ICON[risk.level]  || '\u26AA';
    var cls      = OV_CLASS[risk.level] || '';

    var timeStr = minsLeft === null ? '' : minsLeft <= 0 ? 'Done' :
      minsLeft < 60  ? Math.round(minsLeft) + 'm' :
      Math.floor(minsLeft / 60) + 'h ' + (Math.round(minsLeft) % 60) + 'm';

    var etaStr = risk.pnyp === 0 ? 'Clear' :
      (risk.minsToZero !== undefined && risk.rate > 0)
        ? Math.round(risk.minsToZero) + 'm'
        : (risk.note || '');

    return '<div class="ov-row ' + cls + '">' +
      '<span class="ov-icon">' + icon + '</span>' +
      '<span class="ov-cpt-lbl">' + cpt + '</span>' +
      '<span class="ov-pnyp-val">' + (risk.pnyp !== null ? risk.pnyp.toLocaleString() : '\u2014') + '</span>' +
      '<span class="ov-time-val">' + timeStr + '</span>' +
      '<span class="ov-eta-val">'  + etaStr  + '</span>' +
    '</div>';
  }).join('');

  return '<div id="ov-rate-bar">' +
    '<span id="ov-rate-txt">' + rateDisp + '</span>' +
    '<button id="ov-handoff-btn">\uD83D\uDCCB Handoff</button>' +
  '</div>' +
  '<div class="ov-hdr"><span></span><span>CPT</span><span>PNYP</span><span>To CPT</span><span>ETA Clear</span></div>' +
  rows;
}

// Scan all future CPT columns for live PNYP values and populate _ovPnypCache.
// Uses a setTimeout chain (30ms between CPTs) to avoid blocking the UI.
// Re-renders the Overview when all scans complete.
function scanFuturePnyp() {
  var now = Date.now();
  if (now - _ovPnypAge < 90000) return;  // cache still fresh (< 90 s)
  _ovPnypAge = now;  // mark started to prevent re-entry during async chain

  var future = CPT_TIMES.filter(function(c) { return minsUntilCpt(c) > 0; });
  var i = 0;

  (function next() {
    if (i >= future.length) {
      var ovEl = document.getElementById('ov-content');
      if (ovEl && !document.getElementById('tab-overview').classList.contains('hidden')) {
        ovEl.innerHTML = renderOverview();
        bindHandoffBtn();
      }
      return;
    }
    var cpt    = future[i++];
    var result = scanDOM(cpt);
    _ovPnypCache[cpt] = (result && result.byLabel)
      ? (result.byLabel['Picking Not Yet Picked'] || 0)
      : null;
    setTimeout(next, 30);
  })();
}

function bindHandoffBtn() {
  var btn = document.getElementById('ov-handoff-btn');
  if (!btn) return;
  btn.onclick = function() {
    var report = generateHandoffReport();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(report)
        .then(function() { setStatus('Handoff report copied to clipboard.'); })
        .catch(function() { showHandoffFallback(report); });
    } else {
      showHandoffFallback(report);
    }
  };
}

function showHandoffFallback(text) {
  var existing = document.getElementById('cpt-handoff-overlay');
  if (existing) { existing.remove(); return; }
  var ov = document.createElement('div');
  ov.id  = 'cpt-handoff-overlay';
  ov.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483646;background:#0f172a;border:2px solid #4ade80;border-radius:10px;padding:16px;width:560px;max-height:70vh;overflow-y:auto;box-shadow:0 12px 40px rgba(0,0,0,.9);font-family:monospace';
  ov.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
    '<span style="color:#4ade80;font-weight:700;font-size:13px">\uD83D\uDCCB Handoff Report \u2014 Select all &amp; copy</span>' +
    '<button id="cpt-ho-close" style="background:#374151;border:none;color:#e2e8f0;border-radius:4px;padding:3px 10px;cursor:pointer;font-size:12px">Close</button></div>' +
    '<textarea readonly style="width:100%;height:280px;background:#060c18;color:#e2e8f0;border:1px solid #334155;border-radius:6px;padding:8px;font-family:monospace;font-size:11px;resize:vertical;box-sizing:border-box;white-space:pre">' + escHtml(text) + '</textarea>';
  document.body.appendChild(ov);
  document.getElementById('cpt-ho-close').onclick = function() { ov.remove(); };
  ov.querySelector('textarea').select();
}

function refreshOverviewIfVisible() {
  var ovTab = document.getElementById('tab-overview');
  if (!ovTab || ovTab.classList.contains('hidden')) return;
  scanFuturePnyp();  // kick off per-CPT scan if cache is stale (async, re-renders when done)
  document.getElementById('ov-content').innerHTML = renderOverview();
  bindHandoffBtn();
}

// =============================================================================
// HANDOFF REPORT
// =============================================================================

function generateHandoffReport() {
  var caps  = shiftCapturesForFC();
  var now   = new Date();
  var rate  = clearanceRate();
  var byCpt = {};
  caps.forEach(function(c) { byCpt[c.cpt] = c; });

  var lines = [
    '=== ' + currentFC + ' Outbound Flow \u2014 Shift Handoff ===',
    'Generated : ' + now.toLocaleDateString() + '  ' + pad(now.getHours()) + ':' + pad(now.getMinutes()),
    'Clear rate: ' + (rate !== null ? (rate * 60).toFixed(0) + ' units/hr' : 'N/A (need 2+ captures)'),
    '',
    'CPT    | Grand Tot  | PNYP  | RTP   | Late  | Pal   | Status'
  ];

  CPT_TIMES.forEach(function(cpt) {
    var c        = byCpt[cpt];
    var minsLeft = minsUntilCpt(cpt);
    if (!c) {
      var st = (minsLeft !== null && minsLeft <= 0) ? 'NO DATA' : 'PENDING';
      lines.push(cpt + '   | \u2014          | \u2014     | \u2014     | \u2014     | \u2014     | ' + st);
      return;
    }
    var m    = c.metrics || {};
    var gt   = String((m['Grand Total']             || 0).toLocaleString()).padStart(10);
    var pnyp = String((m['Picking Not Yet Picked']  || 0).toLocaleString()).padStart(5);
    var rtp  = String((m['Ready To Pick']           || 0).toLocaleString()).padStart(5);
    var la   = String((m['Late Assign']             || 0).toLocaleString()).padStart(5);
    var pal  = String((m['Palletized']              || 0).toLocaleString()).padStart(5);
    var risk = cptRisk(cpt);
    var status = risk.level === 'done-clean' ? 'HIT \u2713' :
                 risk.level === 'done-units' ? 'LATE (' + (m['Picking Not Yet Picked'] || 0) + ' PNYP)' :
                 c.source === 'auto' ? 'auto' : 'manual';
    lines.push(cpt + '   | ' + gt + ' | ' + pnyp + ' | ' + rtp + ' | ' + la + ' | ' + pal + ' | ' + status);
  });

  return lines.join('\n');
}

// =============================================================================
// ALERTS
// =============================================================================

function checkAndShowAlerts() {
  var bar = document.getElementById('cpt-alert-bar');
  if (!bar) return;
  var alerts = [];
  CPT_TIMES.forEach(function(cpt) {
    var ml = minsUntilCpt(cpt);
    if (ml === null || ml <= 0 || ml > ALERT_MINS_TO_CPT) return;
    var risk = cptRisk(cpt);
    if (risk.level === 'red' || risk.level === 'amber') alerts.push({ cpt: cpt, risk: risk });
  });
  if (!alerts.length) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  bar.innerHTML = alerts.map(function(a) {
    var icon = a.risk.level === 'red' ? '\uD83D\uDEA8' : '\u26A0\uFE0F';
    var msg  = icon + ' CPT ' + a.cpt;
    if (a.risk.pnyp !== null)          msg += ' \u2014 ' + a.risk.pnyp.toLocaleString() + ' PNYP';
    if (a.risk.minsLeft !== undefined)  msg += ' \u2014 ' + Math.round(a.risk.minsLeft) + ' min left';
    if (a.risk.minsToZero !== undefined) msg += ' \u2014 clears in ' + Math.round(a.risk.minsToZero) + ' min';
    if (a.risk.note)                    msg += ' \u2014 ' + a.risk.note;
    return '<div class="cpt-alert-item cpt-alert-' + a.risk.level + '">' + msg + '</div>';
  }).join('');
}

// =============================================================================
// PANEL UI
// =============================================================================


// =============================================================================
// DRAG — makes #cpt-root freely repositionable; saves position across reloads
// =============================================================================

function initDrag() {
  var root  = document.getElementById('cpt-root');
  var badge = document.getElementById('cpt-badge');
  if (!root || !badge) return;

  // Restore saved position from previous session
  try {
    var saved = JSON.parse(GM_getValue('cpt_pos', 'null'));
    if (saved && typeof saved.left === 'number') {
      root.style.right  = 'auto';
      root.style.left   = Math.min(saved.left, window.innerWidth  - 60) + 'px';
      root.style.top    = Math.min(saved.top,  window.innerHeight - 40) + 'px';
    }
  } catch(_) {}

  var sx, sy, sl, st;

  badge.addEventListener('mousedown', function(e) {
    if (e.button !== 0) return;
    _didDrag = false;
    sx = e.clientX; sy = e.clientY;
    var r = root.getBoundingClientRect();
    sl = r.left; st = r.top;
    e.preventDefault();

    function onMove(ev) {
      var dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!_didDrag && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        _didDrag = true;
        root.style.right = 'auto';
        root.classList.add('dragging');
      }
      if (_didDrag) {
        var nx = Math.max(0, Math.min(window.innerWidth  - root.offsetWidth,  sl + dx));
        var ny = Math.max(0, Math.min(window.innerHeight - root.offsetHeight, st + dy));
        root.style.left = nx + 'px';
        root.style.top  = ny + 'px';
      }
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      root.classList.remove('dragging');
      if (_didDrag) {
        GM_setValue('cpt_pos', JSON.stringify({
          left: parseInt(root.style.left, 10),
          top:  parseInt(root.style.top,  10)
        }));
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// =============================================================================
// CATCHUP — fires missed CPTs on page load
// =============================================================================

function catchupMissedCpts() {
  var today    = dateStr();
  var captures = loadCaptures();
  var captured = {};
  captures.forEach(function(c) {
    if (c.timestamp.startsWith(today) && c.status === 'ok') captured[c.cpt] = true;
  });
  var rel = shiftRelativeMinutes();
  CPT_TIMES.forEach(function(cpt, i) {
    if (captured[cpt]) return;
    if (CPT_SHIFT_MINS[i] > rel) return;
    console.log('[CPT v1.30.0] Catchup: missing CPT ' + cpt + ', scanning now\u2026');
    captureAndSave(cpt, 'auto');
  });
}

function buildPanel() {
  if (document.getElementById('cpt-root')) return;
  migrateCaptures();
  var style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);
  var root = document.createElement('div');
  root.id  = 'cpt-root';
  root.innerHTML = [
    '<div id="cpt-badge"><span id="cpt-dot"></span>' + CPT_ICON_SVG + '<span id="cpt-badge-label">' + currentFC + '</span><span id="cpt-badge-sep">·</span><span id="cpt-badge-cpt">CPT</span></div>',
    '<div id="cpt-panel" class="hidden">',
      '<div id="cpt-header">',
        '<div id="cpt-header-left"><span id="cpt-live-dot"></span><span id="cpt-header-title">CPT Tracker</span><span id="cpt-fc-chip" title="Click to switch FC">' + currentFC + ' &#9998;</span></div>',
        '<div id="cpt-header-right"><div id="cpt-countdown-block"><span id="cpt-next-label">NEXT CPT</span><span id="cpt-countdown">--:--:--</span></div><button id="cpt-close">&#x2715;</button></div></div>',
      '<div id="cpt-alert-bar" class="hidden"></div>',
    '<div id="cpt-tabs"><button class="tab active" data-tab="current">Current</button><button class="tab" data-tab="overview">Overview</button><button class="tab" data-tab="history">History</button></div>',
      '<div id="tab-current">',
        '<div id="cpt-capture-bar"><span id="cpt-capture-label">No capture yet</span>',
          '<div style="display:flex;gap:6px;align-items:center">',
            '<button id="cpt-debug-btn" title="Show debug report">&#128269;</button>',
            '<select id="cpt-cpt-select">' + CPT_TIMES.map(function(t){ return '<option value="' + t + '">' + (CPT_COLUMN_MAP[t]||t) + '</option>'; }).join('') + '</select>',
            '<button id="cpt-capture-btn">&#128247; Capture</button>',
          '</div></div>',
        '<div id="cpt-col-label"></div>',
        '<div id="cpt-metrics">',
          Object.keys(POOL_GROUPS).map(function(lbl) {
            var cls = POOL_STYLE[lbl] || 'metric-row';
            return '<div class="' + cls + '" id="row-' + slugify(lbl) + '" data-base="' + cls + '"><span class="metric-name">' + lbl + '</span><span class="metric-val">&#8212;</span></div>';
          }).join(''),
        '</div>',
        '<div id="cpt-status">Loading&#8230;</div>',
      '</div>',
      '<div id="tab-overview" class="hidden"><div id="ov-content"></div></div>',
      '<div id="tab-history" class="hidden">',
        '<div id="hist-controls"><input type="date" id="hist-date"><button id="hist-select">&#9745; Select</button><button id="hist-delete-sel" class="hidden">&#128465; Delete (0)</button><button id="hist-clear">&#128465; Clear All</button></div>',
        '<div id="hist-list"></div>',
      '</div>',
    '</div>'
  ].join('');
  document.body.appendChild(root);

  document.getElementById('hist-date').value   = dateStr();
  document.getElementById('cpt-badge').onclick = function() { if (_didDrag) { _didDrag = false; return; } togglePanel(); };
  document.getElementById('cpt-close').onclick = function() { document.getElementById('cpt-panel').classList.add('hidden'); };
  document.getElementById('cpt-fc-chip').onclick = function() {
    var name = prompt('Enter FC name (e.g. MQJ4, DCA1, BOS7):', currentFC);
    if (!name) return;
    name = name.trim().toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(name)) { setStatus('Invalid FC name — use 2–8 letters/digits.'); return; }
    currentFC = name;
    GM_setValue('cpt_fc_name', currentFC);
    document.getElementById('cpt-badge-label').textContent = currentFC;
    document.getElementById('cpt-fc-chip').textContent     = currentFC;
    setStatus('FC switched to ' + currentFC + '. Reloading captures\u2026');
    loadLastSnapshot();
    if (!document.getElementById('tab-history').classList.contains('hidden')) renderHistory();
  };
  var cptSel = document.getElementById('cpt-cpt-select');
  cptSel.value = nextCptTime();
  cptSel.addEventListener('change', function() {
    cptSel.dataset.manual = '1';  // user picked a CPT — stop auto-syncing to next CPT
    updateCaptureBtn();
  });
  document.getElementById('cpt-capture-btn').onclick = function() { captureAndSave(cptSel.value, 'manual'); };
  updateCaptureBtn();
  document.getElementById('cpt-debug-btn').onclick   = showDebugOverlay;
  document.getElementById('hist-date').onchange      = renderHistory;
  document.getElementById('hist-clear').onclick = function() {
    if (!confirm('Delete all saved CPT captures?')) return;
    saveCaptures([]); histSelectMode = false; renderHistory(); setStatus('History cleared.');
  };
  document.getElementById('hist-select').onclick = function() {
    histSelectMode = !histSelectMode;
    this.textContent = histSelectMode ? '✖ Cancel' : '☑ Select';
    this.style.background = histSelectMode ? '#3b1212' : '';
    this.style.color      = histSelectMode ? '#fca5a5' : '';
    document.getElementById('hist-delete-sel').classList.add('hidden');
    renderHistory();
  };
  document.getElementById('hist-delete-sel').onclick = function() {
    var checked = Array.from(document.querySelectorAll('.hist-check:checked')).map(function(cb){ return cb.dataset.ts; });
    if (!checked.length) return;
    if (!confirm('Delete ' + checked.length + ' capture' + (checked.length > 1 ? 's' : '') + '?')) return;
    var remaining = loadCaptures().filter(function(c){ return checked.indexOf(c.timestamp) < 0; });
    saveCaptures(remaining);
    histSelectMode = false;
    document.getElementById('hist-select').textContent = '☑ Select';
    document.getElementById('hist-select').style.background = '';
    document.getElementById('hist-select').style.color = '';
    document.getElementById('hist-delete-sel').classList.add('hidden');
    renderHistory();
    setStatus('Deleted ' + checked.length + ' capture' + (checked.length > 1 ? 's' : '') + '.');
  };
  document.querySelectorAll('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.getElementById('tab-current').classList.toggle('hidden',  btn.dataset.tab !== 'current');
      document.getElementById('tab-overview').classList.toggle('hidden', btn.dataset.tab !== 'overview');
      document.getElementById('tab-history').classList.toggle('hidden',  btn.dataset.tab !== 'history');
      if (btn.dataset.tab === 'history')  renderHistory();
      if (btn.dataset.tab === 'overview') {
        _ovPnypAge = 0;  // force fresh per-CPT scan every time Overview tab is opened
        scanFuturePnyp();
        document.getElementById('ov-content').innerHTML = renderOverview();
        bindHandoffBtn();
      }
    });
  });
  setInterval(updateCountdown, 1000);
  updateCountdown();
  loadLastSnapshot();
  setTimeout(catchupMissedCpts, 6000);            // catch up CPTs missed while page was closed
  setInterval(catchupMissedCpts, 5 * 60 * 1000); // re-check every 5 min for any missed CPTs
  setInterval(function() { checkAndShowAlerts(); refreshOverviewIfVisible(); }, 60000); // refresh risk every min
  setTimeout(function() {
    nudgeStatus('Ready \u2014 captures read from DOM.');
  }, 3000);
  initDrag(); // enable drag-to-reposition
}

// =============================================================================
// DISPLAY
// =============================================================================

function showCurrentSnapshot(snap) {
  document.getElementById('cpt-capture-label').textContent = 'CPT ' + snap.cpt + '  \u2022  ' + fmtTime(snap.timestamp);
  var colEl = document.getElementById('cpt-col-label');
  if (colEl) colEl.textContent = snap.col ? 'Column: ' + snap.col : '';
  // First pass: values + classes
  Object.keys(POOL_GROUPS).forEach(function(lbl) {
    var row = document.getElementById('row-' + slugify(lbl));
    if (!row) return;
    var v = (snap.metrics && snap.metrics[lbl]) || 0;
    row.querySelector('.metric-val').textContent = v.toLocaleString();
    var base = row.dataset.base || 'metric-row';
    var cc = base.indexOf('grand-total') >= 0 ? '' : colorClass(v);
    row.className = cc ? base + ' ' + cc : base;
  });
  // Second pass: fill bar widths (standard rows only)
  var barEntries = [];
  Object.keys(POOL_GROUPS).forEach(function(lbl) {
    var row = document.getElementById('row-' + slugify(lbl));
    if (!row) return;
    var base = row.dataset.base || 'metric-row';
    if (base.indexOf('grand-total') >= 0 || base.indexOf('sub-metric') >= 0) return;
    barEntries.push({ lbl: lbl, v: (snap.metrics && snap.metrics[lbl]) || 0 });
  });
  var maxVal = Math.max(1, Math.max.apply(null, barEntries.map(function(e) { return e.v; })));
  barEntries.forEach(function(e) {
    var row = document.getElementById('row-' + slugify(e.lbl));
    if (!row) return;
    var bar = row.querySelector('.metric-bar');
    if (bar) bar.style.width = (e.v / maxVal * 100).toFixed(1) + '%';
  });
  // Happy glow: Picking Not Yet Picked = 0 means fully cleared
  var pnypRow = document.getElementById('row-picking-not-yet-picked');
  if (pnypRow) {
    var pnypVal = (snap.metrics && snap.metrics['Picking Not Yet Picked']) || 0;
    if (pnypVal === 0) {
      pnypRow.classList.add('zero-cleared');
    } else {
      pnypRow.classList.remove('zero-cleared');
    }
  }
}

function loadLastSnapshot() {
  var list = loadCaptures();
  if (list.length && list[0].status === 'ok') {
    showCurrentSnapshot(list[0]);
    setStatus('Last: CPT ' + list[0].cpt + ' \u2022 ' + fmtTime(list[0].timestamp));
  }
}

function renderHistory() {
  var date = document.getElementById('hist-date').value || dateStr();
  var list = loadCaptures().filter(function(c) { return c.timestamp.startsWith(date); });
  var out  = document.getElementById('hist-list');
  if (!list.length) { out.innerHTML = '<div class="empty-msg">No captures for ' + date + '.</div>'; return; }
  out.innerHTML = list.map(function(c) {
    var chk = histSelectMode
      ? '<input type="checkbox" class="hist-check" data-ts="' + c.timestamp + '" onclick="event.stopPropagation();var n=document.querySelectorAll(\'.hist-check:checked\').length;var db=document.getElementById(\'hist-delete-sel\');db.textContent=\'⛔ Delete (\'+n+\')\';db.classList.toggle(\'hidden\',n===0);">'
      : '';
    if (c.status === 'missed') {
      return '<div class="hist-row missed-row"><div class="hist-head">' + chk + '<span class="hist-cpt">CPT ' + c.cpt + '</span><span class="hist-time">' + fmtTime(c.timestamp) + '</span><span class="hist-badge missed">Rodeo closed</span></div></div>';
    }
    var fcNote  = (c.fc && c.fc !== currentFC) ? '<span class="hist-fc-mismatch">' + c.fc + '</span>' : '';
    var colNote = c.col ? '<span class="hist-col">' + c.col + '</span>' : '';
    var rows = Object.keys(POOL_GROUPS).map(function(lbl) {
      var v = (c.metrics && c.metrics[lbl]) || 0;
      return '<div class="hist-metric ' + colorClass(v) + '"><span>' + lbl + '</span><span>' + v.toLocaleString() + '</span></div>';
    }).join('');
    return '<details class="hist-row"><summary class="hist-head">' + chk + '<span class="hist-cpt">CPT ' + c.cpt + '</span><span class="hist-time">' + fmtTime(c.timestamp) + '</span>' + fcNote + colNote + '<span class="hist-badge ' + c.source + '">' + (c.source === 'auto' ? 'Auto' : 'Manual') + '</span>' + (histSelectMode ? '' : '<span class="hist-chevron">&#9658;</span>') + '</summary><div class="hist-metrics">' + rows + '</div></details>';
  }).join('');
}

function togglePanel() {
  document.getElementById('cpt-panel').classList.toggle('hidden');
  if (!document.getElementById('cpt-panel').classList.contains('hidden')) loadLastSnapshot();
}
function flashDot() { var d=document.getElementById('cpt-dot'); d.classList.add('flash'); setTimeout(function(){ d.classList.remove('flash'); },2000); }
function setStatus(msg) { var e=document.getElementById('cpt-status'); if(e) e.textContent=msg; }
function nudgeStatus(msg) { var p=document.getElementById('cpt-panel'); if(p&&!p.classList.contains('hidden')) setStatus(msg); }

function updateCountdown() {
  var cd = document.getElementById('cpt-countdown'); if (!cd) return;
  var now = new Date();
  var relS = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) - SHIFT_START_HOUR * 3600;
  if (relS < 0) relS += 86400; // overnight portion of shift

  var nextRelS = null;
  for (var i = 0; i < CPT_SHIFT_MINS.length; i++) {
    if (CPT_SHIFT_MINS[i] * 60 > relS) { nextRelS = CPT_SHIFT_MINS[i] * 60; break; }
  }
  if (nextRelS === null) nextRelS = CPT_SHIFT_MINS[0] * 60 + 86400; // next shift's 21:00

  var diff = nextRelS - relS;
  cd.textContent = pad(Math.floor(diff/3600)) + ':' + pad(Math.floor((diff%3600)/60)) + ':' + pad(diff%60);
  cd.style.color = diff < 300 ? '#ff4d4d' : '#4ade80';
  updateCaptureBtn();
}

// Keep capture button label in sync with the selected CPT.
function updateCaptureBtn() {
  var sel = document.getElementById('cpt-cpt-select');
  var btn = document.getElementById('cpt-capture-btn');
  if (!btn) return;
  if (sel && !sel.dataset.manual) sel.value = nextCptTime(); // auto-advance
  var t = sel ? sel.value : nextCptTime();
  btn.textContent = '\uD83D\uDCF7 Capture ' + (CPT_COLUMN_MAP[t] || t);
}

function pad(n)      { return String(n).padStart(2,'0'); }
function slugify(s)  { return s.toLowerCase().replace(/\s+/g,'-'); }
function dateStr()   { return new Date().toISOString().slice(0,10); }
function fmtTime(iso){ return new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
function colorClass(v){ return v===0?'zero':v>500?'high':v>100?'med':''; }

// =============================================================================
// STYLES
// =============================================================================

var STYLES = [
/* ROOT */
'#cpt-root{position:fixed;top:16px;right:16px;z-index:2147483647;font-family:"Amazon Ember","Segoe UI",system-ui,Arial,sans-serif;font-size:13px}',
'#cpt-root.dragging{cursor:grabbing !important;user-select:none !important}',
/* BADGE */
'#cpt-badge{display:flex;align-items:center;gap:7px;background:linear-gradient(135deg,#0c1422,#16243d);border:1px solid rgba(96,165,250,.22);border-radius:24px;padding:6px 14px 6px 9px;cursor:grab;box-shadow:0 4px 20px rgba(0,0,0,.7),0 0 0 1px rgba(255,255,255,.04);user-select:none;transition:all .25s}',
'#cpt-badge:active{cursor:grabbing}',
'#cpt-badge:hover{background:linear-gradient(135deg,#122038,#1e3a5f);border-color:rgba(96,165,250,.45);box-shadow:0 6px 28px rgba(0,0,0,.8),0 0 16px rgba(96,165,250,.12);transform:translateY(-1px)}',
'#cpt-badge-label{color:#60a5fa;font-weight:800;font-size:11px;letter-spacing:.08em}',
'#cpt-badge-sep{color:#1e2a40;font-size:12px;margin:0 1px}',
'#cpt-badge-cpt{color:#64748b;font-weight:600;font-size:11px;letter-spacing:.05em}',
'#cpt-icon{flex-shrink:0;filter:drop-shadow(0 1px 4px rgba(0,0,0,.5));transition:transform .25s}',
'#cpt-badge:hover #cpt-icon{transform:scale(1.12) rotate(-6deg)}',
/* DOT */
'#cpt-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 6px #22c55e;flex-shrink:0;animation:livepulse 2.5s ease-in-out infinite}',
'#cpt-dot.flash{animation:cptpulse .4s ease-in-out 4}',
'@keyframes livepulse{0%,100%{box-shadow:0 0 4px #22c55e;opacity:1}50%{box-shadow:0 0 14px #22c55e,0 0 24px rgba(34,197,94,.25);opacity:.85}}',
'@keyframes cptpulse{0%,100%{background:#22c55e;box-shadow:0 0 6px #22c55e}50%{background:#facc15;box-shadow:0 0 18px #facc15}}',
/* PANEL */
'#cpt-panel{position:absolute;top:52px;right:0;width:400px;background:#080e1a;border:1px solid rgba(59,130,246,.18);border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.85),0 0 0 1px rgba(255,255,255,.04),inset 0 1px 0 rgba(255,255,255,.06);overflow:hidden}',
'.hidden{display:none!important}',
/* HEADER */
'#cpt-header{display:flex;justify-content:space-between;align-items:center;background:linear-gradient(135deg,#0c1e3d 0%,#0f2954 50%,#0c1e3d 100%);padding:13px 16px;border-bottom:1px solid rgba(59,130,246,.15);position:relative;overflow:hidden}',
'#cpt-header::after{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(96,165,250,.6),transparent)}',
'#cpt-header-left{display:flex;align-items:center;gap:9px}',
'#cpt-live-dot{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e;animation:livepulse 2.5s ease-in-out infinite;flex-shrink:0}',
'#cpt-header-title{color:#e2e8f0;font-weight:700;font-size:13px}',
'#cpt-fc-chip{background:rgba(59,130,246,.18);border:1px solid rgba(59,130,246,.3);border-radius:6px;color:#60a5fa;font-size:10px;font-weight:800;padding:2px 8px;letter-spacing:.06em;cursor:pointer;transition:all .2s}',
'#cpt-fc-chip:hover{background:rgba(59,130,246,.32);border-color:rgba(59,130,246,.5);color:#93c5fd}',
'#cpt-header-right{display:flex;align-items:center;gap:10px}',
'#cpt-countdown-block{display:flex;flex-direction:column;align-items:flex-end;gap:1px}',
'#cpt-next-label{color:#334155;font-size:9px;letter-spacing:.08em;text-transform:uppercase}',
'#cpt-countdown{font-size:20px;font-weight:900;color:#22c55e;font-variant-numeric:tabular-nums;letter-spacing:.02em;text-shadow:0 0 14px rgba(34,197,94,.4);line-height:1}',
'#cpt-close{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);color:#475569;cursor:pointer;font-size:12px;padding:4px 8px;border-radius:7px;transition:all .2s;line-height:1}',
'#cpt-close:hover{background:rgba(239,68,68,.15);border-color:rgba(239,68,68,.3);color:#f87171}',
/* TABS */
'#cpt-tabs{display:flex;background:#050a12;border-bottom:1px solid rgba(255,255,255,.05)}',
'.tab{flex:1;background:none;border:none;color:#334155;padding:10px;cursor:pointer;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;border-bottom:2px solid transparent;transition:all .2s}',
'.tab:hover{color:#64748b;background:rgba(255,255,255,.02)}',
'.tab.active{color:#60a5fa;border-bottom-color:#3b82f6;background:rgba(59,130,246,.06)}',
/* CAPTURE BAR */
'#cpt-capture-bar{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(255,255,255,.015);border-bottom:1px solid rgba(255,255,255,.05)}',
'#cpt-cpt-select{background:#0f172a;color:#94a3b8;border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:4px 6px;font-size:11px;cursor:pointer;outline:none}',
'#cpt-cpt-select:hover{border-color:rgba(99,102,241,.5);color:#c4b5fd}',
'#cpt-capture-label{color:#334155;font-size:11px}',
'#cpt-capture-btn{background:linear-gradient(135deg,#1d4ed8,#2563eb);border:none;border-radius:8px;color:#fff;padding:6px 13px;cursor:pointer;font-size:11px;font-weight:700;letter-spacing:.03em;box-shadow:0 2px 10px rgba(37,99,235,.4);transition:all .2s}',
'#cpt-capture-btn:hover{background:linear-gradient(135deg,#2563eb,#3b82f6);box-shadow:0 4px 18px rgba(37,99,235,.55);transform:translateY(-1px)}',
'#cpt-debug-btn{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px;color:#334155;padding:6px 9px;cursor:pointer;font-size:12px;transition:all .2s}',
'#cpt-debug-btn:hover{background:rgba(255,255,255,.08);color:#94a3b8}',
/* COL LABEL */
'#cpt-col-label{padding:5px 16px 4px;font-size:10px;color:#1e3a5f;font-style:italic;background:rgba(59,130,246,.04);border-bottom:1px solid rgba(59,130,246,.06)}',
/* METRICS */
'#cpt-metrics{padding:6px 0}',
'.metric-row{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;border-left:3px solid transparent;transition:background .15s;position:relative;overflow:hidden}',
'.metric-bar{position:absolute;left:0;top:0;height:100%;width:0;background:rgba(59,130,246,.07);transition:width .65s cubic-bezier(.4,0,.2,1);pointer-events:none;z-index:0}',
'.metric-row:hover{background:rgba(255,255,255,.025)}',
'.metric-name{color:#64748b;font-size:12px;font-weight:500;position:relative;z-index:1}',
'.metric-val{font-size:18px;font-weight:800;color:#e2e8f0;min-width:80px;text-align:right;font-variant-numeric:tabular-nums;letter-spacing:-.01em;position:relative;z-index:1}',
'.metric-row.zero .metric-val{color:#111e35}',
'.metric-row.zero .metric-name{color:#172030}',
'.metric-row.zero .metric-bar{display:none}',
/* GRAND TOTAL */
'.metric-row.grand-total{background:linear-gradient(135deg,rgba(15,40,80,.45),rgba(10,25,60,.65));border-left-color:#3b82f6;border-bottom:1px solid rgba(59,130,246,.12);margin-bottom:4px;padding:14px 16px}',
'.metric-row.grand-total .metric-bar{display:none}',
'.metric-row.grand-total .metric-name{color:#3b82f6;font-weight:800;font-size:10px;letter-spacing:.1em;text-transform:uppercase}',
'.metric-row.grand-total .metric-val{font-size:26px;color:#e2e8f0;text-shadow:0 0 28px rgba(96,165,250,.18)}',
/* SUB-METRICS */
'.metric-row.sub-metric{padding:5px 16px 5px 30px;border-left-width:1px;border-left-style:dashed}',
'.metric-row.sub-metric .metric-bar{display:none}',
'.metric-row.sub-metric .metric-name{color:#1e3a5f;font-size:11px}',
'.metric-row.sub-metric .metric-val{font-size:13px;min-width:55px;color:#2d4a6e}',
/* COLOR STATES */
'.metric-row.med{border-left-color:#d97706}',
'.metric-row.med .metric-bar{background:rgba(217,119,6,.09)}',
'.metric-row.med .metric-val{color:#fbbf24}',
'.metric-row.med .metric-name{color:#78716c}',
'.metric-row.high{border-left-color:#dc2626}',
'.metric-row.high .metric-bar{background:rgba(220,38,38,.1)}',
'.metric-row.high .metric-val{color:#f87171;text-shadow:0 0 10px rgba(239,68,68,.22)}',
'.metric-row.high .metric-name{color:#6b3232}',
/* STATUS */
'#cpt-status{padding:7px 14px;background:rgba(0,0,0,.4);color:#1a3050;font-size:10px;border-top:1px solid rgba(255,255,255,.04);letter-spacing:.02em}',
/* HISTORY CONTROLS */
'#hist-controls{display:flex;align-items:center;gap:6px;padding:10px 14px;background:rgba(0,0,0,.25);border-bottom:1px solid rgba(255,255,255,.05)}',
'#hist-date{background:#060c18;border:1px solid rgba(255,255,255,.08);border-radius:7px;color:#64748b;padding:4px 8px;font-size:11px;flex:1}',
'#hist-select{background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.22);border-radius:7px;color:#60a5fa;padding:4px 9px;cursor:pointer;font-size:11px;font-weight:600;transition:all .2s}',
'#hist-select:hover{background:rgba(59,130,246,.18)}',
'#hist-delete-sel{background:rgba(220,38,38,.15);border:1px solid rgba(220,38,38,.3);border-radius:7px;color:#f87171;padding:4px 9px;cursor:pointer;font-size:11px;font-weight:700}',
'#hist-clear{background:rgba(100,20,20,.2);border:1px solid rgba(127,29,29,.4);border-radius:7px;color:#7f3535;padding:4px 9px;cursor:pointer;font-size:11px;transition:all .2s}',
'#hist-clear:hover{background:rgba(127,29,29,.35);color:#fca5a5}',
/* HISTORY LIST */
'#hist-list{max-height:380px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#0d1e35 transparent}',
'.empty-msg{color:#14243a;font-size:12px;text-align:center;padding:36px 16px;letter-spacing:.04em}',
'.hist-row{border-bottom:1px solid rgba(255,255,255,.04)}',
'.missed-row{opacity:.35;padding:10px 14px}',
'.hist-head{display:flex;align-items:center;gap:8px;padding:11px 14px;cursor:pointer;list-style:none;transition:background .15s;border-left:3px solid transparent}',
'.hist-head:hover{background:rgba(255,255,255,.03)}',
'details[open] .hist-head{background:rgba(15,40,80,.25);border-left-color:#2563eb}',
'.hist-cpt{font-weight:800;color:#2563eb;font-size:13px;min-width:68px}',
'.hist-time{color:#1a3050;font-size:11px;flex:1}',
'.hist-col{color:#122036;font-size:10px;font-style:italic;flex:1}',
'.hist-badge{font-size:9px;font-weight:700;padding:2px 7px;border-radius:20px;text-transform:uppercase;letter-spacing:.07em}',
'.hist-badge.auto{background:rgba(10,30,70,.8);color:#3b82f6;border:1px solid rgba(59,130,246,.25)}',
'.hist-badge.manual{background:rgba(10,40,15,.8);color:#22c55e;border:1px solid rgba(34,197,94,.2)}',
'.hist-badge.missed{background:rgba(60,10,10,.8);color:#ef4444;border:1px solid rgba(239,68,68,.2)}',
'.hist-chevron{color:#1a3050;font-size:10px;transition:transform .2s;margin-left:auto;flex-shrink:0}',
'details[open] .hist-chevron{transform:rotate(90deg)}',
'.hist-metrics{padding:6px 14px 12px 20px;background:rgba(0,0,0,.2)}',
'.hist-metric{display:flex;justify-content:space-between;padding:4px 6px;font-size:11px;color:#1a3050;border-left:2px solid transparent;border-radius:3px;margin-bottom:1px}',
'.hist-metric span:last-child{font-weight:700;color:#2d4a6e;min-width:60px;text-align:right;font-variant-numeric:tabular-nums}',
'.hist-metric.med{border-left-color:#d97706}.hist-metric.med span:last-child{color:#d97706}',
'.hist-metric.high{border-left-color:#dc2626}.hist-metric.high span:last-child{color:#ef4444}',
'.hist-metric.zero span:last-child{color:#0d1a2e}',
'.hist-check{width:15px;height:15px;cursor:pointer;accent-color:#ef4444;flex-shrink:0;margin-right:2px}',
'.hist-fc-mismatch{font-size:9px;font-weight:700;padding:2px 6px;border-radius:20px;background:rgba(245,158,11,.15);color:#f59e0b;border:1px solid rgba(245,158,11,.3)}',
'@keyframes happyglow{0%,100%{box-shadow:inset 0 0 0 rgba(34,197,94,0);border-left-color:#22c55e}50%{box-shadow:inset 6px 0 28px rgba(34,197,94,.18),0 0 18px rgba(34,197,94,.12);border-left-color:#4ade80}}',
'.metric-row.zero-cleared{animation:happyglow 2s ease-in-out infinite;border-left-color:#22c55e !important;background:rgba(34,197,94,.05) !important}',
'.metric-row.zero-cleared .metric-val{color:#4ade80 !important;text-shadow:0 0 14px rgba(74,222,128,.6)}',
'.metric-row.zero-cleared .metric-name{color:#86efac !important}',
/* ALERT BAR */
'#cpt-alert-bar{padding:8px 14px;background:rgba(220,38,38,.08);border-bottom:1px solid rgba(220,38,38,.2)}',
'.cpt-alert-item{font-size:11px;font-weight:600;padding:2px 0;line-height:1.6}',
'.cpt-alert-red{color:#f87171}',
'.cpt-alert-amber{color:#fbbf24}',
/* OVERVIEW */
'#tab-overview{padding-bottom:8px}',
'#ov-rate-bar{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:rgba(255,255,255,.015);border-bottom:1px solid rgba(255,255,255,.05);gap:8px}',
'#ov-rate-txt{color:#475569;font-size:10px;flex:1}',
'#ov-handoff-btn{background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.22);border-radius:7px;color:#22c55e;padding:5px 11px;cursor:pointer;font-size:10px;font-weight:700;letter-spacing:.04em;transition:all .2s;white-space:nowrap;flex-shrink:0}',
'#ov-handoff-btn:hover{background:rgba(34,197,94,.22);color:#4ade80}',
'.ov-hdr{display:grid;grid-template-columns:22px 52px 1fr 1fr 1fr;gap:4px;padding:5px 14px 3px;font-size:9px;color:#1e2a40;font-weight:700;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid rgba(255,255,255,.04)}',
'.ov-row{display:grid;grid-template-columns:22px 52px 1fr 1fr 1fr;gap:4px;padding:7px 14px;border-left:3px solid transparent;font-size:12px;transition:background .15s}',
'.ov-row:hover{background:rgba(255,255,255,.02)}',
'.ov-icon{font-size:11px;line-height:1.5}',
'.ov-cpt-lbl{color:#334155;font-weight:700;font-size:12px}',
'.ov-pnyp-val{color:#64748b;font-weight:700;font-variant-numeric:tabular-nums;font-size:12px}',
'.ov-time-val{color:#1e2a40;font-size:11px}',
'.ov-eta-val{color:#334155;font-size:11px}',
'.ov-green{border-left-color:#22c55e}',
'.ov-green .ov-cpt-lbl{color:#22c55e}',
'.ov-green .ov-pnyp-val{color:#4ade80}',
'.ov-green .ov-eta-val{color:#4ade80}',
'.ov-amber{border-left-color:#d97706}',
'.ov-amber .ov-cpt-lbl{color:#fbbf24}',
'.ov-amber .ov-pnyp-val{color:#fbbf24}',
'.ov-amber .ov-time-val{color:#d97706;font-weight:600}',
'.ov-red{border-left-color:#dc2626;background:rgba(220,38,38,.04)}',
'.ov-red .ov-cpt-lbl{color:#f87171}',
'.ov-red .ov-pnyp-val{color:#f87171}',
'.ov-red .ov-eta-val{color:#f87171;font-weight:700}',
'.ov-red .ov-time-val{color:#f87171;font-weight:600}',
'.ov-done{opacity:.35}',
'.ov-done-units{border-left-color:#d97706;opacity:.65}',
'.ov-done-units .ov-pnyp-val{color:#fbbf24}',
].join('\n');

// =============================================================================
// BOOT
// =============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', buildPanel);
} else {
  buildPanel();
}

})();
