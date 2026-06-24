require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Uploads dir
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + '-' + file.originalname.replace(/\s/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(session({
  secret: process.env.SESSION_SECRET || 'duke-goods-in-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── AUTH ───────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { name, pin } = req.body;
  console.log('Login attempt:', name, pin);
  const allUsers = db.prepare('SELECT name, pin FROM users').all();
  console.log('All users in DB:', JSON.stringify(allUsers));
  const user = db.prepare('SELECT * FROM users WHERE LOWER(name)=LOWER(?) AND pin=? LIMIT 1').get(name, pin);
  console.log('Found user:', user ? user.name : 'none');
  if (!user) return res.status(401).json({ error: 'Invalid name or PIN' });
  req.session.user = { id: user.id, name: user.name, role: user.role };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.status(401).json({ error: 'Not logged in' });
});

// ─── PURCHASE ORDERS ────────────────────────────────────
app.get('/api/pos', requireAuth, (req, res) => {
  const pos = db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all();
  pos.forEach(po => {
    po.lines = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po.id);
  });
  res.json(pos);
});

app.post('/api/pos', requireAuth, (req, res) => {
  const { number, supplier, project, expected_date, lines } = req.body;
  if (!number || !supplier) return res.status(400).json({ error: 'Number and supplier required' });
  const id = uid();
  db.prepare('INSERT INTO purchase_orders (id, number, supplier, project, expected_date, created_by) VALUES (?,?,?,?,?,?)')
    .run(id, number, supplier, project || '', expected_date || '', req.session.user.name);
  const insertLine = db.prepare('INSERT INTO po_lines (id, po_id, description, part_number, quantity, unit, delivery_date) VALUES (?,?,?,?,?,?,?)');
  (lines || []).forEach(l => insertLine.run(uid(), id, l.description || l.desc, l.part_number || l.partno || '', l.quantity || l.qty || 1, l.unit || '', l.delivery_date || l.deliveryDate || ''));
  res.json({ ok: true, id });
});

app.delete('/api/pos/:id', requireAuth, (req, res) => {
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM po_lines WHERE po_id=?').run(req.params.id);
    db.prepare('UPDATE deliveries SET po_id=NULL WHERE po_id=?').run(req.params.id);
    db.prepare('DELETE FROM purchase_orders WHERE id=?').run(req.params.id);
    db.pragma('foreign_keys = ON');
    res.json({ ok: true });
  } catch(e) {
    console.error('delete PO error:', e);
    res.status(500).json({ error: 'Delete failed: ' + e.message });
  }
});

// ─── PROJECT NAMES ──────────────────────────────────────
app.get('/api/project-names', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT DISTINCT project FROM purchase_orders WHERE project != '' AND project IS NOT NULL ORDER BY project ASC").all();
  res.json(rows.map(r => r.project));
});

// ─── AI EXTRACT PO ──────────────────────────────────────
app.post('/api/extract-po', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

    const sys = `Extract purchase order details and return ONLY valid JSON, no markdown.
{"number":"","supplier":"","project":"","expected_date":"YYYY-MM-DD or empty","lines":[{"description":"","part_number":"","quantity":1,"unit":"","delivery_date":"YYYY-MM-DD or empty"}]}
For project: extract any project name, job number or reference. Return empty string if none found.`;

    let userContent;
    if (req.file) {
      const fileData = fs.readFileSync(req.file.path);
      const b64 = fileData.toString('base64');
      const mime = req.file.mimetype;
      const type = mime === 'application/pdf' ? 'document' : 'image';
      const src = mime === 'application/pdf'
        ? { type: 'base64', media_type: 'application/pdf', data: b64 }
        : { type: 'base64', media_type: mime, data: b64 };
      userContent = [{ type, source: src }, { type: 'text', text: 'Extract all purchase order details from this document.' }];
      fs.unlinkSync(req.file.path);
    } else {
      userContent = req.body.text || '';
      if (!userContent) return res.status(400).json({ error: 'No file or text provided' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16000, system: sys, messages: [{ role: 'user', content: userContent }] })
    });
    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    console.log('extract-po raw:', text.slice(0, 300));
    const js = text.indexOf('{'); const je = text.lastIndexOf('}');
    if (js === -1 || je === -1) throw new Error('No JSON in response: ' + text.slice(0, 200));
    const parsed = JSON.parse(text.slice(js, je + 1));
    res.json(parsed);
  } catch (e) {
    console.error('extract-po error:', e);
    res.status(500).json({ error: 'AI extraction failed: ' + e.message });
  }
});

