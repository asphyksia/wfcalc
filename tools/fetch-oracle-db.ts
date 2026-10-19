/**
 * Downloads Overframe's item/mod/arcane database.
 *
 * Overframe's HTML is behind Cloudflare, but its Next.js static host is not. The game
 * database ships as lazily-loaded webpack chunks named `db/items`, `db/mods`, `db/rivens`…
 * whose filenames (and hashes) are listed in the current webpack runtime chunk.
 *
 * Chain of trust:
 *   1. `overframe.gg/static/manifest.json` returns the app HTML (no Cloudflare) → gives the
 *      current `webpack-<hash>.js` URL.
 *   2. That runtime contains the chunk name → hash map.
 *   3. `static/chunks/db/mods.<hash>.js` holds every mod AND arcane keyed by Lotus path,
 *      each entry carrying `id`, `name` and `categories`.
 *
 * No hashes are hardcoded, so an Overframe deploy does not break this.
 *
 * Run: node tools/fetch-oracle-db.ts
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

const ROOT = new URL('..', import.meta.url).pathname;
const RAW = join(ROOT, 'data/raw');
const OUT = join(RAW, 'overframe-db.json');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) wfcalc/0.1';

async function get(url: string, allowNotFound = false): Promise<string> {
  const response = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(60_000),
  });
  // `overframe.gg/static/manifest.json` deliberately 404s but serves the app shell, which is
  // where the current webpack runtime URL lives.
  if (!response.ok && !(allowNotFound && response.status === 404)) {
    throw new Error(`${response.status} for ${url}`);
  }
  return response.text();
}

/** Runs a webpack chunk and returns the modules it exports. */
function loadChunk(source: string): Record<string, any> {
  const sandbox: any = { self: { webpackChunk_N_E: [] }, window: undefined, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { timeout: 30_000 });

  const out: Record<string, any> = {};
  for (const push of sandbox.self.webpackChunk_N_E as any[]) {
    const modules = push[1] ?? {};
    for (const fn of Object.values<any>(modules)) {
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

/** Finds the current webpack runtime URL from the app HTML. */
async function findRuntime(): Promise<string> {
  const html = await get('https://overframe.gg/static/manifest.json', true);
  const match = /https:\/\/static\.overframe\.gg\/_next\/static\/chunks\/webpack-[a-f0-9]+\.js/.exec(html);
  if (!match) throw new Error('could not find the webpack runtime in the app HTML');
  return match[0];
}

/** `p.u = e => "static/chunks/" + ({name map})[e] + "." + ({hash map})[e] + ".js"` */
function chunkUrlFor(runtime: string, chunkName: string): string {
  const nameEntry = new RegExp(`({[^}]*})`).exec(runtime)?.[0] ?? '';
  // The runtime has two literal maps: id -> "db/name" and id -> hash. Find the id whose
  // name matches, then locate that id in the second map.
  const nameMap = new Map<string, string>();
  for (const pair of runtime.matchAll(/(\d+):"(db\/[a-z]+)"/g)) nameMap.set(pair[2], pair[1]);
  const id = nameMap.get(chunkName);
  if (!id) throw new Error(`chunk ${chunkName} not present in the runtime map`);

  const hashMap = new Map<string, string>();
  for (const pair of runtime.matchAll(/(\d+):"([a-f0-9]{16,20})"/g)) hashMap.set(pair[1], pair[2]);
  const hash = hashMap.get(id);
  if (!hash) throw new Error(`no hash for chunk id ${id}`);
  return `https://static.overframe.gg/_next/static/chunks/${chunkName}.${hash}.js`;
}

async function main(): Promise<void> {
  await mkdir(RAW, { recursive: true });
  const runtimeUrl = await findRuntime();
  const runtime = await get(runtimeUrl);
  console.log(`runtime: ${runtimeUrl.split('/').pop()}`);

  const out: { mods: Record<string, string>; arcanes: Record<string, string>; items: Record<string, string> } = {
    mods: {},
    arcanes: {},
    items: {},
  };

  for (const [chunk, bucket] of [['db/mods', 'mods'], ['db/items', 'items']] as const) {
    const entries = loadChunk(await get(chunkUrlFor(runtime, chunk)));
    let count = 0;
    for (const entry of Object.values<any>(entries)) {
      if (!entry || typeof entry !== 'object' || entry.id === undefined || !entry.name) continue;
      const categories: string[] = entry.categories ?? [];
      // db/mods holds both mods and arcanes; `categories` is the reliable discriminator.
      if (bucket === 'mods') {
        if (categories.includes('arcane')) out.arcanes[String(entry.id)] = entry.name;
        else if (categories.includes('mod')) out.mods[String(entry.id)] = entry.name;
        else continue;
      } else {
        out.items[String(entry.id)] = entry.name;
      }
      count++;
    }
    console.log(`${chunk}: ${count} entries`);
  }

  await writeFile(OUT, JSON.stringify(out) + '\n');
  console.log(`\nmods ${Object.keys(out.mods).length}, arcanes ${Object.keys(out.arcanes).length}, items ${Object.keys(out.items).length} -> data/raw/overframe-db.json`);
  // Sanity anchors, so a silent schema change is noticed.
  const check = (map: Record<string, string>, id: string, expected: string) => {
    const actual = map[id];
    console.log(`  ${actual === expected ? 'ok  ' : 'WARN'} ${id} = ${actual ?? 'missing'} (expected ${expected})`);
  };
  check(out.mods, '626', 'Serration');
  check(out.mods, '5520', 'Galvanized Chamber');
  check(out.arcanes, '7181', 'Primary Crux');
  check(out.items, '8015', 'Haalvu');
}

await main();
