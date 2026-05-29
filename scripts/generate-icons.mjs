#!/usr/bin/env node
/**
 * Generates simple placeholder icons for TaskFlow.
 * Run: node scripts/generate-icons.mjs
 *
 * For production, replace public/icons/ with properly designed assets.
 * Recommended tool: https://maskable.app/editor or https://realfavicongenerator.net
 */

import { createCanvas } from 'canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, '../public/icons');
mkdirSync(iconsDir, { recursive: true });

function generateIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#4f46e5';
  const r = size * 0.2;
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.lineTo(size - r, 0);
  ctx.quadraticCurveTo(size, 0, size, r);
  ctx.lineTo(size, size - r);
  ctx.quadraticCurveTo(size, size, size - r, size);
  ctx.lineTo(r, size);
  ctx.quadraticCurveTo(0, size, 0, size - r);
  ctx.lineTo(0, r);
  ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath();
  ctx.fill();

  // Letter "T"
  const fontSize = size * 0.52;
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('T', size / 2, size / 2 + size * 0.03);

  return canvas.toBuffer('image/png');
}

for (const size of [192, 512]) {
  const buffer = generateIcon(size);
  const dest = join(iconsDir, `icon-${size}.png`);
  writeFileSync(dest, buffer);
  console.log(`✓ Generated ${dest}`);
}
console.log('\nDone! Replace these with proper artwork before App Store submission.');
