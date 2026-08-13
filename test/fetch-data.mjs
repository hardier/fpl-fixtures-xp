/*
 * Downloads the API snapshots the tests run against.
 *
 * The tests drive the real content script over jsdom using real bootstrap-static
 * and fixtures payloads, so player names, fixtures and difficulty ratings are the
 * live ones rather than invented. The snapshots are not committed: they are ~1.3MB
 * and go stale, so fetch them before running the suite.
 */
import { writeFileSync } from 'node:fs';

const BASE = 'https://fantasy.premierleague.com/api/';
for (const [path, file] of [['bootstrap-static/', 'bootstrap.json'], ['fixtures/', 'fixtures.json']]) {
  const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  writeFileSync(new URL(file, import.meta.url), JSON.stringify(await res.json()));
  console.log(`${file} written`);
}
