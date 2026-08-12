'use strict';

/* ============================================================
   Smart Recipe Finder — front-end logic.
   Talks only to our own /api/* endpoints (see server.js).
   The Spoonacular API key never reaches this file or the browser.
   ============================================================ */

const API_BASE = '/api';
const FAVORITES_KEY = 'smart-recipe-favorites';
const RESULTS_PER_PAGE = 12;

// A meal counts as “quick” when it can be on the table in this many minutes or less.
const QUICK_MEAL_MAX_MINUTES = 30;

const $ = (sel) => document.querySelector(sel);

const els = {
  form: $('#search-form'),
  input: $('#search-input'),
  diet: $('#diet-filter'),
  cuisine: $('#cuisine-filter'),
  time: $('#time-filter'),
  sort: $('#sort-filter'),
  randomBtn: $('#random-btn'),
  status: $('#status-line'),
  resultsTitle: $('#results-title'),
  grid: $('#results-grid'),
  empty: $('#empty-state'),
  loading: $('#loading'),
  modal: $('#modal'),
  modalContent: $('#modal-content'),
  favToggle: $('#favorites-toggle'),
  favCount: $('#favorites-count'),
};

const state = {
  view: 'discover', // 'discover' | 'search' | 'favorites'
  mode: 'discover', // what to re-render when leaving the favorites view
  currentResults: [],
};

/* ------------------------------ helpers ----------------------------- */

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// Spoonacular returns HTML fragments (summary, instructions) — reduce to text.
// DOMParser (not innerHTML) so no event handlers inside the HTML can run.
function stripHtml(html) {
  return new DOMParser().parseFromString(html ?? '', 'text/html').body.textContent || '';
}

// Only allow http/https links (blocks javascript: / data: in untrusted data).
function safeUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || [];
  } catch {
    return [];
  }
}

function setFavorites(list) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

const isFavorite = (id) => getFavorites().some((r) => String(r.id) === String(id));

// Uses readyInMinutes (total prep + cook time) as the cook-time proxy — it is the
// field present on both search results and saved favorites.
const isQuickMeal = (r) =>
  Number.isFinite(Number(r.readyInMinutes)) && Number(r.readyInMinutes) <= QUICK_MEAL_MAX_MINUTES;

function findRecipe(id) {
  return state.currentResults.find((r) => String(r.id) === String(id));
}

/* -------------------------------- API -------------------------------- */

async function apiFetch(path) {
  const res = await fetch(path);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `Request failed with status ${res.status}`);
  return data;
}

/* --------------------------- UI state helpers ------------------------ */

function setStatus(msg, kind = '') {
  els.status.textContent = msg;
  els.status.className = 'status-line' + (kind ? ` is-${kind}` : '');
}

function setLoading(on) {
  els.loading.classList.toggle('hidden', !on);
}

function showEmpty(message) {
  els.empty.innerHTML = `<p>${escapeHtml(message)}</p>`;
  els.empty.classList.remove('hidden');
}

function hideEmpty() {
  els.empty.classList.add('hidden');
}

function updateFavUI() {
  const count = getFavorites().length;
  els.favCount.textContent = count;
  els.favToggle.setAttribute('aria-pressed', String(count > 0));
  els.favToggle.classList.toggle('active', state.view === 'favorites');
}

/* ------------------------------ rendering ---------------------------- */

function resultCard(r) {
  const fav = isFavorite(r.id);
  const cuisines = Array.isArray(r.cuisines) && r.cuisines.length ? r.cuisines.join(', ') : '';
  const meta = [cuisines, r.servings ? `${r.servings} servings` : ''].filter(Boolean).join(' · ');
  return `
    <article class="recipe-card" data-id="${escapeHtml(r.id)}" tabindex="0" role="button"
             aria-label="${isQuickMeal(r) ? 'Quick meal. ' : ''}Open recipe: ${escapeHtml(r.title)}">
      <div class="card-media">
        <img src="${escapeHtml(r.image)}" alt="${escapeHtml(r.title)}" loading="lazy"
             onerror="this.classList.add('broken')" />
        ${r.readyInMinutes ? `<span class="badge time">⏱ ${escapeHtml(r.readyInMinutes)}m</span>` : ''}
        ${isQuickMeal(r) ? '<span class="badge quick">⚡ Quick</span>' : ''}
        ${r.healthScore ? `<span class="badge health">💚 ${escapeHtml(r.healthScore)}</span>` : ''}
      </div>
      <div class="card-body">
        <h3 class="card-title">${escapeHtml(r.title)}</h3>
        ${meta ? `<p class="card-meta">${escapeHtml(meta)}</p>` : ''}
      </div>
      <button class="fav-btn ${fav ? 'is-fav' : ''}" type="button"
              data-fav="${escapeHtml(r.id)}" aria-label="${fav ? 'Remove from' : 'Save to'} favorites" aria-pressed="${fav}">♥</button>
    </article>`;
}

