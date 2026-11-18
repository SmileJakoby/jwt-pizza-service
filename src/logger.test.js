const { EventEmitter } = require('node:events');
const logger = require('./logger.js');

describe('structured logs', () => {
  beforeEach(() => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 204 });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('HTTP logs include the requested fields and redact credentials', () => {
    const req = {
      method: 'POST',
      path: '/api/test',
      headers: { authorization: 'Bearer request-secret' },
      body: { password: 'plain-password', name: 'Test' },
      ip: '127.0.0.1',
    };
    const res = new EventEmitter();
    res.statusCode = 201;
    res.send = function () {
      return this;
    };

    logger.httpLogger(req, res, () => {
      req.user = { id: 8, name: 'Test User', email: 'test@example.com' };
      res.send(JSON.stringify({ token: 'response-secret' }));
    });
    res.emit('finish');

    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    const entry = JSON.parse(payload.streams[0].values[0][1]);
    expect(entry).toMatchObject({
      level: 'information',
      Type: 'http',
      method: 'POST',
      status: 201,
      path: '/api/test',
      req: { password: '[REDACTED]', name: 'Test' },
      res: { token: '[REDACTED]' },
      ip: '127.0.0.1',
      hasAuthorizationHeader: true,
      user: { id: 8 },
    });
    expect(JSON.stringify(entry)).not.toContain('request-secret');
    expect(JSON.stringify(entry)).not.toContain('plain-password');
    expect(JSON.stringify(entry)).not.toContain('response-secret');
  });

  test('database logs include statement type, outcome, and sanitized SQL', () => {
    logger.logDatabase("UPDATE user SET password='stored-hash' WHERE id=?", 'error');

    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    const entry = JSON.parse(payload.streams[0].values[0][1]);
    expect(entry).toMatchObject({
      level: 'error',
      Type: 'db',
      method: 'UPDATE',
      status: 'error',
      query: 'UPDATE user SET password=[REDACTED] WHERE id=?',
    });
    expect(JSON.stringify(entry)).not.toContain('stored-hash');
  });

  test('HTTP status codes map to warning and error levels', () => {
    expect(logger.getHttpLevel(404)).toBe('warning');
    expect(logger.getHttpLevel(500)).toBe('error');
  });

  test('handled client errors are not logged as critical exceptions', () => {
    const error = new Error('not found');
    error.statusCode = 404;
    logger.logException(error, { method: 'GET', path: '/api/missing' });

    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    const entry = JSON.parse(payload.streams[0].values[0][1]);
    expect(entry.level).toBe('warning');
  });

  test('factory logs and standalone PII values are sanitized', () => {
    logger.logFactory(
      { diner: { id: 8, name: 'Test User', email: 'test@example.com' } },
      JSON.stringify({ jwt: 'eyJhbGci.payload.signature', reportUrl: 'https://example.com/report' }),
      200
    );

    const payload = JSON.parse(global.fetch.mock.calls[0][1].body);
    const entry = JSON.parse(payload.streams[0].values[0][1]);
    expect(JSON.stringify(entry)).not.toContain('test@example.com');
    expect(JSON.stringify(entry)).not.toContain('eyJhbGci.payload.signature');
  });
});
