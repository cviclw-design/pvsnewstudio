import crypto from 'crypto';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import {
  AuditLogRecord,
  IndexAttachment,
  ItemIndexRecord,
  ItemRecord,
  Pagination,
  PVCResultRecord,
  TenderMasterRecord,
  TenderVendorRecord,
  UserRecord,
} from './types.js';

const SNAPSHOT_PATH = '/tmp/pvc_app_store.json';

interface StoreState {
  nextIds: {
    users: number;
    items: number;
    itemIndices: number;
    tenders: number;
    tenderVendors: number;
    pvcResults: number;
    auditLogs: number;
  };
  users: UserRecord[];
  items: ItemRecord[];
  itemIndices: ItemIndexRecord[];
  tenders: TenderMasterRecord[];
  tenderVendors: TenderVendorRecord[];
  pvcResults: PVCResultRecord[];
  auditLogs: AuditLogRecord[];
}

function generateMonthlyIndices(): ItemIndexRecord[] {
  const rows: ItemIndexRecord[] = [];
  let id = 1;

  for (let year = 2022; year <= 2026; year++) {
    for (let month = 1; month <= 12; month++) {
      const idxOffset = (year - 2022) * 12 + (month - 1);
      const monthStr = `${year}-${String(month).padStart(2, '0')}-01`;
      const wave = Math.sin(idxOffset * 0.35);

      const C = Number((740 + idxOffset * 3.8 + wave * 14).toFixed(2));
      const AL = Number((235 + idxOffset * 1.4 + wave * 6).toFixed(2));
      const FE = Number((145 + idxOffset * 0.9 + Math.cos(idxOffset * 0.3) * 4).toFixed(2));
      const IM = Number((132 + idxOffset * 0.65 + wave * 2.5).toFixed(2));
      const W = Number((128 + idxOffset * 0.85).toFixed(2));
      const D = year >= 2024 ? 7.5 : 10.0;
      const ER_EUR = Number((84.5 + idxOffset * 0.16 + wave * 1.1).toFixed(2));
      const ER_USD = Number((77.2 + idxOffset * 0.15 + Math.cos(idxOffset * 0.25) * 0.7).toFixed(2));
      const ER_JPY = Number((0.62 - idxOffset * 0.001 + wave * 0.01).toFixed(4));

      rows.push({
        id: id++,
        item_id: 1,
        month: monthStr,
        indices_json: JSON.stringify({ C, AL, FE, IM, W, D, ER_EUR, ER_USD, ER_JPY }),
        attachments: [],
      });

      rows.push({
        id: id++,
        item_id: 2,
        month: monthStr,
        indices_json: JSON.stringify({ C, AL, FE, IM, W }),
        attachments: [],
      });

      rows.push({
        id: id++,
        item_id: 3,
        month: monthStr,
        indices_json: JSON.stringify({ C, AL, FE, IM, W }),
        attachments: [],
      });
    }
  }
  return rows;
}

