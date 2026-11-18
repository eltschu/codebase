'use strict';
/**
 * CodeBase server. No dependencies; needs Node 18 or later.
 *
 *   GET  /                    the editor (static files in public/)
 *   POST /api/preview/:id     store a project for previewing; served at /preview/:id/
 *   POST /api/publish         host a project at /s/:slug/
 *   POST /api/ai              proxy a chat request to the user's AI provider and stream the reply
 *   POST /api/models          list the models a provider offers, for the connect dialog
 *   GET  /api/config          what the client needs to know: built-in model, account settings
 *
 *   POST /api/auth/signup | signin | signout, GET /api/me      accounts (see lib/accounts.js)
 *   POST /api/account/password, POST /api/account/delete      change password, delete the account
 *   GET  /api/projects, GET|PUT|DELETE /api/projects/:id     projects saved to the signed-in account
 *   GET  /api/sites, DELETE /api/sites/:slug                 sites the signed-in account published
 *
 * Settings come from environment variables; see the README.
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { createAccounts } = require('./lib/accounts');

const PORT = +process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const SITES = path.join(DATA, 'sites');
const META = path.join(DATA, 'meta');
const MAX_BODY = 25 * 1024 * 1024;
const flag = v => /^(1|true|yes|on)$/i.test(v || '');
// Accounts are on unless turned off. REQUIRE_ACCOUNT limits the AI proxy and publishing to signed-in users,
// which is what you want on a public server. ALLOW_SIGNUP=false stops new sign-ups once your own account exists.
const ACCOUNTS = !/^(0|false|no|off)$/i.test(process.env.ACCOUNTS || '');
const REQUIRE_ACCOUNT = ACCOUNTS && flag(process.env.REQUIRE_ACCOUNT);
const ALLOW_SIGNUP = !/^(0|false|no|off)$/i.test(process.env.ALLOW_SIGNUP || '');
const DESKTOP = flag(process.env.CODEBASE_DESKTOP);
const ALLOW_PRIVATE_AI = flag(process.env.ALLOW_PRIVATE_AI); // set by the desktop app, which runs this server locally
const DOWNLOAD_URL = process.env.DESKTOP_DOWNLOAD_URL || 'https://github.com/eltschu/codebase/releases/latest';
const accounts = createAccounts(DATA);

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
function takeBuiltinQuota(req, account) {
  const ip = account ? 'account:' + account.id : req.socket.remoteAddress || '?',
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
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.trim() ? JSON.parse(text) : {});
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
async function publish(req, res, account) {
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
    // The site's owner can update it: either the account that published it, or whoever holds its token.
    const isOwner = (account && meta.owner === account.id) || (token && hash(token) === meta.hash);
    if (!isOwner) throw httpError(403, `The name "${slug}" is taken. Try another one.`);
    if (!token || hash(token) !== meta.hash) {
      token = crypto.randomBytes(24).toString('hex');
      meta.hash = hash(token);
    }
    if (account && !meta.owner) meta.owner = account.id;
    meta.updated = Date.now();
    await fsp.writeFile(metaFile, JSON.stringify(meta));
  } else {
    token = crypto.randomBytes(24).toString('hex');
    await fsp.writeFile(
      metaFile,
      JSON.stringify({ hash: hash(token), owner: account ? account.id : undefined, created: Date.now() }),
    );
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
async function ai(req, res, account) {
  const b = await readBody(req);
  if (b.builtin) {
    if (!BUILTIN) throw httpError(400, 'This site has no built-in server model.');
    takeBuiltinQuota(req, account);
    Object.assign(b, {
      kind: BUILTIN.kind,
      baseUrl: BUILTIN.baseUrl,
      model: BUILTIN.model,
      apiKey: BUILTIN.apiKey,
      maxTokens: Math.min(+b.maxTokens || 8000, 8000),
    });
  }
  const base = apiBase(b);
  if (!b.model) throw httpError(400, 'Set the AI address and model first.');
  let url, headers, payload;
  if (b.kind === 'anthropic') {
    url = base.replace(/\/v1$/, '') + '/v1/messages';
    headers = anthropicHeaders(b.apiKey);
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
    up = await upstream(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      },
      b.builtin ? null : req,
    );
  } catch (e) {
    if (e.name === 'AbortError') return res.end();
    throw e;
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

// The AI proxy fetches whatever address the user typed. On a shared server that must not become a way to reach
// the server's own network (cloud metadata, databases, admin panels), so private addresses are only allowed for
// people using the server on the same machine, which is how Ollama and LM Studio are normally used.
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
const isLocalRequest = req =>
  /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];
async function checkTarget(url, req) {
  if (ALLOW_PRIVATE_AI || DESKTOP || isLocalRequest(req)) return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map(a => a.address);
  if (addrs.some(isPrivateIp))
    throw httpError(
      400,
      "This server can't connect to local or private network addresses. To use a model running on your own computer, such as Ollama or LM Studio, run CodeBase on that computer or use the desktop app.",
    );
}
// `req` is the visitor's request; leave it out for addresses the server owner configured.
async function upstream(url, init, req) {
  if (req) await checkTarget(url, req);
  let r;
  try {
    r = await fetch(url, { ...init, redirect: 'manual' });
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
    throw httpError(502, `Could not reach ${new URL(url).host}: ${e.cause?.code || e.message}`);
  }
  if (r.status >= 300 && r.status < 400)
    throw httpError(502, `${new URL(url).host} redirected the request. Check the API address.`);
  return r;
}

const apiBase = b => {
  const base = String(b.baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw httpError(400, 'Set the AI address first.');
  return base;
};
const anthropicHeaders = key => ({ 'x-api-key': key || '', 'anthropic-version': '2023-06-01' });

// The models a provider offers, so people pick from a list instead of typing an ID.
async function listModels(req, res) {
  const b = await readBody(req);
  const base = apiBase(b);
  const anthropic = b.kind === 'anthropic';
  const url = anthropic ? base.replace(/\/v1$/, '') + '/v1/models?limit=100' : base + '/models';
  const headers = anthropic ? anthropicHeaders(b.apiKey) : b.apiKey ? { authorization: 'Bearer ' + b.apiKey } : {};
  const up = await upstream(url, { headers, signal: AbortSignal.timeout(15000) }, req);
  const j = await up.json().catch(() => ({}));
  if (up.status === 401 || up.status === 403)
    throw httpError(
      401,
      anthropic ? 'Claude did not accept that API key.' : 'The provider did not accept that API key.',
    );
  if (!up.ok) throw httpError(502, `AI provider said ${up.status}: ${j.error?.message || j.error || ''}`.trim());
  const models = (j.data || j.models || [])
    .map(m => ({ id: String(m.id || m.name || '').replace(/^models\//, ''), name: m.display_name || '' }))
    .filter(m => m.id);
  json(res, 200, { models });
}

// ---------- accounts ----------
const COOKIE = 'cb_session';
function sessionToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
const isHttps = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
function setSessionCookie(req, res, token) {
  const parts = [`${COOKIE}=${token || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(token ? `Max-Age=${accounts.SESSION_DAYS * 86400}` : 'Max-Age=0');
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}
const needAccount = account => {
  if (!account) throw httpError(401, 'Sign in first.');
  return account;
};

async function authRoute(action, req, res) {
  if (!ACCOUNTS) throw httpError(404, 'Accounts are turned off on this server.');
  const body = await readBody(req);
  if (action === 'signout') {
    await accounts.signOut(sessionToken(req));
    setSessionCookie(req, res, null);
    return json(res, 200, { ok: true });
  }
  if (action === 'signup' && !ALLOW_SIGNUP) throw httpError(403, 'This server is not accepting new accounts.');
  const r =
    action === 'signup' ? await accounts.signUp(body) : await accounts.signIn(body, req.socket.remoteAddress || '?');
  setSessionCookie(req, res, r.token);
  json(res, 200, { account: r.account });
}

// Sites published while signed in, newest first.
async function mySites(account) {
  const names = await fsp.readdir(META).catch(() => []);
  const out = [];
  for (const n of names) {
    const meta = await fsp
      .readFile(path.join(META, n), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    if (meta && meta.owner === account.id)
      out.push({ slug: n.replace(/\.json$/, ''), updated: meta.updated || meta.created });
  }
  return out.sort((a, b) => b.updated - a.updated);
}
async function takeDown(slug) {
  await fsp.rm(path.join(SITES, slug), { recursive: true, force: true });
  await fsp.rm(path.join(META, slug + '.json'), { force: true });
}
async function sitesRoute(req, res, account, slug) {
  needAccount(account);
  if (!slug) return json(res, 200, { sites: await mySites(account) });
  if (req.method !== 'DELETE') throw httpError(405, 'Method not allowed');
  if (!(await mySites(account)).some(s => s.slug === slug)) throw httpError(404, 'You have no site with that name.');
  await takeDown(slug);
  json(res, 200, { ok: true });
}

async function accountRoute(action, req, res, account) {
  needAccount(account);
  const body = await readBody(req);
  if (action === 'password') {
    await accounts.changePassword(account.id, body, sessionToken(req));
    return json(res, 200, { ok: true });
  }
  // Deleting the account also takes down the sites it published, so nothing is left without an owner.
  const sites = await mySites(account);
  await accounts.deleteAccount(account.id, body);
  for (const s of sites) await takeDown(s.slug);
  setSessionCookie(req, res, null);
  json(res, 200, { ok: true });
}

async function projectsRoute(req, res, account, id) {
  needAccount(account);
  if (!id) return json(res, 200, { projects: await accounts.listProjects(account.id) });
  if (req.method === 'GET') return json(res, 200, await accounts.getProject(account.id, id));
  if (req.method === 'PUT') return json(res, 200, await accounts.saveProject(account.id, id, await readBody(req)));
  if (req.method === 'DELETE') {
    await accounts.deleteProject(account.id, id);
    return json(res, 200, { ok: true });
  }
  throw httpError(405, 'Method not allowed');
}

// Changes must come from the editor's own page. Previews and published sites run with an opaque origin,
// so they send "Origin: null" and are refused here.
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  let ok = false;
  try {
    ok = new URL(origin).host === host;
  } catch {}
  if (!ok) throw httpError(403, 'Cross-site request refused.');
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

const server = http.createServer(async (req, res) => {
  try {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      throw httpError(400, 'Bad URL');
    }
    let m;
    const account = ACCOUNTS && p.startsWith('/api/') ? await accounts.fromToken(sessionToken(req)) : null;
    if ((m = /^\/api\/projects(?:\/([^/]+))?$/.exec(p))) {
      if (req.method !== 'GET') checkOrigin(req);
      if (!ACCOUNTS) throw httpError(404, 'Accounts are turned off on this server.');
      return await projectsRoute(req, res, account, m[1]);
    }
    if ((m = /^\/api\/sites(?:\/([a-z0-9-]{1,41}))?$/.exec(p))) {
      if (req.method !== 'GET') checkOrigin(req);
      if (!ACCOUNTS) throw httpError(404, 'Accounts are turned off on this server.');
      return await sitesRoute(req, res, account, m[1]);
    }
    if (req.method === 'POST') {
      checkOrigin(req);
      if ((m = /^\/api\/preview\/([\w-]{1,64})$/.exec(p))) return await setPreview(m[1], req, res);
      if ((m = /^\/api\/auth\/(signup|signin|signout)$/.exec(p))) return await authRoute(m[1], req, res);
      if ((m = /^\/api\/account\/(password|delete)$/.exec(p)) && ACCOUNTS)
        return await accountRoute(m[1], req, res, account);
      if (REQUIRE_ACCOUNT && ['/api/publish', '/api/ai', '/api/models'].includes(p)) needAccount(account);
      if (p === '/api/publish') return await publish(req, res, account);
      if (p === '/api/ai') return await ai(req, res, account);
      if (p === '/api/models') return await listModels(req, res);
      throw httpError(404, 'Not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw httpError(405, 'Method not allowed');
    if (p === '/api/me') return json(res, 200, { account });
    if (p === '/api/config')
      return json(res, 200, {
        builtin: BUILTIN && { name: BUILTIN.name },
        accounts: ACCOUNTS && { signup: ALLOW_SIGNUP, required: REQUIRE_ACCOUNT },
        desktop: DESKTOP,
        download: DESKTOP ? null : DOWNLOAD_URL,
      });
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
});

// `node server.js` starts listening; the desktop app requires this file and starts it itself.
if (require.main === module) server.listen(PORT, () => console.log(`CodeBase running at http://localhost:${PORT}`));
module.exports = { server };
