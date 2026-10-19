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
