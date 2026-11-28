import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { evaluateMathExpression, parseItemComponents, safeFloat } from '../pvcEngine.js';
import { paginate, store } from '../store.js';
import { ComponentConfig, IndexAttachment, ItemRecord } from '../types.js';
import { flashMessage, requireAdmin, requireLogin } from './auth.js';

export const adminRouter = express.Router();

adminRouter.use(requireLogin);

const UPLOAD_DIR = path.resolve(process.cwd(), 'static/uploads/indices');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIMES: Record<string, { ext: string; type: 'image' | 'pdf' }> = {
  'application/pdf': { ext: '.pdf', type: 'pdf' },
  'image/png': { ext: '.png', type: 'image' },
  'image/jpeg': { ext: '.jpg', type: 'image' },
  'image/webp': { ext: '.webp', type: 'image' },
  'image/gif': { ext: '.gif', type: 'image' },
};

const indexUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (_req, file, cb) => {
      const meta = ALLOWED_MIMES[file.mimetype];
      const ext = meta ? meta.ext : path.extname(file.originalname).toLowerCase() || '.bin';
      const safeId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
      cb(null, `${safeId}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and image files (PNG, JPG, WEBP, GIF) are allowed.'));
    }
  },
});

function handleIndexUpload(req: Request, res: Response, next: NextFunction): void {
  indexUpload.array('index_files', 5)(req, res, (err: unknown) => {
    if (err) {
      flashMessage(req, err instanceof Error ? err.message : 'File upload failed.', 'danger');
      res.redirect(req.originalUrl);
      return;
    }
    next();
  });
}

function filesToAttachments(files: Express.Multer.File[] | undefined): IndexAttachment[] {
  if (!files || !files.length) return [];
  const now = new Date().toISOString();
  return files.map((f) => {
    const meta = ALLOWED_MIMES[f.mimetype];
    return {
      id: crypto.randomBytes(8).toString('hex'),
      original_name: f.originalname,
      stored_name: f.filename,
      mime_type: f.mimetype,
      file_type: meta ? meta.type : f.mimetype.includes('pdf') ? 'pdf' : 'image',
      size: f.size,
      url: `/static/uploads/indices/${f.filename}`,
      uploaded_at: now,
    };
  });
}

function normalizeMonthStart(dateStr: string): string | null {
  const s = String(dateStr || '').trim();
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

function nextMonthYYYYMM(monthStartIso: string | undefined): string {
  if (!monthStartIso) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  const m = /^(\d{4})-(\d{2})/.exec(monthStartIso);
  if (!m) return '';
  let y = Number(m[1]);
  let mo = Number(m[2]) + 1;
  if (mo > 12) {
    mo = 1;
    y += 1;
  }
  return `${y}-${String(mo).padStart(2, '0')}`;
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

function parseFlexibleMonthStart(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-01`;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 20000 && raw < 80000) {
    const dt = new Date(Math.round((raw - 25569) * 86400 * 1000));
    if (!isNaN(dt.getTime())) {
      const y = dt.getUTCFullYear();
      const mo = dt.getUTCMonth() + 1;
      if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12) {
        return `${y}-${String(mo).padStart(2, '0')}-01`;
      }
    }
  }
  const s = String(raw).trim();
  if (!s) return null;

  // YYYY-MM or YYYY-MM-DD or YYYY/MM or YYYY/MM/DD
  const iso = /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/.exec(s);
  if (iso) {
    const y = Number(iso[1]);
    const mo = Number(iso[2]);
    if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2, '0')}-01`;
    }
  }

  // MM/YYYY or MM-YYYY
  const mmyyyy = /^(\d{1,2})[-/](\d{4})$/.exec(s);
  if (mmyyyy) {
    const mo = Number(mmyyyy[1]);
    const y = Number(mmyyyy[2]);
    if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2, '0')}-01`;
    }
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (dmy) {
    const mo = Number(dmy[2]);
    const y = Number(dmy[3]);
    if (y >= 1990 && y <= 2100 && mo >= 1 && mo <= 12) {
      return `${y}-${String(mo).padStart(2, '0')}-01`;
    }
  }

  // Jan-2025, Jan 2025, January 2025, Jan-25
  const monFirst = /^([A-Za-z]+)[\s\-/]+(\d{2,4})$/.exec(s);
  if (monFirst) {
    const mo = MONTH_NAME_MAP[monFirst[1].toLowerCase()];
    let y = Number(monFirst[2]);
    if (y < 100) y += 2000;
    if (mo && y >= 1990 && y <= 2100) {
      return `${y}-${String(mo).padStart(2, '0')}-01`;
    }
  }

  // 2025-Jan, 2025 Jan
  const yrFirst = /^(\d{4})[\s\-/]+([A-Za-z]+)$/.exec(s);
  if (yrFirst) {
    const y = Number(yrFirst[1]);
    const mo = MONTH_NAME_MAP[yrFirst[2].toLowerCase()];
    if (mo && y >= 1990 && y <= 2100) {
      return `${y}-${String(mo).padStart(2, '0')}-01`;
    }
  }

  return null;
}

function getItemExpectedKeys(item: ItemRecord): { keys: string[]; labels: Record<string, string> } {
  let parsedWeights: Record<string, number> = {};
  try {
    parsedWeights = JSON.parse(item.weights_json || '{}');
  } catch {
    parsedWeights = {};
  }
  const components = parseItemComponents(item, parsedWeights);
  const keySet = new Set<string>();
  const labels: Record<string, string> = {};

  for (const c of components) {
    if (!c.key || c.key.toUpperCase() === 'FIXED') continue;
    keySet.add(c.key);
    labels[c.key] = c.label || c.key;
  }

  if ((item.pvc_formula_code || '').toUpperCase().includes('IGBT')) {
    for (const extra of ['D', 'ER_EUR', 'ER_USD', 'ER_JPY']) {
      keySet.add(extra);
    }
    labels.D = labels.D || 'Customs Duty (%)';
    labels.ER_EUR = labels.ER_EUR || 'Exchange Rate EUR';
    labels.ER_USD = labels.ER_USD || 'Exchange Rate USD';
    labels.ER_JPY = labels.ER_JPY || 'Exchange Rate JPY';
  }

  // Include keys present in existing index rows so nothing is lost
  const existing = store.getItemIndices(item.id, 'desc').slice(0, 12);
  for (const r of existing) {
    try {
      const obj = JSON.parse(r.indices_json || '{}') as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        if (k && k.toUpperCase() !== 'FIXED') {
          keySet.add(k);
          if (!labels[k]) labels[k] = k;
        }
      }
    } catch {
      // ignore
    }
  }

  if (keySet.size === 0) {
    keySet.add('C');
    labels.C = 'Copper';
  }

  return { keys: Array.from(keySet), labels };
}

const bulkSheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
});

function respondBulk(
  req: Request,
  res: Response,
  opts: {
    ok: boolean;
    message: string;
    category?: 'success' | 'danger' | 'warning' | 'info';
    redirectUrl: string;
    status?: number;
  }
): void {
  const isAjax = req.headers['x-pvc-ajax'] === '1';
  if (opts.ok) {
    flashMessage(req, opts.message, opts.category || 'success');
    if (isAjax) {
      res.status(200).json({ ok: true, message: opts.message, redirectUrl: opts.redirectUrl });
      return;
    }
    res.redirect(opts.redirectUrl);
    return;
  }
  if (isAjax) {
    res.status(opts.status || 400).json({ ok: false, error: opts.message });
    return;
  }
  flashMessage(req, opts.message, opts.category || 'danger');
  res.redirect(opts.redirectUrl);
}

function handleBulkSheetUpload(req: Request, res: Response, next: NextFunction): void {
  bulkSheetUpload.single('bulk_file')(req, res, (err: unknown) => {
    if (err) {
      const msg = err instanceof Error ? err.message : 'File upload failed.';
      const fallbackRedirect = req.originalUrl.includes('/tenders/') ? '/admin/tenders/bulk' : '/admin/indices/bulk';
      respondBulk(req, res, { ok: false, message: msg, category: 'danger', redirectUrl: fallbackRedirect, status: 400 });
      return;
    }
    next();
  });
}

