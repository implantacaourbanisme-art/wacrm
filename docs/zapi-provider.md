# Connecting via Z-API instead of Meta

wacrm can connect a WhatsApp number two ways: Meta's official Cloud API
(OAuth-ish, requires a WhatsApp Business Account and — outside the 24h
window — pre-approved templates), or **Z-API**, an unofficial provider
that automates a regular WhatsApp Web session and pairs by scanning a
QR code, like WhatsApp Web itself. Settings → WhatsApp connection lets
an account pick either; switching disconnects whichever provider was
connected before (`whatsapp_config` is one row per account — see
migration 043).

## Why Z-API behaves differently

Z-API is not a WhatsApp Business Account. That has real consequences,
not just a different connect screen:

* **No templates, no 24h window.** Every send is free-form text. A
  "template" send from a Flow, Automation, or Broadcast still exists as
  a reusable saved message, but on a Z-API-connected account it goes
  out as the already-substituted body (see `provider.ts`'s
  `sendTemplate` — the `renderedText` field), not a Meta-style
  pre-approved template. There's no approval step and no compliance
  guardrail preventing you from messaging someone outside any window —
  which also means there's nothing stopping the number from being
  flagged for spam by WhatsApp if it's used carelessly.
* **Interactive messages are best-effort, and this isn't fixable in
  code.** Z-API's button/list sends (`zapiSendButtonList` /
  `zapiSendOptionList`) work, but WhatsApp does not officially support
  interactive messages sent through an unofficial client — that's a
  WhatsApp-side policy against automated/unofficial clients, not a bug
  in this integration. Treat them as "usually works," not guaranteed,
  and know that nothing on wacrm's side can make WhatsApp treat these
  the way it treats Meta's own Cloud API.
* **Groups aren't supported.** Both providers skip group messages —
  Meta's Cloud API never delivers them at all; the Z-API webhook route
  explicitly drops any inbound event with `isGroup: true`.
* **Delivery/read receipts and agent reactions are supported**, with
  one caveat: unlike `on-message-received`, the exact endpoint for
  registering Z-API's status webhook wasn't confirmed from the docs
  (see `configureMessageStatusWebhook`'s doc comment in
  `zapi-api.ts`) — the settings panel warns if that registration call
  fails. If receipts don't move after connecting, check the "Status da
  mensagem" webhook in your Z-API dashboard and point it at the same
  URL as the message-received webhook by hand. The typing indicator
  still has no Z-API equivalent (cosmetic only; not wired up).
* **Weaker webhook authentication.** Meta signs every webhook delivery
  (HMAC over the raw body, checked against `META_APP_SECRET`). Z-API
  has no equivalent — its inbound webhook is authenticated by checking
  the `Client-Token` header against the same account-level security
  token used to authenticate outbound calls to Z-API. That's a shared
  static secret, not a signed payload: treat the token with the same
  care as a password, and confirm in your Z-API dashboard that webhook
  calls are actually configured to send this header before relying on
  it in production.

## Connecting an account

1. Create an instance in the [Z-API dashboard](https://www.z-api.io)
   if you haven't already, and note its **Instance ID** and
   **Instance Token** (shown on the instance's page).
2. Find the account's **security token** (Z-API calls this the
   Client-Token) under the account's Security settings — it's shared
   across every instance on the account.
3. In wacrm, go to Settings → WhatsApp connection, pick **Z-API (QR
   Code)**, and paste all three values in.
4. Saving verifies the credentials against Z-API, points the
   instance's webhook at `https://<your host>/api/whatsapp/zapi/webhook`,
   and shows a QR code.
5. Scan it with WhatsApp on the phone that owns the number: **Linked
   devices → Link a device**. The settings page polls
   `/api/whatsapp/zapi/status` and flips to "Connected" once WhatsApp
   confirms the pairing.

## Endpoints this integration relies on

`src/lib/whatsapp/zapi-api.ts` talks to Z-API over plain REST — there
is no official Node SDK. Every endpoint path there was checked against
<https://developer.z-api.io/api-reference> at the time this was
written, and the inbound webhook shape in
`src/app/api/whatsapp/zapi/webhook/route.ts` was checked against
<https://developer.z-api.io/webhooks/on-message-received-examples>.
Z-API is a third-party API outside wacrm's control — if a call starts
failing with a 404 or an unexpected shape, re-check the current path
or payload in your dashboard / the docs above before assuming the
credentials are wrong. This integration has not been exercised
end-to-end against a live Z-API account; the qr-code, status, and
webhook-configuration endpoints in particular are worth confirming
against your own instance the first time you connect one.

## What is per-account vs. per-deployment

Same shape as Meta's setup (see [multi-waba.md](./multi-waba.md)):
every credential (`zapi_instance_id`, the instance token, the
Client-Token) lives on the account's `whatsapp_config` row, encrypted
the same way as Meta's `access_token`. Nothing Z-API-related is a
deployment-wide environment variable — every account brings its own
instance.
