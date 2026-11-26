import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import { evaluateMathExpression, parseItemComponents, safeFloat } from '../pvcEngine.js';
import { paginate, store } from '../store.js';
import { ComponentConfig, IndexAttachment } from '../types.js';
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

// ── Tenders ───────────────────────────────────────────────────────────────

adminRouter.get('/tenders', (_req, res) => {
  res.locals.request.endpoint = 'admin.tenders_list';
  const tenders = store.getTenders();
  res.render('admin_tenders_list.html', { tenders });
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
  store.createTender(
    {
      item_id: itemid,
      tender_no: tenderno,
      basicrate: safeFloat(req.body.basicrate),
      pvcbasedate: String(req.body.pvcbasedate || '').trim() || null,
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
  store.updateTender(
    tender.id,
    {
      item_id: itemid,
      tender_no: tenderno,
      basicrate: safeFloat(req.body.basicrate),
      pvcbasedate: String(req.body.pvcbasedate || '').trim() || null,
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
