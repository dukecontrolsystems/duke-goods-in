const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'goods-in.db');

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

db.prepare('DELETE FROM users').run();
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get();
if (userCount.c === 0) {
  db.prepare('INSERT INTO users (name, pin, role) VALUES (?, ?, ?)').run('Stephen', '1234', 'admin');
  db.prepare('INSERT INTO users (name, pin, role) VALUES (?, ?, ?)').run('Nick', '2345', 'staff');
  db.prepare('INSERT INTO users (name, pin, role) VALUES (?, ?, ?)').run('Rob', '3456', 'staff');
  db.prepare('INSERT INTO users (name, pin, role) VALUES (?, ?, ?)').run('Site Staff', '0000', 'staff');
  console.log('Default users seeded');
}

module.exports = db;
