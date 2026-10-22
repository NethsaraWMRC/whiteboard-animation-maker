// Import every drawing listed in <dir>/art.json into the asset library.
// Usage: node tools/import-art.cjs my/q3/art [--roughness 0.5]
const { execFileSync } = require('child_process');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/import-art.cjs <art-dir> [--roughness n]');
  process.exit(1);
}
const ri = process.argv.indexOf('--roughness');
const roughness = ri > 0 ? process.argv[ri + 1] : '0.5';
const cli = path.join(__dirname, '..', 'src', 'cli.js');
const meta = require(path.resolve(dir, 'art.json'));
for (const m of meta) {
  const out = execFileSync(
    process.execPath,
    [cli, 'asset', 'import', path.join(dir, `${m.name}.svg`), '--name', m.name, '--description', m.description,
      '--tags', m.tags, '--order', 'document', '--roughness', roughness, '--force', ...(m.frame ? ['--frame'] : [])],
    { encoding: 'utf8' },
  );
  process.stdout.write(out.split('\n')[0] + '\n');
}
