import express from 'express';
import pkg from 'pg';
import basicAuth from 'basic-auth';
const { Pool } = pkg;

// ======= Config =======
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// Conexão com PostgreSQL (usa DATABASE_URL ou variáveis PG*)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.PGHOST,
  port: process.env.PGPORT ? Number(process.env.PGPORT) : undefined,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
});

// Schemas e tabelas fixos
const PGSCHEMA = process.env.PGSCHEMA || 'public';
const T_INSTANCE = `${PGSCHEMA}."Instance"`;
const T_CHAT = `${PGSCHEMA}."Chat"`;
const T_MESSAGE = `${PGSCHEMA}."Message"`;

// ======= Auth (opcional, mas recomendado) =======
function authMiddleware(req, res, next) {
  if (!ADMIN_PASSWORD) return next(); // sem senha -> aberto (use somente em redes privadas!)
  const creds = basicAuth(req);
  if (!creds || creds.name !== ADMIN_USER || creds.pass !== ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Protected"');
    return res.status(401).send('Auth required');
  }
  next();
}

// ======= App =======
const app = express();
app.use(express.json({ limit: '2mb' }));

// Saúde
app.get('/health', async (req, res) => {
  try {
    const r = await pool.query('SELECT 1');
    res.json({ ok: true, db: r.rows[0]['?column?'] === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ======= API: Lista Instâncias =======
app.get('/api/instances', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, number, "connectionStatus", "updatedAt" FROM ${T_INSTANCE} ORDER BY name ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======= API: Lista Chats por Instância =======
app.get('/api/chats', authMiddleware, async (req, res) => {
  const instanceId = (req.query.instanceId||'').toString();
  const q = (req.query.q||'').toString().trim();
  const limit = Math.min(parseInt(req.query.limit||'50',10), 200);
  const page = Math.max(parseInt(req.query.page||'0',10), 0);
  if (!instanceId) return res.status(400).json({ error: 'instanceId é obrigatório' });
  const params = [instanceId];
  let where = 'WHERE "instanceId" = $1';
  if (q) {
    params.push('%'+q+'%');
    where += ` AND ( "remoteJid" ILIKE $${params.length} OR COALESCE(name,'') ILIKE $${params.length} )`;
  }
  params.push(limit, page*limit);
  try {
    const sql = `SELECT id, "remoteJid", name, "updatedAt" FROM ${T_CHAT} ${where}
                 ORDER BY "updatedAt" DESC NULLS LAST
                 LIMIT $${params.length-1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======= Util: extrai campos de mídia dos JSONs =======
function extractMedia(message) {
  if (!message || typeof message !== 'object') return null;
  const get = (o, path) => path.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), o);

  // Possíveis tipos com mídia
  const candidates = [
    { type: 'image', path: 'imageMessage' },
    { type: 'video', path: 'videoMessage' },
    { type: 'document', path: 'documentMessage' },
    { type: 'audio', path: 'audioMessage' },
    { type: 'sticker', path: 'stickerMessage' }
  ];
  for (const c of candidates) {
    const node = get(message, c.path);
    if (node) {
      const caption = node.caption || node.text || '';
      const mimetype = node.mimetype || '';
      const fileName = node.fileName || '';
      const fileLength = node.fileLength || node.seconds || '';
      const directPath = node.directPath || node.url || ''; // nem sempre presente
      const jpegThumb = node.jpegThumbnail || null; // base64 (quando existir)
      return { kind: c.type, caption, mimetype, fileName, fileLength, directPath, jpegThumbnail: jpegThumb };
    }
  }
  return null;
}

// ======= API: Lista Mensagens (por instância e chat) =======
app.get('/api/messages', authMiddleware, async (req, res) => {
  const instanceId = (req.query.instanceId||'').toString();
  const remoteJid = (req.query.remoteJid||'').toString();
  const text = (req.query.text||'').toString().trim();
  const direction = (req.query.direction||'').toString().trim(); // '' | 'in' | 'out'
  const start = (req.query.start||'').toString().trim();
  const end = (req.query.end||'').toString().trim();
  const limit = Math.min(parseInt(req.query.limit||'50',10), 500);
  const page = Math.max(parseInt(req.query.page||'0',10), 0);
  if (!instanceId || !remoteJid) return res.status(400).json({ error: 'instanceId e remoteJid são obrigatórios' });

  const params = [instanceId, remoteJid];
  const where = [
    '"instanceId" = $1',
    "(key->>'remoteJid') = $2"
  ];
  if (text) {
    params.push('%'+text+'%');
    where.push(`(
      message->>'conversation' ILIKE $${params.length}
      OR message->'extendedTextMessage'->>'text' ILIKE $${params.length}
      OR message->'imageMessage'->>'caption' ILIKE $${params.length}
      OR message->'videoMessage'->>'caption' ILIKE $${params.length}
      OR message->'documentMessage'->>'caption' ILIKE $${params.length}
    )`);
  }
  if (direction === 'in' || direction === 'out') {
    params.push(direction === 'out');
    where.push(`(key->>'fromMe')::boolean = $${params.length}`);
  }
  if (start) { params.push(new Date(start).getTime()/1000); where.push(`"messageTimestamp" >= $${params.length}`); }
  if (end) { params.push(new Date(end).getTime()/1000); where.push(`"messageTimestamp" <= $${params.length}`); }

  const baseSelect = `SELECT
      id,
      key,
      message,
      (key->>'remoteJid') AS "remoteJid",
      (key->>'fromMe')::boolean AS from_me,
      "messageType" AS type,
      status,
      to_timestamp("messageTimestamp") AT TIME ZONE 'UTC' AS when_utc
    FROM ${T_MESSAGE}`;

  const whereSql = 'WHERE ' + where.join(' AND ');
  const orderSql = 'ORDER BY "messageTimestamp" DESC';

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${T_MESSAGE} ${whereSql}`, params)).rows[0].n;
    const dataParams = params.concat([limit, page*limit]);
    const { rows } = await pool.query(`${baseSelect} ${whereSql} ${orderSql} LIMIT $${params.length+1} OFFSET $${params.length+2}`, dataParams);

    const out = rows.map(r => {
      // texto
      const text =
        (r.message?.conversation) ||
        (r.message?.extendedTextMessage?.text) ||
        (r.message?.imageMessage?.caption) ||
        (r.message?.videoMessage?.caption) ||
        (r.message?.documentMessage?.caption) ||
        (r.message?.contactMessage?.displayName) ||
        '';

    const media = extractMedia(r.message);

      return {
        id: r.id,
        jid: r.remoteJid,
        when: new Date(r.when_utc).toISOString().replace('T',' ').slice(0,19),
        direction: r.from_me ? 'out' : 'in',
        type: r.type,
        text: text,
        status: r.status || '',
        media: media
      };
    });
    res.json({ total, rows: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ======= API: Mensagem por ID (raw JSON para debug/integração) =======
app.get('/api/messages/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  try {
    const { rows } = await pool.query(`SELECT id, key, message, "messageType", status, "messageTimestamp" FROM ${T_MESSAGE} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======= Export CSV =======
app.get('/api/messages.csv', authMiddleware, async (req, res) => {
  req.query.limit = req.query.limit || '2000';
  req.query.page = req.query.page || '0';
  const params = new URLSearchParams(req.query);
  const url = `http://127.0.0.1:${PORT}/api/messages?${params.toString()}`;
  const r = await fetch(url);
  const json = await r.json();
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="messages.csv"');
  const header = 'id,when,direction,jid,type,text,status\n';
  const body = json.rows.map(m => [m.id,m.when,m.direction,m.jid,m.type,(m.text||'').replaceAll('\n',' ').replaceAll('"','""'),m.status]
      .map(v => '"'+(v??'')+'"').join(',')).join('\n');
  res.send(header+body+'\n');
});

// ======= UI =======
app.get('/', authMiddleware, (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="pt-br">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Evolution Messages Viewer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <style>
    :root { --bg:#0b1020; --card:#11183a; --muted:#9fb0ff; --fg:#e9edff; --accent:#6ea8ff; }
    body{margin:0;font-family:Inter,system-ui,Segoe UI,Roboto,Arial;background:linear-gradient(120deg,#0b1020,#0e1440);color:var(--fg)}
    .wrap{max-width:1200px;margin:0 auto;padding:24px}
    .card{background:linear-gradient(180deg,#11183a 0%, #0f1634 100%);border:1px solid #1c2b6c;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
    .h{font-weight:700;letter-spacing:.2px}
    .muted{color:var(--muted)}
    .grid{display:grid;gap:12px}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    input,select,button{background:#0b1230;color:var(--fg);border:1px solid #1c2b6c;border-radius:10px;padding:10px 12px}
    button{cursor:pointer}
    table{width:100%;border-collapse:collapse}
    th,td{padding:10px;border-bottom:1px solid #1c2b6c;vertical-align:top}
    th{position:sticky;top:0;background:#0b1230}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#0b1230;border:1px solid #1c2b6c;font-size:12px}
    .footer{opacity:.7;font-size:12px}
    a{color:var(--accent)}
    .media{display:flex;align-items:center;gap:8px}
    .thumb{width:56px;height:56px;object-fit:cover;border-radius:8px;border:1px solid #1c2b6c}
  </style>
</head>
<body>
  <div class="wrap" x-data="viewer()">
    <h1 class="h">Evolution Messages Viewer</h1>
    <p class="muted">Fluxo: Instância → Chat → Mensagens (somente leitura). Suporte a <b>preview de mídia</b> e <b>copiar texto</b>.</p>

    <div class="card" style="padding:16px; margin:16px 0;">
      <div class="grid" style="grid-template-columns: repeat(auto-fit,minmax(220px,1fr));">
        <div>
          <label>Instância</label>
          <select x-model="q.instanceId" @change="loadChats(0)">
            <option value="">Selecione…</option>
            <template x-for="i in instances" :key="i.id">
              <option :value="i.id" x-text="i.name + (i.number? ' ('+i.number+')':'')"></option>
            </template>
          </select>
        </div>
        <div>
          <label>Chat (JID ou Nome)</label>
          <input x-model="q.chatQuery" placeholder="pesquisar chats…" @input.debounce.300ms="loadChats(0)" />
        </div>
        <div>
          <label>Contato selecionado</label>
          <select x-model="q.remoteJid" @change="fetchMessages(0)">
            <option value="">—</option>
            <template x-for="c in chats" :key="c.id">
              <option :value="c.remoteJid" x-text="(c.name? c.name+' — ':'') + c.remoteJid"></option>
            </template>
          </select>
        </div>
        <div>
          <label>Texto</label>
          <input x-model="q.text" placeholder="contém…" />
        </div>
        <div>
          <label>Direção</label>
          <select x-model="q.direction">
            <option value="">Todas</option>
            <option value="in">Entrada</option>
            <option value="out">Saída</option>
          </select>
        </div>
        <div>
          <label>Início</label>
          <input type="datetime-local" x-model="q.start" />
        </div>
        <div>
          <label>Fim</label>
          <input type="datetime-local" x-model="q.end" />
        </div>
        <div>
          <label>Limite</label>
          <select x-model.number="q.limit">
            <option>25</option><option>50</option><option>100</option><option>200</option>
          </select>
        </div>
      </div>
      <div class="row" style="margin-top:12px;align-items:center;">
        <button @click="fetchMessages(0)" :disabled="!q.instanceId || !q.remoteJid">Buscar</button>
        <a :class="{muted: !q.instanceId || !q.remoteJid}" :href="exportUrl" target="_blank">Exportar CSV</a>
        <span class="footer" x-text="meta"></span>
      </div>
    </div>

    <div class="card" style="padding:0; overflow:auto; max-height:70vh;">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Quando</th>
            <th>Dir</th>
            <th>JID</th>
            <th>Tipo</th>
            <th>Conteúdo</th>
            <th>Status</th>
            <th>Ações</th>
          </tr>
        </thead>
        <tbody>
          <template x-for="m in rows" :key="m.id">
            <tr>
              <td x-text="m.id"></td>
              <td x-text="m.when"></td>
              <td><span class="badge" x-text="m.direction"></span></td>
              <td x-text="m.jid"></td>
              <td x-text="m.type"></td>
              <td>
                <div class="media">
                  <template x-if="m.media && m.media.kind==='image' && m.media.jpegThumbnail">
                    <img class="thumb" :src="'data:image/jpeg;base64,'+m.media.jpegThumbnail" alt="thumb" />
                  </template>
                  <div>
                    <div x-text="m.text"></div>
                    <template x-if="m.media">
                      <div class="muted" style="font-size:12px;">
                        <span x-text="m.media.kind"></span>
                        <template x-if="m.media.fileName"> • <span x-text="m.media.fileName"></span></template>
                        <template x-if="m.media.mimetype"> • <span x-text="m.media.mimetype"></span></template>
                        <template x-if="m.media.fileLength"> • <span x-text="m.media.fileLength"></span></template>
                        <template x-if="m.media.directPath">
                          • <a :href="m.media.directPath" target="_blank">arquivo</a>
                        </template>
                      </div>
                    </template>
                  </div>
                </div>
              </td>
              <td x-text="m.status"></td>
              <td>
                <button @click="copy(m.text)">Copiar</button>
                <a :href="'/api/messages/'+m.id" target="_blank">JSON</a>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="row" style="margin-top:12px;">
      <button @click="prev()">◀ Anterior</button>
      <button @click="next()">Próximo ▶</button>
    </div>

    <p class="footer" style="margin-top:16px;">Tabelas: <code>${T_INSTANCE}</code>, <code>${T_CHAT}</code>, <code>${T_MESSAGE}</code></p>
  </div>

<script>
function viewer(){
  return {
    instances: [],
    chats: [],
    q: { instanceId:'', chatQuery:'', remoteJid:'', text:'', direction:'', start:'', end:'', limit:50 },
    page: 0,
    rows: [],
    meta: '',
    get exportUrl(){
      if(!this.q.instanceId || !this.q.remoteJid) return '#';
      const p = new URLSearchParams({ ...this.q, page: this.page });
      return '/api/messages.csv?' + p.toString();
    },
    async loadInstances(){
      const r = await fetch('/api/instances');
      this.instances = await r.json();
    },
    async loadChats(page){
      if(page!==undefined) this.page = page;
      if(!this.q.instanceId) { this.chats=[]; this.q.remoteJid=''; return; }
      const p = new URLSearchParams({ instanceId: this.q.instanceId, q: this.q.chatQuery, page: this.page, limit: 50 });
      const r = await fetch('/api/chats?' + p.toString());
      this.chats = await r.json();
    },
    async fetchMessages(page){
      if(page!==undefined) this.page = page;
      const p = new URLSearchParams({ ...this.q, page:this.page });
      const r = await fetch('/api/messages?'+p.toString());
      const json = await r.json();
      this.rows = json.rows;
      this.meta = 'Exibindo ' + json.rows.length + ' de ' + json.total + ' registros (página ' + (this.page+1) + ').';
    },
    next(){ this.page++; this.fetchMessages(); },
    prev(){ if(this.page>0){ this.page--; this.fetchMessages(); } },
    copy(text){ if (!text) return; navigator.clipboard.writeText(text); },
    init(){ this.loadInstances(); }
  }
}
</script>
</body>
</html>`);
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`Evolution Messages Viewer rodando em http://0.0.0.0:${PORT}`);
});
