import { asc, eq } from 'drizzle-orm';
import { db, isSqlConfigured } from './index.js';
import {
  auditLogs,
  itemIndices,
  items,
  pvcResults,
  tenders,
  tenderVendors,
  users,
} from './schema.js';
import type {
  AuditLogRecord,
  IndexAttachment,
  ItemIndexRecord,
  ItemRecord,
  PVCResultRecord,
  TenderMasterRecord,
  TenderVendorRecord,
  UserRecord,
} from '../server/types.js';

export interface WorkspaceDataset {
  users: UserRecord[];
  items: ItemRecord[];
  itemIndices: ItemIndexRecord[];
  tenders: TenderMasterRecord[];
  tenderVendors: TenderVendorRecord[];
  pvcResults: PVCResultRecord[];
  auditLogs: AuditLogRecord[];
}

export type PendingDbOp =
  | { kind: 'insert_user'; record: UserRecord }
  | { kind: 'update_user'; id: number; patch: Partial<UserRecord> }
  | { kind: 'delete_user'; id: number }
  | { kind: 'insert_item'; record: ItemRecord }
  | { kind: 'update_item'; id: number; patch: Partial<ItemRecord> }
  | { kind: 'delete_item'; id: number }
  | { kind: 'upsert_item_index'; record: ItemIndexRecord }
  | { kind: 'update_item_index'; id: number; itemId: number; month: string; indicesJson: string; attachments: IndexAttachment[] }
  | { kind: 'delete_item_index'; id: number }
  | { kind: 'insert_tender'; record: TenderMasterRecord }
  | { kind: 'update_tender'; id: number; patch: Partial<TenderMasterRecord> }
  | { kind: 'delete_tender'; id: number }
  | { kind: 'insert_tender_vendor'; record: TenderVendorRecord }
  | { kind: 'update_tender_vendor'; id: number; patch: Partial<TenderVendorRecord> }
  | { kind: 'delete_tender_vendor'; id: number }
  | { kind: 'insert_pvc_result'; record: PVCResultRecord }
  | { kind: 'update_pvc_result'; id: number; patch: Partial<PVCResultRecord> }
  | { kind: 'insert_audit_log'; record: AuditLogRecord };

function parseAttachmentsSafe(raw: string | null | undefined): IndexAttachment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as IndexAttachment[]) : [];
  } catch {
    return [];
  }
}

