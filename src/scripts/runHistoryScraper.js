import { runHistoryScraper } from '../agents/historyScraper.js';

runHistoryScraper()
  .then((result) => {
    if (result) {
      console.log(result);
    }
  })
  .catch((error) => {
    console.error('❌ History scraper failed:', error);
    process.exitCode = 1;
  });