// ─── AI MATCH DELIVERY NOTE ─────────────────────────────
app.post('/api/match-delivery', requireAuth, upload.array('file', 10), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

    const openPOs = db.prepare("SELECT * FROM purchase_orders WHERE status != 'complete'").all();
    openPOs.forEach(po => { po.lines = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po.id); });
    if (!openPOs.length) {
      return res.json({
        matchedPOId: '', confidence: 'low',
        matchReason: 'No open purchase orders on file',
        dnNumber: '', carrier: '', deliveryDate: '',
        lines: [], unmatchedDelivered: [],
        summary: 'No POs to match against — saved as unmatched',
        imagePath: null
      });
    }

    const poIndex = JSON.stringify(openPOs.map(p => ({
      id: p.id, number: p.number, supplier: p.supplier, project: p.project,
      lines: p.lines.map(l => ({ id: l.id, desc: l.description, partno: l.part_number, qty: l.quantity }))
    })));

    const sys = `You are a goods-in assistant for Duke Control Systems, an industrial automation company.
Given a delivery note and open purchase orders, identify which PO this delivery belongs to and match every line.
Return ONLY valid JSON — no markdown, no explanation.
{
  "matchedPOId": "id or empty string",
  "confidence": "high|medium|low",
  "matchReason": "one sentence",
  "dnNumber": "or empty",
  "carrier": "or empty",
  "deliveryDate": "YYYY-MM-DD or empty",
  "lines": [{"poLineId":"","desc":"","partno":"","ordered":0,"received":0,"status":"ok|short|missing","note":""}],
  "unmatchedDelivered": [{"desc":"","partno":"","received":0,"note":""}],
  "summary": "one sentence summary"
}
Rules: match part number first then description; ok=received>=ordered; short=0<received<ordered; missing=received=0; poLineId must exactly match a line id from PO data.`;

    let userContent;
    let imagePath = null;
    const files = req.files || [];

    if (files.length > 0) {
      const fileBlocks = files.map(f => {
        const fileData = fs.readFileSync(f.path);
        const b64 = fileData.toString('base64');
        const mime = f.mimetype;
        const type = mime === 'application/pdf' ? 'document' : 'image';
        const src = mime === 'application/pdf'
          ? { type: 'base64', media_type: 'application/pdf', data: b64 }
          : { type: 'base64', media_type: mime, data: b64 };
        return { type, source: src };
      });
      imagePath = files.map(f => f.filename).join(',');
      userContent = [
        ...fileBlocks,
        { type: 'text', text: `Open purchase orders:\n${poIndex}\n\nThe above ${files.length > 1 ? files.length + ' images/pages are all part of the same delivery note' : 'document is a delivery note'}. Identify which PO it belongs to and match all items.` }
      ];
      files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
    } else {
      const text = req.body.text || '';
      if (!text) return res.status(400).json({ error: 'No file or text provided' });
      userContent = `Open purchase orders:\n${poIndex}\n\nDelivery note:\n${text}`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 16000, system: sys, messages: [{ role: 'user', content: userContent }] })
    });
    const data = await response.json();
    const text2 = data.content?.find(b => b.type === 'text')?.text || '';
    console.log('match-delivery raw:', text2.slice(0, 300));
    const jsonStart = text2.indexOf('{');
    const jsonEnd = text2.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON in response: ' + text2.slice(0, 200));
    const result = JSON.parse(text2.slice(jsonStart, jsonEnd + 1));
    result.imagePath = imagePath;
    res.json(result);
  } catch (e) {
    console.error('match-delivery error:', e);
    res.status(500).json({ error: 'AI matching failed: ' + e.message });
  }
});

// ─── DELIVERIES ─────────────────────────────────────────
app.post('/api/deliveries', requireAuth, (req, res) => {
  try {
    const { po_id, po_number, supplier, project, delivery_date, carrier, dn_ref, status, lines, unmatched, image_path, ai_summary } = req.body;

    // Duplicate check — if DN ref provided, check it hasn't been saved before
    if (dn_ref && dn_ref.trim()) {
      const existing = db.prepare("SELECT id FROM deliveries WHERE dn_ref=? AND status='complete'").get(dn_ref.trim());
      if (existing) {
        return res.status(409).json({ error: `Duplicate delivery note: DN reference "${dn_ref}" has already been recorded. If this is a different delivery, clear the DN number field and try again.` });
      }
    }

    const id = uid();
    db.prepare('INSERT INTO deliveries (id, po_id, po_number, supplier, project, delivery_date, carrier, dn_ref, status, received_by, image_path, ai_summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, po_id || null, po_number || '', supplier || '', project || '', delivery_date || '', carrier || '', dn_ref || '', status || 'complete', req.session.user.name, image_path || '', ai_summary || '');

    db.pragma('foreign_keys = OFF');
    const insertLine = db.prepare('INSERT INTO delivery_lines (id, delivery_id, po_line_id, description, part_number, ordered, received, status, note, is_unexpected) VALUES (?,?,?,?,?,?,?,?,?,?)');
    (lines || []).forEach(l => {
      const desc = l.desc || l.description || '';
      const partno = l.partno || l.part_number || '';
      if (desc) insertLine.run(uid(), id, l.poLineId || '', desc, partno, l.ordered || 0, l.received || 0, l.status || '', l.note || '', 0);
    });
    (unmatched || []).forEach(l => {
      const desc = l.desc || l.description || '';
      const partno = l.partno || l.part_number || '';
      if (desc) insertLine.run(uid(), id, '', desc, partno, 0, l.received || 0, 'unexpected', l.note || '', 1);
    });
    db.pragma('foreign_keys = ON');

    // Check if PO is fully received by comparing cumulative received vs PO ordered quantities
    if (po_id) {
      const poLines = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po_id);
      if (poLines.length > 0) {
        const allComplete = poLines.every(pol => {
          // Sum received quantities across all complete deliveries for this PO line
          const result = db.prepare(`
            SELECT COALESCE(SUM(dl.received), 0) as total_received
            FROM delivery_lines dl
            JOIN deliveries d ON dl.delivery_id = d.id
            WHERE d.po_id = ? AND d.status = 'complete'
            AND (dl.po_line_id = ? OR dl.description = ?)
          `).get(po_id, pol.id, pol.description);
          return result.total_received >= pol.quantity;
        });
        if (allComplete) {
          db.prepare("UPDATE purchase_orders SET status='complete' WHERE id=?").run(po_id);
        } else {
          db.prepare("UPDATE purchase_orders SET status='open' WHERE id=?").run(po_id);
        }
      }
    }
    res.json({ ok: true, id });
  } catch(e) {
    console.error('deliveries POST error:', e);
    res.status(500).json({ error: 'Failed to save delivery: ' + e.message });
  }
});