function upsertMonthlyIndexValues(
  itemId: number,
  monthStart: string,
  values: Record<string, number>,
  mergeMode: boolean,
  userId: number
): 'created' | 'updated' {
  const existing = store.getItemIndexByMonth(itemId, monthStart);
  if (existing) {
    let nextObj: Record<string, number> = { ...values };
    if (mergeMode) {
      try {
        const prevObj = JSON.parse(existing.indices_json || '{}') as Record<string, number>;
        nextObj = { ...prevObj, ...values };
      } catch {
        nextObj = { ...values };
      }
    }
    store.updateItemIndex(itemId, existing.id, { month: monthStart, indices_json: JSON.stringify(nextObj) }, userId);
    return 'updated';
  }
  store.createItemIndex({ item_id: itemId, month: monthStart, indices_json: JSON.stringify(values), attachments: [] }, userId);
  return 'created';
}

// ── Items ─────────────────────────────────────────────────────────────────

adminRouter.get('/items', (_req, res) => {
  res.locals.request.endpoint = 'admin.items_list';
  const items = store.getItems();
  res.render('admin_items_list.html', { items });
});

adminRouter.get('/items/new', requireAdmin, (_req, res) => {
  res.locals.request.endpoint = 'admin.items_new';
  res.render('admin_items_form.html', { item: null });
});

function parseItemFormPayload(body: Record<string, unknown>): {
  ok: true;
  data: {
    name: string;
    code: string | null;
    pvc_formula_code: string;
    weights_json: string;
    extra_fields_json: string;
    description: string | null;
    lag_months: number;
    base_lag_months: number;
    fixed_weight: number;
    index_source: string | null;
    components_json: string;
    custom_formula: string | null;
  };
} | { ok: false; error: string } {
  const name = String(body.name || '').trim();
  const code = String(body.code || '').trim();
  const formula = String(body.pvcformulacode || '').trim() || 'IEEMA_WEIGHTED';
  const extrafieldsjson = String(body.extrafieldsjson || '').trim() || '[]';
  const description = String(body.description || '').trim();
  const indexSource = String(body.index_source || '').trim();
  const customFormula = String(body.custom_formula || '').trim();

  const rawLag = body.lag_months !== undefined && body.lag_months !== '' ? Number(body.lag_months) : 1;
  const lagMonths = Number.isFinite(rawLag) ? Math.max(0, Math.min(12, Math.floor(rawLag))) : 1;

  const rawBaseLag = body.base_lag_months !== undefined && body.base_lag_months !== '' ? Number(body.base_lag_months) : 0;
  const baseLagMonths = Number.isFinite(rawBaseLag) ? Math.max(0, Math.min(12, Math.floor(rawBaseLag))) : 0;

  const rawFixed = body.fixed_weight !== undefined && body.fixed_weight !== '' ? Number(body.fixed_weight) : NaN;

  if (!name || !formula) {
    return { ok: false, error: 'Name and formula are required.' };
  }

  try {
    JSON.parse(extrafieldsjson);
  } catch {
    return { ok: false, error: 'Extra fields must be valid JSON.' };
  }

  let components: ComponentConfig[] = [];
  const rawComponentsStr = String(body.componentsjson || '').trim();
  const rawWeightsStr = String(body.weightsjson || '').trim();

  if (rawComponentsStr) {
    try {
      const parsed = JSON.parse(rawComponentsStr);
      if (Array.isArray(parsed)) {
        for (const c of parsed) {
          const key = String(c?.key || '').trim();
          if (!key || key.toUpperCase() === 'FIXED') continue;
          const weight = Number(c?.weight ?? 0);
          const cLag =
            c?.lag_months !== undefined && c?.lag_months !== null && c?.lag_months !== ''
              ? Math.max(0, Math.min(12, Math.floor(Number(c.lag_months))))
              : null;
          components.push({
            key,
            label: String(c?.label || key).trim(),
            weight: Number.isFinite(weight) ? weight : 0,
            lag_months: cLag !== null && Number.isFinite(cLag) ? cLag : null,
            source: c?.source ? String(c.source).trim() : indexSource || null,
          });
        }
      }
    } catch {
      return { ok: false, error: 'Components configuration is invalid JSON.' };
    }
  }

  let weightsObj: Record<string, number> = {};
  if (components.length > 0) {
    const fixedVal = Number.isFinite(rawFixed) ? rawFixed : Math.max(0, 100 - components.reduce((s, c) => s + c.weight, 0));
    weightsObj.FIXED = fixedVal;
    for (const c of components) {
      weightsObj[c.key] = c.weight;
    }
  } else if (rawWeightsStr) {
    try {
      const parsedW = JSON.parse(rawWeightsStr) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsedW || {})) {
        const n = Number(v);
        if (Number.isFinite(n)) weightsObj[k] = n;
      }
      components = Object.entries(weightsObj)
        .filter(([k]) => k.toUpperCase() !== 'FIXED')
        .map(([k, w]) => ({
          key: k,
          label: k,
          weight: w,
          lag_months: null,
          source: indexSource || null,
        }));
    } catch {
      return { ok: false, error: 'Weights must be valid JSON.' };
    }
  }

  const fixedWeight = Number.isFinite(rawFixed)
    ? rawFixed
    : weightsObj.FIXED !== undefined
      ? weightsObj.FIXED
      : Math.max(0, 100 - components.reduce((s, c) => s + c.weight, 0));

  if (weightsObj.FIXED === undefined) {
    weightsObj.FIXED = fixedWeight;
  }

  if (formula.toUpperCase() === 'CUSTOM_EXPRESSION') {
    if (!customFormula) {
      return { ok: false, error: 'Custom formula expression is required.' };
    }
    const testVars: Record<string, number> = { F: fixedWeight, FIXED: fixedWeight };
    for (const c of components) {
      testVars[c.key] = 110;
      testVars[c.key.toUpperCase()] = 110;
      testVars[`${c.key}0`] = 100;
      testVars[`${c.key.toUpperCase()}0`] = 100;
      testVars[`W_${c.key}`] = c.weight;
      testVars[`W_${c.key.toUpperCase()}`] = c.weight;
    }
    try {
      evaluateMathExpression(customFormula, testVars);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid custom formula.' };
    }
  }

  return {
    ok: true,
    data: {
      name,
      code: code || null,
      pvc_formula_code: formula,
      weights_json: JSON.stringify(weightsObj),
      extra_fields_json: extrafieldsjson,
      description: description || null,
      lag_months: lagMonths,
      base_lag_months: baseLagMonths,
      fixed_weight: fixedWeight,
      index_source: indexSource || null,
      components_json: JSON.stringify(components),
      custom_formula: customFormula || null,
    },
  };
}

adminRouter.post('/items/new', requireAdmin, (req, res) => {
  const parsed = parseItemFormPayload(req.body as Record<string, unknown>);
  if ('error' in parsed) {
    flashMessage(req, parsed.error, 'danger');
    res.redirect('/admin/items/new');
    return;
  }
  if (store.getItemByName(parsed.data.name)) {
    flashMessage(req, 'An item with that name already exists.', 'danger');
    res.redirect('/admin/items/new');
    return;
  }
  store.createItem(parsed.data, res.locals.current_user.id);
  flashMessage(req, 'Item added successfully.', 'success');
  res.redirect('/admin/items');
});

adminRouter.get('/items/:itemid/edit', requireAdmin, (req, res) => {
  res.locals.request.endpoint = 'admin.items_edit';
  const item = store.getItemById(parseInt(req.params.itemid, 10));
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }
  res.render('admin_items_form.html', { item });
});

adminRouter.post('/items/:itemid/edit', requireAdmin, (req, res) => {
  const itemId = parseInt(req.params.itemid, 10);
  const item = store.getItemById(itemId);
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }

  const parsed = parseItemFormPayload(req.body as Record<string, unknown>);
  if ('error' in parsed) {
    flashMessage(req, parsed.error, 'danger');
    res.redirect(`/admin/items/${item.id}/edit`);
    return;
  }
  const dupItem = store.getItemByName(parsed.data.name);
  if (dupItem && dupItem.id !== item.id) {
    flashMessage(req, 'Another item with that name already exists.', 'danger');
    res.redirect(`/admin/items/${item.id}/edit`);
    return;
  }

  store.updateItem(item.id, parsed.data, res.locals.current_user.id);
  flashMessage(req, 'Item updated successfully.', 'success');
  res.redirect('/admin/items');
});

