#!/usr/bin/env node
/**
 * Local web UI + JSON API.
 *
 *   node src/server.ts [--port 7777] [--host 127.0.0.1]
 *
 * No dependencies: a small http server that serves src/web/ and a handful of
 * JSON endpoints. The API is deliberately plain so that scripts and AI agents can
 * drive it the same way the browser does (see docs/api.md).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { loadSnapshot, findEnemy, findWeapon, modsForWeapon } from './data.ts';
import { resolveBuild, type Build } from './engine/build.ts';
import { scaleEnemy } from './engine/enemy.ts';
import { hitEnemy, statusProcs } from './engine/damage.ts';
import { availableBuffs } from './engine/buffs.ts';

const WEB_ROOT = new URL('./web/', import.meta.url).pathname;
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const hostArg = args.indexOf('--host');
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 7777;
const HOST = hostArg >= 0 ? args[hostArg + 1] : '127.0.0.1';

const snapshot = loadSnapshot();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Runs a build and returns everything the UI needs to render a report. */
function calculate(body: any) {
  const weaponQuery: string = body.weapon ?? '';
  const { item: weapon, suggestions } = findWeapon(snapshot, weaponQuery);
  if (!weapon) return { error: `weapon not found: ${weaponQuery}`, suggestions };

  const build: Build = {
    weapon: weapon.name,
    mods: Array.isArray(body.mods) ? body.mods : [],
    arcanes: Array.isArray(body.arcanes) ? body.arcanes : [],
    buffs: Array.isArray(body.buffs) ? body.buffs : [],
    abilityStrength: body.abilityStrength ? Number(body.abilityStrength) : undefined,
    frameMods: Array.isArray(body.frameMods) ? body.frameMods : [],
    incarnon: Array.isArray(body.incarnon) ? body.incarnon : [],
    aoeDistance: body.aoeDistance !== undefined ? Number(body.aoeDistance) : undefined,
    comboHits: body.comboHits ? Number(body.comboHits) : undefined,
    heavyAttack: Boolean(body.heavyAttack),
    riven: body.riven ?? undefined,
    debuffs: body.debuffs ?? {},
    mode: body.mode || undefined,
    conditions: body.conditions ?? {},
    headshot: Boolean(body.headshot),
  };
  const resolved = resolveBuild(snapshot, build);

  let target = null;
  if (body.enemy) {
    const { item: enemy, suggestions: enemySuggestions } = findEnemy(snapshot, body.enemy);
    if (!enemy) return { error: `enemy not found: ${body.enemy}`, suggestions: enemySuggestions };
    const scaled = scaleEnemy(snapshot, enemy, Number(body.level ?? 100));
    const hit = hitEnemy(snapshot, resolved, scaled);
    target = { name: enemy.name, faction: enemy.faction, pools: scaled.pools, ...hit };
  }

  return {
    weapon: {
      name: weapon.name,
      type: weapon.type,
      category: weapon.category,
      masteryRank: weapon.masteryRank,
      disposition: weapon.disposition,
      modClasses: weapon.modClasses,
      mode: resolved.mode?.name ?? null,
      modes: weapon.modes.map((m) => m.name),
    },
    build,
    damage: resolved.damage.perProjectile,
    projectileTotal: resolved.damage.projectileTotal,
    shotDamage: resolved.shotDamage,
    averageShotDamage: resolved.averageShotDamage,
    critChance: resolved.critChance,
    critMultiplier: resolved.critMultiplier,
    statusChance: resolved.statusChance,
    multishot: resolved.multishot,
    fireRate: resolved.fireRate,
    reloadTime: resolved.reloadTime,
    magazineSize: resolved.magazineSize,
    burstDps: resolved.burstDps,
    factionBonus: resolved.factionBonus,
    activeBuffs: resolved.activeBuffs,
    abilityStrength: resolved.abilityStrength,
    riven: resolved.rivenLines,
    incarnon: resolved.incarnonLines,
    comboMultiplier: resolved.comboMultiplier,
    sustainedDps: resolved.sustainedDps,
    elements: resolved.elements,
    procs: statusProcs(resolved),
    warnings: resolved.warnings,
    unsupportedMods: resolved.unsupportedMods,
    inactiveConditions: resolved.inactiveConditions,
    target,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  try {
    if (url.pathname === '/api/weapons') {
      const list = Object.values(snapshot.weapons)
        .map((w) => ({ name: w.name, category: w.category, type: w.type, masteryRank: w.masteryRank }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/enemies') {
      const list = Object.values(snapshot.enemies)
        .map((e) => ({ name: e.name, faction: e.faction, health: e.health, shield: e.shield, armor: e.armor }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/mods') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      if (!item) return json(res, 404, { error: `weapon not found: ${weaponName}` });
      const list = modsForWeapon(snapshot, item)
        .filter((m) => !m.conclave)
        .map((m) => ({
          name: m.name,
          maxRank: m.maxRank,
          polarity: m.polarity,
          description: m.description,
          partial: m.partial,
          baseDrain: m.baseDrain,
          rarity: m.rarity,
          set: m.set,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/incarnons') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      if (!item) return json(res, 404, { error: `weapon not found: ${weaponName}` });
      return json(res, 200, snapshot.incarnons[item.name] ?? []);
    }
    if (url.pathname === '/api/buffs') {
      return json(res, 200, availableBuffs(snapshot));
    }
    if (url.pathname === '/api/arcanes') {
      const weaponName = url.searchParams.get('weapon') ?? '';
      const { item } = findWeapon(snapshot, weaponName);
      const slots: Record<string, string[]> = {
        primary: ['primary', 'bow', 'shotgun'],
        secondary: ['secondary'],
        melee: ['melee'],
        archgun: ['primary'],
        archmelee: ['melee'],
      };
      const allowed = item ? (slots[item.category] ?? []) : ['primary', 'secondary', 'melee', 'bow', 'shotgun'];
      const list = Object.values(snapshot.arcanes)
        .filter((arcane) => arcane.slot && allowed.includes(arcane.slot))
        .map((arcane) => ({ name: arcane.name, slot: arcane.slot, maxRank: arcane.maxRank, description: arcane.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, list);
    }
    if (url.pathname === '/api/calc' && req.method === 'POST') {
      const body = await readBody(req);
      const result = calculate(body);
      return json(res, result.error ? 404 : 200, result);
    }

    // Static files.
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const path = join(WEB_ROOT, normalize(relative).replace(/^(\.\.[/\\])+/, ''));
    const file = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    return res.end(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    console.error(error);
    return json(res, 500, { error: String(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`wfcalc web UI: http://${HOST}:${PORT}`);
  console.log(`data: ${Object.keys(snapshot.weapons).length} weapons, ${Object.keys(snapshot.mods).length} mods, ${Object.keys(snapshot.enemies).length} enemies`);
});
