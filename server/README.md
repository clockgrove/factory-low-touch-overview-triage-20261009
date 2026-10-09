# Local incident server

From the repository root, run `npm run seed`, then `npm run start`.
The server prints its actual URL, normally `http://127.0.0.1:3000`.
Set `PORT` to another port, or `PORT=0` for an available ephemeral port.
Press Ctrl+C to close the foreground server gracefully; SIGTERM also closes it.
Use Node.js 24. In the supplied qualification environment, run these finite
verification commands from the root in order:

```sh
npm run pretest
qualification-browser-smoke
npm test
```

Preparation checks canonical data and pinned tooling. The unchanged smoke probe
qualifies sandbox-enabled Chromium and loopback HTTP. The suite then verifies
application behavior, including independent canonical-data overview calculations
over actual HTTP; setup and smoke alone do not verify the product. Tests close
their owned servers, browsers and subprocesses in cleanup paths.

The server reads `.runtime/incidents.json` without changing it and serves
the repository's `public/` directory when frontend files are present.
Only GET requests are supported. API errors are `{error:{code,message}}`.

Personal triage belongs to the browser, not the server API. Add from complete
details, keep entries in added order, edit labeled plain-text notes and reopen
details without losing search results. Entries show ID, title, service, severity,
status and opening time. Repeated add preserves order and note without duplicates;
remove clears the note and re-add starts empty. Markup-looking notes remain text.
Same-origin localStorage stores `{version:1,entries}` under
`incident-explorer.triage.v1`, separately from saved views and the address.
Changing hostname or port changes the storage origin. Triage never changes
canonical incidents or enters saved-view records, URLs or external requests.
Unreadable storage or malformed/unsupported initial data produces a dedicated
message and an empty usable list. Failed writes keep current-visit entries and
notes usable, but persistence after reload is not assured. A later successful
edit saves the new list, replacing malformed data and clearing the warning.
Exploration stays available. On phones, the retained landing shows operational
overview cards first, incident results next and reachable triage after the list,
before filters; labeled links and visible focus support keyboard navigation.

Required finite browser verification adds two triage IDs in order, repeated add,
literal note editing, reload, reopen preserving search, removal clearing notes,
empty-note re-add, malformed storage, keyboard and narrow-screen journeys.
Retain inherited HTTP, overview, selection and failure/retry proof. Exercise
unavailable storage when feasible; otherwise report the exact environment
limitation and unexercised condition alongside source robustness review.
This documentation update does not certify the parallel browser suite. Final
integrated QA checks the finished suite and reported limitations, distinguishes
real exercised behavior from tooling qualification, and confirms cleanup of
all real servers and browsers.

`/api/incidents` accepts literal case-insensitive `q` over ID, title and
description; repeated `service`, `status` and `severity`; inclusive UTC
`from` and `to` dates in YYYY-MM-DD form; `sort=openedAt|severity`;
`direction=asc|desc`; a positive `page`; and `pageSize=25|50`.
Defaults are no filters, openedAt descending, page 1 and size 25.
Facet values are case-sensitive and use the dataset's exact enumerations.
Values within a facet are OR, and separate facets are AND.
Opened-date ties use ID ascending. Severity ties use openedAt descending,
then ID ascending. Page requests clamp to the available range.
Summaries cover all matches, with chronological UTC day buckets.

`GET /api/overview` accepts the same query parameters, defaults and validation
as `/api/incidents`. Valid `sort`, `direction`, `page` and `pageSize` values
have no effect on aggregation or service ordering. It returns
`{total,services}` for the complete filtered result, with each service entry:

- `service`: the matching service name; services with no matches are omitted.
- `incidentCount`: the number of matching incidents for that service.
- `unresolvedCount`: matching open and in-progress incidents.
- `highSeverityCount`: matching critical and high incidents, in any status.
- `averageResolutionHours`: the arithmetic mean of elapsed hours from
  `openedAt` to `resolvedAt` for resolved incidents only. The API does not
  round it. Open and in-progress incidents contribute nothing to this mean;
  when none are resolved, it is `null`, meaning unavailable rather than zero.

`total` counts all matching incidents across services. Services are ordered
by unresolved count descending, then service name ascending. Empty results
are exactly `{total:0,services:[]}`. Invalid parameters use the same 400
`INVALID_QUERY` error convention as the incident list. For example,
`/api/overview?service=Billing&status=open&status=in_progress` measures every
unresolved Billing incident, regardless of the visible incident page.

`/api/incidents/:id` returns every incident field, or 404.
`/api/export.csv` applies the same filters and sorting, ignores pagination,
and exports all fields in dataset order. Tags are JSON array text, null is
empty, quotes are doubled, and records use CRLF.
