// ── State ──────────────────────────────────────────────
let currentUser = null;
let matchResult = null;
let matchedPO = null;
let selectedFiles = [];  // supports multiple pages
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
  goTab('home');
  try { setTimeout(updateUnmatchedCount, 1000); } catch(e) {}
}

async function logout() {
  await api('/api/logout', 'POST');
  location.reload();
}

// ── Tabs ───────────────────────────────────────────────
// Check unmatched count on load
setTimeout(updateUnmatchedCount, 1000);

function goTab(name) {
  document.querySelectorAll('.tab-section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab-item').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('tab-' + name + '-btn').classList.add('active');
  if (name === 'projects') loadProjects();
  if (name === 'orders') loadOrders();
  if (name === 'history') loadHistory();
  if (name === 'unmatched') loadUnmatched();
  if (name === 'home') loadHome();
  if (name === 'raise') { loadIssuedPOs(); loadProjectSuggestions(); }
}

function loadHome() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const el = document.getElementById('home-greeting');
  if (el) el.textContent = greeting + (currentUser ? ', ' + currentUser.name : '');
  // Sync unmatched badge
  api('/api/unmatched').then(items => {
    const badge = document.getElementById('home-unmatched-badge');
    const tabBadge = document.getElementById('unmatched-count');
    if (items.length > 0) {
      if (badge) { badge.textContent = items.length; badge.style.display = 'inline'; }
      if (tabBadge) { tabBadge.textContent = items.length; tabBadge.style.display = 'inline'; }
    } else {
      if (badge) badge.style.display = 'none';
      if (tabBadge) tabBadge.style.display = 'none';
    }
  }).catch(() => {});
}

