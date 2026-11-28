import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { configureNunjucks } from './src/server/templateEngine.js';
import { store } from './src/server/store.js';
import { isHttpsRequest, verifyAuthToken } from './src/server/authToken.js';
import { authRouter, consumeUserFlashes } from './src/server/routes/auth.js';
import { mainRouter } from './src/server/routes/main.js';
import { pvcRouter } from './src/server/routes/pvc.js';
import { adminRouter } from './src/server/routes/admin.js';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    flashes?: Array<[string, string]>;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.basename(__dirname) === 'dist' ? path.resolve(__dirname, '..') : __dirname;

const app = express();
app.set('trust proxy', 1);

// Ensure all HTTPS cookies include SameSite=None; Secure; Partitioned (CHIPS)
// so cross-origin preview iframes (Chrome/Edge/Firefox) never drop session cookies.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (isHttpsRequest(req)) {
    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (name.toLowerCase() === 'set-cookie') {
        const list = Array.isArray(value) ? [...value] : [String(value)];
        const patched = list.map((cookieStr) => {
          let c = String(cookieStr);
          if (!/;\s*samesite=/i.test(c)) {
            c += '; SameSite=None';
          } else {
            c = c.replace(/;\s*samesite=lax/i, '; SameSite=None');
          }
          if (!/;\s*secure\b/i.test(c)) {
            c += '; Secure';
          }
          if (!/;\s*partitioned\b/i.test(c)) {
            c += '; Partitioned';
          }
          return c;
        });
        return origSetHeader(name, patched);
      }
      return origSetHeader(name, value);
    }) as typeof res.setHeader;
  }
  next();
});

// Body & cookie parsing
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());

// Session middleware (works on both localhost HTTP and HTTPS cross-origin iframe)
app.use(
  session({
    name: 'pvc_session',
    secret: process.env.SECRET_KEY || 'pvc-studio-dev-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 12,
      sameSite: 'lax',
      secure: false,
    },
  })
);

app.use((req, _res, next) => {
  const isHttps = isHttpsRequest(req);
  if (req.session && req.session.cookie) {
    req.session.cookie.sameSite = isHttps ? 'none' : 'lax';
    req.session.cookie.secure = isHttps;
  }
  next();
});

// Static assets (CSS, JS, uploaded monthly index images/PDFs, generated UI graphics)
app.use('/static', express.static(path.join(ROOT_DIR, 'static')));
app.use('/src/assets', express.static(path.join(ROOT_DIR, 'src/assets')));

// Configure Nunjucks template engine
configureNunjucks(app, path.join(ROOT_DIR, 'templates'));

// Always-connected Cloud SQL (PostgreSQL) request lifecycle middleware:
// 1. Lazily loads latest authoritative data from PostgreSQL on each request (no startup probes).
// 2. Automatically commits all queued Drizzle mutations inside a PostgreSQL transaction
//    BEFORE sending any redirect/JSON/HTML response on mutating requests.
app.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/healthz') {
    next();
    return;
  }
  try {
    await store.syncFromDatabase();
  } catch (err) {
    console.error('[PostgreSQL Load Error]', err);
    if (req.headers['x-pvc-ajax'] === '1' || req.path.startsWith('/api/')) {
      res.status(503).json({ ok: false, error: 'Database is temporarily unavailable. Please try again.' });
    } else {
      res.status(503).send('Database is temporarily unavailable. Please refresh and try again.');
    }
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origRedirect = res.redirect.bind(res);
    const origJson = res.json.bind(res);
    const origSend = res.send.bind(res);
    let flushed = false;

    const commitThen = (proceed: () => unknown): Response => {
      if (flushed || !store.hasPendingDbOps()) {
        flushed = true;
        proceed();
        return res;
      }
      flushed = true;
      store
        .flushDbWrites()
        .then(() => {
          proceed();
        })
        .catch((err) => {
          console.error('[PostgreSQL Commit Error]', err);
          if (!res.headersSent) {
            if (req.headers['x-pvc-ajax'] === '1' || req.path.startsWith('/api/')) {
              origJson.call(res.status(500), { ok: false, error: 'Failed to save changes. Please try again.' });
            } else {
              origSend.call(res.status(500), 'Failed to save changes to the database. Please go back and try again.');
            }
          }
        });
      return res;
    };

    res.redirect = ((arg1: number | string, arg2?: number | string) => {
      commitThen(() => {
        if (typeof arg1 === 'number') {
          origRedirect(arg1, String(arg2 || '/'));
        } else if (typeof arg2 === 'number') {
          origRedirect(arg2, arg1);
        } else {
          origRedirect(arg1);
        }
      });
    }) as unknown as typeof res.redirect;

    res.json = ((body?: unknown) => commitThen(() => origJson(body))) as typeof res.json;

    res.send = ((body?: unknown) => commitThen(() => origSend(body))) as typeof res.send;
  }

  next();
});