app.get('/api/deliveries', requireAuth, (req, res) => {
  const deliveries = db.prepare("SELECT * FROM deliveries WHERE status='complete' ORDER BY created_at DESC").all();
  deliveries.forEach(d => { d.lines = db.prepare('SELECT * FROM delivery_lines WHERE delivery_id=?').all(d.id); });
  res.json(deliveries);
});

app.delete('/api/deliveries/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM delivery_lines WHERE delivery_id=?').run(req.params.id);
    db.prepare('DELETE FROM deliveries WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('delete delivery error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PROJECTS ───────────────────────────────────────────
app.get('/api/projects', requireAuth, (req, res) => {
  const pos = db.prepare('SELECT * FROM purchase_orders').all();
  pos.forEach(po => {
    po.lines = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po.id);
    po.deliveries = db.prepare("SELECT * FROM deliveries WHERE po_id=? AND status='complete'").all(po.id);
    po.deliveries.forEach(d => { d.lines = db.prepare('SELECT * FROM delivery_lines WHERE delivery_id=?').all(d.id); });
  });
  const map = {};
  pos.forEach(po => {
    const proj = (po.project && po.project.trim()) || 'Unassigned';
    if (!map[proj]) map[proj] = { name: proj, pos: [] };
    map[proj].pos.push(po);
  });
  res.json(Object.values(map).sort((a, b) => a.name.localeCompare(b.name)));
});

// ─── USERS (admin) ──────────────────────────────────────
app.get('/api/users', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  res.json(db.prepare('SELECT id, name, role, created_at FROM users').all());
});

app.post('/api/users', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { name, pin, role } = req.body;
  db.prepare('INSERT INTO users (name, pin, role) VALUES (?,?,?)').run(name, pin || '0000', role || 'staff');
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});


// ─── UNMATCHED DELIVERIES ────────────────────────────────
app.get('/api/unmatched', requireAuth, (req, res) => {
  const deliveries = db.prepare("SELECT * FROM deliveries WHERE status='unmatched' ORDER BY created_at DESC").all();
  deliveries.forEach(d => { d.lines = db.prepare('SELECT * FROM delivery_lines WHERE delivery_id=?').all(d.id); });
  res.json(deliveries);
});

// Link unmatched delivery to a PO
app.post('/api/unmatched/:id/link', requireAuth, (req, res) => {
  const { po_id } = req.body;
  if (!po_id) return res.status(400).json({ error: 'po_id required' });
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(po_id);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  db.prepare("UPDATE deliveries SET status='complete', po_id=?, po_number=?, supplier=?, project=? WHERE id=?")
    .run(po_id, po.number, po.supplier, po.project, req.params.id);
  res.json({ ok: true });
});

// Create PO from unmatched delivery
app.post('/api/unmatched/:id/create-po', requireAuth, (req, res) => {
  const { number, supplier, project, expected_date, lines } = req.body;
  if (!number || !supplier) return res.status(400).json({ error: 'Number and supplier required' });
  const poId = uid();
  db.prepare('INSERT INTO purchase_orders (id, number, supplier, project, expected_date, created_by) VALUES (?,?,?,?,?,?)')
    .run(poId, number, supplier, project || '', expected_date || '', req.session.user.name);
  const insertLine = db.prepare('INSERT INTO po_lines (id, po_id, description, part_number, quantity, unit, delivery_date) VALUES (?,?,?,?,?,?,?)');
  (lines || []).forEach(l => insertLine.run(uid(), poId, l.description || '', l.part_number || '', l.quantity || 1, l.unit || '', ''));
  // Link the delivery to the new PO and mark complete
  db.prepare("UPDATE deliveries SET status='complete', po_id=?, po_number=?, supplier=?, project=? WHERE id=?")
    .run(poId, number, supplier, project || '', req.params.id);
  res.json({ ok: true, po_id: poId });
});

// Delete unmatched delivery
app.delete('/api/unmatched/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM delivery_lines WHERE delivery_id=?').run(req.params.id);
  db.prepare('DELETE FROM deliveries WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── SERVE APP ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Duke Goods-In running on port ${PORT}`));
