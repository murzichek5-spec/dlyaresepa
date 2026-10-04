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

// Мягкая миграция для уже существующей SQLite-базы из прошлой версии.
// Внутреннее поле status оставляем waiting/active для совместимости,
// а готовность хелпера храним отдельно. В интерфейсе слова «Ожидает» больше нет.
const ticketColumns = db.prepare('PRAGMA table_info(tickets)').all().map((column) => column.name);
if (!ticketColumns.includes('helper_ready')) {
  db.exec('ALTER TABLE tickets ADD COLUMN helper_ready INTEGER NOT NULL DEFAULT 0');
}

// Все открытые SSE-подключения. Через них отправляем изменения без перезагрузки.
const liveClients = new Set();

function broadcast(type, payload = {}) {
  const message = `data: ${JSON.stringify({ type, ...payload })}\n\n`;

  for (const client of liveClients) {
    try {
      client.write(message);
    } catch (_) {
      liveClients.delete(client);
    }
  }
}

// Удаляем только талоны. Пользователи и логины остаются.
function clearAllTickets() {
  const result = db.prepare('DELETE FROM tickets').run();
  db.prepare("DELETE FROM sqlite_sequence WHERE name = 'tickets'").run();

  console.log(`[cleanup] Удалено талонов: ${result.changes}`);
  broadcast('tickets-cleared');
}

// Если сервер не работал ровно в 00:00, старые талоны удалятся при следующем запуске.
function clearTicketsFromPreviousDays() {
  const result = db.prepare(`
    DELETE FROM tickets
    WHERE date(created_at, 'localtime') < date('now', 'localtime')
  `).run();

  if (result.changes > 0) {
    console.log(`[cleanup] При запуске удалено старых талонов: ${result.changes}`);
  }
}

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
app.use(express.json());
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

