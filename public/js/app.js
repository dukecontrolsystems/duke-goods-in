// ── State ──────────────────────────────────────────────
let currentUser = null;
let matchResult = null;
let matchedPO = null;
let selectedFile = null;
let poSelectedFile = null;
let pendingPOLines = [];
let expandedProjects = {};

// ── Init ───────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await api('/api/me');
    if (res.id) showApp(res);
  } catch { /* not logged in */ }

  document.getElementById('login-pin').addEventListener('keydown', e => {
    if (e.key === 'Enter') login();
  });
});

// ── Auth ───────────────────────────────────────────────
async function login() {
  const name = document.getElementById('login-name').value.trim();
  const pin = document.getElementById('login-pin').value.trim();
  if (!name || !pin) return showLoginError('Enter your name and PIN');
  try {
    const res = await api('/api/login', 'POST', { name, pin });
    showApp(res.user);
  } catch (e) {
    showLoginError('Invalid name or PIN');
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.style.display = 'block';
}

function showApp(user) {
  currentUser = user;
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('nav-user').textContent = user.name;
}

async function logout() {
  await api('/api/logout', 'POST');
  location.reload();
}

// ── Tabs ───────────────────────────────────────────────
function goTab(name) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('tab-' + name + '-btn').classList.add('active');
  if (name === 'projects') loadProjects();
  if (name === 'orders') loadOrders();
  if (name === 'history') loadHistory();
}

// ── File selection ─────────────────────────────────────
function fileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  selectedFile = file;
  document.getElementById('file-preview').style.display = 'flex';
  document.getElementById('file-preview-name').textContent = '✓ ' + file.name;
}
function clearFile() {
  selectedFile = null;
  document.getElementById('file-preview').style.display = 'none';
  document.getElementById('camera-input').value = '';
  document.getElementById('file-input').value = '';
}
function poFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  poSelectedFile = file;
  document.getElementById('po-file-preview').style.display = 'flex';
  document.getElementById('po-file-name').textContent = '✓ ' + file.name;
}
function clearPOFile() {
  poSelectedFile = null;
  document.getElementById('po-file-preview').style.display = 'none';
  document.getElementById('po-camera').value = '';
  document.getElementById('po-file').value = '';
}

// ── RECEIVE ────────────────────────────────────────────
async function processDelivery() {
  const text = document.getElementById('dn-text').value.trim();
  if (!selectedFile && !text) {
    toast('Take a photo or paste delivery note text first');
    return;
  }
  show('receive-upload-panel', false);
  show('receive-processing', true);
  show('receive-results', false);
  setMsg('Reading delivery note…');

  try {
    const fd = new FormData();
    if (selectedFile) fd.append('file', selectedFile);
    else fd.append('text', text);

    setMsg('Matching against purchase orders…');
    const result = await apiFD('/api/match-delivery', fd);
    matchResult = result;

    const pos = await api('/api/pos');
    matchedPO = pos.find(p => p.id === result.matchedPOId) || null;

    show('receive-processing', false);
    show('receive-results', true);
    renderMatchResults();
  } catch (e) {
    show('receive-processing', false);
    show('receive-upload-panel', true);
    toast('Error: ' + (e.message || 'Could not process. Try again.'));
  }
}

