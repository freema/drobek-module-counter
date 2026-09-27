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

Its only dependencies are peers the server provides (`@drobek/modules`,
`drizzle-orm`), so installing it fetches nothing else from npm.

## Install on a drobek server

drobek v0.2.0 or newer (module contract 1.1). A self-hosted server, in its
drobek checkout:

```sh
task selfhost:module:add -- drobek-module-counter@0.1.1
# or the tarball attached to its GitHub release:
task selfhost:module:add -- https://github.com/freema/drobek-module-counter/releases/download/v0.1.1/drobek-module-counter-0.1.1.tgz
```

The drobek dev stack (`task dev`) takes the same spec:

```sh
task module:add -- drobek-module-counter
```

Both print the `DROBEK_MODULES` line to set and the restart command. Add
`counter` to `DROBEK_MODULES` (`.env.production` on a self-hosted server,
`.env` for the dev stack; the short name works because the package is
`drobek-module-counter`):

```sh
DROBEK_MODULES=auth,email,forms,data,proxy,files,counter
```

and restart drobek (self-hosted: `./scripts/selfhost-compose.sh up -d --wait
drobek`). The start applies the module's migration and lists it in `platform
modules ready`, `/healthz` and `/api/version`. A module runs inside the
drobek process with the whole database: install only modules you trust.

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

Node 22. The module contract is on npm as `@freema/drobek-modules` (the
browser SDK core as `@freema/drobek-sdk`); `package.json` installs them under
the names the code imports through npm aliases —
`"@drobek/modules": "npm:@freema/drobek-modules@^0.3.3"` and
`"@drobek/sdk": "npm:@freema/drobek-sdk@^0.3.3"` in `devDependencies` — and
keeps `"@drobek/modules": ">=0.2.0"` as the peer the server provides:

```sh
npm ci
npm run build             # dist/ — what a drobek server loads
npm run typecheck
npm test                  # the routes through the production pipeline (PGlite) + the SKILL.md gate
npm run check             # the SKILL.md gate alone (checkSkill)
```

To move to another drobek release:

```sh
npm install --save-dev @drobek/modules@npm:@freema/drobek-modules@^X.Y.Z @drobek/sdk@npm:@freema/drobek-sdk@^X.Y.Z
```

## Releasing

Bump `version` in `package.json`, commit, tag `v<version>` and push the tag.
CI (`.github/workflows/ci.yml`) runs the checks, packs the module and creates
the GitHub release with the tarball attached. npm publishing is in the same
job and stays off until the repository variable `NPM_PUBLISH` is `true`.

One-time, to publish on npm:

1. Publish the first version by hand — Trusted Publishing is configured on an
   existing package: `npm login`, download the release tarball and
   `npm publish drobek-module-counter-0.1.1.tgz --access public`.
2. On npmjs.com → `drobek-module-counter` → Settings → Trusted Publisher →
   GitHub Actions: repository `freema/drobek-module-counter`, workflow
   `ci.yml` (no environment).
3. Set the repository variable `NPM_PUBLISH=true` (Settings → Secrets and
   variables → Actions → Variables).

From then on every `v*` tag publishes with OIDC (no token) and provenance; a
pre-release (`v0.2.0-rc.1`) goes to the dist-tag `next`, a version npm
already has is skipped.

## License

AGPL-3.0-only, like drobek — see [LICENSE](./LICENSE).
