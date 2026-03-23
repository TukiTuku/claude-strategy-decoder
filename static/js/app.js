// ============================================
// STRATEGY DECODER — Frontend App Logic
// ============================================

// ---- THEME ----
function applyTheme(light) {
  document.body.classList.toggle('light-mode', light);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = light ? '☾' : '☀';
}
function toggleTheme() {
  const isLight = document.body.classList.toggle('light-mode');
  localStorage.setItem('sdTheme', isLight ? 'light' : 'dark');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = isLight ? '☾' : '☀';
}
// Apply saved preference immediately
applyTheme(localStorage.getItem('sdTheme') === 'light');

let currentData = null;
let currentTab = 'active';
let currentSort = 'default';
let pnlFilter = 'all';
let chartInstances = {};
let themesByIdx = {};
let themeChartFilters = {};
let simStates = {}; // idx → true when simulated mode is active

// ---- FORMAT MONEY ----
// Returns European-style: 1.456.543,40 (dot = thousands, comma = decimals)
function formatMoney(amount, decimals = 2) {
  const abs = Math.abs(amount);
  const parts = abs.toFixed(decimals).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return decimals > 0 ? parts.join(',') : parts[0];
}

// ---- UI HELPERS ----
function $(id) { return document.getElementById(id); }

function showOnly(section) {
  ['loadingState', 'errorState', 'resultsSection'].forEach(id => {
    $(id).classList.add('hidden');
  });
  if (section) $(section).classList.remove('hidden');
}


function resetUI() {
  showOnly(null);
  $('walletInput').value = '';
  currentData = null;
}

// ---- LOADING STEPS ----
let loadStep = 0;
function advanceLoadStep() {
  if (loadStep > 0) {
    const prev = $('ls' + loadStep);
    if (prev) { prev.classList.remove('active'); prev.classList.add('done'); }
  }
  loadStep++;
  const curr = $('ls' + loadStep);
  if (curr) curr.classList.add('active');
}

