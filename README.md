# 🍳 Smart Recipe Finder

Search hundreds of thousands of recipes from the [Spoonacular](https://spoonacular.com/food-api) database —
filter by **diet**, **cuisine** and **max prep time**, sort by popularity or speed, save favorites, and get random
suggestions with the **🎲 Surprise me** button.

## Architecture

Your Spoonacular API key is a secret and must **never** be shipped to the browser. This project uses a tiny
zero-dependency Node server that:

1. Reads the key from `.env` (gitignored, so it can't be committed).
2. Serves `index.html`, `style.css` and `recipe.js`.
3. Proxies API calls to Spoonacular — the browser only ever talks to the same-origin `/api/*` endpoints, so the
   key stays server-side.

```
Browser (index.html / style.css / recipe.js)
   │  fetch('/api/search?...')          — no API key anywhere
   ▼
server.js (reads SPOONACULAR_API_KEY from .env)
   │  api.spoonacular.com/recipes/complexSearch?apiKey=…&…
   ▼
Spoonacular API
```

## Setup

1. **Get a free key** at <https://spoonacular.com/food-api> (sign in → *Profile* → *API Key*).
2. **Copy the environment template** and paste your key:

   ```bash
   cp .env.example .env
   # then edit .env and replace `replace-with-your-key`
   ```

3. **Run** (no `npm install` needed — plain Node 18+):

   ```bash
   npm start
   # or: node server.js
   ```

4. Open <http://localhost:3000>.

## API endpoints (served by `server.js`)

| Endpoint | Proxies to Spoonacular | Notes |
| --- | --- | --- |
| `GET /api/search?query=&diet=&cuisine=&maxReadyTime=&number=&sort=` | `/recipes/complexSearch` | Results include images, health scores, cuisines, servings. `sort=popularity` or `sort=time`. |
| `GET /api/recipe/:id` | `/recipes/{id}/information` | Full ingredients + step-by-step instructions. |
| `GET /api/random?number=` | `/recipes/random` | Discovery / “Surprise me”. |

Only whitelisted search parameters are forwarded; everything else is dropped. The API key is added
server-side on every upstream request and never returned to the client.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Missing SPOONACULAR_API_KEY` (400) | `.env` missing or key still the placeholder | Copy `.env.example` to `.env`, paste your real key, restart the server. |
| `401 Unauthorized` / `403 Invalid API key` | Wrong key or key not yet activated | Re-check the key at Spoonacular; keys can take a few minutes to activate. |
| `402 Payment Required` | Free-tier daily quota (150 calls/day) exceeded | Wait for the daily reset, or upgrade. |
| `429 Too Many Requests` | Too many calls per second | The server already paces upstream calls to ~1/sec; wait a moment and retry. |
| Port 3000 in use | Another process | `PORT=3001 npm start`. |

## Customization

- **Port**: set `PORT` in your environment or `.env`.
- **Bind address**: defaults to `127.0.0.1` (loopback only). Set `HOST=0.0.0.0` if you want to reach it from other devices on your network.
- **Results per page**: change `RESULTS_PER_PAGE` at the top of `recipe.js`.
- **Quick Meal threshold**: recipes get the ⚡ Quick badge when `readyInMinutes` (total prep + cook time) is at or below `QUICK_MEAL_MAX_MINUTES` (default 30) at the top of `recipe.js`.
- **Cuisine / diet lists**: edit the `<select>` options in `index.html` (values must match
  [Spoonacular's filter values](https://spoonacular.com/food-api/docs#Search-Recipes-Complex)).
