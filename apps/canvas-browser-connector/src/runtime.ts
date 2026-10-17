import type { BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { CanvasBrowserConnectorConfig } from './config.js';
import {
  canonicalItemLinks,
  CollectionError,
  normalizeCourses,
  normalizeItems,
} from './extract.js';
import type { Course, Item } from './hub.js';
import { ensureDedicatedProfile } from './profile.js';

const origin = 'https://canvas.colorado.edu';
const maxCourses = 100;
const maxItemsPerCourse = 2000;

export type Discovery = { status: 'complete' | 'partial'; courses: Course[] };
export type CourseObservation = {
  status: 'complete' | 'partial' | 'inaccessible';
  items: Item[];
};

export type BrowserCollector = {
  discover: () => Promise<Discovery>;
  collectCourse: (course: {
    providerId: string;
    canonicalUrl: string;
  }) => Promise<CourseObservation>;
  close: () => Promise<void>;
};

async function requireCanvasPage(page: Page, expectedPath?: string) {
  const current = new URL(page.url());
  if (current.origin !== origin) throw new CollectionError('sign-in-required');
  if (/^\/(?:login|logout)(?:\/|$)/.test(current.pathname))
    throw new CollectionError('sign-in-required');
  if (current.search || current.hash)
    throw new CollectionError('traversal-failed');
  if (expectedPath && current.pathname !== expectedPath)
    throw new CollectionError('canvas-unavailable');
}

async function settle(page: Page) {
  // Canvas assignment lists hydrate after DOMContentLoaded. Require the scoped
  // content area, scroll through lazy content, and require a long quiet period
  // plus network idle; never inspect or retain full page text.
  await page.locator('#content').waitFor({ state: 'attached', timeout: 15000 });
  let previous = -1;
  let stable = 0;
  const links = page.locator('#content a.ig-title');
  for (let pass = 0; pass < 60; pass++) {
    const count = await links.count();
    const loading = await page
      .locator(
        '#content [aria-busy="true"], #content .loading, #content .spinner',
      )
      .count();
    if (count > 0)
      await links
        .last()
        .scrollIntoViewIfNeeded()
        .catch(() => undefined);
    if (count === previous && loading === 0) stable++;
    else stable = 0;
    if (stable >= 20) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
        return;
      } catch {
        throw new CollectionError('traversal-failed');
      }
    }
    previous = count;
    await page.waitForTimeout(500);
  }
  throw new CollectionError('traversal-failed');
}

async function settleCourseList(page: Page) {
  let previous = -1;
  let stable = 0;
  const links = page.locator('#content a[href*="/courses/"]');
  for (let pass = 0; pass < 60; pass++) {
    const count = await links.count();
    const loading = await page
      .locator(
        '#content [aria-busy="true"], #content .loading, #content .spinner',
      )
      .count();
    if (count > 0)
      await links
        .last()
        .scrollIntoViewIfNeeded()
        .catch(() => undefined);
    if (count === previous && loading === 0) stable++;
    else stable = 0;
    if (stable >= 20) {
      try {
        await page.waitForLoadState('networkidle', { timeout: 5000 });
        return;
      } catch {
        throw new CollectionError('traversal-failed');
      }
    }
    previous = count;
    await page.waitForTimeout(500);
  }
  throw new CollectionError('traversal-failed');
}

async function uncertainTraversal(page: Page) {
  const next = await page
    .locator(
      '#content a[rel="next"], #content .pagination .next:not(.disabled) a, #content [aria-expanded="false"]',
    )
    .count();
  if (next > 0) return true;
  const activeSearch = await page
    .locator(
      '#content input[type="search"], #content input[name*="search" i], #content input[id*="search" i]',
    )
    .evaluateAll((inputs) =>
      inputs.some(
        (input) => (input as HTMLInputElement).value.trim().length > 0,
      ),
    );
  if (activeSearch) return true;
  const activeFilter = await page
    .locator(
      '#content select[id*="filter" i], #content select[name*="filter" i], #content input[type="checkbox"][id*="filter" i], #content input[type="checkbox"][name*="filter" i], #content [aria-pressed="true"][id*="filter" i], #content [aria-pressed="true"][aria-label*="filter" i]',
    )
    .evaluateAll((controls) =>
      controls.some((control) => {
        if (control instanceof HTMLSelectElement) {
          const value = control.value.trim().toLowerCase();
          return value !== '' && value !== 'all' && value !== 'all_assignments';
        }
        if (control instanceof HTMLInputElement) return control.checked;
        return control.getAttribute('aria-pressed') === 'true';
      }),
    );
  return activeFilter;
}

