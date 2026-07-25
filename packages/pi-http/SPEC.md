# pi-http

An HTTP calling tool for the agent. Instead of shelling out to `curl` — with its quoting hazards and raw-text output — the agent makes requests through a structured tool with typed arguments, house-style rendering, and sane response handling.

## Loading

pi-http is an ordinary pi package:

```sh
pi install npm:@telepath-computer/pi-http
```

It loads through the `packages` array of pi's settings like any other package. It has no dependencies and no configuration file.

## Tool

One agent-callable tool, **`http`**. There is no human-facing command.

Input:

- `url` (required) — `http:` or `https:` only; anything else is rejected.
- `method` — `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`.
- `headers` — optional map of header name → value, sent as given.
- `body` — optional. A **string** is sent raw. An **object** is serialized to JSON and `content-type: application/json` is set, unless the caller already provided a `content-type` header. A body with `GET` or `HEAD` is a tool error — clear beats silently dropped.
- `timeoutSeconds` — optional positive number, default 30. The whole request (connect through body read) must finish within it.

## Behavior

- Requests are made with Node's global `fetch`; redirects are followed.
- **Any HTTP status is a normal result** — a 404 is an answer, not a failure (same principle as pi-runner's command exit codes). Tool errors are reserved for invalid input, network failure (DNS, refused connection, TLS), and timeout.
- The response body is decoded as text when the `content-type` is textual (`text/*`, JSON, XML, form-encoded, or an explicit charset) and capped at **16 KiB, keeping the head** — for responses, the interesting part is the front — with a marker noting how many bytes were dropped. Non-text content-types report the type and size; the body is omitted rather than dumped as bytes.
- The result text contains the status line, the response `content-type` and size, and the (possibly truncated) body. The structured `details` carry `{ status, headers, contentType, size, truncated, body }`.

## Rendering

`renderCall`/`renderResult` in the house style — accent tool name, muted detail, no raw JSON:

- Call: `http · POST api.linear.app/graphql` — method and host + path, with the query string elided past ~60 chars.
- Result: `200 · application/json · 1.2 KB` — status colored by class (2xx success color, 3xx muted, 4xx warning, 5xx error). Expanded rendering shows the body text.

## Out of scope (v1)

Recorded here deliberately: auth profiles or any config file, env-reference header values, streaming, file upload/download, cookies/sessions, and retries. `curl` via bash remains available for all of these.

## Status

Implemented.
