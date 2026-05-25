'use strict';

// Resolve API base from the page location so an optional path prefix works
// (access the dashboard WITH a trailing slash when using a prefix).
const BASE = location.pathname.replace(/\/[^/]*$/, '');
const api = (p) => `${BASE}${p}`;

const $ = (id) => document.getElementById(id);

let chart = null;
let autoTail = true;

function fmtUsd(v) {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
function fmtPct(v) {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}
function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function tsShort(ms) {
  return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
}
function cls(v) {
  return v >= 0 ? 'pos' : 'neg';
}

function renderLoop(loop) {
  const dot = $('loop-state').querySelector('.dot');
  const label = $('loop-label');
  $('btn-start').classList.add('hidden');
  $('btn-stop').classList.add('hidden');
  $('stop-confirm').classList.add('hidden');
  $('adopted-banner').classList.toggle('hidden', !loop.adopted);

  if (loop.running) {
    dot.className = 'dot dot-green';
    label.textContent = `running ${fmtClock(loop.uptimeSec)}`;
    $('btn-stop').classList.remove('hidden');
  } else {
    dot.className = 'dot dot-gray';
    label.textContent = 'stopped';
    $('btn-start').classList.remove('hidden');
  }
}

function kpi(label, value, sub, valueCls) {
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value ${valueCls || ''}">${value}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}</div>`;
}

function renderStats(s, llm) {
  $('equity').textContent = `$${s.equityNow.toFixed(2)}`;
  $('strategy').textContent = `strategy: ${s.strategyName}`;
  const delta = s.equityNow - s.startingEquity;
  $('delta').textContent = fmtUsd(delta);
  $('delta').className = `delta mono ${cls(delta)}`;
  $('delta-pct').textContent = fmtPct(s.realizedPnlPct);
  $('daily-gate').textContent = s.dailyGate.allowed
    ? `OK (DD ${s.dailyGate.ddPct.toFixed(2)}%, streak ${s.dailyGate.streak})`
    : s.dailyGate.reason || 'BLOCKED';
  $('daily-gate').className = s.dailyGate.allowed ? 'mono pos' : 'mono neg';

  $('kpi-grid').innerHTML = [
    kpi('Trades closed', s.tradesClosed),
    kpi('Open', s.tradesOpen),
    kpi('Win rate', `${(s.winRateTotal * 100).toFixed(1)}%`),
    kpi('Win rate buy', `${(s.winRateBuy * 100).toFixed(1)}%`, `${s.winsBuy}/${s.totalBuy}`),
    kpi('Win rate sell', `${(s.winRateSell * 100).toFixed(1)}%`, `${s.winsSell}/${s.totalSell}`),
    kpi('Max DD', `-${s.maxDdPct.toFixed(2)}%`, '', 'neg'),
    kpi('Avg holding', `${s.avgHoldingMinutes.toFixed(0)}m`),
    kpi('Avg R/R', s.avgRrRatio.toFixed(2)),
    kpi('Open PnL', fmtUsd(s.openPnlQuote), '', cls(s.openPnlQuote)),
    kpi('LLM cost', `$${llm.totalUsd.toFixed(4)}`, `${(llm.inputTokens / 1000).toFixed(0)}k in / ${(llm.outputTokens / 1000).toFixed(1)}k out`),
  ].join('');
}

function renderOpen(rows) {
  const body = $('open-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="7">no open positions</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (t) => `<tr>
      <td>${t.symbol}</td><td>${t.side}</td><td>${t.qty}</td>
      <td>${t.entry.toFixed(2)}</td><td>${t.currentPrice.toFixed(2)}</td>
      <td class="${cls(t.pnlQuote)}">${fmtUsd(t.pnlQuote)}</td>
      <td class="${cls(t.pnlPct)}">${fmtPct(t.pnlPct)}</td></tr>`,
    )
    .join('');
}

function renderDecisions(rows) {
  const body = $('decision-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="6">no decisions yet</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (d) => `<tr>
      <td>${tsShort(d.ts)}</td><td>${d.symbol}</td><td>${d.action}</td>
      <td>${d.confidence}%</td><td>${d.executed ? 'EXEC' : 'skip'}</td>
      <td class="dim">${(d.skipReason || d.reason || '').slice(0, 60)}</td></tr>`,
    )
    .join('');
}

function renderClosed(rows) {
  const body = $('closed-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td class="empty" colspan="8">no closed trades</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map(
      (t) => `<tr>
      <td>${tsShort(t.closedTs)}</td><td>${t.symbol}</td><td>${t.side}</td>
      <td>${t.entry.toFixed(2)}</td><td>${t.exit.toFixed(2)}</td>
      <td class="${cls(t.pnlPct)}">${fmtPct(t.pnlPct)}</td>
      <td>${t.status}</td><td>${t.holdingHours.toFixed(1)}h</td></tr>`,
    )
    .join('');
}

function renderChart(curve) {
  const labels = curve.map((p) => tsShort(p.ts));
  const data = curve.map((p) => p.equity);
  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update('none');
    return;
  }
  const ctx = $('curve').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ data, borderColor: '#f5f1e8', borderWidth: 1.5, pointRadius: 0, tension: 0.18, fill: false }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: '#1c1c1c' }, ticks: { color: '#6b6660', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 8 } },
        y: { grid: { color: '#1c1c1c' }, ticks: { color: '#6b6660', font: { family: 'JetBrains Mono', size: 10 } } },
      },
    },
  });
}

function render(snap) {
  renderLoop(snap.loop);
  renderStats(snap.stats, snap.llmCost);
  renderOpen(snap.openTrades);
  renderDecisions(snap.decisions);
  renderClosed(snap.closedTrades);
  renderChart(snap.equityCurve);
}

function appendLog(entry) {
  const body = $('log-body');
  const span = document.createElement('span');
  span.className = entry.stream === 'stderr' ? 'err' : '';
  span.textContent = `${new Date(entry.ts).toISOString().slice(11, 19)}  ${entry.line}\n`;
  body.appendChild(span);
  while (body.childNodes.length > 800) body.removeChild(body.firstChild);
  if (autoTail) body.scrollTop = body.scrollHeight;
}

// --- controls ---
$('btn-start').addEventListener('click', async () => {
  await fetch(api('/api/start'), { method: 'POST' });
});
$('btn-stop').addEventListener('click', () => {
  $('btn-stop').classList.add('hidden');
  $('stop-confirm').classList.remove('hidden');
  setTimeout(() => {
    $('stop-confirm').classList.add('hidden');
    $('btn-stop').classList.remove('hidden');
  }, 5000);
});
$('btn-stop-yes').addEventListener('click', async () => {
  await fetch(api('/api/stop'), { method: 'POST' });
});
$('btn-stop-cancel').addEventListener('click', () => {
  $('stop-confirm').classList.add('hidden');
  $('btn-stop').classList.remove('hidden');
});

// --- log drawer ---
$('log-toggle').addEventListener('click', () => {
  $('log-drawer').classList.toggle('collapsed');
});
$('log-body').addEventListener('scroll', () => {
  const b = $('log-body');
  autoTail = b.scrollTop + b.clientHeight >= b.scrollHeight - 20;
});

// --- cold load of recent logs ---
fetch(api('/api/logs?n=200'))
  .then((r) => r.json())
  .then((lines) => lines.forEach(appendLog))
  .catch(() => {});

// --- live stream ---
const es = new EventSource(api('/api/stream'));
es.addEventListener('snapshot', (e) => render(JSON.parse(e.data)));
es.addEventListener('log', (e) => appendLog(JSON.parse(e.data)));
es.addEventListener('loop', () => {
  // a status flip will arrive via the next snapshot; force an immediate refresh
  fetch(api('/api/status')).then((r) => r.json()).then(render).catch(() => {});
});
