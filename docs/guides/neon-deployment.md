# Neon deployment and operations

Neon Functions/PostgreSQL is one host for the [hosted service](hosted-service.md),
and the recommended free one: its managed Google sign-in needs no OAuth client.
This guide covers only Neon's setup, deployment, native trigger and operations;
login, collection, refresh and Events behave as the hosted-service guide
describes. Follow the [new installation](#new-installation) steps once, then
[update the deployment](#update-an-existing-deployment) for later releases. Each
installation uses its own Neon project, and one Function declared in
[neon.ts](../../neon.ts). The setup, deploy and smoke commands in
[package.json](../../package.json) never belong in a model's tool inputs.

## Owner login and authorization

Neon's default owner login is **Google through the managed Neon Auth bridge**:
the configured Google email and account bind once to the sole Fonds owner
([admission](../security-model.md#admission)), and passkeys and login links
work as on every host
([owner login](hosted-service.md#owner-login-and-authorization)). Neon's shared
Google app needs no OAuth client of your own, but Neon labels shared
credentials for development and testing and recommends owned ones for
production branding and control
([managed Google setup](https://neon.com/docs/auth/guides/setup-oauth)). The
bridge exists because Neon Auth cannot be the MCP issuer while its
OAuth-provider plugin is unavailable; once it is, Better Auth `genericOAuth`
can replace the bridge.

The Function sees no connection address, so auth rate limits key on the
right-most `X-Forwarded-For` entry
([client address](hosted-service.md#client-addresses)), or none if it is
missing or not a bare IP address. Whether Neon's ingress
sets that entry is [unverified](../security-model.md#known-limitations): confirm
it on a real deployment, with the owner's authorization, before relying on the
limit.

### Owner sign-in and recovery

On Neon, a login link comes from the operator's laptop:

```sh
npm run neon:setup -- login-link --env-file "$FONDS_ENV" \
  --project-id PROJECT_ID --branch-id BRANCH_ID --profile PROFILE
```

It reads the existing private env file (run setup first) and connects with the
[CLI profile](#neon-cli-profile) as setup does. Use the link as the
[hosted-service guide](hosted-service.md#owner-login-and-authorization) describes.

## Neon CLI profile

Every command here runs the pinned Neon CLI, `npx --yes neon@8.4.3`, with
`--profile PROFILE`: a Neon CLI profile on the operator's machine authenticated
for the account or organization that owns the project. Create one once, with a
browser sign-in or an existing Neon API key read from standard input:

```sh
npx --yes neon@8.4.3 login --profile PROFILE             # browser sign-in
npx --yes neon@8.4.3 profile create PROFILE --api-key -  # or an API key on stdin
npx --yes neon@8.4.3 profile list
```

Pass `--profile PROFILE` explicitly to every command in this guide.
`npm run neon:setup` refuses to run without it; other commands would otherwise
fall back to the CLI's `NEON_PROFILE` or default profile. Setup and the login
link use it to fetch the database connection string in memory. Keep API keys out
of the env file, the repository, shell history and model context.

## Private env file

Deployment configuration is the committed [`neon.ts`](../../neon.ts) plus one
private env file outside Git:

```sh
FONDS_ENV=/absolute/private/neon.env
```

| Variable                                                 | Source                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `FONDS_PUBLIC_ORIGIN`                                    | The Function URL's origin (printed by `neon functions get fonds` after the first deploy)  |
| `FONDS_NEON_GOOGLE_AUTH_URL`                             | The branch's managed Neon Auth URL                                                        |
| `FONDS_GOOGLE_OWNER_EMAIL`                               | The single allowed Google email                                                           |
| `FONDS_AUTH_SECRET`                                      | Generated once by setup; signs Better Auth state                                          |
| `FONDS_OWNER_ID`                                         | Generated once by setup; the sole Fonds owner ID                                          |
| `FONDS_COLLECTION_CONNECTION_ID`                         | Explicit stored connection ID (examples use `primary`)                                    |
| `FONDS_COLLECTION_PROVIDER`                              | Provider ID from the runtime composition, currently `cal` or `isracard`                   |
| `FONDS_COLLECTION_SECRET`                                | Generated once by setup; bearer for the operator collect route                            |
| `FONDS_COLLECTION_SCHEDULE`, `FONDS_COLLECTION_TIMEZONE` | Optional [schedule](hosted-service.md#scheduling); scheduled collection is off without it |
| `FONDS_COLLECTION_TIME`                                  | Generated once by setup: this installation's random `HH:MM`; set it only to pin the time  |

The file is this installation's [state](../database.md#state-directory-and-backup):
setup binds the database to its secrets, and the Function and the login link
refuse any other database. Treat the whole file as a secret: an owned regular
`0600` file in an owned `0700` directory outside the repository. Do not print it
or read it into model context. Rotating `FONDS_AUTH_SECRET` or `FONDS_OWNER_ID`
invalidates grants or the owner mapping and needs a separate tested procedure.
The Function also receives Neon's injected `DATABASE_URL_UNPOOLED`; the target
parses all variables once at startup and logs only variable names when invalid.

Provider credentials are never in the env file. They live in a separate private
JSON object, with the fields the selected [provider guide](../README.md#providers)
lists, and are uploaded only when `FONDS_COLLECTION_CREDENTIALS_FILE` names it
during [deploy](#deploy). The Function receives `FONDS_COLLECTION_CREDENTIALS`
and validates it with that provider's schema without logging values; verify its
presence by variable name only
([environment semantics](https://neon.com/docs/compute/functions/environment-variables)).

## New installation

A placeholder deploy creates the Function so its URL can go into the env file
before setup and the real deploy. Run every command from the repository root,
after `npm ci`, replacing `PROFILE`, `YOUR_ORG_ID`, `PROJECT_ID`, `BRANCH_ID`
and `FUNCTION_ORIGIN` with your own values.

1. Find your organization ID, create the project (`--no-secrets` keeps
   connection credentials out of the output), note its project ID, and find the
   default branch's ID:

   ```sh
   npx --yes neon@8.4.3 orgs list --profile PROFILE -o json
   npx --yes neon@8.4.3 projects create \
     --name fonds --org-id YOUR_ORG_ID \
     --region-id aws-eu-central-1 --cu 0.25 --no-secrets --profile PROFILE -o json
   npx --yes neon@8.4.3 branches list --project-id PROJECT_ID --profile PROFILE -o json
   ```

   Choose the region closest to you; `aws-eu-central-1` is an example.

2. Enable managed Neon Auth on that branch. Its Auth URL becomes
   `FONDS_NEON_GOOGLE_AUTH_URL`:

   ```sh
   npx --yes neon@8.4.3 neon-auth enable \
     --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE
   ```

3. Create the Function with a first deploy. `neon.ts` requires its variables
   before the env file exists, so give this one run placeholders in the
   environment:

   ```sh
   env FONDS_PUBLIC_ORIGIN=https://placeholder.invalid \
     FONDS_OWNER_ID=placeholder FONDS_AUTH_SECRET=placeholder \
     FONDS_COLLECTION_SECRET=placeholder FONDS_COLLECTION_CONNECTION_ID=primary \
     FONDS_COLLECTION_PROVIDER=cal FONDS_NEON_GOOGLE_AUTH_URL=https://placeholder.invalid \
     FONDS_GOOGLE_OWNER_EMAIL=owner@example.invalid \
     npm run neon:deploy -- --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE
   ```

   This deploy uploads no provider credentials and sets no schedule, so the
   `cal-hourly` trigger is created disabled. The placeholder Function answers
   every request with 503 (its Neon Auth URL is not the `https://….neon.tech`
   URL [function.ts](../../deploy/neon/function.ts) requires) until the real
   deploy in step 8. Confirm that the deploy reports success before going on.

4. Read the Function's URL. A deploy's text output lists it under "Function
   URLs" when the apply reports it; this command prints it as `invocation_url`:

   ```sh
   npx --yes neon@8.4.3 functions get fonds \
     --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE -o json
   ```

   `FUNCTION_ORIGIN` below is that URL's origin: its `https://` scheme and host,
   without a path.

5. Trust that origin for managed Auth redirects, then confirm it appears in the
   branch's Neon Auth trusted domains:

   ```sh
   npx --yes neon@8.4.3 neon-auth domain add FUNCTION_ORIGIN \
     --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE
   ```

6. [Configure managed Google and the password policy](#configure-managed-google-and-password-policy).

7. Create the [private env file](#private-env-file) with the five variables setup
   does not generate: `FONDS_PUBLIC_ORIGIN` (the `FUNCTION_ORIGIN`),
   `FONDS_NEON_GOOGLE_AUTH_URL`, `FONDS_GOOGLE_OWNER_EMAIL`,
   `FONDS_COLLECTION_CONNECTION_ID` and `FONDS_COLLECTION_PROVIDER`. Create its
   directory with mode `0700` and the file with mode `0600`, for example under
   `umask 077`.

8. [Set up the schemas and the owner](#set-up-schemas-and-the-owner), then
   [deploy](#deploy) again with the env file and the provider credentials file,
   run the [smoke check](#verification-and-client-connection) and
   [sign in as the owner](#owner-sign-in-and-recovery). Collection stays off
   until you [turn the schedule on](#native-scheduled-collection).

## Configure managed Google and password policy

Managed Neon Auth enables shared Google by default. Keep Google selected with
shared credentials and do not create or supply Google client ID/secret values;
the Fonds env variables select that upstream and the single permitted owner.
This snippet sets the branch policy with the pinned CLI, keeping CLI output in
memory and printing only a fixed message. Run it from the repository root for
the intended branch. It switches an existing Google provider to the shared app
and disables managed email/password signup:

```sh
node --input-type=module <<'JS'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const context = ['--project-id', 'PROJECT_ID',
  '--branch', 'BRANCH_ID', '--profile', 'PROFILE'];
const run = (args) => exec('npx', ['--yes', 'neon@8.4.3', ...args, ...context],
  { timeout: 60000, maxBuffer: 65536 });
try {
  await run(['neon-auth', 'oauth-provider', 'update', '--provider-id', 'google']);
  await run(['neon-auth', 'config', 'email-password', 'update',
    '--enabled=false', '--disable-sign-up=true']);
  console.log('Shared Google configured; managed email/password and signup disabled.');
} catch {
  console.error('Managed login configuration failed; inspect settings before retrying. Details suppressed.');
  process.exitCode = 1;
}
JS
```

If Google is absent rather than the normal default, replace only
`oauth-provider update` with `oauth-provider add`, still omitting both Google
credential options. Confirm the Google provider and the `enabled:false` /
`disable_sign_up:true` email/password values in the branch's managed Auth
settings. This policy does not disable Google's upstream social flow or replace
the Fonds exact-owner check.
[CLI provider/configuration options](https://neon.com/docs/cli/neon-auth),
[email/password API](https://api-docs.neon.tech/reference/updateneonauthemailandpasswordconfig).

## Set up schemas and the owner

One idempotent command prepares everything the Function needs in the database:

```sh
npm ci
npm run neon:setup -- --env-file "$FONDS_ENV" \
  --project-id PROJECT_ID --branch-id BRANCH_ID --profile PROFILE
```

Setup ([setup.mjs](../../deploy/neon/setup.mjs)) needs no build. It adds any
missing generated secrets and the random `FONDS_COLLECTION_TIME` to the env
file, applies the [migrations](../database.md#migrations) and the
[identity tables](../internals/auth-storage.md), ensures the configured
connection and creates the owner; the owner's password credential is random and
never used. It never calls the provider and prints neither secrets nor driver
diagnostics. Rerunning changes nothing.

## Deploy

Prepare the private env file and the credentials file before deploying.

```sh
npm run neon:deploy -- --env "$FONDS_ENV" \
  --project-id PROJECT_ID --branch BRANCH_ID \
  --profile PROFILE
```

`neon deploy` evaluates `neon.ts`, bundles and uploads
`deploy/neon/function.ts` with the declared variables, and reconciles the
`cal-hourly` cron trigger (a provider-neutral name and route,
`/internal/triggers/recent`; its cron comes from the
[schedule](#native-scheduled-collection))
([declarative deploy](https://neon.com/docs/compute/functions/deploy)). Each
deploy updates that trigger in place by name; renaming it in `neon.ts` would add
a second trigger rather than replace the first. `--no-env-pull` is part of the
npm script: without it the CLI writes the branch's database URL into a local
`.env`. Preview with `npx --yes neon@8.4.3 config plan --env "$FONDS_ENV"` and
the same project, branch and profile options; it lists changes without values.

The **first deploy of a new installation must include the provider credentials file**:
setup always generates `FONDS_COLLECTION_SECRET`, and the target refuses a
collection secret without a connection ID, provider and valid stored credentials.
To upload or rotate provider credentials, name the private credentials file for
that deploy only. Changing `FONDS_COLLECTION_PROVIDER` requires uploading matching
credentials in the same deploy; stored credentials are not converted between providers.

```sh
FONDS_COLLECTION_CREDENTIALS_FILE="$HOME/provider-credentials.json" npm run neon:deploy -- --env "$FONDS_ENV" \
  --project-id PROJECT_ID --branch BRANCH_ID \
  --profile PROFILE
```

The file must be an owned, unlinked `0600` regular file (symlinks, FIFOs and
files over 16 KiB are refused). `neon.ts` reads it in memory, and the selected
provider validates its fields before anything is uploaded; the values never
enter process arguments, the env file or the bundle.

## Update an existing deployment

To release new code to an installation that already runs, keep its env file,
project and branch, and do not regenerate its secrets or owner values. Deploy
only when you intend to replace what runs there; try a release on a separate
project first when it changes setup, schemas or login.

```sh
npm ci
npm run neon:setup -- --env-file "$FONDS_ENV" \
  --project-id PROJECT_ID --branch-id BRANCH_ID --profile PROFILE
npx --yes neon@8.4.3 config plan --env "$FONDS_ENV" \
  --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE
npm run neon:deploy -- --env "$FONDS_ENV" \
  --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE
npm run neon:smoke -- --env-file "$FONDS_ENV"
```

Setup keeps existing values, adds only missing generated settings, applies
pending [migrations](../database.md#migrations) and refuses a newer or altered
schema. The Function never migrates. An ordinary deploy omits the credentials
file, and Neon keeps the stored provider credentials.

## Native scheduled collection

A Function has no long-lived process, so Neon's native cron trigger runs the
schedule instead of the Node host's embedded scheduler. The private env file
chooses it with `FONDS_COLLECTION_SCHEDULE`, with the
[hosted service's values](hosted-service.md#scheduling), at the installation's
random `FONDS_COLLECTION_TIME`. If the schedule is on but the file has no
`FONDS_COLLECTION_TIME`, `neon.ts` stops the deploy and asks you to rerun setup,
which adds it.

To turn collection on, add the setting, rerun setup (it adds a missing time,
and the schedule tables to a database created before them) and deploy:

```sh
echo FONDS_COLLECTION_SCHEDULE=daily >> "$FONDS_ENV"
npm run neon:setup -- --env-file "$FONDS_ENV" \
  --project-id PROJECT_ID --branch-id BRANCH_ID --profile PROFILE
npm run neon:deploy -- --env "$FONDS_ENV" \
  --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE
```

Neon cron is UTC only. `neon.ts` converts the scheduled hours from
`FONDS_COLLECTION_TIMEZONE` to UTC with that zone's offset on the day you
deploy, as one cron (`17 7,11,16 * * *` for `9,13,18` at minute 17 in Israel's
winter time). A daylight-saving change therefore moves the local run time by
an hour until the next deploy; redeploy after a change to restore it. Neon
starts each occurrence at its exact minute, without the Node host's start
jitter. Events [delivery](hosted-service.md#mcp-events-and-webhook-delivery)
runs only after these runs, owner refreshes and operator runs, so a `daily`
schedule retries a failed webhook delivery once a day.

Native invocations use an internal URL and Host, so the Neon target routes only
`/internal/triggers/recent` ahead of the public Host/Origin guard, and accepts it
only with the reserved native attestation header, a valid envelope naming the
`cal-hourly` trigger, a scheduled timestamp, and at most 8 KiB of JSON.
Neon's ingress strips client-supplied `X-Neon-*` headers, so an external spoof
must return 403; the smoke check verifies it. Only the project's own trigger
configuration can name that trigger. The operator route accepts only the private
collection secret.
[Native trigger behavior](https://neon.com/docs/compute/functions/triggers/schedule).

Use the CLI to inspect the schedule, or to pause it immediately until the next deploy:

```sh
npx --yes neon@8.4.3 triggers list --project-id PROJECT_ID \
  --branch BRANCH_ID --profile PROFILE -o json
npx --yes neon@8.4.3 triggers disable TRIGGER_ID --project-id PROJECT_ID \
  --branch BRANCH_ID --profile PROFILE
```

Schedule state is declared: `neon.ts` enables `cal-hourly` only when
`FONDS_COLLECTION_SCHEDULE` turns a schedule on, so a new installation deploys
it disabled and never collects before validation. To pause collection, change
that value and deploy; a CLI `triggers disable` alone is re-enabled by the next
deploy. A queued occurrence can still arrive after disabling.

## Collection and manual refresh

Collection behaves as the
[hosted-service guide](hosted-service.md#collection-refresh-and-scheduling)
describes. The Function hands refreshes to `waitUntil`; a backfill past Neon's
15 minutes continues through `POST /internal/refreshes/continue` with
`FONDS_COLLECTION_SECRET`. The env-configured connection is the one in the
private env file. When the file also holds `FONDS_CREDENTIALS_KEY`, `neon.ts`
deploys it and every connection whose credentials `connect` stored is collected
too.

### Add a stored connection

Another connection is added from the operator's machine, in the repository root,
with the PostgreSQL target's `init` and `connect` against the Neon database.
Setup generates `FONDS_CREDENTIALS_KEY` with the env file's other secrets, and
every command run with `--env-file` checks the database's binding to them.

1. Build the PostgreSQL target and hold the branch's direct connection string
   in the shell only. Fonds accepts no URL parameter but `sslmode`, so ask the
   CLI for none and add it:

   ```sh
   npm run build:targets -- postgres
   (cd dist/targets/postgres && npm ci --omit=dev --omit=optional)
   export FONDS_DATABASE_URL="$(npx --yes neon@8.4.3 connection-string BRANCH_ID \
     --project-id PROJECT_ID --profile PROFILE --database-name neondb --ssl omit)?sslmode=verify-full"
   ```

2. Create the connection and store its credentials with hidden input;
   `--env-file` supplies the secrets and `FONDS_CREDENTIALS_KEY`:

   ```sh
   node --env-file="$FONDS_ENV" dist/targets/postgres/server.js init --connection cal-second --provider cal
   node --env-file="$FONDS_ENV" dist/targets/postgres/server.js connect --connection cal-second
   unset FONDS_DATABASE_URL
   ```

3. If the key is new, [deploy](#deploy) so the Function receives it. The next
   scheduled run collects the connection.

Keep the key: credentials stored under another key cannot be decrypted, and each
connection then needs `connect` again.

The [operator retry](hosted-service.md#collection-refresh-and-scheduling) after
resolving an authentication block posts with the private collection secret and
really calls the provider:

```sh
npm run neon:smoke -- --env-file "$FONDS_ENV" --collect
```

A schedule collects every configured and stored connection. Hosted Isracard
collection is not yet verified, so keep Isracard credentials out of a hosted
deployment, or leave `FONDS_COLLECTION_SCHEDULE` disabled, until it has been.

## Verification and client connection

```sh
npm run check
npm run check:targets
npm run neon:smoke -- --env-file "$FONDS_ENV"
```

The smoke command checks the public authentication, discovery and trigger
boundaries; without `--collect` it collects and writes nothing unless Neon's
ingress stopped stripping the attestation header: then its forged-trigger probe
runs one recent collection and fails. A
real client login and read verify browser cookies, Origin, CSP and redirects:
follow the [ChatGPT connection guide](chatgpt-connect.md) and record the
deployed revision.

Inspect structured logs by their operation/failure codes. Never copy credentials,
financial payloads or complete authenticated URLs into troubleshooting output.
The absence of a log error is not proof of collection completeness or delivery.

## Recovery and maintenance

Preserve the env file and the `financial`, `identity` and `operations` schemas
([backup](../database.md#state-directory-and-backup)): recollection cannot
reconstruct owner annotations, old source observations, auth identities or
consumer checkpoints. A code redeploy is not a recovery test. Verify the
project's actual retention and recovery settings rather than a plan limit
copied from elsewhere. Hosted recovery and subscription renewal have no tested
procedure yet, so test any restore in an isolated environment first; restoring
older change or subscription cursors needs coordination with consumers that may
have processed later events ([storage testing](../internals/storage-testing.md)).
