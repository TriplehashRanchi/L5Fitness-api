/**
 * Build check. This API is plain JavaScript, so there is nothing to compile. "Building" means
 * proving the code can ship: every source file parses, and every local require() resolves.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git']);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

const files = sourceFiles(root);
let failed = false;

for (const file of files) {
  const rel = path.relative(root, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed = true;
    console.error(`✗ ${rel}\n${err.stderr}`);
    continue;
  }
  // Every local or package import must point at something that exists.
  const source = fs.readFileSync(file, 'utf8');
  for (const [, request] of source.matchAll(/require\(\s*'([^']+)'\s*\)/g)) {
    try {
      require.resolve(request, { paths: [path.dirname(file)] });
    } catch {
      failed = true;
      console.error(`✗ ${rel}: cannot resolve '${request}'`);
    }
  }
}

if (failed) process.exit(1);
console.log(`✓ ${files.length} files parse and all imports resolve`);
