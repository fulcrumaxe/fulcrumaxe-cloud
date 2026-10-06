import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/** The exact bytes on disk -- this IS what a real webhook's raw body
 * looks like, so signing this string and parsing it with JSON.parse
 * exercises both halves the same way apps/web's handler.ts does. */
export function loadFixtureRaw(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

export function loadFixture<T>(name: string): T {
  return JSON.parse(loadFixtureRaw(name)) as T;
}
