import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { configureNunjucks } from './src/server/templateEngine.js';
import { store } from './src/server/store.js';
import { authRouter } from './src/server/routes/auth.js';
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

// Body & cookie parsing
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// Session middleware configured to work seamlessly both on localhost HTTP and AI Studio HTTPS iframe
app.use(
  session({
    name: 'pvc_session',
    secret: process.env.SECRET_KEY || 'clw-pvc-dev-secret-change-in-prod',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
      sameSite: 'lax',
      secure: false,
    },
  })
);

// Dynamically adjust SameSite=None; Secure when served over HTTPS proxy (AI Studio iframe)
app.use((req, _res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (req.session && req.session.cookie) {
    req.session.cookie.sameSite = isHttps ? 'none' : 'lax';
    req.session.cookie.secure = isHttps;
  }
  next();
});

// Static assets
app.use('/static', express.static(path.join(ROOT_DIR, 'static')));

// Configure Nunjucks template engine
configureNunjucks(app, path.join(ROOT_DIR, 'templates'));

// Inject Flask-compatible template context locals
app.use((req: Request, res: Response, next: NextFunction) => {
  const userId = req.session?.userId;
  const user = userId ? store.getUserById(userId) : undefined;

  res.locals.current_user = user
    ? { ...user, is_authenticated: true }
    : { id: null, username: 'Guest', is_admin: false, is_authenticated: false };

  res.locals.request = {
    endpoint: '',
    path: req.path,
  };

  res.locals.get_flashed_messages = (_withCategories = true) => {
    const flashes = req.session?.flashes ? [...req.session.flashes] : [];
    if (req.session) req.session.flashes = [];
    return flashes;
  };

  next();
});

// Register blueprints
app.use('/', authRouter);
app.use('/', mainRouter);
app.use('/pvc', pvcRouter);
app.use('/admin', adminRouter);

// Health check endpoint
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', app: 'CLW PVC Calculation System' });
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
  console.log(`CLW PVC Calculation System listening on http://0.0.0.0:${PORT}`);
});
