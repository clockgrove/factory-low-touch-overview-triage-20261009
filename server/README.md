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
