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
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/\s/g, '_'))
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
  const user = db.prepare('SELECT * FROM users WHERE LOWER(name)=LOWER(?) AND pin=?').get(name, pin);
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
  db.prepare('DELETE FROM po_lines WHERE po_id=?').run(req.params.id);
  db.prepare('DELETE FROM purchase_orders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
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
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 2000, system: sys, messages: [{ role: 'user', content: userContent }] })
    });
    const data = await response.json();
    const text = data.content?.find(b => b.type === 'text')?.text || '';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch (e) {
    console.error('extract-po error:', e);
    res.status(500).json({ error: 'AI extraction failed: ' + e.message });
  }
});

// ─── AI MATCH DELIVERY NOTE ─────────────────────────────
app.post('/api/match-delivery', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });

    const openPOs = db.prepare("SELECT * FROM purchase_orders WHERE status != 'complete'").all();
    openPOs.forEach(po => { po.lines = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po.id); });
    if (!openPOs.length) return res.status(400).json({ error: 'No open purchase orders on file' });

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

    if (req.file) {
      const fileData = fs.readFileSync(req.file.path);
      const b64 = fileData.toString('base64');
      const mime = req.file.mimetype;
      imagePath = req.file.filename;
      const type = mime === 'application/pdf' ? 'document' : 'image';
      const src = mime === 'application/pdf'
        ? { type: 'base64', media_type: 'application/pdf', data: b64 }
        : { type: 'base64', media_type: mime, data: b64 };
      userContent = [
        { type, source: src },
        { type: 'text', text: `Open purchase orders:\n${poIndex}\n\nIdentify which PO this delivery note belongs to and match all items.` }
      ];
    } else {
      const text = req.body.text || '';
      if (!text) return res.status(400).json({ error: 'No file or text provided' });
      userContent = `Open purchase orders:\n${poIndex}\n\nDelivery note:\n${text}`;
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 4000, system: sys, messages: [{ role: 'user', content: userContent }] })
    });
    const data = await response.json();
    const text2 = data.content?.find(b => b.type === 'text')?.text || '';
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
  const { po_id, po_number, supplier, project, delivery_date, carrier, dn_ref, status, lines, unmatched, image_path, ai_summary } = req.body;
  const id = uid();
  db.prepare('INSERT INTO deliveries (id, po_id, po_number, supplier, project, delivery_date, carrier, dn_ref, status, received_by, image_path, ai_summary) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, po_id || '', po_number || '', supplier || '', project || '', delivery_date || '', carrier || '', dn_ref || '', status || 'complete', req.session.user.name, image_path || '', ai_summary || '');

  const insertLine = db.prepare('INSERT INTO delivery_lines (id, delivery_id, po_line_id, description, part_number, ordered, received, status, note, is_unexpected) VALUES (?,?,?,?,?,?,?,?,?,?)');
  (lines || []).forEach(l => insertLine.run(uid(), id, l.poLineId || '', l.desc || '', l.partno || '', l.ordered || 0, l.received || 0, l.status || '', l.note || '', 0));
  (unmatched || []).forEach(l => insertLine.run(uid(), id, '', l.desc || '', l.partno || '', 0, l.received || 0, 'unexpected', l.note || '', 1));

  // Mark PO complete if all lines received
  if (po_id && (lines || []).every(l => l.status === 'ok')) {
    db.prepare("UPDATE purchase_orders SET status='complete' WHERE id=?").run(po_id);
  }
  res.json({ ok: true, id });
});

app.get('/api/deliveries', requireAuth, (req, res) => {
  const deliveries = db.prepare("SELECT * FROM deliveries WHERE status='complete' ORDER BY created_at DESC").all();
  deliveries.forEach(d => { d.lines = db.prepare('SELECT * FROM delivery_lines WHERE delivery_id=?').all(d.id); });
  res.json(deliveries);
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

// ─── SERVE APP ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Duke Goods-In running on port ${PORT}`));
