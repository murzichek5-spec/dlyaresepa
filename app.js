require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reasonGroups = require('./data/reasons.json');
const activationAccounts = require('./config/activation-accounts');
const allowedReasons = new Set(reasonGroups.flatMap((group) => group.values));

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
if (!ticketColumns.includes('reason')) {
  db.exec('ALTER TABLE tickets ADD COLUMN reason TEXT');
}
// Закрепление талона за сотрудником активации. NULL = свободен.
if (!ticketColumns.includes('activation_owner_id')) {
  db.exec('ALTER TABLE tickets ADD COLUMN activation_owner_id INTEGER REFERENCES users(id)');
}
if (!ticketColumns.includes('activation_claimed_at')) {
  db.exec('ALTER TABLE tickets ADD COLUMN activation_claimed_at DATETIME');
}

// Роль activation добавляется в существующую базу без потери пользователей или талонов.
// Старые версии users допускали только helper/staff/admin (CHECK constraint).
const usersDDL = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
if (!usersDDL.includes("'activation'")) {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_with_activation (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('helper', 'staff', 'admin', 'activation')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users_with_activation (id, username, password_hash, role, created_at)
          SELECT id, username, password_hash, role, created_at FROM users;
        DROP TABLE users;
        ALTER TABLE users_with_activation RENAME TO users;
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  const brokenLinks = db.pragma('foreign_key_check');
  if (brokenLinks.length) throw new Error('Ошибка внешних ключей после миграции роли activation');
  console.log('[migration] Добавлена роль activation');
}

// Личные учётные записи: миграция добавляет имя и возможность отключать старый общий логин.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('display_name')) db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
if (!userColumns.includes('is_active')) db.exec('ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');

// Все открытые SSE-подключения. Через них отправляем изменения без перезагрузки.
const liveClients = new Set();
// Отдельный SSE-канал. Отдел активации никогда не получает данные новых/неактивных талонов.
const activationClients = new Set();

function sendActivationEvent(type, payload = {}) {
  const message = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  for (const client of activationClients) {
    try {
      client.write(message);
    } catch (_) {
      activationClients.delete(client);
    }
  }
}

function activationTicket(ticket) {
  return {
    id: ticket.id,
    full_name: ticket.full_name,
    phone: ticket.phone,
    queue_number: ticket.queue_number,
    reason: ticket.reason,
    has_telegram: ticket.has_telegram,
    has_my_tax: ticket.has_my_tax,
    has_yandex_pro: ticket.has_yandex_pro,
    activation_owner_id: ticket.activation_owner_id,
    activation_owner_name: ticket.activation_owner_id
      ? (db.prepare("SELECT COALESCE(NULLIF(display_name, ''), username) AS name FROM users WHERE id = ?")
          .get(ticket.activation_owner_id)?.name || 'Сотрудник')
      : null
  };
}

function broadcastActivation(type, payload) {
  if (type === 'tickets-cleared') {
    sendActivationEvent('tickets-cleared');
  } else if (type === 'ticket-deleted') {
    sendActivationEvent('activation-ticket-removed', { ticketId: payload.ticketId });
  } else if (type === 'ticket-status-updated' && payload.ticket?.status !== 'active') {
    sendActivationEvent('activation-ticket-removed', { ticketId: payload.ticket.id });
  } else if (
    ['ticket-status-updated', 'ticket-number-updated', 'ticket-reason-updated', 'services-updated', 'activation-owner-updated'].includes(type)
    && payload.ticket?.status === 'active'
  ) {
    sendActivationEvent('activation-ticket-updated', { ticket: activationTicket(payload.ticket) });
  }
}

function broadcast(type, payload = {}) {
  const message = `data: ${JSON.stringify({ type, ...payload })}\n\n`;

  for (const client of liveClients) {
    try {
      client.write(message);
    } catch (_) {
      liveClients.delete(client);
    }
  }
  broadcastActivation(type, payload);
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
// 11 персональных логинов активации: имена заданы в config/activation-accounts.js,
// пароли — только через индивидуальные переменные Render/.env, генератор не нужен.
// Отсутствующий пароль = учётная запись отключена; ранее существовавшие лишние
// учётные записи активации также отключаются, но не удаляются из SQLite.
function configureActivationAccounts() {
  const ready = [];
  const seen = new Set();

  for (const account of activationAccounts) {
    if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(account.username) || seen.has(account.username)) {
      throw new Error('Некорректный или повторяющийся логин активации в config/activation-accounts.js');
    }
    seen.add(account.username);
    const password = process.env[account.passwordEnv];
    if (!password) continue;
    if (password.length < 6) {
      throw new Error(`Пароль ${account.passwordEnv} должен содержать не менее 6 символов`);
    }
    ready.push({ username: account.username, password });
  }

  // Если кто-то ранее пользовался таким логином под другой ролью,
  // не перезаписываем его учётку и не меняем роль автоматически.
  for (const account of ready) {
    const old = db.prepare('SELECT role FROM users WHERE username = ?').get(account.username);
    if (old && old.role !== 'activation') {
      throw new Error(`Логин ${account.username} уже занят другой ролью`);
    }
  }

  db.transaction(() => {
    db.prepare("UPDATE users SET is_active = 0 WHERE role = 'activation'").run();

    for (const account of ready) {
      const existing = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(account.username);
      if (!existing) {
        db.prepare(`
          INSERT INTO users (username, password_hash, role, display_name, is_active)
          VALUES (?, ?, 'activation', ?, 1)
        `).run(account.username, bcrypt.hashSync(account.password, 12), account.username);
      } else {
        const passwordHash = bcrypt.compareSync(account.password, existing.password_hash)
          ? existing.password_hash
          : bcrypt.hashSync(account.password, 12);
        db.prepare('UPDATE users SET password_hash=?, display_name=?, is_active=1 WHERE id=?')
          .run(passwordHash, account.username, existing.id);
      }
    }

    // Если у выключенных старых аккаунтов были кандидаты, освобождаем их:
    // иначе талон может остаться закреплённым за несуществующей сменой.
    db.prepare(`
      UPDATE tickets
      SET activation_owner_id=NULL, activation_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE activation_owner_id IN (
        SELECT id FROM users WHERE role='activation' AND is_active=0
      )
    `).run();
  })();

  console.log(`[auth] Личные аккаунты активации: ${ready.length} активны из ${activationAccounts.length}`);
  if (ready.length < activationAccounts.length) {
    console.warn('[auth] Для остальных аккаунтов активации не заданы пароли в Environment — вход отключён.');
  }
}
configureActivationAccounts();


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
  if (req.session.user) {
    const current = db.prepare('SELECT id, username, role, display_name, is_active FROM users WHERE id=?')
      .get(req.session.user.id);
    if (!current || !current.is_active || current.role !== req.session.user.role) {
      req.session.user = null;
    } else {
      req.session.user = { id: current.id, username: current.username, role: current.role,
        display_name: current.display_name || current.username };
    }
  }
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
  if (req.session.user.role === 'activation') return res.redirect('/activation');
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

  if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).render('login', { error: 'Неверный логин или пароль' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    display_name: user.display_name || user.username
  };
  req.session.activation_csrf = crypto.randomBytes(32).toString('hex');

  res.redirect('/');
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Одно SSE-подключение держится открытым и получает события об изменениях талонов.
app.get('/events', requireRole('helper', 'staff', 'admin'), (req, res) => {
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

// Страница отдела активации — только переданные талоны.
const activationSelect = `
  SELECT t.id, t.full_name, t.phone, t.queue_number, t.reason,
         t.has_telegram, t.has_my_tax, t.has_yandex_pro,
         t.activation_owner_id, t.activation_claimed_at,
         COALESCE(NULLIF(u.display_name, ''), u.username) AS activation_owner_name
  FROM tickets t
  LEFT JOIN users u ON u.id=t.activation_owner_id
  WHERE t.status='active'
`;

app.get('/activation', requireRole('activation', 'staff', 'admin'), (req, res) => {
  const tickets = db.prepare(activationSelect + ' ORDER BY t.updated_at DESC, t.id DESC').all();
  if (!req.session.activation_csrf) req.session.activation_csrf = crypto.randomBytes(32).toString('hex');
  res.render('activation', { tickets, activationCsrf: req.session.activation_csrf });
});

app.get('/activation/events', requireRole('activation', 'staff', 'admin'), (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive'
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  activationClients.add(res);
  // Переподключение после обрыва синхронизирует весь список.
  const snapshot = db.prepare(activationSelect + ' ORDER BY t.updated_at DESC, t.id DESC').all();
  res.write(`data: ${JSON.stringify({ type: 'activation-snapshot', tickets: snapshot })}\n\n`);
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    activationClients.delete(res);
  });
});

function requireActivationCsrf(req, res, next) {
  const supplied = req.get('X-CSRF-Token') || '';
  const expected = req.session.activation_csrf || '';
  if (!supplied || !expected || supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).json({ ok: false, error: 'Обнови страницу и попробуй снова' });
  }
  next();
}

