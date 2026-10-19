# Plan de continuación

Documento de traspaso: una sesión nueva debe poder empezar aquí sin más contexto.

Última actualización: commit `d2387e0`.

---

## 1. Estado verificado

| | |
|---|---|
| Tests | **92 pass, 0 fail** (`npm test`, ~6 s) |
| Invariantes | `node tools/validate.ts` → PASS, 0 violations |
| Calibración vs Overframe | **50/50** (`node tools/calibrate.ts`) |
| Tipos | `npm run check` limpio |
| Snapshot | 2,6 MB: 622 armas, 1550 mods, 479 enemigos, 22 habilidades de daño, 19 buffs, 54 armas con Incarnon |
| git | limpio |

Antes de empezar cualquier cosa, repetir estos cuatro comandos y confirmar que siguen verdes.

---

## 2. Metodología (la que ha funcionado)

Un cambio a la vez, en este orden:

1. **Planificar**: leer el código y los **datos reales** antes de tocar nada. Nunca asumir: cada vez
   que se asumió (que `Aerial Ace` era de Archwing, que el enlace compartido cargaba vacío, que
   `pools.amount` era la armadura escalada) la suposición era falsa.
2. **Implementar**: cambio pequeño y con el porqué en un comentario, no en un commit críptico.
3. **Probar**: test unitario del comportamiento nuevo *y* comprobación con datos reales
   (`wfcalc ...` con un arma/enemigo concretos), no solo que compile.
4. **Si falla, arreglar en el sitio**: no acumular. Si un test revela que el modelo está mal
   (los perks de Incarnon, los strips multiplicativos), se corrige el modelo, no el test.
5. **Medir antes/después** cuando el cambio es de rendimiento o de aspecto, y dejar el número en
   el mensaje del commit.
6. **Commit** con: qué estaba mal, qué se hizo, y qué evidencia lo respalda.

Reglas que han evitado repetir errores:

- Un test que **fije el número correcto** vale más que tres que comprueben que no explota.
  Ejemplos vivos: el 22 % de armadura tras Terrify + Corrosive Projection, `vida/totalDps ==
  timeToKill`, y la fuerza bruta de Incarnon contra la elección del buscador.
- Si el resultado parece absurdo, **es un bug**: «un Bombard 150 muere de un casteo» y «2361 dps
  matan en 271 s» eran los dos ciertos y los dos estaban mal.
- Todo lo que el motor no modela se dice en la respuesta (`warnings`, `notes`, `partialMods`),
  nunca se maquilla.

---

## 3. Trampas del entorno (han costado horas)

- **El servidor de desarrollo se cae entre turnos.** Si el navegador muestra una página en blanco
  o `chrome-error://`, casi siempre es eso: comprobar `curl -m 5` antes de sospechar del código.
  Arrancarlo con `./tools/dev-server.sh 7801` y verificar **en el mismo comando**.
- **Nunca `pkill -f <patrón>`**: el patrón coincide con la línea de comandos de la propia shell y
  la mata (código 143). Usar `pkill -x chromium`.
- **`fuser -k` no funciona** aquí (no puede leer `/proc/net/tcp` bajo proot): no mata nada y el
  servidor nuevo muere con `EADDRINUSE` mientras el viejo sigue sirviendo datos viejos. Por eso
  `dev-server.sh` mata con `pgrep -f "server.ts --port N"`.
- **`/tmp` se limpia** entre sesiones: dejar los ficheros de trabajo en `/root/wfcheck/`, no en `/tmp`.
- **`agent-browser`** sirve para `eval`, `drag`, `hover` y `screenshot`, pero su daemon falla a
  veces (`Resource temporarily unavailable`), se queda en `about:blank` y **no consigue soltar
  sobre slots cubiertos**. Cuando falle, usar eventos sintéticos (`new DragEvent`) o el script CDP
  de `/root/wfcheck/verify2.mjs`.
- Los tests del CLI se colgaban 96 s porque el hijo heredaba `stdin`: `stdio: ['ignore','pipe','pipe']`.

---

## 4. Backlog, por orden de valor

### A. Deuda concreta (empezar aquí; son fallos, no mejoras)

| # | Qué | Dónde | Cómo verificar |
|---|---|---|---|
| A1 | **Faltan los Incarnon melee** | `tools/build-data.ts`, `readIncarnonForms`: busca `Incarnon Form`, pero la wiki llama `Spectral Dagger`, `Spectral Dagger Explosion`... Son 5 armas | `node -e "console.log(Object.values(require('./data/snapshot.json').weapons).filter(w=>w.category==='melee'&&w.incarnonForm).length)"` → hoy 0 |
| A2 | **`sync` no vigila las fuentes nuevas** | `tools/sync.ts` no menciona `module-weapons-primary/secondary/melee.lua` (`fetch.ts` sí) | `grep -c module-weapons tools/sync.ts` → hoy 0 |
| A3 | **API HTTP sin `search` ni `ability`** | `src/server.ts` | `grep -c "/api/search" src/server.ts` → hoy 0 |
| A4 | **UI sin strip, habilidades ni buscador** | `src/web/app.js` | grep de `strip-from`, `ability`, `search` en la UI |

