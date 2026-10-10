import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {rows, expected, expectedOverview} from './oracle.js';
import {TRIAGE_STORAGE_KEY, addIncident, editNote} from '../../public/triage.js';
import {createState, transition, canAddDetail} from '../../public/state.js';

const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8', timeout: 5000}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');
const viewsKey = 'incident-explorer.views.v1';
const human = value => value.replaceAll('_', ' ');
const utc = value => value ? value.replace('T', ' ').replace('.000Z', ' UTC') : 'Not resolved';
const recognition = (row, note = '') => Object.fromEntries(['id', 'title', 'service', 'severity', 'status', 'openedAt', 'note'].map(key => [key, key === 'note' ? note : row[key]]));

// Production transitions complement HTTP journeys with deterministic late writers.
test('triage metadata survives detail replacement, current failure, retry and late cleanup', () => {
  for (const change of [{type: 'detail:close'}, {type: 'detail:select', id: rows[1].id}, {type: 'intent', patch: {q: 'Billing'}}, {type: 'address', intent: {q: 'Uploads'}}]) {
    let state = createState();
    state = transition(state, {type: 'detail:select', id: rows[0].id});
    state = transition(state, {type: 'detail:start'});
    const old = state.detail.token;
    state = transition(state, {type: 'detail:success', token: old, data: rows[0]});
    assert.equal(canAddDetail(state), true);
    const entries = editNote(addIncident([], state.detail.data), rows[0].id, '<b>literal & retained</b>');
    state = transition(state, change);
    state = transition(state, {type: 'detail:select', id: rows[1].id});
    state = transition(state, {type: 'detail:start'});
    const failed = state.detail.token;
    state = transition(state, {type: 'detail:failure', token: failed, error: 'current connection failure'});
    for (const type of ['detail:success', 'detail:failure', 'detail:finish']) assert.equal(transition(state, {type, token: old, data: rows[0], error: 'late'}), state);
    assert.equal(canAddDetail(state), false);
    assert.equal(state.detail.error, 'current connection failure');
    state = transition(state, {type: 'detail:start'});
    for (const token of [old, failed]) for (const type of ['detail:success', 'detail:failure', 'detail:finish']) assert.equal(transition(state, {type, token, data: rows[0], error: 'late'}), state);
    assert.equal(state.detail.pending, true);
    state = transition(state, {type: 'detail:success', token: state.detail.token, data: rows[1]});
    assert.equal(canAddDetail(state), true);
    assert.deepEqual(entries, [recognition(rows[0], '<b>literal & retained</b>')]);
  }
});

