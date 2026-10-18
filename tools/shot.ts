/**
 * Screenshots the UI with headless Chromium, so the layout can be reviewed without a
 * desktop. Chromium ships in Arch Linux ARM (`pacman -S chromium`).
 *
 *   node tools/shot.ts                      # phone viewport, empty state
 *   node tools/shot.ts --build haalvu       # with a build loaded
 *   node tools/shot.ts --width 1280 --height 900 --out /tmp/desktop.png
 *
 * Requires a running server: `wfcalc serve --host 0.0.0.0`.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};

const width = Number(flag('width', '420'));
const height = Number(flag('height', '1600'));
const out = flag('out', '/tmp/wfcalc.png');
const base = flag('url', 'http://127.0.0.1:7777/');
const build = flag('build', '');

/** Deep-link state, so a screenshot can show a realistic build instead of an empty page. */
const PRESETS: Record<string, unknown> = {
  haalvu: {
    weapon: 'Haalvu',
    mods: [
      { name: 'Galvanized Chamber' }, { name: 'Galvanized Aptitude' }, { name: 'Primed Cryo Rounds' },
      { name: 'Infected Clip' }, { name: 'Hellfire' }, { name: 'Vital Sense' },
      { name: 'Vigilante Armaments' }, { name: 'Galvanized Scope', rank: 6 },
      { name: 'Vigilante Supplies', rank: 3 },
    ],
    arcanes: [{ name: 'Primary Deadhead' }],
    enemy: 'Bombard', level: 150, conditions: { onKill: 5, statusTypes: 3 }, headshot: true,
  },
};

let url = base;
if (build && PRESETS[build]) {
  const state = JSON.parse(JSON.stringify(PRESETS[build]));
  const hash = Buffer.from(JSON.stringify(state)).toString('base64');
  url = `${base}#${hash}`;
} else if (build) {
  console.error(`unknown preset '${build}' (have: ${Object.keys(PRESETS).join(', ')})`);
  process.exit(1);
}

try {
  rmSync(out);
} catch {
  /* first run */
}

try {
  execFileSync(
    'chromium',
    [
      '--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
      '--force-device-scale-factor=1.5',
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      `--screenshot=${out}`,
      url,
    ],
    // dbus warnings are noise on a phone; the screenshot still lands.
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  console.log(`screenshot: ${out} (${width}x${height})`);
} catch (error) {
  console.error(`chromium failed: ${String(error)}`);
  console.error('install it with: pacman -S chromium');
  process.exit(1);
}
void writeFileSync;
