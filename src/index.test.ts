/**
 * The counter module under createModuleTestContext(): its routes run through
 * the SAME pipeline production uses (rule, CSRF, rate limit, uniform errors),
 * over PGlite with the drobek core + module migrations.
 */
import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDefinedModule, type DB, type HookApp, type Logger } from '@drobek/modules';
import { buildSdk, coreMigrationsDir, createModuleTestContext, createTestApp, loadModules } from '@drobek/modules/testing';
import mod from './index.js';

let pg: PGlite;
let db: DB;
let app: HookApp;

const admin = { kind: 'user', id: 'eu_admin', email: 'admin@example.com', role: 'admin' } as const;
const member = { kind: 'user', id: 'eu_user', email: 'ana@example.com', role: 'user' } as const;
const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as Logger;

const rowsOf = async (appId: string) =>
  (await pg.query<{ n: number }>('select count(*)::int as n from mod_counter_counts where app_id = $1', [appId])).rows[0]!.n;

beforeAll(async () => {
  pg = new PGlite();
  const d = drizzle(pg);
  await migrate(d, { migrationsFolder: coreMigrationsDir(), migrationsTable: '__drizzle_migrations_core', migrationsSchema: 'drizzle' });
  await migrate(d, { migrationsFolder: mod.migrations!.folder, migrationsTable: '__drizzle_migrations_mod_counter', migrationsSchema: 'drizzle' });
  app = await createTestApp(d, { slug: 'counter-app' });
  db = d as unknown as DB;
});

afterAll(async () => {
  await pg.close();
});

