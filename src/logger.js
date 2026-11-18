const { AsyncLocalStorage } = require('node:async_hooks');
const config = require('./config.js');

const sensitiveKey = /(password|passwd|token|jwt|authorization|api.?key|secret|credential)/i;
const sensitiveText = /\b((?:password|passwd|token|jwt|authorization|api[_-]?key|secret|credential)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const bearerToken = /\bBearer\s+[^\s"'`,]+/gi;

class Logger {
  constructor() {
    this.requestContext = new AsyncLocalStorage();
    this.httpLogger = this.httpLogger.bind(this);
  }

  httpLogger(req, res, next) {
    this.requestContext.run({ req }, () => {
      let responseBody;
      const send = res.send;
      res.send = function (body) {
        responseBody = body;
        return send.call(this, body);
      };

      res.once('finish', () => {
        this.log('http', {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          hasAuthorizationHeader: req.headers.authorization !== undefined,
          user: this.getCurrentUser(req),
          requestBody: req.body,
          responseBody,
        });
      });

      next();
    });
  }

  logDatabase(sql) {
    this.log('database', {
      query: this.sanitizeSql(sql),
      user: this.getCurrentUser(),
    });
  }

  logFactory(requestBody, responseBody, statusCode, error) {
    this.log('factory', {
      user: this.getCurrentUser(),
      requestBody,
      responseBody,
      statusCode,
      error: error ? this.sanitizeText(error.message || String(error)) : undefined,
    });
  }

  logException(error, req) {
    this.log('exception', {
      name: error.name,
      message: this.sanitizeText(error.message || String(error)),
      stack: error.stack ? this.sanitizeText(error.stack) : undefined,
      method: req?.method,
      path: req?.path,
      user: this.getCurrentUser(),
    });
  }

  log(event, data) {
    const body = JSON.stringify(this.sanitizeValue(data));
    const payload = {
      streams: [
        {
          stream: { source: config.logging.source, event },
          values: [[`${BigInt(Date.now()) * 1000000n}`, body]],
        },
      ],
    };

    this.sendToGrafana(payload);
  }

  async sendToGrafana(payload) {
    try {
      const response = await fetch(config.logging.endpointUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.logging.accountId}:${config.logging.apiKey}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(`Grafana logging endpoint returned HTTP ${response.status}`);
      }
    } catch (error) {
      console.error('Error sending logs to Grafana:', this.sanitizeText(error.message || String(error)));
    }
  }

  getCurrentUser(req) {
    const user = req ? req.user : this.requestContext.getStore()?.req.user;
    if (!user) {
      return undefined;
    }
    return { id: user.id, name: user.name, email: user.email };
  }

  sanitizeSql(sql) {
    return this.sanitizeText(sql).replace(/'(?:''|[^'])*'|"(?:\\.|[^"])*"/g, '[REDACTED]');
  }

  sanitizeText(value) {
    return String(value)
      .replace(bearerToken, 'Bearer [REDACTED]')
      .replace(sensitiveText, '$1[REDACTED]');
  }

  sanitizeValue(value, key) {
    if (key && key.toLowerCase() !== 'hasauthorizationheader' && sensitiveKey.test(key)) {
      return '[REDACTED]';
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try {
          return this.sanitizeValue(JSON.parse(value));
        } catch {
          return this.sanitizeText(value);
        }
      }
      return this.sanitizeText(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entryValue]) => [entryKey, this.sanitizeValue(entryValue, entryKey)])
      );
    }
    return value;
  }
}

module.exports = new Logger();
