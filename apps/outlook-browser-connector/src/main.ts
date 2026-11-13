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
    `Outlook browser collection ${result.outcome}: ${result.complete}/${result.folders} selected folders complete.`,
  );
}

if (process.argv[2] !== 'sync') {
  console.error(
    'Usage: npm run sync --workspace @hub/outlook-browser-connector',
  );
  process.exit(2);
}

runSync().catch((error: unknown) => {
  // Never print provider/browser exception text: it may contain private subjects,
  // addresses, URLs or account/session details. Only our bounded code is safe.
  console.error(
    `Outlook browser collection failed: ${
      error instanceof CollectionError ? error.code : 'collector-error'
    }.`,
  );
  process.exit(1);
});