export async function loadWorkspaceFromDb(seedProvider: () => WorkspaceDataset): Promise<WorkspaceDataset | null> {
  if (!isSqlConfigured()) return null;

  try {
    const [userRows, itemRows] = await Promise.all([
      db.select().from(users).orderBy(asc(users.id)),
      db.select().from(items).orderBy(asc(items.id)),
    ]);

    // Seed initial baseline data ONCE when the PostgreSQL database is brand new (empty users & items)
    if (userRows.length === 0 && itemRows.length === 0) {
      await seedInitialWorkspaceInDb(seedProvider());
    }

    const [allUsers, allItems, allIndices, allTenders, allVendors, allResults, allLogs] = await Promise.all([
      db.select().from(users).orderBy(asc(users.id)),
      db.select().from(items).orderBy(asc(items.id)),
      db.select().from(itemIndices).orderBy(asc(itemIndices.id)),
      db.select().from(tenders).orderBy(asc(tenders.id)),
      db.select().from(tenderVendors).orderBy(asc(tenderVendors.id)),
      db.select().from(pvcResults).orderBy(asc(pvcResults.id)),
      db.select().from(auditLogs).orderBy(asc(auditLogs.id)),
    ]);

    return {
      users: allUsers.map((u) => ({
        id: u.id,
        username: u.username,
        full_name: u.fullName ?? null,
        email: u.email ?? null,
        contact_no: u.contactNo ?? null,
        designation: u.designation ?? null,
        control_no: u.controlNo ?? null,
        password_hash: u.passwordHash,
        is_admin: u.isAdmin,
      })),
      items: allItems.map((it) => ({
        id: it.id,
        name: it.name,
        code: it.code ?? null,
        description: it.description ?? null,
        pvc_formula_code: it.pvcFormulaCode,
        weights_json: it.weightsJson,
        extra_fields_json: it.extraFieldsJson,
        lag_months: it.lagMonths,
        base_lag_months: it.baseLagMonths,
        fixed_weight: it.fixedWeight,
        index_source: it.indexSource ?? 'IEEMA',
        components_json: it.componentsJson ?? '[]',
        custom_formula: it.customFormula ?? null,
      })),
      itemIndices: allIndices.map((idx) => ({
        id: idx.id,
        item_id: idx.itemId,
        month: idx.month,
        indices_json: idx.indicesJson,
        attachments: parseAttachmentsSafe(idx.attachmentsJson),
      })),
      tenders: allTenders.map((t) => ({
        id: t.id,
        item_id: t.itemId,
        tender_no: t.tenderNo,
        basicrate: t.basicrate,
        pvcbasedate: t.pvcbasedate ?? null,
        freightrateperunit: t.freightrateperunit,
        gst_rate: t.gstRate,
        created_at: t.createdAt,
      })),
      tenderVendors: allVendors.map((v) => ({
        id: v.id,
        tender_id: v.tenderId,
        po_no: v.poNo ?? null,
        vendor_name: v.vendorName,
        cif: v.cif,
        freightrateperunit: v.freightrateperunit,
        currency: v.currency,
      })),
      pvcResults: allResults.map((r) => ({
        id: r.id,
        user_id: r.userId,
        item_id: r.itemId,
        username: r.username,
        created_at: r.createdAt,
        basicrate: r.basicrate,
        quantity: r.quantity,
        freightrateperunit: r.freightrateperunit,
        pvcbasedate: r.pvcbasedate ?? null,
        origdp: r.origdp ?? null,
        refixeddp: r.refixeddp ?? null,
        extendeddp: r.extendeddp ?? null,
        caldate: r.caldate ?? null,
        supdate: r.supdate ?? null,
        rateapplied: r.rateapplied ?? null,
        pvcactual: r.pvcactual ?? null,
        pvccontractual: r.pvccontractual ?? null,
        loweractual: r.loweractual ?? null,
        lowercontractual: r.lowercontractual ?? null,
        ldamtactual: r.ldamtactual ?? null,
        ldamtcontractual: r.ldamtcontractual ?? null,
        fairprice: r.fairprice ?? null,
        selectedscenario: r.selectedscenario ?? null,
        pvcactuallessldnew: r.pvcactuallessldnew ?? null,
        pvccontractuallessldnew: r.pvccontractuallessldnew ?? null,
        loweractuallessld: r.loweractuallessld ?? null,
        lowercontractuallessld: r.lowercontractuallessld ?? null,
        delaydays: r.delaydays,
        ldweeksnew: r.ldweeksnew,
        ldratepctnew: r.ldratepctnew,
        ldapplicable: r.ldapplicable,
        pvcperseta2: r.pvcperseta2 ?? null,
        pvcpersetb2: r.pvcpersetb2 ?? null,
        pvcpersetc1: r.pvcpersetc1 ?? null,
        pvcpersetd1: r.pvcpersetd1 ?? null,
        tenderno: r.tenderno ?? null,
        pono: r.pono ?? null,
        scenarioamounts_json: r.scenarioamountsJson,
        scenariodetails_json: r.scenariodetailsJson,
        igbt_vendor_details_json: r.igbtVendorDetailsJson,
      })),
      auditLogs: allLogs.slice(-1000).map((l) => ({
        id: l.id,
        user_id: l.userId ?? null,
        action: (l.action === 'INSERT' || l.action === 'UPDATE' || l.action === 'DELETE'
          ? l.action
          : 'UPDATE') as AuditLogRecord['action'],
        table_name: l.tableName,
        row_id: l.rowId ?? null,
        old_data: l.oldData ?? null,
        new_data: l.newData ?? null,
        timestamp: l.timestamp,
      })),
    };
  } catch (error) {
    console.error('Database workspace load failed:', error);
    throw new Error('Database query failed. Please try again later.', { cause: error });
  }
}

