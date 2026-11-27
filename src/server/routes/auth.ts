import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { store } from '../store.js';
import { buildCookieHeader, isHttpsRequest, signAuthToken } from '../authToken.js';

export const authRouter = express.Router();

let cachedFirebaseProjectId: string | null = null;
function getFirebaseProjectId(): string {
  if (cachedFirebaseProjectId !== null) return cachedFirebaseProjectId;
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cachedFirebaseProjectId = String(raw.projectId || '').trim();
  } catch {
    cachedFirebaseProjectId = '';
  }
  return cachedFirebaseProjectId;
}

let cachedCerts: { certs: Record<string, string>; expiresAt: number } | null = null;
async function getGoogleSecureTokenCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (cachedCerts && cachedCerts.expiresAt > now) {
    return cachedCerts.certs;
  }
  const resp = await fetch('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!resp.ok) {
    throw new Error('Failed to fetch Firebase public verification certificates');
  }
  const certs = (await resp.json()) as Record<string, string>;
  const cc = resp.headers.get('cache-control') || '';
  const maxAgeMatch = /max-age=(\d+)/i.exec(cc);
  const ttlMs = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) * 1000 : 3600 * 1000;
  cachedCerts = { certs, expiresAt: now + ttlMs };
  return certs;
}

interface VerifiedFirebaseClaims {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseClaims> {
  const projectId = getFirebaseProjectId();
  if (!projectId) {
    throw new Error('Firebase project configuration is missing');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8')) as { alg?: string; kid?: string };
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as Record<string, unknown>;

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase token header');
  }

  const certs = await getGoogleSecureTokenCerts();
  const cert = certs[header.kid];
  if (!cert) {
    throw new Error('Unknown Firebase signing key');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const sigBuf = Buffer.from(sigB64, 'base64url');
  if (!verifier.verify(cert, sigBuf)) {
    throw new Error('Invalid Firebase token signature');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) {
    throw new Error('Firebase token audience mismatch');
  }
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Firebase token issuer mismatch');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Firebase token expired');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('Missing Firebase user subject');
  }
  if (typeof payload.email !== 'string' || !payload.email || payload.email_verified !== true) {
    throw new Error('Verified Google email is required');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    email_verified: true,
    name: typeof payload.name === 'string' ? payload.name : undefined,
  };
}

const userFlashQueue = new Map<number, Array<[string, string]>>();

export function flashMessage(req: Request, message: string, category = 'info'): void {
  if (req.session) {
    if (!req.session.flashes) req.session.flashes = [];
    req.session.flashes.push([category, message]);
  }
  const uid = req.session?.userId ?? (req.res?.locals?.current_user?.id as number | undefined);
  if (uid && Number.isFinite(uid)) {
    const existing = userFlashQueue.get(uid) || [];
    existing.push([category, message]);
    userFlashQueue.set(uid, existing);
  }
}

export function consumeUserFlashes(userId: number | null | undefined): Array<[string, string]> {
  if (!userId || !Number.isFinite(userId)) return [];
  const items = userFlashQueue.get(userId) || [];
  userFlashQueue.delete(userId);
  return items;
}

export function requireLogin(req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.current_user?.is_authenticated) {
    const nextUrl = encodeURIComponent(req.originalUrl || '/');
    res.redirect(`/login?next=${nextUrl}`);
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!res.locals.current_user?.is_authenticated || !res.locals.current_user?.is_admin) {
    flashMessage(req, 'Admin access required.', 'danger');
    res.redirect('/');
    return;
  }
  next();
}

authRouter.get('/login', (req, res) => {
  if (res.locals.current_user?.is_authenticated) {
    res.redirect('/');
    return;
  }
  res.locals.request.endpoint = 'auth.login';
  res.render('login.html');
});

