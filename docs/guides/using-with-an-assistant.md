# Using Fonds with an assistant

Workflows for reviewing, organizing and asking about transactions through an
assistant; Fonds can also be used directly through its HTTP API or CLI. Start with
the [sample-data demo](../../README.md#quick-start-about-10-minutes). For your own
records, follow the [local setup](../../README.md#use-your-own-data) or
[hosted ChatGPT setup](chatgpt-connect.md). Keep provider logins and keys out of
chat; enter them through the documented setup flow.

## Review and organize transactions

A [notification host](#refresh-and-notifications) can prompt a review, or you can
start one yourself. Select a specific transaction before asking the assistant to
change it:

- "Show my five most recent transactions with merchant, date, amount, currency
  and status. Let's review them."
- "Categorize this as business travel."
- "Add the tag reimbursement and keep its existing tags."
- "Add a note: taxi to the Example Co client meeting."
- "I've checked this charge; mark it approved."
- "I don't recognize this one yet. Mark it as needing review."
- "Read back its category, tags, note and review status."

These are changes you request, not automatic categorization, and the client
needs write access. Ask it to read the annotation back after a write; a
conversational acknowledgment alone is not proof it was stored. Tags and notes
help you identify an expense later; Fonds does not submit expense claims or pay
reimbursements, and annotations do not change the provider's charge amount.

Fonds has no server-side category/tag filters or category totals. Clients that
group records themselves must retrieve the relevant pages and handle completeness
and money correctly.

## Ask about your spending

- "Which transactions are still pending?"
- "What are my totals by currency for purchases this month? Explain the date
  range and what is excluded."
- "When did this connection last refresh successfully?"

Ask for the scope and missing information, not just a number. A query reads the
records already in Fonds; it does not contact the provider. A recent successful
refresh does not establish that every historical transaction is available.
Provider coverage, unknown amount roles and pending charges can affect totals.
Do not combine different currencies without an explicit conversion method.

## Retrieve saved context elsewhere

Another authorized client connected to the **same Fonds installation** can
retrieve a transaction and its annotation without the first conversation;
separate installations or copied databases do not synchronize. Annotations are
stored separately from provider facts, and refreshing does not overwrite them. A later change to a financial fact can make
a review stale, and an uncertain pending-to-posted match may need review rather
than an assumed link. The [annotation reference](../api.md#annotations) describes
version checks and undo.

## Refresh and notifications

These are separate capabilities:

- **Read:** ask about data already in Fonds.
- **Refresh:** use `refresh_connection` on a supported runtime with stored
  credentials to update a connection from its provider. This contacts the
  provider and may require intervention if authentication fails.
- **Schedule:** explicitly enable scheduled refresh and keep the service available.
- **Notify:** connect a host that supports Fonds's draft MCP Events/webhook
  integration and actually subscribes. Adding an MCP server alone does not
  enable notifications.

A client checks a refresh's outcome with `get_connection`. The operator CLI calls
the same live refresh `collect`, and scheduler settings use the
`FONDS_COLLECTION_` prefix.

A notification says records changed. The receiving assistant or application
must fetch and interpret them: a change may be a new transaction, a correction
or an annotation, not necessarily another purchase. Notification timing depends
on refresh and delivery schedules, not the time you used your card.

Local stdio clients can read, annotate and refresh, but cannot create Events
subscriptions. See [local refresh and Events](local-development.md#refresh-and-events-on-the-server)
and [hosted delivery](hosted-service.md#mcp-events-and-webhook-delivery), including
how often each host delivers, for the actual requirements and limitations.

## Optional: investigate a charge with email

Suppose two charges from "Example Delivery" turn out to be a membership and a
meal (an invented example, not part of the demo dataset).

1. Ask your assistant to find the two transactions in Fonds and show their
   details.
2. With email connected separately, ask it to look for receipts around the dates
   and compare merchant, amount and currency.
3. Ask it to explain the match and distinguish a confirmed receipt from a
   possible match. A similar merchant name alone is not proof.
4. If you want to keep the explanation, ask it to save a note on the specific
   transaction in Fonds, then read the transaction back to verify it.

Fonds does not search your inbox or match receipts. The assistant needs separate
email access, and its conclusion is only as good as the evidence it finds.

## Know what reaches your assistant

Provider credentials are not exposed through Fonds's MCP operations. Transaction
details the assistant reads do reach its provider, and email access has its own
permissions and data flow. You remain responsible for your host, database,
backups and client access. Read [Your data stays yours](../../README.md#your-data-stays-yours)
before connecting real accounts.
