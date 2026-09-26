/**
 * The browser half of the module: the drobek server bundles it into
 * `/__drobek/sdk.js` as `drobek.counter`. It runs in the app's page — keep it
 * dependency-free (type imports only). The declared types are SDK_TYPES in
 * src/index.ts.
 */
import type { SdkCore } from '@drobek/modules';

export interface Counter {
  key: string;
  count: number;
}

export interface CounterEntry extends Counter {
  updated_at: string;
}

const path = (key: string) => `/${encodeURIComponent(key)}`;

export default function sdk(core: SdkCore) {
  return {
    hit: (key: string) => core.request<Counter>('POST', `${path(key)}/hit`),
    get: (key: string) => core.request<Counter>('GET', path(key)),
    list: () => core.request<{ counters: CounterEntry[]; max_keys: number }>('GET', '/'),
  };
}