function renderMatchResults() {
  const r = matchResult;
  const po = matchedPO;
  const lines = r.lines || [];
  const unmatched = r.unmatchedDelivered || [];

  // Banner
  const banner = document.getElementById('match-banner');
  if (po) {
    banner.innerHTML = `<div class="banner banner-ok">
      <span class="banner-icon">✅</span>
      <div>
        <div class="banner-title">Matched: ${esc(po.number)} — ${esc(po.supplier)}</div>
        <div class="banner-sub">${esc(po.project || '')} · ${esc(r.matchReason || '')} · Confidence: ${r.confidence || '—'}</div>
      </div>
    </div>`;
  } else {
    banner.innerHTML = `<div class="banner banner-warn">
      <span class="banner-icon">⚠️</span>
      <div>
        <div class="banner-title">No matching PO found</div>
        <div class="banner-sub">Check the PO is loaded in the system, or add it first.</div>
      </div>
    </div>`;
  }

  // Pre-fill
  if (r.dnNumber) document.getElementById('recv-dn').value = r.dnNumber;
  if (r.carrier) document.getElementById('recv-carrier').value = r.carrier;
  document.getElementById('recv-date').value = r.deliveryDate || today();

  // Stats
  let ok = 0, short = 0, missing = 0;
  lines.forEach(l => { if (l.status === 'ok') ok++; else if (l.status === 'short') short++; else missing++; });
  document.getElementById('recv-stats').innerHTML = `
    <div class="stat-card"><div class="stat-n">${lines.length}</div><div class="stat-l">Lines</div></div>
    <div class="stat-card"><div class="stat-n" style="color:#27500A">${ok}</div><div class="stat-l">OK</div></div>
    <div class="stat-card"><div class="stat-n" style="color:#BA7517">${short}</div><div class="stat-l">Short</div></div>
    <div class="stat-card"><div class="stat-n" style="color:#791F1F">${missing}</div><div class="stat-l">Missing</div></div>`;

  const bdg = {
    ok: '<span class="badge badge-ok"><span class="dot dot-ok"></span>OK</span>',
    short: '<span class="badge badge-short"><span class="dot dot-short"></span>Short</span>',
    missing: '<span class="badge badge-missing"><span class="dot dot-miss"></span>Missing</span>'
  };
  const cls = { ok: 'row-ok', short: 'row-short', missing: 'row-miss' };

  document.getElementById('recv-tbody').innerHTML =
    lines.map(l => `<tr class="${cls[l.status] || ''}">
      <td>${esc(l.desc)}</td>
      <td style="color:#888;font-size:12px">${esc(l.partno) || '—'}</td>
      <td style="text-align:center;font-weight:700">${l.ordered}</td>
      <td style="text-align:center;font-weight:700">${l.received}</td>
      <td>${bdg[l.status] || ''}</td>
    </tr>`).join('') +
    unmatched.map(l => `<tr>
      <td>${esc(l.desc)} <span class="badge badge-pending" style="font-size:10px">Not on PO</span></td>
      <td style="color:#888;font-size:12px">${esc(l.partno) || '—'}</td>
      <td style="text-align:center">—</td>
      <td style="text-align:center;font-weight:700">${l.received}</td>
      <td><span class="badge badge-pending">Unexpected</span></td>
    </tr>`).join('');

  const issues = [...lines.filter(l => l.status !== 'ok'), ...unmatched];
  const ip = document.getElementById('issues-panel');
  if (issues.length) {
    ip.style.display = 'block';
    document.getElementById('issues-list').innerHTML = issues.map(l =>
      `<div class="issue-item">⚠ <span><strong>${esc(l.desc)}</strong>${l.partno ? ' (' + esc(l.partno) + ')' : ''} — ${l.status === 'missing' ? 'Not delivered' : l.status === 'short' ? `Only ${l.received} of ${l.ordered} received` : 'Unexpected item'}</span></div>`
    ).join('');
  } else ip.style.display = 'none';
}

async function confirmDelivery() {
  if (!matchResult) return toast('Process a delivery note first');
  try {
    await api('/api/deliveries', 'POST', {
      po_id: matchedPO?.id || '',
      po_number: matchedPO?.number || 'Unknown',
      supplier: matchedPO?.supplier || 'Unknown',
      project: matchedPO?.project || '',
      delivery_date: document.getElementById('recv-date').value,
      carrier: document.getElementById('recv-carrier').value,
      dn_ref: document.getElementById('recv-dn').value,
      status: 'complete',
      lines: matchResult.lines || [],
      unmatched: matchResult.unmatchedDelivered || [],
      image_path: matchResult.imagePath || '',
      ai_summary: matchResult.summary || ''
    });
    toast('Delivery confirmed ✓');
    resetReceive();
  } catch (e) {
    toast('Error saving delivery: ' + e.message);
  }
}

function resetReceive() {
  matchResult = null; matchedPO = null; selectedFile = null;
  show('receive-upload-panel', true);
  show('receive-processing', false);
  show('receive-results', false);
  document.getElementById('dn-text').value = '';
  clearFile();
}

