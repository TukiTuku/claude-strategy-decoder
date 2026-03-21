// ============================================
// STRATEGY DECODER — Frontend App Logic
// ============================================

let currentData = null;
let currentTab = 'active';
let chartInstances = {};

// ---- UI HELPERS ----
function $(id) { return document.getElementById(id); }

function showOnly(section) {
  ['loadingState', 'errorState', 'resultsSection'].forEach(id => {
    $(id).classList.add('hidden');
  });
  if (section) $(section).classList.remove('hidden');
}

function setWallet(addr) {
  $('walletInput').value = addr;
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

  // Reset loading steps
  loadStep = 0;
  ['ls1','ls2','ls3','ls4'].forEach(id => {
    const el = $(id);
    if (el) { el.classList.remove('active', 'done'); }
  });

  showOnly('loadingState');
  advanceLoadStep();

  const btn = $('analyzeBtn');
  btn.classList.add('loading');
  btn.querySelector('.btn-text').textContent = 'Analyzing...';

  try {
    // Step 1 in progress (fetch)
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet })
    });

    advanceLoadStep(); // step 2 — grouping

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Server error');
    }

    const data = await response.json();
    currentData = data;

    advanceLoadStep(); // step 3 — ROI
    await sleep(300);
    advanceLoadStep(); // step 4 — charts
    await sleep(300);

    renderResults(data);
    showOnly('resultsSection');

  } catch (err) {
    $('errorMsg').textContent = err.message;
    showOnly('errorState');
  } finally {
    btn.classList.remove('loading');
    btn.querySelector('.btn-text').textContent = 'Analyze';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---- RENDER RESULTS ----
function renderResults(data) {
  // Summary bar
  $('summaryWallet').textContent = data.wallet;
  $('statActive').textContent = data.activePositions ?? '—';
  $('statClosed').textContent = data.closedPositions ?? '—';
  $('statTrades').textContent = data.totalTrades ?? '—';
  $('statThemes').textContent = data.themes?.length ?? '—';

  renderThemes(data.themes, currentTab);
}

function switchTab(tab, btn) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (currentData) renderThemes(currentData.themes, tab);
}

function renderThemes(themes, tab) {
  const container = $('themesContainer');
  container.innerHTML = '';

  // Destroy old charts
  Object.values(chartInstances).forEach(c => c.destroy());
  chartInstances = {};

  const relevantThemes = themes.filter(t => {
    const markets = tab === 'active' ? t.activeMarkets : t.closedMarkets;
    return markets && markets.length > 0;
  });

  if (relevantThemes.length === 0) {
    container.innerHTML = `<div class="empty-state">No ${tab} positions found for this wallet.</div>`;
    return;
  }

  relevantThemes.forEach((theme, idx) => {
    const markets = tab === 'active' ? theme.activeMarkets : theme.closedMarkets;
    const card = buildThemeCard(theme, markets, tab, idx);
    container.appendChild(card);
  });
}

