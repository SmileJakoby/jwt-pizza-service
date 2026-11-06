const { EventEmitter } = require('events');
const {
  activeUserTracker,
  recordAuthAttempt,
  recordPizzaCreation,
  requestTracker,
  startMetricsReporting,
  stopMetricsReporting,
} = require('./metrics.js');

describe('request metrics', () => {
  afterEach(() => {
    stopMetricsReporting();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('exports route, method, status, latency, and active user metrics', async () => {
    jest.useFakeTimers();
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200 });
    const req = {
      method: 'POST',
      baseUrl: '/api/order',
      route: { path: '/' },
      user: { id: 42 },
    };
    const res = new EventEmitter();
    res.statusCode = 201;
    const requestNext = jest.fn();
    const activeUserNext = jest.fn();

    requestTracker(req, res, requestNext);
    activeUserTracker(req, res, activeUserNext);
    res.emit('finish');
    recordAuthAttempt(true);
    recordAuthAttempt(false);
    recordPizzaCreation({ success: true, latencyMs: 42, pizzaCount: 2, revenue: 0.12 });
    recordPizzaCreation({ success: false, latencyMs: 510, pizzaCount: 1, revenue: 0.04 });
    startMetricsReporting(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(requestNext).toHaveBeenCalledTimes(1);
    expect(activeUserNext).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    const exportedMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const requests = exportedMetrics.find((metric) => metric.name === 'http.server.request.count');
    expect(requests.sum.aggregationTemporality).toBe('AGGREGATION_TEMPORALITY_CUMULATIVE');
    const requestPoint = requests.sum.dataPoints[0];
    expect(requestPoint.asInt).toBe('1');
    expect(requestPoint.attributes).toEqual(expect.arrayContaining([
      { key: 'http.request.method', value: { stringValue: 'POST' } },
      { key: 'http.route', value: { stringValue: '/api/order/' } },
      { key: 'http.response.status_code', value: { intValue: '201' } },
    ]));

    const latency = exportedMetrics.find((metric) => metric.name === 'http.server.request.duration');
    expect(latency.histogram.dataPoints[0].count).toBe('1');
    expect(exportedMetrics.find((metric) => metric.name === 'app.active_users').gauge.dataPoints[0].asInt).toBe('1');
    expect(exportedMetrics.find((metric) => metric.name === 'auth.attempts').sum.dataPoints.map((point) => point.asInt)).toEqual(['1', '1']);
    expect(exportedMetrics.find((metric) => metric.name === 'pizza.sold').sum.dataPoints[0].asInt).toBe('2');
    expect(exportedMetrics.find((metric) => metric.name === 'pizza.creation.failures').sum.dataPoints[0].asInt).toBe('1');
    expect(exportedMetrics.find((metric) => metric.name === 'pizza.revenue').sum.dataPoints[0].asDouble).toBe(0.12);
    expect(exportedMetrics.find((metric) => metric.name === 'pizza.creation.duration').histogram.dataPoints.map((point) => point.count)).toEqual(['1', '1']);
    expect(exportedMetrics.find((metric) => metric.name === 'system.cpu.utilization').gauge.dataPoints[0].asDouble).toBeGreaterThanOrEqual(0);
    expect(exportedMetrics.find((metric) => metric.name === 'system.memory.utilization').gauge.dataPoints[0].asDouble).toBeGreaterThan(0);
  });
});
