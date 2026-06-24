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
    delivery_date TEXT
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    is_unexpected INTEGER DEFAULT 0
  );
`);

// Migrate delivery_lines to remove foreign key if it exists
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_lines_new (
      id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      po_line_id TEXT,
      description TEXT NOT NULL,
      part_number TEXT,
      ordered REAL DEFAULT 0,
      received REAL DEFAULT 0,
      status TEXT,
      note TEXT,
      is_unexpected INTEGER DEFAULT 0
    );
    INSERT OR IGNORE INTO delivery_lines_new SELECT * FROM delivery_lines;
    DROP TABLE delivery_lines;
    ALTER TABLE delivery_lines_new RENAME TO delivery_lines;
  `);
  console.log('delivery_lines migrated');
} catch(e) {
  console.log('Migration skipped:', e.message);
}

// Seed default users
db.prepare('DELETE FROM users').run();
db.prepare("INSERT INTO users (name, pin, role) VALUES ('Stephen','1234','admin')").run();
db.prepare("INSERT INTO users (name, pin, role) VALUES ('Nick','2345','staff')").run();
db.prepare("INSERT INTO users (name, pin, role) VALUES ('Rob','3456','staff')").run();
db.prepare("INSERT INTO users (name, pin, role) VALUES ('Site Staff','0000','staff')").run();
console.log('Users seeded');

module.exports = db;