Notas para A1: ampliar el regex a `/incarnon form|spectral/i` y comprobar que el perfil resultante
tiene sentido (daño, crit, cadencia) en las 5 armas. Para A2: añadirlas a `WIKI_PAGES` de `sync.ts`
con el mismo `If-Modified-Since`. Para A3: `POST /api/search` (llama a `search()`) y
`GET /api/ability?name=...` (llama a `abilityCast()`); documentar en `docs/api.md`.

### B. Modelado que hace falsas las respuestas endgame

| # | Hueco | Por qué |
|---|---|---|
| B1 | **Overguard** | 0 enemigos con pool de overguard en el snapshot. Es la mitad de lo que mata en Steel Path |
| B2 | **Atenuación de daño** | Lich, Hermana, Archon, Eidolon. Hoy el motor dice que un Rubico los funde |

### C. Modelado pendiente, por valor

| # | Hueco |
|---|---|
| C1 | **Estados que aplican las habilidades**: el proc de Heat garantizado de Inferno, el Viral de Miasma. Es el último hueco grande de la rama de habilidades |
| C2 | **Multiobjetivo y AoE real**: falloff de habilidades, cadenas del Torid |
| C3 | **Escudos en `castsToKill`** de habilidad (hoy se ignoran: el número es optimista contra Corpus) |

### D. Cobertura y confianza

| # | Qué | Evidencia |
|---|---|---|
| D1 | **Mods parciales**: Melee 6/122 y **Bow 2/6** (un tercio de los arcos) | `docs/unmatched-mods.txt` |
| D2 | **Calibración no fijada**: los 50 builds se muestrean de Overframe en cada ejecución, así que el listón cambia solo | `tools/calibrate.ts` |
| D3 | **Sin calibración de melee ni secundarias**: las 3 lecturas doradas son de Soma Prime | `tests/ingame.test.ts` |

Orden sugerido: **A entero → B1/B2 → C1 → D2/D1**.

### E. Fuera de alcance, decidido

Stance slot no se busca; condicionales apagados por defecto (`--stacks`); riven con stats manuales
sin pesos ni reroll; compañeros, Archwing y Necramech no soportados.

---

## 5. Mapa del código

```
src/engine/build.ts     resuelve arma + mods + buffs -> estadísticas modificadas
src/engine/damage.ts    daño por tipo, armadura, TTK, DoT, totalDps (contra el objetivo)
src/engine/enemy.ts     escalado por nivel, reducción por armadura, modelo de armadura
src/engine/dot.ts       ticks de estado, effectiveArmor (aquí vive el strip)
src/engine/buffs.ts     19 buffs de warframe aplicados al arma
src/engine/ability.ts   daño de habilidad, ticks propios, strip
src/engine/search.ts    buscador de builds (voraz + búsqueda local + Incarnon)
src/engine/riven.ts     rivens
src/mods/parse.ts       parser de efectos de mods (97 % de los relevantes)
src/data.ts             carga del snapshot, modsForWeapon (filtro de candidatos)
src/cli.ts              todos los comandos, todos con --json
src/server.ts           web + API JSON
tools/build-data.ts     WFCD + wiki -> data/snapshot.json
tools/fetch*.ts         descargas (fetch, abilities, damage-abilities, incarnon, sets)
docs/agent.md           contrato para un agente
/root/.pi/agent/skills/wfcalc/SKILL.md   skill que usa ese contrato
```

Comandos útiles: `wfcalc abilities`, `wfcalc ability <name> --strength N --enemy X --level N`,
`wfcalc search <weapon> [--strip-from Avalanche --strength 200]`, `wfcalc calc <weapon> --mod ...
[--cp N] [--shattering-impact N] [--armor-strip N]`, `wfcalc incarnon <weapon>`.

---

## 6. Cómo retomar

```sh
cd /root/work/wfcalc
git log --oneline | head -5      # confirmar d2387e0 o posterior
npm test                          # 92 tests
node tools/validate.ts            # 0 violations
node tools/calibrate.ts           # 50/50
./tools/dev-server.sh 7801        # solo si hace falta la web
```

Después: elegir el primer item de la sección A, planificarlo leyendo el código y los datos reales,
y seguir la metodología de la sección 2.
