const DATA_FILE_URL = './data.json';
const REALTIME_PROXY_URLS = ['./api/realtime', '/api/realtime'];
const DATA_CACHE_KEY = 'voltage-monitor-cache';
const TWO_HOURS_IN_MS = 2 * 60 * 60 * 1000;
const pageLoadedAt = new Date();

// Chart configuration
let chart = null;
const maxDataPoints = 60;
const dotIntervalMinutes = 5;
let chartData = {
  labels: [],
  datasets: [{
    label: 'Voltage (V)',
    data: [],
    borderColor: '#667eea',
    backgroundColor: 'rgba(102, 126, 234, 0.1)',
    tension: 0.4,
    fill: true,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointBackgroundColor: '#667eea',
    pointBorderColor: '#fff',
    pointBorderWidth: 2,
  }]
};

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
        y: { beginAtZero: false, min: 0, max: 20, ticks: { color: '#999' }, grid: { color: 'rgba(0, 0, 0, 0.05)' } },
        x: { ticks: { color: '#999', maxTicksLimit: 6 }, grid: { color: 'rgba(0, 0, 0, 0.05)' } }
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
  return {
    records: Array.isArray(payload.records) ? payload.records : [],
    updatedAt: payload.updatedAt
  };
}

async function fetchData() {
  try {
    const records = await fetchRealtimeData();
    updateUi(records);
  } catch (error) {
    console.warn('[realtime] failed, falling back to data.json:', error.message);
    try {
      const fallback = await fetchCachedData();
      updateUi(fallback.records);
    } catch (fallbackError) {
      console.error('Error fetching data:', fallbackError);
      updateStatus(false);
    }
  }
}

function updateUi(data) {
  if (!data.length) {
    updateStatus(false);
    return;
  }

  const latestData = data[data.length - 1];
  document.getElementById('voltageValue').textContent = toNumber(latestData.voltage).toFixed(2);
  document.getElementById('currentValue').textContent = toNumber(latestData.current).toFixed(2);
  document.getElementById('powerValue').textContent = toNumber(latestData.power).toFixed(2);

  document.getElementById('lastUpdate').textContent = pageLoadedAt.toLocaleTimeString();

  updateChart(data);
  updateStatus(true);
}

function toNumber(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
}

function formatTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? String(timestamp || '') : parsed.toLocaleTimeString();
}

function isFiveMinutePoint(timestamp) {
  const parsed = new Date(timestamp);
  return !Number.isNaN(parsed.getTime()) && parsed.getMinutes() % dotIntervalMinutes === 0;
}

function updateChart(data) {
  const now = Date.now();
  const twoHoursAgo = now - TWO_HOURS_IN_MS;
  const twoHourWindow = data.filter((item) => {
    const time = new Date(item.timestamp).getTime();
    return Number.isFinite(time) && time >= twoHoursAgo && time <= now;
  });
  const recentData = twoHourWindow.slice(-maxDataPoints);

  chartData.labels = recentData.map((item, index) => (index % 10 === 0 ? formatTimestamp(item.timestamp) : ''));
  chartData.datasets[0].data = recentData.map((item) => toNumber(item.voltage));
  chartData.datasets[0].pointRadius = recentData.map((item) => (isFiveMinutePoint(item.timestamp) ? 4 : 0));

  const voltages = recentData.map((item) => toNumber(item.voltage));
  const maxVoltage = Math.max(...voltages);
  const minVoltage = Math.min(...voltages);

  chart.options.scales.y.min = Math.max(0, minVoltage - 1);
  chart.options.scales.y.max = Math.ceil(maxVoltage + 1);
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
