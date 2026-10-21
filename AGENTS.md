# Fonds agent guide

Read this before changing Fonds. Setup, verification and pull requests are in
[CONTRIBUTING.md](CONTRIBUTING.md).

**This repository is public.** Everything you commit is published: code,
documentation, fixtures, comments, commit messages, and issue and pull request
text.

## What Fonds is

Fonds is a self-hosted personal financial evidence ledger. Provider adapters
(currently CAL and Isracard) collect card transactions; Fonds keeps the source
evidence, maintains a canonical ledger with owner annotations and serves it over
REST, MCP and a CLI. Each deployment has exactly one owner. Local use runs on
SQLite; the hosted service runs on any Node host with PostgreSQL.

## Sources of truth

- [Documentation](docs/README.md) is a navigation index, not collectively
  a second implementation specification.
- [Design](docs/design.md) owns product boundaries and shared correctness
  invariants. [API](docs/api.md) owns public meanings and client-visible
  behavior. [Security](docs/security-model.md) owns guarantees and limits.
- Operation definitions, executable input/output schemas and transport
  registration own exact interfaces. Keep the API's human reference useful;
  do not hand-copy implementation predicates into it.
- Provider code owns extraction and collection rules. Independent synthetic
  tests own expected outcomes and counterexamples. Expected values must not
  be derived from the production code being tested.
- Source evidence, interpretation rationale and uncertainty belong beside
  the relevant code or in `src/providers/<provider>/source-notes.md`.
  Synthetic fixtures demonstrate behavior; they do not prove issuer semantics.
- Versioned migrations own application SQL structure. Executable schemas own
  stored document shapes. Database documentation owns persistence explanation,
  compatibility and recovery; generated references are derived artifacts.
- Provider guides own setup, capabilities, limitations and recovery actions.
  Fixture READMEs own construction, fixture purposes and check commands.
  Acceptance documentation indexes obligations, executable suites and manual
  release gates; it does not narrate individual regression cases.
- Repository layout owns module responsibilities and artifact maintenance.
  CONTRIBUTING owns the change workflow and documentation discipline.
- Investigate disagreements using intended contracts, source evidence, code
  and independent tests. Passing tests alone do not establish correctness.
  Change an intended contract explicitly; otherwise fix the implementation.
- [Reference models](docs/reference-models.md) records naming rationale and
  external precedents; the API owns the resulting public conventions.

## Financial correctness spine

Read the [design invariants](docs/design.md) before changing money, evidence
retention, identity, reconciliation, totals, annotations or lifecycle behavior.
Changes to these guarantees require adversarial tests and an independent
review when available. Exact provider predicates belong in code and tests;
their justification belongs in source notes. Do not reproduce them here.

Two rules apply to all code:

- Money is exact: integer minor units internally, decimal strings on the wire,
  explicit currency and amount basis. Never guess an amount, rate, role or
  relationship the source does not state; `null` means unknown.
- The core is provider- and country-neutral. Source-specific names belong in
  adapters, provider guides and fixtures.

## Data and live operations

- Commit only invented data. Never commit or paste real captures, credentials,
  tokens, account or card identifiers, screenshots, HAR files, database copies or
  statistics derived from real financial data, including "redacted" copies.
- Provider credentials never enter prompts, MCP inputs or results, logs or
  committed files.
- Collect only from accounts you own and are authorized to use.
- Deploying, querying a production database, running live collection and
  creating or deleting real financial records each require an explicit request
  from the person you are working for, covering that specific action.
- Keep scratch files outside the working tree, in the system temporary directory.

## Security model

[SECURITY.md](SECURITY.md) and the [security model](docs/security-model.md) define
what Fonds protects: owner authentication, OAuth grants and scopes, the
credentials boundary, outbound requests and webhooks. When reviewing, separate
vulnerabilities from documented limitations and deployment hardening. A
documented limitation never excuses a new exploit.

## Architecture and style

- Follow the [module ownership and import rules](docs/internals/repository-layout.md).
  Do not bypass enforced boundaries with barrels or dynamic imports.
- Follow the repository formatter, lint configuration and naming conventions.
- SQLite and PostgreSQL are required targets. Experimental-target capabilities
  are listed in the [storage guide](docs/guides/storage-backends.md).
- Keep one TypeScript service; add no speculative framework or layer.

## Verification

Follow the verification steps and change-specific gates in
[CONTRIBUTING.md](CONTRIBUTING.md#making-a-change). Changes to the correctness
spine also need adversarial tests.

## Agent contribution discipline

- Back claims with file/line references or a reproducible command. Report only
  checks and independent reviews actually performed; state what was unavailable.
- For changes to the correctness spine or security, get a fresh independent
  review when available: give the reviewer the requirements, not your suspicions.
- Follow [documentation discipline](CONTRIBUTING.md#documentation-discipline).
  Before editing prose, identify its reader, owning fact and changed consequence.
- Do not add prose merely because a test or implementation branch was added.
  For an existing behavior change, normally edit at most its owning
  user-consequence passage and an evidence note if the evidence changed.
  New contracts, procedures or security limits may need more; explain why.
- Never copy a predicate into design, API, acceptance, fixtures and comments.
  Do not manufacture a documentation diff for a behavior-preserving refactor.
- Keep comments for rationale, assumptions, provenance and caller obligations.
  Do not translate the following code into English.
- Never add conversation, prompt, review-round or implementation chronology to
  source, documentation, commits or pull requests.
- Preserve unrelated work and stage explicit paths. Follow CONTRIBUTING's
  AI-assistance and verification requirements.
