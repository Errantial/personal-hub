import { readConfig } from './config.js';
import { CollectionError } from './extract.js';
import { hubClient } from './hub.js';
import { openBrowserCollector } from './runtime.js';
import { syncWithBrowserFactory } from './sync.js';

async function runSync() {
  const config = await readConfig();
  const result = await syncWithBrowserFactory(hubClient(config), () =>
    openBrowserCollector(config),
  );
  console.log(
    `Canvas browser collection ${result.outcome}: ${result.complete}/${result.courses} selected courses complete.`,
  );
}

if (process.argv[2] !== 'sync') {
  console.error(
    'Usage: npm run sync --workspace @hub/canvas-browser-connector',
  );
  process.exit(2);
}

runSync().catch((error: unknown) => {
  // Never print provider/browser exception text: it may contain private URLs or
  // account/session details. Only our bounded category is safe.
  console.error(
    `Canvas browser collection failed: ${
      error instanceof CollectionError ? error.code : 'collector-error'
    }.`,
  );
  process.exit(1);
});
