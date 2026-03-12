const { runEkapDownloader } = require('./ekap-playwright-runner');

runEkapDownloader({
  downloadType: 'mahkeme',
  useMahkemeTab: true,
}).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
