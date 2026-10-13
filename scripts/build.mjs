import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

// A build validates the deployable source; live data is fetched by the functions.
// It requires no Sleeper credentials, Python process, or database connection.
for (const path of ['static/index.html', 'static/styles.css', 'static/app.js', 'static/favicon.svg']) {
  if (!(await readFile(path)).length) throw new Error(`Missing publish asset: ${path}`);
}
for (const path of ['static/app.js', 'netlify/functions/api.mjs', 'netlify/functions/health.mjs', 'netlify/functions/refresh.mjs', 'netlify/lib/api.mjs', 'netlify/lib/league.mjs', 'netlify/lib/engine.mjs', 'netlify/lib/fantasypros.mjs', 'netlify/lib/store.mjs']) {
  execFileSync(process.execPath, ['--check', path], { stdio: 'inherit' });
}
console.log('Netlify build ready: static website, API functions, scheduled sync, and durable Netlify Blobs storage.');
