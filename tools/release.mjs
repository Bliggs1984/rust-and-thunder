// Makes the version to send to friends: builds, then packs the self-contained game (RustAndThunder.html) and
// release/HOW-TO-PLAY.txt into release/RustAndThunder-<date>.zip. Checks the HTML needs nothing from the internet.
// Earlier releases are deleted, so release/ only ever holds the newest zip.
// Usage: node tools/release.mjs
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

const html = resolve(root, 'RustAndThunder.html');
const text = readFileSync(html, 'utf8');
// anything loaded from a URL would break offline play: only data: URIs are allowed
// (src="${...}" inside the game's own code builds images in memory, so template strings are fine)
const external = (text.match(/(?:src|href)\s*=\s*["'](?!data:|#|\$\{)[^"']+["']/g) ?? []).filter((m) => !m.includes('${'));
if (external.length) {
  console.error('The build loads outside files, so it would not work offline:', external.slice(0, 5));
  process.exit(1);
}

const now = new Date();
const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; // local date
const name = `RustAndThunder-${date}`;
const dir = resolve(root, 'release', name);
// keep only the newest release: remove every earlier RustAndThunder-* folder and zip
for (const f of readdirSync(resolve(root, 'release'))) {
  if (f.startsWith('RustAndThunder-')) rmSync(resolve(root, 'release', f), { recursive: true, force: true });
}
mkdirSync(dir, { recursive: true });
copyFileSync(html, resolve(dir, 'RustAndThunder.html'));
copyFileSync(resolve(root, 'release/HOW-TO-PLAY.txt'), resolve(dir, 'HOW-TO-PLAY.txt'));

const zip = resolve(root, 'release', `${name}.zip`);
rmSync(zip, { force: true });
// Windows 10+ ships bsdtar, which writes zip files with -a (Git Bash's GNU tar can't, so name the Windows one)
const tar = process.platform === 'win32' ? resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-a', '-c', '-f', zip, '-C', resolve(root, 'release'), name], { stdio: 'inherit' });
rmSync(dir, { recursive: true, force: true }); // only the zip stays
console.log(`${zip} (${Math.round(statSync(zip).size / 1024)} KB)`);
