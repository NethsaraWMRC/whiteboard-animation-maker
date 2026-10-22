// Checks that everything the video tool needs is installed, and says how to install what is not.
//
//   node tools/check-setup.mjs
//
// Exit code 1 when a required piece is missing (Node 20+, ffmpeg/ffprobe, npm packages).
// Exact word timing (.venv-align with torch, torchaudio, uroman, ...) is optional.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
let missing = 0;
const ok = (msg) => console.log(`  ok       ${msg}`);
const bad = (msg, fix, required = true) => {
  if (required) missing++;
  console.log(`  ${required ? 'MISSING' : 'optional'} ${msg}\n           fix: ${fix}`);
};
const runs = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || r.stderr).split('\n')[0].trim() : null;
};

console.log('Required');
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) ok(`Node.js ${process.versions.node}`);
else bad(`Node.js 20+ (found ${process.versions.node})`, 'install the LTS from https://nodejs.org');

const ffInstall = win ? 'winget install Gyan.FFmpeg  (then reopen the terminal)' : mac ? 'brew install ffmpeg' : 'sudo apt install ffmpeg';
for (const tool of ['ffmpeg', 'ffprobe']) {
  const v = runs(tool, ['-version']);
  if (v) ok(v.split(' Copyright')[0]);
  else bad(`${tool} on PATH`, ffInstall);
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const req = createRequire(path.join(ROOT, 'package.json'));
const absent = Object.keys(pkg.dependencies ?? {}).filter((d) => {
  try {
    req.resolve(`${d}/package.json`);
    return false;
  } catch {
    return !existsSync(path.join(ROOT, 'node_modules', d));
  }
});
if (!absent.length) ok('npm packages installed');
else bad(`npm packages: ${absent.join(', ')}`, 'npm install  (in the project folder)');

console.log('\nOptional (exact word timing)');
const py = path.join(ROOT, '.venv-align', win ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(py)) {
  bad('.venv-align (Python 3.12 environment)', `${win ? 'py -3.12' : 'python3.12'} -m venv .venv-align && ${win ? '.venv-align\\Scripts\\pip' : '.venv-align/bin/pip'} install -r requirements.txt`, false);
} else {
  const mods = ['torch', 'torchaudio', 'numpy', 'soundfile', 'uroman'];
  const r = spawnSync(py, ['-c', `import importlib.util as u; print(",".join(m for m in ${JSON.stringify(mods)} if not u.find_spec(m)))`], { encoding: 'utf8' });
  const lack = (r.stdout ?? '').trim();
  if (r.status === 0 && !lack) ok('.venv-align with torch, torchaudio, numpy, soundfile, uroman');
  else bad(`.venv-align packages: ${lack || 'could not run python'}`, `${win ? '.venv-align\\Scripts\\pip' : '.venv-align/bin/pip'} install -r requirements.txt`, false);
}

console.log(missing ? `\n${missing} required item(s) missing: the tool will not work until they are installed.` : '\nReady.');
process.exit(missing ? 1 : 0);
