// Browser-local personal metadata, independent of incidents, queries and views.
export const TRIAGE_STORAGE_KEY = 'incident-explorer.triage.v1';
const fields = ['id', 'title', 'service', 'severity', 'status', 'openedAt', 'note'];
const services = ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'];
const severities = ['critical', 'high', 'medium', 'low'];
const statuses = ['open', 'in_progress', 'resolved'];
const readWarning = 'Triage could not be read from browser storage. You can still use triage for this visit.';
const writeWarning = 'Triage could not be saved to browser storage. Your current triage remains usable for this visit.';

function hasFields(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function validEntry(entry) {
  if (!hasFields(entry, fields) || !fields.every(key => typeof entry[key] === 'string')) return false;
  const time = Date.parse(entry.openedAt);
  const normalized = entry.openedAt.includes('.') ? entry.openedAt : entry.openedAt.replace('Z', '.000Z');
  return entry.id.length > 0 && services.includes(entry.service) && severities.includes(entry.severity)
    && statuses.includes(entry.status) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(entry.openedAt)
    && Number.isFinite(time) && new Date(time).toISOString() === normalized;
}

export function loadTriage(storage) {
  let stored;
  try { stored = storage.getItem(TRIAGE_STORAGE_KEY); }
  catch { return {entries: [], warning: readWarning}; }
  if (stored === null) return {entries: [], warning: null};
  try {
    const value = JSON.parse(stored);
    if (!hasFields(value, ['version', 'entries']) || value.version !== 1 || !Array.isArray(value.entries)
      || !value.entries.every(validEntry) || new Set(value.entries.map(entry => entry.id)).size !== value.entries.length) {
      throw new Error('Invalid triage data');
    }
    return {entries: value.entries, warning: null};
  } catch {
    return {entries: [], warning: 'Stored triage data is malformed or unsupported. You can start a new triage list for this visit.'};
  }
}

export function persistTriage(storage, entries) {
  try {
    storage.setItem(TRIAGE_STORAGE_KEY, JSON.stringify({version: 1, entries}));
    return {warning: null};
  } catch { return {warning: writeWarning}; }
}

export function addIncident(entries, incident) {
  if (entries.some(entry => entry.id === incident.id)) return entries;
  const {id, title, service, severity, status, openedAt} = incident;
  return [...entries, {id, title, service, severity, status, openedAt, note: ''}];
}

export function removeIncident(entries, id) {
  return entries.filter(entry => entry.id !== id);
}

export function editNote(entries, id, note) {
  if (typeof note !== 'string') return entries;
  return entries.map(entry => entry.id === id ? {...entry, note} : entry);
}