describe('drobek-module-counter', () => {
  it('is a module the registry loads by its short name, contract ^1.1', async () => {
    expect(isDefinedModule(mod)).toBe(true);
    expect(mod.contract).toBe('^1.1');
    const mods = await loadModules({ DROBEK_MODULES: 'counter' }, { importer: async (pkg) => (pkg === 'drobek-module-counter' ? { default: mod } : null) });
    expect(mods.map((m) => m.name)).toEqual(['counter']);
    expect(mod.errors?.map((e) => e.code)).toEqual(['invalid_counter_key', 'too_many_counters']);
  });

  it('POST /:key/hit increments by 1 and returns { key, count }; GET /:key reads it', async () => {
    const t = createModuleTestContext(mod, { db, app });
    expect((await t.request('POST', '/page-views/hit')).body).toEqual({ key: 'page-views', count: 1 });
    expect((await t.request('POST', '/page-views/hit')).body).toEqual({ key: 'page-views', count: 2 });
    const res = await t.request('GET', '/page-views');
    expect(res).toMatchObject({ status: 200, body: { key: 'page-views', count: 2 } });
  });

  it('GET of a key never hit is 0 and creates nothing', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other });
    expect((await t.request('GET', '/never.hit_1')).body).toEqual({ key: 'never.hit_1', count: 0 });
    expect(await rowsOf(other.id)).toBe(0);
  });

  it('concurrent hits stay consistent, on a new key and on an existing one', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other });
    const first = await Promise.all(Array.from({ length: 20 }, () => t.request('POST', '/likes/hit')));
    expect(first.every((r) => r.status === 200)).toBe(true);
    expect(first.map((r) => (r.body as { count: number }).count).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    await Promise.all(Array.from({ length: 30 }, () => t.request('POST', '/likes/hit')));
    expect((await t.request('GET', '/likes')).body).toEqual({ key: 'likes', count: 50 });
    expect(await rowsOf(other.id)).toBe(1);
  });

  it('counters are per app', async () => {
    const a = await createTestApp(db);
    const b = await createTestApp(db);
    await createModuleTestContext(mod, { db, app: a }).request('POST', '/downloads/hit');
    expect((await createModuleTestContext(mod, { db, app: b }).request('GET', '/downloads')).body).toEqual({ key: 'downloads', count: 0 });
  });

  it('refuses a bad key with invalid_counter_key (400)', async () => {
    const t = createModuleTestContext(mod, { db, app });
    for (const bad of ['Likes', '-likes', '.hidden', 'a%20b', 'x'.repeat(65), 'caf%C3%A9']) {
      const hit = await t.request('POST', `/${bad}/hit`);
      expect(hit.status, bad).toBe(400);
      expect(hit.body).toMatchObject({ error: 'invalid_counter_key', details: { pattern: expect.any(String) }, hint: "skill_info('counter')" });
      expect((await t.request('GET', `/${bad}`)).body).toMatchObject({ error: 'invalid_counter_key' });
    }
    expect((await t.request('POST', `/${'x'.repeat(64)}/hit`)).status).toBe(200);
  });

  it('enforces maxKeys with too_many_counters (409); existing keys keep counting', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other, config: { maxKeys: 2 } });
    expect((await t.request('POST', '/a/hit')).status).toBe(200);
    expect((await t.request('POST', '/b/hit')).status).toBe(200);
    const full = await t.request('POST', '/c/hit');
    expect(full.status).toBe(409);
    expect(full.body).toMatchObject({ error: 'too_many_counters', details: { max: 2 } });
    expect((await t.request('POST', '/a/hit')).body).toEqual({ key: 'a', count: 2 });
    expect(await rowsOf(other.id)).toBe(2);
  });

  it('maxKeys holds under concurrent first hits of different keys', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other, config: { maxKeys: 3 } });
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => t.request('POST', `/k${i}/hit`)));
    expect(res.filter((r) => r.status === 200)).toHaveLength(3);
    expect(res.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await rowsOf(other.id)).toBe(3);
  });

  it('rate limits hits per visitor IP (COUNTER_HITS_PER_IP_MINUTE, 429 + Retry-After)', async () => {
    const t = createModuleTestContext(mod, { db, app, limits: { COUNTER_HITS_PER_IP_MINUTE: 2 } });
    expect((await t.request('POST', '/rl/hit', { clientIp: '203.0.113.1' })).status).toBe(200);
    expect((await t.request('POST', '/rl/hit', { clientIp: '203.0.113.1' })).status).toBe(200);
    const limited = await t.request('POST', '/rl/hit', { clientIp: '203.0.113.1' });
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBeDefined();
    expect(limited.body).toMatchObject({ error: 'rate_limited' });
    expect((await t.request('POST', '/rl/hit', { clientIp: '203.0.113.2' })).body).toEqual({ key: 'rl', count: 3 });
    expect((await t.request('GET', '/rl', { clientIp: '203.0.113.1' })).status).toBe(200);
  });

  it('rate limits hits per app (COUNTER_HITS_PER_APP_MINUTE), also without a client IP', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other, limits: { COUNTER_HITS_PER_APP_MINUTE: 2 } });
    expect((await t.request('POST', '/x/hit', { clientIp: '198.51.100.1' })).status).toBe(200);
    expect((await t.request('POST', '/x/hit', { clientIp: null })).status).toBe(200);
    const limited = await t.request('POST', '/x/hit', { clientIp: '198.51.100.3' });
    expect(limited.status).toBe(429);
    expect(limited.headers['Retry-After']).toBeDefined();
    expect(limited.body).toMatchObject({ error: 'rate_limited', details: { limit: 'COUNTER_HITS_PER_APP_MINUTE', value: 2 } });
    expect((await t.request('GET', '/x')).body).toEqual({ key: 'x', count: 2 });
  });

  it('rejects a cross-origin hit and one without the SDK header', async () => {
    const t = createModuleTestContext(mod, { db, app });
    expect((await t.request('POST', '/csrf/hit', { headers: { origin: 'https://evil.example' } })).body).toMatchObject({ error: 'csrf_rejected' });
    expect((await t.request('POST', '/csrf/hit', { headers: { 'x-drobek-sdk': '' } })).status).toBe(403);
    expect((await t.request('GET', '/csrf')).body).toEqual({ key: 'csrf', count: 0 });
  });

  it('GET / lists the counters for app admins only by default', async () => {
    const other = await createTestApp(db);
    const t = createModuleTestContext(mod, { db, app: other });
    await t.request('POST', '/views/hit');
    await t.request('POST', '/likes/hit');
    await t.request('POST', '/likes/hit');
    expect((await t.request('GET', '/')).body).toMatchObject({ error: 'unauthorized' });
    t.setPrincipal(member);
    expect((await t.request('GET', '/')).body).toMatchObject({ error: 'forbidden' });
    t.setPrincipal(admin);
    const res = await t.request('GET', '/');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      counters: [
        { key: 'likes', count: 2, updated_at: expect.any(String) },
        { key: 'views', count: 1, updated_at: expect.any(String) },
      ],
      max_keys: 100,
    });
  });

  it('config list "user" / "public" opens the list', async () => {
    const other = await createTestApp(db);
    const users = createModuleTestContext(mod, { db, app: other, config: { list: 'user' } });
    expect((await users.request('GET', '/')).status).toBe(401);
    users.setPrincipal(member);
    expect((await users.request('GET', '/')).status).toBe(200);
    const anyone = createModuleTestContext(mod, { db, app: other, config: { list: 'public' } });
    expect((await anyone.request('GET', '/')).body).toEqual({ counters: [], max_keys: 100 });
  });

  it('widening list needs the owner\'s confirmation; narrowing it and maxKeys do not', async () => {
    const t = createModuleTestContext(mod);
    expect(await t.confirm({}, { list: 'public' })).toEqual(['list: "admin" → "public" (more callers may list every counter)']);
    expect(await t.confirm({ list: 'user' }, { list: 'public' })).toHaveLength(1);
    expect(await t.confirm({ list: 'public' }, { list: 'admin' })).toEqual([]);
    expect(await t.confirm({}, { maxKeys: 5000 })).toEqual([]);
  });

  it('refuses an invalid config', () => {
    expect(mod.configSchema.safeParse({ maxKeys: 0, list: 'admin' }).success).toBe(false);
    expect(mod.configSchema.safeParse({ maxKeys: 100, list: 'owner' }).success).toBe(false);
    expect(mod.configSchema.safeParse(mod.configDefaults).success).toBe(true);
  });

  it('onAppDelete removes the app\'s counters and only those', async () => {
    const gone = await createTestApp(db);
    const kept = await createTestApp(db);
    await createModuleTestContext(mod, { db, app: gone }).request('POST', '/a/hit');
    await createModuleTestContext(mod, { db, app: gone }).request('POST', '/b/hit');
    await createModuleTestContext(mod, { db, app: kept }).request('POST', '/a/hit');
    await mod.hooks!.onAppDelete!(gone, { db, log: silent, contributions: () => [] });
    expect(await rowsOf(gone.id)).toBe(0);
    expect(await rowsOf(kept.id)).toBe(1);
  });

  it('deleting the app row cascades to its counters', async () => {
    const other = await createTestApp(db);
    await createModuleTestContext(mod, { db, app: other }).request('POST', '/a/hit');
    await (db as unknown as { execute(q: unknown): Promise<unknown> }).execute(sql`delete from apps where id = ${other.id}`);
    expect(await rowsOf(other.id)).toBe(0);
  });

  it('bundles into the SDK as drobek.counter with hit() / get() / list()', async () => {
    const sdk = await buildSdk([mod]);
    const js = sdk.js.toString('utf8');
    expect(js).toContain('"counter"');
    expect(js).toContain('/hit');
    expect(sdk.dts).toContain('readonly counter: counter.Api;');
    expect(sdk.dts).toContain('hit(key: string): Promise<Counter>;');
    expect(sdk.dts).toContain('list(): Promise<{ counters: CounterEntry[]; max_keys: number }>;');
  });
});