// ── PROJECTS ───────────────────────────────────────────
async function loadProjects() {
  const el = document.getElementById('projects-list');
  el.innerHTML = '<div class="processing-card"><div class="spinner"></div><span>Loading…</span></div>';
  const projects = await api('/api/projects');
  if (!projects.length) { el.innerHTML = '<div class="empty-state"><div class="empty-icon">📁</div><div class="empty-text">No projects yet.<br>Add POs with project names to see them here.</div></div>'; return; }
  el.innerHTML = projects.map(proj => {
    let totalLines = 0, receivedLines = 0, shortLines = 0, missingLines = 0;
    proj.pos.forEach(po => {
      totalLines += po.lines.length;
      po.deliveries.forEach(d => {
        (d.lines || []).forEach(l => {
          if (l.status === 'ok') receivedLines++;
          else if (l.status === 'short') shortLines++;
          else if (l.status === 'missing') missingLines++;
        });
      });
    });
    const outstanding = totalLines - receivedLines;
    const pct = totalLines > 0 ? Math.round(receivedLines / totalLines * 100) : 0;
    const allDone = outstanding === 0 && totalLines > 0;
    const hasIssues = shortLines > 0 || missingLines > 0;
    const fillCls = allDone ? 'complete' : hasIssues ? 'issues' : '';
    const statusBadge = allDone ? '<span class="badge badge-ok">Complete</span>' : hasIssues ? '<span class="badge badge-short">Issues</span>' : receivedLines > 0 ? '<span class="badge badge-blue">In progress</span>' : '<span class="badge badge-pending">Not started</span>';
    const expanded = expandedProjects[proj.name];
    const suppliers = [...new Set(proj.pos.map(p => p.supplier))].join(', ');

    const poRows = proj.pos.map(po => {
      let poRec = 0, poTotal = po.lines.length, poMiss = 0;
      po.deliveries.forEach(d => (d.lines || []).forEach(l => { if (l.status === 'ok') poRec++; else if (l.status === 'missing') poMiss++; }));
      const poPct = poTotal > 0 ? Math.round(poRec / poTotal * 100) : 0;
      return `<div class="proj-po-row">
        <div>
          <div class="proj-po-title">${esc(po.number)}</div>
          <div class="proj-po-sub">${esc(po.supplier)} · Expected: ${po.expected_date || '—'}</div>
          <div class="prog-bar" style="width:120px"><div class="prog-fill ${poPct===100?'complete':poMiss?'issues':''}" style="width:${poPct}%"></div></div>
        </div>
        <div class="proj-po-right">
          <div class="proj-po-count">${poRec}/${poTotal}</div>
          <div class="proj-po-out">${poTotal - poRec} outstanding${poMiss ? ` · <span style="color:var(--red)">${poMiss} missing</span>` : ''}</div>
        </div>
      </div>`;
    }).join('');

    return `<div class="proj-card">
      <div class="proj-header" onclick="toggleProject(this)" data-projname="${esc(proj.name)}">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <span class="proj-name">${esc(proj.name)}</span>${statusBadge}
          </div>
          <div class="proj-meta">${proj.pos.length} PO${proj.pos.length !== 1 ? 's' : ''} · ${esc(suppliers)}</div>
          <div class="prog-bar"><div class="prog-fill ${fillCls}" style="width:${pct}%"></div></div>
          <div class="prog-text">${pct}% received · ${outstanding} line${outstanding !== 1 ? 's' : ''} outstanding</div>
        </div>
        <span class="proj-chevron ${expanded ? 'open' : ''}">⌄</span>
      </div>
      <div class="proj-body ${expanded ? 'open' : ''}">${poRows}</div>
    </div>`;
  }).join('');
}

function toggleProject(el) {
  const name = el.dataset.projname;
  expandedProjects[name] = !expandedProjects[name];
  loadProjects();
}

// ── ORDERS ─────────────────────────────────────────────
let expandedPOs = {};

