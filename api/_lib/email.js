/**
 * Outbound email, one provider: Resend, over plain `fetch` (no new dep — see
 * TEAM_BRIEF's "no new npm dependencies" rule). No RESEND_API_KEY set ->
 * log-only, channel 'in-app': the notification still exists in-app
 * (api/_lib/notify.js writes that row regardless of whether email sends),
 * it just never left the building. This is the fallback path every dev/
 * staging environment runs on until Sterling adds the key
 * (handoffs/NOTIFICATIONS.md).
 */

export const EMAIL_FROM = "alerts@deepwelltechnology.com";
export const EMAIL_FROM_NAME = "DeepWell Technology";

/**
 * @param {{to: string[], subject: string, text: string, html: string}} msg
 * @returns {Promise<{sent: boolean, channel: 'email'|'in-app', error?: string}>}
 */
export async function sendEmail({ to, subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !to?.length) {
    console.log(`[email:log-only] to=${(to ?? []).join(",")} subject=${JSON.stringify(subject)}`);
    return { sent: false, channel: "in-app" };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
        to,
        subject,
        text,
        html,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("sendEmail: Resend responded", res.status, detail.slice(0, 500));
      return { sent: false, channel: "in-app", error: `resend ${res.status}` };
    }
    return { sent: true, channel: "email" };
  } catch (err) {
    console.error("sendEmail: request failed", err?.message);
    return { sent: false, channel: "in-app", error: err?.message ?? "network error" };
  }
}
