const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'vertexwealth.db'));

db.serialize(() => {
  // Investors table
  db.run(`
    CREATE TABLE IF NOT EXISTS investors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unique_code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      balance REAL DEFAULT 0,
      roi_earned REAL DEFAULT 0,
      active_plan TEXT DEFAULT 'none',
      plan_start_date DATETIME DEFAULT NULL,
      plan_end_date DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Transactions table
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investor_code TEXT NOT NULL,
      investor_name TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      wallet_address TEXT DEFAULT '',
      rejection_reason TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // ROI updates table
  db.run(`
    CREATE TABLE IF NOT EXISTS roi_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investor_code TEXT NOT NULL,
      amount REAL NOT NULL,
      plan_type TEXT DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

module.exports = db;