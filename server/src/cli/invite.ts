/**
 * Create a single-use signup invite, for servers running with REGISTRATION_DISABLED=true.
 *
 *   bun run invite:create [--email someone@example.com] [--days 7]
 *
 * Prints the invite code; the person enters it as "Invite code" when creating their account.
 */
import { parseArgs } from "node:util";
import { sqlClient } from "../db/index.ts";
import { env } from "../env.ts";
import { createSignupInvite, SIGNUP_INVITE_TTL_DAYS } from "../services/auth.ts";

const { values } = parseArgs({
  options: {
    email: { type: "string" },
    days: { type: "string", default: String(SIGNUP_INVITE_TTL_DAYS) },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: bun run invite:create [--email <address>] [--days <n>]");
  process.exit(0);
}

const days = Number(values.days);
if (!Number.isInteger(days) || days < 1 || days > 365) {
  console.error("--days must be a whole number between 1 and 365");
  process.exit(1);
}

try {
  const invite = await createSignupInvite({ email: values.email, days });
  console.log(`Invite code: ${invite.token}`);
  console.log(`Server:      ${env.publicUrl}`);
  console.log(`For:         ${invite.email ?? "any email address"}`);
  console.log(`Expires:     ${invite.expiresAt.toISOString()} (single use)`);
  if (!env.registrationDisabled) console.log("Note: registration is open on this server, so the code is not needed.");
} finally {
  await sqlClient.end();
}
