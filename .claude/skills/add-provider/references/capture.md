# Capturing provider traffic

> For the account owner and the agent assisting them. Owns the capture procedure. The owner does everything here by hand; the agent writes the plan and reads only the [profiler's output](analysis.md).

A capture is a recording of your own session with your own account. It holds your
password in clear text, session tokens, cookies, national ID, card numbers and
financial rows. Treat it as a credential:

- Keep it in an owner-only directory outside every repository. Do not rely on
  `.gitignore`, and do not sync the directory to cloud storage.
- Never upload it to an online HAR viewer, attach it to an issue or give it to an
  agent to read directly.
- Delete it once its findings are recorded. Change the password if a capture
  ever leaves your machine.

## Pick the surface

Start with public sources, then the cheapest capture that answers the open
questions. Web and app are different clients: they can use different hosts, tokens
and device requirements, and neither is reliably richer.

| Surface           | Tool                  | Setup                             | Use when                                                  |
| ----------------- | --------------------- | --------------------------------- | --------------------------------------------------------- |
| Website           | Browser DevTools      | None                              | Always first: no certificate, nothing to undo             |
| iPhone app        | Proxyman or mitmproxy | Trusted certificate on the phone  | The web route is thin, blocked or needs a browser         |
| Android app       | Emulator plus a proxy | System certificate, often refused | Only when neither of the above can work; see below        |
| Public web bundle | `playwright-cli`      | None, no login                    | Reading the frontend's endpoints, request flags and logic |

Any proxy works. HAR is the interchange format, so the choice is taste:

| Tool                                     | Platforms      | Notes                                                                 |
| ---------------------------------------- | -------------- | --------------------------------------------------------------------- |
| [Proxyman](https://docs.proxyman.com/)   | macOS and more | Easiest iPhone setup; right-click a selection, Export, HAR            |
| [mitmproxy](https://mitmproxy.org/)      | All, free      | Scriptable; `mitmdump --set hardump=capture.har` writes a HAR on exit |
| [Charles](https://www.charlesproxy.com/) | All, paid      | Comparable; exports HAR                                               |
| [HTTP Toolkit](https://httptoolkit.com/) | All, free tier | Friendly Android workflow                                             |

## Website capture

1. Log out, open a private window and open DevTools on the Network tab.
2. Turn on **Preserve log** and **Disable cache**, so the login survives its
   redirects and responses are not served from cache.
3. Follow the [capture script](#capture-script).
4. Export the HAR. Chrome's default sanitized export omits cookies and
   authorization headers, which is enough to study structure, but **request
   bodies stay, including your password**. Export with sensitive data only to
   study a session hand-off, and other browsers may not sanitize at all.

## iPhone capture with Proxyman

1. Put the Mac and iPhone on the same Wi-Fi. In Proxyman, open **Certificate →
   Install Certificate on iOS → Physical Device** for the address and port.
2. On the iPhone, set the Wi-Fi network's HTTP proxy to **Manual** with those values.
3. Open `http://proxy.man/ssl` in Safari, install the profile, then turn it on
   under **Settings → General → About → Certificate Trust Settings**.
4. In Proxyman, enable SSL Proxying for the provider's domains only, not for all
   traffic. Other apps then stay encrypted and out of the file.
5. Force-quit the provider's app so the login is recorded, clear the session and
   follow the [capture script](#capture-script).
6. Filter to the provider's domains, select the rows and export them as HAR.
7. **Undo it:** turn the Wi-Fi proxy off, then remove the profile. A trusted root
   left on a phone can intercept everything it sends.

With mitmproxy, the same steps use `mitm.it` for the certificate. Each new app version
may behave differently, so note the version; the app states it in its headers.

## When traffic stays encrypted

A host that appears only as a `CONNECT` tunnel was not decrypted: either SSL
proxying is not enabled for it, or the app refuses the proxy's certificate
(pinning, usually with a connection error in the app). Enable the host and retry
once. If the app still refuses, **stop**: patching an app, jailbreaking or hooking
its TLS library is out of scope. Use the website instead, or ask the owner to choose
a [different source](../SKILL.md#gate-1-is-this-source-viable).

Android 7 and later apps trust only the system certificate store unless they opt
in, so a user-installed certificate does nothing for a third-party app. Reaching the
system store needs an emulator or rooted device, which banking apps commonly detect
and refuse. Treat Android as a last resort.

## Capture script

The file can only show what you opened. A home screen usually shows a short
preview list, and a design built on that list is built on the wrong source. Open
everything, even what seems irrelevant:

1. **Login:** start logged out, so the file holds a complete cold login, and
   approve any one-time code. Never fail a login on purpose: one failure can switch
   the account to CAPTCHA or lock it.
2. **Home:** let the dashboard settle.
3. **Every transaction view:** each tab and filter, each card, and at least two
   past months, then the oldest month offered.
4. **Upcoming:** whatever shows pending, not yet billed, next statement or
   authorizations.
5. **One detail screen per kind you have:** domestic, foreign currency,
   installment plan, refund, standing order, wallet payment, cash withdrawal, fee.
6. **Cards:** card list, one card's details, blocked or inactive cards.
7. **Bank account and statements:** statement download or export views.
8. **Logout:** it reveals session teardown.

Then plan for these repeats, because one capture cannot answer them:

- **A second login soon after** separates stable identifiers from per-session ones.
- **A fresh purchase:** make a small one, capture it while pending, then capture
  again once it posts. This pair is the only direct evidence for pending-to-posted
  identity.
- **A capture on another day** shows what changes between refreshes.

Keep a private note beside the file with times and what you did, such as "foreign
purchase detail at 14:30". Do not put it in the repository.