function buildThemeCard(theme, markets, tab, idx) {
  const card = document.createElement('div');
  card.className = 'theme-card';
  card.id = `theme-${idx}`;

  const roi = theme.roi;
  const roiClass = roi.roiPercent > 0 ? 'roi-positive' : roi.roiPercent < 0 ? 'roi-negative' : 'roi-neutral';
  const roiSign = roi.roiPercent > 0 ? '+' : '';
  const badgeType = tab === 'active' ? 'badge-active' : 'badge-closed';
  const badgeText = tab === 'active' ? `${markets.length} ACTIVE` : `${markets.length} CLOSED`;

  card.innerHTML = `
    <div class="theme-header" onclick="toggleCard(${idx})">
      <div class="theme-title-row">
        <span class="theme-name">${escHtml(theme.theme)}</span>
        <span class="theme-badge ${badgeType}">${badgeText}</span>
        ${theme.tradeCount > 0 ? `<span class="theme-badge badge-closed">${theme.tradeCount} TRADES</span>` : ''}
      </div>
      <div class="theme-roi-row">
        <div class="roi-box">
          <span class="roi-pct ${roiClass}">${roiSign}${roi.roiPercent}%</span>
          <span class="roi-label">ROI</span>
        </div>
        <span class="theme-chevron">▾</span>
      </div>
    </div>
    <div class="theme-body">
      <div class="ai-panel">
        <div class="ai-panel-header">
          <span class="ai-label">AI Strategy Analysis</span>
          <button class="btn-ai-analyze" onclick="runAIAnalysis(${idx}, this)" data-analyzed="false">
            Run Analysis
          </button>
        </div>
        <div class="ai-content-${idx}">
          <span style="font-family:var(--mono);font-size:12px;color:var(--text-dim)">
            Click "Run Analysis" to generate an AI strategy breakdown for this theme.
          </span>
        </div>
      </div>

      <div class="markets-grid" id="markets-grid-${idx}">
        ${markets.map(m => buildMarketCard(m, idx)).join('')}
      </div>

      <div class="roi-strip">
        <div class="roi-item">
          <span class="roi-item-val" style="color:var(--text-dim)">$${roi.totalInvested.toFixed(2)}</span>
          <span class="roi-item-lbl">Invested</span>
        </div>
        <div class="roi-item">
          <span class="roi-item-val" style="color:var(--accent2)">$${roi.totalCurrent.toFixed(2)}</span>
          <span class="roi-item-lbl">Current Value</span>
        </div>
        <div class="roi-item">
          <span class="roi-item-val ${roiClass}">${roiSign}$${Math.abs(roi.totalPnL).toFixed(2)}</span>
          <span class="roi-item-lbl">P&L</span>
        </div>
        <div class="roi-item">
          <span class="roi-item-val ${roiClass}">${roiSign}${roi.roiPercent}%</span>
          <span class="roi-item-lbl">ROI</span>
        </div>
      </div>
    </div>
  `;

  return card;
}

function buildMarketCard(market, themeIdx) {
  const pnl = market.profit ?? 0;
  const pnlClass = pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : '';
  const pnlSign = pnl > 0 ? '+' : '';
  const price = (market.avgPrice * 100).toFixed(1);
  const endDate = market.endDate ? new Date(market.endDate).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
  const impliedProb = `${price}%`;

  return `
    <div class="market-card" onclick="openMarketDetail(${JSON.stringify(JSON.stringify(market))})">
      <div class="market-title">${escHtml(market.title)}</div>
      <div class="market-outcome">${escHtml(market.outcome || 'YES')}</div>
      <div class="market-stats">
        <div class="mstat">
          <span class="mstat-val">${impliedProb}</span>
          <span class="mstat-lbl">Avg Entry</span>
        </div>
        <div class="mstat">
          <span class="mstat-val">${parseFloat(market.size || 0).toFixed(0)}</span>
          <span class="mstat-lbl">Shares</span>
        </div>
        <div class="mstat">
          <span class="mstat-val ${pnlClass}">${pnlSign}$${Math.abs(pnl).toFixed(2)}</span>
          <span class="mstat-lbl">P&L</span>
        </div>
        <div class="mstat">
          <span class="mstat-val">$${parseFloat(market.currentValue || 0).toFixed(2)}</span>
          <span class="mstat-lbl">Current Val</span>
        </div>
      </div>
      <div class="market-end-date">🗓 Resolves: ${endDate}</div>
    </div>
  `;
}

// ---- TOGGLE CARD ----
function toggleCard(idx) {
  const card = $(`theme-${idx}`);
  card.classList.toggle('open');
}