// ── File selection ─────────────────────────────────────
async function compressImage(file) {
  // Only compress images, not PDFs or text
  if (!file.type.startsWith('image/')) return file;
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1400;
      let w = img.width, h = img.height;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => {
        resolve(new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.75);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

async function addFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const compressed = await compressImage(file);
  selectedFiles.push(compressed);
  renderFileList();
  document.getElementById('camera-input').value = '';
  document.getElementById('file-input').value = '';
}

function removeFile(idx) {
  selectedFiles.splice(idx, 1);
  renderFileList();
}

function renderFileList() {
  const el = document.getElementById('file-list');
  const btn = document.getElementById('add-another-btn');
  if (!selectedFiles.length) {
    el.innerHTML = '';
    btn.style.display = 'none';
    return;
  }
  el.innerHTML = selectedFiles.map((f, i) =>
    `<div class="file-preview" style="margin-bottom:4px">
      <span>✓ ${f.name}</span>
      <button class="btn-clear" onclick="removeFile(${i})">✕</button>
    </div>`
  ).join('');
  btn.style.display = 'block';
}

function clearFile() {
  selectedFiles = [];
  renderFileList();
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
  if (!selectedFiles.length && !text) {
    toast('Take a photo or paste delivery note text first');
    return;
  }
  show('receive-upload-panel', false);
  show('receive-processing', true);
  show('receive-results', false);
  setMsg('Reading delivery note…');

  try {
    const fd = new FormData();
    if (selectedFiles.length > 0) {
      selectedFiles.forEach((f, i) => fd.append('file', f));
    } else fd.append('text', text);

    setMsg('Matching against purchase orders…');
    let result;
    try {
      result = await apiFD('/api/match-delivery', fd);
    } catch(e) {
      // If no POs exist, save as unmatched directly
      if (e.message && e.message.includes('No open purchase orders')) {
        show('receive-processing', false);
        show('receive-upload-panel', true);
        await api('/api/deliveries', 'POST', {
          po_id: '', po_number: '', supplier: '', project: '',
          delivery_date: today(), carrier: '', dn_ref: '',
          status: 'unmatched', lines: [], unmatched: [],
          image_path: '', ai_summary: 'No POs on file to match against'
        });
        toast('Saved to Unmatched — add a PO to match it');
        updateUnmatchedCount();
        return;
      }
      throw e;
    }
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
  const isUnmatched = !matchedPO;
  try {
    // Warn if no DN ref — duplicate detection won't work without one
    const dnRef = document.getElementById('recv-dn').value.trim();
    if (!dnRef) {
      const go = confirm('No delivery note number entered. Without one we cannot detect duplicates. Continue anyway?');
      if (!go) return;
    }
    await api('/api/deliveries', 'POST', {
      po_id: matchedPO?.id || '',
      po_number: matchedPO?.number || '',
      supplier: matchedPO?.supplier || matchResult.supplierGuess || '',
      project: matchedPO?.project || '',
      delivery_date: document.getElementById('recv-date').value,
      carrier: document.getElementById('recv-carrier').value,
      dn_ref: document.getElementById('recv-dn').value,
      status: isUnmatched ? 'unmatched' : 'complete',
      lines: matchResult.lines || [],
      unmatched: matchResult.unmatchedDelivered || [],
      image_path: matchResult.imagePath || '',
      ai_summary: matchResult.summary || ''
    });
    if (isUnmatched) {
      toast('Saved to Unmatched deliveries — link a PO to action it');
      updateUnmatchedCount();
    } else {
      toast('Delivery confirmed ✓');
    }
    resetReceive();
  } catch (e) {
    if (e.message && e.message.includes('Duplicate delivery note')) {
      alert('⚠️ ' + e.message);
    } else {
      toast('Error saving delivery: ' + e.message);
    }
  }
}

function resetReceive() {
  matchResult = null; matchedPO = null; selectedFiles = [];
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
      const hasDels = po.deliveries.length > 0;
      // Build cumulative received map per line
      const lineRecvMap = {};
      po.deliveries.forEach(d => (d.lines||[]).forEach(l => {
        const key = l.po_line_id || l.description;
        if (!lineRecvMap[key]) lineRecvMap[key] = 0;
        lineRecvMap[key] += (l.received || 0);
      }));
      // Count against PO lines
      po.lines.forEach(pol => {
        const key = pol.id || pol.description;
        const recvd = lineRecvMap[key] || lineRecvMap[pol.description] || 0;
        if (recvd >= pol.quantity) receivedLines++;
        else if (hasDels && recvd > 0) shortLines++;
        else if (hasDels && recvd === 0) missingLines++;
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
      const poTotal = po.lines.length;
      const poHasDels = po.deliveries.length > 0;
      const poRecvMap = {};
      po.deliveries.forEach(d => (d.lines||[]).forEach(l => {
        const key = l.po_line_id || l.description;
        if (!poRecvMap[key]) poRecvMap[key] = 0;
        poRecvMap[key] += (l.received || 0);
      }));
      let poRec = 0, poMiss = 0, poPartial = 0;
      po.lines.forEach(pol => {
        const key = pol.id || pol.description;
        const recvd = poRecvMap[key] || poRecvMap[pol.description] || 0;
        if (recvd >= pol.quantity) poRec++;
        else if (poHasDels && recvd === 0) poMiss++;
        else if (poHasDels && recvd > 0) poPartial++;
      });
      const poPct = poTotal > 0 ? Math.round(poRec / poTotal * 100) : 0;
      return `<div class="proj-po-row">
        <div>
          <div class="proj-po-title">${esc(po.number)}</div>
          <div class="proj-po-sub">${esc(po.supplier)} · Expected: ${po.expected_date || '—'}</div>
          <div class="prog-bar" style="width:120px"><div class="prog-fill ${poPct===100?'complete':poMiss?'issues':''}" style="width:${poPct}%"></div></div>
        </div>
        <div class="proj-po-right">
          <div class="proj-po-count">${poRec}/${poTotal}</div>
          <div class="proj-po-out">${poTotal - poRec} outstanding${poMiss ? ` · <span style="color:var(--red)">${poMiss} missing</span>` : ''}${poPartial ? ` · <span style="color:#BA7517">${poPartial} partial</span>` : ''}</div>
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
  if (!el) return;
  el.innerHTML = '';
  const [pos, deliveries] = await Promise.all([api('/api/pos'), api('/api/deliveries')]);
  if (!pos.length) { el.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><div class="empty-text">No purchase orders yet.<br>Add one above to get started.</div></div>'; return; }

  el.innerHTML = pos.map(po => {
    const projTag = po.project ? `<span class="badge badge-blue" style="font-size:11px">${esc(po.project)}</span> ` : '';
    const expanded = expandedPOs[po.id];
    const total = po.lines.length;

    // Calculate received from deliveries — use cumulative state per line
    const poDels = deliveries.filter(d => d.po_id === po.id);
    const hasDels = poDels.length > 0;

    // Build a map of total received per line description
    const lineReceivedMap = {};
    poDels.forEach(d => (d.lines||[]).forEach(l => {
      const key = l.po_line_id || l.description;
      if (!lineReceivedMap[key]) lineReceivedMap[key] = 0;
      lineReceivedMap[key] += (l.received || 0);
    }));

    // Count against PO lines
    let received = 0, missing = 0, partial = 0;
    po.lines.forEach(pol => {
      const key = pol.id || pol.description;
      const recvd = lineReceivedMap[key] || lineReceivedMap[pol.description] || 0;
      if (recvd >= pol.quantity) received++;
      else if (hasDels && recvd === 0) missing++;
      else if (hasDels && recvd > 0) partial++;
    });
    const outstanding = total - received;
    const pct = total > 0 ? Math.round(received / total * 100) : 0;

    const progressBar = hasDels ? `
      <div style="margin-top:6px">
        <div style="height:5px;background:#eee;border-radius:4px;overflow:hidden;width:100%">
          <div style="height:100%;background:${pct===100?'#3B6D11':missing?'#BA7517':'#0F2D52'};border-radius:4px;width:${pct}%"></div>
        </div>
        <div style="font-size:11px;color:#888;margin-top:3px">${received}/${total} lines received${missing ? ` · <span style="color:#791F1F">${missing} missing</span>` : ''}${partial ? ` · <span style="color:#BA7517">${partial} partially received</span>` : ''}</div>
      </div>` : '';

    // Build received map from deliveries for this PO
    const receivedMap = {};
    poDels.forEach(d => (d.lines||[]).forEach(l => {
      const key = l.po_line_id || l.description;
      if (!receivedMap[key]) receivedMap[key] = 0;
      if (l.status === 'ok' || l.status === 'short') receivedMap[key] += (l.received || 0);
    }));

    const lineRows = expanded ? `
      <div style="border-top:1px solid #f0f0f0;margin-top:8px;padding-top:8px">
        <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#888;margin-bottom:6px;padding:0 4px">
          <span>Item</span><span style="text-align:center">Ordered</span><span style="text-align:center">Received</span><span style="text-align:center">Status</span>
        </div>
        ${po.lines.map(l => {
          const recvd = receivedMap[l.id] || receivedMap[l.description] || 0;
          const ordered = l.quantity;
          const done = recvd >= ordered;
          const partial = recvd > 0 && recvd < ordered;
          const none = recvd === 0;
          const statusColor = done ? '#27500A' : partial ? '#BA7517' : '#888';
          const statusLabel = done ? '✓ Received' : partial ? '~ Partial' : poDels.length ? '✗ Missing' : '—';
          const rowBg = done ? '#f9fdf5' : partial ? '#fffbf5' : poDels.length ? '#fff8f8' : '';
          return `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:4px;align-items:center;padding:7px 4px;border-bottom:1px solid #f5f5f5;font-size:13px;background:${rowBg}">
            <div>
              <div style="font-weight:500">${esc(l.description)}</div>
              ${l.part_number ? `<div style="font-size:11px;color:#888">${esc(l.part_number)}</div>` : ''}
            </div>
            <div style="text-align:center;font-weight:600;min-width:52px">${ordered}${l.unit ? ' ' + esc(l.unit) : ''}</div>
            <div style="text-align:center;font-weight:600;min-width:52px;color:${recvd>0?'#0F2D52':'#aaa'}">${recvd > 0 ? recvd : '—'}</div>
            <div style="text-align:center;font-weight:700;min-width:52px;color:${statusColor}">${statusLabel}</div>
          </div>`;
        }).join('')}
      </div>` : '';

    return `<div class="list-card">
      <div class="list-card-header" onclick="togglePO('${po.id}')" style="cursor:pointer">
        <div style="flex:1;min-width:0">
          <div class="list-card-title">${esc(po.number)} — ${esc(po.supplier)}</div>
          <div class="list-card-sub">${projTag}${total} line${total !== 1 ? 's' : ''} · Expected: ${po.expected_date || '—'}</div>
          ${progressBar}
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
  const scrollY = window.scrollY;
  expandedPOs[id] = !expandedPOs[id];
  loadOrders().then(() => window.scrollTo(0, scrollY));
}

let allProjectNames = [];

// Filter orders by search term
function filterOrders(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#orders-list .list-card').forEach(card => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(q) ? '' : 'none';
  });
}

// Filter projects by search term
function filterProjects_tab(val) {
  const q = val.toLowerCase();
  document.querySelectorAll('#projects-list .list-card').forEach(card => {
    const text = card.textContent.toLowerCase();
    card.style.display = text.includes(q) ? '' : 'none';
  });
}

async function loadProjectSuggestions() {
  try {
    allProjectNames = await api('/api/project-names');
  } catch(e) { allProjectNames = []; }
}

function showProjectDropdown() {
  renderProjectDropdown(allProjectNames);
}

function hideProjectDropdown() {
  const dd = document.getElementById('project-dropdown');
  if (dd) dd.style.display = 'none';
}

function filterProjects(val) {
  const filtered = val
    ? allProjectNames.filter(n => n.toLowerCase().includes(val.toLowerCase()))
    : allProjectNames;
  renderProjectDropdown(filtered);
}

function renderProjectDropdown(names) {
  const dd = document.getElementById('project-dropdown');
  if (!dd) return;
  if (!names.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = names.map(n =>
    `<div data-name="${esc(n)}"
      style="padding:10px 14px;font-size:14px;cursor:pointer;border-bottom:0.5px solid #f0f0f0;color:#1a1a1a"
      onmouseover="this.style.background='#EAF3DE'" onmouseout="this.style.background=''">${esc(n)}</div>`
  ).join('');
  dd.onclick = function(e) {
    const item = e.target.closest('[data-name]');
    if (item) selectProject(item.getAttribute('data-name'));
  };
  dd.style.display = 'block';
}

function selectProject(name) {
  const input = document.getElementById('po-project-input');
  if (input) { input.value = name; input.focus(); }
  hideProjectDropdown();
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  const dd = document.getElementById('project-dropdown');
  const input = document.getElementById('po-project-input');
  if (dd && !dd.contains(e.target) && e.target !== input) {
    dd.style.display = 'none';
  }
});

function showAddPO() {
  document.getElementById('add-po-panel').style.display = 'block';
  document.getElementById('add-po-panel').scrollIntoView({ behavior: 'smooth' });
  loadProjectSuggestions();
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
  const projectInput = document.getElementById('po-project-input').value.trim();
  if (!projectInput) { toast('Project / Job Name is required'); document.getElementById('po-project-input').focus(); return; }
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
  const project = document.getElementById('po-project-input').value.trim() || document.getElementById('po-project').value.trim();
  if (!project) { toast('Project / Job Name is required'); document.getElementById('po-project-input').focus(); return; }
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
  el.innerHTML = deliveries.map(d => {
    const projTag = d.project ? `<span class="badge badge-blue" style="font-size:11px;margin-right:4px">${esc(d.project)}</span>` : '';
    const lineRows = (d.lines || []).map(l => {
      const done = l.status === 'ok';
      const partial = l.status === 'short';
      const missing = l.status === 'missing';
      const rowBg = done ? '#f9fdf5' : partial ? '#fffbf5' : missing ? '#fff8f8' : '';
      const statusColor = done ? '#27500A' : partial ? '#BA7517' : missing ? '#791F1F' : '#888';
      const statusLabel = done ? '✓ Received' : partial ? '~ Partial' : missing ? '✗ Missing' : l.status;
      return `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:4px;align-items:center;padding:7px 4px;border-bottom:1px solid #f5f5f5;font-size:13px;background:${rowBg}">
        <div>
          <div style="font-weight:500">${esc(l.description)}</div>
          ${l.part_number ? `<div style="font-size:11px;color:#888">${esc(l.part_number)}</div>` : ''}
        </div>
        <div style="text-align:center;font-weight:600;min-width:52px">${l.ordered}</div>
        <div style="text-align:center;font-weight:600;min-width:52px;color:${l.received>0?'#0F2D52':'#aaa'}">${l.received > 0 ? l.received : '—'}</div>
        <div style="text-align:center;font-weight:700;min-width:52px;color:${statusColor}">${statusLabel}</div>
      </div>`;
    }).join('');
    return `<div class="list-card">
      <div class="list-card-header">
        <div>
          <div class="list-card-title">${esc(d.po_number)} — ${esc(d.supplier)}</div>
          <div class="list-card-sub">${projTag}${d.delivery_date || '—'} · ${d.carrier || '—'} · DN: ${d.dn_ref || '—'}</div>
          <div class="list-card-sub">Received by: ${esc(d.received_by || '—')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button class="btn btn-ghost btn-sm" onclick="deleteDelivery('${d.id}')" style="color:#E24B4A;padding:4px 8px">🗑</button>
        </div>
      </div>
      <div style="margin-top:8px">
        <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#888;margin-bottom:4px;padding:0 4px">
          <span>Item</span><span style="text-align:center;min-width:52px">Ordered</span><span style="text-align:center;min-width:52px">Received</span><span style="text-align:center;min-width:52px">Status</span>
        </div>
        ${lineRows}
      </div>
    </div>`;
  }).join('');
}

// ── UNMATCHED ──────────────────────────────────────────
async function updateUnmatchedCount() {
  try {
    const items = await api('/api/unmatched');
    const badge = document.getElementById('unmatched-count');
    if (items.length > 0) {
      badge.textContent = items.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  } catch(e) {}
}

async function loadUnmatched() {
  const el = document.getElementById('unmatched-list');
  el.innerHTML = '<div class="processing-card"><div class="spinner"></div><span>Loading…</span></div>';
  const items = await api('/api/unmatched');
  updateUnmatchedCount();
  if (!items.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-text">No unmatched deliveries.<br>Everything has been linked to a PO.</div></div>';
    return;
  }
  const pos = await api('/api/pos');
  el.innerHTML = items.map(d => {
    const lines = d.lines || [];
    const lineRows = lines.map(l => `
      <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #f5f5f5;font-size:13px">
        <div><div style="font-weight:500">${esc(l.description)}</div>${l.part_number ? `<div style="font-size:11px;color:#888">${esc(l.part_number)}</div>` : ''}</div>
        <div style="font-weight:700;flex-shrink:0;margin-left:8px">Rcvd: ${l.received}</div>
      </div>`).join('');

    const poOptions = pos.filter(p => p.status !== 'complete')
      .map(p => `<option value="${p.id}">${esc(p.number)} — ${esc(p.supplier)}</option>`).join('');

    return `<div class="list-card" id="unmatched-${d.id}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">
        <div>
          <div style="font-weight:700;font-size:15px">📦 ${d.dn_ref ? 'DN: ' + esc(d.dn_ref) : 'Delivery note'}</div>
          <div style="font-size:12px;color:#888;margin-top:2px">${d.delivery_date || '—'} · ${d.carrier || '—'} · Received by: ${esc(d.received_by || '—')}</div>
          ${d.ai_summary ? `<div style="font-size:12px;color:#555;margin-top:4px;font-style:italic">${esc(d.ai_summary)}</div>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm" onclick="deleteUnmatched('${d.id}')" style="color:#E24B4A;flex-shrink:0">🗑</button>
      </div>

      <div style="background:#f8f8f8;border-radius:8px;padding:10px;margin-bottom:12px;max-height:200px;overflow-y:auto">
        ${lineRows || '<div style="color:#888;font-size:13px">No line items</div>'}
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:6px">Link to existing PO</div>
          <select id="link-po-${d.id}" style="width:100%;border:1.5px solid #e0e0e0;border-radius:8px;padding:8px 10px;font-size:13px;margin-bottom:6px">
            <option value="">— select PO —</option>
            ${poOptions}
          </select>
          <button class="btn btn-primary btn-full btn-sm" onclick="linkToPO('${d.id}')">🔗 Link to PO</button>
        </div>
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:6px">Create new PO from this</div>
          <input type="text" id="new-po-num-${d.id}" class="input" placeholder="PO number" style="margin-bottom:6px;font-size:13px;padding:8px 10px">
          <input type="text" id="new-po-sup-${d.id}" class="input" placeholder="Supplier" style="margin-bottom:6px;font-size:13px;padding:8px 10px">
          <input type="text" id="new-po-proj-${d.id}" class="input" placeholder="Project name" style="margin-bottom:6px;font-size:13px;padding:8px 10px">
          <button class="btn btn-orange btn-full btn-sm" onclick="createPOFromUnmatched('${d.id}', ${JSON.stringify(lines.map(l => ({description: l.description, part_number: l.part_number, quantity: l.received || 1})))})">✚ Create PO</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

async function linkToPO(deliveryId) {
  const poId = document.getElementById('link-po-' + deliveryId).value;
  if (!poId) { toast('Select a PO first'); return; }
  try {
    await api('/api/unmatched/' + deliveryId + '/link', 'POST', { po_id: poId });
    toast('Linked to PO ✓');
    loadUnmatched();
  } catch(e) { toast('Error: ' + e.message); }
}

async function createPOFromUnmatched(deliveryId, lines) {
  const number = document.getElementById('new-po-num-' + deliveryId).value.trim();
  const supplier = document.getElementById('new-po-sup-' + deliveryId).value.trim();
  const project = document.getElementById('new-po-proj-' + deliveryId).value.trim();
  if (!number || !supplier) { toast('PO number and supplier are required'); return; }
  try {
    await api('/api/unmatched/' + deliveryId + '/create-po', 'POST', { number, supplier, project, lines });
    toast('PO created and delivery linked ✓');
    loadUnmatched();
  } catch(e) { toast('Error: ' + e.message); }
}

async function deleteUnmatched(id) {
  if (!confirm('Delete this unmatched delivery? This cannot be undone.')) return;
  await api('/api/unmatched/' + id, 'DELETE');
  toast('Deleted');
  loadUnmatched();
}


async function deleteDelivery(id) {
  if (!confirm('Delete this delivery record? This cannot be undone.')) return;
  try {
    await api('/api/deliveries/' + id, 'DELETE');
    toast('Delivery deleted');
    loadHistory();
  } catch(e) { toast('Error: ' + e.message); }
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


// ══════════════════════════════════════════════
// RAISE PO
// ══════════════════════════════════════════════

let raisePOType = 'supplier';
let raiseSelectedFile = null;
let raiseLines = [];

function selectPOType(type) {
  raisePOType = type;
  document.getElementById('raise-type-supplier').style.border = type === 'supplier' ? '2px solid #0F2D52' : '';
  document.getElementById('raise-type-sub').style.border = type === 'subcontractor' ? '2px solid #0F2D52' : '';
  document.getElementById('raise-step1').style.display = 'none';

  if (type === 'subcontractor') {
    // Skip quote upload — go straight to form
    document.getElementById('raise-step3').style.display = 'block';
    document.getElementById('raise-processing').style.display = 'none';
    document.getElementById('raise-step2').style.display = 'none';
    document.getElementById('raise-supplier-only-fields').style.display = 'none';
    document.getElementById('raise-subcon-only-fields').style.display = 'block';
    document.getElementById('raise-lines-section').style.display = 'none';
    document.getElementById('raise-supplier-address-group').style.display = 'block';
    document.getElementById('raise-address-label').textContent = 'Company Address';
    document.getElementById('raise-issue-date').value = new Date().toISOString().slice(0,10);
    // Auto-generate PO number
    api('/api/next-po-number?supplierCode=SUB').then(r => {
      document.getElementById('raise-po-number').value = r.number;
    }).catch(() => {});
    loadProjectSuggestions();
    document.getElementById('raise-form').style.display = 'block';
  } else {
    document.getElementById('raise-step2').style.display = 'block';
  }
}

function raiseBack() {
  document.getElementById('raise-step1').style.display = 'block';
  document.getElementById('raise-step2').style.display = 'none';
}

function raiseBack2() {
  document.getElementById('raise-step3').style.display = 'none';
  if (raisePOType === 'subcontractor') {
    document.getElementById('raise-step1').style.display = 'block';
  } else {
    document.getElementById('raise-step2').style.display = 'block';
  }
}

function raiseFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  raiseSelectedFile = file;
  document.getElementById('raise-file-preview').style.display = 'flex';
  document.getElementById('raise-file-name').textContent = '✓ ' + file.name;
}

function raiseClearFile() {
  raiseSelectedFile = null;
  document.getElementById('raise-file-preview').style.display = 'none';
  document.getElementById('raise-camera').value = '';
  document.getElementById('raise-file').value = '';
}

async function extractQuote() {
  if (!raiseSelectedFile) { toast('Please select a file first'); return; }
  document.getElementById('raise-step2').style.display = 'none';
  document.getElementById('raise-step3').style.display = 'block';
  document.getElementById('raise-processing').style.display = 'block';
  document.getElementById('raise-form').style.display = 'none';

  try {
    const fd = new FormData();
    fd.append('file', raiseSelectedFile);
    const res = await fetch('/api/extract-quote', { method: 'POST', body: fd });
    const result = await res.json();

    // Populate form
    document.getElementById('raise-supplier').value = result.supplier || '';
    document.getElementById('raise-supplier-address').value = result.supplierAddress || '';
    document.getElementById('raise-quote-ref').value = result.quoteRef || '';
    document.getElementById('raise-total').value = result.total || '';
    document.getElementById('raise-scope').value = result.notes || '';
    document.getElementById('raise-issue-date').value = new Date().toISOString().slice(0,10);

    // Auto-generate PO number from supplier
    const supplierCode = (result.supplier || 'SUP').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0,6);
    const numRes = await api('/api/next-po-number?supplierCode=' + supplierCode);
    document.getElementById('raise-po-number').value = numRes.number;

    // Set up line items
    raiseLines = result.lines || [];
    renderRaiseLines();

    // Adjust form for type
    const isSupplier = raisePOType === 'supplier';
    document.getElementById('raise-supplier-only-fields').style.display = isSupplier ? 'block' : 'none';
    document.getElementById('raise-subcon-only-fields').style.display = isSupplier ? 'none' : 'block';
    document.getElementById('raise-lines-section').style.display = isSupplier ? 'block' : 'none';
    document.getElementById('raise-supplier-address-group').style.display = 'block';
    document.getElementById('raise-address-label').textContent = isSupplier ? 'Supplier Address' : 'Company Address';

    // Load project suggestions
    await loadProjectSuggestions();

    document.getElementById('raise-processing').style.display = 'none';
    document.getElementById('raise-form').style.display = 'block';
  } catch(e) {
    toast('Error: ' + e.message);
    document.getElementById('raise-step3').style.display = 'none';
    document.getElementById('raise-step2').style.display = 'block';
  }
}

function renderRaiseLines() {
  const el = document.getElementById('raise-lines-list');
  if (!raiseLines.length) { el.innerHTML = '<div style="color:#aaa;font-size:13px;margin-bottom:8px">No lines extracted — add manually</div>'; return; }
  el.innerHTML = raiseLines.map((l, i) => `
    <div style="display:grid;grid-template-columns:2fr 1fr 0.7fr 1fr 1fr auto;gap:6px;align-items:center;margin-bottom:6px;font-size:13px">
      <input class="input" style="font-size:12px;padding:6px" value="${esc(l.description)}" oninput="raiseLines[${i}].description=this.value" placeholder="Description">
      <input class="input" style="font-size:12px;padding:6px" value="${esc(l.partNumber||'')}" oninput="raiseLines[${i}].partNumber=this.value" placeholder="Part No.">
      <input class="input" style="font-size:12px;padding:6px" value="${l.quantity||1}" oninput="raiseLines[${i}].quantity=this.value" placeholder="Qty" type="number">
      <input class="input" style="font-size:12px;padding:6px" value="${l.unitPrice||''}" oninput="raiseLines[${i}].unitPrice=this.value" placeholder="Unit £">
      <input class="input" style="font-size:12px;padding:6px" value="${l.total||''}" oninput="raiseLines[${i}].total=this.value" placeholder="Total £">
      <button class="btn-clear" onclick="raiseRemoveLine(${i})">✕</button>
    </div>`).join('');
}

function raiseAddLine() {
  raiseLines.push({ description: '', partNumber: '', quantity: 1, unitPrice: '', total: '' });
  renderRaiseLines();
}

function raiseRemoveLine(i) {
  raiseLines.splice(i, 1);
  renderRaiseLines();
}

async function generatePO() {
  const poNumber = document.getElementById('raise-po-number').value.trim();
  const supplier = document.getElementById('raise-supplier').value.trim();
  const project = document.getElementById('raise-project').value.trim();
  const issueDate = document.getElementById('raise-issue-date').value;
  if (!poNumber || !supplier) { toast('PO number and supplier are required'); return; }
  if (!project) { toast('Project reference is required'); document.getElementById('raise-project').focus(); return; }

  const isSupplier = raisePOType === 'supplier';
  const payload = {
    poType: raisePOType,
    poNumber,
    supplier,
    supplierAddress: document.getElementById('raise-supplier-address').value,
    project,
    issueDate,
    scope: document.getElementById('raise-scope').value,
    lines: isSupplier ? raiseLines : [],
    // Supplier fields
    deliveryAddress: isSupplier ? document.getElementById('raise-delivery-address').value : '',
    quoteRef: isSupplier ? document.getElementById('raise-quote-ref').value : '',
    total: isSupplier ? document.getElementById('raise-total').value : '',
    contractPerson: isSupplier ? document.getElementById('raise-contract-person').value : '',
    // Subcontractor fields
    contractorName: !isSupplier ? document.getElementById('raise-contractor-name').value : '',
    location: !isSupplier ? document.getElementById('raise-location').value : '',
    startDate: !isSupplier ? document.getElementById('raise-start-date').value : '',
    endDate: !isSupplier ? document.getElementById('raise-end-date').value : '',
    hourlyRate: !isSupplier ? document.getElementById('raise-hourly-rate').value : '',
    totalHours: !isSupplier ? document.getElementById('raise-total-hours').value : '',
  };

  try {
    const res = await fetch('/api/raise-po', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = poNumber + '.pdf';
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('PO generated and added to tracking!');
    loadIssuedPOs();
    // Reset form
    document.getElementById('raise-step3').style.display = 'none';
    document.getElementById('raise-step1').style.display = 'block';
    raiseLines = []; raiseSelectedFile = null;
  } catch(e) { toast('Error: ' + e.message); }
}

function showRaiseProjectDropdown() {
  const dd = document.getElementById('raise-project-dropdown');
  if (dd && allProjectNames.length) {
    renderRaiseProjectDropdown(allProjectNames);
  }
}

function renderRaiseProjectDropdown(names) {
  const dd = document.getElementById('raise-project-dropdown');
  if (!dd) return;
  if (!names.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = names.map(n =>
    `<div data-name="${esc(n)}" style="padding:10px 14px;font-size:14px;cursor:pointer;border-bottom:0.5px solid #f0f0f0;color:#1a1a1a"
      onmouseover="this.style.background='#EAF3DE'" onmouseout="this.style.background=''">${esc(n)}</div>`
  ).join('');
  dd.onclick = function(e) {
    const item = e.target.closest('[data-name]');
    if (item) { document.getElementById('raise-project').value = item.getAttribute('data-name'); dd.style.display = 'none'; }
  };
  dd.style.display = 'block';
}

let issuedPOsExpanded = false;

function toggleIssuedPOs() {
  issuedPOsExpanded = !issuedPOsExpanded;
  const el = document.getElementById('issued-pos-list');
  const chevron = document.getElementById('issued-pos-chevron');
  el.style.display = issuedPOsExpanded ? 'block' : 'none';
  chevron.style.transform = issuedPOsExpanded ? 'rotate(180deg)' : '';
}

async function loadIssuedPOs() {
  try {
    const pos = await api('/api/issued-pos');
    const countEl = document.getElementById('issued-pos-count');
    if (countEl) countEl.textContent = pos.length ? `(${pos.length})` : '';
    const el = document.getElementById('issued-pos-list');
    if (!pos.length) { el.innerHTML = '<div style="color:#aaa;font-size:13px">None yet</div>'; return; }
    el.innerHTML = pos.map(p => `
      <div class="list-card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-weight:600;font-size:14px">${esc(p.po_number)}</div>
            <div style="font-size:12px;color:#888;margin-top:2px">
              ${p.supplier} · ${p.project || '—'} · ${p.issue_date || '—'}
            </div>
          </div>
          <span class="badge badge-ok" style="font-size:11px">${p.po_type === 'subcontractor' ? 'Sub-Con' : 'Supplier'}</span>
        </div>
      </div>`).join('');
  } catch(e) {}
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