// Inject template locals & resolve authenticated user (session -> signed cookie -> iframe fallback token)
app.use((req: Request, res: Response, next: NextFunction) => {
  let userId: number | undefined = req.session?.userId;
  let fallbackToken = '';

  if (!userId && req.cookies?.pvc_auth) {
    const uidFromCookie = verifyAuthToken(String(req.cookies.pvc_auth));
    if (uidFromCookie) {
      userId = uidFromCookie;
      if (req.session) req.session.userId = uidFromCookie;
    }
  }

  if (!userId) {
    const rawToken =
      (typeof req.query._t === 'string' && req.query._t) ||
      (req.body && typeof req.body._t === 'string' && req.body._t) ||
      (typeof req.headers['x-pvc-auth'] === 'string' && req.headers['x-pvc-auth']) ||
      '';
    if (rawToken) {
      const uidFromToken = verifyAuthToken(rawToken);
      if (uidFromToken) {
        userId = uidFromToken;
        fallbackToken = rawToken;
        if (req.session) req.session.userId = uidFromToken;
      }
    }
  }

  const user = userId ? store.getUserById(userId) : undefined;

  res.locals.current_user = user
    ? { ...user, is_authenticated: true }
    : { id: null, username: 'Guest', is_admin: false, is_authenticated: false };

  res.locals.pvc_fallback_token = fallbackToken;

  if (fallbackToken) {
    const origRedirect = res.redirect.bind(res);
    res.redirect = ((statusOrUrl: number | string, maybeUrl?: string) => {
      const hasStatus = typeof statusOrUrl === 'number';
      const status = hasStatus ? statusOrUrl : 302;
      let target = hasStatus ? String(maybeUrl || '/') : String(statusOrUrl);
      if (target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/login') && !target.startsWith('/register') && !target.includes('_t=')) {
        const sep = target.includes('?') ? '&' : '?';
        target = `${target}${sep}_t=${encodeURIComponent(fallbackToken)}`;
      }
      return origRedirect(status, target);
    }) as typeof res.redirect;
  }

  res.locals.request = {
    endpoint: '',
    path: req.path,
  };

  res.locals.get_flashed_messages = (_withCategories = true) => {
    const sessionFlashes = req.session?.flashes ? [...req.session.flashes] : [];
    if (req.session) req.session.flashes = [];
    const userFlashes = consumeUserFlashes(user?.id);
    if (sessionFlashes.length > 0) return sessionFlashes;
    return userFlashes;
  };

  next();
});

// Register routes
app.use('/', authRouter);
app.use('/', mainRouter);
app.use('/pvc', pvcRouter);
app.use('/admin', adminRouter);

// Health check
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', app: 'PVC Calculation Studio' });
});

// 404 handler
app.use((_req, res) => {
  res.status(404).send('Page not found');
});

// 500 error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Server Error]', err);
  res.status(500).send('Internal server error');
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`PVC Calculation Studio listening on http://0.0.0.0:${PORT}`);
});
