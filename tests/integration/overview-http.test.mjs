import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {expected, expectedOverview} from './oracle.js';
import {createState, transition, isOverviewCurrent} from '../../public/state.js';

const params = options => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  return query;
};

test('overview integration: canonical measures, complete combined pages and presentation invariance', {timeout: 30000}, async t => {
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening', {signal: AbortSignal.timeout(5000)});
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (path, options) => {
      const response = await fetch(`${base}${path}?${params(options)}`, {signal: AbortSignal.timeout(5000)});
      assert.equal(response.status, 200);
      return response.json();
    };
    const check = async (options = {}) => {
      const actual = await get('/api/overview', options);
      assert.deepEqual(actual, expectedOverview(options));
      return actual;
    };
    await t.test('all measures, fractional averages and service-name tie ordering', async () => {
      const all = await check();
      assert.equal(all.total, 2400);
      assert.equal(all.services.length, 6);
      assert.ok(all.services.some(row => row.averageResolutionHours % 1 !== 0));
      const tied = await check({status: ['resolved']});
      assert.ok(tied.services.every(row => row.unresolvedCount === 0));
      assert.deepEqual(tied.services.map(row => row.service), ['Accounts', 'Billing', 'Integrations', 'Notifications', 'Search', 'Uploads']);
    });
    await t.test('combined literal search, OR facets, AND facets and UTC dates cover every matching page', async () => {
      const options = {q: 'iNcIdEnT', service: ['Billing', 'Notifications'], status: ['open', 'in_progress', 'resolved'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13'};
      const whole = await check(options);
      assert.ok(whole.total > 50);
      for (const pageSize of [25, 50]) {
        const collected = [];
        for (let page = 1; page <= Math.ceil(whole.total / pageSize); page++) {
          const list = await get('/api/incidents', {...options, page, pageSize});
          assert.equal(list.total, whole.total);
          collected.push(...list.items);
          assert.deepEqual(await check({...options, page, pageSize}), whole);
        }
        assert.deepEqual(collected, expected(options).items);
        assert.equal(new Set(collected.map(row => row.id)).size, whole.total);
      }
      for (const sort of ['openedAt', 'severity']) for (const direction of ['asc', 'desc']) {
        assert.deepEqual(await check({...options, sort, direction, page: 99999, pageSize: 50}), whole);
      }
      for (const day of ['2026-04-01', '2026-06-29']) assert.ok((await check({from: day, to: day})).total > 0);
      await check({q: 'second LINE: <sample>'});
    });
    await t.test('no resolved incidents means unavailable averages; empty results omit all services', async () => {
      const unresolved = await check({status: ['open', 'in_progress']});
      assert.ok(unresolved.total > 0);
      for (const entry of unresolved.services) {
        assert.equal(entry.averageResolutionHours, null);
        assert.equal(entry.unresolvedCount, entry.incidentCount);
      }
      assert.deepEqual(await check({q: 'no overview matches this phrase'}), {total: 0, services: []});
      assert.deepEqual(await check({from: '2027-01-01', page: 50}), {total: 0, services: []});
    });
  } finally {
    if (server.listening) await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
});

// Production state evidence complements the finite real browser overlap journey.
// app.js captures the token before fetch/body parsing and gates catch/finally
// through this module; aborting requests alone is not the ownership guarantee.
test('overview integration state: canonical snapshots and current error/loading survive obsolete writers', {timeout: 5000}, () => {
  const send = (state, type, payload = {}) => transition(state, {type, ...payload});
  let state = send(createState(), 'overview:start');
  state = send(state, 'overview:success', {token: state.overviewOp.token, data: expectedOverview()});
  const snapshot = state.overview;
  state = send(state, 'intent', {patch: {q: 'Billing'}});
  state = send(state, 'overview:start'); const old = state.overviewOp.token;
  state = send(state, 'intent', {patch: {q: 'Search', status: ['open']}});
  state = send(state, 'overview:start'); const failed = state.overviewOp.token;
  state = send(state, 'overview:failure', {token: failed, error: 'Connection refused'});
  for (const ending of ['success', 'failure', 'finish']) {
    assert.equal(send(state, `overview:${ending}`, {token: old, data: expectedOverview({q: 'Billing'}), error: 'obsolete'}), state);
  }
  assert.equal(state.overview, snapshot);
  assert.equal(state.overviewOp.error, 'Connection refused');
  assert.equal(isOverviewCurrent(state), false);
  state = send(state, 'overview:start');
  for (const token of [old, failed]) for (const ending of ['success', 'failure', 'finish']) {
    assert.equal(send(state, `overview:${ending}`, {token, data: expectedOverview(), error: 'obsolete'}), state);
  }
  assert.equal(state.overviewOp.pending, true);
  assert.equal(state.overviewOp.error, null);
  const op = state.overviewOp;
  state = send(state, 'intent', {patch: {pageSize: 50, sort: 'severity'}});
  assert.equal(state.overviewOp, op);
  state = send(state, 'overview:success', {token: op.token, data: expectedOverview({q: 'Search', status: ['open']})});
  assert.deepEqual(state.overview.data, expectedOverview(state.overviewIntent));
  assert.equal(isOverviewCurrent(state), true);
});
