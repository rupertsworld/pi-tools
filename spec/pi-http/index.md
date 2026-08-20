# pi-http

An HTTP calling tool for the agent. Instead of shelling out to `curl` — with its quoting hazards and raw-text output — the agent makes requests through a structured tool with typed arguments, house-style rendering, and sane response handling.

## Loading

pi-http is an ordinary pi package:

```sh
pi install npm:@rupertsworld/pi-http
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

- Requests are made with Node's global `fetch`; redirects are followed (with a restriction configured, manually and per-hop checked — see Configuration).
- **Any HTTP status is a normal result** — a 404 is an answer, not a failure (same principle as pi-runner's command exit codes). Tool errors are reserved for invalid input, network failure (DNS, refused connection, TLS), and timeout.
- The response body is decoded as text when the `content-type` is textual (`text/*`, JSON, XML, form-encoded, or an explicit charset) and capped at **16 KiB, keeping the head** — for responses, the interesting part is the front — with a marker noting how many bytes were dropped. Non-text content-types report the type and size; the body is omitted rather than dumped as bytes.
- The result text contains the status line, the response `content-type` and size, and the (possibly truncated) body. The structured `details` carry `{ status, headers, contentType, size, truncated, body }`.

## Configuration

An optional `http.json` in the agent home (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) confines the tool to a set of allowed servers — for locked-down sessions where the agent's roads out are known in advance:

```json
{ "base": "http://localhost:8770", "allow": ["localhost:*", "api.linear.app"] }
```

Two keys, each optional; either one being present activates the restriction.

- `base` is a single origin — `http:` or `https:` scheme, host, optional port. No path (a lone trailing `/` is tolerated), no query, no fragment; anything else is invalid config. Beyond allowing its origin, a base does what an `allow` entry cannot: `url` may then be relative, with or without a leading `/`, resolved against it per WHATWG URL resolution. Without a base, a relative `url` stays a tool error even when `allow` is set.
- `allow` is a list of server patterns. Each entry is exactly one of:
  - `host` — that host over either scheme at its default port (`example.com` allows `http://example.com` and `https://example.com`, not `https://example.com:8443`).
  - `host:port` — that host and port, either scheme.
  - `host:*` — any port on that host, either scheme.
  - `scheme://host[:port]` — an exact origin, same rules as `base`.
  - `*` — any server; the explicit way to run a restricted session unrestricted (still `http:`/`https:` only).

  Hosts compare case-insensitively and exactly — no subdomain wildcards (`*.example.com` is invalid config). Ports compare by effective port: a URL or entry without an explicit port has its scheme's default (80/443), so `example.com:443` matches `https://example.com`.
- A request is allowed when its origin equals the base's or matches any `allow` entry; anything else is a tool error naming the allowed set.
- With the restriction active, redirects are followed manually, capped at 10 hops, and every `Location` is resolved and checked against the full allowed set (base plus `allow`) — a hop to a disallowed server is a tool error; a hop between two allowed servers is permitted, though a hop that changes origin drops the `authorization`, `proxy-authorization`, and `cookie` request headers — per fetch convention, a credential sent to one server never rides a redirect to another. (Automatic following would let an allowed server 302 the request anywhere.) Per fetch convention, a 303 on anything but GET or HEAD — or a 301/302 answering a POST — turns the next hop into a body-less GET; 307/308 keep the method and body.
- **Missing file → unrestricted:** exactly the unconfigured behavior above, and a relative `url` stays a tool error. A present file with neither key (`{}`) is the same — the restriction lives in the keys, not in the file's existence. An empty list is a present key: `{"allow": []}` with no base refuses every request.
- **Strict schema, fail closed:** `base` and `allow` are the only recognized keys. An unrecognized top-level key (a mistyped `"alow"` lock), a non-object top level, an unreadable or unparseable file, an invalid `base`, or an `allow` that is not an array of valid patterns makes every call a tool error naming the config problem. Failing open on a broken config would silently unlock the session.
- The file is read on every call and is human-owned: in a locked-down session the agent has no filesystem tools, so it cannot reach it by construction.

## Rendering

`renderCall`/`renderResult` in the house style — accent tool name, muted detail, no raw JSON:

- Call: `http · POST api.linear.app/graphql` — method and host + path, with the query string elided past ~60 chars.
- Result: `200 · application/json · 1.2 KB` — status colored by class (2xx success color, 3xx muted, 4xx warning, 5xx error). Expanded rendering shows the body text.

## Out of scope (v1)

Recorded here deliberately: auth profiles, env-reference header values, streaming, file upload/download, cookies/sessions, and retries. `curl` via bash remains available for all of these.

Recorded future work: per-base default headers in `http.json` — a header attached to every request to the configured base — so a capability-server credential can ride along without appearing in the agent's context.