// Атомарное закрепление: два сотрудника одновременно взять талон не смогут.
app.post('/activation/:id/claim', requireRole('activation'), requireActivationCsrf, (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ ok: false, error: 'Некорректный номер талона' });
  }
  const result = db.prepare(`
    UPDATE tickets SET activation_owner_id=?, activation_claimed_at=CURRENT_TIMESTAMP,
                       updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='active' AND activation_owner_id IS NULL
  `).run(req.session.user.id, ticketId);
  if (!result.changes) {
    const row = db.prepare('SELECT status, activation_owner_id FROM tickets WHERE id=?').get(ticketId);
    return res.status(row ? 409 : 404).json({ ok: false, error: row && row.activation_owner_id
      ? 'Кандидата уже забрал другой сотрудник' : 'Этот талон недоступен для взятия в работу' });
  }
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  broadcast('activation-owner-updated', { ticket });
  res.json({ ok: true, ticket: activationTicket(ticket) });
});

// Освободить талон может только его владелец; администратор — при необходимости.
app.post('/activation/:id/release', requireRole('activation', 'admin'), requireActivationCsrf, (req, res) => {
  const ticketId = Number(req.params.id);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) {
    return res.status(400).json({ ok: false, error: 'Некорректный номер талона' });
  }
  const admin = req.session.user.role === 'admin';
  const result = admin ? db.prepare(`
    UPDATE tickets SET activation_owner_id=NULL, activation_claimed_at=NULL,
                       updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='active' AND activation_owner_id IS NOT NULL
  `).run(ticketId) : db.prepare(`
    UPDATE tickets SET activation_owner_id=NULL, activation_claimed_at=NULL,
                       updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='active' AND activation_owner_id=?
  `).run(ticketId, req.session.user.id);
  if (!result.changes) {
    return res.status(409).json({ ok: false, error: 'Талон уже свободен или закреплён не за тобой' });
  }
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
  broadcast('activation-owner-updated', { ticket });
  res.json({ ok: true, ticket: activationTicket(ticket) });
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

app.get('/tickets', requireRole('helper', 'staff', 'admin'), (req, res) => {
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
    reasonGroups,
    search,
    error: req.query.error || null,
    success: req.query.success || null
  });
});