// ---- MAIN ANALYSIS ----
async function startAnalysis() {
  const wallet = $('walletInput').value.trim();
  if (!wallet) {
    $('walletInput').focus();
    return;
  }

  // Reiniciar pasos de carga
  loadStep = 0;
  ['ls1','ls2','ls3','ls4'].forEach(id => {
    const el = $(id);
    if (el) { el.classList.remove('active', 'done'); }
  });

  showOnly('loadingState');
  advanceLoadStep();

  const btn = $('analyzeBtn');
  btn.classList.add('loading');
  btn.querySelector('.btn-text').textContent = 'Analizando...';

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet })
    });

    advanceLoadStep(); // paso 2 — agrupación

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Error del servidor');
    }

    const data = await response.json();
    currentData = data;

    advanceLoadStep(); // paso 3 — ROI
    await sleep(300);
    advanceLoadStep(); // paso 4 — gráficos
    await sleep(300);

    showOnly('resultsSection');
    renderResults(data);

  } catch (err) {
    $('errorMsg').textContent = err.message;
    showOnly('errorState');
  } finally {
    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Analizar';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- RENDER RESULTS ----
function renderResults(data) {
  $('summaryWallet').textContent = data.wallet;
  $('statActive').textContent = data.activePositions ?? '—';
  $('statClosed').textContent = data.closedPositions ?? '—';
  $('statTrades').textContent = data.totalTrades ?? '—';
  $('statThemes').textContent = data.themes?.length ?? '—';

  // Reset PNL filter to "Todo" on new analysis
  pnlFilter = 'all';
  document.querySelectorAll('.pnl-filter-btn').forEach(b => b.classList.remove('active'));
  const todoBtn = document.querySelector('.pnl-filter-btn:last-child');
  if (todoBtn) todoBtn.classList.add('active');

  renderThemes(data.themes, currentTab);
  setTimeout(() => renderPnlChart(data.themes), 50);
}

// ---- PNL CHART ----

// Returns sorted daily P&L deltas (not cumulative) so filters can re-cumulate from 0
function buildPnlDeltas(themes) {
  const byDay = {};
  themes.forEach(t => {
    (t.closedMarkets || []).forEach(m => {
      if (!m.lastTradeDate) return;
      const day = new Date(m.lastTradeDate * 1000).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + (m.profit ?? 0);
    });
  });
  return Object.keys(byDay).sort().map(day => ({ day, delta: byDay[day] }));
}

function setPnlFilter(filter, btn) {
  pnlFilter = filter;
  document.querySelectorAll('.pnl-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (currentData) renderPnlChart(currentData.themes);
}

function renderPnlChart(themes) {
  const allDeltas = buildPnlDeltas(themes);
  const section = $('pnlChartSection');
  if (!allDeltas.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  // Filter daily deltas to the selected period
  let filtered = allDeltas;
  if (pnlFilter !== 'all') {
    const days = pnlFilter === '7d' ? 7 : pnlFilter === '14d' ? 14 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    filtered = allDeltas.filter(p => p.day >= cutoffStr);
  }

  // Accumulate from 0 within the filtered period
  let running = 0;
  const points = filtered.map(p => {
    running += p.delta;
    return { day: p.day, value: parseFloat(running.toFixed(2)) };
  });

  const finalValue = points.length ? points[points.length - 1].value : 0;
  const isPositive = finalValue >= 0;
  const lineColor  = isPositive ? '#00cc88' : '#ff4444';
  const bgColor    = isPositive ? 'rgba(0,204,136,0.08)' : 'rgba(255,68,68,0.08)';

  // When showing "all" data and polymarket-tools provided a totalPnl, use it as the
  // authoritative total — it covers the full wallet history including periods we can't
  // reconstruct from the trade records we received.
  const toolsPnl = (pnlFilter === 'all' && currentData && currentData.polymarketToolsPnl != null)
    ? currentData.polymarketToolsPnl
    : null;
  const displayValue = toolsPnl !== null ? toolsPnl : finalValue;
  const displayPositive = displayValue >= 0;
  const totalSign = displayValue > 0 ? '+' : displayValue < 0 ? '-' : '';

  const totalEl = $('pnlTotalValue');
  totalEl.textContent = `${totalSign}$${formatMoney(displayValue)}`;
  totalEl.className = `pnl-total-val ${displayPositive ? 'pnl-positive' : 'pnl-negative'}`;

  const lblEl = $('pnlTotalLbl');
  if (toolsPnl !== null) {
    lblEl.textContent = 'P&L Total histórico (polymarket-tools)';
  } else {
    lblEl.textContent = 'Profit acumulado (posiciones cerradas)';
  }

  const labels = points.map(p =>
    new Date(p.day + 'T12:00:00').toLocaleDateString('es-ES', { month: 'short', day: 'numeric' })
  );
  const values = points.map(p => p.value);

  if (chartInstances['pnl']) { chartInstances['pnl'].destroy(); delete chartInstances['pnl']; }

  chartInstances['pnl'] = new Chart($('pnlChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: lineColor,
        backgroundColor: bgColor,
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: points.length > 40 ? 0 : 3,
        pointHoverRadius: 5,
        pointBackgroundColor: lineColor,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              return ` ${v >= 0 ? '+' : '-'}$${formatMoney(v)}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#5a7a9a', font: { family: 'Space Mono', size: 10 }, maxTicksLimit: 8 },
          grid: { color: '#1e2d3d' }
        },
        y: {
          ticks: {
            color: '#5a7a9a',
            font: { family: 'Space Mono', size: 10 },
            callback: v => `$${formatMoney(v, 0)}`
          },
          grid: { color: '#1e2d3d' }
        }
      }
    }
  });
}

// ---- PER-THEME PNL CHART ----
function setThemePnlFilter(idx, filter, btn) {
  themeChartFilters[idx] = filter;
  const filtersEl = $(`theme-pnl-filters-${idx}`);
  if (filtersEl) filtersEl.querySelectorAll('.theme-pnl-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderThemePnlChart(idx);
}

function renderThemePnlChart(idx) {
  const theme = themesByIdx[idx];
  if (!theme) return;

  const section = $(`theme-pnl-section-${idx}`);
  if (!section) return;

  const closedMarkets = theme.closedMarkets || [];
  const byDay = {};
  closedMarkets.forEach(m => {
    if (!m.lastTradeDate) return;
    const day = new Date(m.lastTradeDate * 1000).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + (m.profit ?? 0);
  });
  const allDeltas = Object.keys(byDay).sort().map(day => ({ day, delta: byDay[day] }));

  if (!allDeltas.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  const filter = themeChartFilters[idx] || 'all';
  let filtered = allDeltas;
  if (filter !== 'all') {
    const days = filter === '7d' ? 7 : filter === '14d' ? 14 : 30;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    filtered = allDeltas.filter(p => p.day >= cutoffStr);
  }

  let running = 0;
  const points = filtered.map(p => {
    running += p.delta;
    return { day: p.day, value: parseFloat(running.toFixed(2)) };
  });

  if (!points.length) { section.classList.add('hidden'); return; }

  const finalValue = points[points.length - 1].value;
  const isPositive = finalValue >= 0;
  const lineColor = isPositive ? '#00cc88' : '#ff4444';
  const bgColor   = isPositive ? 'rgba(0,204,136,0.08)' : 'rgba(255,68,68,0.08)';

  const labels = points.map(p =>
    new Date(p.day + 'T12:00:00').toLocaleDateString('es-ES', { month: 'short', day: 'numeric' })
  );
  const values = points.map(p => p.value);

  const chartKey = `theme-pnl-${idx}`;
  if (chartInstances[chartKey]) { chartInstances[chartKey].destroy(); delete chartInstances[chartKey]; }

  const canvas = $(`theme-pnl-${idx}`);
  if (!canvas) return;

  chartInstances[chartKey] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: lineColor,
        backgroundColor: bgColor,
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: points.length > 30 ? 0 : 3,
        pointHoverRadius: 5,
        pointBackgroundColor: lineColor,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw;
              return ` ${v >= 0 ? '+' : '-'}$${formatMoney(v)}`;
            }
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#5a7a9a', font: { family: 'Space Mono', size: 9 }, maxTicksLimit: 6 },
          grid: { color: '#1e2d3d' }
        },
        y: {
          ticks: {
            color: '#5a7a9a',
            font: { family: 'Space Mono', size: 9 },
            callback: v => `$${formatMoney(v, 0)}`
          },
          grid: { color: '#1e2d3d' }
        }
      }
    }
  });
}

function switchTab(tab, btn) {
  currentTab = tab;
  currentSort = 'default';
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (currentData) renderThemes(currentData.themes, tab);
}

function setSortAndRender(sortBy) {
  // Toggle: same key flips direction; new key starts desc
  if (currentSort === sortBy + '-desc') {
    currentSort = sortBy + '-asc';
  } else {
    currentSort = sortBy + '-desc';
  }
  if (currentData) renderThemes(currentData.themes, currentTab);
}

function renderThemes(themes, tab) {
  const container = $('themesContainer');
  container.innerHTML = '';

  Object.values(chartInstances).forEach(c => c.destroy());
  chartInstances = {};
  themesByIdx = {};
  themeChartFilters = {};
  simStates = {};

  const relevantThemes = themes.filter(t => {
    const markets = tab === 'active' ? t.activeMarkets : t.closedMarkets;
    return markets && markets.length > 0;
  });

  if (relevantThemes.length === 0) {
    const label = tab === 'active' ? 'activas' : 'cerradas';
    container.innerHTML = `<div class="empty-state">No se encontraron posiciones ${label} para esta wallet.</div>`;
    return;
  }

  // Sort buttons (both tabs)
  const roiActive = currentSort.startsWith('roi');
  const pnlActive = currentSort.startsWith('pnl');
  const roiArrow = currentSort === 'roi-asc' ? '↑' : '↓';
  const pnlArrow = currentSort === 'pnl-asc' ? '↑' : '↓';
  const sortBar = document.createElement('div');
  sortBar.className = 'sort-bar';
  sortBar.innerHTML = `
    <span class="sort-label">Ordenar:</span>
    <button class="sort-btn ${roiActive ? 'active' : ''}" onclick="setSortAndRender('roi')">ROI% ${roiArrow}</button>
    <button class="sort-btn ${pnlActive ? 'active' : ''}" onclick="setSortAndRender('pnl')">G/P $ ${pnlArrow}</button>
  `;
  container.appendChild(sortBar);

  // Apply sort
  let sorted = [...relevantThemes];
  if (currentSort === 'roi-desc') {
    sorted.sort((a, b) => b.roi.roiPercent - a.roi.roiPercent);
  } else if (currentSort === 'roi-asc') {
    sorted.sort((a, b) => a.roi.roiPercent - b.roi.roiPercent);
  } else if (currentSort === 'pnl-desc') {
    sorted.sort((a, b) => b.roi.totalPnL - a.roi.totalPnL);
  } else if (currentSort === 'pnl-asc') {
    sorted.sort((a, b) => a.roi.totalPnL - b.roi.totalPnL);
  }

  sorted.forEach((theme, idx) => {
    themesByIdx[idx] = theme;
    themeChartFilters[idx] = 'all';
    const markets = tab === 'active' ? theme.activeMarkets : theme.closedMarkets;
    const card = buildThemeCard(theme, markets, tab, idx);
    container.appendChild(card);
  });
}

function buildThemeCard(theme, markets, tab, idx) {
  const card = document.createElement('div');
  card.className = 'theme-card';
  card.id = `theme-${idx}`;

  const roi = tab === 'active' ? (theme.activeRoi || theme.roi) : (theme.closedRoi || theme.roi);
  const roiClass = roi.roiPercent > 0 ? 'roi-positive' : roi.roiPercent < 0 ? 'roi-negative' : 'roi-neutral';
  const roiSign = roi.roiPercent > 0 ? '+' : roi.roiPercent < 0 ? '-' : '';
  const pnlSign = roi.totalPnL > 0 ? '+' : roi.totalPnL < 0 ? '-' : '';
  const badgeType = tab === 'active' ? 'badge-active' : 'badge-closed';
  const badgeText = tab === 'active' ? `${markets.length} ACTIVAS` : `${markets.length} CERRADAS`;

  card.innerHTML = `
    <div class="theme-header" onclick="toggleCard(${idx})">
      <div class="theme-title-row">
        <span class="theme-name">${escHtml(theme.theme)}</span>
        <span class="theme-badge ${badgeType}">${badgeText}</span>
        ${theme.tradeCount > 0 ? `<span class="theme-badge badge-closed">${theme.tradeCount} OPERACIONES</span>` : ''}
      </div>
      <div class="theme-roi-row">
        <div class="roi-box">
          <span class="roi-pct ${roiClass}" id="hdr-pnl-${idx}">${pnlSign}$${formatMoney(roi.totalPnL)}</span>
          <span class="roi-label" id="hdr-pnl-lbl-${idx}">P&amp;L $</span>
        </div>
        <div class="roi-box">
          <span class="roi-pct ${roiClass}" id="hdr-roi-${idx}">${roiSign}${Math.abs(roi.roiPercent)}%</span>
          <span class="roi-label">ROI</span>
        </div>
        <span class="theme-chevron">▾</span>
      </div>
    </div>
    <div class="theme-body">
      <div class="ai-panel">
        <div class="ai-panel-header">
          <span class="ai-label">Análisis de Estrategia IA</span>
          <div style="display:flex;gap:8px;align-items:center">
            ${tab === 'closed' ? `<button class="btn-simulate" onclick="runSimulation(${idx})">+1¢ Sim</button>` : ''}
            <button class="btn-ai-analyze" onclick="runAIAnalysis(this)" data-theme="${escHtml(theme.theme)}" data-analyzed="false">
              Analizar
            </button>
          </div>
        </div>
        <div class="ai-content-${idx}">
          <span style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">
            Haz clic en "Analizar" para obtener un desglose de la estrategia IA para esta temática.
          </span>
        </div>
      </div>

      <div class="theme-pnl-section" id="theme-pnl-section-${idx}">
        <div class="theme-pnl-header">
          <span class="theme-pnl-label">Profit acumulado (cerradas)</span>
          <div class="theme-pnl-filters" id="theme-pnl-filters-${idx}">
            <button class="theme-pnl-filter-btn" onclick="setThemePnlFilter(${idx},'7d',this)">7D</button>
            <button class="theme-pnl-filter-btn" onclick="setThemePnlFilter(${idx},'14d',this)">14D</button>
            <button class="theme-pnl-filter-btn" onclick="setThemePnlFilter(${idx},'1m',this)">1M</button>
            <button class="theme-pnl-filter-btn active" onclick="setThemePnlFilter(${idx},'all',this)">Todo</button>
          </div>
        </div>
        <div class="theme-pnl-canvas-wrap">
          <canvas id="theme-pnl-${idx}" height="110"></canvas>
        </div>
      </div>

      <div class="market-selection-bar">
        <span class="market-selection-label">Selecciona los mercados a analizar</span>
        <button class="btn-select-toggle" onclick="toggleAllMarkets(this, ${idx})">Ninguno</button>
      </div>

      <div class="markets-grid" id="markets-grid-${idx}">
        ${buildMarketsGridHtml(markets, idx, tab)}
      </div>

      <div class="roi-strip">
        <div class="roi-item">
          <span class="roi-item-val" style="color:var(--text-dim)">$${formatMoney(roi.totalInvested)}</span>
          <span class="roi-item-lbl">Total Invertido</span>
        </div>
        <div class="roi-item">
          <span class="roi-item-val" style="color:var(--accent2)">$${formatMoney(roi.totalCurrent)}</span>
          <span class="roi-item-lbl">Valor Actual</span>
        </div>
        <div class="roi-item">
          <span class="roi-item-val ${roiClass}">${roiSign}$${formatMoney(roi.totalPnL)}</span>
          <span class="roi-item-lbl">G/P</span>
        </div>
        <div class="roi-item">
          <span class="roi-item-val ${roiClass}">${roiSign}${Math.abs(roi.roiPercent)}%</span>
          <span class="roi-item-lbl">ROI</span>
        </div>
      </div>

    </div>
  `;

  return card;
}

function buildMarketCard(market, themeIdx, tab) {
  const isHistory = tab === 'closed';
  const pnl = market.profit ?? 0;
  const pnlClass = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : '';
  const pnlSign = pnl > 0 ? '+' : pnl < 0 ? '-' : '';
  const price = (market.avgPrice * 100).toFixed(1);

  // Línea de fecha
  let dateLine;
  if (isHistory) {
    if (market.lastTradeDate) {
      const d = new Date(market.lastTradeDate * 1000).toLocaleDateString('es-ES', { month:'short', day:'numeric', year:'numeric' });
      dateLine = `📅 Última operación: ${d}`;
    } else {
      dateLine = '';
    }
  } else {
    const d = market.endDate ? new Date(market.endDate).toLocaleDateString('es-ES', { month:'short', day:'numeric', year:'numeric' }) : '—';
    dateLine = `🗓 Resuelve: ${d}`;
  }

  // 4.º stat: en historial muestra G/P$ + ROI%; en activas muestra Valor Actual
  const roiPct = market.roiPct ?? 0;
  const roiClass = roiPct > 0 ? 'pnl-positive' : roiPct < 0 ? 'pnl-negative' : '';
  const roiSign = roiPct > 0 ? '+' : roiPct < 0 ? '-' : '';

  const condId = escHtml(market.conditionId || market.title || '');
  return `
    <div class="market-card" data-market="${escHtml(JSON.stringify(market))}" onclick="openMarketDetail(this.dataset.market)">
      <label class="market-checkbox-wrap" onclick="event.stopPropagation()">
        <input type="checkbox" class="market-checkbox" data-condition-id="${condId}" checked>
      </label>
      <div class="market-title">${escHtml(market.title)}</div>
      <div class="market-outcome ${(market.outcome || 'YES').toUpperCase() === 'YES' ? 'css-yes' : 'css-no'}">${escHtml(market.outcome || 'YES')}</div>
      <div class="market-stats">
        <div class="mstat">
          <span class="mstat-val">${price}%</span>
          <span class="mstat-lbl">Precio Medio</span>
        </div>
        <div class="mstat">
          <span class="mstat-val" style="color:var(--text-dim)">$${formatMoney(parseFloat(market.initialValue || 0) || parseFloat(market.size || 0) * parseFloat(market.avgPrice || 0))}</span>
          <span class="mstat-lbl">Invertido</span>
        </div>
        <div class="mstat">
          <span class="mstat-val ${pnlClass}">${pnlSign}$${formatMoney(pnl)}</span>
          <span class="mstat-lbl">G/P</span>
        </div>
        <div class="mstat">
          ${isHistory
            ? `<span class="mstat-val ${roiClass}">${roiSign}${Math.abs(roiPct).toFixed(1)}%</span>
               <span style="font-family:var(--mono);font-size:13px;font-weight:700;color:${roiPct > 0 ? 'var(--green)' : roiPct < 0 ? 'var(--red)' : 'var(--text-dim)'}">${roiSign}$${formatMoney(pnl)}</span>`
            : `<span class="mstat-val">$${formatMoney(parseFloat(market.currentValue || 0))}</span>
               <span class="mstat-lbl">Valor Actual</span>`
          }
        </div>
      </div>
      ${dateLine ? `<div class="market-end-date">${dateLine}</div>` : ''}
    </div>
  `;
}

// ---- SUBCATEGORY GROUPING ----
const MONTH_RE = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';

// Strips ONLY a trailing date phrase at the very end of the title.
// Handles: "by March 31", "by March 31, 2025", "by end of March", "by end of March 2025"
function canonicalizeTitle(title) {
  if (!title) return '';
  let s = title.trim();
  // "by/before [opt: end of / the end of] [Month] [opt: Day[suffix]][opt: , 20YY] [opt: ?]"
  s = s.replace(
    new RegExp(
      `\\s+(?:by|before)\\s+(?:(?:the\\s+)?end\\s+of\\s+)?` +
      `(?:${MONTH_RE})` +
      `(?:\\s+(?:\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*20\\d{2})?|20\\d{2}))?` +
      `\\s*\\??\\s*$`,
      'i'
    ),
    ''
  );
  s = s.replace(/\s*\?\s*$/, '').trim();
  return (s.length >= 4 ? s : title.trim()).toLowerCase();
}

function buildMarketsGridHtml(markets, themeIdx, tab) {
  const groupMap = new Map();
  markets.forEach(m => {
    let key;
    try {
      key = canonicalizeTitle(m.title);
    } catch (e) {
      console.error('[subcategory] error en canonicalizeTitle para:', m.title, e);
      key = (m.title || '').toLowerCase();
    }
    console.log('[subcategory]', JSON.stringify(m.title), '->', JSON.stringify(key));
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(m);
  });

  const hasGroupsWithMultiple = [...groupMap.values()].some(g => g.length >= 2);

  // Paso 1: construir HTML de subgrupos (grupos con 2+ mercados)
  let subgroupsHtml = '';
  // Paso 2: construir HTML de tarjetas individuales (grupos con 1 mercado)
  let standaloneHtml = '';

  groupMap.forEach((groupMarkets, key) => {
    if (hasGroupsWithMultiple && groupMarkets.length >= 2) {
      let label = key.replace(/^will\s+/i, '').trim();
      label = label.replace(/\b\w/g, c => c.toUpperCase());
      const cardsHtml = groupMarkets.map(m => buildMarketCard(m, themeIdx, tab)).join('');
      subgroupsHtml +=
        '<div class="subgroup-wrapper">' +
          '<div class="subgroup-header" onclick="toggleSubgroup(this)">' +
            '<span class="subgroup-title">' + escHtml(label) + '</span>' +
            '<span class="subgroup-count">' + groupMarkets.length + ' mercados</span>' +
            '<span class="subgroup-chevron">\u25be</span>' +
          '</div>' +
          '<div class="subgroup-body">' + cardsHtml + '</div>' +
        '</div>';
    } else {
      standaloneHtml += groupMarkets.map(m => buildMarketCard(m, themeIdx, tab)).join('');
    }
  });

  // Los subgrupos van primero; las tarjetas individuales después, completamente separadas.
  return subgroupsHtml + standaloneHtml;
}

// ---- TOGGLE CARD ----
function toggleCard(idx) {
  const card = $(`theme-${idx}`);
  card.classList.toggle('open');
  if (card.classList.contains('open')) {
    setTimeout(() => renderThemePnlChart(idx), 50);
  }
}

// ---- SUBGROUP TOGGLE ----
function toggleSubgroup(header) {
  header.closest('.subgroup-wrapper').classList.toggle('open');
}

// ---- MARKET SELECTION TOGGLE ----
function toggleAllMarkets(btn, themeIdx) {
  const grid = $(`markets-grid-${themeIdx}`);
  if (!grid) return;
  const checkboxes = grid.querySelectorAll('.market-checkbox');
  const allChecked = [...checkboxes].every(cb => cb.checked);
  checkboxes.forEach(cb => { cb.checked = !allChecked; });
  btn.textContent = allChecked ? 'Seleccionar todos' : 'Ninguno';
}

// ---- +1¢ SIMULATION ----
function runSimulation(idx) {
  const theme = themesByIdx[idx];
  if (!theme) return;

  const btn      = document.querySelector(`#theme-${idx} .btn-simulate`);
  const pnlSpan  = document.getElementById('hdr-pnl-' + idx);
  const lblSpan  = document.getElementById('hdr-pnl-lbl-' + idx);
  const roiSpan  = document.getElementById('hdr-roi-' + idx);
  if (!pnlSpan || !lblSpan) return;

  // Toggle off → restore real values
  if (simStates[idx]) {
    simStates[idx] = false;
    const roi = theme.closedRoi || theme.roi;
    const sign = roi.totalPnL >= 0 ? '+' : '-';
    const cls  = roi.totalPnL > 0 ? 'roi-positive' : roi.totalPnL < 0 ? 'roi-negative' : 'roi-neutral';
    pnlSpan.className = 'roi-pct ' + cls;
    pnlSpan.textContent = sign + '$' + formatMoney(roi.totalPnL);
    lblSpan.textContent = 'P&L $';
    if (roiSpan) {
      const rSign = roi.roiPercent >= 0 ? '+' : '-';
      roiSpan.className = 'roi-pct ' + cls;
      roiSpan.textContent = rSign + Math.abs(roi.roiPercent) + '%';
    }
    if (btn) btn.classList.remove('btn-simulate-active');
    return;
  }

  // Calculate simulated totals
  const closed = theme.closedMarkets || [];
  let realTotal = 0;
  let simTotal  = 0;
  let totalInvested = 0;

  for (const m of closed) {
    const profit = parseFloat(m.profit ?? 0);
    const shares = parseFloat(m.size   ?? 0);
    const invested = parseFloat(m.initialValue || 0) || shares * parseFloat(m.avgPrice ?? 0);
    realTotal    += profit;
    totalInvested += invested;
    if (profit > 0) {
      simTotal += profit - shares * 0.01;   // paid 1¢ more → earns 1¢×shares less
    } else {
      simTotal += profit;                   // losers unchanged
    }
  }

  const simRoiPct = totalInvested > 0 ? ((simTotal / totalInvested) * 100) : 0;
  const sign  = simTotal >= 0 ? '+' : '-';
  const sCls  = simTotal > 0 ? 'roi-positive' : simTotal < 0 ? 'roi-negative' : 'roi-neutral';

  pnlSpan.className = 'roi-pct sim-active-val';
  pnlSpan.textContent = sign + '$' + formatMoney(Math.abs(simTotal));
  lblSpan.innerHTML = 'P&amp;L $ <span class="sim-badge">+1¢</span>';
  if (roiSpan) {
    roiSpan.className = 'roi-pct sim-active-val';
    roiSpan.textContent = (simRoiPct >= 0 ? '+' : '') + simRoiPct.toFixed(2) + '%';
  }
  if (btn) btn.classList.add('btn-simulate-active');
  simStates[idx] = true;
}

// ---- AI ANALYSIS ----
async function runAIAnalysis(btn) {
  if (btn.disabled) return;

  const themeName = btn.dataset.theme;
  const theme = currentData.themes.find(t => t.theme === themeName);
  if (!theme) return;

  btn.textContent = 'Analizando...';
  btn.disabled = true;

  // Find the ai-content div inside the same theme-body as this button
  const contentDiv = btn.closest('.theme-body').querySelector('[class^="ai-content-"]');
  contentDiv.innerHTML = '<span class="ai-loading">Claude está analizando esta estrategia...</span>';

  try {
    const grid = btn.closest('.theme-body').querySelector('[id^="markets-grid-"]');
    const checkedBoxes = grid ? [...grid.querySelectorAll('.market-checkbox:checked')] : [];
    const checkedIds = new Set(checkedBoxes.map(cb => cb.dataset.conditionId));

    const allMarkets = [...(theme.activeMarkets || []), ...(theme.closedMarkets || [])];
    const hasCheckboxes = grid && grid.querySelectorAll('.market-checkbox').length > 0;
    const markets = hasCheckboxes
      ? allMarkets.filter(m => checkedIds.has(m.conditionId || m.title || ''))
      : allMarkets;

    if (markets.length === 0) {
      contentDiv.innerHTML = '<span style="font-family:var(--mono);font-size:12px;color:var(--yellow)">Selecciona al menos un mercado para analizar.</span>';
      btn.textContent = 'Analizar';
      btn.disabled = false;
      return;
    }

    const trades = hasCheckboxes
      ? (theme.trades || []).filter(t => !t.conditionId || checkedIds.has(t.conditionId))
      : (theme.trades || []);

    const res = await fetch('/api/analyze-theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: theme.theme, markets, trades })
    });
    const data = await res.json();
    if (data.analysis) {
      contentDiv.innerHTML = `<div class="ai-analysis-text">${mdToHtml(data.analysis)}</div>`;
      btn.textContent = '✓ Listo';
      btn.dataset.analyzed = 'true';
    } else {
      contentDiv.innerHTML = `<span style="color:var(--red);font-family:var(--mono);font-size:12px">${data.error || 'Análisis fallido'}</span>`;
      btn.textContent = 'Reintentar';
      btn.disabled = false;
    }
  } catch (e) {
    contentDiv.innerHTML = `<span style="color:var(--red);font-family:var(--mono);font-size:12px">Error: ${e.message}</span>`;
    btn.textContent = 'Reintentar';
    btn.disabled = false;
  }
}

// ---- MARKET DETAIL MODAL ----
function openMarketDetail(marketJson) {
  const market = JSON.parse(marketJson);
  const modal = $('marketModal');
  const content = $('modalContent');

  const pnl = market.profit ?? 0;
  const pnlClass = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : '';
  const pnlSign = pnl > 0 ? '+' : pnl < 0 ? '-' : '';
  const price = market.avgPrice ?? 0;
  const shares = parseFloat(market.size || 0);
  const endDate = market.endDate ? new Date(market.endDate).toLocaleDateString('es-ES', {
    month: 'long', day: 'numeric', year: 'numeric'
  }) : '—';

  const currentCost = shares * price;
  const potentialReturn = shares;
  const impliedOdds = price > 0 ? (1 / price).toFixed(2) : '—';

  content.innerHTML = `
    <div class="modal-market-title">${escHtml(market.title)}</div>

    <div class="modal-chart-container">
      <canvas id="modalChart" height="200"></canvas>
    </div>

    <div class="modal-details">
      <div class="modal-detail">
        <div class="modal-detail-val">${(price * 100).toFixed(1)}%</div>
        <div class="modal-detail-lbl">Precio Medio de Entrada</div>
      </div>
      <div class="modal-detail">
        <div class="modal-detail-val">${shares.toFixed(0)}</div>
        <div class="modal-detail-lbl">Participaciones</div>
      </div>
      <div class="modal-detail">
        <div class="modal-detail-val ${pnlClass}">${pnlSign}$${formatMoney(pnl)}</div>
        <div class="modal-detail-lbl">G/P No Realizado</div>
      </div>
    </div>

    <div class="scenarios-section">
      <div class="scenarios-title">📊 Escenarios de Pago</div>
      <div class="scenario-row">
        <span class="scenario-label">Si gana <strong>${escHtml(market.outcome || 'YES')}</strong></span>
        <span class="scenario-value" style="color:var(--green)">+$${formatMoney(potentialReturn)} (${((potentialReturn / currentCost - 1) * 100).toFixed(0)}% de retorno)</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">Si la posición pierde</span>
        <span class="scenario-value" style="color:var(--red)">-$${formatMoney(currentCost)}</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">Probabilidad implícita</span>
        <span class="scenario-value" style="color:var(--accent)">${(price * 100).toFixed(1)}%</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">Cuota implícita</span>
        <span class="scenario-value">${impliedOdds}x</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">Resuelve</span>
        <span class="scenario-value" style="color:var(--text-dim)">${endDate}</span>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  const ctx = document.getElementById('modalChart');
  if (ctx) {
    if (chartInstances['modal']) chartInstances['modal'].destroy();
    const labels = generateDateLabels(30);
    const priceData = generateMockPriceSeries(price, 30);

    chartInstances['modal'] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: market.outcome || 'YES',
          data: priceData,
          borderColor: '#00d4aa',
          backgroundColor: 'rgba(0, 212, 170, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${(ctx.raw * 100).toFixed(1)}%`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: '#5a7a9a', font: { family: 'Space Mono', size: 10 }, maxTicksLimit: 6 },
            grid: { color: '#1e2d3d' }
          },
          y: {
            ticks: {
              color: '#5a7a9a',
              font: { family: 'Space Mono', size: 10 },
              callback: v => `${(v * 100).toFixed(0)}%`
            },
            grid: { color: '#1e2d3d' },
            min: 0, max: 1
          }
        }
      }
    });

    if (market.conditionId) {
      fetchAndUpdateChart(market.conditionId, market.outcome);
    }
  }
}

