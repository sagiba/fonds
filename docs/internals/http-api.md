# HTTP API internals

This page is for contributors who change `/v1` routes or the API description. The
[API reference](../api.md) owns what clients see; this page owns how the HTTP
transport derives it and why it is built this way.

## One route table

Each operation in [operations.ts](../../src/application/operations.ts) owns its
input and output schemas, scope and description, shared by HTTP, MCP and the CLI.
[rest-routes.ts](../../src/transport/rest-routes.ts) owns only the facts HTTP
adds: the method, the path and the inputs it carries, the inputs a route
refuses, and when a success answers 202. Three consumers read that one table:

- the [HTTP service](../../src/transport/http.ts) registers its routes from it;
- the [REST client](../../src/transport/rest-client.ts) behind `--remote` builds
  requests from it;
- [openapi.ts](../../src/transport/openapi.ts) generates `/v1/openapi.json`.

A new operation needs a route entry; creating the HTTP service fails for an
operation without one. An operation whose capability is absent, such as
refreshes, has no route and no description. Hono matches routes in registration
order, so a static path such as `/v1/transactions/totals` must precede a
parameter path it would also match.

## Parsing stays in the transport

The HTTP service reads a route's input strictly: duplicate query keys,
noncanonical integers and booleans, a non-JSON body, and an input sent both in
the path and elsewhere are all `invalid_input`. It then hands the assembled
input to the operation, whose Zod schema validates it as it does for MCP and the
CLI. Hono's own validators accept more: repeated query keys become arrays and
`+json` media types pass. They would weaken this boundary, so routes do not use them.

## The API description

The document combines the route table with each operation's schemas through
Zod's `z.toJSONSchema()`, keeping their field descriptions. Recursive schemas
need a name to become shared components; register one beside `JsonValue` in
openapi.ts when adding another.

JSON Schema carries each input's shape, not Zod refinements: a supported
currency, or a date bound requiring `dateRole`. Those rules stay in Zod and
answer 400; the API reference states them for clients, and the document says
so. Where a declarative constraint expresses a rule, use it instead: totals
declare their two perspectives as an enum, so the document lists exactly the
perspectives they accept.

Every operation route lists its error statuses; only writes, which check
versions and lifecycle state, list 409. The
[tests](../../tests/transport/openapi.test.ts) validate the document as OpenAPI
3.1, compare it with a hand-written route list, check that every documented
route delivers its inputs to its own operation, and pin each route's contract in
a snapshot that leaves schema bodies to Zod.

## Why Hono, without an OpenAPI framework

Fonds's integrations speak the Fetch API: the MCP SDK and Better Auth handlers
take a `Request` and return a `Response`. Hono is a small router and middleware
layer over exactly that. Fastify or Express would need adapters around those
handlers and would not remove the mapping from operations to HTTP. Plain Fetch
handlers would leave routing, middleware order and error handling to Fonds.

`@hono/zod-openapi` and `hono-openapi` generate a document from route
declarations. Those declarations could reuse the catalog's schemas, but the
catalog, MCP, the CLI, scope checks, output bounds and error policy would remain
Fonds code, and the strict parser would still have to guard their validators. They
would replace little beyond `openapi.ts`. Reconsider the framework only for a
concrete runtime incompatibility, a measured bottleneck or a maintenance or
security problem.
