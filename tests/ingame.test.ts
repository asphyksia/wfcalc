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

test('in game: Soma Prime + Serration + Stormbringer vs a level 102 Bombard shows 5 and 19', () => {
  // Read off the screen in game: 5 damage on a normal hit, 19 on a yellow (x3) crit.
  const resolved = resolveBuild(snapshot, {
    weapon: 'Soma Prime',
    mods: ['Serration', 'Stormbringer'],
  });
  const bombard = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 102);
  const hit = hitEnemy(snapshot, resolved, bombard);

  // Per-type values are 1.00 / 2.17 / 1.99 / 1.97 before truncation.
  close(displayed(hit), 5);
  close(displayed(hit, 3), 19);
});

test('in game: an unmodded Soma Prime floors to 3 damage against the armour cap', () => {
  // Level 101 Elite Frontier Lancer, 2700 armour: every damage type falls below 1, and the
  // wiki's minimum of 1 per type makes it exactly 3.
  const resolved = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: [] });
  const lancer = scaleEnemy(snapshot, snapshot.enemies['Elite Frontier Lancer'], 101);
  const hit = hitEnemy(snapshot, resolved, lancer);
  close(displayed(hit), 3);
});

test('in game: an unmodded Soma Prime shows 8 against a level 27 Drekar Elite Lancer', () => {
  const resolved = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: [] });
  const lancer = scaleEnemy(snapshot, snapshot.enemies['Drekar Elite Lancer'], 27);
  const hit = hitEnemy(snapshot, resolved, lancer);
  close(displayed(hit), 8);
});
