// "Build" step: there is nothing to compile (plain ESM JavaScript), so this
// syntax-checks every source file and verifies node:sqlite is available.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['src', 'public', 'scripts', 'test'];
let n = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', p], { stdio: 'inherit' });
      n++;
    }
  }
}
roots.forEach(walk);
process.removeAllListeners('warning');
await import('node:sqlite');
console.log(`build: ${n} files OK`);
