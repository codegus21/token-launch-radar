// Launch Radar's plain dashboard. It reads window.RADAR (written beside this
// page by main.ts) and renders the ranked board, a filterable table, a detail
// view for every protocol and the model's own method section. No network: every
// byte it shows is in data.js.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;

  var qEl = document.getElementById('q');
  var catEl = document.getElementById('cat');
  var sortEl = document.getElementById('sort');
  var watchEl = document.getElementById('watchonly');
  var countEl = document.getElementById('count');
  var rowsEl = document.getElementById('rows');
  var boardEl = document.getElementById('board');
  var liveEl = document.getElementById('live');
  var liveRowsEl = document.getElementById('live-rows');
  var detailEl = document.getElementById('detail');
  var tabRanked = document.getElementById('tab-ranked');
  var tabLive = document.getElementById('tab-live');

  var state = { q: '', cat: 'all', sort: 'implied', watch: false, tab: 'ranked', selected: null };
  var WATCH = {};
  DATA.rows.forEach(function (r) { if (r.watchlist) WATCH[r.slug] = true; });

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // ---- KPI strip -----------------------------------------------------------
  (function kpis() {
    var m = DATA.model;
    var items = [
      ['Protocols scanned', String(DATA.protocols_scanned), 'at or above $5M TVL'],
      ['Watchlist', String(DATA.watchlist_size), 'floor $' + (DATA.floor_usd / 1e6).toFixed(0) + 'M, no token recorded'],
      ['Ranked', String(DATA.board_size), DATA.early_size + ' early finds below the floor'],
      ['Comparables fitted', String(m.model.comps), 'tokens already trading'],
      ['Walk-forward error', m.walk_forward.median_abs_log_err.toFixed(2) + ' dex', 'median, held out'],
      ['Leave-one-out error', m.leave_one_out.median_abs_log_err.toFixed(2) + ' dex', 'median, held out'],
    ];
    var dl = document.getElementById('kpis');
    items.forEach(function (it) {
      var wrap = el('div');
      wrap.appendChild(el('dt', null, it[0]));
      var dd = el('dd', null, it[1]);
      dd.appendChild(el('small', null, it[2]));
      wrap.appendChild(dd);
      dl.appendChild(wrap);
    });
  })();

  // ---- Category filter -----------------------------------------------------
  (function categories() {
    var cats = {};
    DATA.rows.forEach(function (r) { if (r.category) cats[r.category] = true; });
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      catEl.appendChild(o);
    });
  })();

  // ---- Filtering and sorting ----------------------------------------------
  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = DATA.rows.filter(function (r) {
      if (state.watch && !WATCH[r.slug]) return false;
      if (state.cat !== 'all' && r.category !== state.cat) return false;
      if (q) {
        var hay = (r.name + ' ' + r.slug + ' ' + r.chains.join(' ')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var by = state.sort;
    list.sort(function (a, b) {
      if (by === 'tvl') return b.tvl_usd - a.tvl_usd;
      if (by === 'growth') return (b.change_7d || 0) - (a.change_7d || 0);
      if (by === 'odds') return b.launch_odds - a.launch_odds;
      if (by === 'age') return (b.age_days || 0) - (a.age_days || 0);
      if (by === 'name') return a.name.localeCompare(b.name);
      return a.rank - b.rank;
    });
    return list;
  }

  function renderBoard() {
    var list = filtered();
    rowsEl.innerHTML = '';
    countEl.textContent = list.length + ' of ' + DATA.board_size + ' ranked protocols' +
      (state.watch ? ' on the watchlist' : '') +
      (state.cat !== 'all' ? ' · ' + state.cat : '') +
      (state.q ? ' · matching “' + state.q + '”' : '') + '.';
    list.forEach(function (r) {
      var tr = document.createElement('tr');
      if (state.selected === r.slug) tr.className = 'sel';
      tr.addEventListener('click', function () { select(r.slug); });
      var cells = [
        { t: String(r.rank), c: 'num' },
        { t: r.name, c: 'name', sub: r.slug + (WATCH[r.slug] ? ' · watchlist' : '') },
        { t: r.category || '—' },
        { t: r.chains.slice(0, 2).join(', ') || '—' },
        { t: fmtUsd(r.tvl_usd), c: 'num' },
        { t: fmtPct(r.change_7d), c: 'num ' + (r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : '') },
        { t: fmtAge(r.age_days), c: 'num' },
        { t: fmtUsd(r.implied_value_usd), c: 'num', sub: fmtUsd(r.implied_low_usd) + ' – ' + fmtUsd(r.implied_high_usd) },
        { t: Math.round(r.launch_odds * 100) + '%', c: 'num' },
      ];
      cells.forEach(function (cell) {
        var td = el('td', cell.c, cell.t);
        if (cell.sub) td.appendChild(el('span', 'sub', cell.sub));
        tr.appendChild(td);
      });
      rowsEl.appendChild(tr);
    });
    if (list.length === 0) {
      var tr = document.createElement('tr');
      var td = el('td', null, 'Nothing matches — clear the search or the category filter.');
      td.colSpan = 9;
      tr.appendChild(td);
      rowsEl.appendChild(tr);
    }
  }

  function renderLive() {
    liveRowsEl.innerHTML = '';
    DATA.live.forEach(function (r) {
      var tr = document.createElement('tr');
      [r.name, r.category || '—', r.chains.slice(0, 2).join(', ') || '—'].forEach(function (t) {
        tr.appendChild(el('td', null, t));
      });
      tr.appendChild(el('td', 'num', fmtUsd(r.tvl_usd)));
      tr.appendChild(el('td', 'num', fmtUsd(r.mcap_usd)));
      tr.appendChild(el('td', 'num ' + (r.change_7d > 0 ? 'pos' : r.change_7d < 0 ? 'neg' : ''), fmtPct(r.change_7d)));
      liveRowsEl.appendChild(tr);
    });
    countEl.textContent = DATA.live_size + ' largest tokens already trading, by market cap — shown apart, never ranked against the pre-token board.';
  }

  // ---- Farm verdict: what the plan costs and how long it takes ------------
  function verdict(r) {
    var weeks = Math.max(1, Math.round(r.hold_days / 7));
    var gas = (r.capital_usd >= 150 ? 8 : 4) + 2 * weeks + 2;
    var hours = 0.5 + weeks * (10 / 60) + 0.25;
    return 'Farm verdict: about $' + r.capital_usd + ' of capital, about $' + gas + ' of gas, about ' +
      hours.toFixed(1) + ' hours of work spread over ' + r.hold_days + ' days — roughly $' +
      (gas / hours).toFixed(0) + ' of gas per hour of work, before any token is ever issued.';
  }

  // ---- Detail view ---------------------------------------------------------
  function select(slug) {
    var r = null;
    DATA.rows.forEach(function (x) { if (x.slug === slug) r = x; });
    state.selected = slug;
    if (!r) { detailEl.hidden = true; renderBoard(); return; }
    detailEl.hidden = false;
    detailEl.innerHTML = '';
    var close = el('button', 'close', 'Close');
    close.addEventListener('click', function () { state.selected = null; detailEl.hidden = true; renderBoard(); setHash(); });
    detailEl.appendChild(close);
    detailEl.appendChild(el('h2', null, '#' + r.rank + '  ' + r.name));
    detailEl.appendChild(el('p', 'meta', r.slug + ' · ' + (r.category || 'no category') + ' · ' + r.chains.join(', ') +
      ' · listed ' + (r.listed_at || 'date unknown') + ' (' + fmtAge(r.age_days) + ') · ' +
      (WATCH[r.slug] ? 'on the watchlist. ' : 'below the watchlist floor. ') + 'Records no token.'));
    var grid = el('dl', 'detail-grid');
    var facts = [
      ['Implied value', fmtUsd(r.implied_value_usd), 'fitted, not the market'],
      ['80% range', fmtUsd(r.implied_low_usd) + ' – ' + fmtUsd(r.implied_high_usd), 'leave-one-out errors'],
      ['TVL', fmtUsd(r.tvl_usd), '7d ' + fmtPct(r.change_7d)],
      ['Launch odds', Math.round(r.launch_odds * 100) + '%', 'peers of the same age'],
      ['Growth multiplier', '×' + r.growth_multiplier.toFixed(3), 'fitted slope, shrunk'],
      ['Age multiplier', '×' + r.age_multiplier.toFixed(3), 'fitted slope, shrunk'],
    ];
    facts.forEach(function (f) {
      var wrap = el('div');
      wrap.appendChild(el('dt', null, f[0]));
      var dd = el('dd', null, f[1]);
      dd.appendChild(el('small', null, f[2]));
      wrap.appendChild(dd);
      grid.appendChild(wrap);
    });
    detailEl.appendChild(grid);
    detailEl.appendChild(el('h3', null, 'Why this value'));
    detailEl.appendChild(el('p', null,
      'The fitted model prices a token from the protocol’s own figures: log10(market cap) = ' +
      DATA.model.model.intercept + ' + ' + DATA.model.model.tvl_slope + ' × log10(TVL) + ' +
      DATA.model.model.growth_slope + ' × (7-day growth / 100) + ' + DATA.model.model.age_slope +
      ' × log10(age in days + 30). For ' + r.name + ', TVL ' + fmtUsd(r.tvl_usd) + ' with 7-day growth ' +
      fmtPct(r.change_7d) + ' and age ' + fmtAge(r.age_days) + ' gives ' + fmtUsd(r.implied_value_usd) +
      '. The range is the 10th–90th percentile of the leave-one-out errors, so 4 in 5 comparables landed inside a band this wide.'));
    detailEl.appendChild(el('h3', null, 'Farm plan — costed'));
    detailEl.appendChild(el('p', 'verdict', verdict(r)));
    var ol = el('ol', 'steps');
    r.farm_steps.forEach(function (s, i) {
      var li = document.createElement('li');
      li.innerHTML = '<b>Step ' + (i + 1) + '.</b> ' + esc(s);
      ol.appendChild(li);
    });
    detailEl.appendChild(ol);
    renderBoard();
    detailEl.scrollIntoView({ block: 'nearest' });
    setHash();
  }

  // ---- Method section ------------------------------------------------------
  (function method() {
    var m = DATA.model;
    var body = document.getElementById('method-body');
    function p(html) {
      var n = document.createElement('p');
      n.innerHTML = html;
      body.appendChild(n);
    }
    p('<b>The model.</b> log10(market cap) = ' + m.model.intercept + ' + ' + m.model.tvl_slope +
      ' × log10(TVL) + ' + m.model.growth_slope + ' × (7-day growth / 100) + ' + m.model.age_slope +
      ' × log10(age in days + 30), fitted by ridge regression (penalty ' + m.model.ridge_lambda +
      ' on the growth and age slopes only) on ' + m.model.comps +
      ' protocols whose token already trades. The fitted value is then applied to every protocol that records no token. No name is ever special-cased.');
    p('<b>Two blind tests.</b> ' + m.walk_forward.name + ': ' + m.walk_forward.method + ' — median absolute error ' +
      m.walk_forward.median_abs_log_err.toFixed(2) + ' dex, ' + Math.round(m.walk_forward.within_2x * 100) +
      '% within a factor of 2, over ' + m.walk_forward.tested + ' protocols. ' + m.leave_one_out.name + ': ' +
      m.leave_one_out.method + ' — median absolute error ' + m.leave_one_out.median_abs_log_err.toFixed(2) +
      ' dex, ' + Math.round(m.leave_one_out.within_2x * 100) + '% within a factor of 2, over ' +
      m.leave_one_out.tested + ' protocols. (0.30 dex is a factor of 2.) The 80% range on every row is the 10th–90th percentile of the leave-one-out errors: ×' +
      m.range_low_mult + ' to ×' + m.range_high_mult + '.');
    var tbl = document.createElement('table');
    tbl.innerHTML = '<thead><tr><th>Terms tried</th><th class="num">Walk-forward median error</th><th class="num">Within 2×</th><th class="num">Leave-one-out median error</th><th class="num">Within 2×</th><th>Kept?</th></tr></thead>';
    var tb = document.createElement('tbody');
    m.candidates.forEach(function (c) {
      var tr = document.createElement('tr');
      [c.terms, c.walk_forward_median_abs_log_err.toFixed(3) + ' dex', Math.round(c.walk_forward_within_2x * 100) + '%',
       c.loo_median_abs_log_err.toFixed(3) + ' dex', Math.round(c.loo_within_2x * 100) + '%',
       c.kept ? 'Yes — see the note below' : 'No'].forEach(function (t, i) {
        tr.appendChild(el('td', i > 0 && i < 5 ? 'num' : null, t));
      });
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);
    p('<b>Why growth and age stay in.</b> ' + esc(m.selection_note));
    var odds = '<b>Launch odds.</b> The share of all 758 protocols that record a token, by how long they have been listed: ';
    odds += m.launch_odds_buckets.map(function (b) {
      return (b.from_days === 0 ? 'under 6 months' : b.from_days < 365 ? '6–12 months' : b.from_days < 730 ? '1–2 years' : b.from_days < 1095 ? '2–3 years' : 'over 3 years') +
        ' ' + Math.round(b.odds * 100) + '% (' + b.with_token + ' of ' + b.protocols + ')';
    }).join(' · ') + '. Overall ' + Math.round(m.launch_odds_overall * 100) +
      '%. These odds come from the peers’ record, not from any claim about a launch date.';
    p(odds);
    var warn = el('p', 'warn', 'Limits. The snapshot is frozen at 14 Nov 2026 and never moves. A market cap is a noisy thing to fit: the median held-out error is about half a dex, so a typical fitted value is off by a factor of three, and the range says so. The fitted growth slope is negative — fast growth weeks in the comps tended to mean-revert — so a hot week lowers a protocol’s value a little. Nothing here predicts whether or when a token is issued.');
    body.appendChild(warn);
  })();

  // ---- Tabs, controls, hash -----------------------------------------------
  function showTab(tab) {
    state.tab = tab;
    tabRanked.setAttribute('aria-selected', tab === 'ranked' ? 'true' : 'false');
    tabLive.setAttribute('aria-selected', tab === 'live' ? 'true' : 'false');
    boardEl.hidden = tab !== 'ranked';
    liveEl.hidden = tab !== 'live';
    if (tab === 'live') renderLive(); else renderBoard();
    setHash();
  }
  tabRanked.addEventListener('click', function () { showTab('ranked'); });
  tabLive.addEventListener('click', function () { showTab('live'); });
  qEl.addEventListener('input', function () { state.q = qEl.value; renderBoard(); setHash(); });
  catEl.addEventListener('change', function () { state.cat = catEl.value; renderBoard(); setHash(); });
  sortEl.addEventListener('change', function () { state.sort = sortEl.value; renderBoard(); setHash(); });
  watchEl.addEventListener('change', function () { state.watch = watchEl.checked; renderBoard(); setHash(); });

  function setHash() {
    var parts = [];
    if (state.q) parts.push('q=' + encodeURIComponent(state.q));
    if (state.cat !== 'all') parts.push('cat=' + encodeURIComponent(state.cat));
    if (state.watch) parts.push('watch=1');
    if (state.sort !== 'implied') parts.push('sort=' + state.sort);
    if (state.tab !== 'ranked') parts.push('tab=' + state.tab);
    if (state.selected) parts.push('detail=' + state.selected);
    var h = parts.join('&');
    if (history.replaceState) history.replaceState(null, '', h ? '#' + h : '#');
  }
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return;
    h.split('&').forEach(function (pair) {
      var kv = pair.split('=');
      var k = kv[0], v = kv[1] ? decodeURIComponent(kv[1]) : '';
      if (k === 'q') { state.q = v; qEl.value = v; }
      if (k === 'cat') { state.cat = v; catEl.value = v; }
      if (k === 'watch') { state.watch = v === '1'; watchEl.checked = true; }
      if (k === 'sort') { state.sort = v; sortEl.value = v; }
      if (k === 'tab') state.tab = v;
    });
    var dm = h.match(/detail=([^&]+)/);
    if (dm) state.selected = dm[1];
  }

  readHash();
  if (state.tab === 'live') {
    showTab('live');
  } else {
    renderBoard();
  }
  if (state.selected) select(state.selected);
})();
