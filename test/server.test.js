'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let base, server, upstream, dataDir;

// A stand-in for an AI provider that streams "OK" in the OpenAI format.
function startUpstream() {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    s.listen(0, () => resolve(s));
  });
}

function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), ...env },
    });
    child.stdout.on('data', d => String(d).includes('running') && resolve({ child, url: `http://localhost:${port}` }));
    child.on('exit', code => reject(new Error(`server exited with ${code}`)));
  });
}

const post = (url, body) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-test-'));
  upstream = await startUpstream();
  ({ child: server, url: base } = await startServer({
    DATA_DIR: dataDir,
    BUILTIN_AI_URL: `http://localhost:${upstream.address().port}/v1`,
    BUILTIN_AI_MODEL: 'test-model',
    BUILTIN_AI_NAME: 'Test Free',
    BUILTIN_AI_HOURLY_LIMIT: '2',
  }));
});

after(() => {
  server?.kill();
  upstream?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('serves the app', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>CodeBase<\/title>/);
});

test('preview serves project files sandboxed, with console capture injected', async () => {
  const files = {
    'index.html': { content: '<html><head></head><body><script src="app.js"></script></body></html>' },
    'app.js': { content: 'x()' },
  };
  assert.equal((await post(base + '/api/preview/t1', { files, device: 'iphone' })).status, 200);

  const page = await fetch(base + '/preview/t1/index.html');
  assert.match(page.headers.get('content-security-policy'), /^sandbox /);
  const html = await page.text();
  assert.match(html, /<head><script>/, 'shim is injected at the start of <head>');
  assert.match(html, /iPhone/, 'device identity is applied');
  assert.match(html, /<script crossorigin src="app.js">/, 'local scripts opt in to full error messages');

  assert.equal((await fetch(base + '/preview/t1/app.js')).status, 200);
  assert.equal((await fetch(base + '/preview/t1/missing.js')).status, 404);
});

test('publishing creates a site, and only the owner can update it', async () => {
  const files = { 'index.html': { content: '<h1>v1</h1>' } };
  const first = await post(base + '/api/publish', { slug: 'my-site', files });
  assert.equal(first.status, 200);
  const { token } = await first.json();
  assert.ok(token);
  assert.match(await (await fetch(base + '/s/my-site/')).text(), /v1/);

  const stranger = await post(base + '/api/publish', {
    slug: 'my-site',
    files: { 'index.html': { content: 'hijack' } },
  });
  assert.equal(stranger.status, 403);

  const owner = await post(base + '/api/publish', {
    slug: 'my-site',
    token,
    files: { 'index.html': { content: '<h1>v2</h1>' } },
  });
  assert.equal(owner.status, 200);
  assert.match(await (await fetch(base + '/s/my-site/')).text(), /v2/);
});

test('rejects unsafe file paths and site names', async () => {
  const traversal = await post(base + '/api/publish', { slug: 'evil', files: { '../escape.html': { content: 'x' } } });
  assert.equal(traversal.status, 400);
  const badName = await post(base + '/api/publish', { slug: 'Not Valid!', files: { 'index.html': { content: 'x' } } });
  assert.equal(badName.status, 400);
  const noPage = await post(base + '/api/publish', { slug: 'no-page', files: { 'a.css': { content: 'x' } } });
  assert.equal(noPage.status, 400);
});

test('reports the built-in model and enforces its hourly limit', async () => {
  assert.deepEqual(await (await fetch(base + '/api/config')).json(), { builtin: { name: 'Test Free' } });

  const ask = () =>
    post(base + '/api/ai', { builtin: true, system: 'test', messages: [{ role: 'user', content: 'hi' }] });
  const ok = await ask();
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /OK/);
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 429);
});

test('explains when a connected AI cannot be reached', async () => {
  const res = await post(base + '/api/ai', {
    kind: 'openai',
    baseUrl: 'http://localhost:1/v1',
    model: 'm',
    messages: [],
  });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /Could not reach/);
});
