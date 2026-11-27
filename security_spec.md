# Security Specification — PVC Calculation Studio Firestore Rules

## 1. Data Invariants
1. **Verified Authentication Required**: Every read and write requires `request.auth != null && request.auth.token.email_verified == true`.
2. **Ownership & Isolation**: Every business record (`items`, `item_indices`, `tenders`, `tender_vendors`, `pvc_results`, `workspace_meta`) stores `ownerId == request.auth.uid`. Reads, lists, updates, and deletes are restricted to the owner (`existing().ownerId == request.auth.uid`) or verified admin.
3. **Referential Integrity**:
   - An `item_indices` document cannot be created unless its referenced parent `/items/{itemDocId}` exists and belongs to the same user (`ownerId == request.auth.uid`).
   - A `tenders` document cannot be created unless its referenced parent `/items/{itemDocId}` exists and belongs to the same user.
   - A `tender_vendors` document cannot be created unless its referenced parent `/tenders/{tenderDocId}` exists and belongs to the same user.
   - A `pvc_results` document cannot be created unless its referenced parent `/items/{itemDocId}` exists and belongs to the same user.
4. **Strict Schema & Immutability**:
   - All creates enforce `keys().hasAll(...)` and `keys().hasOnly(...)` with strict type, regex, and `.size()` bounds.
   - All updates begin with `isValid[Entity](incoming())`, enforce `affectedKeys().hasOnly(...)`, preserve immutable `ownerId` and `createdAt`, and validate `updatedAt == request.time`.
5. **PII / Admin Protection**:
   - `/admins/{uid}` is strictly restricted to bootstrapped verified admin (`cviclw@gmail.com` with `email_verified == true`) for writes and self-or-admin for reads. No user can self-assign admin role.

## 2. The "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. **Unauthenticated Read** on `/items/item_1` (`request.auth == null`).
2. **Unverified Email Write** on `/items/item_1` (`email_verified: false`, even if email matches `cviclw@gmail.com`).
3. **Owner Spoofing on Create** on `/items/item_1` (`ownerId: "victim_uid"` while signed in as `"attacker_uid"`).
4. **Shadow Field Injection** on `/item_indices/idx_1_2025_01` (extra key `isAdmin: true`).
5. **Orphaned Index Write** on `/item_indices/idx_999_2025_01` (`itemDocId: "item_999"` where `/items/item_999` does not exist).
6. **Cross-Tenant Parent Reference** on `/tender_vendors/vnd_1` (`tenderDocId` points to another user's tender).
7. **ID Poisoning Attack** on `/items/<200-char-invalid-id!@#>` (`isValidId` rejects special chars and oversized IDs).
8. **String Resource Exhaustion** on `/items/item_1` (`name` length > 200 or `description` length > 1000).
9. **Array Overflow Attack** on `/items/item_1` (`components` array length > 50).
10. **Immutable Field Tampering** on update of `/items/item_1` (attempting to change `ownerId` or `createdAt`).
11. **Client Timestamp Forgery** on create/update of `/tenders/tnd_1` (`createdAt` or `updatedAt` != `request.time`).
12. **Self-Admin Escalation** on `/admins/attacker_uid` (regular user attempting to create their own admin document).
