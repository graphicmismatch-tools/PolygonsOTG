// Copy the built web app (dist/) into the Android project's assets.
import { cpSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'dist');
const dst = resolve(root, 'android/app/src/main/assets/web');
if (!existsSync(src)) { console.error('dist/ missing: run `npm run build` first'); process.exit(1); }
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true });
console.log(`Copied ${src} -> ${dst}`);
