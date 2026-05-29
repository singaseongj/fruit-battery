const DATA_FILE_URL = './data.json';
const DATA_CACHE_KEY = 'voltage-monitor-cache';

// Chart configuration
let chart = null;
const maxDataPoints = 10; // Show the 10 most recent logged records
let chartData = {
  labels: [],
  datasets: [{
    label: 'Voltage (V)',
    data: [],
    borderColor: '#667eea',
    backgroundColor: 'rgba(102, 126, 234, 0.1)',
    tension: 0.4,
    fill: true,
    pointRadius: 4,
    pointBackgroundColor: '#667eea',
    pointBorderColor: '#fff',
    pointBorderWidth: 2,
  }]
};

// Initialize chart
function initChart() {
  const ctx = document.getElementById('voltageChart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: {
            color: '#666',
            font: { size: 14 }
          }
        },
        tooltip: {
          callbacks: {
            title: (tooltipItems) => {
              const loggedAt = tooltipItems[0]?.raw?.loggedAt;
              return `Logged: ${formatLoggedDate(loggedAt)}`;
            },
            label: (context) => {
              const record = context.raw || {};
              return [
                `Voltage: ${toNumber(record.voltage).toFixed(2)} V`,
                `Current: ${toNumber(record.current).toFixed(2)} mA`,
                `Logged date: ${formatLoggedDate(record.loggedAt)}`,
              ];
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: false,
          min: 0,
          max: 20,
          ticks: {
            color: '#999',
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.05)'
          }
        },
        x: {
          ticks: {
            color: '#999',
            maxTicksLimit: maxDataPoints
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.05)'
          }
        }
      }
    }
  });
}

// Fetch data from Google Apps Script
async function fetchData() {
  try {
    const cacheBustedUrl = `${DATA_FILE_URL}?t=${Date.now()}`;
    const response = await fetch(cacheBustedUrl, { cache: 'reload', headers: { 'Cache-Control': 'no-cache' } });
    console.log('[local json] Request completed.', { ok: response.ok, status: response.status });
    const payload = await response.json();
    const data = Array.isArray(payload.records) ? payload.records : [];

    if (data.length > 0) {
      console.log(`[local json] Successfully loaded ${data.length} record(s).`);
      // Get the latest data
      const latestData = data[data.length - 1];

      // Update display values
      document.getElementById('voltageValue').textContent = toNumber(latestData.voltage).toFixed(2);
      document.getElementById('currentValue').textContent = toNumber(latestData.current).toFixed(2);
      document.getElementById('powerValue').textContent = toNumber(latestData.power).toFixed(2);

      // Update last update time
      const lastUpdatedAt = payload.updatedAt ? new Date(payload.updatedAt) : new Date();
      document.getElementById('lastUpdate').textContent = lastUpdatedAt.toLocaleTimeString();

      // Update chart with last N data points
      updateChart(data);

      // Update connection status
      updateStatus(true);
    } else {
      console.warn('[local json] Fetch succeeded but returned no records.');
      updateStatus(false);
    }
  } catch (error) {
    console.error('Error fetching data:', error);
    updateStatus(false);
  }
}

function toNumber(value) {
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
}

function formatLoggedDate(timestamp) {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? String(timestamp || '') : parsed.toLocaleString();
}

function formatTimestamp(timestamp) {
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? String(timestamp || '') : parsed.toLocaleTimeString();
}

// Update chart with new data
function updateChart(data) {
  // Keep only last maxDataPoints
  const recentData = data.slice(-maxDataPoints);

  chartData.labels = recentData.map(item => formatTimestamp(item.timestamp));

  chartData.datasets[0].data = recentData.map(item => ({
    x: formatTimestamp(item.timestamp),
    y: toNumber(item.voltage),
    voltage: item.voltage,
    current: item.current,
    loggedAt: item.timestamp,
  }));

  const voltageValues = recentData.map(item => toNumber(item.voltage));

  // Update max Y axis based on data
  const maxVoltage = Math.max(...voltageValues);
  const minVoltage = Math.min(...voltageValues);

  chart.options.scales.y.min = Math.max(0, minVoltage - 1);
  chart.options.scales.y.max = Math.ceil(maxVoltage + 1);

  chart.update('none'); // Update without animation for smooth real-time updates
}

// Update connection status
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

  console.log(`[fetch status] ${connectionStatus}`);
}

function clearInMemoryState() {
  chartData.labels = [];
  chartData.datasets[0].data = [];
  if (chart) {
    chart.update('none');
  }
}

function clearBrowserCacheHint() {
  try {
    sessionStorage.removeItem(DATA_CACHE_KEY);
  } catch (error) {
    console.warn('Unable to clear browser memory hint:', error);
  }
}

window.addEventListener('beforeunload', () => {
  clearInMemoryState();
  clearBrowserCacheHint();
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  clearBrowserCacheHint();
  initChart();
  fetchData();

  // Refresh UI every minute from backend-updated JSON
  setInterval(fetchData, 60 * 1000);
});
