# counter — named counters on the server (page views, likes, downloads)

## 1. When to use

The app counts something every visitor shares: page views, likes, downloads,
votes for an option. One call adds 1 and returns the new total; the count
lives on the server, not in the browser. Not for per-user data or records
with fields (use `skill_info('data')`), and not for analytics with
dimensions: a counter is one number per key.

## 2. Minimal working code

```ts
// src/main.ts — the bare `drobek` import is the platform SDK (no install).
import { drobek, DrobekError } from 'drobek';

const views = document.querySelector<HTMLSpanElement>('#views')!;
const likes = document.querySelector<HTMLSpanElement>('#likes')!;
const likeButton = document.querySelector<HTMLButtonElement>('#like')!;

// One page view per load; show the like count without adding to it.
drobek.counter.hit('page-views').then((c) => (views.textContent = String(c.count)));
drobek.counter.get('likes').then((c) => (likes.textContent = String(c.count)));

likeButton.addEventListener('click', async () => {
  likeButton.disabled = true;
  try {
    const { count } = await drobek.counter.hit('likes');
    likes.textContent = String(count);
  } catch (err) {
    // err.code: see "Errors → fix"
    likes.title = err instanceof DrobekError && err.code === 'rate_limited' ? 'Slow down a little.' : String(err);
  } finally {
    likeButton.disabled = false;
  }
});
```

No configuration is needed for this. To let every visitor see all counters
(a leaderboard), open `list` — the owner confirms it:

```json
{ "app_id": "…", "module": "counter", "config": { "list": "public", "maxKeys": 200 } }
```

## 3. API and types

```ts api
// drobek.counter
export interface Counter {
  key: string;
  count: number;
}
export interface CounterEntry extends Counter {
  /** ISO timestamp of the last hit */
  updated_at: string;
}
export interface Api {
  /** Add 1 to the counter `key` (created at 0 on its first hit); rate-limited (COUNTER_HITS_PER_IP_MINUTE per visitor IP). */
  hit(key: string): Promise<Counter>;
  /** The counter `key`; count 0 when it was never hit. */
  get(key: string): Promise<Counter>;
  /** Every counter of the app, by key; allowed by the config rule `list` (default: app admins only). */
  list(): Promise<{ counters: CounterEntry[]; max_keys: number }>;
}
```

A key is 1–64 characters of `a-z 0-9 . _ -`, starting with a letter or
digit: `page-views`, `likes.post-42`, `downloads.v1.2`. Use one key per
thing counted (`likes.<id>` per item).

HTTP (what the SDK calls): `POST /__drobek/v1/counter/<key>/hit`,
`GET /__drobek/v1/counter/<key>`, `GET /__drobek/v1/counter`. Only the app
itself may call `hit` (same origin; the SDK sends `X-Drobek-SDK: 1`).

Config (configure_module takes a partial config; `null` resets a key):

- `maxKeys` (1–10000, default 100): the most distinct keys the app keeps.
  Applies immediately.
- `list`: who may call `list()` — `"admin"` (default: app admins signed in
  through the `auth` module), `"user"` (any signed-in end user) or
  `"public"` (anyone). **Widening it needs the app owner's confirmation**:
  configure_module answers `applied: false` with a `confirm_url` — give the
  user that link. `hit` and `get` are always public.

## 4. Rules and limits

- `hit` is limited to `COUNTER_HITS_PER_IP_MINUTE` calls per visitor IP per
  minute (default 60) and `COUNTER_HITS_PER_APP_MINUTE` per app (default
  6000); the operator may set other values per workspace.
- A hit is atomic: concurrent hits never lose a count. Counts only go up;
  there is no reset or decrement from the app.
- The first hit of a new key fails once the app keeps `maxKeys` keys; hits
  of existing keys keep working.
- A hit is not deduplicated: call `hit` once per event (e.g. once per page
  load), not in a render loop.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `invalid_counter_key` (400) | the key has upper case, spaces or other characters, or is over 64 | use a key like `page-views` |
| `too_many_counters` (409) | a new key while the app keeps `maxKeys` keys | reuse keys; the owner can raise `maxKeys` |
| `rate_limited` | too many hits from one visitor or for the app | retry after `Retry-After` seconds |
| `unauthorized` | `list()` needs a signed-in user and nobody is signed in | sign in first (`skill_info('auth')`) |
| `forbidden` | `list()` with a signed-in user the `list` rule does not allow | open `list`, or sign in as an app admin |
| `csrf_rejected` | `hit` called with fetch from another origin or without the SDK | call through `drobek.counter` from the app itself |
