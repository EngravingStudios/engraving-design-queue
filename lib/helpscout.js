"use strict";
/*
 * Minimal HelpScout Mailbox API v2 client.
 * Uses OAuth2 client_credentials; token cached until near expiry.
 * Failures are logged and surfaced but never crash a request —
 * a HelpScout outage must not block the design queue.
 */

let cfg = null;
let token = { value: null, expiresAt: 0 };

function init(helpscoutConfig) {
  cfg = { ...helpscoutConfig, mailboxId: Number(helpscoutConfig.mailboxId) };
}

async function getToken() {
  const now = Date.now();
  if (token.value && now < token.expiresAt - 60_000) return token.value;

  const res = await fetch("https://api.helpscout.net/v2/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!res.ok) throw new Error(`HelpScout token failed: ${res.status}`);
  const data = await res.json();
  token = {
    value: data.access_token,
    expiresAt: now + (data.expires_in || 3600) * 1000,
  };
  return token.value;
}

async function createConversation({ subject, text, tags }) {
  const t = await getToken();
  const res = await fetch("https://api.helpscout.net/v2/conversations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "email",
      mailboxId: cfg.mailboxId,
      subject,
      status: "active",
      customer: { email: cfg.issueCustomerEmail },
      tags: tags || [],
      threads: [
        {
          type: "customer",
          customer: { email: cfg.issueCustomerEmail },
          text,
        },
      ],
    }),
  });
  if (res.status !== 201) {
    const body = await res.text().catch(() => "");
    throw new Error(`HelpScout create failed: ${res.status} ${body}`);
  }
  // Resource-ID header carries the new conversation id
  return res.headers.get("Resource-ID") || null;
}

async function createIssueTicket({ orderId, notes, user, lines, orderUrl }) {
  const lineDetail = (lines || [])
    .map(
      (l) =>
        `— ${l.productName} (qty ${l.qty})\n  FRONT: ${l.front || "(none)"}\n  BACK: ${l.back || "(none)"}`
    )
    .join("\n\n");
  return createConversation({
    subject: `Design issue — order ${orderId}`,
    tags: ["design-queue", "design-issue"],
    text:
      `Issue raised from the Design Queue by ${user}.\n\n` +
      `Order: ${orderId}\n` +
      (orderUrl ? `Order link: ${orderUrl}\n\n` : "") +
      `Notes:\n${notes}\n\n` +
      `Items on this order:\n\n${lineDetail}`,
  });
}

async function createUnmappedTicket(names) {
  return createConversation({
    subject: `Design Queue — ${names.length} unmapped product name${names.length > 1 ? "s" : ""}`,
    tags: ["design-queue", "unmapped-product"],
    text:
      "The Design Queue found order items whose names have no match in the " +
      "other_names table (product_id = 0). Add matches so future imports " +
      "map them:\n\n" +
      names.map((n) => `— ${n}`).join("\n"),
  });
}

module.exports = { init, createIssueTicket, createUnmappedTicket };