// Причину обращения выбирает штатный сотрудник из фиксированного перечня.
// До перевода на актив ошибочный выбор можно очистить.
app.post('/tickets/:id/reason', requireRole('staff', 'admin'), (req, res) => {
  const ticketId = Number(req.params.id);
  const reason = req.body.reason;

  if (!Number.isSafeInteger(ticketId) || ticketId <= 0 || typeof reason !== 'string') {
    return res.status(400).json({ ok: false, error: 'Некорректные данные' });
  }

  const value = reason.trim();
  if (value !== '' && !allowedReasons.has(value)) {
    return res.status(400).json({ ok: false, error: 'Выбери причину из списка' });
  }

  // Уже активный талон нельзя оставить без причины; исправить на другую можно.
  const currentTicket = db.prepare('SELECT status FROM tickets WHERE id = ?').get(ticketId);
  if (!currentTicket) {
    return res.status(404).json({ ok: false, error: 'Талон не найден' });
  }
  if (currentTicket.status === 'active' && !value) {
    return res.status(409).json({ ok: false, error: 'У талона на активе причина обращения обязательна' });
  }

  const result = db.prepare(`
    UPDATE tickets SET reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(value || null, ticketId);

  if (!result.changes) {
    return res.status(404).json({ ok: false, error: 'Талон не найден' });
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  broadcast('ticket-reason-updated', { ticket });
  res.json({ ok: true, ticket });
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

  // Серверная проверка: UI можно обойти прямым POST-запросом.
  if (action === 'active' && !allowedReasons.has(ticket.reason)) {
    return redirectWithError(res, 'Сначала выбери причину обращения из списка');
  }

  const nextStatus = action === 'active' ? 'active' : 'waiting';

  db.prepare(`
    UPDATE tickets
    SET status = ?, assigned_by = ?,
        activation_owner_id = CASE WHEN ? = 'waiting' THEN NULL ELSE activation_owner_id END,
        activation_claimed_at = CASE WHEN ? = 'waiting' THEN NULL ELSE activation_claimed_at END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(nextStatus, req.session.user.id, nextStatus, nextStatus, ticketId);

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