function createInitialState(): StoreState {
  const adminHash = bcrypt.hashSync('admin123', 10);
  const userHash = bcrypt.hashSync('user123', 10);

  const users: UserRecord[] = [
    {
      id: 1,
      username: 'admin',
      full_name: 'C. P. Chauhan',
      email: 'admin@pvcstudio.local',
      contact_no: null,
      designation: 'Principal Consultant',
      control_no: 'PVC-001',
      password_hash: adminHash,
      is_admin: true,
    },
    {
      id: 2,
      username: 'operator',
      full_name: 'Costing Analyst',
      email: 'operator@pvcstudio.local',
      contact_no: null,
      designation: 'Accounts & Costing Analyst',
      control_no: 'PVC-002',
      password_hash: userHash,
      is_admin: false,
    },
  ];

  const items: ItemRecord[] = [
    {
      id: 1,
      name: 'IGBT Propulsion System',
      code: '29180010',
      description: '3-Phase IGBT Power Converter & Propulsion Equipment',
      pvc_formula_code: 'IGBTPROPULSIONSYSTEM',
      weights_json: JSON.stringify({ FIXED: 16, C: 26, AL: 13, FE: 18, IM: 9, W: 18 }),
      extra_fields_json: '[]',
      lag_months: 1,
      base_lag_months: 0,
      fixed_weight: 16,
      index_source: 'IEEMA & Reserve Bank of India (RBI)',
      components_json: JSON.stringify([
        { key: 'C', label: 'Copper', weight: 26, lag_months: 1, source: 'IEEMA' },
        { key: 'AL', label: 'Aluminium', weight: 13, lag_months: 1, source: 'IEEMA' },
        { key: 'FE', label: 'Iron & Steel', weight: 18, lag_months: 1, source: 'Office of the Economic Adviser, Govt. of India (WPI)' },
        { key: 'IM', label: 'Insulating Material', weight: 9, lag_months: 1, source: 'IEEMA' },
        { key: 'W', label: 'Labour / Wage', weight: 18, lag_months: 1, source: 'Labour Bureau, Govt. of India (CPI-IW)' },
      ]),
      custom_formula: null,
    },
    {
      id: 2,
      name: '3-Phase AC Traction Motor',
      code: '29150045',
      description: '3-Phase AC Industrial Traction Motor',
      pvc_formula_code: 'TRACTIONMOTOR',
      weights_json: JSON.stringify({ FIXED: 15, C: 25, AL: 10, FE: 20, IM: 15, W: 15 }),
      extra_fields_json: '[]',
      lag_months: 2,
      base_lag_months: 0,
      fixed_weight: 15,
      index_source: 'IEEMA',
      components_json: JSON.stringify([
        { key: 'C', label: 'Copper', weight: 25, lag_months: 2, source: 'IEEMA' },
        { key: 'AL', label: 'Aluminium', weight: 10, lag_months: 2, source: 'IEEMA' },
        { key: 'FE', label: 'Steel / Iron', weight: 20, lag_months: 2, source: 'Office of the Economic Adviser, Govt. of India (WPI)' },
        { key: 'IM', label: 'Insulating Material', weight: 15, lag_months: 2, source: 'IEEMA' },
        { key: 'W', label: 'Labour / Wage', weight: 15, lag_months: 2, source: 'IEEMA' },
      ]),
      custom_formula: null,
    },
    {
      id: 3,
      name: 'Main Power Transformer',
      code: '29160022',
      description: '6531 kVA High-Voltage Power Transformer',
      pvc_formula_code: 'POWERTRFIEEMA',
      weights_json: JSON.stringify({ FIXED: 15, C: 30, AL: 10, FE: 25, IM: 10, W: 10 }),
      extra_fields_json: '[]',
      lag_months: 1,
      base_lag_months: 0,
      fixed_weight: 15,
      index_source: 'IEEMA',
      components_json: JSON.stringify([
        { key: 'C', label: 'Copper', weight: 30, lag_months: 1, source: 'IEEMA' },
        { key: 'AL', label: 'Aluminium', weight: 10, lag_months: 1, source: 'IEEMA' },
        { key: 'FE', label: 'CRGO / Steel', weight: 25, lag_months: 1, source: 'IEEMA' },
        { key: 'IM', label: 'Insulating Material', weight: 10, lag_months: 1, source: 'IEEMA' },
        { key: 'W', label: 'Labour / Wage', weight: 10, lag_months: 1, source: 'IEEMA' },
      ]),
      custom_formula: null,
    },
  ];

  const itemIndices = generateMonthlyIndices();

  const tenders: TenderMasterRecord[] = [
    {
      id: 1,
      item_id: 1,
      tender_no: 'TND/EL/IGBT/2023/001',
      basicrate: 28500000,
      pvcbasedate: '2023-03-01',
      freightrateperunit: 85000,
      gst_rate: 18,
      created_at: '2023-03-15T10:00:00.000Z',
    },
    {
      id: 2,
      item_id: 1,
      tender_no: 'TND/EL/IGBT/2024/002',
      basicrate: 27400000,
      pvcbasedate: '2024-04-01',
      freightrateperunit: 80000,
      gst_rate: 18,
      created_at: '2024-04-10T10:00:00.000Z',
    },
    {
      id: 3,
      item_id: 2,
      tender_no: 'TND/EL/TM/2023/105',
      basicrate: 3250000,
      pvcbasedate: '2023-06-01',
      freightrateperunit: 22000,
      gst_rate: 18,
      created_at: '2023-06-12T10:00:00.000Z',
    },
    {
      id: 4,
      item_id: 3,
      tender_no: 'TND/EL/TRF/2024/088',
      basicrate: 7850000,
      pvcbasedate: '2024-01-01',
      freightrateperunit: 45000,
      gst_rate: 18,
      created_at: '2024-01-20T10:00:00.000Z',
    },
  ];

  const tenderVendors: TenderVendorRecord[] = [
    {
      id: 1,
      tender_id: 1,
      po_no: 'PO23500101',
      vendor_name: 'M/s BHEL',
      cif: 6200000,
      freightrateperunit: 85000,
      currency: 'EUR',
    },
    {
      id: 2,
      tender_id: 1,
      po_no: 'PO23500102',
      vendor_name: 'M/s Medha Servo Drives',
      cif: 5850000,
      freightrateperunit: 78000,
      currency: 'EUR',
    },
    {
      id: 3,
      tender_id: 1,
      po_no: 'PO23500103',
      vendor_name: 'M/s ABB India Ltd',
      cif: 6400000,
      freightrateperunit: 82000,
      currency: 'USD',
    },
    {
      id: 4,
      tender_id: 2,
      po_no: 'PO24500201',
      vendor_name: 'M/s BHEL',
      cif: 5900000,
      freightrateperunit: 80000,
      currency: 'EUR',
    },
    {
      id: 5,
      tender_id: 2,
      po_no: 'PO24500202',
      vendor_name: 'M/s Medha Servo Drives',
      cif: 5600000,
      freightrateperunit: 75000,
      currency: 'EUR',
    },
    {
      id: 6,
      tender_id: 3,
      po_no: 'PO23600301',
      vendor_name: 'M/s CG Power',
      cif: 0,
      freightrateperunit: 22000,
      currency: 'INR',
    },
    {
      id: 7,
      tender_id: 4,
      po_no: 'PO24700401',
      vendor_name: 'M/s Hind Rectifiers',
      cif: 0,
      freightrateperunit: 45000,
      currency: 'INR',
    },
  ];

  return {
    nextIds: {
      users: users.length + 1,
      items: items.length + 1,
      itemIndices: itemIndices.length + 1,
      tenders: tenders.length + 1,
      tenderVendors: tenderVendors.length + 1,
      pvcResults: 1,
      auditLogs: 1,
    },
    users,
    items,
    itemIndices,
    tenders,
    tenderVendors,
    pvcResults: [],
    auditLogs: [],
  };
}

