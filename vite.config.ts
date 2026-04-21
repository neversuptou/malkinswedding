import { defineConfig } from 'vite';
import fs from 'fs';
import https from 'https';
import path from 'path';
import type { Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'http';

const PHOTOS_DIR = path.resolve(__dirname, 'photos');
const GUESTS_CSV = path.resolve(__dirname, 'guests.csv');
const IMAGE_RE   = /\.(jpe?g|png|gif|webp|avif)$/i;

const CSV_HEADER = 'Имя;Телефон;Статус;+1;Горячее;Салат;Пожелания;Дата\n';
if (!fs.existsSync(GUESTS_CSV)) fs.writeFileSync(GUESTS_CSV, '\ufeff' + CSV_HEADER, 'utf8');

function csvEscape(val: unknown): string {
  const s = String(val ?? '').replace(/"/g, '""');
  return /[;"\n\r]/.test(s) ? `"${s}"` : s;
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/png': 'png',  'image/gif': 'gif',
  'image/webp': 'webp','image/avif': 'avif',
};
const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png',  '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif',
};

if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR);

function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Telegram bot (для dev режима) ──────────────────────────
let TG_TOKEN_DEV = '';
let TG_CHAT_ID_DEV = '';
try {
  const cfg = fs.readFileSync(path.resolve(__dirname, 'telegram.config.js'), 'utf8');
  const tokenMatch  = cfg.match(/TG_TOKEN\s*=\s*['"]([^'"]+)['"]/);
  const chatMatch   = cfg.match(/TG_CHAT_ID\s*=\s*['"]([^'"]+)['"]/);
  TG_TOKEN_DEV   = tokenMatch?.[1] ?? '';
  TG_CHAT_ID_DEV = chatMatch?.[1]  ?? '';
} catch {}

const BOT_ACTIVE_DEV = TG_TOKEN_DEV && !TG_TOKEN_DEV.includes('ВСТАВЬ');

function tgRequestDev(method: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN_DEV}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { let r = ''; res.on('data', c => r += c); res.on('end', () => resolve(JSON.parse(r))); });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

async function tgSendDev(text: string, chatId?: string) {
  if (!BOT_ACTIVE_DEV) return;
  try {
    await tgRequestDev('sendMessage', { chat_id: chatId ?? TG_CHAT_ID_DEV, text, parse_mode: 'HTML' });
  } catch (e: any) { console.error('[tg-dev]', e.message); }
}

function formatGuestsListDev(): string {
  const raw = fs.readFileSync(GUESTS_CSV, 'utf8').replace(/^\ufeff/, '');
  const lines = raw.trim().split('\n').slice(1).filter(Boolean);
  if (!lines.length) return '📋 Пока никто не оставил заявку.';
  let msg = `<b>📋 Гости (${lines.length}):</b>\n\n`;
  lines.forEach((line, i) => {
    const cols = line.split(';').map((c: string) => c.replace(/^"|"$/g, '').replace(/""/g, '"'));
    const [name, phone, status, plusOne, hot, salad, wish] = cols;
    const icon = status === 'Придёт' ? '✅' : '❌';
    msg += `${i + 1}. ${icon} <b>${name}</b>`;
    if (phone) msg += ` · ${phone}`;
    if (plusOne === 'Да') msg += ' · +1';
    msg += '\n';
    if (hot)   msg += `   🍖 ${hot}\n`;
    if (salad) msg += `   🥗 ${salad}\n`;
    if (wish)  msg += `   💬 ${wish}\n`;
    msg += '\n';
  });
  return msg.trim();
}

// chat_id сохраняется в файл — не теряется при перезапуске
const ADMIN_CHAT_FILE = path.resolve(__dirname, '.admin_chat_id');
let _adminChatId = (() => {
  try { return fs.readFileSync(ADMIN_CHAT_FILE, 'utf8').trim(); } catch { return TG_CHAT_ID_DEV; }
})();
function saveAdminChatId(id: string) {
  _adminChatId = id;
  try { fs.writeFileSync(ADMIN_CHAT_FILE, id, 'utf8'); } catch {}
}

let _pollOffset = 0;
async function startPollingDev() {
  if (!BOT_ACTIVE_DEV) return;
  console.log('  🤖 Telegram бот запущен (dev)');
  const poll = async () => {
    try {
      const data = await tgRequestDev('getUpdates', { offset: _pollOffset, timeout: 25, allowed_updates: ['message'] });
      if (data.ok) for (const u of data.result) {
        _pollOffset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        const from = String(m.chat.id);
        saveAdminChatId(from);
        console.log(`[tg] chat_id=${from} (сохранён): ${m.text}`);

        const cmd = m.text.trim().toLowerCase().replace(/@\w+/, '');
        if (cmd === '/guests') {
          await tgSendDev(formatGuestsListDev(), from);
        } else if (cmd === '/start' || cmd === '/myid') {
          await tgSendDev(
            `👋 Твой <b>chat_id</b>: <code>${from}</code>\n\n` +
            `Теперь уведомления будут приходить сюда.\n\n` +
            `/guests — список гостей`,
            from
          );
        }
      }
    } catch (e: any) { console.error('[tg-dev] poll:', e.message); }
    setTimeout(poll, 1500);
  };
  poll();
}

