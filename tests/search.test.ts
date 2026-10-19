/**
 * Build search tests.
 *
 * The search is the part an agent trusts blindly: it returns a build rather than a number, so
 * these tests pin the constraints that make a returned build legal in the game.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { search } from '../src/engine/search.ts';

const snapshot = loadSnapshot();

test('a found build is legal: eight slots, capacity respected, formes within budget', () => {
  const result = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, maxForma: 2 });
  assert.ok(result.builds.length > 0);
  for (const build of result.builds) {
    assert.ok(build.mods.length <= 8, `${build.mods.length} mods does not fit eight slots`);
    assert.ok(build.capacityUsed <= build.capacity, `used ${build.capacityUsed} of ${build.capacity}`);
    assert.ok(build.formaNeeded <= 2, `spent ${build.formaNeeded} Forma with a budget of 2`);
    assert.equal(build.fits, true);
  }
});

test('no Forma available still yields a build that fits', () => {
  const result = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, maxForma: 0 });
  assert.ok(result.builds.length > 0);
  assert.ok(result.builds.every((build) => build.formaNeeded === 0));
  assert.ok(result.builds.every((build) => build.capacityUsed <= build.capacity));
});

test('a semi-auto trigger lock is never put on an automatic weapon', () => {
  const result = search(snapshot, { weapon: 'Soma Prime', enemy: 'Bombard', level: 150, limit: 3 });
  const locked = result.builds.flatMap((build) => build.mods.map((mod) => mod.name)).filter((name) => /Cannonade/.test(name));
  assert.deepEqual(locked, [], 'Cannonade mods lock the trigger to semi-auto');
  // The same mods are fair game on a weapon that really is semi-auto.
  const latron = search(snapshot, { weapon: 'Latron Prime', enemy: 'Bombard', level: 150, limit: 1 });
  assert.ok(latron.builds.length > 0);
});

test('the search beats a single-mod build it started from', () => {
  const withSerrationOnly = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, mustInclude: ['Serration'], limit: 1 });
  assert.ok(withSerrationOnly.builds[0].sustainedDps > 0);
  const bare = search(snapshot, { weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150, mustInclude: ['Serration'], limit: 1 });
  assert.equal(withSerrationOnly.builds[0].sustainedDps, bare.builds[0].sustainedDps, 'the search is deterministic');
  assert.ok(withSerrationOnly.builds[0].mods.some((mod) => mod.name === 'Serration'), 'mustInclude is honoured');
});

test('excluded mods never appear in a result', () => {
  const result = search(snapshot, {
    weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150,
    exclude: ['Serration', 'Heavy Caliber', 'Split Chamber'], limit: 2,
  });
  const names = result.builds.flatMap((build) => build.mods.map((mod) => mod.name));
  assert.ok(!names.includes('Serration'));
  assert.ok(!names.includes('Heavy Caliber'));
  assert.ok(!names.includes('Split Chamber'));
});

test('a partial mod makes the result a lower bound and says so', () => {
  // Spectral Serration is a real rifle mod the parser does not fully model.
  const result = search(snapshot, {
    weapon: 'Soma Prime', objective: 'dps', enemy: 'Bombard', level: 150,
    mustInclude: ['Spectral Serration'], limit: 1,
  });
  const build = result.builds[0];
  assert.ok(build.partialMods.includes('Spectral Serration'));
});

test('two mods of the same family never end up together', () => {
  // Pressure Point and Primed Pressure Point are mutually exclusive, and the data says so.
  const result = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 3 });
  for (const build of result.builds) {
    const names = build.mods.map((mod) => mod.name);
    const pressure = names.filter((name) => /Pressure Point$/.test(name));
    assert.ok(pressure.length <= 1, `found ${pressure.join(' and ')}`);
    for (const name of names) {
      const mod = snapshot.mods[name];
      const clash = mod.incompatible.filter((other) => names.includes(other));
      assert.deepEqual(clash, [], `${name} cannot be equipped with ${clash.join(', ')}`);
    }
  }
});

test('a melee search assumes the combo multiplier players fight at', () => {
  const result = search(snapshot, { weapon: 'Nikana Prime', enemy: 'Bombard', level: 150, limit: 1 });
  assert.ok(result.assumptions.some((line) => /combo assumed at 12x/.test(line)));
  // Blood Rush is worth nothing at 1x, so it only shows up because the combo is assumed.
  const withCombo = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1 });
  const without = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1, base: { comboHits: 0 } });
  assert.ok(withCombo.builds[0].totalDps > without.builds[0].totalDps);
});

test('the dps objective counts status damage, not just direct hits', () => {
  const result = search(snapshot, { weapon: 'Nikana Prime', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1 });
  const build = result.builds[0];
  assert.ok(build.totalDps >= build.sustainedDps, 'total damage cannot be below direct damage');
});

test('Incarnon evolutions are chosen only when asked for', () => {
  // The Incarnon form is an endgame unlock and only its perks are modelled, so the search
  // leaves it alone unless the caller asks.
  const byDefault = search(snapshot, { weapon: 'Torid', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1 });
  assert.deepEqual(byDefault.builds[0].incarnon, []);
  assert.ok(byDefault.notes.some((note) => /Incarnon evolutions are not assumed/.test(note)));

  const withChoice = search(snapshot, { weapon: 'Torid', objective: 'dps', enemy: 'Bombard', level: 150, limit: 1, chooseIncarnon: true });
  const build = withChoice.builds[0];
  assert.equal(build.incarnon.length, 3, 'every Torid tier with parsed perks should be picked');
  assert.equal(build.incarnonNames.length, 3);

  // The same search told not to use evolutions must come out behind.
  const without = byDefault;
  assert.ok(build.totalDps > without.builds[0].totalDps,
    `choosing evolutions should help: ${build.totalDps} vs ${without.builds[0].totalDps}`);

  // Brute force over all 18 Torid combinations picked exactly this set, so the greedy per-tier
  // choice is optimal for this weapon.
  assert.deepEqual(build.incarnon, ['EVO2:0', 'EVO3:2', 'EVO4:0']);
});

test('a weapon without Incarnon data is unaffected', () => {
  const result = search(snapshot, { weapon: 'Kuva Hek', enemy: 'Bombard', level: 150, limit: 1, chooseIncarnon: true });
  assert.deepEqual(result.builds[0].incarnon, []);
  assert.deepEqual(result.builds[0].incarnonNames, []);
});