// ---- AI ANALYSIS ----
async function runAIAnalysis(themeIdx, btn) {
  if (btn.dataset.analyzed === 'true') return;

  const theme = currentData.themes.find((_, i) => i === themeIdx);
  if (!theme) return;

  btn.textContent = 'Analyzing...';
  btn.disabled = true;

  const contentDiv = document.querySelector(`.ai-content-${themeIdx}`);
  contentDiv.innerHTML = '<span class="ai-loading">Claude is analyzing this strategy...</span>';

  try {
    const markets = [...(theme.activeMarkets || []), ...(theme.closedMarkets || [])];
    const res = await fetch('/api/analyze-theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: theme.theme, markets, trades: [] })
    });
    const data = await res.json();
    if (data.analysis) {
      contentDiv.innerHTML = `<div class="ai-analysis-text">${escHtml(data.analysis)}</div>`;
      btn.textContent = '✓ Done';
      btn.dataset.analyzed = 'true';
    } else {
      contentDiv.innerHTML = `<span style="color:var(--red);font-family:var(--mono);font-size:12px">${data.error || 'Analysis failed'}</span>`;
      btn.textContent = 'Retry';
      btn.disabled = false;
    }
  } catch (e) {
    contentDiv.innerHTML = `<span style="color:var(--red);font-family:var(--mono);font-size:12px">Error: ${e.message}</span>`;
    btn.textContent = 'Retry';
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
  const pnlSign = pnl > 0 ? '+' : '';
  const price = market.avgPrice ?? 0;
  const shares = parseFloat(market.size || 0);
  const endDate = market.endDate ? new Date(market.endDate).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric'
  }) : '—';

  // Scenario calculations
  const maxWin = shares * (1 - price); // cost was price*shares, win (1-price)*shares if YES
  const currentCost = shares * price;
  const potentialReturn = shares; // 1 per share if wins
  const impliedOdds = price > 0 ? (1 / price).toFixed(2) : '—';

  content.innerHTML = `
    <div class="modal-market-title">${escHtml(market.title)}</div>

    <div class="modal-chart-container">
      <canvas id="modalChart" height="200"></canvas>
    </div>

    <div class="modal-details">
      <div class="modal-detail">
        <div class="modal-detail-val">${(price * 100).toFixed(1)}%</div>
        <div class="modal-detail-lbl">Avg Entry Price</div>
      </div>
      <div class="modal-detail">
        <div class="modal-detail-val">${shares.toFixed(0)}</div>
        <div class="modal-detail-lbl">Shares Held</div>
      </div>
      <div class="modal-detail">
        <div class="modal-detail-val ${pnlClass}">${pnlSign}$${Math.abs(pnl).toFixed(2)}</div>
        <div class="modal-detail-lbl">Unrealized P&L</div>
      </div>
    </div>

    <div class="scenarios-section">
      <div class="scenarios-title">📊 Payout Scenarios</div>
      <div class="scenario-row">
        <span class="scenario-label">If <strong>${escHtml(market.outcome || 'YES')}</strong> wins</span>
        <span class="scenario-value" style="color:var(--green)">+$${potentialReturn.toFixed(2)} (${((potentialReturn / currentCost - 1) * 100).toFixed(0)}% return)</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">If position loses</span>
        <span class="scenario-value" style="color:var(--red)">-$${currentCost.toFixed(2)}</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">Implied probability</span>
        <span class="scenario-value" style="color:var(--accent)">${(price * 100).toFixed(1)}%</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">Implied odds</span>
        <span class="scenario-value">${impliedOdds}x</span>
      </div>
      <div class="scenario-row">
        <span class="scenario-label">Resolves</span>
        <span class="scenario-value" style="color:var(--text-dim)">${endDate}</span>
      </div>
    </div>
  `;

  modal.classList.remove('hidden');

  // Draw placeholder price chart
  const ctx = document.getElementById('modalChart');
  if (ctx) {
    if (chartInstances['modal']) chartInstances['modal'].destroy();
    // Generate mock price evolution if we don't have real history
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

    // Try to fetch real price history
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
        new Date(h.t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      );
      chart.data.datasets[0].data = data.history.map(h => h.p);
      chart.update();
    }
  } catch (e) {
    // Keep mock data
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
    labels.push(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
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

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---- KEYBOARD SHORTCUT ----
$('walletInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') startAnalysis();
});

// Close modal on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModalDirect();
});
