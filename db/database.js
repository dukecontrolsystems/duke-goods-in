const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'goods-in.db');

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    pin TEXT NOT NULL,
    role TEXT DEFAULT 'staff',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS purchase_orders (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    supplier TEXT NOT NULL,
    project TEXT,
    expected_date TEXT,
    status TEXT DEFAULT 'open',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS po_lines (
    id TEXT PRIMARY KEY,
    po_id TEXT NOT NULL,
    description TEXT NOT NULL,
    part_number TEXT,
    quantity REAL NOT NULL,
    unit TEXT,
    delivery_date TEXT,
    FOREIGN KEY (po_id) REFERENCES purchase_orders(id)
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id TEXT PRIMARY KEY,
    po_id TEXT,
    po_number TEXT,
    supplier TEXT,
    project TEXT,
    delivery_date TEXT,
    carrier TEXT,
    dn_ref TEXT,
    status TEXT DEFAULT 'draft',
    received_by TEXT,
    image_path TEXT,
    ai_summary TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (po_id) REFERENCES purchase_orders(id)
  );

  CREATE TABLE IF NOT EXISTS delivery_lines (
    id TEXT PRIMARY KEY,
    delivery_id TEXT NOT NULL,
    po_line_id TEXT,
    description TEXT NOT NULL,
    part_number TEXT,
    ordered REAL DEFAULT 0,
    received REAL DEFAULT 0,
    status TEXT,
    note TEXT,
    is_unexpected INTEGER DEFAULT 0,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(id)
  );
`);

// Clean up any duplicate users then ensure defaults exist
db.exec(`DELETE FROM users WHERE id NOT IN (SELECT MIN(id) FROM users GROUP BY LOWER(name))`);

const defaultUsers = [
  { name: 'Stephen', pin: '1234', role: 'admin' },
  { name: 'Nick', pin: '2345', role: 'staff' },
  { name: 'Rob', pin: '3456', role: 'staff' },
  { name: 'Site Staff', pin: '0000', role: 'staff' }
];

const upsert = db.prepare(`INSERT OR IGNORE INTO users (name, pin, role) VALUES (?, ?, ?)`);
defaultUsers.forEach(u => upsert.run(u.name, u.pin, u.role));

// Ensure PINs are correct for default users
const updatePin = db.prepare(`UPDATE users SET pin=?, role=? WHERE LOWER(name)=LOWER(?)`);
defaultUsers.forEach(u => updatePin.run(u.pin, u.role, u.name));

console.log('Users ready:', db.prepare('SELECT name, role FROM users').all().map(u => u.name).join(', '));

module.exports = db;
