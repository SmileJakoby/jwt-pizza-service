const { EventEmitter } = require('events');
const { activeUserTracker, requestTracker, startMetricsReporting, stopMetricsReporting } = require('./metrics.js');

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
    startMetricsReporting(1000);
    await jest.advanceTimersByTimeAsync(1000);

    expect(requestNext).toHaveBeenCalledTimes(1);
    expect(activeUserNext).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    const exportedMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const requests = exportedMetrics.find((metric) => metric.name === 'http.server.request.count');
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
  });
});
