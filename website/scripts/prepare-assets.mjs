import sharp from 'sharp';
import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const site = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(site, '..');
const destination = path.join(site, 'public/assets');
await mkdir(destination, { recursive: true });

// Pass the original illustration explicitly when regenerating this one-off asset.
const character = process.argv[2];
if (character) {
  // Crop the empty upper canvas and retain the original transparent line work.
  await sharp(character)
    .extract({ left: 500, top: 2720, width: 2500, height: 3680 })
    .resize({ width: 1200 })
    .webp({ quality: 92, alphaQuality: 100 })
    .toFile(path.join(destination, 'echo-character.webp'));
}
await access(path.join(destination, 'echo-character.webp'));

for (const [source, name] of [
  ['local-library-light.png', 'library'],
  ['immersive-lyrics.png', 'lyrics'],
  ['parametric-equalizer.png', 'sound'],
  ['home-dashboard.png', 'home']
]) {
  await sharp(path.join(root, 'assets/screenshots', source))
    .resize({ width: 1800, withoutEnlargement: true })
    .webp({ quality: 86 })
    .toFile(path.join(destination, `${name}.webp`));
}
console.log('Illustration and four real product screenshots are ready.');
