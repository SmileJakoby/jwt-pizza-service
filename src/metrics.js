const os = require('os');
const config = require('./config.js');

const activeUserWindowMs = 5 * 60 * 1000;
const latencyBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const cumulativeTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
const processStartTimeUnixNano = (BigInt(Date.now()) * 1000000n).toString();
const requestCounts = new Map();
const requestDurations = new Map();
const activeUsers = new Map();
const trackedMethods = new Set(['GET', 'POST', 'PUT', 'DELETE']);
const authAttemptCounts = { success: 0, failure: 0 };
const pizzaCreationDurations = {
  success: { count: 0, sum: 0, bucketCounts: Array(latencyBuckets.length + 1).fill(0) },
  failure: { count: 0, sum: 0, bucketCounts: Array(latencyBuckets.length + 1).fill(0) },
};
let pizzasSold = 0;
let pizzaCreationFailures = 0;
let revenue = 0;
let reportingTimer;
let reportingInProgress = false;
let previousCpuTimes = getCpuTimes();

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

function recordAuthAttempt(success) {
  authAttemptCounts[success ? 'success' : 'failure']++;
}

function recordPizzaCreation({ success, latencyMs, pizzaCount = 0, revenue: orderRevenue = 0 }) {
  const outcome = success ? 'success' : 'failure';
  recordDuration(outcome, latencyMs, pizzaCreationDurations);

  if (success) {
    pizzasSold += pizzaCount;
    revenue += orderRevenue;
  } else {
    pizzaCreationFailures++;
  }
}

function getEndpoint(req) {
  const routePath = req.route?.path;
  if (typeof routePath !== 'string' || routePath === '*') {
    return '<unmatched>';
  }
  return `${req.baseUrl || ''}${routePath}` || '/';
}

function recordDuration(key, durationMs, durations = requestDurations) {
  let data = durations instanceof Map ? durations.get(key) : durations[key];
  if (!data) {
    data = { count: 0, sum: 0, bucketCounts: Array(latencyBuckets.length + 1).fill(0) };
    if (durations instanceof Map) {
      durations.set(key, data);
    } else {
      durations[key] = data;
    }
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
    requestPoints.push({ asInt: String(count), startTimeUnixNano: processStartTimeUnixNano, timeUnixNano, attributes });

    const duration = requestDurations.get(key);
    durationPoints.push({
      count: String(duration.count),
      sum: duration.sum,
      explicitBounds: latencyBuckets,
      bucketCounts: duration.bucketCounts.map(String),
      startTimeUnixNano: processStartTimeUnixNano,
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
        aggregationTemporality: cumulativeTemporality,
        isMonotonic: true,
      },
    },
    {
      name: 'http.server.request.duration',
      unit: 'ms',
      histogram: {
        dataPoints: durationPoints,
        aggregationTemporality: cumulativeTemporality,
      },
    },
    {
      name: 'app.active_users',
      unit: '{user}',
      gauge: {
        dataPoints: [{ asInt: String(activeUsers.size), timeUnixNano, attributes: [] }],
      },
    },
    {
      name: 'auth.attempts',
      unit: '{attempt}',
      sum: {
        dataPoints: ['success', 'failure'].map((outcome) => ({
          asInt: String(authAttemptCounts[outcome]),
          startTimeUnixNano: processStartTimeUnixNano,
          timeUnixNano,
          attributes: [stringAttribute('auth.outcome', outcome)],
        })),
        aggregationTemporality: cumulativeTemporality,
        isMonotonic: true,
      },
    },
    {
      name: 'pizza.sold',
      unit: '{pizza}',
      sum: {
        dataPoints: [{ asInt: String(pizzasSold), startTimeUnixNano: processStartTimeUnixNano, timeUnixNano, attributes: [] }],
        aggregationTemporality: cumulativeTemporality,
        isMonotonic: true,
      },
    },
    {
      name: 'pizza.creation.failures',
      unit: '{failure}',
      sum: {
        dataPoints: [{ asInt: String(pizzaCreationFailures), startTimeUnixNano: processStartTimeUnixNano, timeUnixNano, attributes: [] }],
        aggregationTemporality: cumulativeTemporality,
        isMonotonic: true,
      },
    },
    {
      name: 'pizza.revenue',
      unit: 'USD',
      sum: {
        dataPoints: [{ asDouble: revenue, startTimeUnixNano: processStartTimeUnixNano, timeUnixNano, attributes: [] }],
        aggregationTemporality: cumulativeTemporality,
        isMonotonic: true,
      },
    },
    {
      name: 'pizza.creation.duration',
      unit: 'ms',
      histogram: {
        dataPoints: ['success', 'failure'].map((outcome) => ({
          count: String(pizzaCreationDurations[outcome].count),
          sum: pizzaCreationDurations[outcome].sum,
          explicitBounds: latencyBuckets,
          bucketCounts: pizzaCreationDurations[outcome].bucketCounts.map(String),
          startTimeUnixNano: processStartTimeUnixNano,
          timeUnixNano,
          attributes: [stringAttribute('pizza.creation.outcome', outcome)],
        })),
        aggregationTemporality: cumulativeTemporality,
      },
    },
    {
      name: 'system.cpu.utilization',
      unit: '%',
      gauge: {
        dataPoints: [{ asDouble: getCpuUsagePercentage(), timeUnixNano, attributes: [] }],
      },
    },
    {
      name: 'system.memory.utilization',
      unit: '%',
      gauge: {
        dataPoints: [{ asDouble: getMemoryUsagePercentage(), timeUnixNano, attributes: [] }],
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
    try {
      await sendMetricToGrafana(buildMetrics());
    } catch (error) {
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
  const currentCpuTimes = getCpuTimes();
  const totalDelta = currentCpuTimes.total - previousCpuTimes.total;
  const idleDelta = currentCpuTimes.idle - previousCpuTimes.idle;
  previousCpuTimes = currentCpuTimes;
  return totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  return (usedMemory / totalMemory) * 100;
}

function getCpuTimes() {
  return os.cpus().reduce(
    (totals, cpu) => ({
      idle: totals.idle + cpu.times.idle,
      total: totals.total + Object.values(cpu.times).reduce((sum, time) => sum + time, 0),
    }),
    { idle: 0, total: 0 },
  );
}

module.exports = {
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
  activeUserTracker,
  requestTracker,
  recordAuthAttempt,
  recordPizzaCreation,
  startMetricsReporting,
  stopMetricsReporting,
};
