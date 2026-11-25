#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgDir = path.resolve(__dirname, '..');
const distDir = path.join(pkgDir, 'dist');
const withTests = process.argv.includes('--with-tests');

fs.mkdirSync(distDir, { recursive: true });

// Minimal zero-dependency PNG generator for crisp extension icons
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function createIconPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.44;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= radius) {
        // Gradient circle (#1a73e8 -> #8ab4f8) with a white 4-point Gemini sparkle in center
        const t = (x + y) / (2 * size);
        let r = Math.round(26 + t * 56);
        let g = Math.round(115 + t * 70);
        let b = Math.round(232 + t * 18);
        let a = 255;

        const nx = Math.abs(dx) / radius;
        const ny = Math.abs(dy) / radius;
        const sparkle = Math.pow(nx, 0.58) + Math.pow(ny, 0.58);
        if (sparkle < 0.72) {
          r = 255;
          g = 255;
          b = 255;
        } else if (dist > radius - 1.2) {
          a = Math.max(0, Math.min(255, Math.round((radius - dist + 0.6) * 210)));
        }
        raw[px] = r;
        raw[px + 1] = g;
        raw[px + 2] = b;
        raw[px + 3] = a;
      } else {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// 1. Bundle extension scripts
await Promise.all([
  esbuild.build({
    entryPoints: [path.join(pkgDir, 'src', 'background.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    outfile: path.join(distDir, 'background.js')
  }),
  esbuild.build({
    entryPoints: [path.join(pkgDir, 'src', 'content.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: path.join(distDir, 'content.js')
  }),
  esbuild.build({
    entryPoints: [path.join(pkgDir, 'src', 'usage-bridge.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: path.join(distDir, 'usage-bridge.js')
  }),
  esbuild.build({
    entryPoints: [path.join(pkgDir, 'src', 'usage-frame.ts')],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    outfile: path.join(distDir, 'usage-frame.js')
  })
]);

// 2. Copy static extension assets
for (const file of ['manifest.json', 'rules.json']) {
  fs.copyFileSync(path.join(pkgDir, file), path.join(distDir, file));
}
fs.copyFileSync(path.join(pkgDir, 'src', 'styles.css'), path.join(distDir, 'styles.css'));

// 3. Generate extension icons
const iconsDir = path.join(distDir, 'icons');
fs.mkdirSync(iconsDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(iconsDir, `icon-${size}.png`), createIconPng(size));
}

// 4. Optional unit test build
if (withTests) {
  const testSrcDir = path.join(pkgDir, 'test');
  const testOutDir = path.join(pkgDir, 'build', 'test');
  fs.rmSync(testOutDir, { recursive: true, force: true });
  fs.mkdirSync(testOutDir, { recursive: true });
  if (fs.existsSync(testSrcDir)) {
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
        external: ['node:*']
      });
    }
  }
}
