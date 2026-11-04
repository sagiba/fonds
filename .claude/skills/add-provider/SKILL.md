---
name: add-provider
description: Add a new bank or card provider to Fonds, or a new endpoint to an existing one. Use for capturing and analyzing provider traffic (HAR files, Proxyman, mitmproxy, DevTools), building synthetic fixtures, writing collectors and mappings, and deciding whether a private provider API is a viable source.
disable-model-invocation: true
---

# Add a provider

> For agents and contributors adding a provider. Owns the procedure, its gates and the failure modes it exists to prevent. Contracts stay with their [owners](../../../AGENTS.md#sources-of-truth).

Read [AGENTS.md](../../../AGENTS.md), the
[design invariants](../../../docs/design.md) and both existing providers'
source notes ([CAL](../../../src/providers/cal/source-notes.md),
[Isracard](../../../src/providers/isracard/source-notes.md)) first. They are the
worked examples; this page does not retell them.

## Rules for the whole job

- **The owner operates; the agent analyzes.** Capturing, logging in and live
  collection are the account owner's, each on an explicit request covering that
  action. Collect only from accounts you own.
- **Real data never enters the agent's context.** Whatever an agent reads goes to
  its model provider. Never open a HAR, archive or credentials file with a file
  tool, `cat`, `jq` or `grep`. The owner runs [the profiler](references/analysis.md#start-with-the-profiler)
  and checks its output before sharing it.
- **Nothing derived from real data is public,** including counts, merchants,
  statistics and "redacted" rows. Field names, code mappings and their rationale
  may go in source notes; analysis output stays in a private location.
- **State scope first:** which provider, which products, which surfaces, and
  whether shared code should change. A provider PR that changes shared planners
  changes existing providers too, so report that diff separately and put semantic
  changes to the owner.
- **Ask whether a live call adds information.** If an archive can answer, use it.

## Procedure

| Step | Do                                                                                   | Produces                                  |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| 1    | Open an [issue](../../../CONTRIBUTING.md#before-you-start) and survey public sources | Candidate routes and a list of questions  |
| 2    | Pass [gate 1](#gate-1-is-this-source-viable)                                         | The owner's recorded decision             |
| 3    | [Capture](references/capture.md), owner only                                         | Private HAR files and a private note      |
| 4    | [Analyze](references/analysis.md) through the profiler                               | Endpoint map, dispositions, question list |
| 5    | [Prove the minimal flow](#prove-the-minimal-flow), owner only                        | The smallest working request sequence     |
| 6    | Pass [gate 2](#gate-2-design-before-code)                                            | A reviewed design                         |
| 7    | [Fixtures, mapping and collector](references/implementation.md)                      | Code, synthetic fixtures and tests        |
| 8    | [Verify and accept](#verify-and-accept)                                              | CI results and live acceptance            |

### Survey before capturing

Read existing open-source collectors and the provider's public web bundle. Treat a
scraper's steps as what someone once got working, not as requirements: mandatory-looking
pre-steps often turn out to be unnecessary, and normalized scraper output drops
evidence Fonds needs. Check whether the provider offers an official export or an
open-banking route. List every API generation you find, because generations
can coexist and each may hold rows or cards the other lacks.

### Gate 1: is this source viable?

The owner decides, and the issue records the decision before any transport work.
Answer: does a direct API route exist for this account, and does it need anything
beyond ordinary authenticated requests?

**Stop and hand the decision to the owner** when the provider presents a CAPTCHA,
a challenge, device attestation or a block on non-browser clients. Do not solve or
work around it on your own initiative, and do not reword a request after an
automated safety check stops the work. Options for the owner, cheapest first:

1. Another surface the provider offers for ordinary authenticated access, such as
   its mobile app, provided it works without defeating the block.
2. An official export, as a manual import source.
3. An open-banking route through a licensed aggregator.
4. Dropping the provider.

This skill deliberately gives no recipe for passing a provider's bot defenses.
Whatever is chosen, a challenge at runtime stops collection and surfaces as a
typed failure; Fonds never retries through it.

### Prove the minimal flow

The owner runs a throwaway proof outside the repository, reading credentials from a
private file and writing only to an owner-only directory, and reports status codes
and counts.

- Remove steps one at a time to find the smallest sequence: login, discovery,
  one financial request. Fresh session each time.
- A proof covers only the exact request exercised. A client that passes a `GET`
  of the login page proves nothing about the login `POST`.
- Triage blocks with credential-free probes first, so an edge block is never
  mistaken for a bad password. One failed password can change how the account
  behaves; never retry one.
- Space requests widely and stop at the first rate limit. Observed spacing is not
  a published quota.
- Test from the network that will run it. A residential proof says nothing about
  cloud egress.

### Gate 2: design before code

Write down, and get an independent conceptual review of:

- **Capture unit:** what one capture is, and which responses it combines.
- **Identity:** which source fields identify a row, across logins and between
  pending and posted, and what happens when they are absent.
- **Coverage:** what each endpoint's window means, and what absence can prove.
  Default to proving nothing.
- **Retention:** the fate of every observed field. The
  [personal-data rules](../../../docs/design.md#personal-data) come first and are not
  negotiable here. Within them, ask the owner field by field before building any
  redaction; the owner may value what you would strip.
- **Request budget:** cards × months × endpoints, against the observed limit.
- **Unknowns:** what stays `null` or raw until evidence exists.

Then check open issues against current code; a stale issue can justify work that
already shipped.

## Verify and accept

Follow the [change verification](../../../CONTRIBUTING.md#making-a-change). Provider
work touches the correctness spine, so it needs adversarial tests and a fresh
independent review given the requirements, not your suspicions. Have reviewers
reproduce each finding: a plausible finding can be false, and its fix a regression.

Keep a stopping rule. When consecutive review rounds find the same class of bug,
stop patching: redesign, or state a limitation and hold the new provider to the
bar the existing ones meet. Requirements stricter than that bar breed machinery.
If the machinery grows, first ask whether a better source would remove it.

Offline suites cannot see live failures. With explicit owner authorization:

1. Compare live shapes with the fixtures, as the
   [manual release gate](../../../docs/internals/acceptance.md#manual-release-gates) requires.
2. Refresh, then refresh again on a fresh login: the second run must create nothing.
3. Replay the archive into a fresh ledger after any parser change, and diff the
   value-free result. Identity must not move.
4. Reconcile one authoritative statement under a stated amount and date basis.
5. Report separately what this did not cover, such as hosted runs.

Verify runs by effect, not exit code: a command can exit 0 having sent nothing.

## Finish

Register the provider, add its [provider guide](../../../docs/providers/isracard.md)
and source notes in the existing shape, link them from the
[documentation index](../../../docs/README.md), and give each new page a
[budget ceiling](../../../docs/doc-budget.json). Details that exist only in tool
output die with the session, so move exact formats into source notes or a spec, then
have a fresh agent cold-read it.
