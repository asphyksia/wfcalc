/**
 * Ability damage tests.
 *
 * Ability damage shares the target maths with weapons but nothing else, so these tests pin the
 * parts that are easy to get wrong: Ability Strength scaling, the armour of the *scaled* enemy
 * (a pool's own amount is its level-1 value), and the rule that ability damage never crits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSnapshot } from '../src/data.ts';
import { abilityCast } from '../src/engine/ability.ts';
import { resolveStrip } from '../src/engine/strip.ts';
import { armorDamageReduction, scaleEnemy } from '../src/engine/enemy.ts';
import { resolveBuild } from '../src/engine/build.ts';
import { hitEnemy } from '../src/engine/damage.ts';
import { effectiveArmor } from '../src/engine/dot.ts';

const snapshot = loadSnapshot();

test('Ability Strength scales the damage linearly', () => {
  const base = abilityCast(snapshot, 'Rhino Stomp');
  assert.equal(base.baseDamage, 800);
  assert.equal(base.scaledDamage, 800);
  const boosted = abilityCast(snapshot, 'Rhino Stomp', { strength: 200 });
  assert.equal(boosted.scaledDamage, 1600);
  const reduced = abilityCast(snapshot, 'Rhino Stomp', { strength: 50 });
  assert.equal(reduced.scaledDamage, 400);
});

test('armour reduction uses the scaled armour, not the pool base value', () => {
  const scaled = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 150);
  // The Bombard's Alloy Armor pool says 500 at level 1; at 150 it is 2700.
  assert.equal(scaled.pools.find((pool) => pool.category === 'armor')?.amount, 500);
  assert.ok(scaled.armor > 2000);

  const cast = abilityCast(snapshot, 'Rhino Stomp', { enemy: 'Bombard', level: 150 });
  assert.ok(cast.target);
  // Blast has no armour-type modifier here, so the reduction is the plain armour formula.
  assert.ok(Math.abs(cast.target!.armorReduction - armorDamageReduction(scaled.armor, 0)) < 1e-9);
  assert.ok(cast.target!.armorReduction > 0.85, 'a level 150 Bombard should shrug off most of it');

  // Casts to kill must agree with the target's scaled health.
  const expected = Math.ceil(scaled.health / cast.target!.perCast);
  assert.equal(cast.target!.castsToKill, expected);
});

test('an unarmoured target takes the full modified damage', () => {
  const cast = abilityCast(snapshot, 'Rhino Stomp', { enemy: 'Crewman', level: 1 });
  assert.ok(cast.target);
  assert.equal(cast.target!.armorReduction, 0);
  assert.ok(Math.abs(cast.target!.perCast - cast.scaledDamage * cast.target!.healthMultiplier) < 1e-6);
});

test('the ability list is data, not guesses', () => {
  const abilities = Object.values(snapshot.damageAbilities ?? {});
  assert.ok(abilities.length >= 15, `only ${abilities.length} damage abilities`);
  for (const ability of abilities) {
    assert.ok((ability.baseDamage ?? 0) >= 10 || ability.armorStrip, `${ability.ability} has an implausible amount`);
    assert.ok(ability.damageType || ability.armorStrip, `${ability.ability} has neither damage nor strip`);
    assert.ok(ability.frame, `${ability.ability} has no frame`);
  }
});

test('an unknown ability fails loudly', () => {
  assert.throws(() => abilityCast(snapshot, 'Not An Ability'), /ability not found/);
});

test('armour strip: percentage scales with strength and caps at the whole armour', () => {
  // Avalanche removes 60% at 100% Ability Strength and the wiki says armour is fully gone at 167%.
  const at100 = abilityCast(snapshot, 'Avalanche', { strength: 100 });
  assert.equal(at100.armorStrip?.mode, 'percent');
  assert.ok(Math.abs((at100.armorStrip?.fraction ?? 0) - 0.6) < 1e-9);
  const at167 = abilityCast(snapshot, 'Avalanche', { strength: 167 });
  assert.equal(at167.armorStrip?.fraction, 1);
  const at200 = abilityCast(snapshot, 'Avalanche', { strength: 200 });
  assert.equal(at200.armorStrip?.fraction, 1, 'cannot remove more than all of it');

  // Polarize drains a flat number of points instead.
  const polarize = abilityCast(snapshot, 'Polarize', { strength: 200 });
  assert.equal(polarize.armorStrip?.mode, 'flat');
  assert.ok(Math.abs((polarize.armorStrip?.points ?? 0) - 800) < 1e-9);
});

test('effective armour applies the flat drain first, then the percentage', () => {
  assert.equal(effectiveArmor(500, { armorStripFlat: 400, armorStrip: 0.6 }), 40);
  assert.equal(effectiveArmor(500, { armorStrip: 1 }), 0);
  assert.equal(effectiveArmor(0, { armorStrip: 1 }), 0);
  // Without any strip the armour is untouched.
  assert.equal(effectiveArmor(2700, {}), 2700);
});

test('percentage strips are additive, as the wiki states', () => {
  // "Terrify (60%) plus one Corrosive Projection (18%) leaves 22% of the armour": additive.
  // Multiplicative stacking would leave 32.8%, which is the bug this pins.
  const scaled = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 150);
  const both = effectiveArmor(scaled.armor, { armorStrip: 0.6 + 0.18 });
  assert.ok(Math.abs(both - scaled.armor * 0.22) < 1e-9);
  assert.notEqual(both, effectiveArmor(scaled.armor, { armorStrip: 1 - (1 - 0.6) * (1 - 0.18) }));
});

test('Shattering Impact removes base armour, so its effect grows with level', () => {
  // 10 hits at max rank is 60 base armour; the Bombard's base is 500 and scales to 2700 at 150.
  const base = 500;
  const scaledArmor = 2700;
  const hit = effectiveArmor(scaledArmor, { armorStripBaseFlat: 60, armorBase: base });
  assert.ok(Math.abs(hit - (scaledArmor - 60 * (scaledArmor / base))) < 1e-9);
  // The same hits at level 1, where no scaling applies, remove exactly 60.
  assert.equal(effectiveArmor(base, { armorStripBaseFlat: 60, armorBase: base }), base - 60);
});

test('a strip is worth more to the weapon than the ability itself', () => {
  const weapon = ['Serration', 'Split Channel'].slice(0, 1).map((name) => ({ name }));
  const scaled = scaleEnemy(snapshot, snapshot.enemies['Bombard'], 150);
  const damage = (armorStrip?: number) => {
    const resolved = resolveBuild(snapshot, { weapon: 'Soma Prime', mods: weapon, debuffs: armorStrip ? { armorStrip } : {} });
    return hitEnemy(snapshot, resolved, scaled, {});
  };
  const bare = damage();
  const stripped = damage(1);
  assert.ok(stripped.timeToKill! < bare.timeToKill!, 'full strip should kill faster');
  // The dps figure and the time to kill must agree, or an agent quoting both looks wrong.
  assert.ok(Math.abs(scaled.health / stripped.totalDps - stripped.timeToKill!) < 1e-6);
  assert.ok(Math.abs(scaled.health / bare.totalDps - bare.timeToKill!) < 1e-6);
});

test('an ability that ticks is not priced as a single hit', () => {
  // Miasma: 150 viral damage *per second* for 6 seconds.
  const miasma = abilityCast(snapshot, 'Miasma', { strength: 100 });
  assert.equal(miasma.perSecond, true);
  assert.equal(miasma.durationSeconds, 6);
  assert.equal(miasma.totalDamage, 900);
  assert.equal(abilityCast(snapshot, 'Miasma', { strength: 200 }).totalDamage, 1800);

  // Inferno: a 2500 direct meteorite plus a ring of fire that ticks for 15 seconds.
  const inferno = abilityCast(snapshot, 'Inferno', { strength: 100 });
  assert.equal(inferno.perSecond, false);
  assert.ok(inferno.ticks, 'Inferno should carry its ring of fire');
  assert.equal(inferno.ticks!.seconds, 15);
  const expected = inferno.scaledDamage + inferno.ticks!.perSecond * 15;
  assert.ok(Math.abs(inferno.totalDamage - expected) < 1e-6);

  // A plain nuke is unaffected: one hit, no ticks.
  const stomp = abilityCast(snapshot, 'Rhino Stomp');
  assert.equal(stomp.perSecond, false);
  assert.equal(stomp.ticks, null);
  assert.equal(stomp.totalDamage, stomp.scaledDamage);
});

test('ticks make a damage ability kill in fewer casts', () => {
  const single = abilityCast(snapshot, 'Rhino Stomp', { enemy: 'Bombard', level: 150, strength: 200 });
  const ticking = abilityCast(snapshot, 'Inferno', { enemy: 'Bombard', level: 150, strength: 200 });
  assert.ok(ticking.target);
  assert.ok(ticking.target!.perCast > single.target!.perCast,
    `Inferno (${ticking.target!.perCast}) should out-damage a single-hit nuke (${single.target!.perCast})`);
  assert.ok(ticking.target!.castsToKill! < single.target!.castsToKill!);
});

test('the strip resolver turns squad, weapon and ability inputs into one additive debuff', () => {
  // Same example as above, now through the shared resolver the CLI and the HTTP API use:
  // Terrify's 60% plus one Corrosive Projection (18%) is 78%, not 67.2%.
  const both = resolveStrip(snapshot, { armorStripPercent: 60, corrosiveProjections: 1 });
  assert.ok(Math.abs((both.armorStrip ?? 0) - 0.78) < 1e-9);

  // An ability brings its own strength scaling; Avalanche at 200% is capped at the whole armour.
  assert.equal(resolveStrip(snapshot, { stripFrom: 'Avalanche', strength: 200 }).armorStrip, 1);
  // Polarize is a flat point drain, not a fraction.
  assert.ok((resolveStrip(snapshot, { stripFrom: 'Polarize' }).armorStripFlat ?? 0) > 0);
  // Shattering Impact is 6 base armour per hit at max rank.
  assert.equal(resolveStrip(snapshot, { shatteringImpactHits: 10 }).armorStripBaseFlat, 60);

  // Nyx: 80% at 100% strength, capped at the whole armour at 125% (the wiki's cap).
  assert.ok(Math.abs((resolveStrip(snapshot, { stripFrom: 'Psychic Bolts', strength: 100 }).armorStrip ?? 0) - 0.8) < 1e-9);
  assert.equal(resolveStrip(snapshot, { stripFrom: 'Psychic Bolts', strength: 125 }).armorStrip, 1);

  assert.throws(() => resolveStrip(snapshot, { stripFrom: 'Miasma' }), /does not strip armour/);
  assert.throws(() => resolveStrip(snapshot, { corrosiveProjections: 5 }), /0 to 4/);
});

test('Miasma applies one Viral stack and doubles its health damage', () => {
  const cast = abilityCast(snapshot, 'Miasma', { enemy: 'Bombard', level: 150 });
  assert.equal(cast.target?.viralStacks, 1);
  // 150/s x 6s = 900 Viral; the proc doubles it to 1,800 on health, then armour leaves 315.
  assert.ok(Math.abs((cast.target?.perCast ?? 0) - 315) < 1e-6);
  const stacked = abilityCast(snapshot, 'Miasma', { enemy: 'Bombard', level: 150, viralStacks: 10 });
  assert.equal(stacked.target?.viralStacks, 10);
  assert.ok((stacked.target?.perCast ?? 0) > (cast.target?.perCast ?? 0));
});

test('Shuriken guarantees one Bleed, which ignores armour', () => {
  const cast = abilityCast(snapshot, 'Shuriken', { enemy: 'Bombard', level: 150 });
  const proc = cast.target?.statusProcs.find((entry) => entry.type === 'slash');
  assert.equal(proc?.stacks, 1);
  assert.equal(proc?.damageType, 'true');
  // (750 + 1) x 0.35 x 6 ticks = 1,577.1 True damage.
  assert.ok(Math.abs((proc?.total ?? 0) - 1577.1) < 1e-6);
  assert.ok((cast.target?.statusPerCast ?? 0) > 1500);
});

test('Inferno guarantees a Heat proc seeded by half the meteorite damage', () => {
  const cast = abilityCast(snapshot, 'Inferno', { enemy: 'Bombard', level: 150 });
  const proc = cast.target?.statusProcs.find((entry) => entry.type === 'heat');
  assert.equal(proc?.stacks, 1);
  assert.ok((proc?.total ?? 0) > 0);
  assert.ok((cast.target?.statusPerCast ?? 0) > 0);
});
