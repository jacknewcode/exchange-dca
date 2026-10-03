import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignored = new Set(['node_modules', '.git', 'data', 'runtime']);
let checked = 0;
async function check(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name)) await check(file);
    else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
      checked++;
    }
  }
}
await check(root);
console.log(`Syntax checked: ${checked} JavaScript files`);
