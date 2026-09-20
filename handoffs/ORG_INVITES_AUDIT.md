# Org invites audit — agent-invites, 2026-09-20

Owner requirement: invited members get a Clerk email, create their own login,
and land in the SAME tenant (the owner's Clerk organization) with the right
role. Clerk owns the email + invite + signup; our job is exposing it right
and mapping org → tenant/role correctly.

## 1. What already existed (before this build)

**src/App.tsx**
- `useAuth()` gives `orgId`/`orgRole`; `!orgId` renders `OnboardingScreen`
  instead of the app (no "personal workspace" for a signed-in user).
- `usePostgresSync(..., orgId ?? userId ?? null)` — the tenant key the whole
  UI syncs against is the active Clerk org, falling back to the user's own id
  only when there is no org.
- A `mergeNotice` effect POSTs `/api/merge-tenant` the moment `orgId` goes
  from absent to present (create/accept-invite/pick-org all trigger it),
  folding any pre-shop solo uploads into the new org. **Bug found and fixed**
  (see §3): this ran for every role, not just the shop owner.

**src/components/AppShell.tsx**
- `<OrganizationSwitcher hidePersonal />` — no personal-workspace option is
  ever offered, consistent with OnboardingScreen's gate.
- Billing lives in the header's account-area row (not the 4-item primary
  nav). Team now follows the same pattern (§2).

**src/screens/OnboardingScreen.tsx**
- "Create your shop" → `<CreateOrganization hideSlug skipInvitationScreen={false} />`.
- "I was invited" → `<OrganizationList hidePersonal afterSelectOrganizationUrl="/app/" />`.
  This is exactly the invitee path: Clerk's own invite-accept flow signs the
  new user in, `OrganizationList` shows the org they were just added to (or
  they pick it if they belong to more than one), and selecting it sets
  `orgId` — which unmounts `OnboardingScreen` and lands them in the app
  already scoped to the owner's tenant. No separate "join" code needed; Clerk
  handles it.
- No bugs found here. No changes made.

**@clerk/clerk-react**: `^5.3.2` (package.json). Confirmed via
`node_modules/@clerk/shared` type defs: `useAuth()` exposes `orgRole` in the
`"org:admin"`/`"org:member"`-prefixed shape; `Organization` resource has
`membersCount` and `pendingInvitationsCount` fields (used in §4 — no new
server call needed for the seat count).

**api/_lib/auth.js**
- Reads both Clerk session-token shapes (v2 `o.{id,rol}`, v1 legacy
  `org_id`/`org_role`) into `{ orgId, orgRole, tenantId }`.
  `tenantId = orgId ?? user_${userId}` — the org IS the tenant; every invited
  member who lands in the same org automatically shares the same `tenantId`,
  which is the entire mechanism that makes "same tenant" work. Nothing
  invite-specific needed here.
- `normalizeOrgRole` collapses anything that isn't literally `"admin"` to
  `"member"` (custom roles included) — least-privilege default, already
  correct.
- `requireRole(auth, 'admin')` gates admin-only server actions. Already wired
  into `api/billing.js` (checkout/portal), `api/_lib/routes/keys.js`,
  `tenant-export.js`, `tenant-delete.js`, `document-delete.js`. **Verified
  (§5): still true, no changes needed.**