export async function openBrowserCollector(
  config: CanvasBrowserConnectorConfig,
): Promise<BrowserCollector> {
  try {
    await ensureDedicatedProfile(config.profilePath);
  } catch {
    throw new CollectionError('browser-unavailable');
  }
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.profilePath, {
      channel: config.browserChannel,
      headless: false,
    });
  } catch {
    throw new CollectionError('browser-unavailable');
  }
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    discover: async () => {
      let response;
      try {
        response = await page.goto(`${origin}/courses`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch {
        throw new CollectionError('canvas-unavailable');
      }
      await requireCanvasPage(page, '/courses');
      if (response?.status() === 401)
        throw new CollectionError('sign-in-required');
      if (response && response.status() >= 400)
        throw new CollectionError('canvas-unavailable');
      await page
        .locator('#content')
        .waitFor({ state: 'attached', timeout: 15000 });
      await settleCourseList(page);
      const rows = await page
        .locator('#content a[href*="/courses/"]')
        .evaluateAll((anchors) =>
          anchors.map((anchor) => ({
            href: (anchor as HTMLAnchorElement).href,
            title: (anchor.textContent ?? '').trim(),
          })),
        );
      const courses = normalizeCourses(rows);
      if (courses.length > maxCourses)
        throw new CollectionError('traversal-limit');
      return {
        status:
          courses.length === 0 || (await uncertainTraversal(page))
            ? 'partial'
            : 'complete',
        courses,
      };
    },
    collectCourse: async (course) => {
      const expectedPath = `/courses/${course.providerId}/assignments`;
      let response;
      try {
        response = await page.goto(`${origin}${expectedPath}`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
      } catch {
        return { status: 'partial', items: [] };
      }
      try {
        await requireCanvasPage(page, expectedPath);
      } catch (error) {
        if (
          error instanceof CollectionError &&
          error.code === 'canvas-unavailable'
        )
          return { status: 'inaccessible', items: [] };
        throw error;
      }
      if (response?.status() === 401)
        throw new CollectionError('sign-in-required');
      if (response && [403, 404].includes(response.status()))
        return { status: 'inaccessible', items: [] };
      if (response && response.status() >= 400)
        return { status: 'partial', items: [] };
      await settle(page);
      const rows = await page
        .locator('#content li.assignment')
        .evaluateAll((nodes) =>
          nodes.flatMap((node) => {
            const anchor = node.querySelector<HTMLAnchorElement>('a.ig-title');
            if (!anchor) return [];
            const due = node.querySelector<HTMLElement>('.assignment-date-due');
            const date = due?.querySelector<HTMLElement>('[datetime]');
            return [
              {
                href: anchor.href,
                title: (anchor.textContent ?? '').trim(),
                dueAt: date?.getAttribute('datetime') ?? null,
                hasDueLabel: Boolean(due),
              },
            ];
          }),
        );
      const scopedLinks = canonicalItemLinks(
        course.providerId,
        await page
          .locator('#content a.ig-title')
          .evaluateAll((anchors) =>
            anchors.map((anchor) => (anchor as HTMLAnchorElement).href),
          ),
      );
      if (rows.length > maxItemsPerCourse)
        throw new CollectionError('traversal-limit');
      const items = normalizeItems(course.providerId, rows);
      const parsedLinks = items.map((item) => item.canonicalUrl).sort();
      const layoutComplete =
        scopedLinks.length === parsedLinks.length &&
        scopedLinks.every((href, index) => href === parsedLinks[index]);
      return {
        status:
          items.length === 0 ||
          !layoutComplete ||
          (await uncertainTraversal(page))
            ? 'partial'
            : 'complete',
        items,
      };
    },
    close: () => context.close(),
  };
}
