import express from 'express';
import { paginate, store } from '../store.js';
import { requireLogin } from './auth.js';

export const mainRouter = express.Router();

mainRouter.get('/', (_req, res) => {
  res.locals.request.endpoint = 'main.index';
  const stats = store.getStats();
  res.render('dashboard.html', { stats });
});

mainRouter.get('/history', requireLogin, (req, res) => {
  res.locals.request.endpoint = 'main.history';
  const page = parseInt(String(req.query.page || '1'), 10) || 1;
  const user = res.locals.current_user;
  const allRecords = user.is_admin ? store.getPVCResults() : store.getPVCResults(user.id);
  const pagination = paginate(allRecords, page, 25);
  res.render('history.html', {
    records: pagination.items,
    pagination,
  });
});
