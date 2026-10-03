CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('helper', 'staff', 'admin')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  has_telegram INTEGER NOT NULL DEFAULT 0,
  has_my_tax INTEGER NOT NULL DEFAULT 0,
  has_yandex_pro INTEGER NOT NULL DEFAULT 0,
  helper_ready INTEGER NOT NULL DEFAULT 0,
  queue_number INTEGER UNIQUE,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting', 'active')),
  created_by INTEGER NOT NULL,
  assigned_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(created_by) REFERENCES users(id),
  FOREIGN KEY(assigned_by) REFERENCES users(id)
);
