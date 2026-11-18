/**
 * CodeBase editor: projects, files, preview, export, publishing and the AI assistant.
 * Plain browser JavaScript with no build step; CodeMirror 5 provides the editor.
 */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const validPath = p =>
    typeof p === 'string' &&
    p.length < 300 &&
    p.split('/').every(s => /^[\w.\- ]+$/.test(s) && s !== '.' && s !== '..');
  const ext = p => p.split('.').pop().toLowerCase();
  const TEXT_EXT = new Set([
    'html',
    'htm',
    'css',
    'js',
    'mjs',
    'ts',
    'json',
    'svg',
    'txt',
    'md',
    'xml',
    'csv',
    'webmanifest',
  ]);
  const MIME = {
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    ico: 'image/x-icon',
    avif: 'image/avif',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };

  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

  let toastTimer;
  function toast(msg, ms = 4000) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  // In-app replacement for prompt() and confirm(). Resolves to the entered text, true, or null if cancelled.
  function ask({ title, text = '', value, placeholder = '', ok = 'OK', danger = false, validate }) {
    const dlg = $('#askDlg'),
      form = $('#askForm'),
      input = $('#askInput'),
      err = $('#askError'),
      okBtn = $('#askOk');
    $('#askTitle').textContent = title;
    $('#askText').textContent = text;
    $('#askText').hidden = !text;
    input.hidden = value === undefined;
    input.value = value ?? '';
    input.placeholder = placeholder;
    err.textContent = '';
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger);
    okBtn.classList.toggle('primary', !danger);
    dlg.showModal();
    if (input.hidden) okBtn.focus();
    else {
      input.focus();
      input.select();
    }
    return new Promise(resolve => {
      const finish = result => {
        form.onsubmit = dlg.oncancel = $('#askCancel').onclick = null;
        dlg.close();
        resolve(result);
      };
      form.onsubmit = e => {
        e.preventDefault();
        if (input.hidden) return finish(true);
        const v = input.value.trim();
        const problem = v ? validate?.(v) : "This can't be empty.";
        if (problem) {
          err.textContent = problem;
          input.focus();
          return;
        }
        finish(v);
      };
      $('#askCancel').onclick = () => finish(null);
      dlg.oncancel = e => {
        e.preventDefault();
        finish(null);
      };
    });
  }

  const LS = {
    get(k, d) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        return v ?? d;
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
        return true;
      } catch {
        toast('Browser storage is full. Export your project so nothing is lost.');
        return false;
      }
    },
  };

  // Projects
  const starter = name => ({
    name,
    files: {
      'index.html': {
        content: `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${esc(name)}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <main>\n    <h1>Hello, world</h1>\n    <p>Edit the files on the left, or ask the AI to build something.</p>\n    <button id="btn">Clicked 0 times</button>\n  </main>\n  <script src="script.js"></script>\n</body>\n</html>\n`,
      },
      'style.css': {
        content: `body {\n  margin: 0;\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  font-family: system-ui, sans-serif;\n  background: #f4f5fb;\n  color: #1c1f2e;\n}\nmain { text-align: center; padding: 24px; }\nbutton {\n  font: inherit;\n  padding: 10px 18px;\n  border: 0;\n  border-radius: 10px;\n  background: #4f6bff;\n  color: white;\n  cursor: pointer;\n}\n`,
      },
      'script.js': {
        content: `const btn = document.getElementById('btn');\nlet count = 0;\n\nbtn.addEventListener('click', () => {\n  count++;\n  btn.textContent = \`Clicked \${count} times\`;\n  console.log('count is', count);\n});\n`,
      },
    },
  });

  let projects = LS.get('cb.projects', null),
    currentId = LS.get('cb.current', null);
  if (!projects || !Object.keys(projects).length) {
    currentId = uid();
    projects = { [currentId]: starter('My first site') };
  }
  if (!projects[currentId]) currentId = Object.keys(projects)[0];
  const P = () => projects[currentId];
  const save = debounce(() => {
    LS.set('cb.projects', projects);
    LS.set('cb.current', currentId);
    pushChanges();
  }, 300);

  function renderProjects() {
    $('#projectSel').innerHTML = Object.entries(projects)
      .map(([id, p]) => `<option value="${id}"${id === currentId ? ' selected' : ''}>${esc(p.name)}</option>`)
      .join('');
  }
  function switchProject(id) {
    currentId = id;
    docs = {};
    openTabs = [];
    active = null;
    notes = {};
    noteWidgets = [];
    history = [];
    undoFiles = null;
    $('#chat').innerHTML = '';
    emptyChat();
    renderProjects();
    renderNotesBar();
    const paths = Object.keys(P().files).sort();
    openFile(paths.includes('index.html') ? 'index.html' : paths[0]);
    renderTree();
    renderPages();
    save();
    runPreview();
  }
  $('#projectSel').onchange = e => switchProject(e.target.value);
  $('#newProject').onclick = async () => {
    const name = await ask({ title: 'New project', value: 'Untitled site', ok: 'Create' });
    if (!name) return;
    const id = uid();
    projects[id] = starter(name.trim().slice(0, 60));
    switchProject(id);
  };
  $('#renameProject').onclick = async () => {
    const n = await ask({ title: 'Rename project', value: P().name, ok: 'Rename' });
    if (n) {
      P().name = n.trim().slice(0, 60);
      renderProjects();
      save();
    }
  };
  $('#deleteProject').onclick = async () => {
    if (
      !(await ask({
        title: `Delete "${P().name}"?`,
        text: account
          ? 'This removes the project from your account and this browser. Sites you published stay online.'
          : 'This removes the project from this browser. Sites you published stay online.',
        ok: 'Delete',
        danger: true,
      }))
    )
      return;
    delete projects[currentId];
    if (!Object.keys(projects).length) projects[uid()] = starter('My first site');
    switchProject(Object.keys(projects)[0]);
  };

  // Editor
  const cm = CodeMirror($('#editor'), {
    lineNumbers: true,
    theme: 'cb',
    tabSize: 2,
    indentUnit: 2,
    autoCloseBrackets: true,
    matchBrackets: true,
    autoCloseTags: true,
    styleActiveLine: true,
    extraKeys: {
      'Ctrl-/': 'toggleComment',
      'Cmd-/': 'toggleComment',
      Tab: c => acceptGhost() || (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ', 'end')),
      Esc: () => {
        if (!ghost) return CodeMirror.Pass;
        clearGhost();
      },
      'Ctrl-S': () => runPreview(),
      'Cmd-S': () => runPreview(),
    },
  });
  let docs = {},
    openTabs = [],
    active = null;
  const modeFor = p =>
    ({
      html: 'htmlmixed',
      htm: 'htmlmixed',
      css: 'css',
      js: 'javascript',
      mjs: 'javascript',
      ts: { name: 'javascript', typescript: true },
      json: { name: 'javascript', json: true },
      svg: 'xml',
      xml: 'xml',
      md: 'markdown',
    })[ext(p)] || null;
  const getDoc = p => docs[p] || (docs[p] = CodeMirror.Doc(P().files[p].content, modeFor(p)));

  function openFile(p, line) {
    const f = p && P().files[p];
    active = f ? p : null;
    $('#emptyView').hidden = !!f;
    $('#editor').hidden = !f || !!f.b64;
    $('#binaryView').hidden = !f || !f.b64;
    if (f) {
      if (!openTabs.includes(p)) openTabs.push(p);
      if (f.b64) {
        $('#binaryView').innerHTML = (MIME[ext(p)] || '').startsWith('image/')
          ? `<img alt="" src="data:${MIME[ext(p)]};base64,${f.content}">`
          : `<div>${esc(p)}<br>This file type can't be edited here.</div>`;
      } else {
        cm.swapDoc(getDoc(p));
        cm.refresh();
        if (line != null) {
          cm.setCursor(line, 0);
          cm.scrollIntoView({ line, ch: 0 }, 120);
        }
        cm.focus();
      }
    }
    renderTabs();
    renderTree();
  }
  function closeTab(p) {
    openTabs = openTabs.filter(x => x !== p);
    if (active === p) openFile(openTabs[openTabs.length - 1]);
    else renderTabs();
  }
  function renderTabs() {
    const t = $('#tabs');
    t.innerHTML = '';
    for (const p of openTabs) {
      const d = document.createElement('div');
      d.className = 'tab' + (p === active ? ' active' : '');
      d.innerHTML = `<span>${esc(p)}</span><button title="Close" aria-label="Close ${esc(p)}">${icon('x')}</button>`;
      d.onclick = () => openFile(p);
      d.querySelector('button').onclick = e => {
        e.stopPropagation();
        closeTab(p);
      };
      t.append(d);
    }
  }
  const autoPreview = debounce(() => {
    if ($('#autoRun').checked) runPreview();
  }, 700);
  cm.on('change', (_, ch) => {
    if (!active || ch.origin === 'setValue') return;
    const f = P().files[active];
    if (f && !f.b64) {
      f.content = cm.getValue();
      save();
      autoPreview();
    }
  });

  // Files
  function renderTree() {
    const t = $('#tree');
    t.innerHTML = '';
    for (const p of Object.keys(P().files).sort((a, b) => a.includes('/') - b.includes('/') || a.localeCompare(b))) {
      const i = p.lastIndexOf('/') + 1;
      const d = document.createElement('div');
      d.className = 'file' + (p === active ? ' active' : '');
      d.innerHTML = `<span class="name" title="${esc(p)}"><i>${esc(p.slice(0, i))}</i>${esc(p.slice(i))}</span><button title="Rename" aria-label="Rename">${icon('pencil')}</button><button title="Delete" aria-label="Delete">${icon('trash')}</button>`;
      d.onclick = () => openFile(p);
      const [ren, del] = d.querySelectorAll('button');
      ren.onclick = e => {
        e.stopPropagation();
        renameFile(p);
      };
      del.onclick = async e => {
        e.stopPropagation();
        if (await ask({ title: `Delete ${p}?`, text: "This can't be undone.", ok: 'Delete', danger: true })) {
          delete P().files[p];
          syncAll();
        }
      };
      t.append(d);
    }
  }
  function askPath(title, value, ok) {
    return ask({
      title,
      value,
      ok,
      text: 'Use / to put it in a folder, for example images/logo.svg.',
      validate: p => {
        p = p.replace(/^\/+/, '');
        if (!validPath(p)) return 'Use letters, numbers, spaces, dots and dashes, and / for folders.';
        if (P().files[p]) return `${p} already exists.`;
      },
    }).then(p => p && p.replace(/^\/+/, ''));
  }
  $('#newFile').onclick = async () => {
    const p = await askPath('New file', 'page.html', 'Create');
    if (!p) return;
    P().files[p] = { content: '' };
    syncAll();
    openFile(p);
  };
  async function renameFile(p) {
    const n = await askPath(`Rename ${p}`, p, 'Rename');
    if (!n) return;
    const f = P().files;
    f[n] = f[p];
    delete f[p];
    delete docs[p];
    if (notes[p]) {
      notes[n] = notes[p];
      delete notes[p];
    }
    openTabs = openTabs.map(x => (x === p ? n : x));
    if (active === p) active = n;
    syncAll();
    if (active === n) openFile(n);
  }
  $('#uploadBtn').onclick = () => $('#uploadInput').click();
  $('#uploadInput').onchange = async e => {
    for (const file of e.target.files) {
      const name = file.name.replace(/[^\w.\- ]/g, '_');
      if (file.size > 4e6) {
        toast(`${name} is larger than 4 MB and was skipped.`);
        continue;
      }
      if (TEXT_EXT.has(ext(name))) P().files[name] = { content: await file.text() };
      else {
        const url = await new Promise(r => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result);
          fr.readAsDataURL(file);
        });
        P().files[name] = { content: url.slice(url.indexOf(',') + 1), b64: true };
      }
      delete docs[name];
    }
    e.target.value = '';
    syncAll();
  };

  // Bring editor, tabs, tree and preview back in line with P().files after any outside change.
  function syncAll() {
    const files = P().files;
    for (const p of Object.keys(docs)) {
      if (!files[p] || files[p].b64) delete docs[p];
      else if (docs[p].getValue() !== files[p].content) docs[p].setValue(files[p].content);
    }
    openTabs = openTabs.filter(p => files[p]);
    for (const p of Object.keys(notes)) if (!files[p]) delete notes[p];
    if (!files[active]) openFile(openTabs[openTabs.length - 1] || Object.keys(files).sort()[0]);
    else {
      renderTabs();
      renderTree();
    }
    renderPages();
    renderNotesBar();
    save();
    runPreview();
  }

  // Preview and device frames
  const DEVICES = {
    fit: { label: 'Fit', title: 'Fill the available space' },
    laptop: { label: 'Laptop', w: 1366, h: 768 },
    windows: { label: 'Windows', w: 1280, h: 720 },
    mac: { label: 'Mac', w: 1440, h: 900 },
    iphone: { label: 'iPhone', w: 393, h: 771, phone: true },
    android: { label: 'Android', w: 412, h: 863, phone: true },
  };
  let device = LS.get('cb.device', 'fit'),
    rotated = false;
  if (!DEVICES[device]) device = 'fit';
  const frame = $('#frame'),
    dev = $('#dev'),
    wrap = $('#devWrap'),
    stage = $('#stage');
  $('#deviceBtns').innerHTML = Object.entries(DEVICES)
    .map(([k, d]) => `<button data-d="${k}" title="${d.title || d.w + ' × ' + d.h}">${d.label}</button>`)
    .join('');
  $('#deviceBtns').onclick = e => {
    const k = e.target.dataset.d;
    if (!k) return;
    device = k;
    rotated = false;
    LS.set('cb.device', k);
    layoutDevice();
    runPreview();
  };
  $('#rotateBtn').onclick = () => {
    rotated = !rotated;
    layoutDevice();
  };

  function layoutDevice() {
    const d = DEVICES[device];
    for (const b of $('#deviceBtns').children) b.classList.toggle('on', b.dataset.d === device);
    $('#rotateBtn').hidden = !d.phone;
    dev.className = 'dev dev-' + device;
    if (device === 'fit') {
      frame.style.width = frame.style.height = '';
      dev.style.transform = '';
      wrap.style.width = wrap.style.height = '100%';
      $('#devInfo').textContent = `${stage.clientWidth} × ${stage.clientHeight} · your real browser size`;
      return;
    }
    let [w, h] = [d.w, d.h];
    if (rotated && d.phone) [w, h] = [h, w];
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    const fw = dev.offsetWidth,
      fh = dev.offsetHeight;
    const s = Math.min(1, (stage.clientWidth - 28) / fw, (stage.clientHeight - 28) / fh);
    dev.style.transform = `scale(${s})`;
    wrap.style.width = fw * s + 'px';
    wrap.style.height = fh * s + 'px';
    $('#devInfo').textContent = `${d.label} · ${w} × ${h} viewport · shown at ${Math.round(s * 100)}%`;
  }
  new ResizeObserver(layoutDevice).observe(stage);

  function renderPages() {
    const pages = Object.keys(P().files)
      .filter(p => /\.html?$/i.test(p))
      .sort();
    const sel = $('#pageSel'),
      cur = pages.includes(sel.value) ? sel.value : pages.includes('index.html') ? 'index.html' : pages[0];
    sel.innerHTML = pages.map(p => `<option${p === cur ? ' selected' : ''}>${esc(p)}</option>`).join('');
    sel.hidden = pages.length < 2;
  }
  $('#pageSel').onchange = () => runPreview();
  const previewUrl = () => `preview/${currentId}/${$('#pageSel').value.split('/').map(encodeURIComponent).join('/')}`;
  let runSeq = 0;
  async function runPreview() {
    const seq = ++runSeq;
    if (!$('#pageSel').value) {
      frame.srcdoc =
        '<body style="font:14px system-ui;color:#666;padding:24px">Add an .html file to see a preview.</body>';
      return;
    }
    try {
      const r = await fetch('api/preview/' + currentId, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ files: P().files, device }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
    } catch (e) {
      toast('Preview failed: ' + e.message);
      return;
    }
    if (seq !== runSeq) return;
    consoleClear();
    frame.removeAttribute('srcdoc');
    frame.src = previewUrl() + '?t=' + Date.now();
  }
  $('#runBtn').onclick = runPreview;
  $('#popBtn').onclick = async () => {
    await runPreview();
    window.open(previewUrl(), '_blank');
  };
  addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      runPreview();
    }
  });

  // console
  let consoleLines = [];
  function consoleClear() {
    consoleLines = [];
    $('#consoleLog').innerHTML = '';
    consoleMeta();
  }
  function consoleMeta() {
    const errs = consoleLines.filter(l => l.level === 'error').length,
      c = $('#consoleCount');
    c.textContent = consoleLines.length
      ? `(${consoleLines.length}${errs ? `, ${errs} error${errs > 1 ? 's' : ''}` : ''})`
      : '';
    c.className = errs ? 'err' : '';
    $('#fixErrors').hidden = !errs;
  }
  addEventListener('message', e => {
    if (e.source !== frame.contentWindow || !e.data || !e.data.__cb) return;
    const l = { level: String(e.data.level), text: String(e.data.text).slice(0, 4000) };
    if (consoleLines.length > 300) return;
    consoleLines.push(l);
    const d = document.createElement('div');
    d.className = l.level;
    d.textContent = l.text;
    const log = $('#consoleLog');
    log.append(d);
    log.scrollTop = log.scrollHeight;
    if (l.level === 'error') $('#consolePane').classList.remove('collapsed');
    consoleMeta();
  });
  $('#consoleHead').onclick = e => {
    if (e.target.tagName !== 'BUTTON') {
      $('#consolePane').classList.toggle('collapsed');
      layoutDevice();
    }
  };
  $('#clearConsole').onclick = consoleClear;
  $('#fixErrors').onclick = () => {
    document.body.classList.remove('no-ai');
    sendAI('Fix the errors shown in the console.', 'fix');
  };

  // Export to a single HTML file
  const b64utf8 = s => {
    const b = new TextEncoder().encode(s);
    let o = '';
    for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(o);
  };
  function bundle(entry) {
    const files = P().files,
      warn = new Set();
    const resolve = (base, ref) => {
      if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
      ref = ref.split(/[?#]/)[0];
      const out = [];
      for (const s of (ref.startsWith('/') ? ref.slice(1) : base.slice(0, base.lastIndexOf('/') + 1) + ref).split(
        '/',
      )) {
        if (s === '..') out.pop();
        else if (s && s !== '.') out.push(s);
      }
      const p = out.join('/');
      try {
        return files[p] ? p : files[decodeURIComponent(p)] ? decodeURIComponent(p) : null;
      } catch {
        return null;
      }
    };
    const dataUri = p =>
      `data:${MIME[ext(p)] || 'application/octet-stream'};base64,${files[p].b64 ? files[p].content : b64utf8(files[p].content)}`;
    const cssUrls = (text, base) =>
      text.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/g, (m, ref) => {
        const t = resolve(base, ref);
        return t ? `url("${dataUri(t)}")` : m;
      });
    const css = (p, seen = new Set()) => {
      if (seen.has(p)) return '';
      seen.add(p);
      return cssUrls(
        files[p].content.replace(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?[^;]*;/g, (m, ref) => {
          const t = resolve(p, ref);
          return t ? css(t, seen) : m;
        }),
        p,
      );
    };
    const doc = new DOMParser().parseFromString(files[entry].content, 'text/html');
    doc.querySelectorAll('link[rel~="stylesheet"][href]').forEach(l => {
      const t = resolve(entry, l.getAttribute('href'));
      if (!t) return;
      const s = doc.createElement('style');
      if (l.media) s.media = l.media;
      s.textContent = css(t);
      l.replaceWith(s);
    });
    doc.querySelectorAll('style').forEach(s => {
      s.textContent = cssUrls(s.textContent, entry);
    });
    doc.querySelectorAll('script[src]').forEach(s => {
      const t = resolve(entry, s.getAttribute('src'));
      if (!t) return;
      const code = files[t].content;
      if (s.type === 'module' && /(^|\n)\s*import\s*[\w{*'"]/.test(code))
        warn.add(`${t} imports other modules, which can't be merged into one file.`);
      s.removeAttribute('src');
      s.textContent = code.replace(/<\/script/gi, '<\\/script');
      if (s.defer && s.type !== 'module') {
        s.removeAttribute('defer');
        doc.body.append(s);
      } // inline scripts ignore defer
    });
    doc
      .querySelectorAll('img[src],audio[src],video[src],source[src],video[poster],link[rel~="icon"][href]')
      .forEach(n => {
        for (const a of ['src', 'poster', 'href']) {
          const t = n.hasAttribute(a) && resolve(entry, n.getAttribute(a));
          if (t) n.setAttribute(a, dataUri(t));
        }
      });
    doc.querySelectorAll('a[href]').forEach(a => {
      const t = resolve(entry, a.getAttribute('href'));
      if (t && t !== entry)
        warn.add(`Link to ${t}: other pages aren't included in a single file. Publish to keep them.`);
    });
    return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML + '\n', warn: [...warn] };
  }
  $('#exportBtn').onclick = () => {
    const entry = $('#pageSel').value;
    if (!entry) return toast('Add an .html page first.');
    const { html, warn } = bundle(entry);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    a.download =
      (P()
        .name.replace(/[^\w\- ]+/g, '')
        .trim()
        .replace(/\s+/g, '-') || 'site') + '.html';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(
      warn.length ? 'Downloaded. Note: ' + warn[0] : `Downloaded ${a.download} (${Math.ceil(html.length / 1024)} KB).`,
      warn.length ? 9000 : 4000,
    );
  };

  // Publishing
  $('#publishBtn').onclick = () => {
    if (serverCfg.desktop)
      return ask({
        title: 'Publishing needs a server',
        text: 'The desktop app works offline, so there is nowhere to host the site. Use Export to download it as one file, or publish from the website version of CodeBase.',
        ok: 'OK',
      });
    if (serverCfg.accounts?.required && !account) return openAccountDlg('Sign in to publish sites.');
    $('#pubSlug').value =
      P().publish?.slug ||
      P()
        .name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
    $('#pubOut').innerHTML = P().publish ? pubLink(P().publish.slug, 'Currently live at') : '';
    $('#publishDlg').showModal();
  };
  const pubLink = (slug, label) => {
    const u = new URL(`s/${slug}/`, location.href).href;
    return `<span class="ok">${label}</span> <a href="${u}" target="_blank" rel="noopener">${esc(u)}</a>`;
  };
  $('#pubGo').onclick = async () => {
    const slug = $('#pubSlug').value.trim().toLowerCase(),
      out = $('#pubOut');
    out.textContent = 'Publishing…';
    try {
      const token = P().publish?.slug === slug ? P().publish.token : undefined;
      const r = await fetch('api/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slug, token, files: P().files }),
      });
      const j = await r.json();
      if (r.status === 401) {
        $('#publishDlg').close();
        return openAccountDlg('Sign in to publish sites.');
      }
      if (!r.ok) throw new Error(j.error);
      P().publish = { slug: j.slug, token: j.token };
      save();
      out.innerHTML = pubLink(j.slug, 'Live at');
    } catch (e) {
      out.innerHTML = `<span class="bad">${esc(e.message)}</span>`;
    }
  };

  // AI models
  const PRESETS = {
    anthropic: {
      label: 'Anthropic (Claude)',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-opus-5-5',
      models: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    },
    openai: { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: '' },
    gemini: {
      label: 'Google Gemini',
      kind: 'openai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: '',
    },
    openrouter: {
      label: 'OpenRouter (many models)',
      kind: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: '',
    },
    ollama: {
      label: 'Ollama (runs on your computer)',
      kind: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      model: '',
    },
    lmstudio: {
      label: 'LM Studio (runs on your computer)',
      kind: 'openai',
      baseUrl: 'http://localhost:1234/v1',
      model: '',
    },
    custom: { label: 'Other OpenAI-compatible API', kind: 'openai', baseUrl: '', model: '' },
  };
  // Free models that run inside the browser with WebGPU: no account, no key, code never leaves the device.
  const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.79/lib/index.js';
  const DEVICE = {
    'device-s': {
      name: 'Qwen Coder 0.5B',
      size: 'Small',
      dl: '300 MB',
      base: 'Qwen2.5-Coder-0.5B-Instruct',
      note: 'Fastest. Good for suggestions and small edits.',
    },
    'device-m': {
      name: 'Qwen Coder 1.5B',
      size: 'Medium',
      dl: '900 MB',
      base: 'Qwen2.5-Coder-1.5B-Instruct',
      note: 'Recommended balance of speed and quality.',
    },
    'device-l': {
      name: 'Qwen Coder 3B',
      size: 'Large',
      dl: '1.7 GB',
      base: 'Qwen2.5-Coder-3B-Instruct',
      note: 'Best quality. Needs a recent graphics card.',
    },
  };
  const DEVICE_CTX = 8192; // tokens the on-device model can see at once

  let serverAI = null; // the site owner's free model, if they set one up
  let serverCfg = {}; // what /api/config says about this server: accounts, desktop app
  let gpuState = navigator.gpu ? 'checking' : 'none'; // 'checking' | 'ok' | 'none'
  let gpuF16 = false;
  let mcfg = LS.get('cb.models', null);
  if (!mcfg) {
    mcfg = { list: [], chat: null, complete: 'same', inline: true };
    const old = LS.get('cb.ai', null); // carry over the single connection from the first version
    if (old && old.baseUrl && old.model) {
      const id = uid();
      mcfg.list.push({ id, ...old });
      mcfg.chat = id;
    }
  }
  const saveModels = () => LS.set('cb.models', mcfg);

  function allModels() {
    const out = [];
    if (serverAI)
      out.push({ id: 'server', type: 'server', label: `${serverAI.name}`, short: serverAI.name, free: true });
    if (gpuState !== 'none')
      for (const [id, d] of Object.entries(DEVICE))
        out.push({ id, type: 'device', label: `${d.name} · on device`, short: d.name, free: true, d });
    for (const c of mcfg.list)
      out.push({ id: c.id, type: 'remote', label: c.name || c.model, short: c.name || c.model, cfg: c });
    return out;
  }
  const modelById = id => allModels().find(m => m.id === id) || null;
  function chatModel() {
    return (
      modelById(mcfg.chat) ||
      modelById('server') ||
      (gpuState === 'ok' ? modelById('device-m') : null) ||
      allModels().find(m => m.type === 'remote') ||
      null
    );
  }
  const completeModel = () => (mcfg.complete === 'same' ? chatModel() : modelById(mcfg.complete) || chatModel());
  const aiReady = () => !!chatModel();

  function renderAiStatus() {
    const m = chatModel();
    $('#aiDot').classList.toggle('on', !!m);
    $('#aiLabel').textContent = m ? m.short : 'Connect AI';
    const sel = $('#modelSel'),
      all = allModels();
    const opt = m2 => `<option value="${m2.id}"${m && m2.id === m.id ? ' selected' : ''}>${esc(m2.label)}</option>`;
    const free = all.filter(x => x.free),
      mine = all.filter(x => !x.free);
    sel.innerHTML =
      (free.length ? `<optgroup label="Free">${free.map(opt).join('')}</optgroup>` : '') +
      (mine.length ? `<optgroup label="Your models">${mine.map(opt).join('')}</optgroup>` : '') +
      `<option value="__manage">${all.length ? 'Manage models…' : 'Connect a model…'}</option>`;
    if (!m) sel.value = '__manage';
    renderInlineBtn();
  }
  $('#modelSel').onchange = e => {
    if (e.target.value === '__manage') {
      renderAiStatus();
      return openAiDlg();
    }
    mcfg.chat = e.target.value;
    saveModels();
    renderAiStatus();
    emptyChat();
  };

  // ---------- on-device engine ----------
  let webllm = null,
    deviceBusy = false;
  const engine = { id: null, p: null, eng: null, worker: null };
  const progressFns = new Set();
  async function detectGpu() {
    if (!navigator.gpu) {
      gpuState = 'none';
      return;
    }
    try {
      const a = await navigator.gpu.requestAdapter();
      gpuState = a ? 'ok' : 'none';
      gpuF16 = !!a?.features.has('shader-f16');
    } catch {
      gpuState = 'none';
    }
  }
  const deviceModelId = id => `${DEVICE[id].base}-${gpuF16 ? 'q4f16_1' : 'q4f32_1'}-MLC`;
  const loadWebllm = async () => (webllm ||= await import(WEBLLM_URL));
  async function isDownloaded(id) {
    try {
      return await (await loadWebllm()).hasModelInCache(deviceModelId(id));
    } catch {
      return false;
    }
  }
  function loadEngine(id) {
    if (engine.id === id && engine.p) return engine.p;
    if (engine.worker) {
      engine.worker.terminate();
      engine.worker = null;
    }
    engine.id = id;
    engine.eng = null;
    engine.p = (async () => {
      if (gpuState !== 'ok')
        throw new Error(
          "This browser can't run on-device models. They need WebGPU: Chrome or Edge on a computer, or a recent Safari.",
        );
      const lib = await loadWebllm();
      engine.worker = new Worker('llm-worker.js', { type: 'module' });
      const eng = await lib.CreateWebWorkerMLCEngine(
        engine.worker,
        deviceModelId(id),
        { initProgressCallback: r => progressFns.forEach(f => f(r)) },
        { context_window_size: DEVICE_CTX },
      );
      if (engine.id === id) engine.eng = eng;
      return eng;
    })();
    engine.p.catch(() => {
      if (engine.id === id) {
        engine.id = null;
        engine.p = null;
        engine.worker?.terminate();
        engine.worker = null;
      }
    });
    return engine.p;
  }
  async function streamDevice({ id, system, messages, maxTokens, onText, signal, temperature }) {
    const eng = await loadEngine(id);
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    const stop = () => eng.interruptGenerate();
    signal?.addEventListener('abort', stop);
    deviceBusy = true;
    try {
      const chunks = await eng.chat.completions.create({
        messages: [{ role: 'system', content: system }, ...messages],
        stream: true,
        max_tokens: maxTokens || 2048,
        temperature: temperature ?? 0.3,
      });
      let full = '',
        truncated = false;
      for await (const c of chunks) {
        const ch = c.choices?.[0];
        if (!ch) continue;
        if (ch.finish_reason === 'length') truncated = true;
        if (ch.delta?.content) {
          full += ch.delta.content;
          onText?.(full);
        }
      }
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      return { full, truncated };
    } catch (e) {
      if (/context window|prompt tokens exceed|exceed/i.test(e.message || ''))
        throw new Error(
          'This project is too big for the on-device model to read at once. Select the part you care about, ask about a single file, or switch to a larger model.',
        );
      throw e;
    } finally {
      deviceBusy = false;
      signal?.removeEventListener('abort', stop);
    }
  }

  // ---------- one entry point for every kind of model ----------
  async function streamAI({ cfg, system, messages, maxTokens, onText, signal }) {
    const r = await fetch('api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({ ...cfg, system, messages, maxTokens }),
    });
    if (!r.ok) {
      let t = await r.text();
      try {
        t = JSON.parse(t).error || t;
      } catch {}
      if (r.status === 401 && !account && serverCfg.accounts?.required) {
        openAccountDlg('Sign in to use AI on this server.');
        t = 'Sign in to use AI on this server.';
      }
      throw new Error(t);
    }
    const rd = r.body.getReader(),
      dec = new TextDecoder();
    let buf = '',
      full = '',
      truncated = false,
      refused = false;
    for (;;) {
      const { value, done } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        let j;
        try {
          j = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (j.type === 'error' || j.error) throw new Error(j.error?.message || JSON.stringify(j.error || j));
        let t = '';
        if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') t = j.delta.text;
        else if (j.choices) t = j.choices[0]?.delta?.content || '';
        if (
          (j.type === 'message_delta' && j.delta?.stop_reason === 'max_tokens') ||
          j.choices?.[0]?.finish_reason === 'length'
        )
          truncated = true;
        if (j.type === 'message_delta' && j.delta?.stop_reason === 'refusal') refused = true;
        if (t) {
          full += t;
          onText?.(full);
        }
      }
    }
    if (refused && !full.trim()) throw new Error('Claude declined this request. Try rephrasing it.');
    return { full, truncated };
  }
  function callModel(m, opts) {
    if (m.type === 'device') return streamDevice({ id: m.id, ...opts });
    return streamAI({ cfg: m.type === 'server' ? { builtin: true } : m.cfg, ...opts });
  }

  // ---------- the models dialog ----------
  $('#aiPreset').innerHTML = Object.entries(PRESETS)
    .map(([k, p]) => `<option value="${k}">${p.label}</option>`)
    .join('');
  let editing = null;
  const showView = v => {
    $('#aiListView').hidden = v !== 'list';
    $('#aiEditView').hidden = v !== 'edit';
    $('#aiClaudeView').hidden = v !== 'claude';
  };
  async function renderModelLists() {
    const chat = chatModel(),
      using = id => chat && chat.id === id;
    const useBtn = id =>
      using(id) ? '<span class="pill on">In use</span>' : `<button type="button" data-use="${id}">Use</button>`;
    let free = '';
    if (serverAI)
      free += `<div class="mrow"><div><b>${esc(serverAI.name)}</b><div class="dim">Provided by this site. Nothing to set up.</div></div>${useBtn('server')}</div>`;
    if (gpuState === 'none')
      free += `<div class="mrow"><div><b>On-device models</b><div class="dim">Not available in this browser. They need WebGPU: Chrome or Edge on a computer, or a recent Safari.</div></div></div>`;
    else
      for (const [id, d] of Object.entries(DEVICE)) {
        free += `<div class="mrow" data-dev="${id}"><div><b>${d.name}</b> <span class="dim">· ${d.size}</span><div class="dim">${d.note} Runs on your device, private and offline after a one-time ${d.dl} download. <span class="dl"></span></div></div>${useBtn(id)}</div>`;
      }
    $('#freeList').innerHTML = free;
    const claudeCard = mcfg.list.some(c => c.kind === 'anthropic')
      ? ''
      : `<div class="mrow claude-card"><span class="claude-mark">${icon('claude')}</span><div><b>Claude</b><div class="dim">Anthropic's models for coding, review and building whole sites.</div></div><button type="button" class="primary" data-claude="1">Connect Claude</button></div>`;
    $('#userList').innerHTML =
      claudeCard +
      (mcfg.list.length
        ? mcfg.list
            .map(
              c => `<div class="mrow"><div><b>${esc(c.name || c.model)}</b><div class="dim">${esc(PRESETS[c.preset]?.label || 'Custom')} · ${esc(c.model)}</div></div>
    <span class="btns"><button type="button" data-edit="${c.id}">Edit</button><button type="button" class="icon-btn" data-del="${c.id}" title="Remove" aria-label="Remove">${icon('trash')}</button>${useBtn(c.id)}</span></div>`,
            )
            .join('')
        : '<div class="dim mempty">Or connect ChatGPT, Gemini, a local model, or anything OpenAI-compatible.</div>');
    const all = allModels();
    $('#completeSel').innerHTML =
      `<option value="same">Same as the chat model</option>` +
      all
        .map(m => `<option value="${m.id}"${mcfg.complete === m.id ? ' selected' : ''}>${esc(m.label)}</option>`)
        .join('');
    $('#inlineChk').checked = mcfg.inline;
    if (gpuState === 'ok')
      for (const row of document.querySelectorAll('[data-dev]')) {
        const id = row.dataset.dev,
          dl = row.querySelector('.dl');
        if (engine.id === id && engine.eng) {
          dl.innerHTML = '<span class="ok">Loaded.</span>';
          continue;
        }
        if (await isDownloaded(id))
          dl.innerHTML = `<span class="ok">Downloaded.</span> <a href="#" data-rm="${id}">Remove download</a>`;
      }
  }
  async function openAiDlg() {
    showView('list');
    $('#aiDlg').showModal();
    await renderModelLists();
  }
  $('#aiSettingsBtn').onclick = openAiDlg;
  $('#aiDlg').onclick = async e => {
    const t = e.target,
      d = t.dataset;
    if (d.claude) openClaude();
    else if (d.use) {
      mcfg.chat = d.use;
      saveModels();
      renderAiStatus();
      emptyChat();
      renderModelLists();
    } else if (d.edit) openEdit(mcfg.list.find(c => c.id === d.edit));
    else if (d.del) {
      const c = mcfg.list.find(x => x.id === d.del);
      if (
        !(await ask({
          title: `Remove ${c.name || c.model}?`,
          text: 'You can connect it again later.',
          ok: 'Remove',
          danger: true,
        }))
      )
        return;
      mcfg.list = mcfg.list.filter(x => x.id !== d.del);
      if (mcfg.chat === d.del) mcfg.chat = null;
      if (mcfg.complete === d.del) mcfg.complete = 'same';
      saveModels();
      renderAiStatus();
      renderModelLists();
    } else if (d.rm) {
      e.preventDefault();
      if (engine.id === d.rm) {
        engine.worker?.terminate();
        Object.assign(engine, { id: null, p: null, eng: null, worker: null });
      }
      try {
        await (await loadWebllm()).deleteModelAllInfoInCache(deviceModelId(d.rm));
        toast('Download removed. It will download again if you use it.');
      } catch (err) {
        toast('Could not remove: ' + err.message);
      }
      renderModelLists();
    }
  };
  $('#inlineChk').onchange = e => {
    mcfg.inline = e.target.checked;
    saveModels();
    renderInlineBtn();
  };
  $('#completeSel').onchange = e => {
    mcfg.complete = e.target.value;
    saveModels();
  };
  $('#addModel').onclick = () => openEdit(null);
  function fillModelSuggestions(list) {
    $('#modelSuggest').innerHTML = (list || PRESETS[$('#aiPreset').value].models || [])
      .map(m => `<option value="${esc(m)}">`)
      .join('');
  }
  // Ask the provider which models this key can use, so people pick from a list rather than typing IDs.
  async function fetchModels(cfg) {
    const r = await fetch('api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Could not list models (${r.status})`);
    return j.models;
  }
  let modelsSeq = 0;
  async function loadEditModels() {
    const cfg = readAiForm(),
      hint = $('#aiModelHint'),
      seq = ++modelsSeq;
    if (!/^https?:\/\//.test(cfg.baseUrl) || (!cfg.apiKey && !/localhost|127\.0\.0\.1/.test(cfg.baseUrl))) return;
    hint.textContent = 'Loading available models…';
    try {
      const models = await fetchModels(cfg);
      if (seq !== modelsSeq) return;
      fillModelSuggestions(models.map(m => m.id));
      hint.textContent = models.length ? `${models.length} models available. Start typing to pick one.` : '';
      if (!$('#aiModel').value && models[0]) $('#aiModel').value = models[0].id;
    } catch (e) {
      if (seq === modelsSeq) hint.textContent = '';
    }
  }
  $('#aiKey').addEventListener('change', loadEditModels);
  $('#aiBase').addEventListener('change', loadEditModels);
  // `prefill` starts a new connection from the given values instead of editing an existing one.
  function openEdit(c, prefill = false) {
    editing = prefill ? null : c;
    const v = c || { preset: 'anthropic', ...PRESETS.anthropic, apiKey: '', name: '' };
    $('#aiEditTitle').textContent = editing ? 'Edit model' : 'Connect a model';
    $('#aiPreset').value = v.preset;
    $('#aiBase').value = v.baseUrl;
    $('#aiModel').value = v.model;
    $('#aiKey').value = v.apiKey || '';
    $('#aiName').value = v.name || '';
    $('#aiTestOut').textContent = '';
    $('#aiModelHint').textContent = '';
    fillModelSuggestions();
    showView('edit');
    $('#aiModel').focus();
    loadEditModels();
  }
  $('#aiPreset').onchange = e => {
    const p = PRESETS[e.target.value];
    $('#aiBase').value = p.baseUrl;
    $('#aiModel').value = p.model;
    $('#aiModelHint').textContent = '';
    fillModelSuggestions();
    loadEditModels();
  };

  // Connect Claude: paste a key, pick models from the ones the key can use. Each becomes an entry in the picker.
  const CLAUDE_PICKS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
  let claudeFound = null;
  function openClaude() {
    claudeFound = null;
    $('#claudeKey').value = mcfg.list.find(c => c.kind === 'anthropic')?.apiKey || '';
    $('#claudeModels').hidden = true;
    $('#claudeModels').innerHTML = '';
    $('#claudeOut').textContent = '';
    $('#claudeGo').textContent = 'Continue';
    showView('claude');
    $('#claudeKey').focus();
  }
  $('#claudeKey').addEventListener('input', () => {
    if (!claudeFound) return;
    claudeFound = null;
    $('#claudeModels').hidden = true;
    $('#claudeOut').textContent = '';
    $('#claudeGo').textContent = 'Continue';
  });
  $('#claudeBack').onclick = () => {
    showView('list');
    renderModelLists();
  };
  $('#claudeAdvanced').onclick = () =>
    openEdit({ preset: 'anthropic', ...PRESETS.anthropic, apiKey: $('#claudeKey').value.trim(), name: '' }, true);
  $('#claudeGo').onclick = async () => {
    const key = $('#claudeKey').value.trim(),
      out = $('#claudeOut');
    if (!key) {
      out.className = 'bad';
      out.textContent = 'Paste your API key first.';
      return;
    }
    const base = { preset: 'anthropic', kind: 'anthropic', baseUrl: PRESETS.anthropic.baseUrl, apiKey: key };
    if (!claudeFound) {
      out.className = 'dim';
      out.textContent = 'Checking your key…';
      try {
        claudeFound = await fetchModels(base);
      } catch (e) {
        out.className = 'bad';
        out.textContent = e.message;
        return;
      }
      if (!claudeFound.length) {
        out.className = 'bad';
        out.textContent = 'That key works, but it has no models available.';
        claudeFound = null;
        return;
      }
      const have = new Set(mcfg.list.filter(c => c.kind === 'anthropic').map(c => c.model));
      const picks = claudeFound.some(m => CLAUDE_PICKS.includes(m.id)) ? CLAUDE_PICKS : [claudeFound[0].id];
      $('#claudeModels').innerHTML =
        '<div class="dim">Models to add to the picker</div>' +
        claudeFound
          .map(
            m =>
              `<label class="chk"><input type="checkbox" value="${esc(m.id)}"${picks.includes(m.id) || have.has(m.id) ? ' checked' : ''}${have.has(m.id) ? ' disabled' : ''}> ${esc(m.name || m.id)} <span class="dim">${esc(m.id)}</span></label>`,
          )
          .join('');
      $('#claudeModels').hidden = false;
      out.className = 'ok';
      out.textContent = 'Key accepted.';
      $('#claudeGo').textContent = 'Connect';
      return;
    }
    const chosen = [...document.querySelectorAll('#claudeModels input:checked:not(:disabled)')].map(i => i.value);
    const names = Object.fromEntries(claudeFound.map(m => [m.id, m.name]));
    // A new key replaces the one on existing Claude entries, so there's only ever one to update.
    for (const c of mcfg.list) if (c.kind === 'anthropic' && c.baseUrl === base.baseUrl) c.apiKey = key;
    for (const id of chosen) mcfg.list.push({ id: uid(), ...base, model: id, name: names[id] || id });
    const pick = mcfg.list.find(c => c.model === chosen.find(id => /opus/.test(id)) || c.model === chosen[0]);
    if (pick) mcfg.chat = pick.id;
    // Use the smallest model for as-you-type suggestions: they're frequent and short.
    const fast = mcfg.list.find(c => c.kind === 'anthropic' && /haiku/.test(c.model));
    if (fast && mcfg.complete === 'same') mcfg.complete = fast.id;
    saveModels();
    renderAiStatus();
    emptyChat();
    showView('list');
    renderModelLists();
    toast(chosen.length ? `Claude connected. ${pick ? `Using ${pick.name}.` : ''}` : 'Claude key updated.');
  };
  const readAiForm = () => ({
    preset: $('#aiPreset').value,
    kind: PRESETS[$('#aiPreset').value].kind,
    baseUrl: $('#aiBase').value.trim(),
    model: $('#aiModel').value.trim(),
    apiKey: $('#aiKey').value.trim(),
    name: $('#aiName').value.trim().slice(0, 40),
  });
  $('#aiBack').onclick = () => {
    showView('list');
    renderModelLists();
  };
  $('#aiSave').onclick = () => {
    const v = readAiForm();
    if (!/^https?:\/\//.test(v.baseUrl) || !v.model) {
      $('#aiTestOut').className = 'bad';
      $('#aiTestOut').textContent = 'Fill in the API address and the model name.';
      return;
    }
    if (editing) Object.assign(editing, v);
    else {
      const id = uid();
      mcfg.list.push({ id, ...v });
      mcfg.chat = id;
    }
    saveModels();
    renderAiStatus();
    emptyChat();
    showView('list');
    renderModelLists();
  };
  $('#aiTest').onclick = async () => {
    const out = $('#aiTestOut');
    out.className = 'dim';
    out.textContent = 'Testing…';
    try {
      const r = await streamAI({
        cfg: readAiForm(),
        system: 'Reply with the single word OK.',
        messages: [{ role: 'user', content: 'Say OK' }],
        maxTokens: 50,
      });
      out.className = 'ok';
      out.textContent = 'Connected. The model replied: ' + (r.full.trim().slice(0, 80) || '(empty)');
    } catch (e) {
      out.className = 'bad';
      out.textContent = e.message;
    }
  };

  // ---------- inline suggestions (ghost text, like Copilot) ----------
  const COMPLETE_SYS = `You are the autocomplete engine of a code editor, like GitHub Copilot. The user message contains one file split at the cursor: everything before the cursor inside <before>, everything after it inside <after>. Reply with ONLY the text to insert at the cursor: usually the rest of the current line, or the next few lines (at most 8). Match the file's language, style and indentation. Never repeat text that is already in <before> or <after>. No explanations and no markdown fences. If nothing useful fits, reply with nothing.`;
  let ghost = null,
    ghostSeq = 0,
    ghostAbort = null;
  function renderInlineBtn() {
    const b = $('#inlineBtn'),
      m = completeModel();
    b.classList.toggle('on', mcfg.inline && !!m);
    b.innerHTML = icon('sparkle') + (mcfg.inline ? (m ? 'Suggestions' : 'Suggestions (no model)') : 'Suggestions off');
  }
  $('#inlineBtn').onclick = () => {
    mcfg.inline = !mcfg.inline;
    saveModels();
    renderInlineBtn();
    clearGhost();
    toast(
      mcfg.inline ? 'Suggestions on. Pause while typing to see one, then press Tab to accept.' : 'Suggestions off.',
    );
  };
  function clearGhost() {
    ghostSeq++;
    ghostAbort?.abort();
    ghostAbort = null;
    if (ghost) {
      ghost.mark.clear();
      ghost = null;
    }
  }
  function acceptGhost() {
    if (!ghost) return false;
    const { pos, text } = ghost;
    clearGhost();
    cm.replaceRange(text, pos, pos, '+ghost');
    return true;
  }
  function cleanGhost(text, prefix, suffix) {
    text = text
      .replace(/^\s*```[\w-]*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .replace(/<\/?(before|after)>/g, '');
    const curLine = prefix.slice(prefix.lastIndexOf('\n') + 1);
    if (curLine.trim() && text.startsWith(curLine)) text = text.slice(curLine.length); // model repeated the line so far
    text = text.split('\n').slice(0, 8).join('\n').replace(/\s+$/, '');
    const next = suffix.split('\n')[0];
    for (let k = Math.min(next.length, text.length); k > 0; k--)
      if (text.endsWith(next.slice(0, k)) && next.slice(0, k).trim()) {
        text = text.slice(0, -k);
        break;
      } // don't duplicate ")" etc.
    if (!text.trim() || suffix.startsWith(text)) return '';
    return text;
  }
  const requestGhost = debounce(async () => {
    const m = completeModel();
    if (!mcfg.inline || !m || !active || P().files[active]?.b64 || cm.somethingSelected() || !cm.hasFocus() || aborter)
      return;
    if (m.type === 'device' && (engine.id !== m.id || !engine.eng || deviceBusy)) return; // never start a download from typing
    const cur = cm.getCursor(),
      after = cm.getLine(cur.line).slice(cur.ch);
    if (/\w/.test(after)) return; // only suggest at the end of a line (or before closing brackets)
    const doc = cm.getValue(),
      idx = cm.indexFromPos(cur);
    const prefix = doc.slice(Math.max(0, idx - 3000), idx),
      suffix = doc.slice(idx, idx + 1000);
    if (prefix.trim().length < 3) return;
    const seq = ++ghostSeq;
    ghostAbort = new AbortController();
    try {
      const { full } = await callModel(m, {
        system: COMPLETE_SYS,
        temperature: 0.1,
        maxTokens: 160,
        signal: ghostAbort.signal,
        messages: [{ role: 'user', content: `File: ${active}\n<before>${prefix}</before><after>${suffix}</after>` }],
      });
      if (seq !== ghostSeq || cm.indexFromPos(cm.getCursor()) !== idx) return;
      const text = cleanGhost(full, prefix, suffix);
      if (!text) return;
      const span = document.createElement('span');
      span.className = 'ghost';
      span.textContent = text;
      span.title = 'Tab to accept · Esc to dismiss';
      ghost = { pos: cur, text, mark: cm.setBookmark(cur, { widget: span, insertLeft: true }) };
    } catch {
      /* suggestions fail quietly; the chat shows real errors */
    }
  }, 650);
  cm.on('change', (_, ch) => {
    clearGhost();
    if (ch.origin === '+input' && mcfg.inline) requestGhost();
  });
  cm.on('cursorActivity', () => {
    if (ghost && cm.indexFromPos(cm.getCursor()) !== cm.indexFromPos(ghost.pos)) clearGhost();
  });
  cm.on('blur', () =>
    setTimeout(() => {
      if (!cm.hasFocus()) clearGhost();
    }, 150),
  );

  // Assistant modes
  const MODES = {
    build: {
      label: 'Build',
      hint: 'The AI writes and edits the files for you.',
      ph: 'Describe what to build or change…',
    },
    fix: {
      label: 'Fix',
      hint: 'The AI finds and corrects bugs, changing as little as possible.',
      ph: "What's going wrong? Leave empty to check everything.",
      def: 'Find and fix any bugs in this project.',
    },
    comment: {
      label: 'Review',
      hint: "The AI reviews your code and pins comments to lines. It doesn't change anything.",
      ph: 'What should it look at? Leave empty to review the open file.',
      def: 'Review the active file.',
    },
    ask: { label: 'Ask', hint: 'Chat about your code. Nothing is changed.', ph: 'Ask a question…' },
  };
  const BASE = `You are the coding assistant inside CodeBase, a browser-based web IDE. The project is a static website: plain HTML, CSS and JavaScript files that run directly in the browser. There is no build step, no server-side code and no npm; libraries can only be loaded from a CDN URL. The entry page is index.html. The user sees a live preview, so the result must work as written.`;
  const FILE_FORMAT = `Write every file you create or change in full, in exactly this format, with nothing wrapped around it (no markdown code fences):
<file path="relative/path.ext">
complete file content
</file>
To delete a file write <delete path="relative/path.ext"/>. Leave out files that don't change. Never abbreviate a file with placeholders like "rest unchanged".`;
  const SYSTEM = {
    build: `${BASE}\n\nDo what the user asks by editing the project. Start with one or two plain sentences saying what you did, then the files.\n\n${FILE_FORMAT}`,
    fix: `${BASE}\n\nYour job is to correct bugs. Make the smallest change that fixes each problem; do not restyle, rename, restructure or add features. Start with a short list (one line per fix: what was wrong and why), then the corrected files. If nothing is wrong, say so and write no files.\n\n${FILE_FORMAT}`,
    comment: `${BASE}\n\nYour job is to review code and leave comments. Do NOT rewrite or output files. Files are shown with "N| " line-number prefixes that are not part of the code. Unless the user says otherwise, review the active file.\n\nWrite each comment on its own line in exactly this format:\npath/to/file.ext:LINE: the comment\nGive at most 12 comments, most important first: bugs, then risks, then clarity. Each is one or two sentences and says what to do about it. After the comments write a line containing only --- and then a two-sentence overall summary.`,
    ask: `${BASE}\n\nAnswer the user's question about their project. Be concise. You may show short code snippets in markdown fences, but you cannot edit files in this mode; if the user wants changes made, tell them to switch to Build or Fix.`,
  };
  let mode = LS.get('cb.mode', 'build');
  if (!MODES[mode]) mode = 'build';
  let history = [],
    notes = {},
    noteWidgets = [],
    undoFiles = null,
    aborter = null;
  $('#modeBtns').innerHTML = Object.entries(MODES)
    .map(([k, m]) => `<button data-m="${k}">${m.label}</button>`)
    .join('');
  function setMode(m) {
    mode = m;
    LS.set('cb.mode', m);
    for (const b of $('#modeBtns').children) b.classList.toggle('on', b.dataset.m === m);
    $('#modeHint').textContent = MODES[m].hint;
    $('#prompt').placeholder = MODES[m].ph;
  }
  $('#modeBtns').onclick = e => e.target.dataset.m && setMode(e.target.dataset.m);

  function buildContext(m, budget = 400000) {
    const files = P().files,
      numbered = m === 'comment';
    let out = 'Project files:\n',
      size = 0;
    const binary = [],
      skipped = [];
    const order = Object.keys(files).sort((a, b) => (b === active) - (a === active) || a.localeCompare(b));
    for (const p of order) {
      const f = files[p];
      if (f.b64) {
        binary.push(p);
        continue;
      }
      if (size + f.content.length > budget) {
        skipped.push(p);
        continue;
      }
      size += f.content.length;
      const body = numbered
        ? f.content
            .split('\n')
            .map((l, i) => `${i + 1}| ${l}`)
            .join('\n')
        : f.content;
      out += `<file path="${p}">\n${body}\n</file>\n`;
    }
    if (binary.length) out += `Binary files (contents not shown): ${binary.join(', ')}\n`;
    if (skipped.length) out += `Files not shown (too long to include): ${skipped.join(', ')}\n`;
    if (active) out += `\nActive file (open in the editor): ${active}\n`;
    const sel = active && !files[active].b64 ? cm.getSelection() : '';
    if (sel.trim()) out += `Text the user has selected in it:\n"""\n${sel.slice(0, 4000)}\n"""\n`;
    const logs = consoleLines.filter(l => m === 'fix' || l.level === 'error' || l.level === 'warn').slice(-25);
    if (logs.length && m !== 'comment')
      out += `\nConsole output from the last preview run:\n${logs.map(l => `[${l.level}] ${l.text}`).join('\n')}\n`;
    return out;
  }

  const FILE_RE = /<file path="([^"]+)">\r?\n?([\s\S]*?)\r?\n?<\/file>|<delete path="([^"]+)"\s*\/?>/g;
  function parseOps(text) {
    const ops = [];
    let m;
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(text))) {
      const p = (m[1] || m[3]).trim().replace(/^\.?\//, '');
      if (!validPath(p)) continue;
      if (m[3]) ops.push({ path: p, del: true });
      else ops.push({ path: p, content: m[2].replace(/^```[\w-]*\r?\n/, '').replace(/\r?\n```\s*$/, '') + '\n' });
    }
    return ops;
  }
  function md(text) {
    const chips = [];
    const hold = h => {
      chips.push(h);
      return `\u0001${chips.length - 1}\u0001`;
    };
    text = text
      .replace(FILE_RE, (m, p, _c, d) =>
        hold(d ? `<span class="chip del">${esc(d)}</span>` : `<span class="chip">${icon('file')}${esc(p)}</span>`),
      )
      .replace(/<file path="([^"]+)">[\s\S]*$/, (m, p) =>
        hold(`<span class="chip busy">${icon('file')}${esc(p)} <span class="dim">writing…</span></span>`),
      )
      .replace(/<[^>\n]{0,200}$/, m =>
        ['<file path="', '<delete path="'].some(t => t.startsWith(m) || m.startsWith(t)) ? '' : m,
      );
    text = esc(text.trim())
      .replace(/```[\w-]*\n([\s\S]*?)(```|$)/g, (m, c) => `<pre><code>${c}</code></pre>`)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    return text.replace(/\u0001(\d+)\u0001\n?/g, (m, i) => chips[i]);
  }

  function emptyChat() {
    const c = $('#chat');
    if (c.children.length && !c.querySelector(':scope > .empty-chat')) return;
    const m = chatModel();
    $('#chat').innerHTML = `<div class="empty-chat">${
      m
        ? `Using <b>${esc(m.short)}</b>${m.free ? ' (free)' : ''}. Pick a mode above and tell it what you need.<br><span class="dim">Switch models any time from the picker below.</span>`
        : 'Use a free built-in AI or connect your own model. Or just code by hand; everything else works without AI.<br><br><button class="primary" id="connectNow">Choose an AI model</button>'
    }</div>`;
    const b = $('#connectNow');
    if (b) b.onclick = openAiDlg;
  }
  function addMsg(cls, html) {
    $('.empty-chat')?.remove();
    const d = document.createElement('div');
    d.className = 'msg ' + cls;
    d.innerHTML = html;
    const c = $('#chat');
    c.append(d);
    c.scrollTop = c.scrollHeight;
    return d;
  }
  $('#clearChat').onclick = () => {
    history = [];
    $('#chat').innerHTML = '';
    emptyChat();
  };

  async function sendAI(text, m = mode) {
    if (aborter) return;
    const model = chatModel();
    if (!model) return openAiDlg();
    if (m !== mode) setMode(m);
    text = (text || '').trim() || MODES[m].def;
    if (!text) return $('#prompt').focus();
    addMsg('user', `<span class="tag">${MODES[m].label}</span>${esc(text)}`);
    const el = addMsg('ai', '<span class="dim">Thinking…</span>'),
      chat = $('#chat');
    const small = model.type === 'device'; // small context: send less
    const messages = [
      ...history.slice(small ? -2 : -6),
      { role: 'user', content: `${buildContext(m, small ? 14000 : 400000)}\nRequest: ${text}` },
    ];
    aborter = new AbortController();
    $('#sendBtn').textContent = 'Stop';
    const showProgress = r => {
      el.innerHTML = `<div class="loadbar"><i style="width:${Math.round((r.progress || 0) * 100)}%"></i></div><span class="dim">${esc(friendlyProgress(r))}</span>`;
    };
    try {
      if (small && !(engine.id === model.id && engine.eng)) {
        if (!(await isDownloaded(model.id)) && !(await confirmDownload(el, model))) {
          el.innerHTML = '<span class="dim">Cancelled. Nothing was downloaded.</span>';
          return;
        }
        el.innerHTML = '<span class="dim">Starting the on-device model…</span>';
        progressFns.add(showProgress);
        try {
          await loadEngine(model.id);
        } finally {
          progressFns.delete(showProgress);
        }
        el.innerHTML = '<span class="dim">Thinking…</span>';
        renderInlineBtn();
      }
      const { full, truncated } = await callModel(model, {
        system: SYSTEM[m],
        messages,
        signal: aborter.signal,
        maxTokens: small ? 2048 : undefined,
        onText: t => {
          const stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60;
          el.innerHTML = md(t);
          if (stick) chat.scrollTop = chat.scrollHeight;
        },
      });
      if (!full.trim()) throw new Error('The model returned an empty reply.');
      history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: full.replace(FILE_RE, (x, p, _c, d) => (d ? `[deleted ${d}]` : `[wrote ${p}]`)) },
      );
      if (m === 'comment') showNotes(el, full);
      else {
        el.innerHTML = md(full);
        const ops = m === 'ask' ? [] : parseOps(full);
        if (ops.length) applyOps(el, ops);
        else if (m !== 'ask') offerCodeBlocks(el, full);
        if (truncated)
          el.insertAdjacentHTML(
            'beforeend',
            '<div class="actions bad">The reply hit the model\'s length limit, so a file may be missing. Ask it to continue, or request smaller steps.</div>',
          );
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        el.insertAdjacentHTML('beforeend', '<div class="actions dim">Stopped. No changes were made.</div>');
      } else {
        el.className = 'msg err';
        el.textContent = e.message;
      }
    } finally {
      aborter = null;
      $('#sendBtn').textContent = 'Send';
      chat.scrollTop = chat.scrollHeight;
    }
  }
  function friendlyProgress(r) {
    const pct = Math.round((r.progress || 0) * 100);
    if (/cache/i.test(r.text || '') && pct < 100) return `Downloading the model… ${pct}% (only the first time)`;
    if (pct >= 100 || /finish|loading.*gpu|shader/i.test(r.text || ''))
      return 'Loading the model onto your graphics card…';
    return r.text || `Loading… ${pct}%`;
  }
  function confirmDownload(el, model) {
    return new Promise(resolve => {
      el.innerHTML = `<b>${esc(model.d.name)}</b> runs free on your device. It needs a one-time download of about ${model.d.dl}; after that it loads from your browser's storage and works offline.
<div class="actions"><button class="primary" data-ok>Download and start</button><button data-no>Cancel</button></div>`;
      el.querySelector('[data-ok]').onclick = () => resolve(true);
      el.querySelector('[data-no]').onclick = () => resolve(false);
      aborter.signal.addEventListener('abort', () => resolve(false));
    });
  }
  // Smaller models sometimes answer with plain code blocks instead of whole files: let the user apply those by hand.
  function offerCodeBlocks(el, full) {
    const LANG = {
      html: 'html',
      htm: 'html',
      xml: 'html',
      css: 'css',
      js: 'js',
      javascript: 'js',
      mjs: 'js',
      json: 'json',
      svg: 'svg',
    };
    const blocks = [...full.matchAll(/```([\w-]*)\n([\s\S]*?)```/g)];
    if (!blocks.length) return;
    const files = Object.keys(P().files).filter(p => !P().files[p].b64);
    const row = document.createElement('div');
    row.className = 'actions';
    for (const [, lang, code] of blocks) {
      const want = LANG[lang.toLowerCase()];
      const same = files.filter(p => (LANG[ext(p)] || ext(p)) === want);
      const target =
        active && (LANG[ext(active)] || ext(active)) === want ? active : same.length === 1 ? same[0] : null;
      if (!target || code.trim().split('\n').length < 3) continue;
      const b = document.createElement('button');
      b.textContent = `Apply to ${target}`;
      b.title = `Replace the whole of ${target} with this code (you can undo)`;
      b.onclick = () => {
        row.remove();
        applyOps(el, [{ path: target, content: code.replace(/\n?$/, '\n') }]);
      };
      row.append(b);
    }
    if (row.children.length) el.append(row);
  }
  function applyOps(el, ops) {
    const before = structuredClone(P().files),
      files = P().files;
    ops = ops.filter(o => !o.del || files[o.path]);
    if (!ops.length) return;
    for (const o of ops) {
      if (o.del) delete files[o.path];
      else files[o.path] = { content: o.content };
    }
    undoFiles = before;
    syncAll();
    const first = ops.find(o => !o.del);
    if (first && !files[active]) openFile(first.path);
    const a = document.createElement('div');
    a.className = 'actions';
    a.innerHTML = `<span class="ok">Applied ${ops.length} file${ops.length > 1 ? 's' : ''}.</span><button>Undo</button>`;
    a.querySelector('button').onclick = e => {
      P().files = before;
      syncAll();
      a.innerHTML = '<span class="dim">Undone.</span>';
    };
    el.append(a);
  }

  // comment mode: notes pinned to lines, code untouched
  function showNotes(el, full) {
    const [body, summary = ''] = full.split(/\n-{3,}\s*\n?/),
      found = [],
      rest = [];
    for (const line of body.split('\n')) {
      const m = /^\W*([\w.\-/ ]+\.\w+):(\d+)(?:-\d+)?:\**\s*(.+)$/.exec(line.trim());
      if (m && P().files[m[1]]) found.push({ path: m[1], line: Math.max(0, +m[2] - 1), text: m[3] });
      else if (line.trim()) rest.push(line);
    }
    if (!found.length) {
      el.innerHTML = md(full);
      return;
    }
    notes = {};
    for (const n of found) (notes[n.path] ||= []).push(n);
    el.innerHTML = '';
    el.style.whiteSpace = 'normal';
    for (const n of found) {
      const d = document.createElement('span');
      d.className = 'note-item';
      d.innerHTML = `<b>${esc(n.path)}:${n.line + 1}</b>${md(n.text)}`;
      d.onclick = () => openFile(n.path, n.line);
      el.append(d);
    }
    if (rest.length || summary.trim())
      el.insertAdjacentHTML('beforeend', `<div style="margin-top:8px">${md([...rest, summary].join('\n'))}</div>`);
    drawNotes();
    if (notes[active]) openFile(active, notes[active][0].line);
  }
  function drawNotes() {
    noteWidgets.forEach(w => w.clear());
    noteWidgets = [];
    for (const [p, list] of Object.entries(notes)) {
      if (!P().files[p] || P().files[p].b64) continue;
      const doc = getDoc(p);
      for (const n of list) {
        const node = document.createElement('div');
        node.className = 'ai-note';
        node.innerHTML = `<b>AI</b> ${md(n.text)}`;
        noteWidgets.push(doc.addLineWidget(Math.min(n.line, doc.lastLine()), node, { above: true }));
      }
    }
    renderNotesBar();
  }
  function renderNotesBar() {
    const n = Object.values(notes).reduce((a, l) => a + l.length, 0);
    $('#notesBar').hidden = !n;
    $('#notesCount').textContent = `${n} AI comment${n === 1 ? '' : 's'} pinned to your code`;
  }
  $('#clearNotes').onclick = () => {
    notes = {};
    drawNotes();
  };

  $('#sendBtn').onclick = () => {
    if (aborter) return aborter.abort();
    const t = $('#prompt').value;
    $('#prompt').value = '';
    sendAI(t);
  };
  $('#prompt').onkeydown = e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('#sendBtn').click();
    }
  };
  $('#toggleAI').onclick = () => {
    document.body.classList.toggle('no-ai');
    LS.set('cb.noai', document.body.classList.contains('no-ai'));
    cm.refresh();
  };

  $('#themeBtn').onclick = () => {
    const root = document.documentElement;
    const now = root.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    root.dataset.theme = now === 'light' ? 'dark' : 'light';
    LS.set('cb.theme', root.dataset.theme);
  };

  // Workspace style
  const UIS = ['classic', 'flow', 'paper'];
  function applyUI(u) {
    if (!UIS.includes(u)) return;
    document.documentElement.dataset.ui = u;
    LS.set('cb.ui', u);
    for (const c of document.querySelectorAll('.uicard')) c.classList.toggle('on', c.dataset.ui === u);
    requestAnimationFrame(() => {
      cm.refresh();
      layoutDevice();
    });
  }
  function openUiDlg() {
    const cur = document.documentElement.dataset.ui;
    for (const c of document.querySelectorAll('.uicard')) c.classList.toggle('on', c.dataset.ui === cur);
    $('#uiDlg').showModal();
    $('.uicard.on')?.focus();
  }
  $('#styleBtn').onclick = openUiDlg;
  document.querySelectorAll('.uicard').forEach(c => (c.onclick = () => applyUI(c.dataset.ui)));
  $('#uiDlg').addEventListener('close', () => {
    if (!LS.get('cb.ui', null)) applyUI(document.documentElement.dataset.ui);
  });

  // Accounts: projects are kept in the account and synced from every device you sign in on
  let account = null;
  // project id -> fingerprint of the version the account has. Kept in the browser so a reload doesn't
  // re-upload everything (and overwrite newer changes made on another device).
  const savedSync = LS.get('cb.sync', null);
  let synced = savedSync?.hashes || {};
  let syncState = { ok: true, text: '' };
  const fingerprint = str => {
    let h1 = 0xdeadbeef,
      h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36) + ':' + str.length;
  };
  const projectData = p => ({ name: p.name, files: p.files, publish: p.publish || null });
  const snapshot = p => fingerprint(JSON.stringify(projectData(p)));
  const saveSync = () => LS.set('cb.sync', account ? { account: account.id, hashes: synced } : null);
  const pristine = id => snapshot(projects[id]) === snapshot(starter(projects[id].name));
  async function api(url, method = 'GET', body) {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || `Request failed (${r.status})`), { status: r.status });
    return j;
  }
  function setSync(ok, text) {
    syncState = { ok, text };
    $('#accountBtn').classList.toggle('sync-error', !ok);
    if ($('#accountDlg').open) renderAccountDlg();
  }

  let pushing = false,
    pushAgain = false;
  async function pushChanges() {
    if (!account) return;
    if (pushing) return void (pushAgain = true);
    pushing = true;
    try {
      do {
        pushAgain = false;
        for (const [id, p] of Object.entries(projects)) {
          const snap = snapshot(p);
          if (synced[id] === snap) continue;
          p.updated = Date.now();
          await api('api/projects/' + id, 'PUT', { ...projectData(p), updated: p.updated });
          synced[id] = snap;
          saveSync();
        }
        for (const id of Object.keys(synced))
          if (!projects[id]) {
            await api('api/projects/' + id, 'DELETE');
            delete synced[id];
            saveSync();
          }
      } while (pushAgain);
      LS.set('cb.projects', projects);
      setSync(true, 'All changes are saved to your account.');
    } catch (e) {
      if (e.status === 401) return signedOut('You were signed out. Sign in again to keep syncing.');
      setSync(false, "Couldn't save to your account: " + e.message + '. Changes are kept in this browser.');
    } finally {
      pushing = false;
    }
  }

  // Bring down projects that are newer in the account. Local edits that haven't been uploaded yet always win.
  async function pullChanges() {
    if (!account) return;
    let remote;
    try {
      ({ projects: remote } = await api('api/projects'));
    } catch (e) {
      if (e.status === 401) return signedOut('You were signed out. Sign in again to keep syncing.');
      return setSync(false, "Couldn't reach your account: " + e.message);
    }
    let changedCurrent = false;
    const remoteIds = new Set(remote.map(r => r.id));
    for (const r of remote) {
      const local = projects[r.id];
      const unsent = local && synced[r.id] !== snapshot(local);
      if (local && (unsent || (local.updated || 0) >= r.updated)) continue;
      const full = await api('api/projects/' + r.id).catch(() => null);
      if (!full) continue;
      projects[r.id] = {
        name: full.name,
        files: full.files,
        publish: full.publish || undefined,
        updated: full.updated,
      };
      synced[r.id] = snapshot(projects[r.id]);
      if (r.id === currentId) changedCurrent = true;
    }
    // Deleted on another device.
    for (const id of Object.keys(synced))
      if (!remoteIds.has(id) && projects[id] && synced[id] === snapshot(projects[id])) {
        delete projects[id];
        delete synced[id];
        if (id === currentId) changedCurrent = true;
      }
    // An untouched starter project would just pile up copies in the account, so drop it.
    if (remote.length)
      for (const id of Object.keys(projects))
        if (!synced[id] && pristine(id)) {
          delete projects[id];
          if (id === currentId) changedCurrent = true;
        }
    if (!Object.keys(projects).length) projects[uid()] = starter('My first site');
    if (!projects[currentId]) currentId = Object.keys(projects)[0];
    LS.set('cb.projects', projects);
    saveSync();
    if (changedCurrent) switchProject(currentId);
    else renderProjects();
    await pushChanges();
  }

  function signedIn(a) {
    if (LS.get('cb.sync', null)?.account !== a.id) synced = {};
    account = a;
    saveSync();
    renderAccountBtn();
    return pullChanges();
  }
  // Signing out removes this account's projects from the browser, so the next person can't open them.
  async function signedOut(message) {
    // Keep anything with changes that never reached the account, so nothing is lost.
    for (const id of Object.keys(synced))
      if (projects[id] && synced[id] === snapshot(projects[id])) delete projects[id];
    synced = {};
    account = null;
    if (!Object.keys(projects).length) projects[uid()] = starter('My first site');
    LS.set('cb.projects', projects);
    saveSync();
    renderAccountBtn();
    switchProject(projects[currentId] ? currentId : Object.keys(projects)[0]);
    if (message) toast(message, 6000);
  }

  const initials = a => (a.name || a.email).trim()[0].toUpperCase();
  function renderAccountBtn() {
    const b = $('#accountBtn');
    b.hidden = !serverCfg.accounts;
    $('#accountLabel').textContent = account ? account.name || account.email.split('@')[0] : 'Sign in';
    $('#accountAvatar').innerHTML = account ? esc(initials(account)) : icon('user');
    $('#accountAvatar').classList.toggle('filled', !!account);
    b.title = account ? `Signed in as ${account.email}` : 'Sign in or create an account';
  }

  let authMode = 'signin';
  function setAuthMode(m) {
    authMode = m;
    const up = m === 'signup';
    $('#authTitle').textContent = up ? 'Create an account' : 'Sign in';
    $('#authGo').textContent = up ? 'Create account' : 'Sign in';
    $('#authSwitch').textContent = up ? 'I have an account' : 'Create an account';
    $('#authSwitch').hidden = !up && !serverCfg.accounts?.signup;
    $('#authNameRow').hidden = !up;
    $('#authPassword').autocomplete = up ? 'new-password' : 'current-password';
    $('#authPassword').placeholder = up ? 'At least 8 characters' : '';
    $('#authError').textContent = '';
  }
  function renderAccountDlg() {
    $('#authView').hidden = !!account;
    $('#meView').hidden = !account;
    if (account) {
      $('#meAvatar').textContent = initials(account);
      $('#meName').textContent = account.name || account.email.split('@')[0];
      $('#meEmail').textContent = account.email;
      $('#meSync').textContent = syncState.text || 'Syncing…';
      $('#meSync').className = syncState.ok ? 'dim' : 'bad';
    }
  }
  function openAccountDlg(reason) {
    if (!serverCfg.accounts) return;
    setAuthMode('signin');
    if (reason) $('#authIntro').textContent = reason;
    renderAccountDlg();
    $('#accountDlg').showModal();
    if (!account) $('#authEmail').focus();
  }
  $('#accountBtn').onclick = () => openAccountDlg();
  $('#authSwitch').onclick = () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  $('#authCancel').onclick = () => $('#accountDlg').close();
  $('#accountDlg').addEventListener('close', () => {
    $('#authIntro').textContent = 'Sign in to keep your projects in your account and open them on any device.';
    $('#authPassword').value = '';
  });
  $('#authView').onsubmit = async e => {
    e.preventDefault();
    const go = $('#authGo');
    go.disabled = true;
    $('#authError').textContent = '';
    try {
      const { account: a } = await api('api/auth/' + authMode, 'POST', {
        email: $('#authEmail').value,
        password: $('#authPassword').value,
        name: $('#authName').value,
      });
      setSync(true, 'Syncing your projects…');
      renderAccountDlg();
      await signedIn(a);
      const n = Object.keys(synced).length;
      toast(
        authMode === 'signup'
          ? 'Account created. Your projects are saved to it.'
          : `Signed in. ${n} project${n === 1 ? '' : 's'} synced.`,
      );
      $('#accountDlg').close();
    } catch (err) {
      $('#authError').textContent = err.message;
    } finally {
      go.disabled = false;
    }
  };
  $('#signOut').onclick = async () => {
    await pushChanges();
    if (!syncState.ok) {
      const sure = await ask({
        title: 'Sign out anyway?',
        text: "Some changes haven't reached your account yet and will be lost from this browser.",
        ok: 'Sign out',
        danger: true,
      });
      if (!sure) return;
    }
    await api('api/auth/signout', 'POST', {}).catch(() => {});
    $('#accountDlg').close();
    signedOut('Signed out.');
  };
  // Pick up changes made on another device when you come back to this tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') pullChanges();
  });
  window.addEventListener('beforeunload', e => {
    if (account && (pushing || Object.entries(projects).some(([id, p]) => synced[id] !== snapshot(p)))) {
      pushChanges();
      e.preventDefault();
    }
  });

  // Start
  if (LS.get('cb.noai', false)) document.body.classList.add('no-ai');
  setMode(mode);
  renderAiStatus();
  layoutDevice();
  switchProject(currentId);
  if (!LS.get('cb.ui', null)) openUiDlg(); // first visit: let people choose a look
  Promise.all([
    fetch('api/config')
      .then(r => r.json())
      .then(async c => {
        serverCfg = c;
        serverAI = c.builtin || null;
        if (c.download) {
          $('#desktopLink').href = c.download;
          $('#desktopLink').hidden = false;
        }
        renderAccountBtn();
        if (c.accounts) {
          const { account: a } = await api('api/me');
          if (a) await signedIn(a);
          else if (savedSync) signedOut('Your session ended. Sign in again to keep syncing.');
        }
      })
      .catch(() => {}),
    detectGpu(),
  ]).then(() => {
    renderAiStatus();
    emptyChat();
  });
})();
