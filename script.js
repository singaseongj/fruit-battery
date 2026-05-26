// Replace with your Google Apps Script deployment URL
const GOOGLE_SCRIPT_URL = 'https://script.googleapis.com/macros/s/YOUR_DEPLOYMENT_URL_HERE/usercopy';

// Chart configuration
let chart = null;
const maxDataPoints = 60; // Show last 60 seconds of data
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
            maxTicksLimit: 6
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
    const response = await fetch(GOOGLE_SCRIPT_URL);
    const data = await response.json();

    if (data && data.length > 0) {
      // Get the latest data
      const latestData = data[data.length - 1];

      // Update display values
      document.getElementById('voltageValue').textContent = latestData.voltage.toFixed(2);
      document.getElementById('currentValue').textContent = latestData.current.toFixed(2);
      document.getElementById('powerValue').textContent = latestData.power.toFixed(2);

      // Update last update time
      document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString();

      // Update chart with last N data points
      updateChart(data);

      // Update connection status
      updateStatus(true);
    }
  } catch (error) {
    console.error('Error fetching data:', error);
    updateStatus(false);
  }
}

// Update chart with new data
function updateChart(data) {
  // Keep only last maxDataPoints
  const recentData = data.slice(-maxDataPoints);

  chartData.labels = recentData.map((item, index) => {
    return index % 10 === 0 ? new Date(item.timestamp).toLocaleTimeString() : '';
  });

  chartData.datasets[0].data = recentData.map(item => item.voltage);

  // Update max Y axis based on data
  const maxVoltage = Math.max(...recentData.map(item => item.voltage));
  const minVoltage = Math.min(...recentData.map(item => item.voltage));
  
  chart.options.scales.y.min = Math.max(0, minVoltage - 1);
  chart.options.scales.y.max = Math.ceil(maxVoltage + 1);

  chart.update('none'); // Update without animation for smooth real-time updates
}

// Update connection status
function updateStatus(connected) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');

  if (connected) {
    statusDot.classList.add('connected');
    statusText.textContent = 'Connected';
    statusText.style.color = '#2ed573';
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = 'Disconnected';
    statusText.style.color = '#ff4757';
  }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  fetchData();
  
  // Fetch new data every second
  setInterval(fetchData, 1000);
});
