---
id: billing-screen
title: The Billing screen, trial and usage
audience: app
surface: desktop
keywords: billing, trial, plan, usage, status, paywall, records rescue, api keys, stripe, portal, checkout, subscription
updated: 2026-09-29
---
Billing is in the header (icon and "Billing"). Every member can open it and read the plan and usage; only admins can change anything. A member sees the Billing buttons disabled, with "Ask an admin" beside them and a note that only a shop admin can start a plan, change it or manage billing.

### How do I start my free trial?
~ start trial, start my free trial, start the 30 day trial, how do i start the trial, begin trial, activate trial, free trial button, try deepwell free, how do i try it, sign up for the trial, start free trial, start my 30 day trial, how do i start my 30 day trial, 30 day trial
!covers:A-TRIAL
An admin opens **Billing** and presses **Start 30-day free trial**. It is the Solo plan, a card is required, and nothing is charged until the 30 days end. It is offered only to a shop that has never subscribed. You can cancel any time before it ends from **Manage billing**.

### It says "Pick a plan to open your account". Why?
~ pick a plan to open your account, choose a plan to continue, cant open anything, only billing and team, locked out, paywall, no plan yet, why is everything locked, why cant i use the app, app is locked, subscription ended, shop has no plan, need to pick a plan
!covers:A-PAYWALL
A shop with no plan (never subscribed, or canceled) can only open **Billing** and **Team** until an admin picks a plan. On the phone it says "Choose a plan to continue" and the owner picks one on the desktop app. Nothing is deleted; your records are there when a plan is active again.

### What is Manage billing?
~ manage billing, what is manage billing, billing portal, stripe portal, open the portal, where is manage billing, manage subscription, billing settings, subscription settings, stripe
!covers:A-PORTAL
**Billing → Manage billing** (in the Current plan card, shown once a plan exists) opens Stripe's billing portal. There an admin updates the card, views invoices and receipts, and cancels. A member sees it disabled with "Ask an admin".

### Where can I see my usage against my plan?
~ usage, my usage, how much have i used, pages used, pages this month, documents stored, logins used, usage meter, plan usage, how many pages left, pages left, remaining pages, am i near my limit, check my allowance, allowance
!covers:A-USAGE
Open **Billing** and look at the **Current plan** card: **Logins**, **Documents stored** and **Pages this month**, each as used / cap. Donovan questions are unlimited, and the owner isn't counted toward logins.

### What do Free trial, Active, Payment failed and Canceled mean?
~ status, billing status, free trial status, active status, payment failed, past due, canceled status, no plan yet, status pill, banner, your free trial ends in, your last payment failed, update billing to keep uploading, trial ending banner, red banner billing, why is there a billing banner
!covers:A-STATUS
The pill on Billing shows **Free trial**, **Active**, **Payment failed**, **Canceled** or **No plan yet**. A banner says "Your free trial ends in N days" or "Your last payment failed. Update billing to keep uploading." (**Go to Billing**). If a payment has been failing for more than 7 days uploads stop with "Subscription required" until the card is fixed.

### I paid or canceled checkout and Billing shows a message. What does it mean?
~ billing updated thanks, checkout canceled nothing was charged, confirming your subscription, checkout finished, i paid but it still says trial, plan not updated after paying, subscription not showing, payment went through but, still says no plan, just paid, after checkout
!covers:A-BILLING-CONFIRM
After Stripe you land back on Billing. "Billing updated — thanks!" means it worked. "Checkout canceled — nothing was charged." means you backed out. "Confirming your subscription…" can show for up to a minute while Stripe reports in; refresh once after a minute. If it still shows the old plan, email billing@deepwelltechnology.com.

### How do I buy Records Rescue?
~ buy records rescue, order records rescue, purchase paper scanning, order scanning, pay for scanning, scan my paper for me, records rescue button, buy scanning, how do i order scanning of my paper, book records rescue, pages for records rescue
!covers:A-RESCUE
An admin opens **Billing → Records Rescue**, enters the number of **Pages** (a minimum applies) and presses **Buy Records Rescue**. It is a one-time purchase for paper scanning and is separate from your subscription.

### How do I create an API key?
~ create api key, make an api key, api key, api keys, generate a key, new api key, api access, revoke api key, delete api key, where are api keys, dw_live, connect my own system, integration key, copy my key, lost my api key
!covers:A-APIKEYS
On the **Fleet** plan an admin opens **Billing → API access**, types a **Key name** and presses **Create key**. The key (starts dw_live_) is shown once, so copy it right away: "Copy your new key now — it will not be shown again". Keys can read, ingest and ask. **Revoke** on a row turns one off. A member on a Fleet shop sees "API keys are managed by a shop admin. Ask an admin." instead of the key form.

### Where is API access? I don't see it.
~ i dont see api access, api access missing, no api section, see fleet, upgrade for api, why cant i use api keys, api not available on my plan, api locked
!covers:A-APIKEYS-GATE
API keys are Fleet only. On other plans **Billing** shows "API access is included on the Fleet plan. Upgrade to connect your own systems to DeepWell with API keys." with a **See Fleet** button.
