import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { users } from './schema.js';

export async function getOrCreateFirebaseUser(
  uid: string,
  email: string,
  displayName?: string,
  forceAdmin = false
) {
  try {
    const emailLower = email.trim().toLowerCase();
    const existingByUid = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    if (existingByUid.length > 0) {
      const updated = await db
        .update(users)
        .set({
          email: emailLower,
          fullName: displayName || existingByUid[0].fullName,
          isAdmin: forceAdmin ? true : existingByUid[0].isAdmin,
        })
        .where(eq(users.uid, uid))
        .returning();
      return updated[0];
    }

    const existingByEmail = await db.select().from(users).where(eq(users.email, emailLower)).limit(1);
    if (existingByEmail.length > 0) {
      const linked = await db
        .update(users)
        .set({
          uid,
          fullName: displayName || existingByEmail[0].fullName,
          isAdmin: forceAdmin ? true : existingByEmail[0].isAdmin,
        })
        .where(eq(users.id, existingByEmail[0].id))
        .returning();
      return linked[0];
    }

    if (forceAdmin) {
      const adminRow = await db.select().from(users).where(eq(users.username, 'admin')).limit(1);
      if (adminRow.length > 0) {
        const linkedAdmin = await db
          .update(users)
          .set({
            uid,
            email: emailLower,
            isAdmin: true,
          })
          .where(eq(users.id, adminRow[0].id))
          .returning();
        return linkedAdmin[0];
      }
    }

    const allUsers = await db.select({ id: users.id, username: users.username, isAdmin: users.isAdmin }).from(users);
    const taken = new Set(allUsers.map((u) => u.username.toLowerCase()));
    const hasAdmin = allUsers.some((u) => u.isAdmin);
    const base = emailLower.split('@')[0].replace(/[^a-z0-9_.-]/gi, '') || 'user';
    let candidate = base;
    let suffix = 1;
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${base}${suffix++}`;
    }

    const inserted = await db
      .insert(users)
      .values({
        uid,
        username: candidate,
        email: emailLower,
        fullName: displayName || candidate,
        designation: forceAdmin ? 'Principal Consultant' : 'Analyst',
        passwordHash: bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10),
        isAdmin: forceAdmin || !hasAdmin,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: { email: emailLower },
      })
      .returning();

    return inserted[0];
  } catch (error) {
    console.error('Database user upsert failed:', error);
    throw new Error('Failed to synchronize user account.', { cause: error });
  }
}
