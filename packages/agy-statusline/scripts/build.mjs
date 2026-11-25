#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgDir = path.resolve(__dirname, '..');
const withTests = process.argv.includes('--with-tests');

const capsuleCssPath = path.join(pkgDir, 'src', 'app', 'capsule.css');
const capsuleCss = fs.readFileSync(capsuleCssPath, 'utf8');

// Stage 1: Bundle browser runtime IIFE for App CDP injection
const browserResult = await esbuild.build({
  entryPoints: [path.join(pkgDir, 'src', 'app', 'browser-runtime.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  define: {
    __AG_CAPSULE_CSS__: JSON.stringify(capsuleCss)
  }
});

const browserCode = browserResult.outputFiles[0].text;

// Stage 2: Bundle standalone CLI & App daemon executable
const distDir = path.join(pkgDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });
const outFile = path.join(distDir, 'agy-statusline.mjs');

await esbuild.build({
  entryPoints: [path.join(pkgDir, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: outFile,
  external: ['node:*'],
  banner: {
    js: '#!/usr/bin/env node'
  },
  define: {
    __AG_BROWSER_RUNTIME_CODE__: JSON.stringify(browserCode),
    __AG_CAPSULE_CSS__: JSON.stringify(capsuleCss)
  }
});

// Stage 3: Bundle Antigravity IDE / VS Code extension (CommonJS for Extension Host)
const ideDistDir = path.join(pkgDir, 'ide', 'dist');
fs.mkdirSync(ideDistDir, { recursive: true });
const ideOutFile = path.join(ideDistDir, 'extension.cjs');

await esbuild.build({
  entryPoints: [path.join(pkgDir, 'src', 'ide', 'extension.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: ideOutFile,
  external: ['vscode', 'node:*'],
  define: {
    __AG_CAPSULE_CSS__: JSON.stringify(capsuleCss)
  }
});

try {
  fs.chmodSync(outFile, 0o755);
  fs.chmodSync(path.join(pkgDir, 'hooks', 'status-line.sh'), 0o755);
} catch {
  // Ignore chmod errors on Windows
}

if (withTests) {
  const testSrcDir = path.join(pkgDir, 'test');
  const testOutDir = path.join(pkgDir, 'build', 'test');
  fs.rmSync(testOutDir, { recursive: true, force: true });
  fs.mkdirSync(testOutDir, { recursive: true });
  const testFiles = fs
    .readdirSync(testSrcDir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => path.join(testSrcDir, f));

  if (testFiles.length > 0) {
    await esbuild.build({
      entryPoints: testFiles,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      outdir: testOutDir,
      outExtension: { '.js': '.mjs' },
      external: ['node:*', 'vscode'],
      define: {
        __AG_BROWSER_RUNTIME_CODE__: JSON.stringify(browserCode),
        __AG_CAPSULE_CSS__: JSON.stringify(capsuleCss)
      }
    });
  }
}