function setGrid(recipes) {
  state.currentResults = recipes;
  els.grid.innerHTML = recipes.map(resultCard).join('');
  if (recipes.length) hideEmpty();
}

function detailHtml(r) {
  const steps =
    (r.analyzedInstructions && r.analyzedInstructions[0] && r.analyzedInstructions[0].steps) || [];
  const ingredients = r.extendedIngredients || [];
  const fav = isFavorite(r.id);

  const meta = [
    r.readyInMinutes && `⏱ Ready in <strong>${escapeHtml(r.readyInMinutes)} min</strong>`,
    isQuickMeal(r) && '<strong>⚡ Quick meal</strong>',
    r.servings && `🍽 <strong>${escapeHtml(r.servings)}</strong> servings`,
    r.healthScore && `💚 Health score <strong>${escapeHtml(r.healthScore)}</strong>`,
    Array.isArray(r.cuisines) && r.cuisines.length && `🌍 ${escapeHtml(r.cuisines.join(', '))}`,
  ]
    .filter(Boolean)
    .map((m) => `<span>${m}</span>`)
    .join('');

  const ingredientsHtml = ingredients.length
    ? `<ul class="ingredients">${ingredients
        .map(
          (i) =>
            `<li><label><input type="checkbox" /> ${escapeHtml(
              [i.amount, i.unitLong || i.unit, i.nameClean || i.name].filter(Boolean).join(' ')
            )}</label></li>`
        )
        .join('')}</ul>`
    : '<p>Ingredient list unavailable for this recipe.</p>';

  let instructionsHtml;
  if (steps.length) {
    instructionsHtml = `<ol class="steps">${steps
      .map((s) => `<li>${escapeHtml(stripHtml(s.step))}</li>`)
      .join('')}</ol>`;
  } else if (r.instructions) {
    instructionsHtml = `<p>${escapeHtml(stripHtml(r.instructions))}</p>`;
  } else {
    instructionsHtml = '<p>No written instructions for this recipe.</p>';
  }

  const tags = [...(r.diets || []), r.dishTypes && r.dishTypes.length ? r.dishTypes.join(', ') : '']
    .filter(Boolean)
    .join(' · ');

  const sourceUrl = safeUrl(r.sourceUrl);

  return `
    <div class="detail-hero">
      ${r.image ? `<img src="${escapeHtml(r.image)}" alt="${escapeHtml(r.title)}" />` : ''}
    </div>
    <h2 class="detail-title" id="modal-title">${escapeHtml(r.title)}</h2>
    <div class="detail-meta">${meta || '<span>—</span>'}</div>
    ${tags ? `<p class="detail-meta">${escapeHtml(tags)}</p>` : ''}
    <div class="detail-actions">
      <button class="btn btn-primary fav-btn ${fav ? 'is-fav' : ''}" type="button"
              data-fav="${escapeHtml(r.id)}" aria-pressed="${fav}">${fav ? '♥ Saved' : '♡ Save recipe'}</button>
      ${sourceUrl ? `<a class="btn btn-secondary source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener">View original ↗</a>` : ''}
    </div>
    ${r.summary ? `<p class="detail-summary">${escapeHtml(stripHtml(r.summary))}</p>` : ''}
    <div class="detail-section">
      <h3>Ingredients</h3>
      ${ingredientsHtml}
    </div>
    <div class="detail-section">
      <h3>Instructions</h3>
      ${instructionsHtml}
    </div>
    ${r.sourceName ? `<p class="detail-meta">Source: ${escapeHtml(r.sourceName)}</p>` : ''}`;
}

/* ------------------------------ actions ------------------------------ */

