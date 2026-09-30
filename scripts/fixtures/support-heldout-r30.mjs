/**
 * Round 30 - FRESH held-out set for the Support Assistant matcher (precision over recall).
 *
 * Written BEFORE the matcher was changed and before any score on it was looked at. It may be used to tune ONCE;
 * after that it is a regression set, not a tuning set. Consumed by scripts/verify-support-heldout.mjs (which lives
 * next to verify-support-app-coverage.mjs) and by scripts/verify-support-app-coverage.mjs for the Ask-box route.
 *
 *   APP_HOWTO   { q, act, alt? }   signed-in how-to. Right = the answering entry `covers` act (or one of alt).
 *   APP_TRAP    { q, ok? }         how-to shaped, but the KB has NO entry for it. Any confident answer is WRONG
 *                                  (unless the entry id is listed in ok); did-you-mean and fall-through are fine.
 *   PUBLIC_PRE  { q, art }         signed-out pre-sales questions. Right = answered from one of the article ids in art.
 *   PUBLIC_TRAP { q, ok? }         signed-out questions the public KB does not answer.
 *
 * Typing style follows real owners, office staff and field techs: typos, fragments, no punctuation, truck-cab shorthand.
 */
export const APP_HOWTO = [
  // sign in / shell / team
  { q: 'im locked out of my account how do i get back in', act: 'A-RESETPW', alt: ['A-SIGNIN'] },
  { q: 'where do i go to log in to deepwell', act: 'A-SIGNIN' },
  { q: 'how can i sign out of the website', act: 'A-SIGNOUT' },
  { q: 'my boss owns two shops can i hop between them', act: 'A-SWITCHORG' },
  { q: 'just made an account and it wants me to make a shop or join one', act: 'A-CREATESHOP', alt: ['A-JOINSHOP'] },
  { q: 'how do i turn on the dark screen', act: 'A-FIELDVIEW' },
  { q: 'where can i type a question to the help bot', act: 'A-HELPCHAT' },
  { q: 'quick search hotkey for customers and serials', act: 'A-PALETTE' },
  { q: 'how do i email a coworker a direct link to one furnace', act: 'A-DEEPLINK' },
  { q: 'adding a new hire so he can log in', act: 'A-INVITE' },
  { q: 'give my office lady admin rights', act: 'A-ROLE-CHANGE' },
  { q: 'need to cut off access for a guy we let go', act: 'A-USER-REMOVE' },
  { q: 'i sent an invite to the wrong email can i cancel it', act: 'A-INVITE-MANAGE' },
  { q: 'how many of our logins are taken right now', act: 'A-SEATS' },
  { q: 'how do i get the phone app onto my crews phones', act: 'A-PHONE-CARD' },
  // billing
  { q: 'where do i update the card you charge', act: 'A-CARD', alt: ['A-PORTAL'] },
  { q: 'how do i move up to a bigger plan', act: 'A-PLAN-CHANGE' },
  { q: 'stop billing me how do i cancel', act: 'A-CANCEL' },
  { q: 'where are my past receipts', act: 'A-INVOICES', alt: ['A-PORTAL'] },
  { q: 'whats the button that opens the stripe page', act: 'A-PORTAL' },
  { q: 'how much of my page allowance is left this month', act: 'A-USAGE' },
  { q: 'we hit the fleet plan how do i generate a key for our other software', act: 'A-APIKEYS' },
  // uploading and scanning
  { q: 'whats the way to get a folder of old pdfs into the system', act: 'A-UPLOAD-BULK', alt: ['A-UPLOAD-WEB'] },
  { q: 'which button do i press to add work orders from my desktop', act: 'A-UPLOAD-WEB' },
  { q: 'what is the max size for one pdf', act: 'A-UPLOAD-LIMITS' },
  { q: 'my upload says already on file what does that mean', act: 'A-UPLOAD-DUP' },
  { q: 'how do i take a picture of a paper form with my phone and send it in', act: 'A-SCAN' },
  { q: 'i am in a basement with no bars will my scan still go through', act: 'A-SCAN-OFFLINE' },
  { q: 'scan on my phone says filled 4 of 6 fields', act: 'A-SCAN-STATUS' },
  { q: 'what do the stage labels on a file mean', act: 'A-UPLOAD-STATUS' },
  // fixing and verifying
  { q: 'where do i go to see stuff that needs my attention', act: 'A-NEEDS-YOU' },
  { q: 'the system asked me which customer this belongs to how do i answer', act: 'A-DECISIONS' },
  { q: 'the serial it pulled off the nameplate is wrong how do i fix it', act: 'A-FIX-FIELD' },
  { q: 'how do i approve a document once everything looks right', act: 'A-VERIFY-FACT' },
  { q: 'it thinks my invoice is a work order how do i change what kind of document it is', act: 'A-DOC-TYPE' },
  { q: 'attach this file to the right customer', act: 'A-LINK' },
  { q: 'two papers show different install dates which one wins', act: 'A-CONFLICT' },
  { q: 'we have the same customer entered twice how do i combine them', act: 'A-DUP-CUSTOMER' },
  { q: 'how do i see the actual scanned page', act: 'A-OPEN-ORIGINAL' },
  { q: 'invoice total is off by 50 bucks where do i correct it', act: 'A-MONEY-FIX' },
  // finding records
  { q: 'how do i look up a document by the customers name', act: 'A-SEARCH-DOCS', alt: ['A-CUSTOMER-SEARCH'] },
  { q: 'can i see only expired warranty documents', act: 'A-FILTER-DOCS' },
  { q: 'how do i keep a filter setup so i dont redo it every day', act: 'A-VIEWS' },
  { q: 'how do i find one customer by phone number', act: 'A-CUSTOMER-SEARCH' },
  { q: 'how do i enter a customer by hand', act: 'A-CUSTOMER-NEW' },
  { q: 'where can i write notes on a customer', act: 'A-CUSTOMER-PROFILE' },
  { q: 'is there a spreadsheet view of all my units', act: 'A-GRID' },
  { q: 'how do i download the units in the grid as a csv', act: 'A-GRID', alt: ['A-EXPORT-CSV'] },
  // asking Donovan
  { q: 'how do i see what donovan based his answer on', act: 'A-ASK-SOURCES' },
  { q: 'can donovan use documents that havent been checked yet', act: 'A-ASK-UNVERIFIED' },
  { q: 'donovan got it wrong how do i report that', act: 'A-ASK-FEEDBACK' },
  { q: 'how do i send an answer to my partner', act: 'A-ASK-SHARE' },
  { q: 'can i snap a photo of the data plate and have donovan look it up', act: 'A-ASK-SERIAL' },
  { q: 'donovan replied nothing in your records answers that now what', act: 'A-ASK-NOANSWER' },
  { q: 'where are the questions i asked yesterday', act: 'A-ASK-EXAMPLES' },
  // dashboard, warranty, notifications
  { q: 'what are the colored cards at the top of the dashboard', act: 'A-DASH-ALERTS', alt: ['A-DASH'] },
  { q: 'how do i build the pdf for a manufacturer warranty claim', act: 'A-CLAIM-PACKET' },
  { q: 'how do i send warranty emails to my customers', act: 'A-OUTREACH' },
  { q: 'where do i tell the app to nag techs about missing serials', act: 'A-FOLLOWUPS' },
  { q: 'what is the bell in the corner for', act: 'A-BELL', alt: ['A-DIGEST'] },
  { q: 'how do i add the install date for a unit with no warranty on file', act: 'A-INSTALL-DATE', alt: ['A-DASH-EXPIRY'] },
  // exports, data, support
  { q: 'how do i download everything i have in deepwell', act: 'A-EXPORT-JSON' },
  { q: 'can i get my documents into excel', act: 'A-EXPORT-CSV', alt: ['A-GRID'] },
  { q: 'let the deepwell team look at my account for a day', act: 'A-SUPPORT-GRANT' },
  { q: 'how do i see who from your side opened my records', act: 'A-SUPPORT-LOG' },
  { q: 'wipe the whole shop and cancel', act: 'A-DELETE-SHOP' },
  // phone
  { q: 'how do i put deepwell on my iphone home screen', act: 'A-M-INSTALL' },
  { q: 'what cant i do on the phone version', act: 'A-M-LIMITS' },
  { q: 'phone says join your shop first', act: 'A-M-GATES' },
  { q: 'how do i look a customer up on my phone', act: 'A-M-DOCS' },
  { q: 'how do i answer a needs your input question from the truck', act: 'A-M-NEEDS-INFO' },
  { q: 'how do i change shops from the phone app', act: 'A-M-ACCOUNT' },
];