authRouter.post('/login', (req, res) => {
  res.locals.request.endpoint = 'auth.login';
  const username = String(req.body.username || '').trim();
  const passwordRaw = String(req.body.password || '');
  const passwordTrimmed = passwordRaw.trim();

  const user = store.getUserByUsername(username);
  const passwordValid =
    Boolean(user) &&
    (bcrypt.compareSync(passwordRaw, user!.password_hash) ||
      (passwordTrimmed !== passwordRaw && bcrypt.compareSync(passwordTrimmed, user!.password_hash)));

  if (!user || !passwordValid) {
    res.render('login.html', {
      login_error: 'Invalid username or password.',
      entered_username: username,
    });
    return;
  }

  // Auto-promote to admin if there are no admins yet
  if (!user.is_admin && !store.hasAdmin()) {
    store.updateUser(user.id, { is_admin: true }, user.id);
  }

  req.session.userId = user.id;

  const token = signAuthToken(user.id);
  const isHttps = isHttpsRequest(req);
  const maxAgeSec = 60 * 60 * 24 * 7;

  res.append('Set-Cookie', buildCookieHeader('pvc_auth', token, { maxAgeSec, httpOnly: true, isHttps }));
  res.append('Set-Cookie', buildCookieHeader('pvc_ck', '1', { maxAgeSec, httpOnly: false, isHttps }));

  const nextParam = String(req.query.next || req.body.next || '');
  const safeNext = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  req.session.save(() => {
    const acceptsHtml = String(req.headers.accept || '').includes('text/html');
    if (!acceptsHtml) {
      res.redirect(safeNext);
      return;
    }

    // Seamless client redirect: uses clean URL if cookies stuck, or automatically appends
    // signed fallback token ONLY if the browser blocks all third-party iframe cookies.
    const safeNextJson = JSON.stringify(safeNext);
    const tokenJson = JSON.stringify(token);
    res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Signing in…</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}
    .box{text-align:center;font-size:15px;opacity:.9;}
  </style>
</head>
<body>
  <div class="box">Signing in to PVC Calculation Studio…</div>
  <script>
    (function() {
      var target = ${safeNextJson};
      var token = ${tokenJson};
      var hasCookie = document.cookie.indexOf('pvc_ck=1') !== -1;
      if (hasCookie) {
        try { sessionStorage.removeItem('pvc_fallback_token'); } catch (e) {}
        window.location.replace(target);
      } else {
        try { sessionStorage.setItem('pvc_fallback_token', token); } catch (e) {}
        var sep = target.indexOf('?') === -1 ? '?' : '&';
        window.location.replace(target + sep + '_t=' + encodeURIComponent(token));
      }
    })();
  </script>
  <noscript><meta http-equiv="refresh" content="0;url=${safeNext}"></noscript>
</body>
</html>`);
  });
});

authRouter.post('/auth/google', async (req, res) => {
  const idToken = String(req.body?.idToken || '').trim();
  if (!idToken) {
    res.status(400).json({ ok: false, error: 'Missing Google ID token.' });
    return;
  }

  try {
    const claims = await verifyFirebaseIdToken(idToken);
    const emailLower = claims.email.trim().toLowerCase();
    const isOwnerAdmin = emailLower === 'cviclw@gmail.com';

    let user = store.getUserByEmail(emailLower);
    if (!user && isOwnerAdmin) {
      user = store.getUserByUsername('admin');
      if (user) {
        store.updateUser(user.id, { email: emailLower, is_admin: true }, user.id);
      }
    }

    if (!user) {
      const baseUsername = emailLower.split('@')[0].replace(/[^a-z0-9_.-]/gi, '') || 'google_user';
      let candidate = baseUsername;
      let suffix = 1;
      while (store.getUserByUsername(candidate)) {
        candidate = `${baseUsername}${suffix++}`;
      }
      user = store.createUser({
        username: candidate,
        email: emailLower,
        full_name: claims.name || candidate,
        contact_no: null,
        designation: isOwnerAdmin ? 'Principal Consultant' : 'Analyst',
        control_no: null,
        password_hash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
        is_admin: isOwnerAdmin || !store.hasAdmin(),
      });
    } else if (isOwnerAdmin && !user.is_admin) {
      store.updateUser(user.id, { is_admin: true }, user.id);
    }

    req.session.userId = user.id;
    const token = signAuthToken(user.id);
    const isHttps = isHttpsRequest(req);
    const maxAgeSec = 60 * 60 * 24 * 7;

    res.append('Set-Cookie', buildCookieHeader('pvc_auth', token, { maxAgeSec, httpOnly: true, isHttps }));
    res.append('Set-Cookie', buildCookieHeader('pvc_ck', '1', { maxAgeSec, httpOnly: false, isHttps }));

    const nextParam = String(req.body?.next || '');
    const safeNext = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

    req.session.save(() => {
      res.json({
        ok: true,
        redirectUrl: safeNext,
        fallbackToken: token,
        user: { id: user!.id, username: user!.username, is_admin: user!.is_admin },
      });
    });
  } catch (err) {
    res.status(401).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Google sign-in verification failed.',
    });
  }
});

authRouter.get('/register', (_req, res) => {
  res.locals.request.endpoint = 'auth.register';
  res.render('register.html');
});

authRouter.post('/register', (req, res) => {
  res.locals.request.endpoint = 'auth.register';
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim();
  const fullName = String(req.body.fullname || '').trim();
  const contactNo = String(req.body.contactno || '').trim();
  const designation = String(req.body.designation || '').trim();
  const controlNo = String(req.body.controlno || '').trim();

  if (!username || !password) {
    flashMessage(req, 'Username and password are required', 'danger');
    res.redirect('/register');
    return;
  }
  if (store.getUserByUsername(username)) {
    flashMessage(req, 'Username already taken', 'danger');
    res.redirect('/register');
    return;
  }

  store.createUser({
    username,
    email: email || null,
    full_name: fullName || null,
    contact_no: contactNo || null,
    designation: designation || null,
    control_no: controlNo || null,
    password_hash: bcrypt.hashSync(password, 10),
    is_admin: !store.hasAdmin(),
  });

  flashMessage(req, 'Account created. Please log in.', 'success');
  res.redirect('/login');
});

authRouter.get('/logout', (req, res) => {
  const isHttps = isHttpsRequest(req);
  if (req.session) {
    req.session.userId = undefined;
  }
  res.append('Set-Cookie', buildCookieHeader('pvc_auth', '', { maxAgeSec: 0, httpOnly: true, isHttps }));
  res.append('Set-Cookie', buildCookieHeader('pvc_ck', '', { maxAgeSec: 0, httpOnly: false, isHttps }));
  const acceptsHtml = String(req.headers.accept || '').includes('text/html');
  if (!acceptsHtml) {
    res.redirect('/login');
    return;
  }
  res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>Signed out</title></head><body><script>try{sessionStorage.removeItem('pvc_fallback_token');}catch(e){}window.location.replace('/login');</script></body></html>`);
});
