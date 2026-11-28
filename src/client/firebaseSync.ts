import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

// ── Startup Connection Validation ─────────────────────────────────────────
async function testConnection(): Promise<void> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
void testConnection();

// ── Structured Firestore Error Handler ────────────────────────────────────
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// ── Helpers & Blueprint-Synchronized Sanitizers ───────────────────────────
function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = val === null || val === undefined ? fallback : String(val);
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

function clampNum(val: unknown, min: number, max: number, fallback = 0): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeNum(val: unknown, fallback = 0): number {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
  if (raw && typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string' || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sanitizeNumberMap(raw: unknown): Record<string, number> {
  const parsed = parseJsonSafe<Record<string, unknown>>(raw, {});
  const out: Record<string, number> = {};
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      const key = String(k || '').trim().slice(0, 64);
      const n = Number(v);
      if (key && Number.isFinite(n)) {
        out[key] = n;
      }
    }
  }
  return out;
}

function sanitizeObjectList(raw: unknown, maxItems: number): Array<Record<string, unknown>> {
  const parsed = parseJsonSafe<unknown[]>(raw, []);
  if (!Array.isArray(parsed)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const entry of parsed.slice(0, maxItems)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
        if (v !== undefined) clean[k] = v;
      }
      out.push(clean);
    }
  }
  return out;
}

function safeUidSlug(uid: string): string {
  return uid.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
}

function makeItemDocId(uid: string, numericId: number): string {
  return `u_${safeUidSlug(uid)}_item_${numericId}`;
}

function makeIndexDocId(uid: string, itemId: number, month: string): string {
  const slug = String(month || '').slice(0, 7).replace(/[^0-9]/g, '_');
  return `u_${safeUidSlug(uid)}_idx_${itemId}_${slug}`;
}

function makeTenderDocId(uid: string, numericId: number): string {
  return `u_${safeUidSlug(uid)}_tnd_${numericId}`;
}

function makeVendorDocId(uid: string, numericId: number): string {
  return `u_${safeUidSlug(uid)}_vnd_${numericId}`;
}

function makeResultDocId(uid: string, numericId: number): string {
  return `u_${safeUidSlug(uid)}_res_${numericId}`;
}

function stableEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => stableEquals(v, b[i]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA).filter((k) => k !== 'createdAt' && k !== 'updatedAt');
  const keysB = Object.keys(objB).filter((k) => k !== 'createdAt' && k !== 'updatedAt');
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => stableEquals(objA[k], objB[k]));
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = sessionStorage.getItem('pvc_fallback_token') || '';
    if (token) headers['x-pvc-auth'] = token;
  } catch {
    // ignore storage restriction
  }
  return headers;
}

interface SyncSnapshotResponse {
  ok: boolean;
  bootId?: string;
  revision: number;
  hydratedFromCloud: boolean;
  cloudOwnerUid: string | null;
  items: Array<Record<string, unknown>>;
  itemIndices: Array<Record<string, unknown>>;
  tenders: Array<Record<string, unknown>>;
  tenderVendors: Array<Record<string, unknown>>;
  pvcResults: Array<Record<string, unknown>>;
}

interface BatchWriteItem {
  col: string;
  id: string;
  data?: Record<string, unknown>;
  op: 'set' | 'delete';
}

// Firestore enforces a hard limit of 20 get()/exists() security-rule evaluations
// per writeBatch. Child collections (item_indices, tenders, tender_vendors,
// pvc_results) perform 2 parent lookups per create, so chunk size 8 guarantees
// at most 16 lookups per batch while staying fast via bounded concurrency.
const ROOT_BATCH_CHUNK_SIZE = 200;
const CHILD_BATCH_CHUNK_SIZE = 8;
const BATCH_CONCURRENCY = 4;

