# Contributing

Thanks for helping with Fonds. This page covers setup, the change workflow and
what a pull request needs. [AGENTS.md](AGENTS.md) holds the product rules every
change must keep, whether you work by hand or with an AI agent.

> **Never paste real financial data** into an issue, pull request, discussion or
> security report: no transactions, captures, screenshots, logs with financial
> values, credentials or account identifiers. Build a synthetic reproduction
> instead; the committed fixtures are a good starting point.

## Before you start

- Search open issues and pull requests first, to avoid duplicate work.
- Open an issue to discuss substantial changes, and any new provider adapter,
  before implementing them.
- Report security issues privately, as [SECURITY.md](SECURITY.md) describes. Do
  not test against other people's deployments or a provider's infrastructure.
- Outside contributors work from a fork and open a pull request against `main`.

## Set up

Use Node.js 24.11 or newer (pull requests are checked on Node 24; a separate
workflow runs the full check on Node 26 weekly) and install the locked
development dependencies:

```sh
npm ci
```

Fonds is one TypeScript application. Read the [design](docs/design.md) and the
[repository layout](docs/internals/repository-layout.md) before changing module
ownership or adding a package. Develop with the committed synthetic data, and
keep credentials, real captures, databases and transient output outside the
repository.

## Making a change

1. Put code and tests under their existing owner in the
   [layout map](docs/internals/repository-layout.md). Preserve import boundaries.
2. Keep behavior changes separate from mechanical formatting and moves.
3. Add or adjust meaningful tests when behavior changes. A bug fix needs a
   test that fails without the fix. Do not rewrite a golden snapshot merely
   to make a failure disappear. Each test must fail if the behavior it names
   were removed:
   - Write expected values by hand; never compute them with the production
     helper under test.
   - Control the clock for time-dependent rules. Inject atomicity failures
     after earlier writes, then check rollback and retry.
   - Run storage behavior through the
     [backend harness](tests/helpers/storage-harness.ts) unless it is
     driver-specific.
   - Give each scenario one primary layer; repeat it only for a distinct
     integration risk.
   - Pin contractual output and budgets, not incidental text or whole internal
     objects.
4. Identify any changed public contract, user procedure, security limit or
   source interpretation. Update its owner under the documentation rules below.
   Unchanged behavior needs no prose update.
5. Apply automatic fixes, inspect the diff, run focused tests and verify:

   ```sh
   npm run lint:fix
   npm run check
   ```

`check` validates formatting, links, public text, documentation budgets, the
synthetic CAL fixtures, lint, types, tests and the production build. Investigate failures; do not weaken
checks to admit a regression.

For Markdown-only changes, run `npm run format:check`, `npm run check:links`,
`npm run check:public-text` and `npm run check:doc-budget`. Verify edited
commands and paths. Changes to schemas, MCP descriptions or executable examples
also need their affected focused checks. Report unavailable checks explicitly.

The public-text check rejects absolute development paths and any regex listed in
a git-ignored `.public-text-patterns` file. Fix the text, not the allowlist.

## Documentation discipline

- Docs explain consequences, not predicates. Keep public field meanings,
  interaction guarantees, working procedures, rationale and source evidence.
  Keep branch conditions, mappings and regression cases in code and tests.
- Each fact has one owner, identified by AGENTS.md. Link instead of restating.
  A short audience-specific consequence may link to the owner; it must not
  introduce a second table of conditions, constants or exceptions.
- Update only what changed: the owning contract or procedure, affected tests,
  and source evidence when its basis or uncertainty changed. Do not update
  every overview for each implementation change.
- Preserve independent evidence before deleting prose. A passing synthetic
  test does not replace a source label, pinned citation or uncertainty.
- Write current state. Remove superseded directions. Git and release notes
  carry chronology; provenance dates and supported upgrade instructions stay.
- Fixture READMEs describe construction and purpose, not expected-output
  catalogs. Acceptance links obligations to suites and manual release gates.
- Comments explain why, assumptions or caller obligations. MCP descriptions
  are client-facing guidance: retain the information needed to use tools safely,
  but omit implementation recipes and schema field inventories.
- Prefer replacing or deleting text to appending another section. Give each
  substantial page one audience and purpose. Do not split files to hide growth.
- A documentation-budget increase or new page must identify the reader's task,
  the fact it owns and why an existing owner or link is insufficient.

`npm run check:doc-budget` fails when an authored Markdown file's
whitespace-separated token count, tables and examples included, exceeds its
ceiling in [`docs/doc-budget.json`](docs/doc-budget.json), or when a file has no
ceiling there.

## Additional verification by change

| Change                                                                          | Additional verification                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Move modules or change cross-layer imports, dependencies or target entry points | `npm run check:npm`; `npm run check:targets` for experimental targets; exercise affected launchers                                                                                                                                                   |
| Move/rename tests or snapshot-owning suites                                     | `CI=1 npm test`; compare discovered test counts and preserve snapshot contents during a pure move                                                                                                                                                    |
| OAuth login form, headers or redirects                                          | `npm run check`, then a real login through an OAuth client (for example ChatGPT); say in the pull request which client you tested, or that you could not                                                                                             |
| Storage behavior, migrations or declaration validation                          | Relevant `tests/storage/` suites and the affected actual-driver checks in the [storage runbook](docs/internals/storage-testing.md); inspect [artifact maintenance](docs/internals/repository-layout.md#sql-embedded-migrations-and-schema-manifests) |
| Synthetic CAL fixture generation                                                | `npm run check:cal-fixtures`                                                                                                                                                                                                                         |

The workflow files define automated execution. The
[storage runbook](docs/internals/storage-testing.md) gives disposable-service
setup and actual-driver commands. Local checks do not establish browser,
hosted recovery or provider acceptance; report those gates separately.
Dependency changes must preserve manifest/lockfile consistency and
selected-driver deployment isolation. Before distributing an artifact, inspect
its included third-party components and retain their required licenses, notices
and source obligations.

## AI-assisted contributions

AI assistance is welcome. You remain responsible for the whole submission:

- Understand, review and test everything you submit, and make sure you have the
  right to contribute it under the project's license.
- Briefly disclose material AI assistance in the pull request. AI-drafted text is
  fine once you have reviewed it; disclosure never stands in for correctness.
- Do not paste prompts or transcripts, and do not add agents as commit
  co-authors.
- Agents never push to `main`, merge pull requests or publish releases.

## Pull requests

Use the [pull request template](.github/pull_request_template.md). Explain the
concrete problem, the resulting behavior and the relevant tradeoffs. List the
commands you ran and their results, and any checks you skipped and why. Call out
contract, migration, dependency and security-relevant changes. Pull requests
merge by squash once the required checks pass.

## License

Fonds is licensed under [Apache-2.0](LICENSE). By submitting a contribution you
agree that it is licensed under the same terms (section 5 of the license) and
confirm that you have the right to submit it. There is no separate contributor
agreement or sign-off requirement.
