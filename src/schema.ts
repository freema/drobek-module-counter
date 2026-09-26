/**
 * The module's own table, created by ../migrations (journal
 * `__drizzle_migrations_mod_counter`). One row per (app, key); rows reference
 * apps(id) with ON DELETE CASCADE.
 */
import { bigint, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

export const counts = pgTable(
  'mod_counter_counts',
  {
    appId: text('app_id').notNull(),
    key: text('key').notNull(),
    count: bigint('count', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: 'mod_counter_counts_app_id_key_pk', columns: [t.appId, t.key] })]
);