async function runSearch() {
  state.mode = 'search';
  const query = els.input.value.trim();
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (els.diet.value) params.set('diet', els.diet.value);
  if (els.cuisine.value) params.set('cuisine', els.cuisine.value);
  if (els.time.value) params.set('maxReadyTime', els.time.value);
  if (els.sort.value) params.set('sort', els.sort.value);
  params.set('number', String(RESULTS_PER_PAGE));

  setLoading(true);
  setStatus('Searching…');
  try {
    const data = await apiFetch(`${API_BASE}/search?${params}`);
    const recipes = data.results || [];
    state.view = 'search';
    els.resultsTitle.textContent = query ? `Results for “${query}”` : 'Recipes';
    setGrid(recipes);
    setStatus(recipes.length ? `${recipes.length} recipes found` : '');
    if (!recipes.length) showEmpty('No recipes match those filters — try a different search.');
  } catch (err) {
    setGrid([]);
    setStatus(`Search failed: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function loadRandom() {
  state.mode = 'discover';
  setLoading(true);
  setStatus('Finding something tasty…');
  try {
    const data = await apiFetch(`${API_BASE}/random?number=6`);
    const recipes = data.recipes || [];
    state.view = 'discover';
    els.resultsTitle.textContent = 'Try something new';
    setGrid(recipes);
    setStatus('');
    if (!recipes.length) showEmpty('No recipes came back — try again in a moment.');
  } catch (err) {
    setGrid([]);
    setStatus(`Could not load recipes: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

function showFavorites() {
  state.view = 'favorites';
  els.resultsTitle.textContent = 'Your saved recipes';
  const favs = getFavorites();
  setGrid(favs);
  setStatus('');
  if (!favs.length) showEmpty('No saved recipes yet — tap the ♥ on any card to keep it here.');
  updateFavUI();
}

function exitFavorites() {
  state.view = state.mode === 'search' ? 'search' : 'discover';
  updateFavUI();
  if (state.mode === 'search') runSearch();
  else loadRandom();
}

function toggleFavorite(id, btn) {
  const favs = getFavorites();
  const idx = favs.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) {
    const recipe = findRecipe(id) || { id }; // favorites view already has full snapshot
    if (recipe.title) {
      favs.push({
        id: recipe.id,
        title: recipe.title,
        image: recipe.image,
        readyInMinutes: recipe.readyInMinutes,
        healthScore: recipe.healthScore,
        cuisines: recipe.cuisines,
        servings: recipe.servings,
      });
    } else {
      return; // nothing to save
    }
  } else {
    favs.splice(idx, 1);
  }
  setFavorites(favs);
  updateFavUI();

  // Sync the clicked button (card in the grid, or button in the modal).
  if (btn) {
    const fav = isFavorite(id);
    btn.classList.toggle('is-fav', fav);
    btn.setAttribute('aria-pressed', String(fav));
    if (btn.classList.contains('btn')) {
      btn.textContent = fav ? '♥ Saved' : '♡ Save recipe';
      // Keep the card behind the modal in sync (not while in the favorites view —
      // that grid is re-rendered below anyway).
      if (state.view !== 'favorites') setGrid(state.currentResults);
    } else {
      btn.setAttribute('aria-label', fav ? 'Remove from favorites' : 'Save to favorites');
    }
  }

  // Re-render the favorites grid so a removed card disappears immediately.
  if (state.view === 'favorites') {
    const updated = getFavorites();
    setGrid(updated);
    if (!updated.length) showEmpty('No saved recipes yet — tap the ♥ on any card to keep it here.');
  }
}

function showModal(open) {
  els.modal.classList.toggle('hidden', !open);
  document.body.style.overflow = open ? 'hidden' : '';
}

async function openDetail(id) {
  setLoading(true);
  showModal(true);
  els.modalContent.innerHTML = '';
  try {
    const recipe = await apiFetch(`${API_BASE}/recipe/${id}`);
    els.modalContent.innerHTML = detailHtml(recipe);
  } catch (err) {
    els.modalContent.innerHTML =
      '<h2 id="modal-title">Recipe unavailable</h2>' +
      `<p class="modal-error">Could not load recipe: ${escapeHtml(err.message)}</p>`;
  } finally {
    setLoading(false);
  }
}

/* ------------------------------ events ------------------------------- */

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  runSearch();
});

els.randomBtn.addEventListener('click', loadRandom);

els.favToggle.addEventListener('click', () => {
  if (state.view === 'favorites') exitFavorites();
  else showFavorites();
});

// Any filter change re-runs the current search (never while viewing favorites).
[els.diet, els.cuisine, els.time, els.sort].forEach((sel) =>
  sel.addEventListener('change', () => {
    if (state.mode === 'search' && state.view !== 'favorites') runSearch();
  })
);

// Event delegation on the results grid.
els.grid.addEventListener('click', (e) => {
  const favBtn = e.target.closest('.fav-btn');
  if (favBtn) {
    e.stopPropagation();
    toggleFavorite(favBtn.dataset.fav, favBtn);
    return;
  }
  const card = e.target.closest('.recipe-card');
  if (card) openDetail(card.dataset.id);
});

// Keyboard support: Enter / Space opens a focused card.
els.grid.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('recipe-card')) {
    e.preventDefault();
    openDetail(e.target.dataset.id);
  }
});

// Save toggling inside the detail modal (delegated on modal content).
els.modalContent.addEventListener('click', (e) => {
  const favBtn = e.target.closest('.fav-btn');
  if (favBtn) toggleFavorite(favBtn.dataset.fav, favBtn);
});

// Close modal: backdrop, × button, Escape.
document.querySelectorAll('[data-close-modal]').forEach((el) =>
  el.addEventListener('click', () => showModal(false))
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') showModal(false);
});

/* ------------------------------ bootstrap ----------------------------- */

updateFavUI();
loadRandom();
