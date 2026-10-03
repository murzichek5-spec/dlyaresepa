require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

const dbPath = process.env.DB_PATH || path.join(__dirname, 'db', 'office.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Удаляем все талоны. Пользователи и их логины остаются в базе.
function clearAllTickets() {
  const result = db.prepare('DELETE FROM tickets').run();

  // Сбрасываем внутренний AUTOINCREMENT id талонов, чтобы новый день начинался с чистой таблицы.
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'tickets'").run();

  console.log(`[cleanup] Удалено талонов: ${result.changes}`);
}

// Если сервер был выключен ровно в 00:00, при следующем запуске
// удаляем талоны, оставшиеся от предыдущих дней.
function clearTicketsFromPreviousDays() {
  const result = db.prepare(`
    DELETE FROM tickets
    WHERE date(created_at, 'localtime') < date('now', 'localtime')
  `).run();

  if (result.changes > 0) {
    console.log(`[cleanup] При запуске удалено старых талонов: ${result.changes}`);
  }
}

// Планируем очистку на ближайшие 00:00 по локальному времени сервера.
// После выполнения снова считаем следующую полночь — это корректнее, чем setInterval(24h).
function scheduleMidnightCleanup() {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);

  const delay = nextMidnight.getTime() - now.getTime();

  console.log(`[cleanup] Следующая очистка талонов: ${nextMidnight.toLocaleString()}`);

  setTimeout(() => {
    try {
      clearAllTickets();
    } catch (error) {
      console.error('[cleanup] Ошибка очистки талонов:', error);
    } finally {
      scheduleMidnightCleanup();
    }
  }, delay);
}

clearTicketsFromPreviousDays();
scheduleMidnightCleanup();

function seedUser(username, password, role) {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!exists) {
    const passwordHash = bcrypt.hashSync(password, 12);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, passwordHash, role);
  }
}

seedUser(process.env.HELPER_LOGIN || 'helper', process.env.HELPER_PASSWORD || 'helper123', 'helper');
seedUser(process.env.STAFF_LOGIN || 'staff', process.env.STAFF_PASSWORD || 'staff123', 'staff');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 8
  }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!roles.includes(req.session.user.role)) return res.status(403).send('Нет доступа');
    next();
  };
}

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'helper') return res.redirect('/create');
  return res.redirect('/tickets');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: 'Неверный логин или пароль' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role
  };

  res.redirect('/');
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/create', requireRole('helper', 'admin'), (req, res) => {
  res.render('create', { error: null, success: null });
});

app.post('/create', requireRole('helper', 'admin'), (req, res) => {
  const fullName = (req.body.full_name || '').trim();
  const phone = (req.body.phone || '').trim();

  if (fullName.length < 3 || phone.length < 5) {
    return res.status(400).render('create', {
      error: 'Заполни ФИО и номер телефона',
      success: null
    });
  }

  db.prepare(`
    INSERT INTO tickets (
      full_name, phone, has_telegram, has_my_tax, has_yandex_pro, created_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    fullName,
    phone,
    req.body.has_telegram ? 1 : 0,
    req.body.has_my_tax ? 1 : 0,
    req.body.has_yandex_pro ? 1 : 0,
    req.session.user.id
  );

  res.render('create', { error: null, success: 'Талон создан' });
});

app.get('/tickets', requireAuth, (req, res) => {
  const search = (req.query.search || '').trim();
  const status = req.query.status || 'all';
  const date = req.query.date || 'today';

  const where = [];
  const params = [];

  if (search) {
    where.push('(t.full_name LIKE ? OR t.phone LIKE ? OR CAST(t.queue_number AS TEXT) LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }

  if (status === 'waiting' || status === 'active') {
    where.push('t.status = ?');
    params.push(status);
  }

  if (date === 'today') {
    where.push("date(t.created_at, 'localtime') = date('now', 'localtime')");
  } else if (date === '7days') {
    where.push("datetime(t.created_at) >= datetime('now', '-7 days')");
  }

  const sql = `
    SELECT t.*, u.username AS creator_name, a.username AS assigned_name
    FROM tickets t
    JOIN users u ON u.id = t.created_by
    LEFT JOIN users a ON a.id = t.assigned_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.id DESC
  `;

  const tickets = db.prepare(sql).all(...params);
  res.render('tickets', { tickets, search, status, date, error: req.query.error || null });
});

app.post('/tickets/:id/activate', requireRole('staff', 'admin'), (req, res) => {
  const ticketId = Number(req.params.id);
  const queueNumber = Number(req.body.queue_number);

  if (!Number.isInteger(queueNumber) || queueNumber <= 0) {
    return res.redirect('/tickets?error=' + encodeURIComponent('Введите корректный номер'));
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return res.status(404).send('Талон не найден');
  if (ticket.status === 'active') {
    return res.redirect('/tickets?error=' + encodeURIComponent('Талон уже переведен на актив'));
  }

  const duplicate = db.prepare('SELECT id FROM tickets WHERE queue_number = ?').get(queueNumber);
  if (duplicate) {
    return res.redirect('/tickets?error=' + encodeURIComponent('Такой номер уже используется'));
  }

  db.prepare(`
    UPDATE tickets
    SET queue_number = ?, status = 'active', assigned_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'waiting'
  `).run(queueNumber, req.session.user.id, ticketId);

  res.redirect('/tickets');
});

app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

app.listen(PORT, () => {
  console.log(`Office app: http://localhost:${PORT}`);
});
