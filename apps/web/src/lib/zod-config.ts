import { z } from 'zod';

/* Zod probes for `new Function` to compile faster parsers. Under the site's
   content security policy that probe is refused and reported as a violation
   on every load, so the compiled path is turned off before any schema runs.
   Imported first in main.tsx. */
z.config({ jitless: true });
