import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(__dirname, 'photos');
const GUESTS_CSV = path.join(__dirname, 'guests.csv');
const MEDIA_RE   = /\.(jpe?g|png|gif|webp|avif|mp4|webm|mov|avi)$/i;
const VIDEO_RE   = /\.(mp4|webm|mov|avi)$/i;

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR);

const CSV_HEADER = 'Имя;Телефон;Статус;+1;Горячее;Салат;Имя партнёра;Телефон партнёра;Горячее партнёра;Салат партнёра;Пожелания;Дата\n';
if (!fs.existsSync(GUESTS_CSV)) fs.writeFileSync(GUESTS_CSV, '\ufeff' + CSV_HEADER, 'utf8');

function csvEscape(val) {
  const s = String(val ?? '').replace(/"/g, '""');
  return /[;"\n\r]/.test(s) ? `"${s}"` : s;
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/png': 'png',  'image/gif': 'gif',
  'image/webp': 'webp','image/avif': 'avif',
  'video/mp4': 'mp4',  'video/webm': 'webm',
  'video/quicktime': 'mov', 'video/x-msvideo': 'avi',
};
const EXT_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.jpg':  'image/jpeg', '.jpeg': 'image/jpeg',
  '.png':  'image/png',  '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif',
  '.svg':  'image/svg+xml',
  '.mp4':  'video/mp4',  '.webm': 'video/webm',
  '.mov':  'video/quicktime', '.avi': 'video/x-msvideo',
};

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ══════════════════════════════════════════════
//  TELEGRAM BOT
// ══════════════════════════════════════════════
let TG_TOKEN   = '';
let TG_CHAT_ID = '';

try {
  const cfg = await import('./telegram.config.js');
  TG_TOKEN   = cfg.TG_TOKEN   || '';
  TG_CHAT_ID = cfg.TG_CHAT_ID || '';
} catch { /* файл не найден — бот отключён */ }

const BOT_ACTIVE = TG_TOKEN && !TG_TOKEN.includes('ВСТАВЬ');

// chat_id сохраняется в файл — не теряется при перезапуске
const ADMIN_CHAT_FILE = path.join(__dirname, '.admin_chat_id');
let _adminChatId = (() => {
  try { return fs.readFileSync(ADMIN_CHAT_FILE, 'utf8').trim(); } catch { return TG_CHAT_ID; }
})();

function saveAdminChatId(id) {
  _adminChatId = id;
  try { fs.writeFileSync(ADMIN_CHAT_FILE, id, 'utf8'); } catch {}
}

function tgRequest(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function tgSend(text, chatId) {
  if (!BOT_ACTIVE) return;
  try {
    await tgRequest('sendMessage', {
      chat_id: chatId ?? TG_CHAT_ID,
      text,
      parse_mode: 'HTML',
    });
  } catch (e) {
    console.error('[tg] ошибка отправки:', e.message);
  }
}

// Читаем CSV и форматируем список гостей
function formatGuestsList() {
  const raw = fs.readFileSync(GUESTS_CSV, 'utf8').replace(/^\ufeff/, '');
  const lines = raw.trim().split('\n').slice(1).filter(Boolean); // пропускаем заголовок
  if (!lines.length) return '📋 Пока никто не оставил заявку.';

  let msg = `<b>📋 Гости (${lines.length}):</b>\n\n`;
  lines.forEach((line, i) => {
    const cols = line.split(';').map(c => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
    const [name, phone, status, plusOne, hot, salad, partnerName, partnerPhone, partnerHot, partnerSalad, wish] = cols;
    const icon = status === 'Придёт' ? '✅' : '❌';
    msg += `${i + 1}. ${icon} <b>${name}</b>`;
    if (phone) msg += ` · ${phone}`;
    msg += '\n';
    if (hot)   msg += `   🍖 ${hot}\n`;
    if (salad) msg += `   🥗 ${salad}\n`;
    if (plusOne === 'Да') {
      msg += `   👫 Партнёр: <b>${partnerName || '—'}</b>`;
      if (partnerPhone) msg += ` · ${partnerPhone}`;
      msg += '\n';
      if (partnerHot)   msg += `   🍖 ${partnerHot}\n`;
      if (partnerSalad) msg += `   🥗 ${partnerSalad}\n`;
    }
    if (wish)  msg += `   💬 ${wish}\n`;
    msg += '\n';
  });
  return msg.trim();
}

// Long polling — слушаем команды
async function startPolling() {
  if (!BOT_ACTIVE) {
    console.log('  🤖 Telegram бот не настроен (заполни telegram.config.js)');
    return;
  }
  console.log('  🤖 Telegram бот запущен');

  let offset = 0;
  const poll = async () => {
    try {
      const data = await tgRequest('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      if (data.ok && data.result.length) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;

          const from = String(msg.chat.id);
          saveAdminChatId(from);
          console.log(`[tg] chat_id=${from} (сохранён): ${msg.text}`);

          const botName = await getBotUsername();
          const cleanCmd = msg.text.trim().toLowerCase().replace('@' + botName, '');

          if (cleanCmd === '/guests') {
            await tgSend(formatGuestsList(), from);
          } else if (cleanCmd === '/start' || cleanCmd === '/myid') {
            await tgSend(
              `👋 Привет!\n\n` +
              `Твой <b>chat_id</b>: <code>${from}</code>\n\n` +
              `Вставь его в <code>telegram.config.js</code> в поле <code>TG_CHAT_ID</code>\n\n` +
              `Команды:\n/guests — список всех гостей`,
              from
            );
          }
        }
      }
    } catch (e) {
      console.error('[tg] polling error:', e.message);
    }
    setTimeout(poll, 1000);
  };

  poll();
}

let _botUsername = null;
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  try {
    const r = await tgRequest('getMe', {});
    _botUsername = r.result?.username?.toLowerCase() ?? '';
  } catch { _botUsername = ''; }
  return _botUsername;
}

startPolling();

// ══════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET /api/tg-test ───────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/tg-test') {
    try {
      const meRes = await tgRequest('getMe', {});
      const sendRes = await tgRequest('sendMessage', {
        chat_id: TG_CHAT_ID,
        text: '✅ Тест! Бот работает.',
        parse_mode: 'HTML',
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ token_ok: meRes.ok, bot: meRes.result?.username, chat_id: TG_CHAT_ID, send: sendRes }, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/photos ────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/photos') {
    const files = fs.readdirSync(PHOTOS_DIR)
      .filter(f => MEDIA_RE.test(f))
      .sort((a, b) => (parseInt(a.split('_')[0]) || 0) - (parseInt(b.split('_')[0]) || 0));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  // ── POST /api/rsvp ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/rsvp') {
    try {
      const d = JSON.parse((await collectBody(req)).toString('utf8'));

      const row = [
        d.name, d.phone,
        d.attend === 'yes' ? 'Придёт' : 'Не придёт',
        d.plusOne ? 'Да' : 'Нет',
        d.hot, d.salad,
        d.plusOne ? (d.partnerName  ?? '') : '',
        d.plusOne ? (d.partnerPhone ?? '') : '',
        d.plusOne ? (d.partnerHot   ?? '') : '',
        d.plusOne ? (d.partnerSalad ?? '') : '',
        d.wish,
        new Date().toLocaleString('ru-RU'),
      ].map(csvEscape).join(';') + '\n';

      fs.appendFileSync(GUESTS_CSV, row, 'utf8');
      console.log(`[rsvp] ✓ ${d.name} — ${d.attend === 'yes' ? 'придёт' : 'не придёт'}`);

      // Уведомление в Telegram
      const icon = d.attend === 'yes' ? '✅' : '❌';
      let tgMsg = `${icon} <b>Новый гость!</b>\n\n`;
      tgMsg += `👤 <b>${d.name}</b>\n`;
      if (d.phone)   tgMsg += `📞 ${d.phone}\n`;
      tgMsg += `Статус: ${d.attend === 'yes' ? 'Придёт' : 'Не придёт'}\n`;
      if (d.hot)      tgMsg += `🍖 Горячее: ${d.hot}\n`;
      if (d.salad)    tgMsg += `🥗 Салат: ${d.salad}\n`;
      if (d.plusOne) {
        tgMsg += `\n👫 <b>Партнёр:</b>\n`;
        if (d.partnerName)  tgMsg += `👤 ${d.partnerName}\n`;
        if (d.partnerPhone) tgMsg += `📞 ${d.partnerPhone}\n`;
        if (d.partnerHot)   tgMsg += `🍖 Горячее: ${d.partnerHot}\n`;
        if (d.partnerSalad) tgMsg += `🥗 Салат: ${d.partnerSalad}\n`;
      }
      if (d.wish)     tgMsg += `\n💬 Пожелание: ${d.wish}\n`;
      console.log(`[tg] уведомление → chat_id=${_adminChatId}`);
      tgSend(tgMsg, _adminChatId);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      console.error('[rsvp] ошибка:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/upload ────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    try {
      const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const ext = MIME_EXT[contentType];
      if (!ext) { res.writeHead(415); res.end(JSON.stringify({ error: `Unknown type: ${contentType}` })); return; }

      const rawName = req.headers['x-filename'] || 'photo';
      const baseName = decodeURIComponent(rawName).replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9а-яёА-ЯЁ._-]/g, '_').slice(0, 60);
      const safeName = `${baseName}_${Date.now()}.${ext}`;

      const body = await collectBody(req);
      fs.writeFileSync(path.join(PHOTOS_DIR, safeName), body);
      console.log(`[upload] ✓ ${safeName} (${(body.length / 1024).toFixed(1)} KB)`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ filename: safeName }));
    } catch (e) {
      console.error('[upload] ошибка:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /public/* ───────────────────────────────────────────
  if (req.method === 'GET' && !url.pathname.startsWith('/api') && !url.pathname.startsWith('/photos')) {
    const staticPath = path.join(__dirname, 'public', url.pathname);
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      const ext = path.extname(staticPath).toLowerCase();
      const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(staticPath).pipe(res);
      return;
    }
  }

  // ── GET /photos/:file ───────────────────────────────────────
  if (req.method === 'GET' && url.pathname.startsWith('/photos/')) {
    const filename = decodeURIComponent(path.basename(url.pathname));
    const filePath = path.join(PHOTOS_DIR, filename);
    if (fs.existsSync(filePath) && MEDIA_RE.test(filename)) {
      const ext  = path.extname(filename).toLowerCase();
      const mime = EXT_MIME[ext] || 'application/octet-stream';
      const stat = fs.statSync(filePath);
      const total = stat.size;
      const rangeHeader = req.headers['range'];
      if (rangeHeader) {
        const [startStr, endStr] = rangeHeader.replace('bytes=', '').split('-');
        const start = parseInt(startStr, 10);
        const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024, total - 1);
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': mime,
          'Accept-Ranges': 'bytes',
          'Content-Length': total,
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } else {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── /gallery → gallery.html ─────────────────────────────────
  if (req.method === 'GET' && (url.pathname === '/gallery' || url.pathname === '/gallery.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'gallery.html')).pipe(res);
    return;
  }

  // ── всё остальное → index.html ──────────────────────────────
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  🌸 Свадебный сайт → http://localhost:${PORT}`);
  console.log(`  📁 Фото: ${PHOTOS_DIR}`);
  console.log(`  📋 Гости: ${GUESTS_CSV}\n`);
});
