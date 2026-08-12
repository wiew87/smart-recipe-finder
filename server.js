'use strict';

/*
 * Smart Recipe Finder — local dev server + Spoonacular proxy.
 *
 * Why a proxy? A Spoonacular API key must never be shipped to the browser.
 * This server reads the key from .env (which is gitignored) and forwards
 * requests to Spoonacular, so the key only ever lives server-side.
 * The frontend (recipe.js) talks exclusively to /api/* endpoints here.
 *
 * Run:  node server.js   (or: npm start)
 * Zero runtime dependencies — plain Node 18+ (uses built-in fetch).
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Project root. Local runs: the folder containing server.js. On Vercel the
// function bundle places static files (via includeFiles) at the bundle root
// while this file lives in api/, so walk up until we find index.html.
function findRoot() {
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return __dirname;
}

const ROOT = findRoot();
const PORT = Number(process.env.PORT) || 3000;
// Loopback by default so the server isn't exposed on the LAN; set HOST=0.0.0.0 to override.
const HOST = process.env.HOST || '127.0.0.1';
const SPOONACULAR_BASE = 'https://api.spoonacular.com';
const UPSTREAM_TIMEOUT_MS = 20000;

/* ----------------------------- .env loader ----------------------------- */
// Minimal, dependency-free parser for KEY=VALUE lines (avoids a dotenv dep).
function loadEnvFile(filePath = path.join(ROOT, '.env')) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    // Don't override values already set in the real environment.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();
const API_KEY = (process.env.SPOONACULAR_API_KEY || '').trim();
// Treat the template placeholder the same as a missing key.
const KEY_MISSING = !API_KEY || API_KEY === 'replace-with-your-key';

/* ----------------------------- tiny helpers ---------------------------- */

function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(obj));
}

// Search params we are willing to forward — everything else is dropped.
const SEARCH_PARAMS = new Set([
  'query',
  'diet',
  'cuisine',
  'intolerances',
  'number',
  'maxReadyTime',
  'sort',
]);

function pickSearchParams(searchParams) {
  const picked = new URLSearchParams();
  for (const key of SEARCH_PARAMS) {
    const value = searchParams.get(key);
    if (value && value.trim() !== '') picked.set(key, value.trim());
  }
  // Clamp result count to a sane range.
  const rawNumber = parseInt(picked.get('number') || '12', 10);
  picked.set('number', String(Math.min(Math.max(Number.isNaN(rawNumber) ? 12 : rawNumber, 1), 100)));
  // Enrich results so cards can show ratings, health scores, cuisines, etc.
  picked.set('addRecipeInformation', 'true');
  picked.set('fillIngredients', 'true');
  picked.set('instructionsRequired', 'true');
  return picked;
}

/* ------------------------- polite rate limiting ------------------------ */
// Spoonacular's free tier allows roughly 150 calls/day and ~1 call/second.
// This serializes upstream calls with a minimum gap so we don't get 429s.
let lastUpstreamCall = 0;
function acquireSlot() {
  const minGapMs = 1100;
  const wait = Math.max(0, lastUpstreamCall + minGapMs - Date.now());
  lastUpstreamCall = Date.now() + Math.max(0, wait);
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}

/* ------------------------- Spoonacular proxy --------------------------- */

async function proxyToSpoonacular(apiPath, searchParams, res) {
  if (KEY_MISSING) {
    sendJson(res, 400, {
      error:
        'Missing SPOONACULAR_API_KEY. Copy .env.example to .env and paste your key from https://spoonacular.com/food-api.',
    });
    return;
  }
  const url = new URL(SPOONACULAR_BASE + apiPath);
  for (const [key, value] of searchParams) url.searchParams.set(key, value);
  url.searchParams.set('apiKey', API_KEY); // never echoed back to the client

  await acquireSlot();
  let upstream;
  try {
    upstream = await fetch(url, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    sendJson(res, 502, { error: `Upstream error: ${err.name === 'TimeoutError' ? 'timeout' : err.message}` });
    return;
  }
  const body = await upstream.text();
  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
  });
  res.end(body);
}

/* ----------------------------- static files ---------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    sendJson(res, 400, { error: 'Malformed URL' });
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const rel = pathname.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(ROOT, rel));

  // Path-traversal guard + never serve dotfiles (.env, .git, …).
  const outsideRoot = !filePath.startsWith(ROOT + path.sep);
  const hasDotPart = rel.split('/').some((part) => part.startsWith('.'));
  if (outsideRoot || hasDotPart) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (err, buffer) => {
    if (err) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buffer);
  });
}

/* -------------------------------- router ------------------------------- */
// Vercel-compatible request handler. Locally it backs the HTTP server below;
// on Vercel it is invoked directly as a serverless function (module.exports).
async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }

    // GET /api/search?query=…&diet=…&cuisine=…&number=…&sort=…
    if (pathname === '/api/search') {
      return proxyToSpoonacular('/recipes/complexSearch', pickSearchParams(url.searchParams), res);
    }

    // GET /api/recipe/:id  → full recipe details
    const recipeMatch = pathname.match(/^\/api\/recipe\/(\d+)$/);
    if (recipeMatch) {
      const params = new URLSearchParams();
      params.set('includeNutrition', 'false');
      return proxyToSpoonacular(`/recipes/${recipeMatch[1]}/information`, params, res);
    }

    // GET /api/random?number=…  → "surprise me" discovery
    if (pathname === '/api/random') {
      const params = new URLSearchParams();
      const rawNumber = parseInt(url.searchParams.get('number') || '6', 10);
      const n = Math.min(Math.max(Number.isNaN(rawNumber) ? 6 : rawNumber, 1), 20);
      params.set('number', String(n));
      return proxyToSpoonacular('/recipes/random', params, res);
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Unknown API endpoint' });
      return;
    }

    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// Run as a local server only when executed directly (node server.js).
// On Vercel this file is required by the platform, which calls handleRequest.
if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`🍳 Smart Recipe Finder running at http://${HOST}:${PORT}`);
    if (KEY_MISSING) {
      console.warn('⚠️  No SPOONACULAR_API_KEY found — copy .env.example to .env and add your key.');
    }
  });
}

module.exports = handleRequest;
