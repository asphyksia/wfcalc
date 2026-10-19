/**
 * CLI contract tests.
 *
 * An AI agent drives this tool, so the JSON has to be machine-readable and stable: these tests
 * fail if a listing command stops emitting a parseable payload or loses a field an agent needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wfcalc', import.meta.url));

const run = (args: string[]): unknown => {
  const out = execFileSync(BIN, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
};

test('listing commands emit parseable JSON', () => {
  const weapons = run(['weapons', 'Soma', '--json']) as Array<{ name: string }>;
  assert.ok(weapons.length > 0);
  assert.ok(weapons.every((w) => typeof w.name === 'string'));

  const mods = run(['mods', 'Soma', '--json']) as { weapon: string; count: number; mods: Array<{ name: string; partial: boolean }> };
  assert.equal(mods.weapon, 'Soma');
  assert.equal(mods.count, mods.mods.length);
  // partial is how an agent knows a number is a lower bound rather than the real value.
  assert.ok(mods.mods.every((m) => typeof m.partial === 'boolean'));

  for (const [command, args] of [
    ['enemies', ['Bombard', '--json']],
    ['arcanes', ['--json']],
    ['buffs', ['--json']],
    ['rivens', ['--json']],
    ['incarnon', ['Torid', '--json']],
  ] as const) {
    const payload = run([command, ...args]);
    assert.ok(payload, `${command} produced nothing`);
  }
});

test('fusion cores and Operator arcanes are not weapon candidates', () => {
  const mods = run(['mods', 'Soma', '--json']) as { mods: Array<{ name: string; classes: string[] }> };
  const junk = mods.mods.filter((m) => /Core$|Transmute Core/.test(m.name) || m.classes.includes('Antique'));
  assert.deepEqual(junk.map((m) => m.name), [], 'candidate list carries non-equippable entries');
});

test('calc reports the time to kill an agent can quote', () => {
  const result = run(['calc', 'Soma', '--mod', 'Serration', '--mod', 'Stormbringer', '--enemy', 'Bombard', '--level', '102', '--json']) as {
    sustainedDps: number;
    timeToKill: number | null;
    warnings: string[];
    unsupportedMods: string[];
  };
  assert.ok(result.sustainedDps > 0);
  assert.ok(result.timeToKill === null || result.timeToKill > 0);
  assert.ok(Array.isArray(result.warnings) && Array.isArray(result.unsupportedMods));
});

test('an unknown weapon fails loudly instead of returning an empty build', () => {
  assert.throws(() => run(['mods', 'NotAWeaponAtAll', '--json']));
});
