const app = require('./service.js');
const { startMetricsReporting } = require('./metrics.js');
const logger = require('./logger.js');

const port = process.argv[2] || 3000;
app.listen(port, () => {
  startMetricsReporting();
  console.log(`Server started on port ${port}`);
});

process.on('uncaughtException', (error) => {
  logger.logException(error);
  console.error('Uncaught exception:', logger.sanitizeText(error.message || String(error)));
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.logException(error);
  console.error('Unhandled rejection:', logger.sanitizeText(error.message));
  process.exitCode = 1;
});
