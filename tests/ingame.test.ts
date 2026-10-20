/**
 * Golden tests taken from the game itself.
 *
 * These use the real snapshot on purpose: they are the only assertions tied to what the
 * arsenal and the damage numbers actually show, so a data drift that changes them should
 * fail loudly.
 *
 * Evidence and method: docs/verified-in-game.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild } from '../src/engine/build.ts';
import { scaleEnemy } from '../src/engine/enemy.ts';
import { hitEnemy } from '../src/engine/damage.ts';

const snapshot = loadSnapshot();
const close = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);

/** The game shows the sum of integers per damage type. */
function displayed(hit: ReturnType<typeof hitEnemy>, crit = 1): number {
  return hit.breakdown.reduce((sum, entry) => sum + Math.floor(entry.toHealth * crit), 0);
}

test('Damage 3.0: Soma Prime + Serration + Stormbringer vs a level 102 Bombard shows 5 and 18', () => {
  // Damage 3.0 (Update 36) removed the Damage 2.0 health-type table this capture was taken
  // under. Grineer is neutral to Electricity now, so the crit total moves from 19 to 18;
  // the normal hit stays at 5 through the per-type floor. The old reading is kept in
  // docs/verified-in-game.md for the record.
  const resolved = resolveBuild(snapshot, {
    weapon: 'Soma Prime',
    mods: ['Serration', 'Stormbringer'],
  });
  const bombard = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 102);
  const hit = hitEnemy(snapshot, resolved, bombard);

  close(displayed(hit), 5);
  close(displayed(hit, 3), 18);
});

test('in game: an unmodded Soma Prime floors to 3 damage against the armour cap', () => {
  // Level 101 Elite Frontier Lancer, 2700 armour: every damage type falls below 1, and the
  // wiki's minimum of 1 per type makes it exactly 3.
  const resolved = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: [] });
  const lancer = scaleEnemy(snapshot, snapshot.enemies['Elite Frontier Lancer'], 101);
  const hit = hitEnemy(snapshot, resolved, lancer);
  close(displayed(hit), 3);
});

test('Damage 3.0: an unmodded Soma Prime deals 6 against a level 27 Drekar Elite Lancer', () => {
  // The Damage 2.0 capture said 8, because Slash was +25% against Cloned Flesh and Impact
  // -25%. Grineer now takes +50% Impact and is neutral to Slash, so the display reads 6.
  const resolved = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: [] });
  const lancer = scaleEnemy(snapshot, snapshot.enemies['Drekar Elite Lancer'], 27);
  const hit = hitEnemy(snapshot, resolved, lancer);
  close(displayed(hit), 6);
});

test('a level 80 Lancer uses the Grineer curve, not the neutral one', () => {
  // Beta review, 2026-10-20: WFCD reports the weapon class ("Rifle") as `type` for a handful
  // of enemies, which left Lancer, Trooper, Crewman and Corrupted Lancer without a faction.
  // They fell back to the neutral curve and read 9,635 hp at level 80 instead of 24,791.
  const lancer = snapshot.enemies['Lancer'];
  assert.equal(lancer.faction, 'grineer');
  assert.equal(lancer.healthClass, 'Grineer');
  close(scaleEnemy(snapshot, lancer, 80).health, 24791.427612304688, 1e-9);

  const corrupted = snapshot.enemies['Corrupted Lancer'];
  assert.equal(corrupted.faction, 'orokin');
  assert.equal(corrupted.healthClass, 'Orokin');
  close(scaleEnemy(snapshot, corrupted, 80).health, 12789.396057128906, 1e-9);
});

test('every enemy resolves a faction and a Damage 3.0 health class', () => {
  const missing = Object.values(snapshot.enemies).filter((enemy) => !enemy.faction || !enemy.healthClass);
  assert.deepEqual(missing.map((enemy) => enemy.name), []);
});

test('the faction table comes from Damage 3.0, not the deprecated health types', () => {
  // Grineer is +50% Corrosive and neutral to Radiation; the Damage 2.0 table had Radiation +75
  // against Alloy Armor. This is the assertion that fails if the parse regresses.
  assert.equal(snapshot.modifiers.corrosive?.Grineer, 50);
  assert.equal(snapshot.modifiers.radiation?.Grineer ?? 0, 0);
  assert.equal(snapshot.modifiers.radiation?.Orokin, -50);
  assert.equal(snapshot.modifiers.void?.Overguard, 50);
  assert.equal(snapshot.modifiers.corrosive?.['Alloy Armor'], undefined);
});
