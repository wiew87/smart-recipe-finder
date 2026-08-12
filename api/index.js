'use strict';

// Vercel serverless entry point: reuses the exact handler from server.js.
// Vercel auto-deploys files in /api as functions; the rewrite in vercel.json
// routes every /api/* request here. Locally, server.js still runs standalone
// via `npm start` (this file is never used).
module.exports = require('../server.js');
