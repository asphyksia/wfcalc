# Formulas and where they come from

Every formula here is implemented in `src/engine/` and tested in `tests/engine.test.ts`
against values quoted from the wiki. Sources are the official wiki pages downloaded
by `npm run update` into `data/raw/`.

## 1. Arsenal damage (`Damage/Calculation`)

```
total = base × [1 + Σ elemental bonuses + Σ share_i × physical bonus_i]
              × (1 + Σ damage bonuses)
              × multishot
```

Per damage type:

```
physical type  = base_i × (1 + ips_bonus_i) × (1 + damage_bonus)
element        = (innate_i + base_total × element_bonus) × (1 + damage_bonus)
```

Consequences worth remembering:

- Damage mods (Serration +165%) multiply **everything**, including elements and IPS bonuses.
- Elemental mods add a share of the **unmodded total**, then get multiplied by the
  damage bonus. Verified by test: 100 base + Serration + Hellfire → 90 heat × 2.65.
- Physical (IPS) mods only boost their own type's share.

### Elemental combination order

Elements combine in mod-slot order (top-left to bottom-right), with the weapon's
innate element counting first. Two singles of the same type just add up. A third
single pairs with the earliest pending compatible element.

| Pair | Result | | Pair | Result |
|---|---|---|---|---|
| Heat + Cold | Blast | | Cold + Toxin | Viral |
| Electricity + Toxin | Corrosive | | Cold + Electricity | Magnetic |
| Heat + Toxin | Gas | | Heat + Electricity | Radiation |

### Crit (`Damage/Calculation → Average Shot`)

```
modded crit chance   = base × (1 + Σ bonuses)
modded crit damage   = base × (1 + Σ bonuses)
average multiplier   = 1 + crit_chance × (crit_damage − 1)
```

Crit tiers (orange/red) are only relevant on a per-hit basis; the expected-value
formula above is what every calculator shows as "average damage".

### Mod ranks

Mods have `maxRank + 1` equal steps, so rank `r` of a `maxRank` mod is
`value × (r + 1) / (maxRank + 1)`: Serration R0 = +15%, R9 = +150%, R10 = +165%
(the wiki quotes the R9 example: `18 × (1 + 1.5) = 45`).

### Faction damage

`Bane of Grineer` and friends are a separate multiplier bucket
(`x1.3 Damage to Grineer` → ×1.3 against Grineer only), multiplicative with damage
mods, not additive to them.

## 2. Enemy scaling (`Enemy_Level_Scaling`, `Armor`)

Each stat is two endpoint curves blended with a smoothstep, evaluated in binary32:

```
f1(q) = 1 + C1 · q^E1
f2(q) = 1 + C2 · q^E2              q = level − base level
t = clamp((q − L) / (U − L), 0, 1) L = 70, U = 80
s = t² · (3 − 2t)
multiplier = f1 + (f2 − f1) · s
```

| Stat | Curve |
|---|---|
| Grineer/Scaldra health | `1 + 0.015q^2.12` → `1 + 10.7332q^0.72` |
| Corpus health | `1 + 0.015q^2.12` → `1 + 13.4165q^0.55` |
| Infested health | `1 + 0.0225q^2.12` → `1 + 16.0998q^0.72` |
| Corrupted/Orokin health | `1 + 0.015q^2.1` → `1 + 10.7332q^0.685` |
| Murmur/Sentient/Neutral health | `1 + 0.015q^2` → `1 + 10.7332q^0.5` |
| Corpus shields | `1 + 0.02q^1.76` → `1 + 2q^0.76` |
| Corrupted shields | `1 + 0.02q^1.75` → `1 + 2q^0.75` |
| Grineer/Sentient shields | `1 + 0.02q^1.75` → `1 + 1.6q^0.75` |
| Armor (all factions) | `1 + 0.005q^1.75` → `1 + 0.4q^0.75` |

Level-scaled armor is clamped to **200..2700**. Every enemy's base level is taken as
1 unless the dataset says otherwise (that is the case for all normal enemies).

## 3. Armor damage reduction (`Armor`)

```
armor ≤ 2700:  DR = 0.9 · sqrt(armor / 2700)
armor > 2700:  DR = armor / (armor + 300)
```

Armored enemies still take a minimum of 1 damage per damage type per hit.

## 4. Damage type modifiers (`Module:DamageTypes/data`)

Each health type (Cloned Flesh, Alloy Armor, Shield, ...) has positive and negative
modifiers in percentage points, e.g. Alloy Armor: Radiation +75, Cold +25,
Puncture +15, Electricity −50, Magnetic −50. The snapshot stores them as
`modifiers[damage_type][health_type]`.

```
health hit = damage × (1 + health_type_modifier) × (1 − DR)
shield hit = damage × (1 + shield_type_modifier)      (armor does not apply)
```

### Modelling decision: armour modifiers act on armour

A vulnerability does two things at once: it increases damage **and** makes armour
protect less. We model that the way the game does — by scaling the armour value:

```
effective_armor = armor × (1 − armor_type_modifier)
```

so `+75%` Radiation vs Alloy Armor turns 2700 armour into 675 (DR 90% → 45%).
The alternative model (armour modifier as a plain damage multiplier) gives visibly
different rankings against high-armour Grineer, so this is the first thing to
re-verify in game if numbers ever look off.

## 5. Time to kill

Shields are chewed through first, then health, using the per-shot damage against each
pool. Toxin damage bypasses shields (except Treasurer and Hounds). Time comes from
the sustained fire rate, which accounts for the magazine and reload cycle.

## Known approximations

- Quantization (`1/32` of base damage) is **not** applied: it shifts things by well
  under 1% except for the Shattering Impact edge case.
- Multishot and crit are treated as expectations, not per-pellet rolls.
- Fire rate is the trigger rate; charge weapons use the dataset's charge-inclusive rate.
- Area-of-effect falloff and punch-through multi-hits are not modelled.
