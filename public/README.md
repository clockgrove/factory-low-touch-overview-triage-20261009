# Incident explorer frontend

Serve this directory from the local app's same origin. `index.html` loads `app.js`, `state.js`, and `styles.css`; requests use the settled `/api/overview`, `/api/incidents`, `/api/incidents/:id`, and `/api/export.csv` endpoints. No dataset or server is embedded in the frontend.

Search is submitted with Search or Enter. Facet, date, sorting, and page-size changes apply immediately and return to page one. Dates and displayed timestamps use UTC. The overview and daily counts describe the full matching result. While updating, the previous completed rows and summaries remain explicitly marked, and page controls are disabled. CSV exports the current applied selections and sort, across all pages; tags follow the API's JSON-array CSV representation.

Copy or bookmark the browser address to share the applied query, including sorting, page size and later pages. Reload and fresh tabs restore the results view. Back and Forward restore controls (discarding unsent drafts), rows and whole-result summaries; pending requests retain the previous snapshot as stale. Details and export activity do not create history entries. Invalid address values fall back to defaults; invalid dates clear and reversed date ranges clear both bounds. Unknown parameters are removed.

Named views persist the applied search, facets, dates, sorting, and page size in browser localStorage. Opening a view applies its selections together and returns to page one. Storage failures are visible and exploration remains available.

The native details dialog supports keyboard dismissal, exposes every incident field as text, and restores focus to the incident on return. Results, service overview requests, detail sessions, and exports have separate ownership tokens. Each completion, error, and cleanup is gated; changed selections invalidate details and export downloads. Cancellation helps save work but tokens provide correctness. Download object URLs are released.

Run the repository's exact verification command from the checkout:

```sh
npm test
```

Discoverable tests under `tests/frontend/` exercise the actual DOM-free state module with direct events. These establish component behavior, including overlapping intents and retries; they do not establish real HTTP or browser integration. The integration suites run real sandbox-enabled Chromium against the existing backend and compare with an independent canonical-data oracle. See the root README for preparation, browser qualification and startup instructions.

Component review: `state.js` separates the requested intent from the last displayed snapshot and publishes rows and whole-result summaries atomically. Pending or stale queries lock pagination, and synchronous page transitions are clamped before dispatch. The UI retains the native modal and return target while detail ownership changes; it renders dataset values through text nodes. Independent operation tokens gate success, failure, and cleanup, and export gates download side effects after reading the response. This review establishes frontend structure and state behavior only.

The service overview requests `GET /api/overview` using the applied search,
facets and inclusive UTC dates. It covers the entire filtered result, regardless
of incident pagination, page size or sorting. Each service shows all matching
incidents, unresolved incidents (open or in progress), critical or high incidents,
and mean opening-to-resolution hours for resolved incidents only. The displayed
average is rounded to at most two decimal places; an average with no resolved
incidents is explicitly unavailable. Services follow the API's order: unresolved
count descending, then service name ascending.

Overview requests have independent filter identity, completed snapshots and
operation tokens. Search, facets, dates, address navigation and saved-view recall
supersede their success, errors, retry targets and cleanup. Page, size and sort
changes preserve the overview's filter meaning and pending request. Requested
filters and any previous snapshot's filters are labeled separately. Loading,
empty and failure messages belong to the overview; its Retry requests the current
filters. Live announcements prioritize details, list errors/loading, overview
errors/loading, then export activity and the current list count.

The operator's retained planning answer selects operational overview first on
phones. The narrow layout places results and the service overview before the
filter panel, and wraps each service's measures into readable cards. Labeled
links reach the overview, incident list and filters by keyboard; no new autofocus
policy is applied. Existing details focus restoration, addresses and storage
remain in place.

Direct tests exercise the production state module, including an obsolete
completion, failure and cleanup after newer filters fail and retry. Existing
real browser regressions still verify explorer journeys. Real overview HTTP and
browser proof requires the separately owned backend and downstream integration
work; this frontend does not substitute or fabricate that endpoint.