adminRouter.post('/items/:itemid/delete', requireAdmin, (req, res) => {
  const itemId = parseInt(req.params.itemid, 10);
  const result = store.deleteItem(itemId, res.locals.current_user.id);
  if (result.ok) {
    flashMessage(req, 'Item and associated indices deleted.', 'success');
  } else {
    flashMessage(req, result.error || 'Cannot delete item.', 'danger');
  }
  res.redirect('/admin/items');
});

// ── Item Indices (with Image & PDF attachments) ───────────────────────────

adminRouter.get('/items/:itemid/indices', (req, res) => {
  res.locals.request.endpoint = 'admin.item_indices_list';
  const item = store.getItemById(parseInt(req.params.itemid, 10));
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }
  const page = parseInt(String(req.query.page || '1'), 10) || 1;
  const allRows = store.getItemIndices(item.id, 'desc');
  const pagination = paginate(allRows, page, 25);
  res.render('admin_item_indices_list.html', {
    item,
    rows: pagination.items,
    pagination,
  });
});

adminRouter.get('/items/:itemid/indices/new', (req, res) => {
  res.locals.request.endpoint = 'admin.item_indices_new';
  const item = store.getItemById(parseInt(req.params.itemid, 10));
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }
  let parsedWeights: Record<string, number> = {};
  try { parsedWeights = JSON.parse(item.weights_json || '{}'); } catch { parsedWeights = {}; }
  const itemComponents = parseItemComponents(item, parsedWeights);

  const latest = store.getItemIndices(item.id, 'desc')[0];
  let defaultIndices = latest ? latest.indices_json : '';
  if (!defaultIndices) {
    const template: Record<string, number> = {};
    for (const c of itemComponents) {
      template[c.key] = 100;
    }
    if (Object.keys(template).length === 0) {
      template.C = 100;
    }
    if ((item.pvc_formula_code || '').toUpperCase().includes('IGBT')) {
      template.D = 7.5;
      template.ER_EUR = 90;
      template.ER_USD = 84;
    }
    defaultIndices = JSON.stringify(template);
  }
  res.render('admin_item_indices_form.html', {
    item,
    row: null,
    default_month: nextMonthYYYYMM(latest?.month),
    default_indices_json: defaultIndices,
    item_components: itemComponents,
  });
});

adminRouter.post('/items/:itemid/indices/new', handleIndexUpload, (req, res) => {
  const item = store.getItemById(parseInt(req.params.itemid, 10));
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }
  const month = normalizeMonthStart(String(req.body.month || ''));
  if (!month) {
    flashMessage(req, 'Invalid month date. Use YYYY-MM-DD format.', 'danger');
    res.redirect(`/admin/items/${item.id}/indices/new`);
    return;
  }
  const indicesjson = String(req.body.indicesjson || '').trim() || '{}';
  try {
    JSON.parse(indicesjson);
  } catch {
    flashMessage(req, 'Indices must be valid JSON, e.g. {"C":100,"AL":200}.', 'danger');
    res.redirect(`/admin/items/${item.id}/indices/new`);
    return;
  }
  if (store.getItemIndexByMonth(item.id, month)) {
    flashMessage(req, `Indices for ${month.slice(0, 7)} already exist. Edit instead.`, 'warning');
    res.redirect(`/admin/items/${item.id}/indices`);
    return;
  }

  const attachments = filesToAttachments(req.files as Express.Multer.File[] | undefined);
  store.createItemIndex(
    { item_id: item.id, month, indices_json: indicesjson, attachments },
    res.locals.current_user.id
  );
  flashMessage(
    req,
    attachments.length
      ? `Indices for ${month.slice(0, 7)} added with ${attachments.length} proof file(s).`
      : `Indices for ${month.slice(0, 7)} added.`,
    'success'
  );
  res.redirect(`/admin/items/${item.id}/indices`);
});

adminRouter.get('/items/:itemid/indices/:rowid/edit', (req, res) => {
  res.locals.request.endpoint = 'admin.item_indices_edit';
  const item = store.getItemById(parseInt(req.params.itemid, 10));
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }
  const row = store.getItemIndexById(item.id, parseInt(req.params.rowid, 10));
  if (!row) {
    res.status(404).send('Index row not found');
    return;
  }
  let parsedWeights: Record<string, number> = {};
  try { parsedWeights = JSON.parse(item.weights_json || '{}'); } catch { parsedWeights = {}; }
  const itemComponents = parseItemComponents(item, parsedWeights);
  res.render('admin_item_indices_form.html', { item, row, item_components: itemComponents });
});

adminRouter.post('/items/:itemid/indices/:rowid/edit', handleIndexUpload, (req, res) => {
  const item = store.getItemById(parseInt(req.params.itemid, 10));
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }
  const row = store.getItemIndexById(item.id, parseInt(req.params.rowid, 10));
  if (!row) {
    res.status(404).send('Index row not found');
    return;
  }
  const month = normalizeMonthStart(String(req.body.month || ''));
  if (!month) {
    flashMessage(req, 'Invalid month date. Use YYYY-MM-DD format.', 'danger');
    res.redirect(`/admin/items/${item.id}/indices/${row.id}/edit`);
    return;
  }
  const indicesjson = String(req.body.indicesjson || '').trim() || '{}';
  try {
    JSON.parse(indicesjson);
  } catch {
    flashMessage(req, 'Indices must be valid JSON, e.g. {"C":100,"AL":200}.', 'danger');
    res.redirect(`/admin/items/${item.id}/indices/${row.id}/edit`);
    return;
  }

  const dupMonth = store.getItemIndexByMonth(item.id, month);
  if (dupMonth && dupMonth.id !== row.id) {
    flashMessage(req, `Another index record for ${month.slice(0, 7)} already exists.`, 'warning');
    res.redirect(`/admin/items/${item.id}/indices/${row.id}/edit`);
    return;
  }

  store.updateItemIndex(item.id, row.id, { month, indices_json: indicesjson }, res.locals.current_user.id);
  const newAttachments = filesToAttachments(req.files as Express.Multer.File[] | undefined);
  if (newAttachments.length > 0) {
    store.addIndexAttachments(item.id, row.id, newAttachments, res.locals.current_user.id);
  }
  flashMessage(
    req,
    newAttachments.length
      ? `Indices updated and ${newAttachments.length} proof file(s) attached.`
      : 'Indices updated.',
    'success'
  );
  res.redirect(`/admin/items/${item.id}/indices`);
});

adminRouter.post('/items/:itemid/indices/:rowid/attachments/:attid/delete', (req, res) => {
  const itemId = parseInt(req.params.itemid, 10);
  const rowId = parseInt(req.params.rowid, 10);
  const attId = String(req.params.attid || '');
  const removed = store.removeIndexAttachment(itemId, rowId, attId, res.locals.current_user.id);
  if (removed) {
    const filePath = path.join(UPLOAD_DIR, path.basename(removed.stored_name));
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore disk cleanup failure
    }
    flashMessage(req, `Removed attachment "${removed.original_name}".`, 'success');
  } else {
    flashMessage(req, 'Attachment not found.', 'warning');
  }
  res.redirect(`/admin/items/${itemId}/indices/${rowId}/edit`);
});

