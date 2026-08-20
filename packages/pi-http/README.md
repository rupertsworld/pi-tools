# @rupertsworld/pi-http

A structured HTTP calling tool for [pi](https://github.com/earendil-works/pi-mono) agents. Instead of shelling out to `curl`, the agent makes requests through a typed tool — no quoting hazards, house-style rendering, sane response truncation.

```sh
pi install npm:@rupertsworld/pi-http
```

## Surface

One agent-callable tool, `http`:

- `{ url, method?, headers?, body?, timeoutSeconds? }` — `body` takes a raw string or an object (auto-serialized to JSON with the right `content-type`).
- Any HTTP status is a normal result — a 404 is an answer, not a failure. Tool errors are reserved for invalid input, network failure, and timeout.
- Text responses are capped at 16 KiB (head kept, marker for the rest); binary responses report type and size instead of bytes.
- Rendered compactly: `http · POST api.linear.app/graphql` → `200 · application/json · 1.2 KB`.

No dependencies; one optional config — a `base` and/or `allow` list in `http.json` confines every request (redirects included) to a set of allowed servers, with `base` also letting `url` be a relative path. [`spec/pi-http/index.md`](https://github.com/rupertsworld/pi-tools/blob/main/spec/pi-http/index.md) is the authority on behavior.
