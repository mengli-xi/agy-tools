#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgDir = path.resolve(__dirname, '..');

const releaseRoot = path.join(pkgDir, 'release');
const stageDir = path.join(releaseRoot, 'agy-statusline');

fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(stageDir, 'assets'), { recursive: true });
fs.mkdirSync(path.join(stageDir, 'dist'), { recursive: true });
fs.mkdirSync(path.join(stageDir, 'hooks'), { recursive: true });
fs.mkdirSync(path.join(stageDir, 'skills', 'agy-statusline'), { recursive: true });

const copySpecs = [
  ['plugin.json', 'plugin.json'],
  ['assets/logo.svg', 'assets/logo.svg'],
  ['README.md', 'README.md'],
  ['dist/agy-statusline.mjs', 'dist/agy-statusline.mjs'],
  ['hooks/status-line.sh', 'hooks/status-line.sh'],
  ['hooks/status-line.cmd', 'hooks/status-line.cmd'],
  ['skills/agy-statusline/SKILL.md', 'skills/agy-statusline/SKILL.md']
];

for (const [srcRel, dstRel] of copySpecs) {
  const srcPath = path.join(pkgDir, srcRel);
  const dstPath = path.join(stageDir, dstRel);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Missing release file: ${srcPath}`);
  }
  fs.copyFileSync(srcPath, dstPath);
}

try {
  fs.chmodSync(path.join(stageDir, 'dist', 'agy-statusline.mjs'), 0o755);
  fs.chmodSync(path.join(stageDir, 'hooks', 'status-line.sh'), 0o755);
} catch {
  // Ignore on Windows
}

const tarPath = path.join(releaseRoot, 'agy-statusline.tar.gz');
if (fs.existsSync(tarPath)) {
  fs.unlinkSync(tarPath);
}
execFileSync('tar', ['-czf', tarPath, '-C', releaseRoot, 'agy-statusline'], {
  stdio: 'inherit'
});

console.log(`Staged plugin at ${stageDir}`);
console.log(`Created archive ${tarPath}`);
