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

Neon's default owner login is **Google through the managed Neon Auth bridge**,
bound to the configured owner ([admission](../security-model.md#admission)).
Neon's shared Google app needs no OAuth client of your own, but Neon labels
shared credentials for development and testing and recommends owned ones for
production branding and control
([managed Google setup](https://neon.com/docs/auth/guides/setup-oauth)). The
bridge exists because Neon Auth cannot be the MCP issuer while its
OAuth-provider plugin is unavailable; once it is, Better Auth `genericOAuth`
can replace the bridge. Auth rate limits key on a
[client address](hosted-service.md#client-addresses) unverified on Neon.

### Owner sign-in and recovery

Passkeys and [login links](hosted-service.md#owner-login-and-authorization) work
as on every host. On Neon, the login link comes from the operator's laptop, after
setup, with the env file and the [CLI profile](#neon-cli-profile):

```sh
npm run neon:setup -- login-link --env-file "$FONDS_ENV" \
  --project-id PROJECT_ID --branch-id BRANCH_ID --profile PROFILE
```

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

Pass `--profile PROFILE` explicitly to every command in this guide:
`npm run neon:setup` refuses to run without it, and other commands would
otherwise fall back to the CLI's `NEON_PROFILE` or default profile. Setup and the
login link use it to fetch the database connection string in memory. Keep API
keys out of the env file, the repository, shell history and model context.

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

The file is this installation's [state](../database.md#state-directory-and-backup),
bound to its database. Treat the whole file as a secret: an owned regular `0600`
file in an owned `0700` directory outside the repository. Do not print it or
read it into model context. Rotating `FONDS_AUTH_SECRET` or `FONDS_OWNER_ID`
invalidates grants or the owner mapping and needs a separate tested procedure.
The Function also receives Neon's injected `DATABASE_URL_UNPOOLED`; it parses
all variables once at startup and logs only variable names when invalid.
Provider credentials are never in the env file; see [deploy](#deploy).

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

   Confirm that the deploy reports success. It uploads no provider credentials
   and sets no schedule, so the `scheduled-collection` trigger is created
   disabled. Until the real deploy in step 8 the Function answers every request
   with 503: its placeholder Auth URL is not the `https://….neon.tech` URL it
   requires.

4. Read the Function's URL, printed as `invocation_url` (a deploy's text output
   may also list it under "Function URLs"). `FUNCTION_ORIGIN` below is that
   URL's origin: its `https://` scheme and host, without a path.

   ```sh
   npx --yes neon@8.4.3 functions get fonds \
     --project-id PROJECT_ID --branch BRANCH_ID --profile PROFILE -o json
   ```

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
shared credentials and supply no Google client ID or secret. This snippet, run
from the repository root for the intended branch, switches an existing Google
provider to the shared app and disables managed email/password signup, keeping
CLI output in memory and printing only a fixed message:

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

One idempotent command prepares everything the Function needs in the database,
and adds any missing generated values to the env file:

```sh
npm ci
npm run neon:setup -- --env-file "$FONDS_ENV" \
  --project-id PROJECT_ID --branch-id BRANCH_ID --profile PROFILE
```

Setup ([setup.mjs](../../deploy/neon/setup.mjs)) needs no build, never calls the
provider and prints neither secrets nor driver diagnostics. Rerunning changes
nothing.

## Deploy

Prepare the private env file and, for a new installation, the credentials file:

```sh
FONDS_COLLECTION_CREDENTIALS_FILE="$HOME/provider-credentials.json" npm run neon:deploy -- --env "$FONDS_ENV" \
  --project-id PROJECT_ID --branch BRANCH_ID \
  --profile PROFILE
```

`neon deploy` uploads [function.ts](../../deploy/neon/function.ts) with the
declared variables and reconciles the `scheduled-collection` cron trigger for
`/internal/triggers/recent`
([declarative deploy](https://neon.com/docs/compute/functions/deploy)). Each
deploy updates that trigger in place by name; renaming it in `neon.ts` would add
a second trigger rather than replace the first. `--no-env-pull` is part of the
npm script: without it the CLI writes the branch's database URL into a local
`.env`. Preview with `npx --yes neon@8.4.3 config plan --env "$FONDS_ENV"` and
the same project, branch and profile options; it lists changes without values.

Provider credentials live in a separate private JSON object with the fields the
selected [provider guide](../README.md#providers) lists, uploaded only by a
deploy whose `FONDS_COLLECTION_CREDENTIALS_FILE` names it. The **first deploy of
a new installation must include it**: setup always generates
`FONDS_COLLECTION_SECRET`, and the target refuses a collection secret without a
connection ID, provider and valid stored credentials. Afterwards name it only to
upload or rotate credentials. Changing `FONDS_COLLECTION_PROVIDER` requires
uploading matching credentials in the same deploy; stored credentials are not
converted between providers. An [ordinary deploy](#update-an-existing-deployment)
omits the variable, and Neon keeps the stored credentials.

The file must be an owned, unlinked `0600` regular file (symlinks, FIFOs and
files over 16 KiB are refused). `neon.ts` reads it in memory, and the selected
provider validates its fields before anything is uploaded; the values never
enter process arguments, the env file or the bundle. The Function receives
`FONDS_COLLECTION_CREDENTIALS` and validates it without logging values; verify
its presence by variable name only
([environment semantics](https://neon.com/docs/compute/functions/environment-variables)).

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

Setup keeps existing values and applies pending
[migrations](../database.md#migrations); the Function never migrates.

## Native scheduled collection

A Function has no long-lived process, so Neon's native cron trigger runs the
[schedule](hosted-service.md#scheduling) instead of the Node host's embedded
scheduler, at the installation's random `FONDS_COLLECTION_TIME`. If the schedule
is on but the env file has no `FONDS_COLLECTION_TIME`, `neon.ts` stops the
deploy and asks you to rerun setup, which adds it. To turn collection on, add
the setting, rerun setup (it adds a missing time, and the schedule tables to a
database created before them) and deploy:

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
jitter. The schedule also sets when Events
[delivery](hosted-service.md#mcp-events-and-webhook-delivery) retries on Neon.

The trigger route's admission limits are in the
[security model](../security-model.md#what-fonds-protects)
([function.ts](../../deploy/neon/function.ts)). Neon's ingress strips
client-supplied `X-Neon-*` headers, so an external spoof must return 403; the
smoke check verifies it. Only the project's own trigger configuration can name
that trigger
([native trigger behavior](https://neon.com/docs/compute/functions/triggers/schedule)).

Schedule state is declared: `neon.ts` enables `scheduled-collection` only
when `FONDS_COLLECTION_SCHEDULE` turns a schedule on, so a new installation
deploys it disabled and never collects before validation. To pause collection,
change that value and deploy. The CLI can inspect the trigger, or pause it
immediately, but the next deploy re-enables it, and a queued occurrence can
still arrive after disabling:

```sh
npx --yes neon@8.4.3 triggers list --project-id PROJECT_ID \
  --branch BRANCH_ID --profile PROFILE -o json
npx --yes neon@8.4.3 triggers disable TRIGGER_ID --project-id PROJECT_ID \
  --branch BRANCH_ID --profile PROFILE
```

## Collection and manual refresh

Collection behaves as the
[hosted-service guide](hosted-service.md#collection-refresh-and-scheduling)
describes. A refresh that outlives Neon's 15-minute invocation continues in a
new one through `POST /internal/refreshes/continue` with
`FONDS_COLLECTION_SECRET`. The env-configured connection is the one in the
private env file. When the file also holds `FONDS_CREDENTIALS_KEY`, `neon.ts`
deploys it and every connection whose credentials `connect` stored is collected
too. Hosted Isracard collection is not yet verified, so keep Isracard
credentials out of a hosted deployment, or leave `FONDS_COLLECTION_SCHEDULE`
disabled, until it has been.

The [operator retry](hosted-service.md#collection-refresh-and-scheduling) after
resolving an authentication block posts with the private collection secret and
really calls the provider:

```sh
npm run neon:smoke -- --env-file "$FONDS_ENV" --collect
```

### Add a stored connection

Another connection is added from the operator's machine, in the repository root,
with the PostgreSQL target's `init` and `connect` against the Neon database.
Setup generates `FONDS_CREDENTIALS_KEY` with the env file's other secrets.

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

## Verification and client connection

```sh
npm run check
npm run check:targets
npm run neon:smoke -- --env-file "$FONDS_ENV"
```

The smoke command checks the public authentication, discovery and trigger
boundaries; without `--collect` it collects and writes nothing unless Neon's
ingress stopped stripping the attestation header: then its forged-trigger probe
runs one recent collection and fails. A real client login and read verify
browser cookies, Origin, CSP and redirects: follow the
[ChatGPT connection guide](chatgpt-connect.md) and record the deployed revision.

Inspect structured logs by their operation/failure codes. Never copy credentials,
financial payloads or complete authenticated URLs into troubleshooting output.
The absence of a log error is not proof of collection completeness or delivery.

## Recovery and maintenance

Preserve the env file and the `financial`, `identity` and `operations` schemas
together ([backup](../database.md#state-directory-and-backup)): recollection
cannot reconstruct owner annotations, old source observations, auth identities
or consumer checkpoints. A code redeploy is not a recovery test. Verify the
project's actual retention and recovery settings rather than a plan limit
copied from elsewhere. Hosted restore is a
[manual release gate](../internals/acceptance.md#manual-release-gates) and
subscription renewal is unverified, so test any restore in an isolated
environment first ([storage testing](../internals/storage-testing.md)).
