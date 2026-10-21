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
    [{ name: 'Spectral Dagger Explosion', damage: { Heat: 350 }, falloff: { start: 0, end: 4, reduction: 0.3 } }]);
});

test('a melee form can be used without an evolution selection', () => {
  // Okina Prime inherits Okina's tree, but the form is usable even with no perks picked.
  const resolved = resolveBuild(snapshot, { weapon: 'Ceramic Dagger', mods: [], incarnon: ['form'] });
  // Per dagger: 350 direct + its 350 Heat explosion at the blast centre.
  assert.equal(resolved.damage.projectileTotal, 700);
  // The heavy attack fires a flurry of 2 daggers (wiki), so one attack is two of those.
  assert.equal(resolved.multishot, 2);
  assert.equal(resolved.shotDamage, 1400);
  assert.ok(resolved.incarnonLines.includes('form only, no evolution perks'));
  assert.ok(resolved.incarnonLines.some((line) => /Spectral Dagger Explosion included at the blast centre/.test(line)),
    `expected the explosion in ${JSON.stringify(resolved.incarnonLines)}`);
});

test('Incarnon option names keep apostrophes and EVO1 is not an option', () => {
  // The name regex once excluded apostrophes, so "Templar's Wrath" fell through to the first
  // bold number in the row ("+150"). EVO1 describes the transformation, not a choice.
  const names = (snapshot.incarnons['Hate'] ?? []).map((option) => option.name);
  assert.ok(names.includes("Stalker's Legacy"), `expected Stalker's Legacy in ${names.join(', ')}`);
  assert.ok(names.every((name) => !/^[+\d]/.test(name)), `option names should be names: ${names.join(', ')}`);
  assert.ok((snapshot.incarnons['Hate'] ?? []).every((option) => option.tier !== 'EVO1'));
});

test('spectral direct hits ignore melee damage bonuses but keep Condition Overload', () => {
  // Wiki (Ceramic Dagger, Hate, Okina pages): spectral hits are not affected by Pressure
  // Point, the stance or the combo multiplier, while direct hits *are* affected by Condition
  // Overload, whose multiplier only scales the direct share (350 of the 700 per dagger):
  // direct 350 x 3.4 + explosion 350 = 1540 per dagger, so 3080 for the two-dagger attack.
  const resolved = resolveBuild(snapshot, {
    weapon: 'Ceramic Dagger',
    mods: ['Pressure Point', 'Condition Overload'],
    incarnon: ['form'],
    conditions: { statusTypes: 3 },
    comboHits: 220,
    heavyAttack: true,
  });
  assert.ok(Math.abs(resolved.damage.projectileTotal - 1540) < 1e-6,
    `expected 1540 per dagger, got ${resolved.damage.projectileTotal}`);
  assert.ok(resolved.inactiveConditions.some((line) => /Pressure Point/.test(line)),
    `Pressure Point should be reported as inactive: ${JSON.stringify(resolved.inactiveConditions)}`);
  // No 12x heavy multiplier, but the pair of daggers still counts.
  assert.ok(Math.abs(resolved.shotDamage - 3080) < 1e-6, `expected 3080 per attack, got ${resolved.shotDamage}`);
});

test('the Incarnon second hit follows falloff', () => {
  // Braton's form is 50 direct + 50 Heat AoE at the centre; at 3 m the AoE keeps 90%.
  const at = (distance?: number) => resolveBuild(snapshot, {
    weapon: 'Braton', mods: [], incarnon: ['form'], aoeDistance: distance,
  }).damage.projectileTotal;
  assert.equal(at(0), 100);
  assert.ok(Math.abs(at(3) - 95) < 1e-9);
});

test('a gun Incarnon form is unaffected by the spectral rule', () => {
  const resolved = resolveBuild(snapshot, { weapon: 'Torid', mods: ['Serration'], incarnon: ['form'] });
  // 51 Toxin x 2.65 Serration: a ranged form still takes its damage mods.
  assert.ok(Math.abs(resolved.damage.projectileTotal - 51 * 2.65) < 1e-6);
  assert.ok(!resolved.incarnonLines.some((line) => /spectral/.test(line)));
});

test('only the Ceramic Dagger fires a second spectral dagger', () => {
  // Wiki: Ceramic Dagger "fires a flurry of 2 spectral daggers"; Hate launches 1 blade, the
  // Ack & Brunt one axe, and Okina's daggers come from kills (a different mechanic).
  const counts = Object.fromEntries(
    ['Ceramic Dagger', 'Hate', 'Ack & Brunt', 'Okina', 'Okina Prime']
      .map((name) => [name, snapshot.weapons[name].incarnonForm?.multishot]),
  );
  assert.deepEqual(counts, {
    'Ceramic Dagger': 2, Hate: 1, 'Ack & Brunt': 1, Okina: 1, 'Okina Prime': 1,
  });
});
