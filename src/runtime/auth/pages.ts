import { randomBytes } from "node:crypto";

import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );

const providerNames = { google: "Google", github: "GitHub" } as const;

type SocialProvider = keyof typeof providerNames;

/** Shared browser helpers: JSON calls and per-button error messages. */
const clientHelpers = `const alertBox=document.querySelector('[role=alert]');
const fail=message=>{alertBox.textContent=message;document.querySelectorAll('button').forEach(button=>button.disabled=false);};
const call=async(path,body)=>{const response=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error();return data;};
const on=(action,handler)=>document.querySelectorAll('[data-action='+action+']').forEach(button=>button.addEventListener('click',async event=>{
event.preventDefault();document.querySelectorAll('button').forEach(item=>item.disabled=true);try{await handler(button);}catch{fail(button.dataset.error);}}));`;

function htmlPage(title: string, body: string, script: string, status = 200) {
  const nonce = randomBytes(18).toString("base64");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body><main><h1>${title}</h1>${body}<p role="alert"></p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      },
    },
  );
}

/** Only the issuer's authenticated, expiring OAuth query can drive these pages. */
export async function betterAuthPage(
  request: Request,
  options: {
    secret: string;
    ownerEmail: string;
    consent: boolean;
    allowedClientIds: ReadonlySet<string>;
    /** The host's Google login bridge (Neon). */
    googleBridge?: boolean;
    /** Owner-linked social providers. */
    socialProviders?: readonly SocialProvider[];
    /** Synthetic browser tests/setup only; disabled in the deployed service. */
    allowPassword?: boolean;
  },
): Promise<Response> {
  const query = new URL(request.url).search.slice(1);
  const params = new URLSearchParams(query);
  if (
    !(await verifyOAuthQueryParams(query, options.secret)) ||
    !options.allowedClientIds.has(params.get("client_id") ?? "")
  ) {
    return new Response(
      "Invalid or expired authorization request. Reconnect from ChatGPT.",
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      },
    );
  }
  if (options.consent) {
    return consentPage(params);
  }
  const email = JSON.stringify(options.ownerEmail).replace(/</g, "\\u003c");
  const body = [
    `<p><button type="button" data-action="passkey" data-error="Passkey sign-in failed. Try again, or use a login link from your deployment.">Sign in with a passkey</button></p>`,
    ...(options.googleBridge
      ? [
          `<p><a href="/google/start?${escapeHtml(query)}">Continue with Google</a></p>`,
        ]
      : []),
    ...(options.socialProviders ?? []).map(
      (provider) =>
        `<p><button type="button" data-action="social" data-provider="${provider}" data-error="Sign-in failed. Reconnect from ChatGPT and try again.">Continue with ${providerNames[provider]}</button></p>`,
    ),
    ...(options.allowPassword
      ? [
          `<form><p>Account: ${escapeHtml(options.ownerEmail)}</p><label>Password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit" data-action="password" data-error="Request failed. Check your password or reconnect from ChatGPT.">Sign in</button></form>`,
        ]
      : []),
    `<p>No passkey on this device? Open a login link from your deployment in this browser, then reconnect from ChatGPT.</p>`,
  ].join("");
  // Each sign-in carries the signed OAuth query, so the issuer resumes the
  // authorization once the session exists.
  const script = `${clientHelpers}
const oauth_query=location.search.slice(1);
const finish=data=>{if(!data.url)throw new Error();location.assign(data.url);};
on('passkey',async()=>{const options=await call('/api/auth/passkey/generate-authenticate-options');
// The plugin offers preferred verification; Fonds requires it, so ask the device for it.
const credential=await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON({...options,userVerification:'required'})});
finish(await call('/api/auth/passkey/verify-authentication',{response:credential.toJSON(),oauth_query}));});
${options.socialProviders?.length ? `on('social',async button=>finish(await call('/api/auth/sign-in/social',{provider:button.dataset.provider,callbackURL:'/',disableRedirect:true,oauth_query})));` : ""}
${options.allowPassword ? `on('password',async button=>finish(await call('/api/auth/sign-in/email',{email:${email},password:new FormData(button.form).get('password'),oauth_query})));` : ""}`;
  return htmlPage("Sign in to Fonds", body, script);
}