async function seedInitialWorkspaceInDb(seed: WorkspaceDataset): Promise<void> {
  await db.transaction(async (tx) => {
    const existingUsers = await tx.select({ id: users.id }).from(users).limit(1);
    const existingItems = await tx.select({ id: items.id }).from(items).limit(1);
    if (existingUsers.length > 0 || existingItems.length > 0) {
      return;
    }

    for (const u of seed.users) {
      await tx
        .insert(users)
        .values({
          username: u.username,
          fullName: u.full_name,
          email: u.email,
          contactNo: u.contact_no,
          designation: u.designation,
          controlNo: u.control_no,
          passwordHash: u.password_hash,
          isAdmin: u.is_admin,
        })
        .onConflictDoNothing();
    }

    const itemIdMap = new Map<number, number>();
    for (const it of seed.items) {
      const [inserted] = await tx
        .insert(items)
        .values({
          name: it.name,
          code: it.code,
          description: it.description,
          pvcFormulaCode: it.pvc_formula_code,
          weightsJson: it.weights_json,
          extraFieldsJson: it.extra_fields_json,
          lagMonths: it.lag_months ?? 1,
          baseLagMonths: it.base_lag_months ?? 0,
          fixedWeight: it.fixed_weight ?? 15,
          indexSource: it.index_source ?? 'IEEMA',
          componentsJson: it.components_json ?? '[]',
          customFormula: it.custom_formula ?? null,
        })
        .returning({ id: items.id });
      if (inserted) {
        itemIdMap.set(it.id, inserted.id);
      }
    }

    const indexValues = seed.itemIndices
      .map((idx) => {
        const mappedItemId = itemIdMap.get(idx.item_id);
        if (!mappedItemId) return null;
        return {
          itemId: mappedItemId,
          month: idx.month,
          indicesJson: idx.indices_json,
          attachmentsJson: JSON.stringify(idx.attachments || []),
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    const CHUNK = 50;
    for (let i = 0; i < indexValues.length; i += CHUNK) {
      await tx.insert(itemIndices).values(indexValues.slice(i, i + CHUNK)).onConflictDoNothing();
    }

    const tenderIdMap = new Map<number, number>();
    for (const t of seed.tenders) {
      const mappedItemId = itemIdMap.get(t.item_id);
      if (!mappedItemId) continue;
      const [inserted] = await tx
        .insert(tenders)
        .values({
          itemId: mappedItemId,
          tenderNo: t.tender_no,
          basicrate: t.basicrate,
          pvcbasedate: t.pvcbasedate,
          freightrateperunit: t.freightrateperunit ?? 0,
          gstRate: t.gst_rate ?? 18,
          createdAt: t.created_at,
        })
        .onConflictDoNothing()
        .returning({ id: tenders.id });
      if (inserted) {
        tenderIdMap.set(t.id, inserted.id);
      }
    }

    const vendorValues = seed.tenderVendors
      .map((v) => {
        const mappedTenderId = tenderIdMap.get(v.tender_id);
        if (!mappedTenderId) return null;
        return {
          tenderId: mappedTenderId,
          poNo: v.po_no,
          vendorName: v.vendor_name,
          cif: v.cif,
          freightrateperunit: v.freightrateperunit,
          currency: v.currency,
        };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    if (vendorValues.length > 0) {
      await tx.insert(tenderVendors).values(vendorValues);
    }
  });
}

export async function commitPendingOpsToDb(ops: PendingDbOp[]): Promise<void> {
  if (!isSqlConfigured() || ops.length === 0) return;

  try {
    await db.transaction(async (tx) => {
      const userIdMap = new Map<number, number>();
      const itemIdMap = new Map<number, number>();
      const tenderIdMap = new Map<number, number>();

      for (const op of ops) {
        switch (op.kind) {
          case 'insert_user': {
            const u = op.record;
            const [inserted] = await tx
              .insert(users)
              .values({
                username: u.username,
                fullName: u.full_name,
                email: u.email,
                contactNo: u.contact_no,
                designation: u.designation,
                controlNo: u.control_no,
                passwordHash: u.password_hash,
                isAdmin: u.is_admin,
              })
              .returning({ id: users.id });
            if (inserted) {
              userIdMap.set(u.id, inserted.id);
              u.id = inserted.id;
            }
            break;
          }
          case 'update_user': {
            const targetId = userIdMap.get(op.id) ?? op.id;
            const setValues: Partial<typeof users.$inferInsert> = {};
            if (op.patch.username !== undefined) setValues.username = op.patch.username;
            if (op.patch.full_name !== undefined) setValues.fullName = op.patch.full_name;
            if (op.patch.email !== undefined) setValues.email = op.patch.email;
            if (op.patch.contact_no !== undefined) setValues.contactNo = op.patch.contact_no;
            if (op.patch.designation !== undefined) setValues.designation = op.patch.designation;
            if (op.patch.control_no !== undefined) setValues.controlNo = op.patch.control_no;
            if (op.patch.password_hash !== undefined) setValues.passwordHash = op.patch.password_hash;
            if (op.patch.is_admin !== undefined) setValues.isAdmin = op.patch.is_admin;
            if (Object.keys(setValues).length > 0) {
              await tx.update(users).set(setValues).where(eq(users.id, targetId));
            }
            break;
          }
          case 'delete_user': {
            const targetId = userIdMap.get(op.id) ?? op.id;
            await tx.delete(users).where(eq(users.id, targetId));
            break;
          }
          case 'insert_item': {
            const it = op.record;
            const [inserted] = await tx
              .insert(items)
              .values({
                name: it.name,
                code: it.code,
                description: it.description,
                pvcFormulaCode: it.pvc_formula_code,
                weightsJson: it.weights_json,
                extraFieldsJson: it.extra_fields_json,
                lagMonths: it.lag_months ?? 1,
                baseLagMonths: it.base_lag_months ?? 0,
                fixedWeight: it.fixed_weight ?? 15,
                indexSource: it.index_source ?? 'IEEMA',
                componentsJson: it.components_json ?? '[]',
                customFormula: it.custom_formula ?? null,
              })
              .returning({ id: items.id });
            if (inserted) {
              itemIdMap.set(it.id, inserted.id);
              it.id = inserted.id;
            }
            break;
          }
          case 'update_item': {
            const targetId = itemIdMap.get(op.id) ?? op.id;
            const setValues: Partial<typeof items.$inferInsert> = {};
            if (op.patch.name !== undefined) setValues.name = op.patch.name;
            if (op.patch.code !== undefined) setValues.code = op.patch.code;
            if (op.patch.description !== undefined) setValues.description = op.patch.description;
            if (op.patch.pvc_formula_code !== undefined) setValues.pvcFormulaCode = op.patch.pvc_formula_code;
            if (op.patch.weights_json !== undefined) setValues.weightsJson = op.patch.weights_json;
            if (op.patch.extra_fields_json !== undefined) setValues.extraFieldsJson = op.patch.extra_fields_json;
            if (op.patch.lag_months !== undefined) setValues.lagMonths = op.patch.lag_months;
            if (op.patch.base_lag_months !== undefined) setValues.baseLagMonths = op.patch.base_lag_months;
            if (op.patch.fixed_weight !== undefined) setValues.fixedWeight = op.patch.fixed_weight;
            if (op.patch.index_source !== undefined) setValues.indexSource = op.patch.index_source;
            if (op.patch.components_json !== undefined) setValues.componentsJson = op.patch.components_json;
            if (op.patch.custom_formula !== undefined) setValues.customFormula = op.patch.custom_formula;
            if (Object.keys(setValues).length > 0) {
              await tx.update(items).set(setValues).where(eq(items.id, targetId));
            }
            break;
          }
          case 'delete_item': {
            const targetId = itemIdMap.get(op.id) ?? op.id;
            await tx.delete(items).where(eq(items.id, targetId));
            break;
          }
          case 'upsert_item_index': {
            const idx = op.record;
            const mappedItemId = itemIdMap.get(idx.item_id) ?? idx.item_id;
            const attachmentsJson = JSON.stringify(idx.attachments || []);
            const [upserted] = await tx
              .insert(itemIndices)
              .values({
                itemId: mappedItemId,
                month: idx.month,
                indicesJson: idx.indices_json,
                attachmentsJson,
              })
              .onConflictDoUpdate({
                target: [itemIndices.itemId, itemIndices.month],
                set: {
                  indicesJson: idx.indices_json,
                  attachmentsJson,
                },
              })
              .returning({ id: itemIndices.id });
            if (upserted) {
              idx.id = upserted.id;
              idx.item_id = mappedItemId;
            }
            break;
          }
          case 'update_item_index': {
            const mappedItemId = itemIdMap.get(op.itemId) ?? op.itemId;
            await tx
              .update(itemIndices)
              .set({
                month: op.month,
                indicesJson: op.indicesJson,
                attachmentsJson: JSON.stringify(op.attachments || []),
              })
              .where(eq(itemIndices.id, op.id));
            // Fallback upsert if row was matched by (itemId, month) in-memory
            void mappedItemId;
            break;
          }
          case 'delete_item_index': {
            await tx.delete(itemIndices).where(eq(itemIndices.id, op.id));
            break;
          }
          case 'insert_tender': {
            const t = op.record;
            const mappedItemId = itemIdMap.get(t.item_id) ?? t.item_id;
            const [upserted] = await tx
              .insert(tenders)
              .values({
                itemId: mappedItemId,
                tenderNo: t.tender_no,
                basicrate: t.basicrate,
                pvcbasedate: t.pvcbasedate,
                freightrateperunit: t.freightrateperunit ?? 0,
                gstRate: t.gst_rate ?? 18,
                createdAt: t.created_at,
              })
              .onConflictDoUpdate({
                target: tenders.tenderNo,
                set: {
                  itemId: mappedItemId,
                  basicrate: t.basicrate,
                  pvcbasedate: t.pvcbasedate,
                  freightrateperunit: t.freightrateperunit ?? 0,
                  gstRate: t.gst_rate ?? 18,
                },
              })
              .returning({ id: tenders.id });
            if (upserted) {
              tenderIdMap.set(t.id, upserted.id);
              t.id = upserted.id;
              t.item_id = mappedItemId;
            }
            break;
          }
          case 'update_tender': {
            const targetId = tenderIdMap.get(op.id) ?? op.id;
            const setValues: Partial<typeof tenders.$inferInsert> = {};
            if (op.patch.item_id !== undefined) setValues.itemId = itemIdMap.get(op.patch.item_id) ?? op.patch.item_id;
            if (op.patch.tender_no !== undefined) setValues.tenderNo = op.patch.tender_no;
            if (op.patch.basicrate !== undefined) setValues.basicrate = op.patch.basicrate;
            if (op.patch.pvcbasedate !== undefined) setValues.pvcbasedate = op.patch.pvcbasedate;
            if (op.patch.freightrateperunit !== undefined) setValues.freightrateperunit = op.patch.freightrateperunit;
            if (op.patch.gst_rate !== undefined) setValues.gstRate = op.patch.gst_rate;
            if (Object.keys(setValues).length > 0) {
              await tx.update(tenders).set(setValues).where(eq(tenders.id, targetId));
            }
            break;
          }
          case 'delete_tender': {
            const targetId = tenderIdMap.get(op.id) ?? op.id;
            await tx.delete(tenders).where(eq(tenders.id, targetId));
            break;
          }
          case 'insert_tender_vendor': {
            const v = op.record;
            const mappedTenderId = tenderIdMap.get(v.tender_id) ?? v.tender_id;
            const [inserted] = await tx
              .insert(tenderVendors)
              .values({
                tenderId: mappedTenderId,
                poNo: v.po_no,
                vendorName: v.vendor_name,
                cif: v.cif,
                freightrateperunit: v.freightrateperunit,
                currency: v.currency,
              })
              .returning({ id: tenderVendors.id });
            if (inserted) {
              v.id = inserted.id;
              v.tender_id = mappedTenderId;
            }
            break;
          }
          case 'update_tender_vendor': {
            const setValues: Partial<typeof tenderVendors.$inferInsert> = {};
            if (op.patch.po_no !== undefined) setValues.poNo = op.patch.po_no;
            if (op.patch.vendor_name !== undefined) setValues.vendorName = op.patch.vendor_name;
            if (op.patch.cif !== undefined) setValues.cif = op.patch.cif;
            if (op.patch.freightrateperunit !== undefined) setValues.freightrateperunit = op.patch.freightrateperunit;
            if (op.patch.currency !== undefined) setValues.currency = op.patch.currency;
            if (Object.keys(setValues).length > 0) {
              await tx.update(tenderVendors).set(setValues).where(eq(tenderVendors.id, op.id));
            }
            break;
          }
          case 'delete_tender_vendor': {
            await tx.delete(tenderVendors).where(eq(tenderVendors.id, op.id));
            break;
          }
          case 'insert_pvc_result': {
            const r = op.record;
            const mappedUserId = userIdMap.get(r.user_id) ?? r.user_id;
            const mappedItemId = itemIdMap.get(r.item_id) ?? r.item_id;
            const [inserted] = await tx
              .insert(pvcResults)
              .values({
                userId: mappedUserId,
                itemId: mappedItemId,
                username: r.username,
                createdAt: r.created_at,
                basicrate: r.basicrate,
                quantity: r.quantity,
                freightrateperunit: r.freightrateperunit,
                pvcbasedate: r.pvcbasedate,
                origdp: r.origdp,
                refixeddp: r.refixeddp,
                extendeddp: r.extendeddp,
                caldate: r.caldate,
                supdate: r.supdate,
                rateapplied: r.rateapplied,
                pvcactual: r.pvcactual,
                pvccontractual: r.pvccontractual,
                loweractual: r.loweractual,
                lowercontractual: r.lowercontractual,
                ldamtactual: r.ldamtactual,
                ldamtcontractual: r.ldamtcontractual,
                fairprice: r.fairprice,
                selectedscenario: r.selectedscenario,
                pvcactuallessldnew: r.pvcactuallessldnew,
                pvccontractuallessldnew: r.pvccontractuallessldnew,
                loweractuallessld: r.loweractuallessld,
                lowercontractuallessld: r.lowercontractuallessld,
                delaydays: r.delaydays,
                ldweeksnew: r.ldweeksnew,
                ldratepctnew: r.ldratepctnew,
                ldapplicable: r.ldapplicable,
                pvcperseta2: r.pvcperseta2,
                pvcpersetb2: r.pvcpersetb2,
                pvcpersetc1: r.pvcpersetc1,
                pvcpersetd1: r.pvcpersetd1,
                tenderno: r.tenderno,
                pono: r.pono,
                scenarioamountsJson: r.scenarioamounts_json,
                scenariodetailsJson: r.scenariodetails_json,
                igbtVendorDetailsJson: r.igbt_vendor_details_json,
              })
              .returning({ id: pvcResults.id });
            if (inserted) {
              r.id = inserted.id;
              r.user_id = mappedUserId;
              r.item_id = mappedItemId;
            }
            break;
          }
          case 'update_pvc_result': {
            const setValues: Partial<typeof pvcResults.$inferInsert> = {};
            const p = op.patch;
            if (p.basicrate !== undefined) setValues.basicrate = p.basicrate;
            if (p.quantity !== undefined) setValues.quantity = p.quantity;
            if (p.freightrateperunit !== undefined) setValues.freightrateperunit = p.freightrateperunit;
            if (p.pvcbasedate !== undefined) setValues.pvcbasedate = p.pvcbasedate;
            if (p.origdp !== undefined) setValues.origdp = p.origdp;
            if (p.refixeddp !== undefined) setValues.refixeddp = p.refixeddp;
            if (p.extendeddp !== undefined) setValues.extendeddp = p.extendeddp;
            if (p.caldate !== undefined) setValues.caldate = p.caldate;
            if (p.supdate !== undefined) setValues.supdate = p.supdate;
            if (p.rateapplied !== undefined) setValues.rateapplied = p.rateapplied;
            if (p.pvcactual !== undefined) setValues.pvcactual = p.pvcactual;
            if (p.pvccontractual !== undefined) setValues.pvccontractual = p.pvccontractual;
            if (p.loweractual !== undefined) setValues.loweractual = p.loweractual;
            if (p.lowercontractual !== undefined) setValues.lowercontractual = p.lowercontractual;
            if (p.ldamtactual !== undefined) setValues.ldamtactual = p.ldamtactual;
            if (p.ldamtcontractual !== undefined) setValues.ldamtcontractual = p.ldamtcontractual;
            if (p.fairprice !== undefined) setValues.fairprice = p.fairprice;
            if (p.selectedscenario !== undefined) setValues.selectedscenario = p.selectedscenario;
            if (p.pvcactuallessldnew !== undefined) setValues.pvcactuallessldnew = p.pvcactuallessldnew;
            if (p.pvccontractuallessldnew !== undefined) setValues.pvccontractuallessldnew = p.pvccontractuallessldnew;
            if (p.loweractuallessld !== undefined) setValues.loweractuallessld = p.loweractuallessld;
            if (p.lowercontractuallessld !== undefined) setValues.lowercontractuallessld = p.lowercontractuallessld;
            if (p.delaydays !== undefined) setValues.delaydays = p.delaydays;
            if (p.ldweeksnew !== undefined) setValues.ldweeksnew = p.ldweeksnew;
            if (p.ldratepctnew !== undefined) setValues.ldratepctnew = p.ldratepctnew;
            if (p.ldapplicable !== undefined) setValues.ldapplicable = p.ldapplicable;
            if (p.pvcperseta2 !== undefined) setValues.pvcperseta2 = p.pvcperseta2;
            if (p.pvcpersetb2 !== undefined) setValues.pvcpersetb2 = p.pvcpersetb2;
            if (p.pvcpersetc1 !== undefined) setValues.pvcpersetc1 = p.pvcpersetc1;
            if (p.pvcpersetd1 !== undefined) setValues.pvcpersetd1 = p.pvcpersetd1;
            if (p.tenderno !== undefined) setValues.tenderno = p.tenderno;
            if (p.pono !== undefined) setValues.pono = p.pono;
            if (p.scenarioamounts_json !== undefined) setValues.scenarioamountsJson = p.scenarioamounts_json;
            if (p.scenariodetails_json !== undefined) setValues.scenariodetailsJson = p.scenariodetails_json;
            if (p.igbt_vendor_details_json !== undefined) setValues.igbtVendorDetailsJson = p.igbt_vendor_details_json;
            if (Object.keys(setValues).length > 0) {
              await tx.update(pvcResults).set(setValues).where(eq(pvcResults.id, op.id));
            }
            break;
          }
          case 'insert_audit_log': {
            const l = op.record;
            const mappedUserId = l.user_id != null ? (userIdMap.get(l.user_id) ?? l.user_id) : null;
            await tx.insert(auditLogs).values({
              userId: mappedUserId,
              action: l.action,
              tableName: l.table_name,
              rowId: l.row_id,
              oldData: l.old_data,
              newData: l.new_data,
              timestamp: l.timestamp,
            });
            break;
          }
        }
      }
    });
  } catch (error) {
    console.error('Database transaction commit failed:', error);
    throw new Error('Failed to save changes to the database. Please try again.', { cause: error });
  }
}
