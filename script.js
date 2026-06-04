const DATA_FILE_URL = './data.json';
const DATA_CACHE_KEY = 'voltage-monitor-cache';
const SEOUL_UTC_OFFSET_HOURS = 9;
const DATA_FRESHNESS_THRESHOLD_MS = 5 * 60 * 60 * 1000;

// Chart configuration
let chart = null;
const maxDataPoints = 10; // Show 10 logged records in the chart
const chartPointIntervalMinutes = 5;
const recordsPerChartPoint = chartPointIntervalMinutes;
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
    const noNewerData = isNoNewerDataPayload(payload);

    if (data.length > 0) {
      console.log(`[local json] Successfully loaded ${data.length} record(s).`);
      // Get the latest data
      const latestData = data[data.length - 1];

      // Update display values
      document.getElementById('voltageValue').textContent = toNumber(latestData.voltage).toFixed(2);
      document.getElementById('currentValue').textContent = toNumber(latestData.current).toFixed(2);
      document.getElementById('powerValue').textContent = toNumber(latestData.power).toFixed(2);

      // If the backend updater ran but found no newer records, show that run time.
      // Otherwise, show the latest logged data record time.
      document.getElementById('lastUpdate').textContent = noNewerData
        ? formatLoggedDate(payload.updatedAt)
        : formatLoggedDate(latestData.timestamp);

      // Update chart with last N data points
      updateChart(data);

      // A successful updater run with no newer records means the device is disconnected.
      // Otherwise, fall back to freshness based on the latest logged data.
      updateStatus(noNewerData ? false : isLatestDataFresh(latestData));
    } else {
      console.warn('[local json] Fetch succeeded but returned no records.');
      if (payload.updatedAt) {
        document.getElementById('lastUpdate').textContent = formatLoggedDate(payload.updatedAt);
      }
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

function parseSeoulTimestamp(timestamp) {
  if (!timestamp) return null;

  if (timestamp instanceof Date) {
    return Number.isNaN(timestamp.getTime()) ? null : timestamp;
  }

  const timestampText = String(timestamp).trim();
  const koreanDateMatch = timestampText.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(오전|오후)\s*(\d{1,2}):(\d{2}):(\d{2})$/);

  if (koreanDateMatch) {
    const [, year, month, day, meridiem, hourText, minuteText, secondText] = koreanDateMatch;
    let hour = Number(hourText);

    if (meridiem === '오전' && hour === 12) hour = 0;
    if (meridiem === '오후' && hour < 12) hour += 12;

    const utcTime = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      hour - SEOUL_UTC_OFFSET_HOURS,
      Number(minuteText),
      Number(secondText)
    );

    return new Date(utcTime);
  }

  const parsed = new Date(timestampText);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isNoNewerDataPayload(payload) {
  return payload?.connected === false || payload?.hasNewData === false || payload?.disconnectedReason === 'no-newer-data';
}

function isLatestDataFresh(latestData) {
  const loggedAt = parseSeoulTimestamp(latestData?.timestamp);

  if (!loggedAt) {
    console.warn('[local json] Latest record has an invalid timestamp.', latestData);
    return false;
  }

  const ageMs = Date.now() - loggedAt.getTime();
  const connected = ageMs >= 0 && ageMs <= DATA_FRESHNESS_THRESHOLD_MS;
  console.log(`[freshness] Latest Seoul record age: ${(ageMs / (60 * 60 * 1000)).toFixed(2)} hour(s).`);
  return connected;
}

function formatLoggedDate(timestamp) {
  const parsed = parseSeoulTimestamp(timestamp);
  return parsed ? parsed.toLocaleString() : String(timestamp || '');
}

function formatTimestamp(timestamp) {
  const parsed = parseSeoulTimestamp(timestamp);
  return parsed ? parsed.toLocaleTimeString() : String(timestamp || '');
}

function selectChartDataPoints(data) {
  const selectedData = [];

  for (let index = data.length - 1; index >= 0 && selectedData.length < maxDataPoints; index -= recordsPerChartPoint) {
    selectedData.unshift(data[index]);
  }

  return selectedData;
}

// Update chart with new data
function updateChart(data) {
  // Keep maxDataPoints chart dots, spaced 5 minutes apart from the latest logged record.
  const recentData = selectChartDataPoints(data);

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
