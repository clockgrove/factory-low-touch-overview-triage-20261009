import test from 'node:test';
import assert from 'node:assert/strict';
import {TRIAGE_STORAGE_KEY, loadTriage, persistTriage, addIncident, removeIncident, editNote} from '../../public/triage.js';

const incident = (id = 'INC-000001', service = 'Billing') => ({
  id, title: `Incident ${id}`, service, severity: 'high', status: 'open', openedAt: '2026-04-01T12:30:00.000Z',
  description: 'Full details <remain text>', resolvedAt: null, team: 'Team A', region: 'AMER', tags: ['example']
});
const freezeEntries = entries => Object.freeze(entries.map(entry => Object.freeze(entry)));
const encoded = entries => JSON.stringify({version: 1, entries});

test('add copies only recognition fields in insertion order; duplicate add preserves position and literal note', () => {
  const first = Object.freeze(incident('INC-000002')), second = Object.freeze(incident());
  const empty = Object.freeze([]);
  const added = addIncident(empty, first);
  assert.deepEqual(empty, []);
  assert.deepEqual(added, [{id: first.id, title: first.title, service: first.service, severity: first.severity,
    status: first.status, openedAt: first.openedAt, note: ''}]);
  assert.notEqual(added[0], first);
  const entries = freezeEntries(addIncident(editNote(freezeEntries(added), first.id, '<b>keep & "quotes"</b>\n雪'), second));
  assert.deepEqual(entries.map(entry => entry.id), [first.id, second.id]);
  assert.equal(addIncident(entries, {...first, title: 'New canonical title'}), entries);
  assert.equal(entries[0].title, first.title);
  assert.equal(entries[0].note, '<b>keep & "quotes"</b>\n雪');
  assert.equal(Object.hasOwn(first, 'note'), false);
});

test('note edits are literal, immutable and restricted to an existing member string note', () => {
  const entries = freezeEntries(addIncident(addIncident([], incident()), incident('INC-000002')));
  const note = '  <script>alert("x")</script> & **markdown**\nline two  ';
  const edited = editNote(entries, entries[0].id, note);
  assert.deepEqual(edited[0], {...entries[0], note});
  assert.equal(edited[1], entries[1]);
  assert.equal(entries[0].note, '');
  assert.equal(editNote(edited, entries[0].id, '')[0].note, '');
  assert.deepEqual(editNote(entries, 'missing', note), entries);
  for (const value of [null, undefined, 42, {}, ['text']]) assert.equal(editNote(entries, entries[0].id, value), entries);
});

test('remove deletes the note and re-add appends a fresh recognition snapshot', () => {
  const first = incident(), second = incident('INC-000002');
  const entries = freezeEntries(editNote(addIncident(addIncident([], first), second), first.id, 'old note'));
  const removed = freezeEntries(removeIncident(entries, first.id));
  assert.deepEqual(removed, [entries[1]]);
  assert.equal(entries[0].note, 'old note');
  const readded = addIncident(removed, {...first, title: 'Updated details', status: 'resolved'});
  assert.deepEqual(readded.map(entry => entry.id), [second.id, first.id]);
  assert.equal(readded[1].note, '');
  assert.equal(readded[1].title, 'Updated details');
  assert.equal(readded[1].status, 'resolved');
  assert.deepEqual(removeIncident(removed, 'missing'), removed);
});

