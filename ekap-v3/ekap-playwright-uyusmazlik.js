const { runEkapDownloader } = require('./ekap-playwright-runner');

runEkapDownloader({
  downloadType: 'uyusmazlik',
  useMahkemeTab: false,
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
