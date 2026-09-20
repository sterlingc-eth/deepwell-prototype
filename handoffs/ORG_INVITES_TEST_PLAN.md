# Org invites — click-path test plan for Sterling

Needs two email addresses you control (a real inbox each — Clerk sends a
real email through the verified custom domain). Call them **Owner email**
(already has a DeepWell account/shop) and **Invitee email** (has never
signed in to DeepWell).

## A. Owner invites the second technician

1. Sign in to DeepWell as the Owner. Confirm the shop's name shows in the
   `OrganizationSwitcher` at the top right of the header.
2. Click **Team** in the header (next to Billing). If you don't see a "Team"
   button, you're not signed in with an admin role in this org — check
   Clerk Dashboard → your org → Members → your row's role.
3. You should see: a pill reading "N of M seats" (M = your plan's technician
   cap — Solo 1, Shop 4, Crew 10, Fleet uncapped), and Clerk's own
   Organization Profile panel below it with **Members** and **Invitations**
   tabs.
4. Click **Invite**. Enter the Invitee email, pick a role (test with
   **Member** first), send.
5. The pill's pending-invite count should tick up by one immediately
   ("· 1 pending invite").

## B. Invitee accepts and creates their own login

6. Open the Invitee email inbox. An invite email should arrive within a
   minute or two, from DeepWell's verified sending domain (not a raw
   `@clerk.com`/`@clerk.dev` address — if it's the latter, the custom-domain
   email setup isn't fully live yet).
7. Click the link in the email. It should open Clerk's sign-up flow
   pre-filled with the Invitee email, already scoped to the Owner's org (you
   should NOT be asked "create a shop or join one" — that's the Clerk invite
   token doing its job).
8. Complete sign-up (password or whatever methods are enabled).
9. **Check**: you should land inside the DeepWell app directly — never on
   the `OnboardingScreen` ("join or start a shop") gate. If you do land on
   that gate, the invite token didn't carry through; see the diagnostics
   below.
10. **Check**: the header's `OrganizationSwitcher` should show the SAME shop
    name the Owner sees — not a new/empty personal workspace. There is no
    "personal workspace" option in this app (`hidePersonal` everywhere), so
    if this ever shows something unexpected, that's a real bug.
11. As the Invitee (a Member, not Admin): confirm there is **no "Team"
    button** in the header. Confirm there is **no "Billing" access to
    checkout/portal actions** — Billing screen should be visible/read-only at
    most; upgrading or opening the Stripe portal should fail with "This
    action requires the 'admin' role in your shop" if attempted directly
    against the API.
12. As the Invitee: go to **Inbox → Add files**, upload one test document.
    Confirm it processes (Sorted → Read → Matched → Checked, or shows up in
    "Needs a person").
13. As the Invitee: go to **Ask**, ask a simple question about the document
    you just uploaded (e.g. "What's the customer name on the document I just
    uploaded?"). Confirm it answers and cites that document.
14. Back as the **Owner**: refresh Records/Browse. Confirm the document the
    Invitee just uploaded shows up — same tenant, same records, visible to
    both.
15. Optional: repeat steps 4–14 inviting the second email as **Admin**
    instead of Member, and confirm THAT account DOES see the "Team" button
    and CAN reach checkout/portal.

## C. Seat cap (informational, not a hard block)

16. As the Owner, on the Team screen, note the "N of M seats" pill. If N
    reaches M (e.g. Shop plan, 4 of 4), you should see a warning banner
    ("You're at your plan's seat limit… Upgrade to invite more
    technicians") with a "Go to Billing" link.
17. **Known limitation — by design, not a bug**: Clerk's own invite form
    does NOT get blocked by this banner. You CAN still click Invite and send
    a 5th invite past a 4-seat Shop plan; DeepWell has no way to stop Clerk's
    own UI from submitting it. The banner is advisory. If you want a hard
    stop here, that would need a custom invite form calling Clerk's API
    ourselves instead of embedding `<OrganizationProfile />` — flag it if
    Sterling wants that as a follow-up.

## If the invite email never arrives — check in Clerk Dashboard

1. **Organization → Invitations**: does the invitation show status
   `pending`? If it shows `revoked` or doesn't exist at all, it never sent —
   redo step 4.
2. **Configure → Email, Phone, Username → Email**: confirm "Email address"
   is enabled and the invitation email template is turned on (not disabled
   for this instance).
3. **Configure → Domains** (or **Customization → Email delivery** depending
   on Clerk's current dashboard layout): confirm the custom domain shows
   **Verified**, specifically its DKIM/SPF/DMARC/MX **CNAME records** — a
   domain that's "Active" for sign-in but still mid-verification for email
   can silently fail to send while sign-in still works fine. This is the
   single most common cause of "invite never arrives."
4. **Spam/Promotions folder** in the Invitee's inbox — a freshly verified
   sending domain with low reputation sometimes lands there for the first
   few sends.
5. If everything above looks correct and the email still doesn't arrive,
   check Clerk Dashboard → **Logs** (or **Webhooks** if configured) for a
   bounce or delivery error against that specific invitation's email.

## Quick reference — what "admin" vs "member" gets, today

| Action | Admin | Member |
|---|---|---|
| See "Team" button | Yes | No (but a member who navigates to `?screen=team` directly sees a read-only member list, not the invite UI) |
| Invite / remove members, see pending invites | Yes | No |
| Upload documents, Ask questions | Yes | Yes |
| API keys, export everything, delete everything | Yes | No (server returns 403) |
| Billing checkout / Stripe portal | Yes | No (server returns 403) |
| Land in the SAME tenant as the org after joining | Yes | Yes |
