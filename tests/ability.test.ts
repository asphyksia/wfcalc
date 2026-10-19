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
import { armorDamageReduction, scaleEnemy } from '../src/engine/enemy.ts';

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
    assert.ok(ability.baseDamage >= 10, `${ability.ability} has an implausible amount`);
    assert.ok(ability.damageType, `${ability.ability} has no damage type`);
    assert.ok(ability.frame, `${ability.ability} has no frame`);
  }
});

test('an unknown ability fails loudly', () => {
  assert.throws(() => abilityCast(snapshot, 'Not An Ability'), /ability not found/);
});
