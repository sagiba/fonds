# Analyzing captures

> For the agent analyzing a capture, and the owner answering its questions. Owns the analysis method. Findings belong in the provider's source notes.

The goal is an endpoint map, a disposition for every observed field and a short list
of questions only the owner can answer. Label every claim by source: observed,
public frontend, owner-labelled, inference or unknown. The project's own guide is
not evidence, and neither is a synthetic fixture.

## Start with the profiler

[`scripts/har-profile.mjs`](../../../../scripts/har-profile.mjs) prints structure, not
values. Its masking of paths and field names is a heuristic, not a privacy boundary:
a JSON key can embed a national ID, and it catches digits and opaque tokens but not a
name. So **the owner runs it and reads the output before sharing it** with the agent.
The output is still derived from real data, so keep it private.

```sh
node scripts/har-profile.mjs endpoints /private/capture.har
node scripts/har-profile.mjs shape /private/capture.har /GetTransactions
node scripts/har-profile.mjs shape /private/capture.har /GetTransactions --codes kind,currency
```

`endpoints` lists rows in first-seen order, so the login flow reads top to bottom,
with status, content type and whether authorization or cookies were sent. `shape`
reports request and response fields as `path  present/total  classes`.
`--codes` counts the values of named fields, printing booleans, null and values of
up to three characters. Name only code fields; never name a card or identity field.

## What to look for

Work through these in order. Each has found a real defect or wrong assumption in an
existing adapter.

1. **Classify endpoints** as authentication, discovery, financial, summary or
   telemetry. Hosts that appear only as `CONNECT` were not decrypted. Ignore
   marketing calls, but note anything financial you did not expect.
2. **Find the real source.** A dashboard list is a preview. Before designing around
   an endpoint, ask what screen would show everything, and capture that.
3. **Read the envelope.** Learn how the provider signals success, failure and
   "no data", separately. HTTP 200 can carry an application error, and success
   proves neither completeness nor absence. Record exact empty shapes; a looser
   rule accepts shapes nobody has seen.
4. **Note protocol quirks exactly.** Key spelling can differ by case between the
   response and the next request, and content types can be mislabeled. Parameters
   you did not see in a request do not exist; never invent a date range or cursor.
5. **Compare schemas, not statuses.** Posted and pending rows can be unrelated
   schemas. Rows from different eras can differ too. A short recent capture is a small
   sample; run final analysis across all available history.
6. **Join generations.** Where two APIs cover the same rows, join them and diff
   the row sets and amounts. Disagreements expose the real structure.
7. **Diff repeat captures** to find volatile fields: request IDs and session GUIDs
   that change every login cannot be identity, and must be excluded from change
   detection.
8. **Enumerate exact categorical combinations,** separately for posted and pending,
   before writing any classification. They are usually few. Cardinality is a filter,
   not a verdict, and a constant or empty field is not automatically noise.
9. **Check the arithmetic.** Test field-to-field equations and statement totals
   against rows. These checks find more than field profiles do, including
   misnamed fields and lines wrongly dropped as artifacts.
10. **Read free text.** Rates, fees and installment counts can exist only in comment
    templates while the dedicated field stays blank. See the masked pass below.
11. **Compare real pending and posted pairs** field by field before proposing a link
    rule. Expect no shared ID, differing timestamps and truncated names.
12. **Read the public frontend.** It shows request flags, what is rendered and
    whether the client truncates. Pin the bundle's hash in source notes. It proves
    client behavior, never server guarantees.

Before saying a question is blocked on missing evidence, test that claim against
the full archive, free text included.

## When the profiler is not enough

The profiler sees shape, not meaning. It cannot see a count stated in a comment, and
text comparison calls zero-padded IDs different. Write a throwaway script outside
the repository for the owner to run, aggregating before it prints:

- Replace every digit with `9` and count distinct text templates. Templates still hold
  names and merchants, so they are for the owner's eyes: the owner passes on only
  provider-defined wording, with invented values.
- Print counts and booleans for joins and equations, never rows.
- Count identifying categories without naming them: the currencies on a card reveal
  travel.
- Check a query against every era's shape before reporting a fact from it.

For archives already in Fonds, start from the value-free
[Isracard](../../../../tests/providers/isracard/scripts/audit-isracard-db.ts) and
[CAL](../../../../tests/providers/cal/scripts/audit-cal-db.ts) profilers.

## Ask the owner row by row

Aggregate questions mostly come back unknown. For each unexplained combination, have
the script pick one representative row, tell the owner how to find it, and ask what
that purchase actually was. A few such answers can dissolve a supposed contradiction
or show that two concepts, such as wallet and channel, are independent. Owner
answers are evidence for that example, never a merchant-specific rule.

## Record dispositions

Give every observed path one disposition: mapped, retained unmapped, excluded as
noise, excluded as personal data, or not understood. These are different states, and
"not understood" is not "noise". Once raw bodies are
[released](../../../../docs/design.md#collection-and-evidence), anything unretained
is gone, so keep transaction facts even when unmapped.

Record observed facts, rationale, unknowns and the tests that check them in
`src/providers/<provider>/source-notes.md`, following the existing `Observed`,
`Policy`, `Unknown` and `Checks` shape. Private counts stay private.
