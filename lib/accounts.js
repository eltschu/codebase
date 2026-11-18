'use strict';
/**
 * Accounts, sign-in sessions and per-account project storage, kept as JSON files on disk.
 *
 *   <dataDir>/accounts/emails.json            email -> account id
 *   <dataDir>/accounts/<id>/account.json      email, name, password hash
 *   <dataDir>/accounts/<id>/projects/<p>.json one file per project
 *   <dataDir>/sessions.json                   hashed session token -> account id and expiry
 *
 * Passwords are hashed with scrypt. Session tokens are random and only their SHA-256 is stored.
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const SESSION_DAYS = 30;
const MAX_PROJECTS = 200;
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const scrypt = (password, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
const httpError = (status, message) => Object.assign(new Error(message), { status });
const validEmail = e => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const validId = id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id);

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}
// Write to a temporary file first so a crash never leaves half a file behind.
async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value));
  await fsp.rename(tmp, file);
}

function createAccounts(dataDir) {
  const dir = path.join(dataDir, 'accounts');
  const emailsFile = path.join(dir, 'emails.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const accountFile = id => path.join(dir, id, 'account.json');
  const projectsDir = id => path.join(dir, id, 'projects');

  // Writes to shared files go through one queue so concurrent requests can't overwrite each other.
  let queue = Promise.resolve();
  const serial = fn => (queue = queue.then(fn, fn));

  let sessions = null;
  async function loadSessions() {
    if (!sessions) {
      sessions = await readJson(sessionsFile, {});
      const now = Date.now();
      for (const [k, s] of Object.entries(sessions)) if (s.exp < now) delete sessions[k];
    }
    return sessions;
  }
  const saveSessions = () => writeJson(sessionsFile, sessions);

  // Slow down password guessing: at most 10 failed sign-ins per email per address every 15 minutes. Counting per
  // email means one person guessing can't lock out everyone else who shares their network.
  const failures = new Map();
  function checkThrottle(ip) {
    const f = failures.get(ip);
    if (f && f.until > Date.now() && f.n >= 10)
      throw httpError(429, 'Too many attempts. Wait a few minutes and try again.');
  }
  function noteFailure(ip) {
    const now = Date.now();
    let f = failures.get(ip);
    if (!f || f.until < now) failures.set(ip, (f = { n: 0, until: now + 15 * 60e3 }));
    f.n++;
    if (failures.size > 10000) for (const [k, v] of failures) if (v.until < now) failures.delete(k);
  }

  const publicAccount = a => ({ id: a.id, email: a.email, name: a.name });

  async function newSession(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    await serial(async () => {
      await loadSessions();
      sessions[sha256(token)] = { account: accountId, exp: Date.now() + SESSION_DAYS * 864e5 };
      await saveSessions();
    });
    return token;
  }

  return {
    SESSION_DAYS,

    async signUp({ email, password, name }) {
      email = String(email || '')
        .trim()
        .toLowerCase();
      if (!validEmail(email)) throw httpError(400, 'Enter a valid email address.');
      if (typeof password !== 'string' || password.length < 8)
        throw httpError(400, 'Use a password with at least 8 characters.');
      if (password.length > 200) throw httpError(400, 'That password is too long.');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt)).toString('hex');
      const account = {
        id: crypto.randomUUID(),
        email,
        name: String(name || '')
          .trim()
          .slice(0, 60),
        salt,
        hash,
        created: Date.now(),
      };
      await serial(async () => {
        const emails = await readJson(emailsFile, {});
        if (emails[email]) throw httpError(409, 'There is already an account with that email. Sign in instead.');
        await writeJson(accountFile(account.id), account);
        emails[email] = account.id;
        await writeJson(emailsFile, emails);
      });
      return { account: publicAccount(account), token: await newSession(account.id) };
    },

    async signIn({ email, password }, ip) {
      email = String(email || '')
        .trim()
        .toLowerCase();
      const who = ip + '|' + email;
      checkThrottle(who);
      const emails = await readJson(emailsFile, {});
      const account = emails[email] && (await readJson(accountFile(emails[email]), null));
      // Hash even when the account doesn't exist, so response time doesn't reveal which emails are registered.
      const key = await scrypt(String(password || ''), account ? account.salt : 'no-such-account');
      if (!account || !crypto.timingSafeEqual(key, Buffer.from(account.hash, 'hex'))) {
        noteFailure(who);
        throw httpError(401, 'Wrong email or password.');
      }
      failures.delete(who);
      return { account: publicAccount(account), token: await newSession(account.id) };
    },

    async signOut(token) {
      if (!token) return;
      await serial(async () => {
        await loadSessions();
        if (sessions[sha256(token)]) {
          delete sessions[sha256(token)];
          await saveSessions();
        }
      });
    },

    /** The signed-in account for a session token, or null. */
    async fromToken(token) {
      if (!token) return null;
      await loadSessions();
      const s = sessions[sha256(token)];
      if (!s || s.exp < Date.now()) return null;
      const a = await readJson(accountFile(s.account), null);
      return a && publicAccount(a);
    },

    async listProjects(accountId) {
      const names = await fsp.readdir(projectsDir(accountId)).catch(() => []);
      const out = [];
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        const p = await readJson(path.join(projectsDir(accountId), n), null);
        if (p) out.push({ id: p.id, name: p.name, updated: p.updated });
      }
      return out.sort((a, b) => b.updated - a.updated);
    },

    async getProject(accountId, id) {
      if (!validId(id)) throw httpError(400, 'Bad project id');
      const p = await readJson(path.join(projectsDir(accountId), id + '.json'), null);
      if (!p) throw httpError(404, 'Project not found');
      return p;
    },

    async saveProject(accountId, id, body) {
      if (!validId(id)) throw httpError(400, 'Bad project id');
      if (!body || typeof body.files !== 'object' || !body.files) throw httpError(400, 'No files');
      const file = path.join(projectsDir(accountId), id + '.json');
      // `base` is the version the device last saw. If the account has moved on since then (another device
      // saved in between), refuse, so the device can keep both versions instead of overwriting.
      if ('base' in body) {
        const current = await readJson(file, null);
        if ((current ? current.updated : null) !== body.base)
          throw httpError(409, 'This project was changed on another device.');
      }
      if (!fs.existsSync(file) && (await this.listProjects(accountId)).length >= MAX_PROJECTS)
        throw httpError(400, `You can keep up to ${MAX_PROJECTS} projects. Delete one to make room.`);
      const project = {
        id,
        name: String(body.name || 'Untitled').slice(0, 60),
        files: body.files,
        publish: body.publish || undefined,
        updated: +body.updated || Date.now(),
      };
      await writeJson(file, project);
      return { id, updated: project.updated };
    },

    async changePassword(accountId, { current, password }, keepToken) {
      const a = await readJson(accountFile(accountId), null);
      if (!a) throw httpError(404, 'Account not found');
      const key = await scrypt(String(current || ''), a.salt);
      if (!crypto.timingSafeEqual(key, Buffer.from(a.hash, 'hex')))
        throw httpError(401, 'Your current password is wrong.');
      if (typeof password !== 'string' || password.length < 8)
        throw httpError(400, 'Use a new password with at least 8 characters.');
      if (password.length > 200) throw httpError(400, 'That password is too long.');
      a.salt = crypto.randomBytes(16).toString('hex');
      a.hash = (await scrypt(password, a.salt)).toString('hex');
      await writeJson(accountFile(accountId), a);
      await this.endSessions(accountId, keepToken);
    },

    /** Sign out everywhere, except the session `keepToken` if given. */
    async endSessions(accountId, keepToken) {
      await serial(async () => {
        await loadSessions();
        const keep = keepToken && sha256(keepToken);
        for (const [k, v] of Object.entries(sessions)) if (v.account === accountId && k !== keep) delete sessions[k];
        await saveSessions();
      });
    },

    async deleteAccount(accountId, { password }) {
      const a = await readJson(accountFile(accountId), null);
      if (!a) throw httpError(404, 'Account not found');
      const key = await scrypt(String(password || ''), a.salt);
      if (!crypto.timingSafeEqual(key, Buffer.from(a.hash, 'hex'))) throw httpError(401, 'That password is wrong.');
      await this.endSessions(accountId);
      await serial(async () => {
        const emails = await readJson(emailsFile, {});
        delete emails[a.email];
        await writeJson(emailsFile, emails);
      });
      await fsp.rm(path.join(dir, accountId), { recursive: true, force: true });
    },

    async deleteProject(accountId, id) {
      if (!validId(id)) throw httpError(400, 'Bad project id');
      await fsp.rm(path.join(projectsDir(accountId), id + '.json'), { force: true });
    },
  };
}

module.exports = { createAccounts };
