# Documentation

> For every reader. Owns navigation only; [AGENTS.md](../AGENTS.md#sources-of-truth) names each fact's owner.

## Start here

| I want to…                                        | Start here                                                                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Try it without connecting a card                  | [README quick start](../README.md#quick-start-about-10-minutes)                                                                  |
| Connect my own card locally                       | [Use your own data](../README.md#use-your-own-data), then the [CAL](providers/cal.md) or [Isracard](providers/isracard.md) guide |
| Review, categorize and tag transactions           | [Using Fonds with an assistant](guides/using-with-an-assistant.md)                                                               |
| Connect Claude Code or Claude Desktop             | [Local MCP setup](guides/local-development.md#connect-an-mcp-client-locally)                                                     |
| Use my hosted instance from ChatGPT               | [Hosted setup](guides/hosted-service.md), then [ChatGPT connection](guides/chatgpt-connect.md)                                   |
| Keep records current and understand notifications | [Refresh and notifications](guides/using-with-an-assistant.md#refresh-and-notifications)                                         |
| Understand privacy and my responsibilities        | [Your data stays yours](../README.md#your-data-stays-yours) and [security model](security-model.md)                              |

## Reference

| Question                                                                    | Page                                    |
| --------------------------------------------------------------------------- | --------------------------------------- |
| What does the service guarantee, and why is the model shaped this way?      | [Design](design.md)                     |
| What can a client call, and what does each field mean?                      | [API reference](api.md)                 |
| How is data persisted, upgraded and recovered?                              | [Database reference](database.md)       |
| Which API and standards models does the contract follow, and why?           | [Reference models](reference-models.md) |
| What does Fonds protect, and what is the person running it responsible for? | [Security model](security-model.md)     |

## Guides

- [Local development](guides/local-development.md): synthetic quickstart, local authentication and HTTP/MCP clients.
- [Storage backends](guides/storage-backends.md): choose and run SQLite, PostgreSQL or Turso.
- [Hosted service](guides/hosted-service.md): host-neutral configuration, owner login, refresh, scheduling and Events.
- [Docker](guides/docker.md): the SQLite and PostgreSQL images, the compose stack and a quick tunnel.
- [Neon deployment](guides/neon-deployment.md): Neon setup, deployment, native trigger and operations.
- [ChatGPT connection](guides/chatgpt-connect.md): connect and verify your own deployment.

## Providers

- CAL: [guide](providers/cal.md), [source notes](../src/providers/cal/source-notes.md) and [synthetic fixtures](../tests/providers/cal/fixtures/README.md).
- Isracard: [guide](providers/isracard.md) and [synthetic fixtures](../tests/providers/isracard/fixtures/README.md).

## Contributing and internals

[CONTRIBUTING.md](../CONTRIBUTING.md) covers the change workflow and [documentation discipline](../CONTRIBUTING.md#documentation-discipline). [SUPPORT.md](../SUPPORT.md), [SECURITY.md](../SECURITY.md) and the [code of conduct](../CODE_OF_CONDUCT.md) cover help, vulnerability reports and participation.

| Internal reference                                  | Purpose                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| [Repository layout](internals/repository-layout.md) | Module ownership, imports, style and generated artifacts |
| [Acceptance scenarios](internals/acceptance.md)     | Financial behaviors that must remain correct             |
| [Authentication storage](internals/auth-storage.md) | Hosted identity and bridge table inventory and ownership |
| [Storage tests](internals/storage-testing.md)       | Reproduce actual-driver verification                     |
| [Experimental D1](internals/d1-storage.md)          | Maintained experimental adapter; not a deployed service  |
| [Releasing](../RELEASING.md)                        | Cut, verify and recover a release                        |
