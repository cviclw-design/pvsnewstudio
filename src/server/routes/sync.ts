import express, { Request, Response } from 'express';
import { store } from '../store.js';

export const syncRouter = express.Router();

function requireApiAuth(_req: Request, res: Response, next: express.NextFunction): void {
  if (!res.locals.current_user?.is_authenticated) {
    res.status(401).json({ ok: false, error: 'Authentication required' });
    return;
  }
  next();
}

syncRouter.use(requireApiAuth);

syncRouter.get('/snapshot', (_req, res) => {
  res.json({
    ok: true,
    ...store.getSyncSnapshot(),
  });
});

syncRouter.post('/hydrate', (req, res) => {
  const body = req.body || {};
  const ownerUid = String(body.ownerUid || '').trim();
  if (!ownerUid || !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerUid)) {
    res.status(400).json({ ok: false, error: 'Invalid ownerUid' });
    return;
  }

  const revision = Number(body.revision || 0);
  const currentUserId = Number(res.locals.current_user?.id || 1);

  const result = store.hydrateFromCloud({
    ownerUid,
    revision: Number.isFinite(revision) ? revision : 0,
    items: Array.isArray(body.items) ? body.items : [],
    itemIndices: Array.isArray(body.itemIndices) ? body.itemIndices : [],
    tenders: Array.isArray(body.tenders) ? body.tenders : [],
    tenderVendors: Array.isArray(body.tenderVendors) ? body.tenderVendors : [],
    pvcResults: Array.isArray(body.pvcResults) ? body.pvcResults : [],
    defaultUserId: currentUserId,
  });

  res.json({
    ok: true,
    ...result,
  });
});

syncRouter.post('/mark-synced', (req, res) => {
  const body = req.body || {};
  const ownerUid = String(body.ownerUid || '').trim();
  const revision = Number(body.revision || 0);
  if (!ownerUid) {
    res.status(400).json({ ok: false, error: 'Missing ownerUid' });
    return;
  }
  store.markCloudSynced(revision, ownerUid);
  res.json({ ok: true });
});
