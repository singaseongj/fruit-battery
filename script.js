const DATA_FILE_URL = './data.json';
const REALTIME_PROXY_URLS = ['./api/realtime', '/api/realtime'];
const DATA_CACHE_KEY = 'voltage-monitor-cache';
const TWO_HOURS_IN_MS = 2 * 60 * 60 * 1000;
const FIVE_MINUTES_IN_MS = 5 * 60 * 1000;
const TEN_MINUTES_IN_MS = 10 * 60 * 1000;

// Chart configuration
let chart = null;
let chartData = {
  labels: [],
  datasets: [{
    label: 'Voltage (V)',
    data: [],
    borderColor: '#667eea',
    backgroundColor: 'rgba(102, 126, 234, 0.1)',
    tension: 0.25,
    fill: true,
    pointRadius: [],
    pointHoverRadius: 5,
    pointBackgroundColor: '#667eea',
    pointBorderColor: '#fff',
    pointBorderWidth: 2,
  }]
};

function shouldUseRealtimeApi() {
  const { protocol, hostname } = window.location;
  if (protocol === 'file:') return false;
  if (hostname.endsWith('github.io')) return false;
  return true;
}

function initChart() {
  const ctx = document.getElementById('voltageChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true, labels: { color: '#666', font: { size: 14 } } } },
      scales: {
        y: { beginAtZero: true, min: 0, max: 20, ticks: { color: '#999' }, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
        x: { ticks: { color: '#999', maxTicksLimit: 8 }, grid: { color: 'rgba(0, 0, 0, 0.05)' } }
      }
    }
  });
}

async function fetchRealtimeData() {
  let lastError = null;

  for (const url of REALTIME_PROXY_URLS) {
    try {
      const response = await fetch(`${url}?t=${Date.now()}`, {
        cache: 'reload',
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      return Array.isArray(payload.records) ? payload.records : [];
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Unable to load realtime data');
}

async function fetchCachedData() {
  const response = await fetch(`${DATA_FILE_URL}?t=${Date.now()}`, {
    cache: 'reload',
    headers: { 'Cache-Control': 'no-cache' }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.records) ? payload.records : [];
}

async function fetchData() {
  if (!shouldUseRealtimeApi()) {
    try {
      const fallbackRecords = await fetchCachedData();
      updateUi(fallbackRecords);
    } catch (fallbackError) {
      console.error('Error fetching data:', fallbackError);
      updateUi([]);
    }
    return;
  }

  try {
    const records = await fetchRealtimeData();
    updateUi(records);
  } catch (error) {
    console.warn('[realtime] failed, falling back to data.json:', error.message);
    try {
      const fallbackRecords = await fetchCachedData();
      updateUi(fallbackRecords);
    } catch (fallbackError) {
      console.error('Error fetching data:', fallbackError);
      updateUi([]);
    }
  }
}

function updateUi(data) {
  const latestData = getLatestDataPoint(data);
  const isConnected = Boolean(latestData) && (Date.now() - latestData.timeMs <= TEN_MINUTES_IN_MS);

  if (latestData) {
    document.getElementById('voltageValue').textContent = toNumber(latestData.raw.voltage).toFixed(2);
    document.getElementById('currentValue').textContent = toNumber(latestData.raw.current).toFixed(2);
    document.getElementById('powerValue').textContent = toNumber(latestData.raw.power).toFixed(2);
    document.getElementById('lastUpdate').textContent = new Date(latestData.timeMs).toLocaleTimeString();
  } else {
    document.getElementById('voltageValue').textContent = '0.00';
    document.getElementById('currentValue').textContent = '0.00';
    document.getElementById('powerValue').textContent = '0.00';
    document.getElementById('lastUpdate').textContent = '--';
  }

  updateChart(data);
  updateStatus(isConnected);
}

function getLatestDataPoint(data) {
  let latest = null;
  for (const item of data) {
    const timeMs = new Date(item.timestamp).getTime();
    if (!Number.isFinite(timeMs)) continue;
    if (!latest || timeMs > latest.timeMs) {
      latest = { raw: item, timeMs };
    }
  }
  return latest;
}

function toNumber(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
}

function buildTwoHourTimeline(data) {
  const now = Date.now();
  const end = Math.floor(now / FIVE_MINUTES_IN_MS) * FIVE_MINUTES_IN_MS;
  const start = end - TWO_HOURS_IN_MS;

  const pointsBySlot = new Map();
  for (const item of data) {
    const ts = new Date(item.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < start || ts > end + FIVE_MINUTES_IN_MS) continue;

    const slot = Math.floor(ts / FIVE_MINUTES_IN_MS) * FIVE_MINUTES_IN_MS;
    const existing = pointsBySlot.get(slot);
    if (!existing || ts > existing.timeMs) {
      pointsBySlot.set(slot, { timeMs: ts, voltage: toNumber(item.voltage) });
    }
  }

  const timeline = [];
  for (let slotMs = start; slotMs <= end; slotMs += FIVE_MINUTES_IN_MS) {
    const sample = pointsBySlot.get(slotMs);
    timeline.push({
      slotMs,
      voltage: sample ? sample.voltage : 0,
      hasData: Boolean(sample)
    });
  }

  return timeline;
}

function updateChart(data) {
  const timeline = buildTwoHourTimeline(data);

  chartData.labels = timeline.map((point, index) => (
    index % 2 === 0
      ? new Date(point.slotMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : ''
  ));
  chartData.datasets[0].data = timeline.map((point) => point.voltage);
  chartData.datasets[0].pointRadius = timeline.map((point) => (point.hasData ? 4 : 2));

  const voltages = chartData.datasets[0].data;
  const maxVoltage = voltages.length ? Math.max(...voltages) : 0;
  chart.options.scales.y.min = 0;
  chart.options.scales.y.max = Math.max(5, Math.ceil(maxVoltage + 1));
  chart.update('none');
}

function updateStatus(connected) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const connectionStatus = connected ? 'Connected' : 'Disconnected';

  if (connected) {
    statusDot.classList.add('connected');
    statusText.textContent = connectionStatus;
    statusText.style.color = '#2ed573';
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = connectionStatus;
    statusText.style.color = '#ff4757';
  }
}

function clearInMemoryState() {
  chartData.labels = [];
  chartData.datasets[0].data = [];
  chartData.datasets[0].pointRadius = [];
  if (chart) chart.update('none');
}

function clearBrowserCacheHint() {
  try { sessionStorage.removeItem(DATA_CACHE_KEY); } catch (_error) {}
}

window.addEventListener('beforeunload', () => {
  clearInMemoryState();
  clearBrowserCacheHint();
});

document.addEventListener('DOMContentLoaded', () => {
  clearBrowserCacheHint();
  initChart();
  fetchData();

  const refreshButton = document.getElementById('refreshButton');
  refreshButton.addEventListener('click', () => {
    fetchData();
  });

  setInterval(fetchData, 60 * 1000);
});
