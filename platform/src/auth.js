// Staff sign-in, sessions and roles.
import { DurableObject } from 'cloudflare:workers';

export const ROLES = {
  admin: {
    label: 'Administrator',
    description: 'Everything, including staff accounts and settings',
    perms: ['*'],
  },
  editor: {
    label: 'Knowledge editor',
    description: 'Manages the knowledge base and reviews conversations',
    perms: ['overview', 'knowledge.view', 'knowledge.edit', 'assistant.test', 'conversations.view', 'conversations.review',
      'requests.view', 'permits.view', 'channels.view', 'audit.view', 'report.view'],
  },
  department: {
    label: 'Department staff',
    description: "Works their own department's service requests, and permit applications in the permit department",
    perms: ['overview', 'knowledge.view', 'assistant.test', 'conversations.view', 'requests.view', 'requests.edit', 'requests.create', 'report.view',
      'permits.view', 'permits.edit', 'residents.contact'],
  },
  viewer: {
    label: 'Viewer',
    description: 'Can see the dashboard but not change anything',
    perms: ['overview', 'knowledge.view', 'conversations.view', 'requests.view', 'permits.view', 'channels.view', 'report.view'],
  },
};

export const SESSION_COOKIE = 'chos_session';
const SESSION_DAYS = 14;
const SETUP_DAYS = 7;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
export async function sha256(s) { return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
const later = (days) => new Date(Date.now() + days * 864e5).toISOString();
const now = () => new Date().toISOString();

// Who is making a request and what they may do in this city.
export function access({ operator = false, user = null, role = null, departmentId = null, staffId = null, via = 'session' }) {
  const perms = operator ? ['*'] : ROLES[role]?.perms || [];
  return {
    operator, user, role: operator ? 'admin' : role, departmentId: operator ? null : role === 'department' ? departmentId : null, staffId, via,
    can: (p) => perms.includes('*') || perms.includes(p),
    actor: operator
      ? { type: 'operator', id: null, name: 'City Hall OS support' }
      : { type: 'staff', id: user?.id, name: user?.name || 'Staff' },
    perms: perms.includes('*') ? ['*'] : perms,
  };
}

function constantEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export const isOperatorKey = (env, key) => constantEqual(key, env.ADMIN_KEY);

export function cookieValue(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

export function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return token
    ? `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure}`
    : `${SESSION_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

// The signed-in session, if any: { operator, user } or null.
export async function sessionFrom(env, request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT s.id, s.operator, s.expires_at, u.id AS user_id, u.name, u.email, u.status FROM sessions s
     LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`
  ).bind(await sha256(token)).first();
  if (!row || row.expires_at < now()) return null;
  if (row.operator) return { sessionId: row.id, operator: true, user: null };
  if (row.status !== 'active') return null;
  return { sessionId: row.id, operator: false, user: { id: row.user_id, name: row.name, email: row.email } };
}

export async function createSession(env, request, { userId = null, operator = false }) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, operator, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256(token), userId, operator ? 1 : 0, now(), later(SESSION_DAYS), request.headers.get('CF-Connecting-IP'),
      (request.headers.get('User-Agent') || '').slice(0, 200)).run();
  return token;
}

export async function createSetupToken(env, userId) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare("UPDATE auth_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(now(), userId),
    env.DB.prepare('INSERT INTO auth_tokens (id, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(await sha256(token), userId, 'setup', now(), later(SETUP_DAYS)),
  ]);
  return token;
}

export function platformAudit(env, request, actor, action, summary, cityId = null) {
  return env.DB.prepare('INSERT INTO platform_audit (at, actor_type, actor_id, actor_name, action, city_id, summary, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(now(), actor.type, actor.id ?? null, actor.name, action, cityId, summary, request.headers.get('CF-Connecting-IP')).run();
}

// Password hashing runs in a Durable Object: PBKDF2 needs more CPU than a Worker request gets on the Free plan.
// It also counts failed sign-ins per email so a password can't be guessed by brute force.
export class AuthService extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS failures (email TEXT NOT NULL, at INTEGER NOT NULL)');
  }

  async hash(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = await this.derive(password, salt, 100000);
    return `pbkdf2-sha256$100000$${b64url(salt)}$${b64url(bits)}`;
  }

  // Returns 'ok', 'bad' or 'locked'.
  async verify(email, password, stored) {
    const key = email.toLowerCase();
    const since = Date.now() - 15 * 60 * 1000;
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM failures WHERE at < ?', since);
    if (sql.exec('SELECT COUNT(*) AS n FROM failures WHERE email = ?', key).one().n >= 8) return 'locked';
    let ok = false;
    if (stored) {
      const [, iter, salt, expected] = stored.split('$');
      const bits = await this.derive(password, Uint8Array.from(atob(salt.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)), Number(iter));
      ok = constantEqual(b64url(bits), expected);
    } else {
      await this.derive(password, new Uint8Array(16), 100000); // same timing whether or not the account exists
    }
    if (ok) { sql.exec('DELETE FROM failures WHERE email = ?', key); return 'ok'; }
    sql.exec('INSERT INTO failures (email, at) VALUES (?, ?)', key, Date.now());
    return 'bad';
  }

  async derive(password, salt, iterations) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  }
}
