/**
 * Mod coverage tests.
 *
 * `partial` means "at least one line of this mod is not understood", which makes a result a
 * lower bound. Utility lines (range, secondary-weapon buffs, Tennokai, armour chipping) are out
 * of scope, not unknown: marking them partial hid the real gaps and made good builds look weak.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';

const snapshot = loadSnapshot();

test('bow and melee utility mods are not marked partial', () => {
  for (const name of ['Split Flights', 'Plan B', 'Spring-Loaded Blade', 'Stand Ground', 'Tek Gravity', 'Shattering Impact', "Truth's Flame"]) {
    assert.equal(snapshot.mods[name]?.partial, false, `${name} should be fully understood`);
  }
  // Split Flights' multishot is the reason it matters, and it is applied.
  const split = snapshot.mods['Split Flights'];
  assert.ok(split.effects.some((effect) => effect.target === 'multishot' && effect.value === 1));
  // The only remaining partial Melee mod is Strain Infection (crit damage per Cyst), which is
  // a real conditional damage effect that still needs a flag.
  assert.equal(snapshot.mods['Strain Infection'].partial, true);
  const partials = (classes: string) => Object.values(snapshot.mods)
    .filter((mod) => (mod.classes ?? []).includes(classes) && mod.partial).length;
  assert.equal(partials('Bow'), 0);
  assert.equal(partials('Melee'), 1);
});
