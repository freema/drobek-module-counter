/**
 * drobek-module-counter — named counters per app (page views, likes,
 * downloads). Module contract ^1.1.
 *
 *   DROBEK_MODULES=…,counter
 *
 *   POST /__drobek/v1/counter/:key/hit → { key, count }   (+1, rate-limited per visitor IP and per app)
 *   GET  /__drobek/v1/counter/:key     → { key, count }   (0 for a key never hit)
 *   GET  /__drobek/v1/counter          → { counters, max_keys }   (rule: config `list`, default admin)
 *   drobek.counter.hit(key) / get(key) / list()
 *   config { maxKeys, list } — opening `list` to more callers needs the owner's OK.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { ModuleError, defineModule, z, type ModuleContext } from '@drobek/modules';
import { counts } from './schema.js';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

const sdkEntry = existsSync(here('./sdk.js')) ? here('./sdk.js') : here('./sdk.ts');

export const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_KEYS_CAP = 10_000;
const WINDOW_MS = 60_000;
const DEFAULT_HITS_PER_APP_MINUTE = 6000;

const LIST_RULES = ['admin', 'user', 'public'] as const;

export const counterConfig = z.object({
  maxKeys: z.number().int().min(1).max(MAX_KEYS_CAP).describe('The most distinct counter keys one app keeps (1–10000).'),
  list: z
    .enum(LIST_RULES)
    .describe('Who may list every counter of the app: "admin" (app admins), "user" (signed-in end users) or "public" (anyone).'),
});
export type CounterConfig = z.infer<typeof counterConfig>;

const SDK_TYPES = `
export interface Counter {
  key: string;
  count: number;
}
export interface CounterEntry extends Counter {
  /** ISO timestamp of the last hit */
  updated_at: string;
}
export interface Api {
  /** Add 1 to the counter \`key\` (created at 0 on its first hit); rate-limited (COUNTER_HITS_PER_IP_MINUTE per visitor IP). */
  hit(key: string): Promise<Counter>;
  /** The counter \`key\`; count 0 when it was never hit. */
  get(key: string): Promise<Counter>;
  /** Every counter of the app, by key; allowed by the config rule \`list\` (default: app admins only). */
  list(): Promise<{ counters: CounterEntry[]; max_keys: number }>;
}
`;

type Ctx = ModuleContext<CounterConfig>;

function validKey(raw: string | undefined): string {
  const key = raw ?? '';
  if (!KEY_RE.test(key)) {
    throw new ModuleError('invalid_counter_key', `"${key.slice(0, 80)}" is not a counter key: 1–64 of a-z 0-9 . _ -, starting with a letter or digit.`, {
      status: 400,
      details: { pattern: KEY_RE.source },
    });
  }
  return key;
}

async function appWideLimit(ctx: Ctx): Promise<void> {
  const max = (await ctx.limits()).COUNTER_HITS_PER_APP_MINUTE ?? DEFAULT_HITS_PER_APP_MINUTE;
  const r = await ctx.rateLimit('hit-app', 'app', max, WINDOW_MS);
  if (!r.ok) {
    throw new ModuleError('rate_limited', `Too many counter hits for this app (${max} per minute). Slow down and retry.`, {
      details: { limit: 'COUNTER_HITS_PER_APP_MINUTE', value: max },
      headers: { 'Retry-After': String(r.retryAfterSec) },
    });
  }
}

/** +1 on an existing counter: one atomic UPDATE, no lock. */
async function bumpExisting(db: Ctx['db'], appId: string, key: string): Promise<number | null> {
  const [row] = await db
    .update(counts)
    .set({ count: sql`${counts.count} + 1`, updatedAt: sql`now()` })
    .where(and(eq(counts.appId, appId), eq(counts.key, key)))
    .returning({ count: counts.count });
  return row ? Number(row.count) : null;
}

/**
 * The first hit of a key: the maxKeys check and the insert run under a
 * per-app advisory lock, so concurrent first hits of different keys cannot
 * overshoot the cap. ON CONFLICT covers a concurrent first hit of the same key.
 */
async function createAndBump(db: Ctx['db'], appId: string, key: string, maxKeys: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mod_counter:${appId}`}))`);
    const [existing] = await tx
      .select({ n: count() })
      .from(counts)
      .where(and(eq(counts.appId, appId), eq(counts.key, key)));
    if (Number(existing?.n ?? 0) === 0) {
      const [total] = await tx.select({ n: count() }).from(counts).where(eq(counts.appId, appId));
      if (Number(total?.n ?? 0) >= maxKeys) {
        throw new ModuleError('too_many_counters', `This app already keeps ${maxKeys} counters; "${key}" would be one more.`, {
          status: 409,
          details: { max: maxKeys },
        });
      }
    }
    const [row] = await tx
      .insert(counts)
      .values({ appId, key, count: 1 })
      .onConflictDoUpdate({ target: [counts.appId, counts.key], set: { count: sql`${counts.count} + 1`, updatedAt: sql`now()` } })
      .returning({ count: counts.count });
    return Number(row!.count);
  });
}

const rank = (rule: CounterConfig['list']) => LIST_RULES.indexOf(rule);

export default defineModule<CounterConfig>({
  name: 'counter',
  version: '0.1.1',
  contract: '^1.1',
  skill: {
    useWhen: 'the app counts something on the server that every visitor shares, such as page views, likes or downloads',
    markdown: readFileSync(here('../SKILL.md'), 'utf8'),
  },
  configSchema: counterConfig,
  configDefaults: { maxKeys: 100, list: 'admin' },
  confirmRequired(before, after) {
    return rank(after.list) > rank(before.list) ? [`list: "${before.list}" → "${after.list}" (more callers may list every counter)`] : [];
  },
  rules: { ops: { hit: 'Add 1 to a counter', get: 'Read one counter', list: 'List every counter of the app' } },
  limits: [
    { env: 'COUNTER_HITS_PER_IP_MINUTE', default: 60, meaning: 'counter hits one visitor IP may send per minute' },
    { env: 'COUNTER_HITS_PER_APP_MINUTE', default: DEFAULT_HITS_PER_APP_MINUTE, meaning: 'counter hits one app takes per minute, all visitors together' },
  ],
  errors: [
    {
      code: 'invalid_counter_key',
      meaning: 'HTTP 400. The key is not 1–64 characters of a-z 0-9 . _ - starting with a letter or digit (`details.pattern`).',
      fix: 'Use a lowercase key such as "page-views" or "likes.post-42".',
    },
    {
      code: 'too_many_counters',
      meaning: 'HTTP 409. The first hit of a new key while the app already keeps `maxKeys` counters (`details.max`).',
      fix: 'Reuse existing keys; the app owner can raise maxKeys with configure_module.',
    },
  ],
  routes(r) {
    r.get('/', { rule: (c) => c.list }, async (_req, ctx) => {
      const rows = await ctx.db
        .select()
        .from(counts)
        .where(eq(counts.appId, ctx.app.id))
        .orderBy(asc(counts.key))
        .limit(MAX_KEYS_CAP);
      return {
        counters: rows.map((row) => ({ key: row.key, count: Number(row.count), updated_at: row.updatedAt.toISOString() })),
        max_keys: ctx.config.maxKeys,
      };
    });
    r.get('/:key', { rule: 'public' }, async (req, ctx) => {
      const key = validKey(req.params.key);
      const [row] = await ctx.db
        .select({ count: counts.count })
        .from(counts)
        .where(and(eq(counts.appId, ctx.app.id), eq(counts.key, key)));
      return { key, count: row ? Number(row.count) : 0 };
    });
    r.post(
      '/:key/hit',
      {
        rule: 'public',
        rateLimit: { bucket: 'hit', max: 'COUNTER_HITS_PER_IP_MINUTE', windowMs: WINDOW_MS, per: 'ip' },
        maxBodyBytes: 256,
      },
      async (req, ctx) => {
        const key = validKey(req.params.key);
        await appWideLimit(ctx);
        const value = (await bumpExisting(ctx.db, ctx.app.id, key)) ?? (await createAndBump(ctx.db, ctx.app.id, key, ctx.config.maxKeys));
        return { key, count: value };
      }
    );
  },
  hooks: {
    async onAppDelete(app, { db, log }) {
      const removed = await db.delete(counts).where(eq(counts.appId, app.id)).returning({ key: counts.key });
      log.info('counter: counters of a deleted app removed', { app_id: app.id, counters: removed.length });
    },
  },
  sdk: { entry: sdkEntry, types: SDK_TYPES },
  migrations: { folder: here('../migrations') },
});
