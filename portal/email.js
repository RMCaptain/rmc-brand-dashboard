'use strict';
/**
 * Portal email delivery — magic-link sign-in emails.
 *
 * Provider: Resend (single REST call, no SDK). Configured via:
 *   RESEND_API_KEY   — enables sending
 *   PORTAL_FROM      — e.g. "Rocky Mountain Co. <portal@rockymountainco.ca>"
 *                      (domain must be verified in Resend first)
 *
 * NOT CONFIGURED YET (Mike's call — needs a Resend account + domain verify):
 * when the key is absent, isConfigured() is false and nothing sends. The
 * working delivery path until then is the team invite-link endpoint — the team
 * copies the link and sends it to the brand themselves. request-link still
 * responds generically so the page works the same either way.
 */

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

async function sendLoginLink({ to, brandName, link, expiresMinutes }) {
  if (!isConfigured()) {
    console.log(`[PortalEmail] Not configured (no RESEND_API_KEY) — login link for ${to} NOT emailed. Team must use the invite-link flow.`);
    return { sent: false, reason: 'not-configured' };
  }
  const from = process.env.PORTAL_FROM || 'Rocky Mountain Co. <portal@rockymountainco.ca>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: 'Sign in to your Rocky Mountain Co. brand portal',
      html: `
        <div style="font-family: Inter, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #33392c;">
          <h2 style="color: #2c3a20;">Rocky Mountain Co. — Brand Portal</h2>
          <p>Click the button below to sign in${brandName ? ` to the <strong>${brandName}</strong> portal` : ''}.
             This link expires in ${expiresMinutes} minutes and can be used once.</p>
          <p style="margin: 28px 0;">
            <a href="${link}" style="background: #2c3a20; color: #fff; padding: 12px 22px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              Sign in
            </a>
          </p>
          <p style="font-size: 12px; color: #6e7567;">If you didn't request this, you can ignore this email —
             nothing happens unless the link is clicked.</p>
        </div>`,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[PortalEmail] Resend send failed (${res.status}): ${body.slice(0, 200)}`);
    return { sent: false, reason: `resend-${res.status}` };
  }
  return { sent: true };
}

module.exports = { isConfigured, sendLoginLink };
