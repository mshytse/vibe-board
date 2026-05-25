const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 3000;
const HOST = process.env.HOST || '127.0.0.1';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const agent = new https.Agent({ keepAlive: true, maxSockets: 30 });

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.png':  'image/png',
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2));
}

function jiraRequest(config, jiraPath, cb) {
  const base = config.jiraUrl.replace(/\/$/, '');
  const reqUrl = url.parse(`${base}${jiraPath}`);
  const auth = Buffer.from(`${config.email}:${config.token}`).toString('base64');

  const options = {
    hostname: reqUrl.hostname,
    port: reqUrl.port || 443,
    path: reqUrl.path,
    method: 'GET',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
  };

  const req = https.request({ ...options, agent }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => cb(null, res.statusCode, body));
  });
  req.on('error', err => cb(err));
  req.end();
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── API: proxy to Jira ──
  if (pathname.startsWith('/api/jira/')) {
    const config = loadConfig();
    if (!config.jiraUrl || !config.email || !config.token) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not configured' }));
      return;
    }
    // Strip /api/jira prefix, forward the rest as-is (including query string)
    const jiraPath = req.url.replace('/api/jira', '');
    jiraRequest(config, jiraPath, (err, status, body) => {
      if (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    return;
  }

  // ── API: read settings ──
  if (pathname === '/api/settings' && req.method === 'GET') {
    const config = loadConfig();
    // Never expose the token to the browser
    const safe = { ...config, token: config.token ? '••••••••' : '' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(safe));
    return;
  }

  // ── API: save settings ──
  if (pathname === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const incoming = JSON.parse(body);
        const existing = loadConfig();
        // Keep old token if placeholder was sent (user didn't change it)
        if (incoming.token === '••••••••') incoming.token = existing.token || '';
        saveConfig(incoming);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Static files ──
  let filePath = pathname === '/' ? '/dashboard.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Team dashboard running at http://localhost:${PORT}`);
  console.log(`Settings page: http://localhost:${PORT}/settings.html`);
});