startPollingDev();

function weddingApiPlugin() {
  return {
    name: 'wedding-api',
    configureServer(server: { middlewares: Connect.Server }) {
      // GET /api/tg-test
      server.middlewares.use('/api/tg-test', async (_req: IncomingMessage, res: ServerResponse) => {
        try {
          const meRes = await tgRequestDev('getMe', {});
          const sendRes = await tgRequestDev('sendMessage', {
            chat_id: TG_CHAT_ID_DEV,
            text: '✅ Тест! Бот работает.',
            parse_mode: 'HTML',
          });
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ token_ok: meRes.ok, bot: meRes.result?.username, chat_id: TG_CHAT_ID_DEV, send: sendRes }, null, 2));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // GET /api/photos
      server.middlewares.use('/api/photos', (_req: IncomingMessage, res: ServerResponse) => {
        const files = fs.readdirSync(PHOTOS_DIR)
          .filter(f => IMAGE_RE.test(f))
          .sort((a, b) => (parseInt(a) || 0) - (parseInt(b) || 0));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(files));
      });

      // POST /api/rsvp
      server.middlewares.use('/api/rsvp', async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (req.method !== 'POST') { next(); return; }
        try {
          const body = await collectBody(req);
          const d = JSON.parse(body.toString('utf8'));
          const row = [
            d.name    ?? '',
            d.phone   ?? '',
            d.attend === 'yes' ? 'Придёт' : 'Не придёт',
            d.plusOne ? 'Да' : 'Нет',
            d.hot     ?? '',
            d.salad   ?? '',
            d.wish    ?? '',
            new Date().toLocaleString('ru-RU'),
          ].map(csvEscape).join(';') + '\n';
          fs.appendFileSync(GUESTS_CSV, row, 'utf8');
          console.log(`[rsvp] ✓ ${d.name} — ${d.attend === 'yes' ? 'придёт' : 'не придёт'}`);

          const icon = d.attend === 'yes' ? '✅' : '❌';
          let tgMsg = `${icon} <b>Новый гость!</b>\n\n👤 <b>${d.name}</b>\n`;
          if (d.phone)  tgMsg += `📞 ${d.phone}\n`;
          tgMsg += `Статус: ${d.attend === 'yes' ? 'Придёт' : 'Не придёт'}\n`;
          if (d.plusOne) tgMsg += `+1: Да\n`;
          if (d.hot)     tgMsg += `🍖 ${d.hot}\n`;
          if (d.salad)   tgMsg += `🥗 ${d.salad}\n`;
          if (d.wish)    tgMsg += `💬 ${d.wish}\n`;
          tgSendDev(tgMsg, _adminChatId);
          console.log(`[tg] уведомление → chat_id=${_adminChatId}`);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[rsvp] ошибка:', msg);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: msg }));
        }
      });

      // POST /api/upload
      server.middlewares.use('/api/upload', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        try {
          const contentType = ((req.headers['content-type'] as string) || '').split(';')[0].trim().toLowerCase();
          const ext = MIME_EXT[contentType];
          if (!ext) { res.statusCode = 415; res.end(JSON.stringify({ error: `Unknown type: ${contentType}` })); return; }

          const rawName = (req.headers['x-filename'] as string) || 'photo';
          const baseName = decodeURIComponent(rawName)
            .replace(/\.[^.]+$/, '')
            .replace(/[^a-zA-Z0-9._-]/g, '_')
            .slice(0, 60);

          const safeName = `${Date.now()}_${baseName}.${ext}`;
          const body = await collectBody(req);
          fs.writeFileSync(path.join(PHOTOS_DIR, safeName), body);
          console.log(`[upload] ✓ ${safeName} (${(body.length / 1024).toFixed(1)} KB)`);

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ filename: safeName }));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error('[upload] error:', msg);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: msg }));
        }
      });

      // GET /photos/:file
      server.middlewares.use('/photos', (req: IncomingMessage, res: ServerResponse) => {
        const filename = path.basename(req.url || '');
        const filePath = path.join(PHOTOS_DIR, filename);
        if (fs.existsSync(filePath) && IMAGE_RE.test(filename)) {
          const mime = EXT_MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream';
          res.setHeader('Content-Type', mime);
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.statusCode = 404; res.end('Not found');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [weddingApiPlugin()],
  // index.html в корне — Vite найдёт его сам
});