function redirectWithError(res, message) {
  return res.redirect('/tickets?error=' + encodeURIComponent(message));
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

// Одно SSE-подключение держится открытым и получает события об изменениях талонов.
app.get('/events', requireAuth, (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  liveClients.add(res);

  const keepAlive = setInterval(() => {
    res.write(': keep-alive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    liveClients.delete(res);
  });
});

app.get('/create', requireRole('helper', 'admin'), (req, res) => {
  res.render('create', {
    error: null,
    success: req.query.created ? 'Талон создан. Сервисы можно отметить на странице «Талоны».' : null
  });
});

// При создании сохраняются только ФИО и телефон.
app.post('/create', requireRole('helper', 'admin'), (req, res) => {
  const fullName = (req.body.full_name || '').trim();
  const phone = (req.body.phone || '').trim();

  if (fullName.length < 3 || phone.length < 5) {
    return res.status(400).render('create', {
      error: 'Заполни ФИО и номер телефона',
      success: null
    });
  }

  const result = db.prepare(`
    INSERT INTO tickets (full_name, phone, created_by)
    VALUES (?, ?, ?)
  `).run(fullName, phone, req.session.user.id);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(result.lastInsertRowid);
  broadcast('ticket-created', { ticket });

  // Redirect защищает от повторного создания талона при обновлении страницы.
  res.redirect('/create?created=1');
});

// Telegram / Мой налог / Яндекс Про хелпер меняет прямо в общем списке.
app.post('/tickets/:id/services', requireRole('helper', 'admin'), (req, res) => {
  const ticketId = Number(req.params.id);
  const field = req.body.field;
  const value = req.body.value === true || req.body.value === 1 || req.body.value === '1';

  const columns = {
    telegram: 'has_telegram',
    my_tax: 'has_my_tax',
    yandex_pro: 'has_yandex_pro'
  };

  const column = columns[field];
  if (!Number.isInteger(ticketId) || !column) {
    return res.status(400).json({ ok: false, error: 'Некорректные данные' });
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) {
    return res.status(404).json({ ok: false, error: 'Талон не найден' });
  }

  // Обычный хелпер меняет сервисы только у созданных им талонов.
  if (req.session.user.role === 'helper' && ticket.created_by !== req.session.user.id) {
    return res.status(403).json({ ok: false, error: 'Нет доступа к этому талону' });
  }

  db.prepare(`
    UPDATE tickets
    SET ${column} = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(value ? 1 : 0, ticketId);

  const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  broadcast('services-updated', { ticket: updatedTicket });

  res.json({ ok: true, ticket: updatedTicket });
});

// Готов / Не готов меняет только хелпер у созданного им талона.
app.post('/tickets/:id/ready', requireRole('helper', 'admin'), (req, res) => {
  const ticketId = Number(req.params.id);
  const ready = req.body.ready === true || req.body.ready === 1 || req.body.ready === '1' || req.body.ready === 'ready';

  if (!Number.isInteger(ticketId)) {
    return res.status(400).json({ ok: false, error: 'Некорректный талон' });
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) {
    return res.status(404).json({ ok: false, error: 'Талон не найден' });
  }

  if (req.session.user.role === 'helper' && ticket.created_by !== req.session.user.id) {
    return res.status(403).json({ ok: false, error: 'Нет доступа к этому талону' });
  }

  // После перевода в актив итоговый статус контролирует штатный сотрудник.
  if (ticket.status === 'active') {
    return res.status(409).json({ ok: false, error: 'Талон уже переведен на актив' });
  }

  db.prepare(`
    UPDATE tickets
    SET helper_ready = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(ready ? 1 : 0, ticketId);

  const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  broadcast('ticket-ready-updated', { ticket: updatedTicket });

  res.json({ ok: true, ticket: updatedTicket });
});

app.get('/tickets', requireAuth, (req, res) => {
  const search = (req.query.search || '').trim();
  const where = [];
  const params = [];

  if (search) {
    where.push('(t.full_name LIKE ? OR t.phone LIKE ? OR CAST(t.queue_number AS TEXT) LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
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
  res.render('tickets', {
    tickets,
    search,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// Штатный сотрудник может присвоить, исправить или очистить номер талона.
app.post('/tickets/:id/number', requireRole('staff', 'admin'), (req, res) => {
  const ticketId = Number(req.params.id);
  const rawNumber = String(req.body.queue_number ?? '').trim();

  if (!Number.isInteger(ticketId)) return redirectWithError(res, 'Некорректный талон');

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return res.status(404).send('Талон не найден');

  let queueNumber = null;
  if (rawNumber === '' && ticket.status === 'active') {
    return redirectWithError(res, 'У талона в активе должен быть номер. Сначала верни его из статуса «Переведен на актив».');
  }

  if (rawNumber !== '') {
    queueNumber = Number(rawNumber);
    if (!Number.isInteger(queueNumber) || queueNumber <= 0) {
      return redirectWithError(res, 'Введите корректный номер талона');
    }

    const duplicate = db.prepare('SELECT id FROM tickets WHERE queue_number = ? AND id <> ?')
      .get(queueNumber, ticketId);
    if (duplicate) {
      return redirectWithError(res, 'Такой номер уже используется');
    }
  }

  db.prepare(`
    UPDATE tickets
    SET queue_number = ?, assigned_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(queueNumber, req.session.user.id, ticketId);

  const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  broadcast('ticket-number-updated', { ticket: updatedTicket });
  res.redirect('/tickets');
});

// Штатный сотрудник переводит талон в актив и может отменить случайное нажатие.
// При возврате из актива снова показывается последнее состояние хелпера: Готов / Не готов.
app.post('/tickets/:id/status', requireRole('staff', 'admin'), (req, res) => {
  const ticketId = Number(req.params.id);
  const action = req.body.action;

  if (!Number.isInteger(ticketId) || !['active', 'restore'].includes(action)) {
    return redirectWithError(res, 'Некорректное действие со статусом');
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return res.status(404).send('Талон не найден');

  if (action === 'active' && !ticket.queue_number) {
    return redirectWithError(res, 'Сначала присвой номер талона');
  }

  const nextStatus = action === 'active' ? 'active' : 'waiting';

  db.prepare(`
    UPDATE tickets
    SET status = ?, assigned_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextStatus, req.session.user.id, ticketId);

  const updatedTicket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  broadcast('ticket-status-updated', { ticket: updatedTicket });
  res.redirect('/tickets');
});

// Удалять могут обе роли. Хелпер — только созданные им талоны, staff/admin — любые.
app.post('/tickets/:id/delete', requireRole('helper', 'staff', 'admin'), (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isInteger(ticketId)) return redirectWithError(res, 'Некорректный талон');

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return res.status(404).send('Талон не найден');

  if (req.session.user.role === 'helper' && ticket.created_by !== req.session.user.id) {
    return res.status(403).send('Нет доступа к этому талону');
  }

  db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
  broadcast('ticket-deleted', { ticketId });

  res.redirect('/tickets?success=' + encodeURIComponent('Талон удалён'));
});

app.use((req, res) => {
  res.status(404).send('Страница не найдена');
});

app.listen(PORT, () => {
  console.log(`Office app: http://localhost:${PORT}`);
});
