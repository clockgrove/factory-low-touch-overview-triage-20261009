import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {expectedOverview} from './oracle.js';

const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8', timeout: 5000}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');
const parameters = options => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  return query;
};

test('overview real Chromium: canonical selection, overlap failure/retry, keyboard and narrow measures', {timeout: 90000}, async t => {
  let server, browser, context, port;
  const start = async () => {
    server = await createAppServer();
    server.listen(port || 0, '127.0.0.1');
    await once(server, 'listening', {signal: AbortSignal.timeout(5000)});
    port = server.address().port;
  };
  const stop = async () => {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  };
  try {
    await start();
    browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, timeout: 15000, env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: resolve(alias, '../host-libs/usr/lib/x86_64-linux-gnu'),
      ALSA_CONFIG_PATH: resolve(alias, '../host-libs/usr/share/alsa/alsa.conf'),
      TMPDIR: '.runtime/browser-tmp', TMP: '.runtime/browser-tmp', TEMP: '.runtime/browser-tmp'
    }});
    context = await browser.newContext({locale: 'en-US', viewport: {width: 1280, height: 900}});
    const page = await context.newPage();
    page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    // Latency delays actual loopback traffic; no route interception or replacement.
    const throttle = latency => cdp.send('Network.emulateNetworkConditions', {offline: false, latency, downloadThroughput: -1, uploadThroughput: -1});
    const text = (id, value) => page.waitForFunction(({id, value}) => document.getElementById(id).textContent.includes(value), {id, value}, {timeout: 8000});
    const busy = value => page.waitForFunction(value => document.getElementById('overview').getAttribute('aria-busy') === String(value), value, {timeout: 8000});
    const search = async q => { await page.locator('#search').fill(q); await page.locator('#search').press('Enter'); };
    const listReady = () => page.waitForFunction(() => document.getElementById('results').getAttribute('aria-busy') === 'false' && document.getElementById('freshness').textContent === 'Current selections', null, {timeout: 8000});
    const check = async (options = {}) => {
      await busy(false);
      await text('overview-selection', 'Completed for these filters');
      assert.equal(await page.locator('#overview').getAttribute('data-stale'), 'false');
      assert.equal(await page.locator('#overview-message').getAttribute('class'), 'operation-message');
      const oracle = expectedOverview(options);
      const actual = await page.locator('.service-card').evaluateAll(cards => cards.map(card => ({
        service: card.querySelector('h3').textContent,
        labels: [...card.querySelectorAll('dt')].map(x => x.textContent),
        measures: [...card.querySelectorAll('dd')].map(x => x.textContent),
      })));
      assert.deepEqual(actual, oracle.services.map(entry => ({
        service: entry.service,
        labels: ['Incident count', 'Unresolved', 'Critical or high severity', 'Average resolution · hours'],
        measures: [entry.incidentCount, entry.unresolvedCount, entry.highSeverityCount].map(n => n.toLocaleString('en-US')).concat(
          entry.averageResolutionHours === null ? 'Unavailable — no resolved incidents' : entry.averageResolutionHours.toLocaleString('en-US', {maximumFractionDigits: 2})),
      })));
      if (options.q) await text('overview-selection', `q: ${options.q}`);
      return actual;
    };
    const overviewRequest = q => page.waitForRequest(request => {
      const url = new URL(request.url());
      return url.pathname === '/api/overview' && url.searchParams.get('q') === q;
    }, {timeout: 8000});

    await t.test('real loading, all canonical measures and combined multi-page selection updates', async () => {
      await throttle(500);
      await page.goto(`http://127.0.0.1:${port}`);
      await busy(true); await text('overview-message', 'Loading service overview');
      await check(); await listReady(); await throttle(0);
      const options = {q: 'incident', service: ['Billing', 'Notifications'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13'};
      assert.ok(expectedOverview(options).total > 50);
      await search(options.q);
      for (const facet of ['service', 'severity']) for (const value of options[facet]) await page.locator(`#${facet}`).getByLabel(value, {exact: true}).check();
      await page.locator('#from').fill(options.from); await page.locator('#to').fill(options.to);
      await check(options); await listReady();
      const requests = []; const observe = request => { if (new URL(request.url()).pathname === '/api/overview') requests.push(request.url()); };
      page.on('request', observe);
      try {
        await page.getByRole('button', {name: 'Next', exact: true}).click(); await listReady(); await check(options);
        assert.equal(new URL(page.url()).searchParams.get('page'), '2');
        await page.getByLabel('Rows per page').selectOption('50'); await listReady(); await check(options);
        await page.getByRole('button', {name: 'Next', exact: true}).click(); await listReady(); await check(options);
        await page.getByLabel('Sort by').selectOption('severity'); await listReady(); await check(options);
        assert.deepEqual(requests, [], 'presentation changes must preserve overview request ownership');
      } finally { page.off('request', observe); }
    });
    await t.test('unavailable averages and useful empty results are obtained from HTTP', async () => {
      await page.goto(`http://127.0.0.1:${port}/?status=open&status=in_progress`);
      await check({status: ['open', 'in_progress']}); await listReady();
      assert.ok((await page.locator('.service-card dd').allTextContents()).includes('Unavailable — no resolved incidents'));
      await search('no overview matches this phrase');
      await check({q: 'no overview matches this phrase', status: ['open', 'in_progress']});
      await text('overview-message', 'No services match these filters. Try clearing a filter');
    });
    await t.test('bounded selection replacement survives genuine connection failure and retries current filters', async () => {
      await page.goto(`http://127.0.0.1:${port}/`); await check(); await listReady();
      const snapshot = await page.locator('#service-measures').textContent();
      await throttle(1000);
      const oldStarted = overviewRequest('Billing');
      await search('Billing'); const old = await oldStarted;
      await busy(true); await text('overview-selection', 'Requested: q: Billing');
      assert.equal(await page.locator('#overview').getAttribute('data-stale'), 'true');
      assert.equal(await page.locator('#service-measures').textContent(), snapshot);
      const oldFinished = page.waitForEvent('requestfailed', {predicate: request => request === old, timeout: 8000});
      await stop();
      const replacement = overviewRequest('Search');
      await search('Search'); await replacement;
      await oldFinished;
      await page.locator('#overview-message').getByRole('button', {name: 'Retry'}).waitFor({state: 'visible', timeout: 8000});
      await busy(false); await text('overview-selection', 'Requested: q: Search');
      assert.equal(await page.locator('#service-measures').textContent(), snapshot);
      assert.match(await page.locator('#overview-message').textContent(), /Failed to fetch/);
      assert.equal(await page.locator('#overview').getAttribute('data-stale'), 'true');
      await start();
      const retryRequest = overviewRequest('Search');
      await page.locator('#overview-message').getByRole('button', {name: 'Retry'}).click();
      await retryRequest; await busy(true);
      await text('overview-message', 'Updating overview');
      await check({q: 'Search'});
      assert.equal(await page.locator('#overview-message').textContent(), '');
      // List retry has separate ownership and must preserve the completed overview.
      await page.locator('#result-message').getByRole('button', {name: 'Retry'}).click();
      await listReady(); await check({q: 'Search'}); await throttle(0);
    });
    await t.test('keyboard reaches both views, shows focus and reads every measure on a narrow screen', async () => {
      await page.setViewportSize({width: 375, height: 812});
      await page.goto(`http://127.0.0.1:${port}/`); await check(); await listReady();
      for (const [name, id] of [['Service overview', 'overview'], ['Incident list', 'incident-list'], ['Personal triage', 'triage'], ['Search and filters', 'query-form']]) {
        const link = page.getByRole('link', {name, exact: true});
        await link.focus();
        const focus = await link.evaluate(element => ({active: element === document.activeElement, style: getComputedStyle(element).outlineStyle, width: getComputedStyle(element).outlineWidth}));
        assert.equal(focus.active, true); assert.notEqual(focus.style, 'none'); assert.ok(parseFloat(focus.width) >= 2);
        await page.keyboard.press('Enter'); assert.equal(new URL(page.url()).hash, `#${id}`);
      }
      await page.locator('#search').focus(); await page.keyboard.press('Tab');
      assert.equal(await page.getByRole('button', {name: 'Search', exact: true}).evaluate(x => x === document.activeElement), true);
      const facet = page.locator('#status').getByLabel('open', {exact: true});
      await facet.focus(); await page.keyboard.press('Space');
      await check({status: ['open']}); await listReady(); assert.equal(await facet.isChecked(), true);
      const geometry = await page.locator('.service-card dt, .service-card dd').evaluateAll(nodes => nodes.map(element => {
        const box = element.getBoundingClientRect(), style = getComputedStyle(element);
        return {left: box.left, right: box.right, width: box.width, height: box.height, fits: element.scrollWidth <= element.clientWidth, visible: style.visibility !== 'hidden' && style.display !== 'none'};
      }));
      assert.equal(geometry.length, expectedOverview({status: ['open']}).services.length * 8);
      for (const box of geometry) {
        assert.ok(box.visible && box.width > 0 && box.height > 0 && box.left >= 0 && box.right <= 375 && box.fits, JSON.stringify(box));
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    });
    assert.deepEqual(errors, []);
  } finally {
    try { await context?.close(); }
    finally { try { await browser?.close(); } finally { await stop(); } }
  }
});