async function fetchAndUpdateChart(conditionId, outcome) {
  try {
    const res = await fetch(`/api/price-history?conditionId=${conditionId}`);
    const data = await res.json();
    if (data.history && data.history.length > 2) {
      const chart = chartInstances['modal'];
      if (!chart) return;
      chart.data.labels = data.history.map(h =>
        new Date(h.t * 1000).toLocaleDateString('es-ES', { month: 'short', day: 'numeric' })
      );
      chart.data.datasets[0].data = data.history.map(h => h.p);
      chart.update();
    }
  } catch (e) {
    // Mantener datos de muestra
  }
}

function closeModal(e) {
  if (e.target === $('marketModal')) closeModalDirect();
}
function closeModalDirect() {
  $('marketModal').classList.add('hidden');
  if (chartInstances['modal']) {
    chartInstances['modal'].destroy();
    delete chartInstances['modal'];
  }
}

// ---- UTILITIES ----
function generateDateLabels(n) {
  const labels = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString('es-ES', { month: 'short', day: 'numeric' }));
  }
  return labels;
}

function generateMockPriceSeries(endPrice, n) {
  const data = [];
  let price = 0.5 + (Math.random() - 0.5) * 0.3;
  for (let i = 0; i < n; i++) {
    price += (Math.random() - 0.48) * 0.03;
    price = Math.max(0.02, Math.min(0.98, price));
    if (i === n - 1) price = endPrice;
    data.push(parseFloat(price.toFixed(3)));
  }
  return data;
}

function mdToHtml(text) {
  // Escape HTML first, then convert markdown
  let s = escHtml(text);
  // #### / ### / ## headings
  s = s.replace(/^#{1,4} (.+)$/gm, '<strong style="font-size:13px;display:block;margin-top:10px;color:var(--text-bright)">$1</strong>');
  // **bold**
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // *italic*
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Blank lines → paragraph break with spacing
  s = s.replace(/\n\n+/g, '<br><br>');
  // Single newlines → line break (preserves scenario table lines)
  s = s.replace(/\n/g, '<br>');
  return s;
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- ATAJO DE TECLADO ----
$('walletInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startAnalysis();
});

// Cerrar modal con Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModalDirect();
});
