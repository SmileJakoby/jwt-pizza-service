const os = require('os');
const config = require('./config.js');

const activeUserWindowMs = 5 * 60 * 1000;
const latencyBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const requestCounts = new Map();
const requestDurations = new Map();
const activeUsers = new Map();
const trackedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);
let reportingTimer;
let reportingInProgress = false;

function requestTracker(req, res, next) {
  if (!trackedMethods.has(req.method)) {
    return next();
  }

  const startTime = process.hrtime.bigint();
  res.once('finish', () => {
    const endpoint = getEndpoint(req);
    const statusCode = res.statusCode;
    const key = JSON.stringify([req.method, endpoint, statusCode]);
    const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;

    requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
    recordDuration(key, durationMs);
  });

  next();
}

function activeUserTracker(req, res, next) {
  if (trackedMethods.has(req.method) && req.user?.id !== undefined && req.user?.id !== null) {
    activeUsers.set(String(req.user.id), Date.now());
  }
  next();
}

function getEndpoint(req) {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string' || routePath === '*') {
    return '<unmatched>';
  }
  return `${req.baseUrl || ''}${routePath}` || '/';
}

function recordDuration(key, durationMs) {
  let data = requestDurations.get(key);
  if (!data) {
    data = { count: 0, sum: 0, bucketCounts: Array(latencyBuckets.length + 1).fill(0) };
    requestDurations.set(key, data);
  }

  data.count++;
  data.sum += durationMs;
  const bucketIndex = latencyBuckets.findIndex((bound) => durationMs <= bound);
  data.bucketCounts[bucketIndex === -1 ? latencyBuckets.length : bucketIndex]++;
}

function buildMetrics() {
  const timeUnixNano = (BigInt(Date.now()) * 1000000n).toString();
  const requestPoints = [];
  const durationPoints = [];

  for (const [key, count] of requestCounts) {
    const [method, endpoint, statusCode] = JSON.parse(key);
    const attributes = [
      stringAttribute('http.request.method', method),
      stringAttribute('http.route', endpoint),
      intAttribute('http.response.status_code', statusCode),
    ];
    requestPoints.push({ asInt: String(count), timeUnixNano, attributes });

    const duration = requestDurations.get(key);
    durationPoints.push({
      count: String(duration.count),
      sum: duration.sum,
      explicitBounds: latencyBuckets,
      bucketCounts: duration.bucketCounts.map(String),
      timeUnixNano,
      attributes,
    });
  }

  const now = Date.now();
  for (const [userId, lastSeen] of activeUsers) {
    if (now - lastSeen > activeUserWindowMs) {
      activeUsers.delete(userId);
    }
  }

  return [
    {
      name: 'http.server.request.count',
      unit: '{request}',
      sum: {
        dataPoints: requestPoints,
        aggregationTemporality: 1,
        isMonotonic: true,
      },
    },
    {
      name: 'http.server.request.duration',
      unit: 'ms',
      histogram: {
        dataPoints: durationPoints,
        aggregationTemporality: 1,
      },
    },
    {
      name: 'app.active_users',
      unit: '{user}',
      gauge: {
        dataPoints: [{ asInt: String(activeUsers.size), timeUnixNano, attributes: [] }],
      },
    },
  ];
}

async function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        resource: {
          attributes: [stringAttribute('service.name', config.metrics.source)],
        },
        scopeMetrics: [{ metrics }],
      },
    ],
  };
  const response = await fetch(config.metrics.endpointUrl, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Grafana metrics endpoint returned HTTP ${response.status}`);
  }
}

function startMetricsReporting(period = 10000) {
  if (reportingTimer) {
    return reportingTimer;
  }

  reportingTimer = setInterval(async () => {
    if (reportingInProgress) {
      return;
    }

    reportingInProgress = true;
    let counts;
    let durations;
    let metricsCleared = false;
    try {
      const metrics = buildMetrics();
      counts = new Map(requestCounts);
      durations = new Map(requestDurations);
      requestCounts.clear();
      requestDurations.clear();
      metricsCleared = true;
      await sendMetricToGrafana(metrics);
    } catch (error) {
      if (metricsCleared) {
        for (const [key, count] of counts) {
          requestCounts.set(key, (requestCounts.get(key) || 0) + count);
        }
        for (const [key, duration] of durations) {
          const current = requestDurations.get(key);
          if (current) {
            current.count += duration.count;
            current.sum += duration.sum;
            current.bucketCounts = current.bucketCounts.map((count, index) => count + duration.bucketCounts[index]);
          } else {
            requestDurations.set(key, duration);
          }
        }
      }
      console.error('Error sending metrics to Grafana:', error);
    } finally {
      reportingInProgress = false;
    }
  }, period);

  return reportingTimer;
}

function stopMetricsReporting() {
  if (reportingTimer) {
    clearInterval(reportingTimer);
    reportingTimer = undefined;
  }
  reportingInProgress = false;
}

function stringAttribute(key, value) {
  return { key, value: { stringValue: String(value) } };
}

function intAttribute(key, value) {
  return { key, value: { intValue: String(value) } };
}

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return cpuUsage.toFixed(2) * 100;
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return memoryUsage.toFixed(2);
}

module.exports = {
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
  activeUserTracker,
  requestTracker,
  startMetricsReporting,
  stopMetricsReporting,
};