async function loadOrders() {
  const el = document.getElementById('orders-list');
  el.innerHTML = '';
  const pos = await api('/api/pos');
  if (!pos.length) { el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No purchase orders yet.<br>Add one above to get started.</div></div>'; return; }
  el.innerHTML = pos.map(po => {
    const projTag = po.project ? `<span class="badge badge-blue" style="font-size:11px">${esc(po.project)}</span> ` : '';
    const expanded = expandedPOs[po.id];
    const lineRows = expanded ? `
      <div style="border-top:1px solid #f0f0f0;margin-top:8px;padding-top:8px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#888;margin-bottom:6px">Line items</div>
        ${po.lines.map(l => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #f8f8f8;font-size:13px">
            <div>
              <div style="font-weight:500">${esc(l.description)}</div>
              ${l.part_number ? `<div style="font-size:11px;color:#888">${esc(l.part_number)}</div>` : ''}
            </div>
            <div style="font-weight:700;flex-shrink:0;margin-left:12px">Qty: ${l.quantity}${l.unit ? ' ' + esc(l.unit) : ''}</div>
          </div>`).join('')}
      </div>` : '';
    return `<div class="list-card">
      <div class="list-card-header" onclick="togglePO('${po.id}')" style="cursor:pointer">
        <div style="flex:1;min-width:0">
          <div class="list-card-title">${esc(po.number)} — ${esc(po.supplier)}</div>
          <div class="list-card-sub">${projTag}${po.lines.length} line${po.lines.length !== 1 ? 's' : ''} · Expected: ${po.expected_date || '—'}</div>
        </div>
        <div class="list-card-actions" onclick="event.stopPropagation()">
          <span class="badge ${po.status === 'complete' ? 'badge-ok' : 'badge-pending'}">${po.status === 'complete' ? 'Complete' : 'Open'}</span>
          <span style="color:#aaa;font-size:18px;transition:transform .2s;display:inline-block;${expanded ? 'transform:rotate(180deg)' : ''}">⌄</span>
          <button class="btn btn-ghost btn-sm" onclick="deletePO('${po.id}')">🗑</button>
        </div>
      </div>
      ${lineRows}
    </div>`;
  }).join('');
}

function togglePO(id) {
  expandedPOs[id] = !expandedPOs[id];
  loadOrders();
}

function showAddPO() {
  document.getElementById('add-po-panel').style.display = 'block';
  document.getElementById('add-po-panel').scrollIntoView({ behavior: 'smooth' });
}
function cancelAddPO() {
  document.getElementById('add-po-panel').style.display = 'none';
  document.getElementById('po-form').style.display = 'none';
  document.getElementById('extract-btn').style.display = 'block';
  document.getElementById('po-text').value = '';
  document.getElementById('po-project-input').value = '';
  clearPOFile();
  pendingPOLines = [];
}

async function extractPO() {
  const text = document.getElementById('po-text').value.trim();
  if (!poSelectedFile && !text) { toast('Choose a file or paste text first'); return; }
  show('po-processing', true);
  document.getElementById('extract-btn').disabled = true;
  try {
    let result;
    if (poSelectedFile) {
      const fd = new FormData();
      fd.append('file', poSelectedFile);
      result = await apiFD('/api/extract-po', fd);
    } else {
      result = await api('/api/extract-po', 'POST', { text });
    }
    document.getElementById('po-number').value = result.number || '';
    document.getElementById('po-supplier').value = result.supplier || '';
    document.getElementById('po-project').value = document.getElementById('po-project-input').value.trim() || result.project || '';
    document.getElementById('po-expected').value = result.expected_date || '';
    pendingPOLines = (result.lines || []).map((l, i) => ({ ...l, _id: i }));
    renderPOLines();
    show('po-form', true);
    document.getElementById('extract-btn').style.display = 'none';
    toast('Extracted ' + pendingPOLines.length + ' line items');
  } catch (e) {
    toast('Extraction failed: ' + e.message);
  }
  show('po-processing', false);
  document.getElementById('extract-btn').disabled = false;
}

function renderPOLines() {
  document.getElementById('po-lines-list').innerHTML = pendingPOLines.map((l, i) => `
    <div class="po-line-row">
      <div class="po-line-desc">
        <input class="input" type="text" value="${esc(l.description || '')}" placeholder="Description" oninput="pendingPOLines[${i}].description=this.value" style="font-size:13px;padding:8px 10px;margin-bottom:4px">
        <input class="input" type="text" value="${esc(l.part_number || '')}" placeholder="Part no." oninput="pendingPOLines[${i}].part_number=this.value" style="font-size:12px;padding:6px 10px;color:#888">
      </div>
      <div class="po-line-qty">
        <input class="input" type="number" value="${l.quantity || 1}" min="0" oninput="pendingPOLines[${i}].quantity=+this.value" style="font-size:13px;padding:8px;text-align:center">
      </div>
      <button class="btn-clear" onclick="removePOLine(${i})">✕</button>
    </div>
  `).join('');
}

function addPOLine() {
  pendingPOLines.push({ description: '', part_number: '', quantity: 1 });
  renderPOLines();
}
function removePOLine(i) {
  pendingPOLines.splice(i, 1);
  renderPOLines();
}

async function savePO() {
  const number = document.getElementById('po-number').value.trim();
  const supplier = document.getElementById('po-supplier').value.trim();
  if (!number || !supplier) { toast('PO number and supplier are required'); return; }
  if (!pendingPOLines.length) { toast('Add at least one line item'); return; }
  try {
    await api('/api/pos', 'POST', {
      number, supplier,
      project: document.getElementById('po-project').value.trim(),
      expected_date: document.getElementById('po-expected').value,
      lines: pendingPOLines
    });
    toast('PO saved ✓');
    cancelAddPO();
    loadOrders();
  } catch (e) {
    toast('Error saving PO: ' + e.message);
  }
}

async function deletePO(id) {
  if (!confirm('Delete this PO? This cannot be undone.')) return;
  await api('/api/pos/' + id, 'DELETE');
  toast('PO deleted');
  loadOrders();
}

// ── HISTORY ────────────────────────────────────────────
async function loadHistory() {
  const el = document.getElementById('history-list');
  el.innerHTML = '';
  const deliveries = await api('/api/deliveries');
  if (!deliveries.length) { el.innerHTML = '<div class="empty-state"><div class="empty-icon">🕓</div><div class="empty-text">No confirmed deliveries yet.</div></div>'; return; }
  const bdg = {
    ok: '<span class="badge badge-ok">OK</span>',
    short: '<span class="badge badge-short">Short</span>',
    missing: '<span class="badge badge-missing">Missing</span>',
    unexpected: '<span class="badge badge-pending">Unexpected</span>'
  };
  el.innerHTML = deliveries.map(d => {
    const issues = (d.lines || []).filter(l => l.status !== 'ok').length;
    const projTag = d.project ? `<span class="badge badge-blue" style="font-size:11px;margin-right:4px">${esc(d.project)}</span>` : '';
    const lineRows = (d.lines || []).map(l => `<tr>
      <td>${esc(l.description)}</td>
      <td style="color:#888;font-size:12px">${esc(l.part_number) || '—'}</td>
      <td style="text-align:center">${l.ordered}</td>
      <td style="text-align:center;font-weight:700">${l.received}</td>
      <td>${bdg[l.status] || ''}</td>
    </tr>`).join('');
    return `<div class="list-card">
      <div class="list-card-header">
        <div>
          <div class="list-card-title">${esc(d.po_number)} — ${esc(d.supplier)}</div>
          <div class="list-card-sub">${projTag}${d.delivery_date || '—'} · ${d.carrier || '—'} · DN: ${d.dn_ref || '—'}</div>
          <div class="list-card-sub">Received by: ${esc(d.received_by || '—')}</div>
        </div>
        <span class="badge ${issues ? 'badge-missing' : 'badge-ok'}">${issues ? issues + ' issue' + (issues > 1 ? 's' : '') : 'All OK'}</span>
      </div>
      <div class="results-table-wrap" style="margin-top:8px">
        <table class="results-table">
          <thead><tr><th>Item</th><th>P/N</th><th>Ord</th><th>Rcvd</th><th>Status</th></tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');
}

function exportCSV() {
  api('/api/deliveries').then(deliveries => {
    if (!deliveries.length) { toast('No deliveries to export'); return; }
    let csv = 'Project,PO Number,Supplier,Date,Carrier,DN Ref,Received By,Item,Part No,Ordered,Received,Status\n';
    deliveries.forEach(d => (d.lines || []).forEach(l => {
      csv += `"${d.project||''}","${d.po_number}","${d.supplier}","${d.delivery_date||''}","${d.carrier||''}","${d.dn_ref||''}","${d.received_by||''}","${l.description}","${l.part_number||''}","${l.ordered}","${l.received}","${l.status}"\n`;
    }));
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'duke-goods-in.csv';
    a.click();
  });
}

// ── Helpers ────────────────────────────────────────────
async function api(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || res.statusText); }
  return res.json();
}

async function apiFD(url, fd) {
  const res = await fetch(url, { method: 'POST', body: fd });
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || res.statusText); }
  return res.json();
}

function show(id, visible) {
  document.getElementById(id).style.display = visible ? 'block' : 'none';
}
function setMsg(msg) { document.getElementById('processing-msg').textContent = msg; }
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function today() { return new Date().toISOString().slice(0, 10); }
function toast(msg, dur = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), dur);
}