class MemoryStore {
  private readonly bootId = crypto.randomBytes(8).toString('hex');
  private state: StoreState;
  private mutationRevision = 0;
  private hydratedFromCloud = false;
  private cloudOwnerUid: string | null = null;
  private dirtyItemIds = new Set<number>();
  private dirtyIndexKeys = new Set<string>();
  private dirtyTenderNos = new Set<string>();
  private dirtyVendorKeys = new Set<string>();
  private dirtyResultIds = new Set<number>();
  private hasDirtyDeletes = false;

  constructor() {
    this.state = this.load();
  }

  private load(): StoreState {
    try {
      if (fs.existsSync(SNAPSHOT_PATH)) {
        const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as StoreState;
        if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.items)) {
          for (const idx of parsed.itemIndices || []) {
            if (!Array.isArray(idx.attachments)) idx.attachments = [];
          }
          for (const t of parsed.tenders || []) {
            if (typeof t.gst_rate !== 'number' || !Number.isFinite(t.gst_rate)) {
              t.gst_rate = 18;
            }
            if (typeof t.freightrateperunit !== 'number' || !Number.isFinite(t.freightrateperunit)) {
              const firstVendor = (parsed.tenderVendors || []).find((v) => v.tender_id === t.id && Number(v.freightrateperunit) > 0);
              t.freightrateperunit = firstVendor ? Number(firstVendor.freightrateperunit) : 0;
            }
          }
          for (const it of parsed.items || []) {
            if (it.lag_months === undefined || it.lag_months === null) {
              it.lag_months = (it.pvc_formula_code || '').toUpperCase() === 'TRACTIONMOTOR' ? 2 : 1;
            }
            if (it.base_lag_months === undefined || it.base_lag_months === null) {
              it.base_lag_months = 0;
            }
            if (it.index_source === undefined) {
              it.index_source = 'IEEMA';
            }
          }
          return parsed;
        }
      }
    } catch {
      // ignore corrupted snapshot
    }
    const fresh = createInitialState();
    this.persist(fresh);
    return fresh;
  }

  private persist(state: StoreState = this.state): void {
    try {
      fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(state), 'utf-8');
    } catch {
      // best effort in ephemeral container
    }
  }

  public logAudit(
    userId: number | null,
    action: 'INSERT' | 'UPDATE' | 'DELETE',
    tableName: string,
    rowId: number | string | null,
    oldData: unknown,
    newData: unknown
  ): void {
    const entry: AuditLogRecord = {
      id: this.state.nextIds.auditLogs++,
      user_id: userId,
      action,
      table_name: tableName,
      row_id: rowId != null ? String(rowId) : null,
      old_data: oldData != null ? JSON.stringify(oldData) : null,
      new_data: newData != null ? JSON.stringify(newData) : null,
      timestamp: new Date().toISOString(),
    };
    this.state.auditLogs.push(entry);
    if (this.state.auditLogs.length > 1000) {
      this.state.auditLogs = this.state.auditLogs.slice(-1000);
    }
    if (['item', 'item_index', 'tender_master', 'tender_vendor', 'pvc_result'].includes(tableName)) {
      this.mutationRevision += 1;
    }
    this.persist();
  }

  // ── Cloud Sync Bridge (Firestore <-> Store) ───────────────────────────
  getSyncSnapshot(): {
    bootId: string;
    revision: number;
    hydratedFromCloud: boolean;
    cloudOwnerUid: string | null;
    items: ItemRecord[];
    itemIndices: ItemIndexRecord[];
    tenders: TenderMasterRecord[];
    tenderVendors: TenderVendorRecord[];
    pvcResults: PVCResultRecord[];
  } {
    return {
      bootId: this.bootId,
      revision: this.mutationRevision,
      hydratedFromCloud: this.hydratedFromCloud,
      cloudOwnerUid: this.cloudOwnerUid,
      items: this.state.items,
      itemIndices: this.state.itemIndices,
      tenders: this.state.tenders,
      tenderVendors: this.state.tenderVendors,
      pvcResults: this.state.pvcResults,
    };
  }

  markCloudSynced(revision: number, ownerUid: string): void {
    this.hydratedFromCloud = true;
    this.cloudOwnerUid = ownerUid;
    if (Number.isFinite(revision) && revision > this.mutationRevision) {
      this.mutationRevision = revision;
    }
    this.dirtyItemIds.clear();
    this.dirtyIndexKeys.clear();
    this.dirtyTenderNos.clear();
    this.dirtyVendorKeys.clear();
    this.dirtyResultIds.clear();
    this.hasDirtyDeletes = false;
  }

  private hasDirtyLocalMutations(): boolean {
    return (
      this.dirtyItemIds.size > 0 ||
      this.dirtyIndexKeys.size > 0 ||
      this.dirtyTenderNos.size > 0 ||
      this.dirtyVendorKeys.size > 0 ||
      this.dirtyResultIds.size > 0 ||
      this.hasDirtyDeletes
    );
  }

  hydrateFromCloud(payload: {
    ownerUid: string;
    revision: number;
    items: ItemRecord[];
    itemIndices: ItemIndexRecord[];
    tenders: TenderMasterRecord[];
    tenderVendors: TenderVendorRecord[];
    pvcResults: PVCResultRecord[];
    defaultUserId: number;
  }): { changed: boolean; needsPushBack: boolean; revision: number } {
    const cloudItems = Array.isArray(payload.items) ? payload.items : [];
    const cloudIndices = Array.isArray(payload.itemIndices) ? payload.itemIndices : [];
    const cloudTenders = Array.isArray(payload.tenders) ? payload.tenders : [];
    const cloudVendors = Array.isArray(payload.tenderVendors) ? payload.tenderVendors : [];
    const cloudResults = Array.isArray(payload.pvcResults) ? payload.pvcResults : [];

    // If cloud has no items at all, keep current seeded/local data and push back to cloud
    if (cloudItems.length === 0) {
      this.hydratedFromCloud = true;
      this.cloudOwnerUid = payload.ownerUid;
      if (this.mutationRevision === 0) this.mutationRevision = 1;
      return { changed: false, needsPushBack: true, revision: this.mutationRevision };
    }

    const hadLocalUnsyncedMutations = !this.hydratedFromCloud && this.hasDirtyLocalMutations();
    const beforeFingerprint = JSON.stringify({
      items: this.state.items,
      itemIndices: this.state.itemIndices.map((r) => ({ id: r.id, item_id: r.item_id, month: r.month, indices_json: r.indices_json })),
      tenders: this.state.tenders,
      tenderVendors: this.state.tenderVendors,
      pvcResults: this.state.pvcResults.length,
    });

    const maxId = (arr: Array<{ id: number }>) => arr.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);

    // Always start from Firestore cloud records as the authoritative base.
    // Never let untouched container seed defaults overwrite cloud-persisted data.
    const normalizedCloudItems: ItemRecord[] = cloudItems.map((it) => ({
      ...it,
      lag_months: it.lag_months ?? 1,
      base_lag_months: it.base_lag_months ?? 0,
      fixed_weight: it.fixed_weight ?? 15,
      index_source: it.index_source ?? 'IEEMA',
    }));
    const normalizedCloudIndices: ItemIndexRecord[] = cloudIndices.map((idx) => ({
      ...idx,
      attachments: Array.isArray(idx.attachments) ? idx.attachments : [],
    }));
    const normalizedCloudTenders: TenderMasterRecord[] = cloudTenders.map((t) => ({
      ...t,
      freightrateperunit: t.freightrateperunit ?? 0,
      gst_rate: t.gst_rate ?? 18,
    }));
    const normalizedCloudVendors: TenderVendorRecord[] = [...cloudVendors];
    const normalizedCloudResults: PVCResultRecord[] = cloudResults.map((r) => ({
      ...r,
      user_id: r.user_id || payload.defaultUserId,
    }));

    if (!hadLocalUnsyncedMutations) {
      this.state.items = normalizedCloudItems;
      this.state.itemIndices = normalizedCloudIndices;
      this.state.tenders = normalizedCloudTenders;
      this.state.tenderVendors = normalizedCloudVendors;
      this.state.pvcResults = normalizedCloudResults;
      this.mutationRevision = Math.max(1, Number(payload.revision) || 1);
    } else {
      // Overlay ONLY records explicitly created/updated by the user since process boot.
      const itemMap = new Map<number, ItemRecord>();
      for (const it of normalizedCloudItems) itemMap.set(it.id, it);
      for (const it of this.state.items) {
        if (this.dirtyItemIds.has(it.id)) {
          itemMap.set(it.id, it);
        }
      }
      this.state.items = Array.from(itemMap.values());

      let nextIndexId = Math.max(this.state.nextIds.itemIndices, maxId(normalizedCloudIndices) + 1);
      const idxMap = new Map<string, ItemIndexRecord>();
      for (const idx of normalizedCloudIndices) {
        idxMap.set(`${idx.item_id}::${idx.month}`, idx);
      }
      for (const idx of this.state.itemIndices) {
        const key = `${idx.item_id}::${idx.month}`;
        if (this.dirtyIndexKeys.has(key)) {
          const existingCloud = idxMap.get(key);
          idxMap.set(key, {
            ...idx,
            id: existingCloud ? existingCloud.id : nextIndexId++,
          });
        }
      }
      this.state.itemIndices = Array.from(idxMap.values());

      let nextTenderId = Math.max(this.state.nextIds.tenders, maxId(normalizedCloudTenders) + 1);
      const tenderMap = new Map<string, TenderMasterRecord>();
      for (const t of normalizedCloudTenders) {
        tenderMap.set(t.tender_no.trim().toLowerCase(), t);
      }
      const localTenderIdToFinalId = new Map<number, number>();
      for (const t of this.state.tenders) {
        const key = t.tender_no.trim().toLowerCase();
        const existingCloud = tenderMap.get(key);
        if (this.dirtyTenderNos.has(key)) {
          const finalId = existingCloud ? existingCloud.id : nextTenderId++;
          localTenderIdToFinalId.set(t.id, finalId);
          tenderMap.set(key, { ...t, id: finalId });
        } else if (existingCloud) {
          localTenderIdToFinalId.set(t.id, existingCloud.id);
        }
      }
      this.state.tenders = Array.from(tenderMap.values());

      let nextVendorId = Math.max(this.state.nextIds.tenderVendors, maxId(normalizedCloudVendors) + 1);
      const vendorMap = new Map<string, TenderVendorRecord>();
      for (const v of normalizedCloudVendors) {
        vendorMap.set(`${v.tender_id}::${v.vendor_name.trim().toLowerCase()}`, v);
      }
      for (const v of this.state.tenderVendors) {
        const localKey = `${v.tender_id}::${v.vendor_name.trim().toLowerCase()}`;
        if (this.dirtyVendorKeys.has(localKey)) {
          const mappedTenderId = localTenderIdToFinalId.get(v.tender_id);
          if (mappedTenderId !== undefined) {
            const finalKey = `${mappedTenderId}::${v.vendor_name.trim().toLowerCase()}`;
            const existingCloud = vendorMap.get(finalKey);
            vendorMap.set(finalKey, {
              ...v,
              id: existingCloud ? existingCloud.id : nextVendorId++,
              tender_id: mappedTenderId,
            });
          }
        }
      }
      this.state.tenderVendors = Array.from(vendorMap.values());

      let nextResultId = Math.max(this.state.nextIds.pvcResults, maxId(normalizedCloudResults) + 1);
      const resMap = new Map<number, PVCResultRecord>();
      for (const r of normalizedCloudResults) resMap.set(r.id, r);
      for (const r of this.state.pvcResults) {
        if (this.dirtyResultIds.has(r.id)) {
          const finalId = resMap.has(r.id) ? nextResultId++ : r.id;
          resMap.set(finalId, { ...r, id: finalId, user_id: r.user_id || payload.defaultUserId });
        }
      }
      this.state.pvcResults = Array.from(resMap.values());

      this.mutationRevision = Math.max(this.mutationRevision, Number(payload.revision) || 0) + 1;
    }

    // Recompute safe nextIds so future creates never collide
    this.state.nextIds.items = Math.max(this.state.nextIds.items, maxId(this.state.items) + 1);
    this.state.nextIds.itemIndices = Math.max(this.state.nextIds.itemIndices, maxId(this.state.itemIndices) + 1);
    this.state.nextIds.tenders = Math.max(this.state.nextIds.tenders, maxId(this.state.tenders) + 1);
    this.state.nextIds.tenderVendors = Math.max(this.state.nextIds.tenderVendors, maxId(this.state.tenderVendors) + 1);
    this.state.nextIds.pvcResults = Math.max(this.state.nextIds.pvcResults, maxId(this.state.pvcResults) + 1);

    this.hydratedFromCloud = true;
    this.cloudOwnerUid = payload.ownerUid;
    this.persist();

    const afterFingerprint = JSON.stringify({
      items: this.state.items,
      itemIndices: this.state.itemIndices.map((r) => ({ id: r.id, item_id: r.item_id, month: r.month, indices_json: r.indices_json })),
      tenders: this.state.tenders,
      tenderVendors: this.state.tenderVendors,
      pvcResults: this.state.pvcResults.length,
    });

    return {
      changed: beforeFingerprint !== afterFingerprint,
      needsPushBack: hadLocalUnsyncedMutations,
      revision: this.mutationRevision,
    };
  }

  // ── Users ─────────────────────────────────────────────────────────────
  getUsers(): UserRecord[] {
    return [...this.state.users].sort((a, b) => a.id - b.id);
  }

  getUserById(id: number): UserRecord | undefined {
    return this.state.users.find((u) => u.id === id);
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const normalized = username.trim().toLowerCase();
    return this.state.users.find((u) => u.username.trim().toLowerCase() === normalized);
  }

  getUserByEmail(email: string): UserRecord | undefined {
    const normalized = email.trim().toLowerCase();
    return this.state.users.find((u) => (u.email || '').trim().toLowerCase() === normalized);
  }

  hasAdmin(): boolean {
    return this.state.users.some((u) => u.is_admin);
  }

  createUser(input: Omit<UserRecord, 'id'>, actorId: number | null = null): UserRecord {
    const user: UserRecord = { id: this.state.nextIds.users++, ...input };
    this.state.users.push(user);
    this.logAudit(actorId, 'INSERT', 'user', user.id, null, { ...user, password_hash: '***' });
    return user;
  }

  updateUser(id: number, patch: Partial<UserRecord>, actorId: number | null = null): UserRecord | undefined {
    const user = this.state.users.find((u) => u.id === id);
    if (!user) return undefined;
    const oldSnap = { ...user, password_hash: '***' };
    Object.assign(user, patch);
    this.logAudit(actorId, 'UPDATE', 'user', user.id, oldSnap, { ...user, password_hash: '***' });
    return user;
  }

  deleteUser(id: number, actorId: number | null = null): boolean {
    const idx = this.state.users.findIndex((u) => u.id === id);
    if (idx === -1) return false;
    const [removed] = this.state.users.splice(idx, 1);
    this.state.pvcResults = this.state.pvcResults.filter((r) => r.user_id !== id);
    this.logAudit(actorId, 'DELETE', 'user', id, { ...removed, password_hash: '***' }, null);
    return true;
  }

  // ── Items ─────────────────────────────────────────────────────────────
  getItems(): ItemRecord[] {
    return [...this.state.items].sort((a, b) => a.name.localeCompare(b.name));
  }

  getItemById(id: number): ItemRecord | undefined {
    return this.state.items.find((it) => it.id === id);
  }

  getItemByName(name: string): ItemRecord | undefined {
    return this.state.items.find((it) => it.name.toLowerCase() === name.toLowerCase());
  }

  createItem(input: Omit<ItemRecord, 'id'>, actorId: number | null = null): ItemRecord {
    const item: ItemRecord = { id: this.state.nextIds.items++, ...input };
    this.state.items.push(item);
    this.dirtyItemIds.add(item.id);
    this.logAudit(actorId, 'INSERT', 'item', item.id, null, item);
    return item;
  }

  updateItem(id: number, patch: Partial<ItemRecord>, actorId: number | null = null): ItemRecord | undefined {
    const item = this.state.items.find((it) => it.id === id);
    if (!item) return undefined;
    const oldSnap = { ...item };
    Object.assign(item, patch);
    this.dirtyItemIds.add(item.id);
    this.logAudit(actorId, 'UPDATE', 'item', item.id, oldSnap, item);
    return item;
  }

  deleteItem(id: number, actorId: number | null = null): { ok: boolean; error?: string } {
    const hasTenders = this.state.tenders.some((t) => t.item_id === id);
    const hasCalcs = this.state.pvcResults.some((c) => c.item_id === id);
    if (hasTenders || hasCalcs) {
      return { ok: false, error: 'Cannot delete item. It is referenced by tenders or calculation history.' };
    }
    const idx = this.state.items.findIndex((it) => it.id === id);
    if (idx === -1) return { ok: false, error: 'Item not found.' };
    const [removed] = this.state.items.splice(idx, 1);
    this.state.itemIndices = this.state.itemIndices.filter((r) => r.item_id !== id);
    this.hasDirtyDeletes = true;
    this.logAudit(actorId, 'DELETE', 'item', id, removed, null);
    return { ok: true };
  }

  // ── Item Indices ──────────────────────────────────────────────────────
  getItemIndices(itemId: number, order: 'asc' | 'desc' = 'desc'): ItemIndexRecord[] {
    return this.state.itemIndices
      .filter((r) => r.item_id === itemId)
      .sort((a, b) => (order === 'asc' ? a.month.localeCompare(b.month) : b.month.localeCompare(a.month)));
  }

  getItemIndexById(itemId: number, rowId: number): ItemIndexRecord | undefined {
    return this.state.itemIndices.find((r) => r.item_id === itemId && r.id === rowId);
  }

  getItemIndexByMonth(itemId: number, month: string): ItemIndexRecord | undefined {
    return this.state.itemIndices.find((r) => r.item_id === itemId && r.month === month);
  }

  createItemIndex(input: Omit<ItemIndexRecord, 'id'>, actorId: number | null = null): ItemIndexRecord {
    const row: ItemIndexRecord = {
      id: this.state.nextIds.itemIndices++,
      attachments: [],
      ...input,
    };
    this.state.itemIndices.push(row);
    this.dirtyIndexKeys.add(`${row.item_id}::${row.month}`);
    this.logAudit(actorId, 'INSERT', 'item_index', row.id, null, row);
    return row;
  }

  updateItemIndex(
    itemId: number,
    rowId: number,
    patch: Partial<ItemIndexRecord>,
    actorId: number | null = null
  ): ItemIndexRecord | undefined {
    const row = this.getItemIndexById(itemId, rowId);
    if (!row) return undefined;
    const oldSnap = { ...row };
    Object.assign(row, patch);
    if (!Array.isArray(row.attachments)) row.attachments = [];
    this.dirtyIndexKeys.add(`${row.item_id}::${row.month}`);
    this.logAudit(actorId, 'UPDATE', 'item_index', row.id, oldSnap, row);
    return row;
  }

  addIndexAttachments(
    itemId: number,
    rowId: number,
    newAttachments: IndexAttachment[],
    actorId: number | null = null
  ): ItemIndexRecord | undefined {
    const row = this.getItemIndexById(itemId, rowId);
    if (!row) return undefined;
    if (!Array.isArray(row.attachments)) row.attachments = [];
    row.attachments.push(...newAttachments);
    this.dirtyIndexKeys.add(`${row.item_id}::${row.month}`);
    this.logAudit(actorId, 'UPDATE', 'item_index', row.id, null, { added_attachments: newAttachments.map((a) => a.original_name) });
    return row;
  }

  removeIndexAttachment(
    itemId: number,
    rowId: number,
    attachmentId: string,
    actorId: number | null = null
  ): IndexAttachment | undefined {
    const row = this.getItemIndexById(itemId, rowId);
    if (!row || !Array.isArray(row.attachments)) return undefined;
    const idx = row.attachments.findIndex((a) => a.id === attachmentId);
    if (idx === -1) return undefined;
    const [removed] = row.attachments.splice(idx, 1);
    this.dirtyIndexKeys.add(`${row.item_id}::${row.month}`);
    this.logAudit(actorId, 'UPDATE', 'item_index', row.id, { removed_attachment: removed.original_name }, null);
    return removed;
  }

  deleteItemIndex(itemId: number, rowId: number, actorId: number | null = null): boolean {
    const idx = this.state.itemIndices.findIndex((r) => r.item_id === itemId && r.id === rowId);
    if (idx === -1) return false;
    const [removed] = this.state.itemIndices.splice(idx, 1);
    this.hasDirtyDeletes = true;
    this.logAudit(actorId, 'DELETE', 'item_index', rowId, removed, null);
    return true;
  }

  // ── Tenders & Vendors ─────────────────────────────────────────────────
  getTenders(): Array<TenderMasterRecord & { item?: ItemRecord; vendors: TenderVendorRecord[] }> {
    return [...this.state.tenders]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((t) => ({
        ...t,
        item: this.getItemById(t.item_id),
        vendors: this.getTenderVendors(t.id),
      }));
  }

  getTendersByNumberAsc(): Array<TenderMasterRecord & { item?: ItemRecord; vendors: TenderVendorRecord[] }> {
    return [...this.state.tenders]
      .sort((a, b) => a.tender_no.localeCompare(b.tender_no))
      .map((t) => ({
        ...t,
        item: this.getItemById(t.item_id),
        vendors: this.getTenderVendors(t.id),
      }));
  }

  getTenderById(id: number): (TenderMasterRecord & { item?: ItemRecord; vendors: TenderVendorRecord[] }) | undefined {
    const t = this.state.tenders.find((x) => x.id === id);
    if (!t) return undefined;
    return {
      ...t,
      item: this.getItemById(t.item_id),
      vendors: this.getTenderVendors(t.id),
    };
  }

  getTenderByNo(tenderNo: string): (TenderMasterRecord & { item?: ItemRecord; vendors: TenderVendorRecord[] }) | undefined {
    const t = this.state.tenders.find((x) => x.tender_no === tenderNo);
    if (!t) return undefined;
    return this.getTenderById(t.id);
  }

  createTender(input: Omit<TenderMasterRecord, 'id' | 'created_at'>, actorId: number | null = null): TenderMasterRecord {
    const row: TenderMasterRecord = {
      id: this.state.nextIds.tenders++,
      created_at: new Date().toISOString(),
      ...input,
    };
    this.state.tenders.push(row);
    this.dirtyTenderNos.add(row.tender_no.trim().toLowerCase());
    this.logAudit(actorId, 'INSERT', 'tender_master', row.id, null, row);
    return row;
  }

  updateTender(id: number, patch: Partial<TenderMasterRecord>, actorId: number | null = null): TenderMasterRecord | undefined {
    const row = this.state.tenders.find((t) => t.id === id);
    if (!row) return undefined;
    const oldSnap = { ...row };
    Object.assign(row, patch);
    this.dirtyTenderNos.add(row.tender_no.trim().toLowerCase());
    this.logAudit(actorId, 'UPDATE', 'tender_master', row.id, oldSnap, row);
    return row;
  }

  deleteTender(id: number, actorId: number | null = null): boolean {
    const idx = this.state.tenders.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    const [removed] = this.state.tenders.splice(idx, 1);
    this.state.tenderVendors = this.state.tenderVendors.filter((v) => v.tender_id !== id);
    this.hasDirtyDeletes = true;
    this.logAudit(actorId, 'DELETE', 'tender_master', id, removed, null);
    return true;
  }

  getTenderVendors(tenderId: number): TenderVendorRecord[] {
    return this.state.tenderVendors
      .filter((v) => v.tender_id === tenderId)
      .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
  }

  getAllVendors(): TenderVendorRecord[] {
    return [...this.state.tenderVendors];
  }

  getTenderVendorById(tenderId: number, rowId: number): TenderVendorRecord | undefined {
    return this.state.tenderVendors.find((v) => v.tender_id === tenderId && v.id === rowId);
  }

  getTenderVendorByName(tenderId: number, vendorName: string): TenderVendorRecord | undefined {
    const target = vendorName.trim().toLowerCase();
    return this.state.tenderVendors.find(
      (v) => v.tender_id === tenderId && v.vendor_name.trim().toLowerCase() === target
    );
  }

  createTenderVendor(input: Omit<TenderVendorRecord, 'id'>, actorId: number | null = null): TenderVendorRecord {
    const row: TenderVendorRecord = { id: this.state.nextIds.tenderVendors++, ...input };
    this.state.tenderVendors.push(row);
    this.dirtyVendorKeys.add(`${row.tender_id}::${row.vendor_name.trim().toLowerCase()}`);
    this.logAudit(actorId, 'INSERT', 'tender_vendor', row.id, null, row);
    return row;
  }

  updateTenderVendor(
    tenderId: number,
    rowId: number,
    patch: Partial<TenderVendorRecord>,
    actorId: number | null = null
  ): TenderVendorRecord | undefined {
    const row = this.getTenderVendorById(tenderId, rowId);
    if (!row) return undefined;
    const oldSnap = { ...row };
    Object.assign(row, patch);
    this.dirtyVendorKeys.add(`${row.tender_id}::${row.vendor_name.trim().toLowerCase()}`);
    this.logAudit(actorId, 'UPDATE', 'tender_vendor', row.id, oldSnap, row);
    return row;
  }

  deleteTenderVendor(tenderId: number, rowId: number, actorId: number | null = null): boolean {
    const idx = this.state.tenderVendors.findIndex((v) => v.tender_id === tenderId && v.id === rowId);
    if (idx === -1) return false;
    const [removed] = this.state.tenderVendors.splice(idx, 1);
    this.hasDirtyDeletes = true;
    this.logAudit(actorId, 'DELETE', 'tender_vendor', rowId, removed, null);
    return true;
  }

  // ── PVC Results ───────────────────────────────────────────────────────
  getPVCResults(userId?: number): Array<PVCResultRecord & { item?: ItemRecord }> {
    return this.state.pvcResults
      .filter((r) => (userId != null ? r.user_id === userId : true))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) => ({ ...r, item: this.getItemById(r.item_id) }));
  }

  getPVCResultById(id: number): (PVCResultRecord & { item?: ItemRecord }) | undefined {
    const r = this.state.pvcResults.find((x) => x.id === id);
    if (!r) return undefined;
    return { ...r, item: this.getItemById(r.item_id) };
  }

  createPVCResult(input: Omit<PVCResultRecord, 'id' | 'created_at'>, actorId: number | null = null): PVCResultRecord {
    const row: PVCResultRecord = {
      id: this.state.nextIds.pvcResults++,
      created_at: new Date().toISOString(),
      ...input,
    };
    this.state.pvcResults.push(row);
    this.dirtyResultIds.add(row.id);
    this.logAudit(actorId, 'INSERT', 'pvc_result', row.id, null, { id: row.id, item_id: row.item_id, fairprice: row.fairprice });
    return row;
  }

  updatePVCResult(id: number, patch: Partial<PVCResultRecord>, actorId: number | null = null): PVCResultRecord | undefined {
    const row = this.state.pvcResults.find((x) => x.id === id);
    if (!row) return undefined;
    const oldSnap = { id: row.id, fairprice: row.fairprice, selectedscenario: row.selectedscenario };
    Object.assign(row, patch);
    this.dirtyResultIds.add(row.id);
    this.logAudit(actorId, 'UPDATE', 'pvc_result', row.id, oldSnap, { id: row.id, fairprice: row.fairprice, selectedscenario: row.selectedscenario });
    return row;
  }

  // ── Audit Logs ────────────────────────────────────────────────────────
  getAuditLogs(limit = 200): Array<AuditLogRecord & { user?: UserRecord }> {
    return [...this.state.auditLogs]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map((l) => ({
        ...l,
        user: l.user_id != null ? this.getUserById(l.user_id) : undefined,
      }));
  }

  // ── Backup Snapshot ───────────────────────────────────────────────────
  exportBackup(): Record<string, unknown> {
    return {
      exported_at: new Date().toISOString(),
      app: 'PVC Calculation Studio',
      counts: {
        users: this.state.users.length,
        items: this.state.items.length,
        item_indices: this.state.itemIndices.length,
        tenders: this.state.tenders.length,
        tender_vendors: this.state.tenderVendors.length,
        pvc_results: this.state.pvcResults.length,
        audit_logs: this.state.auditLogs.length,
      },
      data: {
        users: this.state.users.map(({ password_hash: _pw, ...rest }) => rest),
        items: this.state.items,
        item_indices: this.state.itemIndices,
        tenders: this.state.tenders,
        tender_vendors: this.state.tenderVendors,
        pvc_results: this.state.pvcResults,
        audit_logs: this.state.auditLogs,
      },
    };
  }

  getStats(): { totalCalculations: number; totalItems: number; activeContracts: number; systemUsers: number } {
    return {
      totalCalculations: this.state.pvcResults.length,
      totalItems: this.state.items.length,
      activeContracts: this.state.tenders.length,
      systemUsers: this.state.users.length,
    };
  }
}

export function paginate<T>(allItems: T[], page: number, perPage = 25): Pagination<T> {
  const safePage = Math.max(1, Number.isFinite(page) ? Math.floor(page) : 1);
  const total = allItems.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const clampedPage = Math.min(safePage, pages);
  const start = (clampedPage - 1) * perPage;
  const items = allItems.slice(start, start + perPage);
  return {
    items,
    page: clampedPage,
    per_page: perPage,
    total,
    pages,
    has_prev: clampedPage > 1,
    has_next: clampedPage < pages,
    prev_num: Math.max(1, clampedPage - 1),
    next_num: Math.min(pages, clampedPage + 1),
  };
}

export const store = new MemoryStore();
