import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { store } from '../store.js';

export const authRouter = express.Router();

export function flashMessage(req: Request, message: string, category = 'info'): void {
  if (!req.session.flashes) req.session.flashes = [];
  req.session.flashes.push([category, message]);
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
  const password = String(req.body.password || '');

  const user = store.getUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    flashMessage(req, 'Invalid username or password', 'danger');
    res.redirect('/login');
    return;
  }

  // Auto-promote to admin if there are no admins yet
  if (!user.is_admin && !store.hasAdmin()) {
    store.updateUser(user.id, { is_admin: true }, user.id);
  }

  req.session.userId = user.id;
  const nextParam = String(req.query.next || '');
  const safeNext = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';
  res.redirect(safeNext);
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

authRouter.get('/logout', requireLogin, (req, res) => {
  req.session.userId = undefined;
  res.redirect('/login');
});
