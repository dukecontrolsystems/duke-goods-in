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
app.post('/api/match-delivery', requireAuth, upload.array('file', 50), async (req, res) => {
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

// ─── RAISE PO ───────────────────────────────────────────

// Extract quote details using AI
app.post('/api/extract-quote', requireAuth, upload.array('file', 10), async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const files = req.files || [];
    let userContent;

    if (files.length > 0) {
      const fileBlocks = files.map(f => {
        const b64 = fs.readFileSync(f.path).toString('base64');
        const mime = f.mimetype;
        const type = mime === 'application/pdf' ? 'document' : 'image';
        const src = mime === 'application/pdf'
          ? { type: 'base64', media_type: 'application/pdf', data: b64 }
          : { type: 'base64', media_type: mime, data: b64 };
        return { type, source: src };
      });
      files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
      userContent = [
        ...fileBlocks,
        { type: 'text', text: `Extract all details from this quotation/quote document. Return ONLY valid JSON with these fields:
{
  "supplier": "supplier company name",
  "supplierAddress": "full supplier address if shown",
  "quoteRef": "quote or reference number",
  "date": "quote date",
  "total": "total price inc VAT if shown",
  "totalExVat": "total ex VAT if shown",
  "vatAmount": "VAT amount if shown",
  "lines": [
    {
      "description": "item description",
      "partNumber": "part/product number if shown",
      "quantity": 1,
      "unit": "each/pack/m etc",
      "unitPrice": 0.00,
      "total": 0.00
    }
  ],
  "deliveryCharge": 0.00,
  "notes": "brief scope description only - do NOT include supplier payment terms, incoterms, VAT info or legal boilerplate"
}` }
      ];
    } else {
      return res.status(400).json({ error: 'No file provided' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: userContent }] })
    });
    const data = await response.json();
    const text = data.content.map(b => b.text || '').join('');
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    const result = JSON.parse(text.slice(start, end + 1));
    res.json(result);
  } catch(e) {
    console.error('extract-quote error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get next PO number for a supplier code
app.get('/api/next-po-number', requireAuth, (req, res) => {
  const { supplierCode } = req.query;
  if (!supplierCode) return res.status(400).json({ error: 'supplierCode required' });
  const prefix = `PO-DCS-${supplierCode.toUpperCase()}-`;
  const existing = db.prepare("SELECT po_number FROM issued_pos WHERE po_number LIKE ? ORDER BY po_number DESC").all(prefix + '%');
  let nextNum = 1;
  if (existing.length > 0) {
    const last = existing[0].po_number;
    const lastNum = parseInt(last.split('-').pop());
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }
  const number = prefix + String(nextNum).padStart(3, '0');
  res.json({ number });
});

// Helper: format date as "7th July 2026"
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  const day = d.getDate();
  const suffix = ['th','st','nd','rd'][(day % 10 > 3 || Math.floor(day / 10) === 1) ? 0 : day % 10] || 'th';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${day}${suffix} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Generate PO PDF and save to tracking
app.post('/api/raise-po', requireAuth, async (req, res) => {
  try {
    const PDFDocument = require('pdfkit');
    const { poType, poNumber, supplier, supplierAddress, project, deliveryAddress,
            quoteRef, total, contractPerson, scope, lines, issueDate,
            contractorName, startDate, endDate, totalHours, hourlyRate, location } = req.body;

    const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 50, right: 50 }, bufferPages: true, autoFirstPage: true });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    const pageW = 595, left = 50, right = 545, contentW = 495;

    // ── HEADER ──
    const logoPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, left, 30, { width: 130 });
    }

    // Top right label
    const typeLabel = poType === 'subcontractor' ? 'Sub-Contractor' : 'Supplier';
    doc.fontSize(10).fillColor('#E8622A').font('Helvetica-Bold')
      .text(typeLabel, 350, 32, { width: 195, align: 'right' });
    doc.fontSize(10).fillColor('#0F2D52').font('Helvetica-Bold')
      .text('Purchase Order', 350, 46, { width: 195, align: 'right' });
    doc.fontSize(8).fillColor('#555').font('Helvetica')
      .text(`${poNumber} | Issue 1.0`, 350, 60, { width: 195, align: 'right' });

    // Orange divider line
    doc.moveTo(left, 80).lineTo(right, 80).strokeColor('#E8622A').lineWidth(1.5).stroke();

    // ── TITLE ──
    doc.fontSize(13).fillColor('#0F2D52').font('Helvetica-Bold')
      .text(`PURCHASE ORDER (PO) \u2013 [${poNumber}]`, left, 92, { width: contentW, align: 'center' });

    // Company sub-title
    doc.fontSize(8).fillColor('#444').font('Helvetica-Oblique')
      .text('Manageverse Consultancy Limited T/A Duke Control Systems', left, 112, { width: contentW, align: 'center' })
      .text('Duke Control Systems is a trading name of Manageverse Consultancy Limited registered in England &', { width: contentW, align: 'center' })
      .text('Wales 14804396. Registered Office: 2 Fournier House, 8 Tenby Street, Birmingham, B1 3AJ.', { width: contentW, align: 'center' });

    // ── DETAILS TABLE ──
    const tableTop = 148;
    const col1W = 155, rowH = 26;

    const rows = poType === 'subcontractor'
      ? [
          ['Work Order Number:', poNumber],
          ['Date of Issue:', formatDate(issueDate)],
          ['Contractor:', `${supplier}${supplierAddress ? '\n' + supplierAddress : ''}`],
          ['Contractor Personnel:', contractorName || ''],
          ['Project Reference:', project || ''],
          ['Location:', location || ''],
          ['Start Date:', formatDate(startDate)],
          ['End Date:', endDate || ''],
          ['Day Rate / Fee:', hourlyRate ? `£${hourlyRate} GBP p/hr` : ''],
          ['Total Hours:', totalHours || ''],
        ]
      : [
          ['Work Order Number:', poNumber],
          ['Date of Issue:', formatDate(issueDate)],
          ['Supplier:', supplier],
          ['Project Reference:', project || ''],
          ['Delivery Address:', deliveryAddress || ''],
          ['Quote Reference:', quoteRef || ''],
          ['Order Total (Inc VAT):', total ? (total.startsWith('£') ? total : `£${total}`) : ''],
          ['Contract Person:', contractPerson || ''],
        ];

    rows.forEach((row, i) => {
      const y = tableTop + i * rowH;
      const val = row[1] || '\u2014';
      const lineCount = val.split('\n').length;
      const rH = Math.max(rowH, lineCount * 14 + 8);

      doc.rect(left, y, contentW, rH).fillColor(i % 2 === 0 ? '#f7f7f7' : '#ffffff').fill();
      doc.rect(left, y, contentW, rH).strokeColor('#dddddd').lineWidth(0.4).stroke();
      doc.fontSize(9).fillColor('#0F2D52').font('Helvetica-Bold')
        .text(row[0], left + 6, y + 7, { width: col1W - 6 });
      doc.fontSize(9).fillColor('#333').font('Helvetica')
        .text(val, left + col1W, y + 7, { width: contentW - col1W - 6 });
    });

    const afterTable = tableTop + rows.length * rowH + 14;
    doc.y = afterTable;

    // ── SCOPE ──
    doc.fontSize(9).fillColor('#0F2D52').font('Helvetica-Bold').text('Scope of Services:', left, doc.y);
    doc.moveDown(0.3);

    if (lines && lines.length > 0 && poType !== 'subcontractor') {
      const lh = 18, lTop = doc.y;
      const cols = [left, left+175, left+265, left+310, left+380, right];
      const headers = ['Description', 'Part No.', 'Qty', 'Unit Price', 'Total'];
      doc.rect(left, lTop, contentW, lh).fillColor('#0F2D52').fill();
      headers.forEach((h, i) => {
        doc.fontSize(8).fillColor('#ffffff').font('Helvetica-Bold')
          .text(h, cols[i] + 3, lTop + 5, { width: cols[i+1] - cols[i] - 6 });
      });
      lines.forEach((l, i) => {
        const y = lTop + lh + i * lh;
        doc.rect(left, y, contentW, lh).fillColor(i % 2 === 0 ? '#f7f7f7' : '#fff').fill();
        doc.rect(left, y, contentW, lh).strokeColor('#ddd').lineWidth(0.3).stroke();
        const vals = [l.description||'', l.partNumber||'', String(l.quantity||''),
          l.unitPrice ? `\u00a3${Number(l.unitPrice).toFixed(2)}` : '',
          l.total ? `\u00a3${Number(l.total).toFixed(2)}` : ''];
        vals.forEach((v, j) => {
          doc.fontSize(8).fillColor('#333').font('Helvetica')
            .text(v, cols[j] + 3, y + 5, { width: cols[j+1] - cols[j] - 6 });
        });
      });
      doc.y = lTop + lh + lines.length * lh + 8;
    }

    // Scope text — only use our own scope, not supplier terms
    const scopeText = scope || (poType === 'subcontractor'
      ? `Providing ${contractorName || 'contractor'} services as described above.`
      : `Supply of Parts as per quotation ${quoteRef || ''}.`);
    doc.fontSize(9).fillColor('#333').font('Helvetica').text(scopeText, left, doc.y, { width: contentW });

    // ── CONFIDENTIALITY BOX (subcontractor only) ──
    if (poType === 'subcontractor') {
      doc.moveDown(1);
      const bY = doc.y, bH = 32;
      doc.rect(left, bY, contentW, bH).fillColor('#FFF4E5').fill();
      doc.rect(left, bY, contentW, bH).strokeColor('#E8622A').lineWidth(0.8).stroke();
      doc.fontSize(8.5).fillColor('#E8622A').font('Helvetica-Bold')
        .text('CONFIDENTIALITY REMINDER: ', left + 6, bY + 10, { continued: true });
      doc.fillColor('#333').font('Helvetica')
        .text('This purchase order is raised in accordance with dukes subcontractor Confidentiality & Customer Protection Agreement.');
    }

    // ── FOOTER ── written after buffering so it always goes on page 1
    doc.end();
    await new Promise(resolve => doc.on('end', resolve));

    // Write footer on first page only using buffered pages
    const range = doc.bufferedPageRange();
    doc.switchToPage(0);
    doc.fontSize(7.5).fillColor('#999').font('Helvetica')
      .text('www.dukecontrolsystems.com  |  Confidential - Property of Duke Control Systems', left, 778, { width: contentW - 60, align: 'left', lineBreak: false });
    doc.fontSize(7.5).fillColor('#999').font('Helvetica')
      .text('Content is property of Duke Control Systems. Paper copies are uncontrolled.', left, 788, { width: contentW - 60, align: 'left', lineBreak: false });
    doc.fontSize(7.5).fillColor('#999').font('Helvetica')
      .text('Page 1 of 1', left, 783, { width: contentW, align: 'right', lineBreak: false });

    doc.flushPages();
    const pdfBuffer = Buffer.concat(chunks);

    // Save to issued_pos
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    db.prepare(`INSERT INTO issued_pos (id, po_number, po_type, supplier, project, quote_ref, total, delivery_address, contract_person, scope, lines, issue_date, issued_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, poNumber, poType, supplier, project || '', quoteRef || '', total || '', deliveryAddress || '', contractPerson || contractorName || '', scope || '', JSON.stringify(lines || []), issueDate, req.session.user.name);

    // Add to goods-in purchase_orders tracking
    const poId = Date.now().toString(36) + Math.random().toString(36).slice(2) + 'g';
    const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
    db.prepare('INSERT INTO purchase_orders (id, number, supplier, project, status, created_by) VALUES (?,?,?,?,?,?)')
      .run(poId, poNumber, supplier, project || '', 'open', req.session.user.name);
    if (lines && lines.length > 0) {
      const insertLine = db.prepare('INSERT INTO po_lines (id, po_id, description, part_number, quantity, unit) VALUES (?,?,?,?,?,?)');
      lines.forEach(l => insertLine.run(uid(), poId, l.description || '', l.partNumber || '', l.quantity || 1, l.unit || 'each'));
    }

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${poNumber}.pdf"`,
      'Content-Length': pdfBuffer.length
    });
    res.send(pdfBuffer);

  } catch(e) {
    console.error('raise-po error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Get all issued POs
app.get('/api/issued-pos', requireAuth, (req, res) => {
  const pos = db.prepare('SELECT * FROM issued_pos ORDER BY created_at DESC').all();
  res.json(pos);
});

// ─── SERVE APP ──────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Duke Goods-In running on port ${PORT}`));
