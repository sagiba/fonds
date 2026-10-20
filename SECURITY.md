# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, not through a public issue.
Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository (the **Security** tab, then **Report a vulnerability**).

Include what is needed to reproduce it: the affected version or commit, how Fonds
was run (local CLI, SQLite server, Docker, Neon or another host) and the observed
versus expected behavior. Please contact the maintainer privately to coordinate a
reasonable disclosure timeline; disclosure need not wait indefinitely for a fix.

## Supported versions

Fonds is pre-release and has no published releases. Security fixes currently
target `main` only.

## Scope

Fonds holds one owner's financial records and the provider credentials that
collect them. In scope is any way, from outside the deployment's host,
environment and state, to act as the owner or a client without the owner's
authorization, to expose provider credentials (including from a copy of the
database alone), to read or change financial records without a valid grant or
leak them through errors or logs, or to change archived source evidence, or the
record derived from it, without that being recorded. The
[security model](docs/security-model.md) defines these boundaries, the
[known limitations](docs/security-model.md#known-limitations) and what is
[out of scope](docs/security-model.md#out-of-scope).
