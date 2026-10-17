# JSON API

`wfcalc serve` exposes a small HTTP API on `http://127.0.0.1:7777` (loopback only by
default). It is meant to be driven by scripts and AI agents: same inputs, same
results as the CLI and the UI.

## `GET /api/weapons`

```json
[{ "name": "Kuva Bramma", "category": "primary", "type": "Bow", "masteryRank": 15 }]
```

## `GET /api/enemies`

```json
[{ "name": "Bombard", "faction": "grineer", "health": 300, "shield": 0, "armor": 500 }]
```

## `GET /api/mods?weapon=Kuva%20Bramma`

Mods that fit the weapon, with max rank, polarity and description.

```json
[{ "name": "Serration", "maxRank": 10, "polarity": "madurai", "description": "+165% Damage",
   "partial": false, "baseDrain": 4, "rarity": "Uncommon", "set": null }]
```

`partial: true` means the calculator only understood part of the mod's effects; the
damage result is a lower bound.

## `POST /api/calc`

```json
{
  "weapon": "Kuva Bramma",
  "mods": [{ "name": "Serration" }, { "name": "Vital Sense", "rank": 3 }],
  "enemy": "Bombard",
  "level": 150,
  "mode": "Radial Attack",
  "headshot": false,
  "conditions": { "onKill": 5, "aiming": true, "statusTypes": 3 }
}
```

- `mods`: order matters — it is the slot order the game uses for elemental combination.
- `rank` is optional; omitted means max rank.
- `mode` is optional; omitted means the arsenal stat block.
- `conditions` toggles conditional mods: `onKill` (stacks), `onWeakPointHit`,
  `onWeakPointKill`, `onReload`, `aiming`, `sliding`, `holstered`, `statusTypes` (count).

Response (abridged):

```json
{
  "weapon": { "name": "Kuva Bramma", "type": "Bow", "modClasses": ["Rifle", "Bow"],
              "mode": null, "modes": ["Charged Shot", "Radial Attack", "..."] },
  "damage": { "impact": 495.55, "blast": 7117.37 },
  "projectileTotal": 7612.92,
  "averageShotDamage": 32791.1,
  "critChance": 0.35, "critMultiplier": 4.62, "statusChance": 0.21,
  "multishot": 1.9, "fireRate": 0.667,
  "burstDps": 21860.8, "sustainedDps": 15614.8,
  "elements": [{ "type": "blast", "share": 0.935 }],
  "target": {
    "name": "Bombard", "level": 150, "health": 118480.2, "armor": 2700,
    "breakdown": [{ "type": "blast", "raw": 7117.37, "healthMultiplier": 0.1,
                    "toHealth": 711.74, "procShare": 0.935 }],
    "shotsToKill": 27.4, "timeToKill": 57.51
  },
  "warnings": [],
  "unsupportedMods": [],
  "inactiveConditions": ["..."]
}
```

Errors come back as `{ "error": "...", "suggestions": ["..."] }` with status 404.

## Agent recipes

"Is my build good against high-level Grineer?"

```sh
curl -s localhost:7777/api/calc -H 'content-type: application/json' -d '{
  "weapon":"Lex Prime",
  "mods":[{"name":"Hornet Strike"},{"name":"Primed Pistol Gambit"},{"name":"Primed Target Cracker"}],
  "enemy":"Bombard","level":200}' | jq '{dps:.sustainedDps, ttk:.target.timeToKill, warns:.warnings}'
```

"Which elemental combo is best for this weapon?"

```sh
for combo in "Hellfire,Cryo Rounds" "Infected Clip,Stormbringer" "Hellfire,Infected Clip"; do
  jq -n --arg c "$combo" '{weapon:"Ignis Wraith", mods:[{name:"Serration"}] + ($c|split(",")|map({name:.})),
                            enemy:"Corrupted Bombard", level:160}' |
  curl -s localhost:7777/api/calc -H 'content-type: application/json' -d @- |
  jq -r --arg c "$combo" '"\($c): \(.target.timeToKill)s"'
done
```

"Find me mods that fit this weapon and mention multishot":

```sh
curl -s 'localhost:7777/api/mods?weapon=Kuva%20Bramma' | jq -r '.[] | select(.description|test("Multishot")) | "\(.name)  \(.description|split("\n")[0])"'
```
