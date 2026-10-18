/**
 * Loader for Overframe's webpack data chunks.
 *
 * Overframe's Next.js host is not behind Cloudflare, and its game database ships as lazily
 * loaded chunks (`db/items`, `db/mods`, ...). The chunk filenames live in the current
 * webpack runtime, which the app shell links, so nothing here is hardcoded.
 */
import vm from 'node:vm';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) wfcalc/0.1';

export async function get(url: string, allowNotFound = false): Promise<string> {
  const response = await fetch(url, { headers: { 'user-agent': UA } });
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    throw new Error(`${response.status} for ${url}`);
  }
  return response.text();
}

/** Runs a webpack chunk in a sandbox and returns every module export merged. */
export function loadChunk(source: string): Record<string, any> {
  const sandbox: any = { self: { webpackChunk_N_E: [] }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 60_000 });

  const out: Record<string, any> = {};
  for (const push of sandbox.self.webpackChunk_N_E as any[]) {
    for (const fn of Object.values<any>(push[1] ?? {})) {
      const module = { exports: {} as any };
      try {
        fn(module);
      } catch {
        continue;
      }
      if (module.exports && typeof module.exports === 'object') Object.assign(out, module.exports);
    }
  }
  return out;
}

/** Finds the current webpack runtime URL from the app shell. */
async function findRuntime(): Promise<string> {
  const html = await get('https://overframe.gg/static/manifest.json', true);
  const match = /https:\/\/static\.overframe\.gg\/_next\/static\/chunks\/webpack-[a-f0-9]+\.js/.exec(html);
  if (!match) throw new Error('could not find the webpack runtime in the app shell');
  return match[0];
}

function chunkUrl(runtime: string, chunkName: string): string {
  const ids = new Map<string, string>();
  for (const pair of runtime.matchAll(/(\d+):"(db\/[a-z]+)"/g)) ids.set(pair[2], pair[1]);
  const id = ids.get(chunkName);
  if (!id) throw new Error(`chunk ${chunkName} missing from the runtime map`);
  const hashes = new Map<string, string>();
  for (const pair of runtime.matchAll(/(\d+):"([a-f0-9]{16,20})"/g)) hashes.set(pair[1], pair[2]);
  const hash = hashes.get(id);
  if (!hash) throw new Error(`no hash for chunk ${chunkName}`);
  return `https://static.overframe.gg/_next/static/chunks/${chunkName}.${hash}.js`;
}

export interface OverframeChunks {
  /** id -> name */
  mods: Record<string, string>;
  arcanes: Record<string, string>;
  /** id -> name */
  items: Record<string, string>;
  /** Lotus path -> game export blob, for drift checks. */
  itemsByPath: Record<string, any>;
}

/** Downloads and parses the mod/arcane/item chunks. */
export async function loadOverframeChunks(): Promise<OverframeChunks> {
  const runtime = await get(await findRuntime());
  const out: OverframeChunks = { mods: {}, arcanes: {}, items: {}, itemsByPath: {} };

  const modEntries = loadChunk(await get(chunkUrl(runtime, 'db/mods')));
  for (const entry of Object.values<any>(modEntries)) {
    if (!entry?.id || !entry.name) continue;
    const categories: string[] = entry.categories ?? [];
    if (categories.includes('arcane')) out.arcanes[String(entry.id)] = entry.name;
    else if (categories.includes('mod')) out.mods[String(entry.id)] = entry.name;
  }

  const itemEntries = loadChunk(await get(chunkUrl(runtime, 'db/items')));
  for (const [path, entry] of Object.entries<any>(itemEntries)) {
    if (!entry?.id || !entry.name) continue;
    out.items[String(entry.id)] = entry.name;
    if (entry.data) out.itemsByPath[path] = entry.data;
  }

  return out;
}
