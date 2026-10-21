# Fonds

**Stay on top of your card transactions with your AI assistant.**

Fonds refreshes transactions from supported card providers and connects them to
your assistant. Get notified about new activity, review your charges, categorize
and tag them, and add context you can use later. It currently supports Israeli
credit cards, CAL and Isracard; the core is provider-independent, and
contributions for other providers are welcome.

Run it yourself. Your transactions and saved context stay in Fonds, available to
assistants, scripts and other tools connected to the same installation.

## What can I do with it?

Keep up with transactions as they arrive, rather than sorting through a
statement each month:

1. **Get notified.** A compatible assistant can bring new activity to your attention.
2. **Review the charges.** "Show me the latest transactions. Let's go through them."
3. **Organize them.** "Categorize this as business travel, add the tag
   reimbursement, and note which client meeting it was for."
4. **Record your decision.** "I've checked this charge; mark it approved."
5. **Come back to the context.** Another connected client can retrieve the same
   saved note, tags and review status, without the original chat. Refreshing
   does not overwrite them.

These are requests you make, not automatic rules, and need write access.
Notifications need scheduled refresh and a compatible host
([refresh and notifications](docs/guides/using-with-an-assistant.md#refresh-and-notifications)).
The [assistant guide](docs/guides/using-with-an-assistant.md) has more examples,
including totals by currency and checking a receipt in a separate inbox.

## Who can use it today?

Fonds is for people comfortable running their own software. It is pre-release:
the API may change, and earlier database layouts require explicit
[recreation](docs/database.md#migrations). There is no ready-made budgeting UI,
payment processing or bank-account integration; you bring your own assistant or
client. CAL supports local and hosted refresh, including opt-in schedules;
Isracard supports local refresh through the CLI, and its hosted refresh is
unverified. Each provider guide ([CAL](docs/providers/cal.md),
[Isracard](docs/providers/isracard.md)) says what is collected and what totals
count.

## Get started

- **ChatGPT desktop, Claude Code or Claude Desktop with sample data:** the quick start below.
- **ChatGPT web:** run a hosted instance with
  [Docker](docs/guides/docker.md) or [Neon](docs/guides/neon-deployment.md), then
  follow the [ChatGPT connection guide](docs/guides/chatgpt-connect.md).
- **Containers:** the [local Docker image](docs/guides/docker.md#sqlite)
  needs no Node install; a [quick tunnel](docs/guides/docker.md#quick-tunnel)
  gives temporary hosted access.

### Quick start (about 10 minutes)

You need Node.js 24.11 or newer. The demo uses invented data only; no provider
account is needed.

```sh
npm install --global fonds-finance
fonds demo
```

`demo` creates a separate private ledger of synthetic CAL transactions and prints
what to run next, including setup for ChatGPT desktop, Claude Code and Claude
Desktop. Follow your client's snippet, restart the client,
and check its MCP connection status. Ask "What are my totals by currency in
fonds-demo?". The client starts Fonds over stdio; no HTTP server is needed.
The [local guide](docs/guides/local-setup.md) covers source installation,
client setup and troubleshooting. ChatGPT desktop uses the same local Codex host's
MCP configuration; ChatGPT web has a separate hosted path.

### Use your own data

For the local CAL path, read [Your data stays yours](#your-data-stays-yours) and
the [provider guide](docs/providers/cal.md) first. Then:

```sh
fonds init --connection my-cal --provider cal
fonds connect --connection my-cal
fonds refresh --connection my-cal
fonds mcp-config
```

These use your private default ledger. Copy your client's setup from
`mcp-config`. The [local guide](docs/guides/local-setup.md#add-provider-logins)
covers adding more CAL or Isracard logins to that ledger; provider guides cover
credentials and collection windows. Back up the database and its
[state directory](docs/database.md#state-directory-and-backup) together.
`fonds --help` lists commands.

## Your data stays yours

Fonds is software you run yourself: on your laptop, a home server, or a host
you choose, such as Neon. The project doesn't host it for you or receive your
transactions or provider credentials.

Credentials saved with `connect` are encrypted, with the key kept outside the
database; you can also supply them through your host's secrets or environment, or
for one local refresh. Encryption doesn't hide them from the host running Fonds,
and your hosting and database providers can access what you put on their systems.

Only saved credentials are encrypted. Financial records and archived responses
are stored as plain data; login bodies are not stored, but archives can still
contain holder data. Provider account keys are never returned, and holder data
only where a provider guide maps it. See the
[security limitations](docs/security-model.md#known-limitations) and
[personal-data handling](docs/design.md#personal-data).

Whatever a connected assistant reads goes to its provider under that service's
terms. You choose those connections and look after your installation's security
and backups, including its keys and state.

## How Fonds talks to your card provider

Fonds signs in to CAL's and Isracard's internal web APIs with your login. These
aren't supported public integrations, and the providers haven't promised to keep
them working.

- **Things can change.** Provider updates can break refreshes, and a fix may
  take time or may not be possible; each provider guide lists current limitations.
- **Access can be interrupted.** Providers may ask for extra verification, limit
  requests or block access. Login failures or challenges stop refreshes until you
  intervene and explicitly retry. Use only your own accounts. Automated access may
  violate your provider's terms or lead to access restrictions; check the terms
  that apply to your account before refreshing.
- **Double-check what matters.** Fonds leaves facts the source does not state
  unknown. Check your provider's own records before a financial decision.

Fonds is independent and isn't affiliated with or endorsed by the providers,
hosting services or AI products named here.

## For developers

Fonds is one TypeScript service with a provider-neutral core. SQLite and
PostgreSQL are the supported backends; Turso/libSQL and D1 are experimental
([storage guide](docs/guides/storage-backends.md)). The
[documentation index](docs/README.md) leads to every guide and reference,
including the [design](docs/design.md), [API](docs/api.md) and
[database](docs/database.md) references; [CONTRIBUTING.md](CONTRIBUTING.md)
covers setup, checks and contribution conventions.

## Why the name?

In archival terminology, a _fonds_ is the complete body of records of a person or
organization, preserved with its original context and provenance. Fonds keeps
source evidence and corrections, and your notes, categories and review decisions
stay separate from provider facts.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Report security issues
privately as described in [SECURITY.md](SECURITY.md).