function consentPage(params: URLSearchParams) {
  const scopes = (params.get("scope") ?? "").split(" ");
  const permissions = [
    ...(scopes.includes("financial:read")
      ? ["Read your connections, transactions, totals and collection status."]
      : []),
    ...(scopes.includes("financial:write")
      ? [
          "Edit annotations and confirm transaction posting or removal.",
          "Request a bounded refresh of transaction data from your provider.",
        ]
      : []),
    ...(scopes.includes("offline_access")
      ? ["Keep this access using refresh tokens until revoked."]
      : []),
    ...(scopes.includes("openid") || scopes.includes("profile")
      ? ["Identify your signed-in Fonds account."]
      : []),
  ];
  const error = "Request failed. Reconnect from ChatGPT.";
  const body = `<form><p>Client: ${escapeHtml(params.get("client_id")!)}</p><ul>${permissions.map((permission) => `<li>${permission}</li>`).join("")}</ul><button type="submit" data-action="consent" value="allow" data-error="${error}">Allow access</button><button type="submit" data-action="consent" value="deny" data-error="${error}">Deny</button></form>`;
  const script = `${clientHelpers}
on('consent',async button=>{const data=await call('/api/auth/oauth2/consent',{accept:button.value==='allow',oauth_query:location.search.slice(1)});
if(!data.url)throw new Error();location.assign(data.url);});`;
  return htmlPage("Allow Fonds access", body, script);
}

/** The owner's passkeys and linked sign-in providers; requires an owner session. */
export function ownerAccountPage(
  account:
    | { signedIn: false }
    | {
        signedIn: true;
        passkeys: { id: string; name: string | null; createdAt: Date }[];
        socialProviders: readonly SocialProvider[];
        linkedAccounts: readonly { id: string; provider: SocialProvider }[];
      },
): Response {
  if (!account.signedIn) {
    return htmlPage(
      "Fonds account",
      "<p>Sign in first: open a login link from your deployment in this browser.</p>",
      "",
      401,
    );
  }
  const passkeys = account.passkeys.length
    ? `<ul>${account.passkeys
        .map(
          (passkey) =>
            `<li>${escapeHtml(passkey.name ?? "Passkey")}, added ${passkey.createdAt.toISOString().slice(0, 10)} <button type="button" data-action="remove-passkey" data-id="${escapeHtml(passkey.id)}" data-error="Could not remove the passkey.">Remove</button></li>`,
        )
        .join("")}</ul>`
    : "<p>No passkeys yet. Add one to sign in without a login link.</p>";
  const providers = account.socialProviders
    .map((provider) => {
      const linked = account.linkedAccounts.find(
        (linkedAccount) => linkedAccount.provider === provider,
      );
      return linked
        ? `<li>${providerNames[provider]}: linked <button type="button" data-action="unlink" data-id="${escapeHtml(linked.id)}" data-error="Could not unlink ${providerNames[provider]}.">Unlink</button></li>`
        : `<li>${providerNames[provider]}: <button type="button" data-action="link" data-provider="${provider}" data-error="Could not link ${providerNames[provider]}.">Link</button></li>`;
    })
    .join("");
  const body = `<h2>Passkeys</h2>${passkeys}<p><button type="button" data-action="add-passkey" data-error="Could not add the passkey. Your device must verify you with a biometric or PIN.">Add a passkey</button></p>${providers ? `<h2>Sign-in providers</h2><ul>${providers}</ul>` : ""}<p><button type="button" data-action="sign-out" data-error="Sign-out failed.">Sign out</button></p>`;
  const script = `${clientHelpers}
on('add-passkey',async()=>{const options=await call('/api/auth/passkey/generate-register-options');
const credential=await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON(options)});
await call('/api/auth/passkey/verify-registration',{response:credential.toJSON()});location.reload();});
on('remove-passkey',async button=>{await call('/api/auth/passkey/delete-passkey',{id:button.dataset.id});location.reload();});
on('link',async button=>{const data=await call('/api/auth/link-social',{provider:button.dataset.provider,callbackURL:'/account',disableRedirect:true});
if(!data.url)throw new Error();location.assign(data.url);});
on('unlink',async button=>{await call('/api/auth/unlink-account',{accountId:button.dataset.id});location.reload();});
on('sign-out',async()=>{await call('/api/auth/sign-out',{});location.reload();});`;
  return htmlPage("Fonds account", body, script);
}
