import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').unique(),
  username: text('username').notNull().unique(),
  fullName: text('full_name'),
  email: text('email'),
  contactNo: text('contact_no'),
  designation: text('designation'),
  controlNo: text('control_no'),
  passwordHash: text('password_hash').notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const items = pgTable('items', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  code: text('code'),
  description: text('description'),
  pvcFormulaCode: text('pvc_formula_code').notNull().default('IEEMA_WEIGHTED'),
  weightsJson: text('weights_json').notNull().default('{}'),
  extraFieldsJson: text('extra_fields_json').notNull().default('[]'),
  lagMonths: integer('lag_months').notNull().default(1),
  baseLagMonths: integer('base_lag_months').notNull().default(0),
  fixedWeight: doublePrecision('fixed_weight').notNull().default(15),
  indexSource: text('index_source').default('IEEMA'),
  componentsJson: text('components_json').default('[]'),
  customFormula: text('custom_formula'),
});

export const itemIndices = pgTable(
  'item_indices',
  {
    id: serial('id').primaryKey(),
    itemId: integer('item_id')
      .references(() => items.id, { onDelete: 'cascade' })
      .notNull(),
    month: text('month').notNull(),
    indicesJson: text('indices_json').notNull().default('{}'),
    attachmentsJson: text('attachments_json').notNull().default('[]'),
  },
  (table) => [uniqueIndex('item_indices_item_month_uidx').on(table.itemId, table.month)]
);

export const tenders = pgTable('tenders', {
  id: serial('id').primaryKey(),
  itemId: integer('item_id')
    .references(() => items.id, { onDelete: 'cascade' })
    .notNull(),
  tenderNo: text('tender_no').notNull().unique(),
  basicrate: doublePrecision('basicrate').notNull().default(0),
  pvcbasedate: text('pvcbasedate'),
  freightrateperunit: doublePrecision('freightrateperunit').notNull().default(0),
  gstRate: doublePrecision('gst_rate').notNull().default(18),
  createdAt: text('created_at').notNull(),
});

export const tenderVendors = pgTable('tender_vendors', {
  id: serial('id').primaryKey(),
  tenderId: integer('tender_id')
    .references(() => tenders.id, { onDelete: 'cascade' })
    .notNull(),
  poNo: text('po_no'),
  vendorName: text('vendor_name').notNull(),
  cif: doublePrecision('cif').notNull().default(0),
  freightrateperunit: doublePrecision('freightrateperunit').notNull().default(0),
  currency: text('currency').notNull().default('INR'),
});

export const pvcResults = pgTable('pvc_results', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  itemId: integer('item_id')
    .references(() => items.id, { onDelete: 'cascade' })
    .notNull(),
  username: text('username').notNull(),
  createdAt: text('created_at').notNull(),
  basicrate: doublePrecision('basicrate').notNull().default(0),
  quantity: doublePrecision('quantity').notNull().default(1),
  freightrateperunit: doublePrecision('freightrateperunit').notNull().default(0),
  pvcbasedate: text('pvcbasedate'),
  origdp: text('origdp'),
  refixeddp: text('refixeddp'),
  extendeddp: text('extendeddp'),
  caldate: text('caldate'),
  supdate: text('supdate'),
  rateapplied: text('rateapplied'),
  pvcactual: doublePrecision('pvcactual'),
  pvccontractual: doublePrecision('pvccontractual'),
  loweractual: doublePrecision('loweractual'),
  lowercontractual: doublePrecision('lowercontractual'),
  ldamtactual: doublePrecision('ldamtactual'),
  ldamtcontractual: doublePrecision('ldamtcontractual'),
  fairprice: doublePrecision('fairprice'),
  selectedscenario: text('selectedscenario'),
  pvcactuallessldnew: doublePrecision('pvcactuallessldnew'),
  pvccontractuallessldnew: doublePrecision('pvccontractuallessldnew'),
  loweractuallessld: doublePrecision('loweractuallessld'),
  lowercontractuallessld: doublePrecision('lowercontractuallessld'),
  delaydays: integer('delaydays').notNull().default(0),
  ldweeksnew: integer('ldweeksnew').notNull().default(0),
  ldratepctnew: doublePrecision('ldratepctnew').notNull().default(0),
  ldapplicable: boolean('ldapplicable').notNull().default(false),
  pvcperseta2: doublePrecision('pvcperseta2'),
  pvcpersetb2: doublePrecision('pvcpersetb2'),
  pvcpersetc1: doublePrecision('pvcpersetc1'),
  pvcpersetd1: doublePrecision('pvcpersetd1'),
  tenderno: text('tenderno'),
  pono: text('pono'),
  scenarioamountsJson: text('scenarioamounts_json').notNull().default('{}'),
  scenariodetailsJson: text('scenariodetails_json').notNull().default('[]'),
  igbtVendorDetailsJson: text('igbt_vendor_details_json').notNull().default('[]'),
});

export const auditLogs = pgTable('audit_logs', {
  id: serial('id').primaryKey(),
  userId: integer('user_id'),
  action: text('action').notNull(),
  tableName: text('table_name').notNull(),
  rowId: text('row_id'),
  oldData: text('old_data'),
  newData: text('new_data'),
  timestamp: text('timestamp').notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  pvcResults: many(pvcResults),
}));

export const itemsRelations = relations(items, ({ many }) => ({
  indices: many(itemIndices),
  tenders: many(tenders),
  pvcResults: many(pvcResults),
}));

export const itemIndicesRelations = relations(itemIndices, ({ one }) => ({
  item: one(items, {
    fields: [itemIndices.itemId],
    references: [items.id],
  }),
}));

export const tendersRelations = relations(tenders, ({ one, many }) => ({
  item: one(items, {
    fields: [tenders.itemId],
    references: [items.id],
  }),
  vendors: many(tenderVendors),
}));

export const tenderVendorsRelations = relations(tenderVendors, ({ one }) => ({
  tender: one(tenders, {
    fields: [tenderVendors.tenderId],
    references: [tenders.id],
  }),
}));

export const pvcResultsRelations = relations(pvcResults, ({ one }) => ({
  user: one(users, {
    fields: [pvcResults.userId],
    references: [users.id],
  }),
  item: one(items, {
    fields: [pvcResults.itemId],
    references: [items.id],
  }),
}));
