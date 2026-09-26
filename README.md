# drobek-module-counter

A [drobek](https://github.com/freema/drobek) platform module: **named
counters per app** — page views, likes, downloads. One call adds 1 and
returns the new total; counts live on the server and every visitor of the
app shares them. Written against the module contract `^1.1`
(`@drobek/modules`).

- `POST /__drobek/v1/counter/:key/hit` → `{ key, count }` — adds 1 (atomic),
  rate-limited per visitor IP and per app
- `GET /__drobek/v1/counter/:key` → `{ key, count }` — `0` for a key never hit
- `GET /__drobek/v1/counter` → `{ counters: [{ key, count, updated_at }], max_keys }`
  — app admins only by default (config `list`)
- `drobek.counter.hit(key)` / `get(key)` / `list()` in the browser
- table `mod_counter_counts` (its own migrations, journal
  `__drizzle_migrations_mod_counter`); the counters of a deleted app are
  removed (`onAppDelete`, and the `apps(id)` cascade)

## Install on a drobek server

drobek v0.2.0 or newer (module contract 1.1). On the server, in the drobek
checkout:

```sh
task selfhost:module:add -- drobek-module-counter@0.1.0     # or a tarball URL/path from `npm pack`
```

then add `counter` to `DROBEK_MODULES` in `.env.production` (the short name
works because the package is `drobek-module-counter`):

```sh
DROBEK_MODULES=auth,email,forms,data,proxy,files,counter
```

and restart drobek with the command `selfhost:module:add` prints
(`./scripts/selfhost-compose.sh up -d --wait drobek`). The start applies the module's migration and
lists it in `platform modules ready`, `/healthz` and `/api/version`. A module
runs inside the drobek process with the whole database: install only modules
you trust.

## Use it in an app

```ts
import { drobek, DrobekError } from 'drobek';

const { count } = await drobek.counter.hit('page-views');   // +1, returns the total
const likes = await drobek.counter.get('likes');             // { key: 'likes', count: 0 } when never hit

try {
  await drobek.counter.hit('likes.post-42');
} catch (err) {
  if (err instanceof DrobekError && err.code === 'rate_limited') {
    // slow down; err.hint / Retry-After
  }
}
```

A key is 1–64 characters of `a-z 0-9 . _ -`, starting with a letter or digit.
The agent-facing guide is [`SKILL.md`](./SKILL.md) (`skill_info('counter')`).

## Config

Per app, set by an agent with `configure_module` or in the dashboard
(Apps → Modules → counter):

| Key | Default | Meaning |
| --- | --- | --- |
| `maxKeys` | `100` | the most distinct keys one app keeps (1–10000); applies at once |
| `list` | `"admin"` | who may call `list()`: `"admin"` (app admins signed in through the `auth` module), `"user"` (any signed-in end user), `"public"` (anyone). Widening it waits for the app owner's confirmation |

`hit` and `get` are always public. An operator changes the defaults for the
whole server with `DROBEK_MODULE_COUNTER_DEFAULTS='{"maxKeys":500}'`.

## Limits

Env vars on the drobek server (a limits provider may override them per
workspace):

| Env | Default | Meaning |
| --- | --- | --- |
| `COUNTER_HITS_PER_IP_MINUTE` | `60` | hits one visitor IP may send per minute |
| `COUNTER_HITS_PER_APP_MINUTE` | `6000` | hits one app takes per minute, all visitors together (also bounds clients without a resolved IP) |

## Error codes

Besides the core codes (`rate_limited`, `unauthorized`, `forbidden`,
`csrf_rejected`, …) the routes answer the module's own:

| Code | HTTP | Meaning | Fix |
| --- | --- | --- | --- |
| `invalid_counter_key` | 400 | the key is not 1–64 of `a-z 0-9 . _ -` starting with a letter or digit (`details.pattern`) | use a lowercase key like `page-views` |
| `too_many_counters` | 409 | the first hit of a new key while the app keeps `maxKeys` keys (`details.max`) | reuse keys; the owner raises `maxKeys` |

## Develop

```sh
npm install
npm run build       # dist/ — what a drobek server loads
npm run typecheck
npm test            # the routes through the production pipeline (PGlite) + the SKILL.md gate
npm run check       # the SKILL.md gate alone (checkSkill)
```

**While `@drobek/*` is not on the npm registry**, `package.json` keeps the
registry ranges (`@drobek/modules` `^0.2.0` as a dev dependency, `>=0.2.0` as
the peer the server provides) and the committed `package-lock.json` pins
`@drobek/modules` and `@drobek/sdk` to local tarballs at
`../drobek/dist-npm/` (a drobek checkout next to this one, built with its
npm pack step). `npm install` / `npm ci` then work offline from the lock.
After rebuilding the tarballs (a new integrity), re-pin them:

```sh
npm run dev:install-local                     # DROBEK_NPM_DIR=<dir with the .tgz files> to override
```

Once `@drobek/modules` is published, drop the pin: `rm package-lock.json &&
npm install`. The published package never contains the lockfile, so its
manifest names no `file:` path.

## License

AGPL-3.0-only, like drobek — see [LICENSE](./LICENSE).
