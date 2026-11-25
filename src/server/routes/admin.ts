import express from 'express';
import bcrypt from 'bcryptjs';
import { safeFloat } from '../pvcEngine.js';
import { paginate, store } from '../store.js';
import { flashMessage, requireAdmin, requireLogin } from './auth.js';

export const adminRouter = express.Router();

adminRouter.use(requireLogin, requireAdmin);

function normalizeMonthStart(dateStr: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

// ── Items ─────────────────────────────────────────────────────────────────

adminRouter.get('/items', (_req, res) => {
  res.locals.request.endpoint = 'admin.items_list';
  const items = store.getItems();
  res.render('admin_items_list.html', { items });
});

adminRouter.get('/items/new', (_req, res) => {
  res.locals.request.endpoint = 'admin.items_new';
  res.render('admin_items_form.html', { item: null });
});

adminRouter.post('/items/new', (req, res) => {
  const name = String(req.body.name || '').trim();
  const code = String(req.body.code || '').trim();
  const formula = String(req.body.pvcformulacode || '').trim();
  const weightsjson = String(req.body.weightsjson || '').trim() || '{}';
  const extrafieldsjson = String(req.body.extrafieldsjson || '').trim() || '[]';
  const description = String(req.body.description || '').trim();

  if (!name || !formula) {
    flashMessage(req, 'Name and formula code are required.', 'danger');
    res.redirect('/admin/items/new');
    return;
  }
  if (store.getItemByName(name)) {
    flashMessage(req, 'An item with that name already exists.', 'danger');
    res.redirect('/admin/items/new');
    return;
  }
  try {
    JSON.parse(weightsjson);
    JSON.parse(extrafieldsjson);
  } catch {
    flashMessage(req, 'Weights / extra fields must be valid JSON.', 'danger');
    res.redirect('/admin/items/new');
    return;
  }

  store.createItem(
    {
      name,
      code: code || null,
      pvc_formula_code: formula,
      weights_json: weightsjson,
      extra_fields_json: extrafieldsjson,
      description: description || null,
    },
    res.locals.current_user.id
  );
  flashMessage(req, 'Item added successfully.', 'success');
  res.redirect('/admin/items');
});

adminRouter.get('/items/:itemid/edit', (req, res) => {
  res.locals.request.endpoint = 'admin.items_edit';
  const item = store.getItemById(parseInt(req.params.itemid, 10));
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }
  res.render('admin_items_form.html', { item });
});

adminRouter.post('/items/:itemid/edit', (req, res) => {
  const itemId = parseInt(req.params.itemid, 10);
  const item = store.getItemById(itemId);
  if (!item) {
    res.status(404).send('Item not found');
    return;
  }

  const name = String(req.body.name || '').trim();
  const code = String(req.body.code || '').trim();
  const formula = String(req.body.pvcformulacode || '').trim();
  const weightsjson = String(req.body.weightsjson || '').trim() || '{}';
  const extrafieldsjson = String(req.body.extrafieldsjson || '').trim() || '[]';
  const description = String(req.body.description || '').trim();

  if (!name || !formula) {
    flashMessage(req, 'Name and formula code are required.', 'danger');
    res.redirect(`/admin/items/${item.id}/edit`);
    return;
  }
  try {
    JSON.parse(weightsjson);
    JSON.parse(extrafieldsjson);
  } catch {
    flashMessage(req, 'Weights / extra fields must be valid JSON.', 'danger');
    res.redirect(`/admin/items/${item.id}/edit`);
    return;
  }

  store.updateItem(
    item.id,
    {
      name,
      code: code || null,
      pvc_formula_code: formula,
      weights_json: weightsjson,
      extra_fields_json: extrafieldsjson,
      description: description || null,
    },
    res.locals.current_user.id
  );
  flashMessage(req, 'Item updated successfully.', 'success');
  res.redirect('/admin/items');
});

adminRouter.post('/items/:itemid/delete', (req, res) => {
  const itemId = parseInt(req.params.itemid, 10);
  const result = store.deleteItem(itemId, res.locals.current_user.id);
  if (result.ok) {
    flashMessage(req, 'Item and associated indices deleted.', 'success');
  } else {
    flashMessage(req, result.error || 'Cannot delete item.', 'danger');
  }
  res.redirect('/admin/items');
});

// ── Item Indices ──────────────────────────────────────────────────────────

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
  const latest = store.getItemIndices(item.id, 'desc')[0];
  res.render('admin_item_indices_form.html', {
    item,
    row: null,
    default_indices_json: latest ? latest.indices_json : '{}',
  });
});

adminRouter.post('/items/:itemid/indices/new', (req, res) => {
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

  store.createItemIndex({ item_id: item.id, month, indices_json: indicesjson }, res.locals.current_user.id);
  flashMessage(req, `Indices for ${month.slice(0, 7)} added.`, 'success');
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
  res.render('admin_item_indices_form.html', { item, row });
});

adminRouter.post('/items/:itemid/indices/:rowid/edit', (req, res) => {
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

  store.updateItemIndex(item.id, row.id, { month, indices_json: indicesjson }, res.locals.current_user.id);
  flashMessage(req, 'Indices updated.', 'success');
  res.redirect(`/admin/items/${item.id}/indices`);
});

adminRouter.post('/items/:itemid/indices/:rowid/delete', (req, res) => {
  const itemId = parseInt(req.params.itemid, 10);
  const rowId = parseInt(req.params.rowid, 10);
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

adminRouter.get('/users', (_req, res) => {
  res.locals.request.endpoint = 'admin.users_list';
  const users = store.getUsers();
  res.render('admin_users_list.html', { users });
});

adminRouter.get('/users/new', (_req, res) => {
  res.locals.request.endpoint = 'admin.users_new';
  res.render('admin_users_form.html', { user: null });
});

adminRouter.post('/users/new', (req, res) => {
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

adminRouter.get('/users/:userid/edit', (req, res) => {
  res.locals.request.endpoint = 'admin.users_edit';
  const user = store.getUserById(parseInt(req.params.userid, 10));
  if (!user) {
    res.status(404).send('User not found');
    return;
  }
  res.render('admin_users_form.html', { user });
});

adminRouter.post('/users/:userid/edit', (req, res) => {
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

adminRouter.get('/users/:userid/reset_password', (req, res) => {
  res.locals.request.endpoint = 'admin.users_reset_password';
  const user = store.getUserById(parseInt(req.params.userid, 10));
  if (!user) {
    res.status(404).send('User not found');
    return;
  }
  res.render('admin_users_reset_password.html', { user });
});

adminRouter.post('/users/:userid/reset_password', (req, res) => {
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

adminRouter.post('/users/:userid/delete', (req, res) => {
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

adminRouter.get('/audit_logs', (_req, res) => {
  res.locals.request.endpoint = 'admin.audit_logs_list';
  const logs = store.getAuditLogs(200);
  res.render('admin_audit_logs.html', { logs });
});

// ── Database Backup Export (In-memory JSON snapshot) ──────────────────────

adminRouter.get('/backup_now', (_req, res) => {
  const snapshot = store.exportBackup();
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Disposition', `attachment; filename="pvc_backup_${ts}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(snapshot, null, 2));
});
