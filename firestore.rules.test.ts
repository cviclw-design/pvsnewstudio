/**
 * Security Rules Test Suite Specification (Phase 0 TDD — Dirty Dozen Payloads)
 * Intended for execution with @firebase/rules-unit-testing against Firestore emulator.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  collection: string;
  docId: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  auth: { uid: string; email?: string; email_verified?: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read on items',
    collection: 'items',
    docId: 'u_user1_item_1',
    operation: 'get',
    auth: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified admin email spoof write on items',
    collection: 'items',
    docId: 'u_spoof_item_1',
    operation: 'create',
    auth: { uid: 'spoof', email: 'cviclw@gmail.com', email_verified: false },
    payload: { numericId: 1, name: 'Spoof Item', ownerId: 'spoof' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Owner spoofing on item create',
    collection: 'items',
    docId: 'u_victim_item_1',
    operation: 'create',
    auth: { uid: 'attacker', email: 'attacker@example.com', email_verified: true },
    payload: { numericId: 1, name: 'Hijack', ownerId: 'victim' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Shadow field injection on item_indices',
    collection: 'item_indices',
    docId: 'u_user1_idx_1_2025_01',
    operation: 'create',
    auth: { uid: 'user1', email: 'user1@example.com', email_verified: true },
    payload: {
      numericId: 1,
      item_id: 1,
      itemDocId: 'u_user1_item_1',
      month: '2025-01-01',
      indices: { C: 800 },
      ownerId: 'user1',
      isAdmin: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Orphaned item_index write referencing non-existent itemDocId',
    collection: 'item_indices',
    docId: 'u_user1_idx_999_2025_01',
    operation: 'create',
    auth: { uid: 'user1', email: 'user1@example.com', email_verified: true },
    payload: {
      numericId: 999,
      item_id: 999,
      itemDocId: 'u_user1_item_999',
      month: '2025-01-01',
      indices: { C: 800 },
      ownerId: 'user1',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Cross-tenant parent reference on tender_vendors',
    collection: 'tender_vendors',
    docId: 'u_attacker_vnd_1',
    operation: 'create',
    auth: { uid: 'attacker', email: 'attacker@example.com', email_verified: true },
    payload: {
      numericId: 1,
      tender_id: 1,
      tenderDocId: 'u_victim_tnd_1',
      po_no: 'PO1',
      vendor_name: 'Bad Vendor',
      cif: 0,
      freightrateperunit: 0,
      currency: 'INR',
      ownerId: 'attacker',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'ID poisoning with invalid characters',
    collection: 'items',
    docId: 'bad$id!with@invalid#chars',
    operation: 'create',
    auth: { uid: 'user1', email: 'user1@example.com', email_verified: true },
    payload: { numericId: 1, name: 'Test', ownerId: 'user1' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Oversized string resource exhaustion on item name (> 200 chars)',
    collection: 'items',
    docId: 'u_user1_item_2',
    operation: 'create',
    auth: { uid: 'user1', email: 'user1@example.com', email_verified: true },
    payload: { numericId: 2, name: 'A'.repeat(250), ownerId: 'user1' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Array overflow attack on item components (> 50 entries)',
    collection: 'items',
    docId: 'u_user1_item_3',
    operation: 'create',
    auth: { uid: 'user1', email: 'user1@example.com', email_verified: true },
    payload: {
      numericId: 3,
      name: 'Overflow',
      components: Array.from({ length: 55 }, (_, i) => ({ key: `K${i}`, weight: 1 })),
      ownerId: 'user1',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Immutable ownerId tampering on update',
    collection: 'items',
    docId: 'u_user1_item_1',
    operation: 'update',
    auth: { uid: 'user1', email: 'user1@example.com', email_verified: true },
    payload: { ownerId: 'user2' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Client-forged timestamp on tender create',
    collection: 'tenders',
    docId: 'u_user1_tnd_1',
    operation: 'create',
    auth: { uid: 'user1', email: 'user1@example.com', email_verified: true },
    payload: {
      numericId: 1,
      item_id: 1,
      itemDocId: 'u_user1_item_1',
      tender_no: 'TND-1',
      basicrate: 1000,
      pvcbasedate: '2025-01-01',
      freightrateperunit: 0,
      gst_rate: 18,
      ownerId: 'user1',
      createdAt: '2020-01-01T00:00:00Z',
      updatedAt: '2020-01-01T00:00:00Z',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Self-admin privilege escalation on admins collection',
    collection: 'admins',
    docId: 'attacker',
    operation: 'create',
    auth: { uid: 'attacker', email: 'attacker@example.com', email_verified: true },
    payload: { uid: 'attacker', email: 'attacker@example.com' },
    expected: 'PERMISSION_DENIED',
  },
];
