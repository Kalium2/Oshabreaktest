/* OSHA Enforcement Search
 * All data comes from the DOL Open Data Portal OSHA datasets:
 *   https://apiprod.dol.gov/v4/get/OSHA/{dataset}/json
 * Datasets used: inspection, violation, accident, accident_abstract, accident_injury.
 */
(() => {
  'use strict';

  const DIRECT_BASE = 'https://apiprod.dol.gov/v4/get/OSHA';
  const PROXY_BASE = '/api/OSHA';
  const PAGE_SIZE = 25;
  const ESTAB_SCAN = 200; // inspection rows scanned when grouping establishments

  // Code labels from the OSHA enforcement data dictionary.
  const CODES = {
    insp_type: {
      A: 'Accident', B: 'Complaint', C: 'Referral', D: 'Monitoring', E: 'Variance',
      F: 'Follow-up', G: 'Unprogrammed related', H: 'Planned', I: 'Unprogrammed other',
      J: 'Programmed related', K: 'Programmed other', L: 'Other', M: 'Fatality/Catastrophe',
    },
    insp_scope: { A: 'Complete', B: 'Partial', C: 'Records only', D: 'No inspection' },
    safety_hlth: { S: 'Safety', H: 'Health' },
    owner_type: { A: 'Private', B: 'Local government', C: 'State government', D: 'Federal' },
    viol_type: { S: 'Serious', W: 'Willful', R: 'Repeat', O: 'Other', U: 'Unclassified' },
    degree_of_inj: { 0: 'Unknown', 1: 'Fatality', 2: 'Hospitalized', 3: 'Non-hospitalized' },
  };

  // Columns shown first in result tables (any other fields appear in the detail view).
  const COLUMNS = {
    inspection: ['activity_nr', 'estab_name', 'site_address', 'site_city', 'site_state', 'site_zip',
      'naics_code', 'insp_type', 'safety_hlth', 'open_date', 'close_case_date'],
    violation: ['activity_nr', 'citation_id', 'standard', 'viol_type', 'issuance_date',
      'initial_penalty', 'current_penalty', 'nr_exposed', 'gravity'],
    accident: ['summary_nr', 'event_date', 'event_desc', 'fatality', 'event_keyword'],
    accident_injury: ['summary_nr', 'injury_line_nr', 'rel_insp_nr', 'age', 'sex',
      'degree_of_inj', 'nature_of_inj', 'part_of_body', 'occ_code'],
  };

  const LABELS = {
    activity_nr: 'Activity #', estab_name: 'Establishment', site_address: 'Address', site_city: 'City',
    site_state: 'State', site_zip: 'ZIP', naics_code: 'NAICS', sic_code: 'SIC', insp_type: 'Type',
    insp_scope: 'Scope', safety_hlth: 'Safety/Health', owner_type: 'Owner', open_date: 'Opened',
    close_case_date: 'Closed', citation_id: 'Citation', standard: 'Standard', viol_type: 'Violation type',
    issuance_date: 'Issued', initial_penalty: 'Initial penalty', current_penalty: 'Current penalty',
    nr_exposed: 'Exposed', gravity: 'Gravity', summary_nr: 'Summary #', event_date: 'Event date',
    event_desc: 'Description', fatality: 'Fatality', event_keyword: 'Keywords', rel_insp_nr: 'Inspection #',
    injury_line_nr: 'Line', degree_of_inj: 'Degree', nature_of_inj: 'Nature', part_of_body: 'Body part',
    occ_code: 'Occupation', nr_in_estab: 'Employees', abstract_text: 'Abstract',
  };

  const MONEY = new Set(['initial_penalty', 'current_penalty', 'fta_penalty']);

  // ---------- settings ----------
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };
  const settings = {
    key: store.get('osha.apiKey', ''),
    mode: store.get('osha.mode', 'direct'),
  };

  // ---------- API ----------
  class ApiError extends Error {}

  function cond(field, operator, value) { return { field, operator, value }; }

  function filterObject(conds) {
    if (!conds.length) return null;
    return conds.length === 1 ? conds[0] : { and: conds };
  }

  function buildUrl(dataset, { conds = [], limit = PAGE_SIZE, offset = 0, sortBy, sort = 'desc' }) {
    const base = settings.mode === 'proxy' ? PROXY_BASE : DIRECT_BASE;
    const p = new URLSearchParams();
    if (settings.key) p.set('X-API-KEY', settings.key);
    p.set('limit', String(limit));
    p.set('offset', String(offset));
    if (sortBy) { p.set('sort_by', sortBy); p.set('sort', sort); }
    const f = filterObject(conds);
    if (f) p.set('filter_object', JSON.stringify(f));
    return `${base}/${dataset}/json?${p}`;
  }

  async function fetchRows(dataset, opts) {
    const url = buildUrl(dataset, opts);
    let res;
    try {
      res = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw new ApiError(settings.mode === 'direct'
        ? 'Could not reach apiprod.dol.gov. The browser may be blocking a cross-origin request. Run the bundled server.js and switch Connection to "Local proxy".'
        : 'Could not reach the local proxy. Is server.js running?');
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    if (!res.ok) {
      const msg = (json && (json.message || json.error || json.detail)) || text.slice(0, 200) || res.statusText;
      if (res.status === 401 || res.status === 403) throw new ApiError(`The API rejected the request (${res.status}). Check your API key. ${msg}`);
      throw new ApiError(`API error ${res.status}: ${msg}`);
    }
    if (json === null) throw new ApiError('The API returned a response that is not JSON.');
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json.results)) return json.results;
    if (json.data == null && (json.message || json.error)) throw new ApiError(String(json.message || json.error));
    return [];
  }

  // The API's matching rules (wildcards for "like", numeric vs. string IDs) are strict,
  // so an empty first attempt is retried once with %wildcards% and string-typed IDs.
  function relaxed(conds) {
    let changed = false;
    const out = conds.map(c => {
      if (c.operator === 'like' && !String(c.value).includes('%')) { changed = true; return { ...c, value: `%${c.value}%` }; }
      if (c.operator === 'eq' && typeof c.value === 'number') { changed = true; return { ...c, value: String(c.value) }; }
      return c;
    });
    return changed ? out : null;
  }

  async function query(dataset, opts) {
    let rows;
    try {
      rows = await fetchRows(dataset, opts);
    } catch (e) {
      const alt = opts.conds && relaxed(opts.conds);
      if (!alt || !(e instanceof ApiError) || /key|reach/i.test(e.message)) throw e;
      return fetchRows(dataset, { ...opts, conds: alt });
    }
    if (!rows.length && opts.conds) {
      const alt = relaxed(opts.conds);
      if (alt) return fetchRows(dataset, { ...opts, conds: alt });
    }
    return rows;
  }

  // ---------- formatting ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const label = k => LABELS[k] || k.replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
  const asNum = v => (/^\d+$/.test(String(v).trim()) ? Number(v) : String(v).trim());
  const upper = v => String(v).trim().toUpperCase();

  function fmt(key, value) {
    if (value == null || value === '') return '';
    if (MONEY.has(key) && !isNaN(Number(value))) {
      return Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    }
    if (/_date$|_dt$/.test(key) && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    const map = CODES[key];
    if (map && map[value] !== undefined) return `${value} – ${map[value]}`;
    return String(value);
  }

  // Cells that link to related records.
  function cell(key, row) {
    const v = row[key];
    const text = esc(fmt(key, v));
    if (v == null || v === '') return '';
    if (key === 'activity_nr' || key === 'rel_insp_nr') {
      return `<button class="link" data-open="inspection" data-id="${esc(v)}">${text}</button>`;
    }
    if (key === 'summary_nr') return `<button class="link" data-open="accident" data-id="${esc(v)}">${text}</button>`;
    return text;
  }

  function columnsFor(type, rows) {
    const present = new Set(rows.flatMap(r => Object.keys(r)));
    const cols = (COLUMNS[type] || []).filter(c => present.has(c));
    return cols.length ? cols : [...present].slice(0, 10);
  }

  function table(type, rows) {
    if (!rows.length) return '<p class="empty">No records found.</p>';
    const cols = columnsFor(type, rows);
    return `<div class="table-wrap"><table>
      <thead><tr>${cols.map(c => `<th scope="col">${esc(label(c))}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>${cols.map(c => `<td data-label="${esc(label(c))}">${cell(c, r)}</td>`).join('')}
        <td><button class="link" data-raw="${i}">All fields</button></td></tr>`).join('')}</tbody>
    </table></div>`;
  }

  function fieldList(row) {
    return `<dl class="fields">${Object.keys(row).map(k =>
      `<div><dt>${esc(label(k))}</dt><dd>${cell(k, row) || '<span class="muted">—</span>'}</dd></div>`).join('')}</dl>`;
  }

  // ---------- UI state ----------
  const results = $('#results');
  const dialog = $('#detail');
  let current = null; // { type, dataset, opts, rows, title }

  function status(html, cls = '') { results.innerHTML = `<p class="status ${cls}">${html}</p>`; }

  function needKey() {
    if (settings.key || settings.mode === 'proxy') return false;
    status('Add your DOL API key under <strong>API settings</strong> to search.', 'warn');
    openSettings(true);
    return true;
  }

  function renderPage() {
    const { title, rows, opts, type } = current;
    const page = Math.floor(opts.offset / opts.limit) + 1;
    results.innerHTML = `
      <div class="results-head">
        <h2>${esc(title)}</h2>
        <span class="muted">Page ${page} · ${rows.length} record${rows.length === 1 ? '' : 's'}</span>
      </div>
      ${table(type, rows)}
      <div class="pager">
        <button class="btn ghost" data-page="-1" ${opts.offset === 0 ? 'disabled' : ''}>Previous</button>
        <button class="btn ghost" data-page="1" ${rows.length < opts.limit ? 'disabled' : ''}>Next</button>
      </div>`;
    bindRaw(results, rows);
  }

  async function runSearch(state) {
    current = state;
    status('Searching OSHA records…');
    try {
      current.rows = await query(state.dataset, state.opts);
      renderPage();
    } catch (e) {
      status(esc(e.message), 'error');
    }
  }

  function bindRaw(root, rows) {
    root.querySelectorAll('[data-raw]').forEach(b => b.addEventListener('click', () => {
      showDetail('Record', fieldList(rows[Number(b.dataset.raw)]));
    }));
  }

  // ---------- searches ----------
  function formValues(form) {
    const out = {};
    for (const [k, v] of new FormData(form)) if (String(v).trim() !== '') out[k] = String(v).trim();
    return out;
  }

  const searches = {
    inspections(v) {
      const c = [];
      if (v.estab_name) c.push(cond('estab_name', 'like', upper(v.estab_name)));
      if (v.activity_nr) c.push(cond('activity_nr', 'eq', asNum(v.activity_nr)));
      if (v.site_city) c.push(cond('site_city', 'like', upper(v.site_city)));
      if (v.site_state) c.push(cond('site_state', 'eq', upper(v.site_state)));
      if (v.site_zip) c.push(cond('site_zip', 'like', v.site_zip));
      if (v.naics_code) c.push(cond('naics_code', 'like', v.naics_code));
      if (v.insp_type) c.push(cond('insp_type', 'eq', v.insp_type));
      if (v.open_from) c.push(cond('open_date', 'gt', dayBefore(v.open_from)));
      if (v.open_to) c.push(cond('open_date', 'lt', dayAfter(v.open_to)));
      runSearch({ type: 'inspection', dataset: 'inspection', title: 'Inspections',
        opts: { conds: c, limit: PAGE_SIZE, offset: 0, sortBy: 'open_date' } });
    },

    violations(v) {
      const c = [];
      if (v.activity_nr) c.push(cond('activity_nr', 'eq', asNum(v.activity_nr)));
      if (v.standard) c.push(cond('standard', 'like', upper(v.standard).replace(/[\s.()]/g, '')));
      if (v.viol_type) c.push(cond('viol_type', 'eq', v.viol_type));
      if (v.min_penalty) c.push(cond('current_penalty', 'gt', Number(v.min_penalty) - 0.01));
      if (v.issued_from) c.push(cond('issuance_date', 'gt', dayBefore(v.issued_from)));
      if (v.issued_to) c.push(cond('issuance_date', 'lt', dayAfter(v.issued_to)));
      runSearch({ type: 'violation', dataset: 'violation', title: 'Violations',
        opts: { conds: c, limit: PAGE_SIZE, offset: 0, sortBy: 'issuance_date' } });
    },

    accidents(v) {
      const c = [];
      if (v.summary_nr) c.push(cond('summary_nr', 'eq', asNum(v.summary_nr)));
      if (v.event_desc) c.push(cond('event_desc', 'like', upper(v.event_desc)));
      if (v.fatality) c.push(cond('fatality', 'eq', v.fatality));
      if (v.event_from) c.push(cond('event_date', 'gt', dayBefore(v.event_from)));
      if (v.event_to) c.push(cond('event_date', 'lt', dayAfter(v.event_to)));
      runSearch({ type: 'accident', dataset: 'accident', title: 'Accidents',
        opts: { conds: c, limit: PAGE_SIZE, offset: 0, sortBy: 'event_date' } });
    },

    async establishments(v) {
      const c = [cond('estab_name', 'like', upper(v.estab_name))];
      if (v.site_city) c.push(cond('site_city', 'like', upper(v.site_city)));
      if (v.site_state) c.push(cond('site_state', 'eq', upper(v.site_state)));
      if (v.site_zip) c.push(cond('site_zip', 'like', v.site_zip));
      current = null;
      status('Searching OSHA inspection records for establishments…');
      try {
        const rows = await query('inspection', { conds: c, limit: ESTAB_SCAN, offset: 0, sortBy: 'open_date' });
        renderEstablishments(rows);
      } catch (e) {
        status(esc(e.message), 'error');
      }
    },
  };

  function shiftDay(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const dayBefore = iso => shiftDay(iso, -1);
  const dayAfter = iso => shiftDay(iso, 1);

  function renderEstablishments(rows) {
    const groups = new Map();
    for (const r of rows) {
      const key = [r.estab_name, r.site_address, r.site_city, r.site_state].map(x => String(x ?? '').trim().toUpperCase()).join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    if (!groups.size) { results.innerHTML = '<p class="empty">No establishments found.</p>'; return; }
    const list = [...groups.values()].sort((a, b) => b.length - a.length);
    results.innerHTML = `
      <div class="results-head">
        <h2>Establishments</h2>
        <span class="muted">${list.length} site${list.length === 1 ? '' : 's'} from ${rows.length} inspection record${rows.length === 1 ? '' : 's'}${rows.length >= ESTAB_SCAN ? ' (most recent ' + ESTAB_SCAN + '; refine your search to see more)' : ''}</span>
      </div>
      <div class="cards">${list.map((g, i) => {
        const r = g[0];
        const dates = g.map(x => fmt('open_date', x.open_date)).filter(Boolean).sort();
        return `<article class="card">
          <h3>${esc(r.estab_name)}</h3>
          <p>${esc([r.site_address, r.site_city, r.site_state, r.site_zip].filter(Boolean).join(', '))}</p>
          <p class="muted">${r.naics_code ? 'NAICS ' + esc(r.naics_code) + ' · ' : ''}${g.length} inspection${g.length === 1 ? '' : 's'}${dates.length ? ' · ' + esc(dates[0]) + ' to ' + esc(dates[dates.length - 1]) : ''}</p>
          <button class="btn small" data-estab="${i}">View inspections</button>
        </article>`;
      }).join('')}</div>`;
    results.querySelectorAll('[data-estab]').forEach(b => b.addEventListener('click', () => {
      const g = list[Number(b.dataset.estab)];
      showDetail(g[0].estab_name, `<h3>Inspections at this site</h3>${table('inspection', g)}`, g);
    }));
  }

  // ---------- detail views ----------
  function showDetail(title, html, rawRows) {
    $('#detail-title').textContent = title;
    const body = $('#detail-body');
    body.innerHTML = html;
    if (rawRows) bindRaw(body, rawRows);
    if (!dialog.open) dialog.showModal();
    body.scrollTop = 0;
  }

  async function openInspection(id) {
    showDetail(`Inspection ${id}`, '<p class="status">Loading inspection…</p>');
    try {
      const nr = asNum(id);
      const [insp, viols, injuries] = await Promise.all([
        query('inspection', { conds: [cond('activity_nr', 'eq', nr)], limit: 1 }),
        query('violation', { conds: [cond('activity_nr', 'eq', nr)], limit: 200, sortBy: 'citation_id', sort: 'asc' }),
        query('accident_injury', { conds: [cond('rel_insp_nr', 'eq', nr)], limit: 100 }).catch(() => []),
      ]);
      const r = insp[0];
      const total = key => viols.reduce((s, v) => s + (Number(v[key]) || 0), 0);
      const summaries = [...new Set(injuries.map(i => i.summary_nr).filter(Boolean))];
      const html = `
        ${r ? `<div class="summary">
          <h3>${esc(r.estab_name)}</h3>
          <p>${esc([r.site_address, r.site_city, r.site_state, r.site_zip].filter(Boolean).join(', '))}</p>
          <div class="stats">
            <div><span>Opened</span><strong>${esc(fmt('open_date', r.open_date)) || '—'}</strong></div>
            <div><span>Type</span><strong>${esc(fmt('insp_type', r.insp_type)) || '—'}</strong></div>
            <div><span>Violations</span><strong>${viols.length}</strong></div>
            <div><span>Initial penalties</span><strong>${esc(fmt('initial_penalty', total('initial_penalty')))}</strong></div>
            <div><span>Current penalties</span><strong>${esc(fmt('current_penalty', total('current_penalty')))}</strong></div>
          </div>
        </div>
        <details><summary>All inspection fields</summary>${fieldList(r)}</details>` : '<p class="empty">Inspection record not found.</p>'}
        <h3>Violations</h3>${table('violation', viols)}
        <h3>Related accidents</h3>
        ${summaries.length ? `<p>${summaries.map(s => `<button class="link" data-open="accident" data-id="${esc(s)}">Accident ${esc(s)}</button>`).join(' · ')}</p>` : '<p class="empty">No accident investigations linked to this inspection.</p>'}`;
      showDetail(`Inspection ${id}`, html, viols);
    } catch (e) {
      showDetail(`Inspection ${id}`, `<p class="status error">${esc(e.message)}</p>`);
    }
  }

  async function openAccident(id) {
    showDetail(`Accident ${id}`, '<p class="status">Loading accident…</p>');
    try {
      const nr = asNum(id);
      const [acc, abs, inj] = await Promise.all([
        query('accident', { conds: [cond('summary_nr', 'eq', nr)], limit: 1 }),
        query('accident_abstract', { conds: [cond('summary_nr', 'eq', nr)], limit: 100, sortBy: 'line_nr', sort: 'asc' }).catch(() => []),
        query('accident_injury', { conds: [cond('summary_nr', 'eq', nr)], limit: 100 }).catch(() => []),
      ]);
      const a = acc[0];
      const abstract = abs.map(x => x.abstract_text).filter(Boolean).join(' ');
      const html = `
        ${a ? `<div class="summary">
          <h3>${esc(a.event_desc || 'Accident ' + id)}</h3>
          <div class="stats">
            <div><span>Event date</span><strong>${esc(fmt('event_date', a.event_date)) || '—'}</strong></div>
            <div><span>Fatality</span><strong>${a.fatality ? 'Yes' : 'No'}</strong></div>
            <div><span>People involved</span><strong>${inj.length}</strong></div>
          </div>
          ${a.event_keyword ? `<p class="muted">Keywords: ${esc(a.event_keyword)}</p>` : ''}
        </div>
        <details><summary>All accident fields</summary>${fieldList(a)}</details>` : '<p class="empty">Accident record not found.</p>'}
        <h3>Abstract</h3>${abstract ? `<p class="abstract">${esc(abstract)}</p>` : '<p class="empty">No abstract available.</p>'}
        <h3>Injured employees</h3>${table('accident_injury', inj)}`;
      showDetail(`Accident ${id}`, html, inj);
    } catch (e) {
      showDetail(`Accident ${id}`, `<p class="status error">${esc(e.message)}</p>`);
    }
  }

  // ---------- wiring ----------
  function fillSelect(name, map) {
    document.querySelectorAll(`select[name="${name}"]`).forEach(sel => {
      for (const [k, v] of Object.entries(map)) sel.add(new Option(`${k} – ${v}`, k));
    });
  }
  fillSelect('insp_type', CODES.insp_type);
  fillSelect('viol_type', CODES.viol_type);

  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-selected', String(t === tab)));
    document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
    results.innerHTML = '';
  }));

  document.querySelectorAll('.search-form').forEach(form => form.addEventListener('submit', e => {
    e.preventDefault();
    if (needKey()) return;
    searches[form.dataset.search](formValues(form));
  }));

  results.addEventListener('click', e => {
    const b = e.target.closest('[data-page]');
    if (!b || !current) return;
    current.opts = { ...current.opts, offset: Math.max(0, current.opts.offset + Number(b.dataset.page) * current.opts.limit) };
    runSearch(current);
  });

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-open]');
    if (!b) return;
    if (needKey()) return;
    (b.dataset.open === 'inspection' ? openInspection : openAccident)(b.dataset.id);
  });

  $('#detail-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  // settings panel
  const panel = $('#settings');
  const toggle = $('#settings-toggle');
  function openSettings(show) {
    panel.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
  }
  toggle.addEventListener('click', () => openSettings(panel.hidden));
  $('#api-key').value = settings.key;
  $('#api-mode').value = settings.mode;
  $('#settings-form').addEventListener('submit', e => {
    e.preventDefault();
    settings.key = $('#api-key').value.trim();
    settings.mode = $('#api-mode').value;
    store.set('osha.apiKey', settings.key);
    store.set('osha.mode', settings.mode);
    $('#settings-status').textContent = 'Saved.';
  });
  $('#test-conn').addEventListener('click', async () => {
    settings.key = $('#api-key').value.trim();
    settings.mode = $('#api-mode').value;
    const out = $('#settings-status');
    out.textContent = 'Testing…';
    try {
      const rows = await fetchRows('inspection', { limit: 1 });
      out.textContent = rows.length ? 'Connected. The OSHA inspection dataset responded.' : 'Connected, but no rows came back.';
    } catch (e) {
      out.textContent = e.message;
    }
  });

  if (!settings.key && settings.mode === 'direct') openSettings(true);
})();
