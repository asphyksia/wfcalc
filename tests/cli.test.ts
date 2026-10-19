/**
 * CLI contract tests.
 *
 * An AI agent drives this tool, so the JSON has to be machine-readable and stable: these tests
 * fail if a listing command stops emitting a parseable payload or loses a field an agent needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/wfcalc', import.meta.url));

const run = (args: string[]): unknown => {
  const out = execFileSync(BIN, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
};

const runRaw = (args: string[], input?: string) =>
  spawnSync(BIN, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, input, stdio: ['pipe', 'pipe', 'pipe'] });

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

test('armour strip flags change the answer, and bad values fail loudly', () => {
  const timeToKill = (extra: string[]): number => {
    const result = run(['calc', 'Soma Prime', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--json', ...extra]) as {
      timeToKill: number | null;
      armor: number;
    };
    return result.timeToKill ?? 0;
  };
  const bare = timeToKill([]);
  const oneCorrosive = timeToKill(['--cp', '1']);
  const fourCorrosive = timeToKill(['--cp', '4']);
  assert.ok(oneCorrosive < bare, 'one Corrosive Projection should help');
  assert.ok(fourCorrosive < oneCorrosive, 'four should help more');
  // Additive strips: Terrify at 60% plus one aura at 18% leaves 22% of the armour.
  assert.ok(timeToKill(['--strip-from', 'Terrify', '--cp', '1']) < timeToKill(['--strip-from', 'Terrify']));
  assert.throws(() => run(['calc', 'Soma Prime', '--cp', '9', '--json']));
});


test('--brief is one compact line for a calculation', () => {
  // The agent default: no per-type tree, no JSON, the numbers that answer the question.
  const result = runRaw(['calc', 'Kuva Bramma', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief']);
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1, `brief should be one line, got:\n${result.stdout}`);
  assert.match(lines[0], /^Kuva Bramma vs Bombard 150 · /);
  assert.match(lines[0], /total [\d,.]+ dps with status/);
  assert.match(lines[0], /ttk [\d,.]+s \([\d,.]+ shots\)/);
});

test('--brief search keeps the mod list and the assumptions', () => {
  const result = runRaw(['search', 'Soma Prime', '--enemy', 'Bombard', '--level', '150', '--top', '1', '--brief']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Soma Prime vs Bombard 150 · 1 of \d+ builds/);
  assert.match(result.stdout, /^1\. .*s · .* dps · \d+F · \d+\/\d+ cap/m);
  assert.match(result.stdout, /^   .*Serration/m, 'the answer must carry the mods');
  assert.match(result.stdout, /^assumptions: /m);
});

test('expected failures exit 2, stay terse, and are JSON when asked', () => {
  const json = runRaw(['calc', 'NoSuchWeapon', '--json']);
  assert.equal(json.status, 2);
  assert.equal(json.stdout.trim(), '');
  const payload = JSON.parse(json.stderr) as { error: { code: string; message: string } };
  assert.equal(payload.error.code, 'weapon_not_found');
  assert.equal(payload.error.message, 'weapon not found: NoSuchWeapon');
  assert.ok(!/file:|\bat .*cli\.ts/.test(json.stderr), 'an expected failure must not print a stack trace');

  const text = runRaw(['calc', 'NoSuchWeapon']);
  assert.equal(text.status, 2);
  assert.match(text.stderr, /^error: weapon not found: NoSuchWeapon/);

  const ability = runRaw(['ability', 'Not An Ability', '--json']);
  assert.equal(ability.status, 2);
  assert.equal((JSON.parse(ability.stderr) as { error: { code: string } }).error.code, 'ability_not_found');
});

test('--brief=answer keeps the answer and drops the context', () => {
  const result = runRaw(['calc', 'Kuva Bramma', '--mod', 'Serration', '--enemy', 'Bombard', '--level', '150', '--brief=answer']);
  assert.equal(result.status, 0);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /ttk [\d,.]+s/);
  for (const word of ['burst', 'sustained', 'armour']) assert.ok(!lines[0].includes(word));
});

test('batch prices every record and reports a bad one without stopping', () => {
  const input = [
    JSON.stringify({ label: 'bramma', weapon: 'Kuva Bramma', mods: [{ name: 'Serration' }], enemy: 'Bombard', level: 150 }),
    JSON.stringify({ label: 'typo', weapon: 'NoSuchWeapon', enemy: 'Bombard', level: 150 }),
    JSON.stringify({ label: 'avalanche', ability: 'Avalanche', strength: 200 }),
  ].join('\n');
  const result = runRaw(['batch', '--brief=answer'], input);
  assert.equal(result.status, 1, 'one failed record makes the batch exit 1');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^bramma: Kuva Bramma vs Bombard 150 · [\d,.]+ dps · ttk /);
  assert.match(lines[1], /^typo: error: weapon not found: NoSuchWeapon/);
  assert.match(lines[2], /^avalanche: Frost Avalanche .* · strip 100%/);
});

test('the text report shows the effective armour after a strip', () => {
  const result = runRaw(['calc', 'Haalvu', '--armor-strip', '100', '--enemy', 'Bombard', '--level', '150']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /armor 0 \(base 2,700\)/, result.stdout);
});
