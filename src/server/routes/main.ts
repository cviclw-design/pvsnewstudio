import express from 'express';
import { paginate, store } from '../store.js';
import { requireLogin } from './auth.js';

export const mainRouter = express.Router();

mainRouter.get('/', (_req, res) => {
  res.locals.request.endpoint = 'main.index';
  const stats = store.getStats();
  const items = store.getItems();
  const user = res.locals.current_user;
  const recentCalcs = user?.is_authenticated
    ? (user.is_admin ? store.getPVCResults() : store.getPVCResults(user.id)).slice(0, 8)
    : [];

  // Chronological monthly index series per item (values only — never proof files)
  const dashboardSeries = items.map((it) => {
    const rows = store.getItemIndices(it.id, 'asc').slice(-18);
    const paramSet = new Set<string>();
    const points = rows.map((r) => {
      let vals: Record<string, number> = {};
      try {
        const parsed = JSON.parse(r.indices_json || '{}') as Record<string, unknown>;
        for (const [k, v] of Object.entries(parsed)) {
          const num = Number(v);
          if (Number.isFinite(num)) {
            vals[k] = num;
            paramSet.add(k);
          }
        }
      } catch {
        vals = {};
      }
      return { month: r.month.slice(0, 7), values: vals };
    });
    return {
      id: it.id,
      name: it.name,
      code: it.code || '',
      formula: it.pvc_formula_code || '',
      source: it.index_source || 'IEEMA',
      keys: Array.from(paramSet),
      points,
    };
  });

  res.render('dashboard.html', { stats, items, recentCalcs, dashboardSeries });
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
