import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createAppServer } from '../../server/app.mjs';

const dataURL = new URL('../../.runtime/incidents.json', import.meta.url);

// Independent canonical-data calculation: numeric UTC bounds and per-service subsets.
function calculate(rows, options = {}) {
  const matches = rows.filter(row => {
    if (options.q && ![row.id, row.title, row.description].some(text => text.toUpperCase().includes(options.q.toUpperCase()))) return false;
    for (const key of ['service', 'status', 'severity']) {
      if (options[key]?.length && !options[key].includes(row[key])) return false;
    }
    const opened = Date.parse(row.openedAt);
    return (!options.from || opened >= Date.parse(`${options.from}T00:00:00Z`)) &&
      (!options.to || opened < Date.parse(`${options.to}T00:00:00Z`) + 86400000);
  });
  const names = [...new Set(matches.map(row => row.service))];
  const services = names.map(service => {
    const subset = matches.filter(row => row.service === service);
    const durations = subset.filter(row => row.status === 'resolved').map(row =>
      (new Date(row.resolvedAt).getTime() - new Date(row.openedAt).getTime()) / 3600000);
    return {
      service,
      incidentCount: subset.length,
      unresolvedCount: subset.filter(row => ['open', 'in_progress'].includes(row.status)).length,
      highSeverityCount: subset.filter(row => ['critical', 'high'].includes(row.severity)).length,
      averageResolutionHours: durations.length ? durations.reduce((sum, hours) => sum + hours, 0) / durations.length : null,
    };
  });
  services.sort((a, b) => b.unresolvedCount - a.unresolvedCount || a.service.localeCompare(b.service, 'en'));
  return { total: matches.length, services };
}

function params(options) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  return query;
}

test('whole-result service overview through real loopback HTTP', { timeout: 30000 }, async t => {
  const before = await readFile(dataURL);
  const rows = JSON.parse(before);
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(5000) });
    const check = async (options = {}) => {
      const response = await request(`/api/overview?${params(options)}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const actual = await response.json();
      assert.deepEqual(actual, calculate(rows, options));
      return actual;
    };

    await t.test('all canonical incidents, exact unrounded averages and deterministic order', async () => {
      const body = await check();
      assert.equal(body.total, 2400);
      assert.equal(body.services.length, 6);
      assert.equal(body.services.reduce((sum, entry) => sum + entry.incidentCount, 0), body.total);
      assert.ok(body.services.some(entry => entry.averageResolutionHours % 1 !== 0));
      assert.deepEqual(await check(), body);
    });
    await t.test('combined search, repeated facets and dates span pages; presentation parameters are invariant', async () => {
      const options = { q: 'iNcIdEnT', service: ['Billing', 'Notifications'], status: ['open', 'in_progress', 'resolved'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13' };
      const body = await check(options);
      assert.ok(body.total > 50);
      const list = await request(`/api/incidents?${params(options)}`);
      const page = await list.json();
      assert.equal(page.total, body.total);
      assert.equal(page.items.length, 25);
      for (const sort of ['openedAt', 'severity']) {
        for (const direction of ['asc', 'desc']) {
          for (const pageSize of [25, 50]) {
            assert.deepEqual(await check({ ...options, sort, direction, pageSize, page: 999999 }), body);
          }
        }
      }
    });
    await t.test('inclusive UTC boundary days and single-ended ranges', async () => {
      for (const date of ['2026-04-01', '2026-06-29']) {
        assert.ok((await check({ from: date, to: date })).total > 0);
      }
      await check({ from: '2026-06-13' });
      await check({ to: '2026-04-15' });
    });
    await t.test('unresolved incidents have unavailable averages and only matching services appear', async () => {
      const body = await check({ status: ['open', 'in_progress'], service: ['Billing', 'Search', 'Billing'] });
      assert.equal(body.services.length, 2);
      for (const entry of body.services) {
        assert.equal(entry.averageResolutionHours, null);
        assert.equal(entry.unresolvedCount, entry.incidentCount);
      }
      await check({ q: 'INC-000001' });
      await check({ q: 'Second line: <SAMPLE>' });
    });
    await t.test('tied unresolved counts use ascending service names', async () => {
      const body = await check({ status: ['resolved'] });
      assert.equal(body.services.length, 6);
      assert.ok(body.services.every(entry => entry.unresolvedCount === 0 && entry.averageResolutionHours > 0));
      assert.deepEqual(body.services.map(entry => entry.service), ['Accounts', 'Billing', 'Integrations', 'Notifications', 'Search', 'Uploads']);
    });
    await t.test('empty results have exactly the settled empty shape', async () => {
      for (const options of [{ q: 'no such incident' }, { from: '2027-01-01' }, { q: '.*', page: 999999 }]) {
        assert.deepEqual(await check(options), { total: 0, services: [] });
      }
    });
    await t.test('query validation and error bodies match incidents, including ignored presentation fields', async () => {
      const invalid = ['unknown=yes', 'q=a&q=b', 'service=billing', 'status=closed', 'severity=urgent', 'from=2026-02-30', 'to=2026-13-01', 'from=', 'from=2026-06-01&to=2026-04-01', 'sort=id', 'direction=down', 'sort=severity&sort=openedAt', 'direction=asc&direction=desc', 'page=0', 'page=-1', 'page=1.5', 'page=9007199254740992', 'page=1&page=2', 'pageSize=100', 'pageSize=25&pageSize=50'];
      for (const query of invalid) {
        const overview = await request(`/api/overview?${query}`);
        const incidents = await request(`/api/incidents?${query}`);
        assert.equal(overview.status, 400, query);
        assert.equal(incidents.status, 400, query);
        assert.deepEqual(await overview.json(), await incidents.json(), query);
      }
      const response = await request('/api/overview', { method: 'POST' });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET');
      assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
    });
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    assert.deepEqual(await readFile(dataURL), before);
  }
});