**api/_lib/members.js**
- `upsertMember(auth)`, called from every authenticated request that has an
  org (`requireAuth`'s tail), upserts a `users` row keyed on
  `(tenant_id, clerk_user_id)` with `role` mapped from `orgRole` (`admin` →
  `'admin'`, else `'user'`). This is what makes "who's on this team" queryable
  from our own DB, independent of Clerk. Best-effort/non-fatal by design — a
  write failure here never blocks the request.
- No bugs found. No changes made.

## 2. What was built

**src/screens/TeamScreen.tsx** (new), route `'team'` (added to
`Screen` in `src/store/appStore.ts` and to `useDeepLink.ts`'s `SCREENS`):
- Embeds Clerk's `<OrganizationProfile />` for an **admin** — members +
  invitations tabs, invite-by-email with role admin/member, revoke, remove —
  themed via the `appearance` prop's `variables` pointing at the `--dw-*` CSS
  custom properties (`src/index.css`) so it tracks Truck view automatically
  instead of being hardcoded light/dark.
- For a **non-admin**, does NOT mount `<OrganizationProfile />` at all —
  instead renders a small read-only list built from
  `useOrganization({ memberships: { pageSize: 50 } })` (name + role per
  member). This doesn't rely on Clerk's own permission system hiding the
  manage controls for a "member" role (which it likely would anyway) — a
  member here simply never gets the management component.
- Defensive fallback: if `organization` isn't loaded yet, shows
  `<CreateOrganization hideSlug />` with the copy "Create your shop to invite
  your team." (App.tsx already gates on `orgId` before this screen can even
  render, so this should be unreachable in practice — it only covers the
  instant Clerk's org object hasn't hydrated.)
- Seats: see §4.

**src/components/AppShell.tsx**: a "Team" button next to Billing in the
header's account-area row, rendered only when `isAdminRole(orgRole)` is true.
Hidden for members — matches "admin only in UI" — but see §2's read-only
fallback for anyone who reaches `?screen=team` directly anyway.

**src/services/teamClient.ts** (new): two pure functions,
`isAdminRole(raw)` (mirrors `api/_lib/auth.js`'s `normalizeOrgRole` exactly —
same "org:" stripping, same least-privilege collapse of custom roles) and
`seatStatus(count, cap)` (§4). Unit-tested in `scripts/verify-ui.ts`.

## 3. Fix: merge-tenant no longer runs for non-admins

`src/App.tsx`'s merge effect now checks `isAdminRole(orgRole ?? null)` before
calling `/api/merge-tenant`, in addition to the existing `orgId` transition
check. Rationale: `merge_tenant()` only ever moves the calling browser's OWN
solo tenant (`user_<callerId>`) — never another technician's or the shop's —
so this was never a cross-tenant security bug. But for a freshly invited
member, that "solo work" is almost always pre-invite scratch/testing, and
silently mixing it into the shop's shared records the instant they accept an
invite is not something anyone decided on purpose. Gating it to admins also
avoids a wasted serverless invocation on every member's first sign-in for a
case that essentially never applies to them. Server-side, `merge-tenant.js`
itself was left unchanged — it's already scoped to the caller's own userId
and does no harm if called, so this is a UI-side "don't bother" gate, not a
security fix.

## 4. Seat enforcement — no new server endpoint

`api/_lib/plan.js`'s `PLAN_LIMITS[plan].technicians` is the seat cap; it's
already surfaced to the client today via `GET /api/billing?action=status` →
`BillingStatus.limits.technicians` (see `src/services/billingClient.ts`),
fetched once in `App.tsx` and held in `useAppStore`. The member **count**
comes straight from Clerk's own `organization.membersCount` (confirmed
present on this SDK version — see §1), which Clerk keeps accurate as people
are invited, accept, or get removed.

Given both numbers were already one hook/store-read away on the client, no
new `teamStatus` action was added to `api/review.js` or `api/_lib/members.js`
— that would have meant a new DB round trip to reproduce a count Clerk
already maintains for free, and the file-count/DDL-avoidance rules make
"don't add server surface you don't need" the cheaper and safer call. If a
future need arises to cross-check Clerk's count against our own `users`
table (e.g. to catch someone removed from Clerk but never cleaned up here),
that would be the actual justification for a `teamStatus` action — not the
seat display itself.

`teamClient.ts`'s `seatStatus(count, cap)` renders "N of M seats" (or
"N members" when `cap` is `null`, i.e. Fleet or billing status not loaded
yet) and reports `atCap`. `TeamScreen.tsx` shows a warning banner + a
"Go to Billing" link when `atCap` is true, for admins only.

**Honest limitation, stated here and in the test plan**: Clerk itself does
NOT enforce this cap. `<OrganizationProfile />`'s invite form has no hook in
this SDK version to block a submission based on our own plan data, so a
determined admin can still invite past the seat count — the banner and label
are advisory, not a hard stop. This mirrors the existing pattern for billing
gates elsewhere (upload/ask 402 responses are enforced server-side; seats are
not, because Clerk owns that specific form).

## 5. Verified (no changes needed)

- Admin-only server actions already correctly gated: `api/billing.js`
  (checkout/portal), `api/_lib/routes/keys.js`, `tenant-export.js`,
  `tenant-delete.js` all call `if (hasShop(auth)) requireRole(auth, 'admin')`.
- Member-usable server actions correctly NOT role-gated: `api/document-status.js`,
  `api/upload-url.js`, `api/ask.js` all call `requireAuth`/`requireAuthOrKey`
  with no `requireRole` — any tenant member can check status, upload, and ask.
- `requireAuth` (`api/_lib/auth.js`) upserts a `users` row for every
  authenticated request with an org, regardless of role — so a member's
  first request after joining is already recorded in `users` with
  `role = 'user'` (non-admin), independent of anything built here.

## 6. Files touched

- `src/App.tsx` — import `TeamScreen`/`isAdminRole`; admin-gate the
  merge-tenant effect; add the `'team'` screen case.
- `src/components/AppShell.tsx` — admin-only "Team" button.
- `src/store/appStore.ts` — `'team'` added to `Screen`.
- `src/hooks/useDeepLink.ts` — `'team'` added to the valid-screen list.
- `src/screens/TeamScreen.tsx` (new), `src/screens/index.ts` (export it).
- `src/services/teamClient.ts` (new).
- `scripts/verify-ui.ts` — `isAdminRole`/`seatStatus` unit checks.
- `scripts/verify-auth.mjs` — added the missing v1-legacy-shape custom-role
  fallback case (the v2 case already existed).
- `src/screens/OnboardingScreen.tsx`, `api/_lib/auth.js`,
  `api/_lib/members.js` — audited only, no changes.
