const app = require('./service.js');
const { startMetricsReporting } = require('./metrics.js');

const port = process.argv[2] || 3000;
app.listen(port, () => {
  startMetricsReporting();
  console.log(`Server started on port ${port}`);
});