export const APP_TRAP = [
  { q: 'how do i change the email address on my login' },
  { q: 'how do i print a work order from deepwell' },
  { q: 'how do i rename a document after uploading' },
  { q: 'how do i change the language of the app to spanish' },
  { q: 'can i attach a photo to a customer note' },
  { q: 'how do i export my customers to quickbooks' , ok: ['add-ons#5', 'exports-and-warranty-export#3'] },
  { q: 'how do i undelete a document i removed by mistake' },
  { q: 'how do i change which alert cards show on my dashboard' },
];

export const PUBLIC_PRE = [
  { q: 'what does deepwell actually do', art: ['what-is-deepwell'] },
  { q: 'is this for hvac shops only', art: ['what-is-deepwell'] },
  { q: 'who started this company', art: ['what-is-deepwell'] },
  { q: 'can i see it working before i pay', art: ['what-is-deepwell', 'trial-and-billing-dates', 'contacting-humans'] },
  { q: 'what does it cost per month', art: ['plans-and-pricing'] },
  { q: 'whats in the cheapest plan', art: ['plans-and-pricing'] },
  { q: 'how many logins do i get on the crew plan', art: ['plans-and-pricing'] },
  { q: 'do you give a discount if i pay for the year', art: ['plans-and-pricing'] },
  { q: 'do you charge extra for each tech i add', art: ['plans-and-pricing'] },
  { q: 'im a 4 person shop which plan fits', art: ['plans-and-pricing'] },
  { q: 'are there any hidden fees or long contracts', art: ['plans-and-pricing'] },
  { q: 'do i have to enter a card to start the trial', art: ['trial-and-billing-dates'] },
  { q: 'how long is the free trial', art: ['trial-and-billing-dates'] },
  { q: 'what happens if a payment doesnt go through', art: ['trial-and-billing-dates'] },
  { q: 'if i quit what happens to my stuff', art: ['data-export-and-deletion', 'trial-and-billing-dates', 'change-cancel-plan-invoices'] },
  { q: 'can i get my money back', art: ['change-cancel-plan-invoices'] },
  { q: 'can you scan my old paper files for me', art: ['add-ons'] },
  { q: 'does it hook into quickbooks', art: ['add-ons'] },
  { q: 'is the api included', art: ['add-ons', 'plans-and-pricing'] },
  { q: 'do you have an app in the app store', art: ['mobile-app-and-install', 'known-limits-and-coming-soon'] },
  { q: 'does the phone app cost extra', art: ['mobile-app-and-install'] },
  { q: 'how many pages of scanning do i get', art: ['page-allowance-and-limits'] },
  { q: 'do the questions i ask count toward my limit', art: ['page-allowance-and-limits', 'using-donovan-and-sources', 'plans-and-pricing'] },
  { q: 'can the ai make mistakes', art: ['using-donovan-and-sources'] },
  { q: 'is our data safe', art: ['security-and-privacy'] },
  { q: 'do you have soc 2', art: ['security-and-privacy'] },
  { q: 'do you train your models on my documents', art: ['security-and-privacy', 'using-donovan-and-sources'] },
  { q: 'who else touches my data', art: ['security-and-privacy'] },
  { q: 'how do i reach a human', art: ['contacting-humans'] },
  { q: 'how quickly do you reply to support emails', art: ['contacting-humans'] },
  { q: 'is there a status page for outages', art: ['contacting-humans', 'known-limits-and-coming-soon'] },
  { q: 'do you make backups of my records', art: ['known-limits-and-coming-soon', 'security-and-privacy'] },
];

export const PUBLIC_TRAP = [
  { q: 'do you offer a nonprofit discount' },
  { q: 'can i pay by check or purchase order' },
  { q: 'is there a reseller or partner program' },
  { q: 'does it work in canada or the uk' },
  { q: 'can i host deepwell on my own servers' },
];
