#!/usr/bin/env node
// Builds an immutable AVD release for the browser deployer at deploy.andykemp.com/avd (akc-tools ADR 0004):
// the compiled templates, the two scripts the VMs run, and a manifest with each file's SHA-256. The deployer checks
// every file against the manifest before it uses it.
//
//   node scripts/build-release.mjs --version v2.1.0 --out ../akc-tools/apps/web/public/releases/avd [--bicep bicep]
//
// Releases are never edited in place: the script refuses to overwrite an existing version.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, a, i, all) => (a.startsWith('--') ? [...pairs, [a.slice(2), all[i + 1]]] : pairs), []));
const version = args.version;
if (!/^v\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('Pass --version vX.Y.Z');
if (!args.out) throw new Error('Pass --out <releases/avd folder>');
const bicep = args.bicep ?? 'bicep';
const out = join(resolve(args.out), version);
if (existsSync(out)) throw new Error(`${out} already exists. Releases are never edited in place; choose a new version.`);

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--', 'infra', 'scripts'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty && !args['allow-dirty']) throw new Error(`Commit infra/ and scripts/ first, so the manifest's commit matches the files:\n${dirty}`);

const templates = {
  'foundation.json': 'infra/avd/foundation.bicep',
  'platform.json': 'infra/avd/platform.bicep',
  'session-hosts.json': 'infra/avd/session-hosts-from-vault.bicep',
};
const scripts = {
  'session-host-prep.ps1': 'scripts/session-host-prep.ps1',
  'set-profile-acls.ps1': 'scripts/set-profile-acls.ps1',
};

// Build everything in memory first, so a failed build leaves no half-made folder holding the version number.
const built = {};
for (const [name, source] of Object.entries(templates)) built[name] = execFileSync(bicep, ['build', join(root, source), '--stdout'], { encoding: 'utf8' });
for (const [name, source] of Object.entries(scripts)) built[name] = readFileSync(join(root, source), 'utf8');

mkdirSync(out, { recursive: true });
const files = {};
for (const [name, text] of Object.entries(built)) {
  // LF only, so the hash is the same whichever machine built it.
  const bytes = Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8');
  writeFileSync(join(out, name), bytes);
  files[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ product: 'avd', version, commit, builtAt: new Date().toISOString(), files }, null, 2)}\n`);
console.log(`Built AVD ${version} from ${commit.slice(0, 7)} into ${out}`);
for (const [name, f] of Object.entries(files)) console.log(`  ${name}  ${f.bytes} bytes  ${f.sha256}`);