test('persistence uses only the triage key and reloads ordered entries and literal text', () => {
  assert.equal(TRIAGE_STORAGE_KEY, 'incident-explorer.triage.v1');
  const values = new Map([['incident-explorer.views.v1', 'untouched saved views']]);
  const calls = [];
  const storage = {
    getItem(key) { calls.push(['get', key]); return values.get(key) ?? null; },
    setItem(key, value) { calls.push(['set', key]); values.set(key, value); }
  };
  assert.deepEqual(loadTriage(storage), {entries: [], warning: null});
  const entries = freezeEntries(editNote(addIncident(addIncident([], incident('INC-000002', 'Search')), incident()), 'INC-000002', '<em>literal</em>\n&'));
  assert.deepEqual(persistTriage(storage, entries), {warning: null});
  assert.equal(values.get(TRIAGE_STORAGE_KEY), encoded(entries));
  const loaded = loadTriage(storage);
  assert.deepEqual(loaded, {entries, warning: null});
  assert.notEqual(loaded.entries, entries);
  assert.notEqual(loaded.entries[0], entries[0]);
  assert.equal(values.get('incident-explorer.views.v1'), 'untouched saved views');
  assert.deepEqual(calls, [['get', TRIAGE_STORAGE_KEY], ['set', TRIAGE_STORAGE_KEY], ['get', TRIAGE_STORAGE_KEY]]);
  assert.deepEqual(persistTriage(storage, []), {warning: null});
  assert.deepEqual(loadTriage(storage), {entries: [], warning: null});
});

test('reload validates the entire envelope, every field, enumerations, timestamps and unique IDs', () => {
  const entry = addIncident([], incident())[0];
  const malformed = ['', '{', 'null', '[]', '1', 'true', '{}', JSON.stringify({version: 2, entries: []}),
    JSON.stringify({version: '1', entries: []}), JSON.stringify({version: 1, entries: {}}),
    JSON.stringify({version: 1, entries: [], extra: true}), encoded([entry, entry]), encoded([entry, null]),
    encoded([entry, {}]), encoded([{...entry, extra: 'untrusted'}])];
  for (const field of Object.keys(entry)) {
    const missing = {...entry}; delete missing[field];
    malformed.push(encoded([missing]));
    for (const value of [null, 3, [], {}]) malformed.push(encoded([{...entry, [field]: value}]));
  }
  for (const [field, values] of Object.entries({id: [''], service: ['Unknown'], severity: ['urgent'], status: ['closed'],
    openedAt: ['not a date', '2026-04-01', '2026-02-30T12:30:00.000Z', '2026-04-01T12:30:00+00:00']})) {
    for (const value of values) malformed.push(encoded([{...entry, [field]: value}]));
  }
  for (const stored of malformed) {
    const loaded = loadTriage({getItem: () => stored});
    assert.deepEqual(loaded.entries, [], stored);
    assert.match(loaded.warning, /malformed|unsupported/, stored);
  }
  for (const service of ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations']) {
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      for (const status of ['open', 'in_progress', 'resolved']) {
        const entries = [{...entry, service, severity, status}];
        assert.deepEqual(loadTriage({getItem: () => encoded(entries)}), {entries, warning: null});
      }
    }
  }
});

test('unavailable storage and throwing storage operations preserve usable current entries and recover', () => {
  const current = freezeEntries(editNote(addIncident([], Object.freeze(incident())), 'INC-000001', 'keep this note'));
  const before = encoded(current);
  for (const storage of [undefined, null, {}, {
    getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); }
  }, {get getItem() { throw new Error('access denied'); }, get setItem() { throw new Error('access denied'); }}]) {
    const loaded = loadTriage(storage);
    assert.deepEqual(loaded.entries, []);
    assert.match(loaded.warning, /could not be read/);
    assert.match(persistTriage(storage, current).warning, /could not be saved/);
    assert.equal(encoded(current), before);
  }
  let stored = 'malformed';
  const storage = {getItem: () => stored, setItem: (key, value) => { stored = value; }};
  assert.match(loadTriage(storage).warning, /malformed/);
  assert.equal(encoded(current), before);
  const edited = freezeEntries(editNote(current, current[0].id, 'latest visit text'));
  assert.equal(persistTriage(storage, edited).warning, null);
  assert.deepEqual(loadTriage(storage), {entries: edited, warning: null});
  assert.equal(current[0].note, 'keep this note');
});