async function commitInChunks(
  ops: BatchWriteItem[],
  chunkSize: number = CHILD_BATCH_CHUNK_SIZE,
  onChunkDone?: (count: number) => void
): Promise<void> {
  if (ops.length === 0) return;

  const chunks: BatchWriteItem[][] = [];
  for (let i = 0; i < ops.length; i += chunkSize) {
    chunks.push(ops.slice(i, i + chunkSize));
  }

  let nextIdx = 0;
  const workerCount = Math.min(BATCH_CONCURRENCY, chunks.length);

  const runWorker = async (): Promise<void> => {
    while (nextIdx < chunks.length) {
      const idx = nextIdx++;
      const slice = chunks[idx];
      const batch = writeBatch(db);
      for (const item of slice) {
        const ref = doc(db, item.col, item.id);
        if (item.op === 'delete') {
          batch.delete(ref);
        } else if (item.data) {
          batch.set(ref, item.data);
        }
      }
      try {
        await batch.commit();
        if (onChunkDone) onChunkDone(slice.length);
      } catch (error) {
        const firstPath = slice[0] ? `${slice[0].col}/${slice[0].id}` : null;
        const opType = slice[0]?.op === 'delete' ? OperationType.DELETE : OperationType.WRITE;
        handleFirestoreError(error, opType, firstPath);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}

async function fetchOwnedCollection(colName: string, uid: string): Promise<Map<string, DocumentData>> {
  const out = new Map<string, DocumentData>();
  try {
    const q = query(collection(db, colName), where('ownerId', '==', uid));
    const snap = await getDocs(q);
    snap.forEach((d) => {
      out.set(d.id, d.data());
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, colName);
  }
  return out;
}

function buildItemFirestoreDoc(uid: string, raw: Record<string, unknown>, existing?: DocumentData): Record<string, unknown> {
  const numericId = Math.max(1, Math.floor(safeNum(raw.id, 1)));
  return {
    numericId,
    name: clampStr(raw.name, 200, `Item ${numericId}`) || `Item ${numericId}`,
    code: clampStr(raw.code, 80, ''),
    description: clampStr(raw.description, 1000, ''),
    pvc_formula_code: clampStr(raw.pvc_formula_code, 80, 'IEEMA_WEIGHTED') || 'IEEMA_WEIGHTED',
    weights: sanitizeNumberMap(raw.weights_json ?? raw.weights),
    components: sanitizeObjectList(raw.components_json ?? raw.components, 50),
    extra_fields: sanitizeObjectList(raw.extra_fields_json ?? raw.extra_fields, 50),
    lag_months: clampNum(raw.lag_months, 0, 24, 1),
    base_lag_months: clampNum(raw.base_lag_months, 0, 24, 0),
    fixed_weight: clampNum(raw.fixed_weight, 0, 100, 15),
    index_source: clampStr(raw.index_source, 200, 'IEEMA'),
    custom_formula: clampStr(raw.custom_formula, 500, ''),
    ownerId: uid,
    createdAt: existing?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function buildItemIndexFirestoreDoc(uid: string, raw: Record<string, unknown>, existing?: DocumentData): Record<string, unknown> | null {
  const numericId = Math.max(1, Math.floor(safeNum(raw.id, 1)));
  const itemId = Math.max(1, Math.floor(safeNum(raw.item_id, 0)));
  const month = clampStr(raw.month, 10, '');
  if (!itemId || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(month)) return null;
  return {
    numericId,
    item_id: itemId,
    itemDocId: makeItemDocId(uid, itemId),
    month,
    indices: sanitizeNumberMap(raw.indices_json ?? raw.indices),
    ownerId: uid,
    createdAt: existing?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function buildTenderFirestoreDoc(uid: string, raw: Record<string, unknown>, existing?: DocumentData): Record<string, unknown> | null {
  const numericId = Math.max(1, Math.floor(safeNum(raw.id, 1)));
  const itemId = Math.max(1, Math.floor(safeNum(raw.item_id, 0)));
  const tenderNo = clampStr(raw.tender_no, 120, '').trim();
  if (!itemId || !tenderNo) return null;
  return {
    numericId,
    item_id: itemId,
    itemDocId: makeItemDocId(uid, itemId),
    tender_no: tenderNo,
    basicrate: Math.max(0, safeNum(raw.basicrate, 0)),
    pvcbasedate: clampStr(raw.pvcbasedate, 20, ''),
    freightrateperunit: Math.max(0, safeNum(raw.freightrateperunit, 0)),
    gst_rate: clampNum(raw.gst_rate, 0, 100, 18),
    ownerId: uid,
    createdAt: existing?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function buildVendorFirestoreDoc(uid: string, raw: Record<string, unknown>, existing?: DocumentData): Record<string, unknown> | null {
  const numericId = Math.max(1, Math.floor(safeNum(raw.id, 1)));
  const tenderId = Math.max(1, Math.floor(safeNum(raw.tender_id, 0)));
  const vendorName = clampStr(raw.vendor_name, 200, '').trim();
  if (!tenderId || !vendorName) return null;
  return {
    numericId,
    tender_id: tenderId,
    tenderDocId: makeTenderDocId(uid, tenderId),
    po_no: clampStr(raw.po_no, 120, ''),
    vendor_name: vendorName,
    cif: Math.max(0, safeNum(raw.cif, 0)),
    freightrateperunit: Math.max(0, safeNum(raw.freightrateperunit, 0)),
    currency: clampStr(raw.currency, 16, 'INR').trim() || 'INR',
    ownerId: uid,
    createdAt: existing?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function buildResultFirestoreDoc(uid: string, raw: Record<string, unknown>, existing?: DocumentData): Record<string, unknown> | null {
  const numericId = Math.max(1, Math.floor(safeNum(raw.id, 1)));
  const itemId = Math.max(1, Math.floor(safeNum(raw.item_id, 0)));
  if (!itemId) return null;
  return {
    numericId,
    item_id: itemId,
    itemDocId: makeItemDocId(uid, itemId),
    username: clampStr(raw.username, 100, ''),
    basicrate: safeNum(raw.basicrate, 0),
    quantity: safeNum(raw.quantity, 0),
    freightrateperunit: safeNum(raw.freightrateperunit, 0),
    pvcbasedate: clampStr(raw.pvcbasedate, 20, ''),
    origdp: clampStr(raw.origdp, 20, ''),
    refixeddp: clampStr(raw.refixeddp, 20, ''),
    extendeddp: clampStr(raw.extendeddp, 20, ''),
    caldate: clampStr(raw.caldate, 20, ''),
    supdate: clampStr(raw.supdate, 20, ''),
    rateapplied: clampStr(raw.rateapplied, 160, ''),
    pvcactual: safeNum(raw.pvcactual, 0),
    pvccontractual: safeNum(raw.pvccontractual, 0),
    loweractual: safeNum(raw.loweractual, 0),
    lowercontractual: safeNum(raw.lowercontractual, 0),
    ldamtactual: safeNum(raw.ldamtactual, 0),
    ldamtcontractual: safeNum(raw.ldamtcontractual, 0),
    fairprice: safeNum(raw.fairprice, 0),
    selectedscenario: clampStr(raw.selectedscenario, 40, ''),
    pvcactuallessldnew: safeNum(raw.pvcactuallessldnew, 0),
    pvccontractuallessldnew: safeNum(raw.pvccontractuallessldnew, 0),
    loweractuallessld: safeNum(raw.loweractuallessld, 0),
    lowercontractuallessld: safeNum(raw.lowercontractuallessld, 0),
    delaydays: safeNum(raw.delaydays, 0),
    ldweeksnew: safeNum(raw.ldweeksnew, 0),
    ldratepctnew: safeNum(raw.ldratepctnew, 0),
    ldapplicable: Boolean(raw.ldapplicable),
    pvcperseta2: safeNum(raw.pvcperseta2, 0),
    pvcpersetb2: safeNum(raw.pvcpersetb2, 0),
    pvcpersetc1: safeNum(raw.pvcpersetc1, 0),
    pvcpersetd1: safeNum(raw.pvcpersetd1, 0),
    tenderno: clampStr(raw.tenderno, 120, ''),
    pono: clampStr(raw.pono, 120, ''),
    scenarioamounts: sanitizeNumberMap(raw.scenarioamounts_json ?? raw.scenarioamounts),
    scenariodetails: sanitizeObjectList(raw.scenariodetails_json ?? raw.scenariodetails, 20),
    igbt_vendor_details: sanitizeObjectList(raw.igbt_vendor_details_json ?? raw.igbt_vendor_details, 50),
    ownerId: uid,
    createdAt: existing?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function firestoreToServerRecords(
  itemsMap: Map<string, DocumentData>,
  indicesMap: Map<string, DocumentData>,
  tendersMap: Map<string, DocumentData>,
  vendorsMap: Map<string, DocumentData>,
  resultsMap: Map<string, DocumentData>
) {
  const items = Array.from(itemsMap.values()).map((d) => ({
    id: safeNum(d.numericId, 1),
    name: String(d.name || ''),
    code: d.code ? String(d.code) : null,
    description: d.description ? String(d.description) : null,
    pvc_formula_code: String(d.pvc_formula_code || 'IEEMA_WEIGHTED'),
    weights_json: JSON.stringify(d.weights || {}),
    extra_fields_json: JSON.stringify(d.extra_fields || []),
    lag_months: safeNum(d.lag_months, 1),
    base_lag_months: safeNum(d.base_lag_months, 0),
    fixed_weight: safeNum(d.fixed_weight, 15),
    index_source: d.index_source ? String(d.index_source) : 'IEEMA',
    components_json: JSON.stringify(d.components || []),
    custom_formula: d.custom_formula ? String(d.custom_formula) : null,
  }));

  const itemIndices = Array.from(indicesMap.values()).map((d) => ({
    id: safeNum(d.numericId, 1),
    item_id: safeNum(d.item_id, 1),
    month: String(d.month || ''),
    indices_json: JSON.stringify(d.indices || {}),
    attachments: [],
  }));

  const tenders = Array.from(tendersMap.values()).map((d) => ({
    id: safeNum(d.numericId, 1),
    item_id: safeNum(d.item_id, 1),
    tender_no: String(d.tender_no || ''),
    basicrate: safeNum(d.basicrate, 0),
    pvcbasedate: d.pvcbasedate ? String(d.pvcbasedate) : null,
    freightrateperunit: safeNum(d.freightrateperunit, 0),
    gst_rate: safeNum(d.gst_rate, 18),
    created_at:
      d.createdAt && typeof d.createdAt.toDate === 'function'
        ? d.createdAt.toDate().toISOString()
        : new Date().toISOString(),
  }));

  const tenderVendors = Array.from(vendorsMap.values()).map((d) => ({
    id: safeNum(d.numericId, 1),
    tender_id: safeNum(d.tender_id, 1),
    po_no: d.po_no ? String(d.po_no) : null,
    vendor_name: String(d.vendor_name || ''),
    cif: safeNum(d.cif, 0),
    freightrateperunit: safeNum(d.freightrateperunit, 0),
    currency: String(d.currency || 'INR'),
  }));

  const pvcResults = Array.from(resultsMap.values()).map((d) => ({
    id: safeNum(d.numericId, 1),
    user_id: 0,
    item_id: safeNum(d.item_id, 1),
    username: String(d.username || ''),
    created_at:
      d.createdAt && typeof d.createdAt.toDate === 'function'
        ? d.createdAt.toDate().toISOString()
        : new Date().toISOString(),
    basicrate: safeNum(d.basicrate, 0),
    quantity: safeNum(d.quantity, 0),
    freightrateperunit: safeNum(d.freightrateperunit, 0),
    pvcbasedate: d.pvcbasedate ? String(d.pvcbasedate) : null,
    origdp: d.origdp ? String(d.origdp) : null,
    refixeddp: d.refixeddp ? String(d.refixeddp) : null,
    extendeddp: d.extendeddp ? String(d.extendeddp) : null,
    caldate: d.caldate ? String(d.caldate) : null,
    supdate: d.supdate ? String(d.supdate) : null,
    rateapplied: d.rateapplied ? String(d.rateapplied) : null,
    pvcactual: safeNum(d.pvcactual, 0),
    pvccontractual: safeNum(d.pvccontractual, 0),
    loweractual: safeNum(d.loweractual, 0),
    lowercontractual: safeNum(d.lowercontractual, 0),
    ldamtactual: safeNum(d.ldamtactual, 0),
    ldamtcontractual: safeNum(d.ldamtcontractual, 0),
    fairprice: safeNum(d.fairprice, 0),
    selectedscenario: d.selectedscenario ? String(d.selectedscenario) : null,
    pvcactuallessldnew: safeNum(d.pvcactuallessldnew, 0),
    pvccontractuallessldnew: safeNum(d.pvccontractuallessldnew, 0),
    loweractuallessld: safeNum(d.loweractuallessld, 0),
    lowercontractuallessld: safeNum(d.lowercontractuallessld, 0),
    delaydays: safeNum(d.delaydays, 0),
    ldweeksnew: safeNum(d.ldweeksnew, 0),
    ldratepctnew: safeNum(d.ldratepctnew, 0),
    ldapplicable: Boolean(d.ldapplicable),
    pvcperseta2: safeNum(d.pvcperseta2, 0),
    pvcpersetb2: safeNum(d.pvcpersetb2, 0),
    pvcpersetc1: safeNum(d.pvcpersetc1, 0),
    pvcpersetd1: safeNum(d.pvcpersetd1, 0),
    tenderno: d.tenderno ? String(d.tenderno) : null,
    pono: d.pono ? String(d.pono) : null,
    scenarioamounts_json: JSON.stringify(d.scenarioamounts || {}),
    scenariodetails_json: JSON.stringify(d.scenariodetails || []),
    igbt_vendor_details_json: JSON.stringify(d.igbt_vendor_details || []),
  }));

  return { items, itemIndices, tenders, tenderVendors, pvcResults };
}

async function pushSnapshotToFirestore(
  uid: string,
  snapshot: SyncSnapshotResponse,
  existingItems: Map<string, DocumentData>,
  existingIndices: Map<string, DocumentData>,
  existingTenders: Map<string, DocumentData>,
  existingVendors: Map<string, DocumentData>,
  existingResults: Map<string, DocumentData>,
  existingMeta: DocumentData | undefined,
  targetRevision: number,
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  // Stage 1: Upsert Items first (parents of item_indices, tenders, pvc_results)
  const itemOps: BatchWriteItem[] = [];
  const nextItemIds = new Set<string>();
  const validItemNumericIds = new Set<number>();
  for (const raw of snapshot.items) {
    const idNum = Math.max(1, Math.floor(safeNum(raw.id, 0)));
    if (!idNum) continue;
    validItemNumericIds.add(idNum);
    const docId = makeItemDocId(uid, idNum);
    nextItemIds.add(docId);
    const existing = existingItems.get(docId);
    const payload = buildItemFirestoreDoc(uid, raw, existing);
    if (!existing || !stableEquals(payload, existing)) {
      itemOps.push({ col: 'items', id: docId, data: payload, op: 'set' });
    }
  }

  // Stage 2: Upsert ItemIndices, Tenders, and PVCResults
  const stage2Ops: BatchWriteItem[] = [];
  const nextIndexIds = new Set<string>();
  for (const raw of snapshot.itemIndices) {
    const itemId = Math.max(1, Math.floor(safeNum(raw.item_id, 0)));
    if (!validItemNumericIds.has(itemId)) continue;
    const month = clampStr(raw.month, 10, '');
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(month)) continue;
    const docId = makeIndexDocId(uid, itemId, month);
    nextIndexIds.add(docId);
    const existing = existingIndices.get(docId);
    const payload = buildItemIndexFirestoreDoc(uid, raw, existing);
    if (payload && (!existing || !stableEquals(payload, existing))) {
      stage2Ops.push({ col: 'item_indices', id: docId, data: payload, op: 'set' });
    }
  }

  const nextTenderIds = new Set<string>();
  const validTenderNumericIds = new Set<number>();
  for (const raw of snapshot.tenders) {
    const itemId = Math.max(1, Math.floor(safeNum(raw.item_id, 0)));
    const idNum = Math.max(1, Math.floor(safeNum(raw.id, 0)));
    if (!idNum || !validItemNumericIds.has(itemId)) continue;
    validTenderNumericIds.add(idNum);
    const docId = makeTenderDocId(uid, idNum);
    nextTenderIds.add(docId);
    const existing = existingTenders.get(docId);
    const payload = buildTenderFirestoreDoc(uid, raw, existing);
    if (payload && (!existing || !stableEquals(payload, existing))) {
      stage2Ops.push({ col: 'tenders', id: docId, data: payload, op: 'set' });
    }
  }

  const nextResultIds = new Set<string>();
  for (const raw of snapshot.pvcResults) {
    const itemId = Math.max(1, Math.floor(safeNum(raw.item_id, 0)));
    const idNum = Math.max(1, Math.floor(safeNum(raw.id, 0)));
    if (!idNum || !validItemNumericIds.has(itemId)) continue;
    const docId = makeResultDocId(uid, idNum);
    nextResultIds.add(docId);
    const existing = existingResults.get(docId);
    const payload = buildResultFirestoreDoc(uid, raw, existing);
    if (payload && (!existing || !stableEquals(payload, existing))) {
      stage2Ops.push({ col: 'pvc_results', id: docId, data: payload, op: 'set' });
    }
  }

  // Stage 3: Upsert TenderVendors (children of Tenders)
  const vendorOps: BatchWriteItem[] = [];
  const nextVendorIds = new Set<string>();
  for (const raw of snapshot.tenderVendors) {
    const tenderId = Math.max(1, Math.floor(safeNum(raw.tender_id, 0)));
    const idNum = Math.max(1, Math.floor(safeNum(raw.id, 0)));
    if (!idNum || !validTenderNumericIds.has(tenderId)) continue;
    const docId = makeVendorDocId(uid, idNum);
    nextVendorIds.add(docId);
    const existing = existingVendors.get(docId);
    const payload = buildVendorFirestoreDoc(uid, raw, existing);
    if (payload && (!existing || !stableEquals(payload, existing))) {
      vendorOps.push({ col: 'tender_vendors', id: docId, data: payload, op: 'set' });
    }
  }

  // Stage 4: Delete removed documents (children first, then parents)
  const deleteChildOps: BatchWriteItem[] = [];
  for (const oldId of existingVendors.keys()) {
    if (!nextVendorIds.has(oldId)) deleteChildOps.push({ col: 'tender_vendors', id: oldId, op: 'delete' });
  }
  for (const oldId of existingIndices.keys()) {
    if (!nextIndexIds.has(oldId)) deleteChildOps.push({ col: 'item_indices', id: oldId, op: 'delete' });
  }
  for (const oldId of existingResults.keys()) {
    if (!nextResultIds.has(oldId)) deleteChildOps.push({ col: 'pvc_results', id: oldId, op: 'delete' });
  }

  const deleteTenderOps: BatchWriteItem[] = [];
  for (const oldId of existingTenders.keys()) {
    if (!nextTenderIds.has(oldId)) deleteTenderOps.push({ col: 'tenders', id: oldId, op: 'delete' });
  }

  const deleteItemOps: BatchWriteItem[] = [];
  for (const oldId of existingItems.keys()) {
    if (!nextItemIds.has(oldId)) deleteItemOps.push({ col: 'items', id: oldId, op: 'delete' });
  }

  const totalOps =
    itemOps.length +
    stage2Ops.length +
    vendorOps.length +
    deleteChildOps.length +
    deleteTenderOps.length +
    deleteItemOps.length +
    1;
  let completedOps = 0;
  const reportChunk = (count: number): void => {
    completedOps += count;
    if (onProgress) onProgress(Math.min(completedOps, totalOps), totalOps);
  };
  if (onProgress) onProgress(0, totalOps);

  if (itemOps.length > 0) await commitInChunks(itemOps, ROOT_BATCH_CHUNK_SIZE, reportChunk);
  if (stage2Ops.length > 0) await commitInChunks(stage2Ops, CHILD_BATCH_CHUNK_SIZE, reportChunk);
  if (vendorOps.length > 0) await commitInChunks(vendorOps, CHILD_BATCH_CHUNK_SIZE, reportChunk);
  if (deleteChildOps.length > 0) await commitInChunks(deleteChildOps, CHILD_BATCH_CHUNK_SIZE, reportChunk);
  if (deleteTenderOps.length > 0) await commitInChunks(deleteTenderOps, CHILD_BATCH_CHUNK_SIZE, reportChunk);
  if (deleteItemOps.length > 0) await commitInChunks(deleteItemOps, ROOT_BATCH_CHUNK_SIZE, reportChunk);

  // Stage 5: Update workspace_meta/{uid}
  const metaPayload: Record<string, unknown> = {
    ownerId: uid,
    revision: Math.max(1, targetRevision),
    seeded: true,
    createdAt: existingMeta?.createdAt ?? serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await commitInChunks([{ col: 'workspace_meta', id: uid, data: metaPayload, op: 'set' }], 1, reportChunk);
}

// ── Clean Alert / Active Bulk-Commit Feedback (Idle = Zero UI Noise) ──────
function ensureCloudAlertContainer(): HTMLElement | null {
  let container = document.getElementById('pvcCloudAlertHost');
  if (container) return container;
  const mainContainer = document.querySelector('main .container-xl');
  if (!mainContainer) return null;
  container = document.createElement('div');
  container.id = 'pvcCloudAlertHost';
  container.className = 'mb-3 d-print-none';
  mainContainer.prepend(container);
  return container;
}

function showCloudAlert(message: string, variant: 'danger' | 'warning' | 'info' | 'success' = 'danger', dismissible = true): void {
  const host = ensureCloudAlertContainer();
  if (!host) return;
  host.innerHTML = '';
  const alertEl = document.createElement('div');
  alertEl.className = `alert alert-${variant}${dismissible ? ' alert-dismissible' : ''} fade show d-flex align-items-center gap-2 mb-0`;
  alertEl.setAttribute('role', 'alert');

  if (variant === 'info' && !dismissible) {
    const spinner = document.createElement('span');
    spinner.className = 'spinner-border spinner-border-sm flex-shrink-0';
    spinner.setAttribute('aria-hidden', 'true');
    alertEl.appendChild(spinner);
  }

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  alertEl.appendChild(textSpan);

  if (dismissible) {
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'btn-close ms-auto';
    closeBtn.setAttribute('data-bs-dismiss', 'alert');
    closeBtn.setAttribute('aria-label', 'Close');
    alertEl.appendChild(closeBtn);
  }

  host.appendChild(alertEl);
}

function clearCloudAlert(): void {
  const host = document.getElementById('pvcCloudAlertHost');
  if (host) host.innerHTML = '';
}

function formatSyncError(err: unknown): string {
  if (err instanceof Error) {
    try {
      const parsed = JSON.parse(err.message) as { error?: string; path?: string };
      if (parsed && parsed.error) {
        return `Cloud database sync failed (${parsed.path || 'Firestore'}): ${parsed.error}`;
      }
    } catch {
      // plain Error message
    }
    return `Cloud database sync failed: ${err.message}`;
  }
  return 'Cloud database sync failed. Please check your connection and try again.';
}

let syncInFlight = false;
let activeSyncPromise: Promise<void> | null = null;
let bulkSubmitInProgress = false;

window.addEventListener('beforeunload', (e) => {
  if (syncInFlight) {
    e.preventDefault();
    e.returnValue = '';
  }
});

interface SyncOptions {
  forcePush?: boolean;
  rethrow?: boolean;
  onProgress?: (done: number, total: number) => void;
}

async function syncWithFirestore(user: User, reloadIfHydrated = true, options: SyncOptions = {}): Promise<void> {
  if (!user || !user.emailVerified) return;

  // If a background sync is already in progress when an explicit bulk save runs,
  // wait for it to finish rather than dropping the bulk save sync.
  if (activeSyncPromise) {
    if (!options.forcePush) return;
    try {
      await activeSyncPromise;
    } catch {
      // continue with explicit forcePush
    }
  }

  const run = async (): Promise<void> => {
    syncInFlight = true;
    try {
      const snapResp = await fetch('/api/sync/snapshot', {
        method: 'GET',
        credentials: 'same-origin',
        headers: getAuthHeaders(),
      });
      if (!snapResp.ok) {
        if (options.rethrow) {
          throw new Error('Could not read workspace snapshot from server.');
        }
        return;
      }
      const snapshot = (await snapResp.json()) as SyncSnapshotResponse;
      if (!snapshot.ok) return;

      const uid = user.uid;
      const metaRef = doc(db, 'workspace_meta', uid);
      let metaSnap;
      try {
        metaSnap = await getDoc(metaRef);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `workspace_meta/${uid}`);
      }

      const metaExists = Boolean(metaSnap && metaSnap.exists());
      const metaData = metaExists ? metaSnap.data() : undefined;
      const cloudRevision = safeNum(metaData?.revision, 0);

      const [existingItems, existingIndices, existingTenders, existingVendors, existingResults] = await Promise.all([
        fetchOwnedCollection('items', uid),
        fetchOwnedCollection('item_indices', uid),
        fetchOwnedCollection('tenders', uid),
        fetchOwnedCollection('tender_vendors', uid),
        fetchOwnedCollection('pvc_results', uid),
      ]);

      if (!metaExists || !metaData?.seeded) {
        // First-time Firestore persistence: push current workspace to Firestore
        const targetRev = Math.max(1, snapshot.revision);
        await pushSnapshotToFirestore(
          uid,
          snapshot,
          existingItems,
          existingIndices,
          existingTenders,
          existingVendors,
          existingResults,
          metaData,
          targetRev,
          options.onProgress
        );
        await fetch('/api/sync/mark-synced', {
          method: 'POST',
          credentials: 'same-origin',
          headers: getAuthHeaders(),
          body: JSON.stringify({ ownerUid: uid, revision: targetRev }),
        });
        return;
      }

      if (!snapshot.hydratedFromCloud || snapshot.cloudOwnerUid !== uid) {
        // Fresh container / cold start: hydrate Express store from Firestore
        // (Store merges ONLY explicitly dirty user uploads onto cloud records, never untouched defaults)
        const serverPayload = firestoreToServerRecords(
          existingItems,
          existingIndices,
          existingTenders,
          existingVendors,
          existingResults
        );
        const hydResp = await fetch('/api/sync/hydrate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: getAuthHeaders(),
          body: JSON.stringify({
            ownerUid: uid,
            revision: cloudRevision,
            ...serverPayload,
          }),
        });
        if (hydResp.ok) {
          const hydJson = (await hydResp.json()) as {
            ok: boolean;
            changed?: boolean;
            needsPushBack?: boolean;
            revision?: number;
          };
          if (hydJson.needsPushBack || options.forcePush) {
            const freshResp = await fetch('/api/sync/snapshot', {
              method: 'GET',
              credentials: 'same-origin',
              headers: getAuthHeaders(),
            });
            if (freshResp.ok) {
              const freshSnap = (await freshResp.json()) as SyncSnapshotResponse;
              const targetRev = Math.max(cloudRevision + 1, freshSnap.revision);
              await pushSnapshotToFirestore(
                uid,
                freshSnap,
                existingItems,
                existingIndices,
                existingTenders,
                existingVendors,
                existingResults,
                metaData,
                targetRev,
                options.onProgress
              );
              await fetch('/api/sync/mark-synced', {
                method: 'POST',
                credentials: 'same-origin',
                headers: getAuthHeaders(),
                body: JSON.stringify({ ownerUid: uid, revision: targetRev }),
              });
            }
          }
          if (reloadIfHydrated && hydJson.changed && !bulkSubmitInProgress) {
            const bootKey = snapshot.bootId || 'default';
            const guardKey = `pvc_hydrated_${bootKey}_${uid}`;
            try {
              if (!sessionStorage.getItem(guardKey)) {
                sessionStorage.setItem(guardKey, '1');
                window.location.reload();
              }
            } catch {
              window.location.reload();
            }
          }
        }
        return;
      }

      // Active hydrated session: push diff to Firestore if any mutation occurred or forcePush requested
      if (snapshot.revision > cloudRevision || options.forcePush) {
        const targetRev = Math.max(snapshot.revision, cloudRevision + 1);
        await pushSnapshotToFirestore(
          uid,
          snapshot,
          existingItems,
          existingIndices,
          existingTenders,
          existingVendors,
          existingResults,
          metaData,
          targetRev,
          options.onProgress
        );
        await fetch('/api/sync/mark-synced', {
          method: 'POST',
          credentials: 'same-origin',
          headers: getAuthHeaders(),
          body: JSON.stringify({ ownerUid: uid, revision: targetRev }),
        });
      }
    } catch (err) {
      console.error('[PVC Cloud Sync]', err);
      showCloudAlert(formatSyncError(err), 'danger', true);
      if (options.rethrow) throw err;
    } finally {
      syncInFlight = false;
      activeSyncPromise = null;
    }
  };

  activeSyncPromise = run();
  return activeSyncPromise;
}

function updateConnectButtonVisibility(user: User | null): void {
  const isConnected = Boolean(user && user.emailVerified);
  const connectBtn = document.getElementById('btnConnectCloudDb');
  if (connectBtn) {
    connectBtn.classList.toggle('d-none', isConnected);
  }
  const noticeEl = document.getElementById('cloudAuthRequiredNotice');
  if (noticeEl) {
    noticeEl.classList.toggle('d-none', isConnected);
  }
}

function appendFallbackTokenIfNeeded(targetUrl: string): string {
  if (document.cookie.indexOf('pvc_ck=1') !== -1) return targetUrl;
  try {
    const token = sessionStorage.getItem('pvc_fallback_token') || '';
    if (!token) return targetUrl;
    const u = new URL(targetUrl, window.location.origin);
    u.searchParams.set('_t', token);
    return u.pathname + u.search + u.hash;
  } catch {
    return targetUrl;
  }
}

async function ensureCloudSignedIn(): Promise<User> {
  if (auth.currentUser && auth.currentUser.emailVerified) {
    return auth.currentUser;
  }
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  if (!cred.user || !cred.user.emailVerified) {
    throw new Error('A verified Google account is required to store data in the Cloud Database.');
  }
  updateConnectButtonVisibility(cred.user);
  return cred.user;
}

async function googleSignInFlow(nextUrl = '/'): Promise<void> {
  const errEl = document.getElementById('googleAuthError');
  const btnEl = document.getElementById('btnGoogleSignIn') as HTMLButtonElement | null;
  if (errEl) {
    errEl.classList.add('d-none');
    errEl.textContent = '';
  }
  if (btnEl) btnEl.disabled = true;

  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    const idToken = await cred.user.getIdToken();

    const resp = await fetch('/auth/google', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, next: nextUrl }),
    });
    const data = (await resp.json()) as {
      ok?: boolean;
      error?: string;
      redirectUrl?: string;
      fallbackToken?: string;
    };
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || 'Google sign-in failed.');
    }

    const hasCookie = document.cookie.indexOf('pvc_ck=1') !== -1;
    if (!hasCookie && data.fallbackToken) {
      try {
        sessionStorage.setItem('pvc_fallback_token', data.fallbackToken);
      } catch {
        // ignore
      }
    }

    // Hydrate cloud database before landing on dashboard
    await syncWithFirestore(cred.user, false);

    let target = data.redirectUrl || '/';
    if (!hasCookie && data.fallbackToken) {
      const sep = target.includes('?') ? '&' : '?';
      target = `${target}${sep}_t=${encodeURIComponent(data.fallbackToken)}`;
    }
    window.location.replace(target);
  } catch (err) {
    if (errEl) {
      errEl.textContent = err instanceof Error ? err.message : 'Google sign-in failed.';
      errEl.classList.remove('d-none');
    }
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

async function connectCloudDbFlow(): Promise<void> {
  const btns = Array.from(document.querySelectorAll('#btnConnectCloudDb, [data-connect-cloud-db="1"]')) as HTMLButtonElement[];
  btns.forEach((b) => {
    b.disabled = true;
  });
  try {
    clearCloudAlert();
    const user = await ensureCloudSignedIn();
    showCloudAlert('Synchronizing with Cloud Database…', 'info', false);
    await syncWithFirestore(user, true, { rethrow: true });
    clearCloudAlert();
  } catch (err) {
    console.error('[PVC Connect Cloud DB]', err);
    showCloudAlert(formatSyncError(err), 'danger', true);
  } finally {
    btns.forEach((b) => {
      b.disabled = false;
    });
  }
}

async function firebaseSignOutFlow(logoutHref: string): Promise<void> {
  try {
    await signOut(auth);
  } catch {
    // ignore
  }
  window.location.href = logoutHref;
}

function attachBulkCloudSyncInterceptor(): void {
  // Bubble-phase document listener runs strictly AFTER form-level submit listeners
  // that serialize spreadsheet grid / multi-item hidden JSON inputs.
  document.addEventListener('submit', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (target.getAttribute('data-cloud-sync-form') !== '1') return;

    e.preventDefault();

    const submitButtons = Array.from(target.querySelectorAll('button[type="submit"], input[type="submit"]')) as Array<
      HTMLButtonElement | HTMLInputElement
    >;
    const originalLabels = submitButtons.map((b) => (b instanceof HTMLButtonElement ? b.innerHTML : b.value));

    const setBusy = (busy: boolean): void => {
      submitButtons.forEach((b, idx) => {
        b.disabled = busy;
        if (b instanceof HTMLButtonElement) {
          b.innerHTML = busy
            ? '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Saving to Cloud…'
            : originalLabels[idx];
        }
      });
    };

    void (async () => {
      bulkSubmitInProgress = true;
      setBusy(true);
      clearCloudAlert();

      try {
        showCloudAlert('Verifying Cloud Database connection…', 'info', false);
        const user = await ensureCloudSignedIn();

        const actionUrl = target.getAttribute('action') || window.location.href;
        const isMultipart = (target.getAttribute('enctype') || '').toLowerCase().includes('multipart/form-data');

        const headers: Record<string, string> = { 'X-PVC-Ajax': '1' };
        try {
          const token = sessionStorage.getItem('pvc_fallback_token') || '';
          if (token) headers['x-pvc-auth'] = token;
        } catch {
          // ignore
        }

        let body: BodyInit;
        if (isMultipart) {
          body = new FormData(target);
        } else {
          const fd = new FormData(target);
          const params = new URLSearchParams();
          fd.forEach((val, key) => {
            if (typeof val === 'string') params.append(key, val);
          });
          headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
          body = params.toString();
        }

        showCloudAlert('Processing uploaded records…', 'info', false);
        const resp = await fetch(actionUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers,
          body,
        });

        let json: { ok?: boolean; error?: string; message?: string; redirectUrl?: string } = {};
        try {
          json = (await resp.json()) as typeof json;
        } catch {
          throw new Error(`Server returned HTTP ${resp.status} while processing bulk upload.`);
        }

        if (!resp.ok || !json.ok) {
          throw new Error(json.error || 'Bulk upload could not be processed.');
        }

        showCloudAlert('Saving uploaded data to Cloud Database…', 'info', false);
        await syncWithFirestore(user, false, {
          forcePush: true,
          rethrow: true,
          onProgress: (done, total) => {
            showCloudAlert(`Saving uploaded data to Cloud Database (${done} / ${total})…`, 'info', false);
          },
        });

        clearCloudAlert();
        bulkSubmitInProgress = false;
        const nextUrl = appendFallbackTokenIfNeeded(json.redirectUrl || window.location.href);
        window.location.assign(nextUrl);
      } catch (err) {
        console.error('[PVC Bulk Cloud Save]', err);
        showCloudAlert(
          err instanceof Error ? err.message : 'Failed to save bulk data to Cloud Database.',
          'danger',
          true
        );
        bulkSubmitInProgress = false;
        setBusy(false);
      }
    })();
  });
}

declare global {
  interface Window {
    pvcGoogleSignIn?: (nextUrl?: string) => Promise<void>;
    pvcConnectCloudDb?: () => Promise<void>;
    pvcFirebaseSignOut?: (logoutHref: string) => Promise<void>;
  }
}

window.pvcGoogleSignIn = googleSignInFlow;
window.pvcConnectCloudDb = connectCloudDbFlow;
window.pvcFirebaseSignOut = firebaseSignOutFlow;

document.addEventListener('DOMContentLoaded', () => {
  const isAuthenticatedPage = document.body.getAttribute('data-auth') === '1';

  const googleBtn = document.getElementById('btnGoogleSignIn');
  if (googleBtn) {
    googleBtn.addEventListener('click', () => {
      const params = new URLSearchParams(window.location.search);
      const nextUrl = params.get('next') || '/';
      void googleSignInFlow(nextUrl);
    });
  }

  document.querySelectorAll('#btnConnectCloudDb, [data-connect-cloud-db="1"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void connectCloudDbFlow();
    });
  });

  const logoutLink = document.getElementById('pvcLogoutLink');
  if (logoutLink) {
    logoutLink.addEventListener('click', (e) => {
      e.preventDefault();
      const href = logoutLink.getAttribute('href') || '/logout';
      void firebaseSignOutFlow(href);
    });
  }

  if (isAuthenticatedPage) {
    attachBulkCloudSyncInterceptor();
  }

  onAuthStateChanged(auth, (user) => {
    updateConnectButtonVisibility(user);
    if (isAuthenticatedPage && user && user.emailVerified && !bulkSubmitInProgress) {
      void syncWithFirestore(user, true);
    }
  });
});
