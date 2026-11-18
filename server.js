'use strict';
/**
 * CodeBase server. No dependencies; needs Node 18 or later.
 *
 *   GET  /                    the editor (static files in public/)
 *   POST /api/preview/:id     store a project for previewing; served at /preview/:id/
 *   POST /api/publish         host a project at /s/:slug/
 *   POST /api/ai              proxy a chat request to the user's AI provider and stream the reply
 *   GET  /api/config          what the client needs to know (currently: the optional built-in model)
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = +process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const SITES = path.join(DATA, 'sites');
const META = path.join(DATA, 'meta');
const MAX_BODY = 25 * 1024 * 1024;

// Optional built-in model that every visitor can use for free, paid for by whoever runs the site.
// Turned on only when the owner sets these; the key never reaches the browser.
const BUILTIN =
  process.env.BUILTIN_AI_MODEL && process.env.BUILTIN_AI_URL
    ? {
        name: process.env.BUILTIN_AI_NAME || process.env.BUILTIN_AI_MODEL,
        kind: process.env.BUILTIN_AI_PROVIDER === 'anthropic' ? 'anthropic' : 'openai',
        baseUrl: process.env.BUILTIN_AI_URL,
        model: process.env.BUILTIN_AI_MODEL,
        apiKey: process.env.BUILTIN_AI_KEY || '',
        hourly: +process.env.BUILTIN_AI_HOURLY_LIMIT || 200,
      }
    : null;
const usage = new Map(); // ip -> { hour, n }
function takeBuiltinQuota(req) {
  const ip = req.socket.remoteAddress || '?',
    hour = Math.floor(Date.now() / 3600e3);
  let u = usage.get(ip);
  if (!u || u.hour !== hour) {
    u = { hour, n: 0 };
    usage.set(ip, u);
  }
  if (usage.size > 10000) for (const [k, v] of usage) if (v.hour !== hour) usage.delete(k);
  if (++u.n > BUILTIN.hourly)
    throw httpError(
      429,
      `You've used the free built-in model ${BUILTIN.hourly} times this hour. Try again later, or switch to the on-device model or your own.`,
    );
}

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  webmanifest: 'application/manifest+json',
};
const mime = p => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';

// User-made pages are served on the IDE's own origin, so they run sandboxed (opaque origin):
// they can never read the IDE's saved API key or another site's data.
const SITE_HEADERS = {
  'Content-Security-Policy':
    'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

// A sandboxed page has no localStorage; give it an in-memory one so apps don't crash.
const STORAGE_SHIM = `(function(){function mem(){var d={};return{getItem:function(k){return k in d?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
['localStorage','sessionStorage'].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:mem(),configurable:true})}catch(_){}}})})();`;

const UA = {
  iphone: [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'iPhone',
    5,
  ],
  android: [
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'Linux armv81',
    5,
  ],
  windows: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Win32',
    0,
  ],
  mac: [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'MacIntel',
    0,
  ],
};
// Preview only: report console output + errors to the IDE, and make the page see the chosen device's identity.
const previewShim = device => `(function(){var ua=${JSON.stringify(UA[device] || null)};
if(ua){try{Object.defineProperty(navigator,'userAgent',{get:function(){return ua[0]}});Object.defineProperty(navigator,'platform',{get:function(){return ua[1]}});Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return ua[2]}})}catch(e){}}
function fmt(a){if(a instanceof Error)return a.stack||a.message;if(typeof a==='object'&&a!==null){try{return JSON.stringify(a)}catch(e){}}return String(a)}
function send(l,args){try{parent.postMessage({__cb:1,level:l,text:args.map(fmt).join(' ')},'*')}catch(e){}}
['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){send(l,[].slice.call(arguments));o.apply(console,arguments)}});
window.addEventListener('error',function(e){var t=e.target;if(t&&t!==window&&(t.src||t.href))send('error',['Failed to load '+(t.src||t.href).split('/').pop()]);else send('error',[(e.message||'Error')+' ('+String(e.filename||'').split('/').pop().split('?')[0]+':'+e.lineno+')'])},true);
window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled promise rejection: '+(e.reason&&e.reason.message||e.reason)])});})();`;

function inject(html, js) {
  const tag = `<script>${js}</script>`;
  for (const re of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  }
  return tag + html;
}

const safePath = p =>
  typeof p === 'string' && p.length < 300 && p.split('/').every(s => /^[\w.\- ]+$/.test(s) && s !== '.' && s !== '..');

function cleanFiles(files) {
  if (!files || typeof files !== 'object') throw httpError(400, 'No files');
  const out = {};
  for (const [p, f] of Object.entries(files)) {
    if (!safePath(p) || !f || typeof f.content !== 'string') throw httpError(400, 'Bad file: ' + p);
    out[p] = Buffer.from(f.content, f.b64 ? 'base64' : 'utf8');
  }
  return out;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(httpError(413, 'Project too large (25 MB max)'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendSiteFile(res, p, buf, shim) {
  if (/\.html?$/i.test(p)) buf = Buffer.from(inject(buf.toString('utf8'), shim));
  res.writeHead(200, { 'content-type': mime(p), ...SITE_HEADERS });
  res.end(buf);
}
const notFound = (res, what) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...SITE_HEADERS });
  res.end('Not found: ' + what);
};

// ---------- preview (kept in memory) ----------
const previews = new Map();
async function setPreview(id, req, res) {
  const body = await readBody(req);
  previews.delete(id);
  previews.set(id, { files: cleanFiles(body.files), device: String(body.device || '') });
  while (previews.size > 50) previews.delete(previews.keys().next().value);
  json(res, 200, { ok: true });
}
function getPreview(id, rel, res) {
  const pv = previews.get(id);
  if (!pv) return notFound(res, 'This preview has expired. Press Run to refresh it.');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  let buf = pv.files[rel];
  if (!buf) return notFound(res, rel);
  // Sandboxed pages only get full error messages from scripts loaded with CORS, so opt local scripts in.
  if (/\.html?$/i.test(rel))
    buf = Buffer.from(
      buf
        .toString('utf8')
        .replace(
          /<script\b(?![^>]*\bcrossorigin)(?=[^>]*\ssrc\s*=\s*["']?(?![a-z][a-z0-9+.-]*:|\/\/))/gi,
          '<script crossorigin',
        ),
    );
  sendSiteFile(res, rel, buf, STORAGE_SHIM + previewShim(pv.device));
}

// ---------- publishing (kept on disk) ----------
const hash = t => crypto.createHash('sha256').update(t).digest('hex');
async function publish(req, res) {
  const body = await readBody(req);
  const slug = String(body.slug || '').toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug))
    throw httpError(400, 'Use 2 to 41 lowercase letters, numbers or dashes for the site name.');
  const files = cleanFiles(body.files);
  if (!Object.keys(files).some(p => /\.html?$/i.test(p)))
    throw httpError(400, 'The project needs at least one HTML page.');
  await fsp.mkdir(META, { recursive: true });
  const metaFile = path.join(META, slug + '.json');
  let token = String(body.token || '');
  const meta = await fsp.readFile(metaFile, 'utf8').then(JSON.parse, () => null);
  if (meta) {
    if (!token || hash(token) !== meta.hash) throw httpError(403, `The name "${slug}" is taken. Try another one.`);
  } else {
    token = crypto.randomBytes(24).toString('hex');
    await fsp.writeFile(metaFile, JSON.stringify({ hash: hash(token), created: Date.now() }));
  }
  const dir = path.join(SITES, slug);
  await fsp.rm(dir, { recursive: true, force: true });
  for (const [p, buf] of Object.entries(files)) {
    const dest = path.join(dir, p);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, buf);
  }
  json(res, 200, { slug, token });
}
async function getSite(slug, rel, res) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) return notFound(res, slug);
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  if (!safePath(rel)) return notFound(res, rel);
  const buf = await fsp.readFile(path.join(SITES, slug, rel)).catch(() => null);
  if (!buf) return notFound(res, rel);
  sendSiteFile(res, rel, buf, STORAGE_SHIM);
}

// ---------- AI proxy: forwards to whichever provider the user connected ----------
async function ai(req, res) {
  const b = await readBody(req);
  if (b.builtin) {
    if (!BUILTIN) throw httpError(400, 'This site has no built-in server model.');
    takeBuiltinQuota(req);
    Object.assign(b, {
      kind: BUILTIN.kind,
      baseUrl: BUILTIN.baseUrl,
      model: BUILTIN.model,
      apiKey: BUILTIN.apiKey,
      maxTokens: Math.min(+b.maxTokens || 8000, 8000),
    });
  }
  const base = String(b.baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base) || !b.model) throw httpError(400, 'Set the AI address and model first.');
  let url, headers, payload;
  if (b.kind === 'anthropic') {
    url = base.replace(/\/v1$/, '') + '/v1/messages';
    headers = { 'x-api-key': b.apiKey || '', 'anthropic-version': '2023-06-01' };
    payload = {
      model: b.model,
      max_tokens: b.maxTokens || 16000,
      system: b.system,
      messages: b.messages,
      stream: true,
    };
  } else {
    url = base + '/chat/completions';
    headers = b.apiKey ? { authorization: 'Bearer ' + b.apiKey } : {};
    payload = { model: b.model, messages: [{ role: 'system', content: b.system || '' }, ...b.messages], stream: true };
  }
  const ctl = new AbortController();
  res.on('close', () => ctl.abort());
  let up;
  try {
    up = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
  } catch (e) {
    throw httpError(502, `Could not reach ${new URL(url).host}: ${e.cause?.code || e.message}`);
  }
  if (!up.ok) {
    let text = await up.text();
    try {
      const j = JSON.parse(text);
      text = j.error?.message || j.error || j.message || text;
    } catch {}
    throw httpError(
      502,
      `AI provider said ${up.status}: ${String(typeof text === 'string' ? text : JSON.stringify(text)).slice(0, 500)}`,
    );
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
  try {
    for await (const chunk of up.body) res.write(chunk);
  } catch {}
  res.end();
}

// ---------- static ----------
async function serveStatic(rel, res) {
  if (!rel) rel = 'index.html';
  if (!safePath(rel)) return json(res, 404, { error: 'Not found' });
  const buf = await fsp.readFile(path.join(ROOT, rel)).catch(() => null);
  if (!buf) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': mime(rel), 'cache-control': 'no-cache' });
  res.end(buf);
}

http
  .createServer(async (req, res) => {
    try {
      let p;
      try {
        p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      } catch {
        throw httpError(400, 'Bad URL');
      }
      let m;
      if (req.method === 'POST') {
        if ((m = /^\/api\/preview\/([\w-]{1,64})$/.exec(p))) return await setPreview(m[1], req, res);
        if (p === '/api/publish') return await publish(req, res);
        if (p === '/api/ai') return await ai(req, res);
        throw httpError(404, 'Not found');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
      if (p === '/api/config') return json(res, 200, { builtin: BUILTIN && { name: BUILTIN.name } });
      if ((m = /^\/preview\/([\w-]{1,64})\/(.*)$/.exec(p))) return getPreview(m[1], m[2], res);
      if ((m = /^\/s\/([^/]+)$/.exec(p))) {
        res.writeHead(302, { location: `/s/${m[1]}/` });
        return res.end();
      }
      if ((m = /^\/s\/([^/]+)\/(.*)$/.exec(p))) return await getSite(m[1], m[2], res);
      await serveStatic(p.slice(1), res);
    } catch (e) {
      if (res.headersSent) return res.end();
      json(res, e.status || 500, { error: e.message || 'Server error' });
    }
  })
  .listen(PORT, () => console.log(`CodeBase running at http://localhost:${PORT}`));
