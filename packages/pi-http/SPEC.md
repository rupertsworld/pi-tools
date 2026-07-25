# pi-http

An HTTP calling tool for the agent. Instead of shelling out to `curl` — with its quoting hazards and raw-text output — the agent makes requests through a structured tool with typed arguments, house-style rendering, and sane response handling.

## Loading

pi-http is an ordinary pi package:

```sh
pi install npm:@telepath-computer/pi-http
```

It loads through the `packages` array of pi's settings like any other package. It has no dependencies and one optional configuration file (see Configuration).

## Tool

One agent-callable tool, **`http`**. There is no human-facing command.

Input:

- `url` (required) — `http:` or `https:` only; anything else is rejected. With a base configured, may instead be a path relative to it (see Configuration).
- `method` — `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, or `OPTIONS`.
- `headers` — optional map of header name → value, sent as given.
- `body` — optional. A **string** is sent raw. An **object** is serialized to JSON and `content-type: application/json` is set, unless the caller already provided a `content-type` header. A body with `GET` or `HEAD` is a tool error — clear beats silently dropped.
- `timeoutSeconds` — optional positive number, default 30. The whole request (connect through body read) must finish within it.

## Behavior

- Requests are made with Node's global `fetch`; redirects are followed (with a base configured, manually and per-hop checked — see Configuration).
- **Any HTTP status is a normal result** — a 404 is an answer, not a failure (same principle as pi-runner's command exit codes). Tool errors are reserved for invalid input, network failure (DNS, refused connection, TLS), and timeout.
- The response body is decoded as text when the `content-type` is textual (`text/*`, JSON, XML, form-encoded, or an explicit charset) and capped at **16 KiB, keeping the head** — for responses, the interesting part is the front — with a marker noting how many bytes were dropped. Non-text content-types report the type and size; the body is omitted rather than dumped as bytes.
- The result text contains the status line, the response `content-type` and size, and the (possibly truncated) body. The structured `details` carry `{ status, headers, contentType, size, truncated, body }`.

## Configuration

An optional `http.json` in the agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) confines the tool to a single origin — for locked-down sessions where the agent's only road out is a capability server:

```json
{ "base": "http://bellhop:8770" }
```

- `base` is an origin only — `http:` or `https:` scheme, host, optional port. No path (a lone trailing `/` is tolerated), no query, no fragment; anything else is invalid config.
- With a valid base, `url` may be relative, with or without a leading `/`, resolved against the base per WHATWG URL resolution. An absolute `url` is allowed only when its origin (scheme + host + port) equals the base's; otherwise a tool error naming the base.
- Redirects are followed manually, capped at 10 hops, and every `Location` is resolved and origin-checked against the base — a cross-origin hop is a tool error. (Automatic following would let the allowed origin 302 the request anywhere.) Per fetch convention, a 303 on anything but GET or HEAD — or a 301/302 answering a POST — turns the next hop into a body-less GET; 307/308 keep the method and body.
- **Missing file → unrestricted:** exactly the unconfigured behavior above, and a relative `url` stays a tool error. A present file without a `base` key (`{}`) is the same — the restriction lives in the key, not in the file's existence.
- **Strict schema, fail closed:** `base` is the only recognized key. An unrecognized top-level key (a mistyped `"bsae"` lock), a non-object top level, an unreadable or unparseable file, or an invalid `base` makes every call a tool error naming the config problem. Failing open on a broken config would silently unlock the session.
- The file is read on every call and is human-owned: in a locked-down session the agent has no filesystem tools, so it cannot reach it by construction.

## Rendering

`renderCall`/`renderResult` in the house style — accent tool name, muted detail, no raw JSON:

- Call: `http · POST api.linear.app/graphql` — method and host + path, with the query string elided past ~60 chars.
- Result: `200 · application/json · 1.2 KB` — status colored by class (2xx success color, 3xx muted, 4xx warning, 5xx error). Expanded rendering shows the body text.

## Out of scope (v1)

Recorded here deliberately: auth profiles, env-reference header values, streaming, file upload/download, cookies/sessions, and retries. `curl` via bash remains available for all of these.

Recorded future work: per-base default headers in `http.json` — a header attached to every request to the configured base — so a capability-server credential can ride along without appearing in the agent's context.

## Status

Implemented.
