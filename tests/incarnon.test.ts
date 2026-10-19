/**
 * Melee Incarnon data tests.
 *
 * Melee weapons do not have an attack called "Incarnon Form": the wiki names the transformed
 * attacks "Spectral Axe", "Spectral Dagger" and "Spectral Blade", each with an "... Explosion"
 * child. Reading only "Incarnon Form" left every melee weapon without a transformed profile.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { resolveBuild } from '../src/engine/build.ts';

const snapshot = loadSnapshot();

test('the five melee Incarnon forms carry the wiki spectral stats', () => {
  // Attack table of module-weapons-melee.lua, cross-checked on each weapon's Incarnon Genesis
  // page: Ceramic Dagger's notes say the spectral dagger deals 350 damage, for example.
  const expected: Record<string, { impact: number; puncture: number; slash: number; critChance: number; fireRate: number }> = {
    'Ack & Brunt': { impact: 29.8, puncture: 14.9, slash: 104.3, critChance: 0.13, fireRate: 0.833 },
    'Ceramic Dagger': { impact: 35, puncture: 116.67, slash: 198.33, critChance: 0.1, fireRate: 1 },
    Hate: { impact: 19.5, puncture: 19.5, slash: 91, critChance: 0.3, fireRate: 0.917 },
    Okina: { impact: 21, puncture: 49, slash: 70, critChance: 0.16, fireRate: 1.08 },
    'Okina Prime': { impact: 27.6, puncture: 64.4, slash: 92, critChance: 0.3, fireRate: 1.17 },
  };
  for (const [name, want] of Object.entries(expected)) {
    const form = snapshot.weapons[name]?.incarnonForm;
    assert.ok(form, `${name} should carry an Incarnon profile`);
    assert.equal(form!.impact, want.impact);
    assert.equal(form!.puncture, want.puncture);
    assert.equal(form!.slash, want.slash);
    assert.equal(form!.critChance, want.critChance);
    assert.equal(form!.fireRate, want.fireRate);
    // Spectral direct hits are not affected by melee damage mods (wiki), which will matter
    // once the model applies that rule; at least the profile must not be the base weapon.
    assert.notDeepEqual(form!, snapshot.weapons[name].stats);
  }
  // The explosion is a second hit on the same shot, kept separate instead of dropped.
  assert.deepEqual(snapshot.weapons['Ceramic Dagger'].incarnonFormExtra,
    [{ name: 'Spectral Dagger Explosion', damage: { Heat: 350 } }]);
});

test('a melee form can be used without an evolution selection', () => {
  // Okina Prime inherits Okina's tree, but the form is usable even with no perks picked.
  const resolved = resolveBuild(snapshot, { weapon: 'Ceramic Dagger', mods: [], incarnon: ['form'] });
  assert.equal(resolved.damage.projectileTotal, 350); // spectral dagger only
  assert.ok(resolved.incarnonLines.includes('form only, no evolution perks'));
  assert.ok(resolved.incarnonLines.some((line) => /Spectral Dagger Explosion not modelled \(\+350 Heat\)/.test(line)),
    `expected the unmodelled explosion in ${JSON.stringify(resolved.incarnonLines)}`);
});

test('Incarnon option names keep apostrophes and EVO1 is not an option', () => {
  // The name regex once excluded apostrophes, so "Templar's Wrath" fell through to the first
  // bold number in the row ("+150"). EVO1 describes the transformation, not a choice.
  const names = (snapshot.incarnons['Hate'] ?? []).map((option) => option.name);
  assert.ok(names.includes("Stalker's Legacy"), `expected Stalker's Legacy in ${names.join(', ')}`);
  assert.ok(names.every((name) => !/^[+\d]/.test(name)), `option names should be names: ${names.join(', ')}`);
  assert.ok((snapshot.incarnons['Hate'] ?? []).every((option) => option.tier !== 'EVO1'));
});