test('finite real Chromium triage: persistence, recovery, keyboard, phone and real detail failure', {timeout: 90000}, async t => {
  const before = await readFile('.runtime/incidents.json');
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
    const ready = () => page.waitForFunction(() => document.querySelector('#freshness').textContent === 'Current selections' && document.querySelector('#overview-selection').textContent.includes('Completed for these filters'), null, {timeout: 8000});
    const focused = locator => locator.evaluate(element => element === document.activeElement);
    const ids = () => page.locator('#triage-list > li').evaluateAll(nodes => nodes.map(node => node.dataset.triageId));
    const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), TRIAGE_STORAGE_KEY);
    const note = id => page.getByRole('textbox', {name: `Note for ${id}`, exact: true});
    const open = id => page.getByRole('button', {name: `Open details for ${id}`, exact: true});
    const remove = id => page.getByRole('button', {name: `Remove ${id} from triage`, exact: true});
    const add = id => page.getByRole('button', {name: `Add ${id} to triage`, exact: true});
    const detail = async row => {
      await page.waitForFunction(id => document.querySelector('#detail-content dd')?.textContent === id && document.querySelectorAll('#detail-content dd').length === 11, row.id, {timeout: 8000});
      assert.deepEqual(await page.locator('#detail-content dd').allTextContents(), Object.entries(row).map(([key, value]) => key.endsWith('At') ? utc(value) : key === 'tags' ? value.join(', ') : key === 'status' ? human(value) : String(value)));
    };
    const close = async () => { await page.keyboard.press('Escape'); assert.equal(await page.locator('#detail').isVisible(), false); };
    const search = async q => { await page.locator('#search').fill(q); await page.locator('#search').press('Enter'); await ready(); };
    const addFromResults = async row => {
      await page.locator(`#rows button[data-incident="${row.id}"]`).click(); await detail(row);
      await add(row.id).focus(); await page.keyboard.press('Enter');
      assert.equal(await add(row.id).isDisabled(), true); await close();
    };
    const selected = expected({q: 'incident'}).items;
    // Reverse the visible order to prove insertion order, rather than incidental sorting.
    const first = selected[1], second = selected[0];
    const initialNote = '  <script>window.triageInjected=true</script> & "quotes"\n雪  ';
    const editedNote = '  <img src=x onerror="window.triageInjected=true"> & **edited**\nline two  ';
    await page.goto(`http://127.0.0.1:${port}/?q=incident`); await ready();

    await t.test('ordered canonical recognition, duplicate activation, literal input and independent saved view', async () => {
      await addFromResults(first); await note(first.id).fill(initialNote);
      assert.equal(await note(first.id).inputValue(), initialNote);
      await addFromResults(second);
      assert.deepEqual(await ids(), [first.id, second.id]);
      const row = page.locator(`[data-triage-id="${first.id}"]`);
      assert.equal(await row.locator('h3').textContent(), `${first.id} · ${first.title}`);
      assert.equal(await row.locator('p').textContent(), `${first.service} · ${human(first.severity)} · ${human(first.status)} · Opened ${utc(first.openedAt)}`);
      await open(first.id).click(); await detail(first);
      assert.equal(await add(first.id).isDisabled(), true);
      await add(first.id).evaluate(button => { button.click(); button.click(); }); await close();
      assert.deepEqual(await ids(), [first.id, second.id]);
      assert.equal(await note(first.id).inputValue(), initialNote);
      await note(first.id).fill(editedNote);
      assert.equal(await note(first.id).inputValue(), editedNote);
      assert.equal(await page.locator('#triage-list script, #triage-list img').count(), 0);
      assert.equal(await page.evaluate(() => window.triageInjected), undefined);
      const address = page.url();
      await page.getByLabel('Name this view').fill('Triage investigation');
      await page.getByRole('button', {name: 'Save current view', exact: true}).click();
      const saved = await page.evaluate(key => localStorage.getItem(key), viewsKey);
      assert.deepEqual(await stored(), {version: 1, entries: [recognition(first, editedNote), recognition(second)]});
      await page.reload(); await ready();
      assert.equal(page.url(), address); assert.equal(await page.locator('#search').inputValue(), 'incident');
      assert.deepEqual(await ids(), [first.id, second.id]); assert.equal(await note(first.id).inputValue(), editedNote);
      const resultIds = await page.locator('#rows button').evaluateAll(nodes => nodes.map(node => node.dataset.incident));
      await open(first.id).focus(); await page.keyboard.press('Enter'); await detail(first); await close();
      assert.equal(await focused(open(first.id)), true);
      assert.deepEqual(await page.locator('#rows button').evaluateAll(nodes => nodes.map(node => node.dataset.incident)), resultIds);
      assert.equal(page.url(), address);
      await search('Billing');
      await page.getByRole('button', {name: 'Open saved view Triage investigation', exact: true}).click(); await ready();
      assert.equal(await page.locator('#search').inputValue(), 'incident');
      assert.equal(await page.evaluate(key => localStorage.getItem(key), viewsKey), saved);
      assert.deepEqual(await stored(), {version: 1, entries: [recognition(first, editedNote), recognition(second)]});
    });

    await t.test('real connection failure, close/reselection and current retry preserve notes and results', async () => {
      const snapshot = await page.locator('#rows').textContent();
      await stop(); await open(first.id).click();
      await page.locator('#detail-content').getByRole('button', {name: 'Retry', exact: true}).waitFor();
      assert.equal(await add(first.id).count(), 0); await close();
      await open(second.id).click();
      await page.locator('#detail-content').getByRole('button', {name: 'Retry', exact: true}).waitFor();
      await start(); await page.locator('#detail-content').getByRole('button', {name: 'Retry', exact: true}).click();
      await detail(second); assert.equal(await add(second.id).isDisabled(), true); await close();
      assert.equal(await page.locator('#rows').textContent(), snapshot);
      assert.deepEqual(await stored(), {version: 1, entries: [recognition(first, editedNote), recognition(second)]});
    });

    await t.test('phone overview-first landing, readable measures, keyboard triage and removal/re-add', async () => {
      await page.setViewportSize({width: 375, height: 812});
      await page.goto(`http://127.0.0.1:${port}/`); await ready();
      assert.equal(await page.evaluate(() => scrollY), 0);
      assert.equal(await page.evaluate(() => {
        const top = selector => document.querySelector(selector).getBoundingClientRect().top;
        return top('#overview') < top('#incident-list') && top('#incident-list') < top('#triage') && top('#triage') < top('aside');
      }), true);
      const geometry = await page.locator('.service-card dt, .service-card dd').evaluateAll(nodes => nodes.map(element => {
        const box = element.getBoundingClientRect();
        return {left: box.left, right: box.right, width: box.width, height: box.height, fits: element.scrollWidth <= element.clientWidth};
      }));
      assert.equal(geometry.length, expectedOverview().services.length * 8);
      for (const box of geometry) assert.ok(box.left >= 0 && box.right <= 375 && box.width > 0 && box.height > 0 && box.fits, JSON.stringify(box));
      const link = page.getByRole('link', {name: 'Personal triage', exact: true});
      await link.focus(); await page.keyboard.press('Enter');
      assert.equal(await focused(page.locator('#triage')), true);
      await open(first.id).focus(); await page.keyboard.press('Tab');
      assert.equal(await focused(remove(first.id)), true);
      await page.keyboard.press('Tab'); assert.equal(await focused(note(first.id)), true);
      assert.notEqual(await note(first.id).evaluate(element => getComputedStyle(element).outlineStyle), 'none');
      await note(first.id).press('End'); await page.keyboard.type(' keyboard');
      assert.ok((await stored()).entries[0].note.endsWith(' keyboard'));
      for (const control of [open(first.id), remove(first.id), note(first.id)]) {
        await control.scrollIntoViewIfNeeded();
        const box = await control.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= 375 && box.height > 0);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await remove(first.id).focus(); await page.keyboard.press('Enter');
      assert.equal(await focused(page.locator('#triage')), true);
      assert.deepEqual(await ids(), [second.id]);
      assert.deepEqual((await stored()).entries, [recognition(second)]);
      await page.reload(); await ready(); assert.deepEqual(await ids(), [second.id]);
      await search(first.id); await addFromResults(first);
      assert.deepEqual(await ids(), [second.id, first.id]); assert.equal(await note(first.id).inputValue(), '');
      await page.reload(); await ready(); assert.equal(await note(first.id).inputValue(), '');
    });

    await t.test('malformed real persisted values explain recovery without damaging saved views or address', async () => {
      const address = page.url();
      const saved = await page.evaluate(key => localStorage.getItem(key), viewsKey);
      for (const value of ['{', JSON.stringify({version: 2, entries: []}), JSON.stringify({version: 1, entries: [recognition(first), recognition(first)]}), JSON.stringify({version: 1, entries: [{...recognition(first), note: 42}]})]) {
        await page.evaluate(({key, value}) => localStorage.setItem(key, value), {key: TRIAGE_STORAGE_KEY, value});
        await page.reload(); await ready();
        assert.deepEqual(await ids(), []);
        assert.match(await page.locator('#triage-storage-message').textContent(), /malformed|unsupported/);
        assert.equal(page.url(), address);
        assert.equal(await page.evaluate(key => localStorage.getItem(key), viewsKey), saved);
        await addFromResults(first); await note(first.id).fill(editedNote);
        assert.equal(await page.locator('#triage-storage-message').textContent(), '');
        await page.reload(); await ready(); assert.equal(await note(first.id).inputValue(), editedNote);
      }
    });

    await t.test('quota denies triage writes before reversed-order adds and literal visit investigation', {timeout: 30000}, async () => {
      await page.evaluate(key => localStorage.removeItem(key), TRIAGE_STORAGE_KEY);
      await page.goto(`http://127.0.0.1:${port}/?q=incident`); await ready();
      assert.deepEqual(await ids(), []);
      const address = page.url();
      const literal = '  <script>window.triageInjected=true</script> & "quotes"\n雪  ';
      const edited = '  <img src=x onerror="window.triageInjected=true"> & **visit edit**\nline two  ';
      const denied = async entries => {
        // Exercise the exact production key/envelope with native setItem. Failure
        // must leave the readable key absent, not merely fail a filler write.
        const proof = await page.evaluate(({key, entries}) => {
          const before = localStorage.getItem(key);
          let name = null;
          try { localStorage.setItem(key, JSON.stringify({version: 1, entries})); }
          catch (error) { name = error.name; }
          return {name, before, after: localStorage.getItem(key)};
        }, {key: TRIAGE_STORAGE_KEY, entries});
        assert.deepEqual(proof, {name: 'QuotaExceededError', before: null, after: null});
      };
      const results = async q => {
        const {items, summary} = expected({q});
        assert.deepEqual(await page.locator('#rows button').evaluateAll(nodes => nodes.map(node => node.dataset.incident)), items.slice(0, 25).map(row => row.id));
        assert.deepEqual(await page.locator('#summary strong').allTextContents(), [summary.total, summary.unresolved, summary.highSeverity].map(n => n.toLocaleString('en-US')));
      };
      try {
        const quota = await page.evaluate(() => {
          let count = 0, name = null;
          // Finite coarse fill, then consume residual space with smaller native
          // writes so even a new recognition envelope cannot fit.
          for (let size = 1024; size >= 1; size = Math.floor(size / 2)) {
            for (let attempt = 0; attempt < 6000; attempt++) {
              try { localStorage.setItem(`triage-visit-fill-${count}`, 'x'.repeat(size)); count++; }
              catch (error) { name = error.name; break; }
            }
          }
          return {count, name};
        });
        assert.equal(quota.name, 'QuotaExceededError');
        assert.ok(quota.count > 0 && quota.count < 66000);
        await denied([recognition(first)]);
        await search('Billing'); await results('Billing');
        await search('incident'); await results('incident');
        await addFromResults(first);
        assert.deepEqual(await ids(), [first.id]);
        assert.equal(await page.locator('#triage-storage-message').isVisible(), true);
        assert.equal(await page.locator('#triage-storage-message').textContent(), 'Triage could not be saved to browser storage. Your current triage remains usable for this visit.');
        await note(first.id).fill(literal);
        await denied([recognition(first, literal)]);
        await addFromResults(second);
        assert.deepEqual(await ids(), [first.id, second.id]);
        await denied([recognition(first, literal), recognition(second)]);
        for (const row of [first, second]) {
          const entry = page.locator(`[data-triage-id="${row.id}"]`);
          assert.equal(await entry.locator('h3').textContent(), `${row.id} · ${row.title}`);
          assert.equal(await entry.locator('p').textContent(), `${row.service} · ${human(row.severity)} · ${human(row.status)} · Opened ${utc(row.openedAt)}`);
          await open(row.id).click(); await detail(row);
          assert.equal(await add(row.id).isDisabled(), true);
          await add(row.id).evaluate(button => { button.click(); button.click(); }); await close();
          assert.equal(await focused(open(row.id)), true);
        }
        assert.deepEqual(await ids(), [first.id, second.id]);
        assert.equal(await note(first.id).inputValue(), literal);
        await note(first.id).fill(edited);
        await note(second.id).fill('second <b>literal</b> & note');
        await search('Search'); await results('Search');
        const snapshot = await page.locator('#rows').textContent();
        await open(first.id).click(); await detail(first); await close();
        assert.equal(await page.locator('#rows').textContent(), snapshot);
        assert.deepEqual(await ids(), [first.id, second.id]);
        assert.equal(await note(first.id).inputValue(), edited);
        assert.equal(await note(second.id).inputValue(), 'second <b>literal</b> & note');
        assert.equal(await page.locator('#triage-list script, #triage-list img, #triage-list b').count(), 0);
        assert.equal(await page.evaluate(() => window.triageInjected), undefined);
        await denied([recognition(first, edited), recognition(second, 'second <b>literal</b> & note')]);
        assert.equal(await page.locator('#triage-storage-message').isVisible(), true);
        assert.equal(new URL(page.url()).searchParams.get('q'), 'Search');
        assert.ok(!page.url().includes('triage') && !address.includes('triage'));
        t.diagnostic(`Native quota exhaustion: ${quota.count} filler keys; exact triage setItem denied before additions and after visit edits; reads remained available. No reload persistence asserted during denial.`);
      } finally {
        await page.evaluate(() => {
          for (const key of Object.keys(localStorage)) if (key.startsWith('triage-visit-fill-')) localStorage.removeItem(key);
        });
      }
      // Restore the inherited recovery journey's starting state only after the
      // unavailable-write condition has ended.
      await remove(second.id).click(); await note(first.id).fill(editedNote);
      await search(first.id);
      assert.deepEqual(await stored(), {version: 1, entries: [recognition(first, editedNote)]});
    });

    await t.test('actual localStorage quota failure retains visit edits and recovers after space is freed', async () => {
      // Real browser storage exhaustion, without patched APIs, flags or HTTP responses.
      const quota = await page.evaluate(() => {
        let count = 0;
        try {
          for (; count < 6000; count++) localStorage.setItem(`triage-proof-fill-${count}`, 'x'.repeat(1024));
        } catch (error) { return {count, name: error.name}; }
        return {count, name: null};
      });
      assert.equal(quota.name, 'QuotaExceededError', 'bounded real quota probe must reach storage failure');
      try {
        const visitNote = `${editedNote}\n${'personal note '.repeat(1000)}`;
        await note(first.id).fill(visitNote);
        assert.match(await page.locator('#triage-storage-message').textContent(), /could not be saved.*current triage remains usable/i);
        assert.equal(await note(first.id).inputValue(), visitNote);
        assert.equal((await stored()).entries[0].note, editedNote);
        await open(first.id).click(); await detail(first); await close();
        assert.equal(await note(first.id).inputValue(), visitNote);
      } finally {
        await page.evaluate(() => {
          for (const key of Object.keys(localStorage)) if (key.startsWith('triage-proof-fill-')) localStorage.removeItem(key);
        });
      }
      await note(first.id).fill('recovered <literal>');
      assert.equal(await page.locator('#triage-storage-message').textContent(), '');
      await page.reload(); await ready(); assert.equal(await note(first.id).inputValue(), 'recovered <literal>');
      t.diagnostic('Runtime: genuine quota/write failure exercised. Storage getter/read denial was not induced; production catches and inherited component tests assess those conditions.');
    });
    assert.deepEqual(errors, []);
  } finally {
    try { await context?.close(); }
    finally { try { await browser?.close(); } finally { await stop(); } }
    assert.deepEqual(await readFile('.runtime/incidents.json'), before);
  }
});