adminRouter.post('/items/:itemid/indices/:rowid/delete', (req, res) => {
  const itemId = parseInt(req.params.itemid, 10);
  const rowId = parseInt(req.params.rowid, 10);
  const row = store.getItemIndexById(itemId, rowId);
  if (row && Array.isArray(row.attachments)) {
    for (const att of row.attachments) {
      const filePath = path.join(UPLOAD_DIR, path.basename(att.stored_name));
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
  }
  store.deleteItemIndex(itemId, rowId, res.locals.current_user.id);
  flashMessage(req, 'Index row deleted.', 'success');
  res.redirect(`/admin/items/${itemId}/indices`);
});

// ── Bulk Monthly Indices Update ───────────────────────────────────────────

adminRouter.get('/indices/bulk', (req, res) => {
  res.locals.request.endpoint = 'admin.indices_bulk';
  const items = store.getItems();
  const reqItemId = parseInt(String(req.query.itemid || ''), 10);
  const selectedItemId = items.some((it) => it.id === reqItemId) ? reqItemId : items[0]?.id ?? null;

  const itemsMeta = items.map((it) => {
    const { keys, labels } = getItemExpectedKeys(it);
    const rows = store.getItemIndices(it.id, 'desc');
    const existingMonths = rows.map((r) => {
      let values: Record<string, number> = {};
      try {
        values = JSON.parse(r.indices_json || '{}');
      } catch {
        values = {};
      }
      return {
        id: r.id,
        month: r.month.slice(0, 7),
        values,
      };
    });
    return {
      id: it.id,
      name: it.name,
      code: it.code || '',
      formula: it.pvc_formula_code || '',
      source: it.index_source || 'IEEMA',
      keys,
      labels,
      existingMonths,
      nextMonth: nextMonthYYYYMM(rows[0]?.month),
    };
  });

  const now = new Date();
  const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  res.render('admin_indices_bulk.html', {
    items,
    selectedItemId,
    itemsMeta,
    defaultMonth,
  });
});

adminRouter.get('/indices/bulk/template', (req, res) => {
  const itemId = parseInt(String(req.query.itemid || ''), 10);
  const item = store.getItemById(itemId) || store.getItems()[0];
  if (!item) {
    res.status(404).send('No item configured');
    return;
  }
  const { keys } = getItemExpectedKeys(item);
  const existing = store.getItemIndices(item.id, 'asc').slice(-12);

  const sheetRows: Array<Record<string, string | number>> = [];
  if (existing.length > 0) {
    for (const r of existing) {
      let vals: Record<string, unknown> = {};
      try {
        vals = JSON.parse(r.indices_json || '{}');
      } catch {
        vals = {};
      }
      const rowObj: Record<string, string | number> = { Month: r.month.slice(0, 7) };
      for (const k of keys) {
        const n = Number(vals[k]);
        rowObj[k] = Number.isFinite(n) ? n : '';
      }
      sheetRows.push(rowObj);
    }
  } else {
    const sampleRow: Record<string, string | number> = { Month: nextMonthYYYYMM(undefined) };
    for (const k of keys) sampleRow[k] = 100;
    sheetRows.push(sampleRow);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows, { header: ['Month', ...keys] });
  XLSX.utils.book_append_sheet(wb, ws, 'MonthlyIndices');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const safeSlug = (item.code || item.name || `item_${item.id}`).replace(/[^a-zA-Z0-9_-]+/g, '_');

  res.setHeader('Content-Disposition', `attachment; filename="indices_template_${safeSlug}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

adminRouter.post('/indices/bulk/save', (req, res) => {
  const itemId = parseInt(String(req.body.itemid || ''), 10);
  const item = store.getItemById(itemId);
  if (!item) {
    respondBulk(req, res, { ok: false, message: 'Please select a valid item.', category: 'danger', redirectUrl: '/admin/indices/bulk' });
    return;
  }

  const mergeMode = String(req.body.merge_mode || 'merge') !== 'replace';
  const rawRowsStr = String(req.body.rows_json || '').trim();
  let parsedRows: Array<{ month?: unknown; values?: Record<string, unknown> }> = [];
  try {
    const raw = JSON.parse(rawRowsStr);
    if (!Array.isArray(raw)) throw new Error('Not array');
    parsedRows = raw;
  } catch {
    respondBulk(req, res, { ok: false, message: 'Invalid bulk indices payload.', category: 'danger', redirectUrl: `/admin/indices/bulk?itemid=${item.id}` });
    return;
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const userId = res.locals.current_user.id;

  for (const row of parsedRows) {
    const monthStart = parseFlexibleMonthStart(row?.month);
    if (!monthStart) {
      skipped += 1;
      continue;
    }
    const cleanValues: Record<string, number> = {};
    for (const [k, v] of Object.entries(row?.values || {})) {
      const key = String(k || '').trim();
      if (!key || key.toUpperCase() === 'FIXED') continue;
      if (v === '' || v === null || v === undefined) continue;
      const num = Number(v);
      if (Number.isFinite(num)) {
        cleanValues[key] = num;
      }
    }
    if (Object.keys(cleanValues).length === 0) {
      skipped += 1;
      continue;
    }
    const status = upsertMonthlyIndexValues(item.id, monthStart, cleanValues, mergeMode, userId);
    if (status === 'created') created += 1;
    else updated += 1;
  }

  if (created === 0 && updated === 0) {
    respondBulk(req, res, { ok: false, message: 'No valid monthly index rows found to save.', category: 'warning', redirectUrl: `/admin/indices/bulk?itemid=${item.id}` });
    return;
  }

  const parts = [];
  if (created > 0) parts.push(`${created} month(s) created`);
  if (updated > 0) parts.push(`${updated} month(s) updated`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  respondBulk(req, res, {
    ok: true,
    message: `Bulk update for ${item.name}: ${parts.join(', ')}.`,
    category: 'success',
    redirectUrl: `/admin/items/${item.id}/indices`,
  });
});

adminRouter.post('/indices/bulk/upload', handleBulkSheetUpload, (req, res) => {
  const itemId = parseInt(String(req.body.itemid || ''), 10);
  const item = store.getItemById(itemId);
  if (!item) {
    respondBulk(req, res, { ok: false, message: 'Please select a valid item.', category: 'danger', redirectUrl: '/admin/indices/bulk' });
    return;
  }
  const file = req.file;
  if (!file || !file.buffer) {
    respondBulk(req, res, { ok: false, message: 'Please choose an Excel (.xlsx / .xls) or CSV file.', category: 'danger', redirectUrl: `/admin/indices/bulk?itemid=${item.id}` });
    return;
  }

  const mergeMode = String(req.body.merge_mode || 'merge') !== 'replace';
  const userId = res.locals.current_user.id;

  try {
    const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: false });
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) {
      respondBulk(req, res, { ok: false, message: 'Uploaded file contains no sheets.', category: 'danger', redirectUrl: `/admin/indices/bulk?itemid=${item.id}` });
      return;
    }
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[firstSheetName], { defval: '' });
    if (!rows.length) {
      respondBulk(req, res, { ok: false, message: 'Uploaded sheet has no data rows.', category: 'warning', redirectUrl: `/admin/indices/bulk?itemid=${item.id}` });
      return;
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const rawRow of rows) {
      let monthKey: string | null = null;
      for (const col of Object.keys(rawRow)) {
        const lower = col.trim().toLowerCase();
        if (lower === 'month' || lower === 'date' || lower === 'period' || lower === 'year-month' || lower === 'yyyy-mm') {
          monthKey = col;
          break;
        }
      }
      if (!monthKey) {
        monthKey = Object.keys(rawRow)[0] || null;
      }
      const monthStart = monthKey ? parseFlexibleMonthStart(rawRow[monthKey]) : null;
      if (!monthStart) {
        skipped += 1;
        continue;
      }

      const cleanValues: Record<string, number> = {};
      for (const [col, val] of Object.entries(rawRow)) {
        if (col === monthKey) continue;
        const key = col.trim();
        if (!key || key.toUpperCase() === 'FIXED' || key.startsWith('__EMPTY')) continue;
        if (val === '' || val === null || val === undefined) continue;
        const num = Number(String(val).replace(/,/g, '').trim());
        if (Number.isFinite(num)) {
          cleanValues[key] = num;
        }
      }

      if (Object.keys(cleanValues).length === 0) {
        skipped += 1;
        continue;
      }

      const status = upsertMonthlyIndexValues(item.id, monthStart, cleanValues, mergeMode, userId);
      if (status === 'created') created += 1;
      else updated += 1;
    }

    if (created === 0 && updated === 0) {
      respondBulk(req, res, { ok: false, message: 'No valid month rows found in uploaded file.', category: 'warning', redirectUrl: `/admin/indices/bulk?itemid=${item.id}` });
      return;
    }

    const parts = [];
    if (created > 0) parts.push(`${created} created`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    respondBulk(req, res, {
      ok: true,
      message: `Imported ${file.originalname} for ${item.name}: ${parts.join(', ')}.`,
      category: 'success',
      redirectUrl: `/admin/items/${item.id}/indices`,
    });
  } catch (err) {
    respondBulk(req, res, {
      ok: false,
      message: `Failed to parse file: ${err instanceof Error ? err.message : 'Unknown error'}`,
      category: 'danger',
      redirectUrl: `/admin/indices/bulk?itemid=${item.id}`,
    });
  }
});

adminRouter.post('/indices/bulk/month', (req, res) => {
  const monthStart = parseFlexibleMonthStart(req.body.month);
  if (!monthStart) {
    respondBulk(req, res, { ok: false, message: 'Please select a valid month (YYYY-MM).', category: 'danger', redirectUrl: '/admin/indices/bulk' });
    return;
  }

  let itemsPayload: Array<{ itemid?: unknown; values?: Record<string, unknown> }> = [];
  try {
    const raw = JSON.parse(String(req.body.items_payload_json || '[]'));
    if (!Array.isArray(raw)) throw new Error('Invalid payload');
    itemsPayload = raw;
  } catch {
    respondBulk(req, res, { ok: false, message: 'Invalid multi-item update payload.', category: 'danger', redirectUrl: '/admin/indices/bulk' });
    return;
  }

  let created = 0;
  let updated = 0;
  const userId = res.locals.current_user.id;

  for (const entry of itemsPayload) {
    const itemId = Number(entry?.itemid);
    if (!Number.isFinite(itemId) || !store.getItemById(itemId)) continue;
    const cleanValues: Record<string, number> = {};
    for (const [k, v] of Object.entries(entry?.values || {})) {
      const key = String(k || '').trim();
      if (!key || key.toUpperCase() === 'FIXED') continue;
      if (v === '' || v === null || v === undefined) continue;
      const num = Number(v);
      if (Number.isFinite(num)) cleanValues[key] = num;
    }
    if (Object.keys(cleanValues).length === 0) continue;
    const status = upsertMonthlyIndexValues(itemId, monthStart, cleanValues, true, userId);
    if (status === 'created') created += 1;
    else updated += 1;
  }

  if (created === 0 && updated === 0) {
    respondBulk(req, res, { ok: false, message: 'No items selected or no valid values provided.', category: 'warning', redirectUrl: '/admin/indices/bulk' });
    return;
  }

  respondBulk(req, res, {
    ok: true,
    message: `Month ${monthStart.slice(0, 7)} updated across ${created + updated} item(s) (${created} created, ${updated} updated).`,
    category: 'success',
    redirectUrl: '/admin/indices/bulk',
  });
});

// ── Tenders ───────────────────────────────────────────────────────────────

function parseFlexibleDateYMD(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    const y = raw.getUTCFullYear();
    const m = String(raw.getUTCMonth() + 1).padStart(2, '0');
    const d = String(raw.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 10000 && raw < 100000) {
    const dt = new Date(Math.round((raw - 25569) * 86400 * 1000));
    if (!isNaN(dt.getTime())) {
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  const s = String(raw).trim();
  if (!s) return null;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const da = Number(m[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    }
  }

  // DD-MM-YYYY or DD/MM/YYYY
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) {
    const da = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    }
  }

  // DD-MMM-YYYY or DD MMM YYYY (e.g. 01-Apr-2024)
  const monMap: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  m = /^(\d{1,2})[-\s/]([a-zA-Z]{3,9})[-\s/](\d{2,4})$/.exec(s);
  if (m) {
    const da = Number(m[1]);
    const mo = monMap[m[2].slice(0, 3).toLowerCase()];
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    if (mo && da >= 1 && da <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
    }
  }

  // Fallback to month-start format (YYYY-MM or MMM-YYYY)
  const monthFallback = parseFlexibleMonthStart(s);
  if (monthFallback) return monthFallback;

  return null;
}

function resolveItemForBulk(rawItem: unknown, fallbackItemId: number | null): ItemRecord | undefined {
  const items = store.getItems();
  const s = String(rawItem ?? '').trim();
  if (s) {
    if (/^\d+$/.test(s)) {
      const byId = store.getItemById(parseInt(s, 10));
      if (byId) return byId;
    }
    const lower = s.toLowerCase();
    const byCode = items.find((it) => (it.code || '').trim().toLowerCase() === lower);
    if (byCode) return byCode;
    const byName = items.find((it) => it.name.trim().toLowerCase() === lower);
    if (byName) return byName;
    const byCombined = items.find(
      (it) => `${it.name}${it.code ? ` (${it.code})` : ''}`.trim().toLowerCase() === lower
    );
    if (byCombined) return byCombined;
    const partialMatches = items.filter(
      (it) => it.name.toLowerCase().includes(lower) || lower.includes(it.name.toLowerCase())
    );
    if (partialMatches.length === 1) return partialMatches[0];
  }
  if (fallbackItemId != null) {
    return store.getItemById(fallbackItemId);
  }
  return undefined;
}

interface BulkTenderVendorInput {
  item?: unknown;
  tender_no?: unknown;
  basicrate?: unknown;
  pvcbasedate?: unknown;
  freightrateperunit?: unknown;
  gst_rate?: unknown;
  vendor_name?: unknown;
  po_no?: unknown;
  cif?: unknown;
  vendor_freight?: unknown;
  currency?: unknown;
}

function parseOptionalNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const cleaned = String(raw).replace(/[₹,\s%]/g, '').trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function processBulkTenderVendorRows(
  rows: BulkTenderVendorInput[],
  fallbackItemId: number | null,
  userId: number
): {
  tendersCreated: number;
  tendersUpdated: number;
  vendorsCreated: number;
  vendorsUpdated: number;
  skipped: number;
} {
  let tendersCreated = 0;
  let tendersUpdated = 0;
  let vendorsCreated = 0;
  let vendorsUpdated = 0;
  let skipped = 0;

  // Track tenders touched within this batch so multiple vendor rows for the same tender
  // don't double-count tender updates or overwrite tender fields with blank cells.
  const touchedTenders = new Set<number>();

  for (const row of rows) {
    const tenderNo = String(row.tender_no ?? '').trim();
    if (!tenderNo) {
      skipped += 1;
      continue;
    }

    const existingTender = store.getTenderByNo(tenderNo);
    const resolvedItem = resolveItemForBulk(row.item, fallbackItemId);

    const parsedBasic = parseOptionalNumber(row.basicrate);
    const parsedDate = parseFlexibleDateYMD(row.pvcbasedate);
    const parsedTenderFreight = parseOptionalNumber(row.freightrateperunit);
    const parsedGst = parseOptionalNumber(row.gst_rate);
    const parsedVendorFreight = parseOptionalNumber(row.vendor_freight);

    let tenderId: number;
    if (existingTender) {
      tenderId = existingTender.id;
      const patch: Record<string, unknown> = {};
      if (resolvedItem && resolvedItem.id !== existingTender.item_id && !touchedTenders.has(tenderId)) {
        patch.item_id = resolvedItem.id;
      }
      if (parsedBasic !== null) patch.basicrate = parsedBasic;
      if (parsedDate !== null) patch.pvcbasedate = parsedDate;
      if (parsedTenderFreight !== null) patch.freightrateperunit = parsedTenderFreight;
      if (parsedGst !== null) patch.gst_rate = parsedGst;

      if (Object.keys(patch).length > 0) {
        store.updateTender(tenderId, patch, userId);
        if (!touchedTenders.has(tenderId)) {
          tendersUpdated += 1;
          touchedTenders.add(tenderId);
        }
      } else {
        touchedTenders.add(tenderId);
      }
    } else {
      if (!resolvedItem) {
        skipped += 1;
        continue;
      }
      const createdTender = store.createTender(
        {
          item_id: resolvedItem.id,
          tender_no: tenderNo,
          basicrate: parsedBasic ?? 0,
          pvcbasedate: parsedDate,
          freightrateperunit: parsedTenderFreight ?? parsedVendorFreight ?? 0,
          gst_rate: parsedGst ?? 18,
        },
        userId
      );
      tenderId = createdTender.id;
      tendersCreated += 1;
      touchedTenders.add(tenderId);
    }

    const vendorName = String(row.vendor_name ?? '').trim();
    if (vendorName) {
      const poNo = String(row.po_no ?? '').trim() || null;
      const cifVal = parseOptionalNumber(row.cif) ?? 0;
      const vFreightVal = parsedVendorFreight ?? parsedTenderFreight ?? 0;
      const currencyVal = String(row.currency ?? '').trim().toUpperCase() || 'INR';

      const existingVendor = store.getTenderVendorByName(tenderId, vendorName);
      if (existingVendor) {
        store.updateTenderVendor(
          tenderId,
          existingVendor.id,
          {
            vendor_name: vendorName,
            po_no: poNo ?? existingVendor.po_no,
            cif: parseOptionalNumber(row.cif) !== null ? cifVal : existingVendor.cif,
            freightrateperunit:
              parsedVendorFreight !== null || parsedTenderFreight !== null
                ? vFreightVal
                : existingVendor.freightrateperunit,
            currency: String(row.currency ?? '').trim() ? currencyVal : existingVendor.currency,
          },
          userId
        );
        vendorsUpdated += 1;
      } else {
        store.createTenderVendor(
          {
            tender_id: tenderId,
            vendor_name: vendorName,
            po_no: poNo,
            cif: cifVal,
            freightrateperunit: vFreightVal,
            currency: currencyVal,
          },
          userId
        );
        vendorsCreated += 1;
      }
    }
  }

  return { tendersCreated, tendersUpdated, vendorsCreated, vendorsUpdated, skipped };
}

adminRouter.get('/tenders', (_req, res) => {
  res.locals.request.endpoint = 'admin.tenders_list';
  const tenders = store.getTenders();
  res.render('admin_tenders_list.html', { tenders });
});

adminRouter.get('/tenders/bulk', (_req, res) => {
  res.locals.request.endpoint = 'admin.tenders_bulk';
  const items = store.getItems();
  const tenders = store.getTenders();
  const existingFlatRows: Array<Record<string, unknown>> = [];
  for (const t of tenders) {
    if (t.vendors && t.vendors.length > 0) {
      for (const v of t.vendors) {
        existingFlatRows.push({
          item_id: t.item_id,
          tender_no: t.tender_no,
          basicrate: t.basicrate ?? 0,
          pvcbasedate: t.pvcbasedate || '',
          freightrateperunit: t.freightrateperunit ?? v.freightrateperunit ?? 0,
          gst_rate: t.gst_rate ?? 18,
          vendor_name: v.vendor_name,
          po_no: v.po_no || '',
          cif: v.cif ?? 0,
          vendor_freight: v.freightrateperunit ?? 0,
          currency: v.currency || 'INR',
        });
      }
    } else {
      existingFlatRows.push({
        item_id: t.item_id,
        tender_no: t.tender_no,
        basicrate: t.basicrate ?? 0,
        pvcbasedate: t.pvcbasedate || '',
        freightrateperunit: t.freightrateperunit ?? 0,
        gst_rate: t.gst_rate ?? 18,
        vendor_name: '',
        po_no: '',
        cif: '',
        vendor_freight: '',
        currency: 'INR',
      });
    }
  }
  res.render('admin_tenders_bulk.html', {
    items,
    existingFlatRows,
    existingTenderNos: tenders.map((t) => t.tender_no),
  });
});

adminRouter.get('/tenders/bulk/template', (_req, res) => {
  const items = store.getItems();
  const sampleItem1 = items[0]?.name || 'IGBT Propulsion System';
  const sampleItem2 = items[1]?.name || sampleItem1;

  const headers = [
    'Item',
    'Tender No',
    'Basic Rate',
    'PVC Base Date',
    'Freight',
    'GST %',
    'Vendor Name',
    'PO No',
    'CIF',
    'Vendor Freight',
    'Currency',
  ];

  const sampleRows = [
    {
      Item: sampleItem1,
      'Tender No': 'TND/2025/SAMPLE-01',
      'Basic Rate': 27500000,
      'PVC Base Date': '2025-01-01',
      Freight: 80000,
      'GST %': 18,
      'Vendor Name': 'M/s Vendor Alpha',
      'PO No': 'PO2500101',
      CIF: 5800000,
      'Vendor Freight': 80000,
      Currency: 'EUR',
    },
    {
      Item: sampleItem1,
      'Tender No': 'TND/2025/SAMPLE-01',
      'Basic Rate': 27500000,
      'PVC Base Date': '2025-01-01',
      Freight: 80000,
      'GST %': 18,
      'Vendor Name': 'M/s Vendor Beta',
      'PO No': 'PO2500102',
      CIF: 5650000,
      'Vendor Freight': 76000,
      Currency: 'USD',
    },
    {
      Item: sampleItem2,
      'Tender No': 'TND/2025/SAMPLE-02',
      'Basic Rate': 3180000,
      'PVC Base Date': '2025-02-01',
      Freight: 21500,
      'GST %': 18,
      'Vendor Name': 'M/s Vendor Gamma',
      'PO No': 'PO2500201',
      CIF: 0,
      'Vendor Freight': 21500,
      Currency: 'INR',
    },
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sampleRows, { header: headers });
  XLSX.utils.book_append_sheet(wb, ws, 'TendersAndVendors');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  res.setHeader('Content-Disposition', 'attachment; filename="tenders_vendors_bulk_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

adminRouter.post('/tenders/bulk/upload', handleBulkSheetUpload, (req, res) => {
  const file = req.file;
  if (!file || !file.buffer) {
    respondBulk(req, res, { ok: false, message: 'Please choose an Excel (.xlsx / .xls) or CSV file.', category: 'danger', redirectUrl: '/admin/tenders/bulk' });
    return;
  }

  const fallbackItemRaw = parseInt(String(req.body.default_itemid || ''), 10);
  const fallbackItemId = Number.isFinite(fallbackItemRaw) ? fallbackItemRaw : null;
  const userId = res.locals.current_user.id;

  try {
    const wb = XLSX.read(file.buffer, { type: 'buffer', cellDates: false });
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) {
      respondBulk(req, res, { ok: false, message: 'Uploaded file contains no sheets.', category: 'danger', redirectUrl: '/admin/tenders/bulk' });
      return;
    }
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[firstSheetName], { defval: '' });
    if (!rawRows.length) {
      respondBulk(req, res, { ok: false, message: 'Uploaded sheet has no data rows.', category: 'warning', redirectUrl: '/admin/tenders/bulk' });
      return;
    }

    const pickCol = (row: Record<string, unknown>, aliases: string[]): unknown => {
      for (const key of Object.keys(row)) {
        const norm = key.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (aliases.includes(norm)) return row[key];
      }
      return '';
    };

    const normalizedRows: BulkTenderVendorInput[] = rawRows.map((r) => ({
      item: pickCol(r, ['item', 'itemname', 'itemcode', 'itemid']),
      tender_no: pickCol(r, ['tenderno', 'tendernumber', 'tender', 'tendercode']),
      basicrate: pickCol(r, ['basicrate', 'rate', 'unitrate', 'basicrateperunit', 'tenderbasicrate']),
      pvcbasedate: pickCol(r, ['pvcbasedate', 'basedate', 'tenderbasedate', 'date']),
      freightrateperunit: pickCol(r, ['freight', 'tenderfreight', 'freightperunit', 'freightrate', 'freightrateperunit']),
      gst_rate: pickCol(r, ['gst', 'gstpct', 'gstrate', 'gstpercent', 'tax', 'taxrate']),
      vendor_name: pickCol(r, ['vendorname', 'vendor', 'firm', 'firmname', 'supplier', 'suppliername']),
      po_no: pickCol(r, ['pono', 'ponumber', 'po', 'contractno', 'orderno']),
      cif: pickCol(r, ['cif', 'cifvalue', 'cifamount']),
      vendor_freight: pickCol(r, ['vendorfreight', 'vendorfreightperunit', 'vfreight']),
      currency: pickCol(r, ['currency', 'curr', 'cifcurrency']),
    }));

    const stats = processBulkTenderVendorRows(normalizedRows, fallbackItemId, userId);
    if (
      stats.tendersCreated === 0 &&
      stats.tendersUpdated === 0 &&
      stats.vendorsCreated === 0 &&
      stats.vendorsUpdated === 0
    ) {
      respondBulk(req, res, { ok: false, message: 'No valid tender or vendor rows found in the uploaded file.', category: 'warning', redirectUrl: '/admin/tenders/bulk' });
      return;
    }

    const parts: string[] = [];
    if (stats.tendersCreated > 0) parts.push(`${stats.tendersCreated} tender(s) created`);
    if (stats.tendersUpdated > 0) parts.push(`${stats.tendersUpdated} tender(s) updated`);
    if (stats.vendorsCreated > 0) parts.push(`${stats.vendorsCreated} vendor(s) created`);
    if (stats.vendorsUpdated > 0) parts.push(`${stats.vendorsUpdated} vendor(s) updated`);
    if (stats.skipped > 0) parts.push(`${stats.skipped} row(s) skipped`);

    respondBulk(req, res, {
      ok: true,
      message: `Imported ${file.originalname}: ${parts.join(', ')}.`,
      category: 'success',
      redirectUrl: '/admin/tenders',
    });
  } catch (err) {
    respondBulk(req, res, {
      ok: false,
      message: `Failed to parse file: ${err instanceof Error ? err.message : 'Unknown error'}`,
      category: 'danger',
      redirectUrl: '/admin/tenders/bulk',
    });
  }
});

adminRouter.post('/tenders/bulk/save', (req, res) => {
  const fallbackItemRaw = parseInt(String(req.body.default_itemid || ''), 10);
  const fallbackItemId = Number.isFinite(fallbackItemRaw) ? fallbackItemRaw : null;
  const userId = res.locals.current_user.id;

  let rows: BulkTenderVendorInput[] = [];
  try {
    const parsed = JSON.parse(String(req.body.rows_json || '[]'));
    if (!Array.isArray(parsed)) throw new Error('Invalid payload');
    rows = parsed;
  } catch {
    respondBulk(req, res, { ok: false, message: 'Invalid bulk tender & vendor payload.', category: 'danger', redirectUrl: '/admin/tenders/bulk' });
    return;
  }

  const stats = processBulkTenderVendorRows(rows, fallbackItemId, userId);
  if (
    stats.tendersCreated === 0 &&
    stats.tendersUpdated === 0 &&
    stats.vendorsCreated === 0 &&
    stats.vendorsUpdated === 0
  ) {
    respondBulk(req, res, { ok: false, message: 'No valid tender or vendor rows found to save.', category: 'warning', redirectUrl: '/admin/tenders/bulk' });
    return;
  }

  const parts: string[] = [];
  if (stats.tendersCreated > 0) parts.push(`${stats.tendersCreated} tender(s) created`);
  if (stats.tendersUpdated > 0) parts.push(`${stats.tendersUpdated} tender(s) updated`);
  if (stats.vendorsCreated > 0) parts.push(`${stats.vendorsCreated} vendor(s) created`);
  if (stats.vendorsUpdated > 0) parts.push(`${stats.vendorsUpdated} vendor(s) updated`);
  if (stats.skipped > 0) parts.push(`${stats.skipped} row(s) skipped`);

  respondBulk(req, res, {
    ok: true,
    message: `Bulk save completed: ${parts.join(', ')}.`,
    category: 'success',
    redirectUrl: '/admin/tenders',
  });
});

adminRouter.get('/tenders/new', (_req, res) => {
  res.locals.request.endpoint = 'admin.tenders_new';
  const items = store.getItems();
  res.render('admin_tenders_form.html', { tender: null, items });
});

adminRouter.post('/tenders/new', (req, res) => {
  const itemid = parseInt(String(req.body.itemid || ''), 10);
  const tenderno = String(req.body.tenderno || '').trim();
  if (isNaN(itemid) || !tenderno) {
    flashMessage(req, 'Item and Tender No are required.', 'danger');
    res.redirect('/admin/tenders/new');
    return;
  }
  if (store.getTenderByNo(tenderno)) {
    flashMessage(req, 'Tender No already exists.', 'danger');
    res.redirect('/admin/tenders/new');
    return;
  }
  const rawGst = String(req.body.gst_rate ?? '').trim();
  store.createTender(
    {
      item_id: itemid,
      tender_no: tenderno,
      basicrate: safeFloat(req.body.basicrate),
      pvcbasedate: String(req.body.pvcbasedate || '').trim() || null,
      freightrateperunit: safeFloat(req.body.freightrateperunit),
      gst_rate: rawGst !== '' ? safeFloat(rawGst) : 18,
    },
    res.locals.current_user.id
  );
  flashMessage(req, 'Tender added successfully.', 'success');
  res.redirect('/admin/tenders');
});

adminRouter.get('/tenders/:tenderid/edit', (req, res) => {
  res.locals.request.endpoint = 'admin.tenders_edit';
  const tender = store.getTenderById(parseInt(req.params.tenderid, 10));
  if (!tender) {
    res.status(404).send('Tender not found');
    return;
  }
  const items = store.getItems();
  res.render('admin_tenders_form.html', { tender, items });
});

adminRouter.post('/tenders/:tenderid/edit', (req, res) => {
  const tenderId = parseInt(req.params.tenderid, 10);
  const tender = store.getTenderById(tenderId);
  if (!tender) {
    res.status(404).send('Tender not found');
    return;
  }
  const itemid = parseInt(String(req.body.itemid || ''), 10);
  const tenderno = String(req.body.tenderno || '').trim();
  if (isNaN(itemid) || !tenderno) {
    flashMessage(req, 'Item and Tender No are required.', 'danger');
    res.redirect(`/admin/tenders/${tender.id}/edit`);
    return;
  }
  const dupTender = store.getTenderByNo(tenderno);
  if (dupTender && dupTender.id !== tender.id) {
    flashMessage(req, 'Another tender with that Tender No already exists.', 'danger');
    res.redirect(`/admin/tenders/${tender.id}/edit`);
    return;
  }
  const rawGst = String(req.body.gst_rate ?? '').trim();
  store.updateTender(
    tender.id,
    {
      item_id: itemid,
      tender_no: tenderno,
      basicrate: safeFloat(req.body.basicrate),
      pvcbasedate: String(req.body.pvcbasedate || '').trim() || null,
      freightrateperunit: safeFloat(req.body.freightrateperunit),
      gst_rate: rawGst !== '' ? safeFloat(rawGst) : 18,
    },
    res.locals.current_user.id
  );
  flashMessage(req, 'Tender updated successfully.', 'success');
  res.redirect('/admin/tenders');
});

adminRouter.post('/tenders/:tenderid/delete', (req, res) => {
  const tenderId = parseInt(req.params.tenderid, 10);
  store.deleteTender(tenderId, res.locals.current_user.id);
  flashMessage(req, 'Tender and its vendors deleted.', 'success');
  res.redirect('/admin/tenders');
});

// ── Tender Vendors ────────────────────────────────────────────────────────

adminRouter.get('/tenders/:tenderid/vendors', (req, res) => {
  res.locals.request.endpoint = 'admin.tender_vendors_list';
  const tender = store.getTenderById(parseInt(req.params.tenderid, 10));
  if (!tender) {
    res.status(404).send('Tender not found');
    return;
  }
  const rows = store.getTenderVendors(tender.id);
  res.render('admin_tender_vendors_list.html', { tender, rows });
});

adminRouter.get('/tenders/:tenderid/vendors/new', (req, res) => {
  res.locals.request.endpoint = 'admin.tender_vendors_new';
  const tender = store.getTenderById(parseInt(req.params.tenderid, 10));
  if (!tender) {
    res.status(404).send('Tender not found');
    return;
  }
  res.render('admin_tender_vendor_form.html', { tender, row: null });
});

adminRouter.post('/tenders/:tenderid/vendors/new', (req, res) => {
  const tender = store.getTenderById(parseInt(req.params.tenderid, 10));
  if (!tender) {
    res.status(404).send('Tender not found');
    return;
  }
  const vendorName = String(req.body.vendorname || '').trim();
  const poNo = String(req.body.pono || '').trim();
  const cif = safeFloat(req.body.cif);
  const freightrateperunit = safeFloat(req.body.freightrateperunit);
  const currency = String(req.body.currency || '').trim();

  if (!vendorName || !currency) {
    flashMessage(req, 'Vendor name and currency are required.', 'danger');
    res.redirect(`/admin/tenders/${tender.id}/vendors/new`);
    return;
  }
  store.createTenderVendor(
    {
      tender_id: tender.id,
      vendor_name: vendorName,
      po_no: poNo || null,
      cif,
      freightrateperunit,
      currency,
    },
    res.locals.current_user.id
  );
  flashMessage(req, 'Vendor added.', 'success');
  res.redirect(`/admin/tenders/${tender.id}/vendors`);
});

adminRouter.get('/tenders/:tenderid/vendors/:rowid/edit', (req, res) => {
  res.locals.request.endpoint = 'admin.tender_vendors_edit';
  const tender = store.getTenderById(parseInt(req.params.tenderid, 10));
  if (!tender) {
    res.status(404).send('Tender not found');
    return;
  }
  const row = store.getTenderVendorById(tender.id, parseInt(req.params.rowid, 10));
  if (!row) {
    res.status(404).send('Vendor not found');
    return;
  }
  res.render('admin_tender_vendor_form.html', { tender, row });
});

adminRouter.post('/tenders/:tenderid/vendors/:rowid/edit', (req, res) => {
  const tender = store.getTenderById(parseInt(req.params.tenderid, 10));
  if (!tender) {
    res.status(404).send('Tender not found');
    return;
  }
  const rowId = parseInt(req.params.rowid, 10);
  const row = store.getTenderVendorById(tender.id, rowId);
  if (!row) {
    res.status(404).send('Vendor not found');
    return;
  }
  const vendorName = String(req.body.vendorname || '').trim();
  const poNo = String(req.body.pono || '').trim();
  const cif = safeFloat(req.body.cif);
  const freightrateperunit = safeFloat(req.body.freightrateperunit);
  const currency = String(req.body.currency || '').trim();

  if (!vendorName || !currency) {
    flashMessage(req, 'Vendor name and currency are required.', 'danger');
    res.redirect(`/admin/tenders/${tender.id}/vendors/${row.id}/edit`);
    return;
  }
  store.updateTenderVendor(
    tender.id,
    row.id,
    {
      vendor_name: vendorName,
      po_no: poNo || null,
      cif,
      freightrateperunit,
      currency,
    },
    res.locals.current_user.id
  );
  flashMessage(req, 'Vendor updated.', 'success');
  res.redirect(`/admin/tenders/${tender.id}/vendors`);
});

adminRouter.post('/tenders/:tenderid/vendors/:rowid/delete', (req, res) => {
  const tenderId = parseInt(req.params.tenderid, 10);
  const rowId = parseInt(req.params.rowid, 10);
  store.deleteTenderVendor(tenderId, rowId, res.locals.current_user.id);
  flashMessage(req, 'Vendor deleted.', 'success');
  res.redirect(`/admin/tenders/${tenderId}/vendors`);
});

// ── Users Management ──────────────────────────────────────────────────────

adminRouter.get('/users', requireAdmin, (_req, res) => {
  res.locals.request.endpoint = 'admin.users_list';
  const users = store.getUsers();
  res.render('admin_users_list.html', { users });
});

adminRouter.get('/users/new', requireAdmin, (_req, res) => {
  res.locals.request.endpoint = 'admin.users_new';
  res.render('admin_users_form.html', { user: null });
});

adminRouter.post('/users/new', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim();
  const fullName = String(req.body.fullname || '').trim();
  const contactNo = String(req.body.contactno || '').trim();
  const designation = String(req.body.designation || '').trim();
  const controlNo = String(req.body.controlno || '').trim();
  const isAdmin = Boolean(req.body.is_admin);

  if (!username || !password) {
    flashMessage(req, 'Username and password are required.', 'danger');
    res.redirect('/admin/users/new');
    return;
  }
  if (store.getUserByUsername(username)) {
    flashMessage(req, 'Username already exists.', 'danger');
    res.redirect('/admin/users/new');
    return;
  }

  store.createUser(
    {
      username,
      email: email || null,
      full_name: fullName || null,
      contact_no: contactNo || null,
      designation: designation || null,
      control_no: controlNo || null,
      password_hash: bcrypt.hashSync(password, 10),
      is_admin: isAdmin,
    },
    res.locals.current_user.id
  );
  flashMessage(req, 'User created successfully.', 'success');
  res.redirect('/admin/users');
});

adminRouter.get('/users/:userid/edit', requireAdmin, (req, res) => {
  res.locals.request.endpoint = 'admin.users_edit';
  const user = store.getUserById(parseInt(req.params.userid, 10));
  if (!user) {
    res.status(404).send('User not found');
    return;
  }
  res.render('admin_users_form.html', { user });
});

adminRouter.post('/users/:userid/edit', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userid, 10);
  const user = store.getUserById(userId);
  if (!user) {
    res.status(404).send('User not found');
    return;
  }
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim();
  const fullName = String(req.body.fullname || '').trim();
  const contactNo = String(req.body.contactno || '').trim();
  const designation = String(req.body.designation || '').trim();
  const controlNo = String(req.body.controlno || '').trim();
  const isAdmin = user.id === res.locals.current_user.id ? true : Boolean(req.body.is_admin);

  if (!username) {
    flashMessage(req, 'Username is required.', 'danger');
    res.redirect(`/admin/users/${user.id}/edit`);
    return;
  }
  const existing = store.getUserByUsername(username);
  if (existing && existing.id !== user.id) {
    flashMessage(req, 'Username already taken by another user.', 'danger');
    res.redirect(`/admin/users/${user.id}/edit`);
    return;
  }

  const patch: Partial<typeof user> = {
    username,
    email: email || null,
    full_name: fullName || null,
    contact_no: contactNo || null,
    designation: designation || null,
    control_no: controlNo || null,
    is_admin: isAdmin,
  };
  if (password) {
    patch.password_hash = bcrypt.hashSync(password, 10);
  }
  store.updateUser(user.id, patch, res.locals.current_user.id);
  flashMessage(req, 'User updated successfully.', 'success');
  res.redirect('/admin/users');
});

adminRouter.get('/users/:userid/reset_password', requireAdmin, (req, res) => {
  res.locals.request.endpoint = 'admin.users_reset_password';
  const user = store.getUserById(parseInt(req.params.userid, 10));
  if (!user) {
    res.status(404).send('User not found');
    return;
  }
  res.render('admin_users_reset_password.html', { user });
});

adminRouter.post('/users/:userid/reset_password', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userid, 10);
  const user = store.getUserById(userId);
  if (!user) {
    res.status(404).send('User not found');
    return;
  }
  const password = String(req.body.password || '');
  if (!password) {
    flashMessage(req, 'New password is required.', 'danger');
    res.redirect(`/admin/users/${user.id}/reset_password`);
    return;
  }
  store.updateUser(user.id, { password_hash: bcrypt.hashSync(password, 10) }, res.locals.current_user.id);
  flashMessage(req, `Password reset successfully for ${user.username}.`, 'success');
  res.redirect('/admin/users');
});

adminRouter.post('/users/:userid/delete', requireAdmin, (req, res) => {
  const userId = parseInt(req.params.userid, 10);
  if (userId === res.locals.current_user.id) {
    flashMessage(req, 'You cannot delete your own active session account.', 'danger');
    res.redirect('/admin/users');
    return;
  }
  store.deleteUser(userId, res.locals.current_user.id);
  flashMessage(req, 'User and their calculation history deleted successfully.', 'success');
  res.redirect('/admin/users');
});

// ── Audit Logs ────────────────────────────────────────────────────────────

adminRouter.get('/audit_logs', requireAdmin, (_req, res) => {
  res.locals.request.endpoint = 'admin.audit_logs_list';
  const logs = store.getAuditLogs(200);
  res.render('admin_audit_logs.html', { logs });
});

// ── Database Backup Export ────────────────────────────────────────────────

adminRouter.get('/backup_now', requireAdmin, (_req, res) => {
  const snapshot = store.exportBackup();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="pvc_backup_${ts}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(snapshot, null, 2));
});
