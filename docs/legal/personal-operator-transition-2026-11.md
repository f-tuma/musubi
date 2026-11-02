# Musubi: transition to Filip Tůma

Reviewed: 2 November 2026. Status: source changes prepared; legal and operational
handover remains open. This record is an implementation audit, not evidence that
contracts, personal data, provider accounts or infrastructure have been transferred.

## Confirmed instructions

The owner confirmed that Musubi is moving from forgotten s.r.o. to **Filip Tůma**,
acting as an individual without an IČO, using **hello@f-tuma.dev** and
**https://f-tuma.dev**. The requested operator date is **1 November 2026**.
Hosting, backups, email and analytics are all intended to move under him. No public
postal address was provided. The revision date must reflect actual publication;
1 November must not be used to invent earlier notice, consent or acceptance.

## Source inventory

The public legal pages live in the separate
[website repository](https://github.com/f-tuma/musubi-web), checked at base
`1aec305`. The app repository base for this audit is `ac798e3`. Web retrieval of
`musubi.pro/privacy`, `/terms` and `/about` still identified the company; a separate
direct HTTP check returned 403, so it supplied no independent current-page proof.

| Surface | Source | Prepared change / remaining action |
| --- | --- | --- |
| Terms and search descriptions | website `src/pages/terms.astro`, `src/content/legal/terms.html` | Name Filip Tůma, personal contact, historical operator note; remove company registration/address; correct courts, liability and prospective changes |
| Privacy and contents navigation | website `src/pages/privacy.astro`, `src/content/legal/privacy.html` | Identify controller near the start, distinguish independent servers, add logs and Microsoft Tasks, correct rights and request timing |
| About and author metadata | website `src/pages/about.astro`, `src/content/authors/filip-tuma.json` | Replace current corporate identity with individual operator; retain only an explicit historical company reference |
| Account deletion help | website `src/pages/account/delete.astro` | New mailbox and GDPR timing; receive and verify requests at the new mailbox |
| Source links | website home, self-host page and two articles; root Compose download examples | Canonical `f-tuma/musubi` URLs |
| Web problem report | `apps/web/src/calendar/components/settings/AboutPanel.tsx` | New mailbox; editable diagnostic draft remains user-controlled |
| Mobile problem report | `apps/client/app/(tabs)/settings.tsx` | New mailbox; installed versions need a subsequent app update |
| Email copyright | seven templates in `packages/emails/src` | Credit Filip Tůma, matching the existing MIT notice; this is author credit, not proof of server ownership |
| Project/package author | root and eight workspace `package.json` files; README | Filip Tůma and personal website |
| Public app documentation | `packages/docs/.../architecture/client.mdx`, `guides/google-play-release.mdx` | New support mailbox |
| License and provenance | `LICENSE`, third-party notices, release/audit records | Existing MIT copyright already names Filip Tůma. Preserve it and third-party notices; retain historical evidence |
| Donations | web and mobile `KOFI_URL`, currently `ko-fi.com/frgtn` | Verify account ownership, beneficiary and billing details before changing the destination; a replacement URL was not supplied |

## Legal work required for the handover

### 1. Record the transfer, rather than relying on a website edit

Obtain a written handover covering the project name and assets, domains, repository
and deployment control, licenses or rights to exercise/use company-created work,
existing user agreements, outstanding liabilities, provider accounts and data.
Determine the applicable contractual transfer mechanism and any required user
agreement. A common director/author does not make the company and individual the
same legal person. The public texts cannot accomplish that transfer by themselves.

Have Czech counsel check contractual succession under the actual transaction
(including Civil Code § 1895 where relevant), the company-side authorization and
the rights chain for code, graphics and any employee/contractor work. Do not assume
a GitHub repository move transfers all rights, or delete existing copyright
notices. [Civil Code, official publication](https://e-sbirka.gov.cz/sb/2012/89).

### 2. Resolve Google Limited Use before transferring Google user data

Google's [API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
Limited Use, explicitly requires prior express user consent for a transfer as part
of a merger, acquisition or asset sale. If this handover falls within that route,
a new privacy policy, a news read marker or ordinary continued use is insufficient.
An OAuth reconnect alone does not document informed consent to transferring data
already held by the company.

Establish the actual transaction and data/control timeline, affected users, consent
wording/version and auditable affirmative receipts before relying on that route.
Include Google-derived content, stored credentials and backups in the scope. If
control already moved on 1 November, do not fabricate earlier consent; obtain a
specific remediation decision, including provider guidance where needed. This PR
does not implement consent capture, suspend sync, transfer data, revoke tokens,
reset queues or erase provider data. Those require a separately designed flow.

### 3. Inform users and establish GDPR roles

The company and the individual are distinct potential controllers. Document the
lawful basis for disclosure and receipt, purposes, categories, processors and
retention, and update the processing record. Inform existing users directly of the
new identity and contact, the actual transition and their options; assess Article
14 for data obtained indirectly. App users are not the only possible data subjects:
organizer/attendee details may concern non-users. Contract performance must not be
used as a blanket justification for people who are not parties to the contract.
[GDPR Articles 6, 13–14 and 28](https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=CELEX%3A32016R0679),
[ÚOOÚ controller guidance](https://uoou.gov.cz/verejnost/zakladni-prirucka-k-ochrane-udaju).

Update agreements with hosting, backup and email processors for the new customer;
check international transfers and the actual mechanism, countries and how users
can obtain safeguards. A third-party provider's general terms do not by themselves
prove this controller's transfer arrangements. Connected calendar providers are
not automatically all subprocessors; describe their actual role.

The prepared policy still needs a verified operational inventory: backup/log and
analytics retention or usable criteria, transactional mail provider, CDN/hosting
for the website, any newsletter list and its consent provenance, and international
processing. The website has a Cloudflare assets configuration and an external
`analytics.frgtn.dev` endpoint; those names alone do not prove the current legal
customer or deployment. Remove company infrastructure access only after safe
handover, and document any residual company copies/retention obligations.

### 4. Notify prospectively; do not backdate

The existing policy and Terms promise at least 14 days' advance notice for material
changes. Distinguish correction of operator/contact information from new
contractual provisions. Preserve the old texts and actual notice timestamp,
proposed effective date and acceptance evidence where required. The candidate
pages record the owner-reported operator date and explicitly do not backdate
acceptance. Their revision date must be refreshed if publication is later.

A project-wide `news.json` post may support awareness but is not sufficient proof
of notice or consent: the feed reaches independently hosted servers too, and new
accounts establish a baseline instead of seeing every historical entry. Scope a
notice to **hosted Musubi**; do not claim the individual operates all instances.
No user notice or email was sent by this change.

### 5. Decide business/consumer status and address requirements

No IČO does not establish a legal exemption from business or consumer obligations.
Assess the actual activity before enabling subscriptions or promoting paid extras.
If operating as a trader, resolve the required establishment/contact address,
registration information, applicable consumer information, complaints/ADR,
withdrawal and digital-service rules, and relevant language requirements. The
candidate identifies the real person and email without inventing a postal address
or reusing the company's address. This leaves the address/business-status question
open; it does not certify the final disclosure is sufficient for every regime.
[Civil Code §§ 420–435, official publication](https://e-sbirka.gov.cz/sb/2012/89),
[ČOI digital-service guidance](https://coi.gov.cz/faq/smlouvy-o-poskytovani-digitalniho-obsahu-ci-sluzby/).

The current free app is not automatically in every paid digital-service regime.
Assess its scope, including whether personal data is processed beyond what is
necessary for providing the service or complying with law. If targeting Czech
consumers, review the language of required disclosures as part of that assessment.

For future EU App Store publication, assess the app's DSA trader status separately
from the account's individual/organization label. Apple requires an individual
trader's public address (or verified P.O. Box), telephone and email. Google Play
requires a verified legal address for its account even where the public profile
shows only country; monetization and regional rules can require public disclosure.
Do not select non-trader merely to hide an address.
[Apple DSA requirements](https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements/),
[Google account information](https://support.google.com/googleplay/android-developer/answer/13628312?hl=en).

## Corrections prepared in the website candidate

- Replace exclusive Brno jurisdiction with courts competent under applicable law;
  preserve mandatory consumer protection despite choosing Czech law. See
  [Rome I Article 6](https://eur-lex.europa.eu/eli/reg/2008/593) and
  [Brussels I bis Articles 18–19](https://eur-lex.europa.eu/eli/reg/2012/1215/2015-01-10/eng).
- Remove the inconsistent hosted-service liability summary and blanket €50/fees
  cap. Use applicable-law wording and protected-liability exceptions; keep the
  separate MIT license. This deliberately does not invent a new personal liability
  shield. Counsel should assess the operator's exposure and any suitable future
  limitation under Czech law, including § 2898.
- Replace automatic acceptance by continued use with prospective notice and express
  agreement where legally required. Do not treat agreeing to Terms as GDPR consent.
- Correct the rights-response rule to one month from receipt, with lawful extension
  and notification, rather than 30 days after verification. Add restriction and
  withdrawal of consent. See [ÚOOÚ rights guidance](https://uoou.gov.cz/poradna/poradna-gdpr/prava-subjektu-udaju).
- Add Microsoft `Tasks.ReadWrite`, demonstrated by the real connect-time scope
  function in `apps/web/src/calendar/connections.ts`, and describe request/sync
  diagnostics demonstrated by API log middleware and provider observers.
- Separate our hosted service from other servers and clarify that exported/shared
  copies are not automatically erased from their recipients.

## Analytics needs a separate consent check

The website currently loads self-hosted Rybbit in production, with page views and
interaction events. “Cookie-free” alone does not establish that client-side
tracking is exempt from terminal-access consent rules. Inspect the deployed
script and configuration, identifiers, actual requests and retention before
relying on the existing legitimate-interest statement. Do not assert a violation
or add a generic cookie banner solely from the product name.
[Final EDPB technical-scope guidance](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-22023-technical-scope-art-53-eprivacy-directive_en),
[ÚOOÚ cookie guidance](https://uoou.gov.cz/verejnost/qa-otazky-a-odpovedi/cookies).

## Items requiring separate verification

| System | Action and acceptance evidence |
| --- | --- |
| Google Play Console | Verify current legal account holder/type, developer/support contacts, privacy/deletion URL, Data safety and any required app transfer. Preserve package, signing continuity and existing updates. [Official transfer guide](https://support.google.com/googleplay/android-developer/answer/6230247) |
| Apple / TestFlight | Verify current individual/organization owner and transfer eligibility. Preserve Bundle ID; plan Sign in with Apple user/relay migration before a team transfer and recheck widget App Groups, profiles and entitlements. Apple's migration has a 60-day window. [Transfer overview](https://developer.apple.com/help/app-store-connect/transfer-an-app/overview-of-app-transfer/), [TN3159](https://developer.apple.com/documentation/technotes/tn3159-migrating-sign-in-with-apple-users-for-an-app-transfer) |
| Expo / EAS | Project currently declares owner `frgtn` and project ID `4e24bdfa-490c-4c3e-9a76-7abef4efa823`. Transfer/verify access and credentials through EAS before changing owner; preserve project continuity |
| Google Cloud / OAuth | Verify project/customer and billing ownership, consent-screen publisher/support/privacy/domain verification, OAuth clients and service credentials; reassess verification after ownership changes |
| Microsoft Entra | Verify tenant/application ownership, publisher/contact/branding/privacy and redirect URIs; avoid changing app IDs or breaking refresh credentials |
| Domains and DNS | Registrant/billing/control for `musubi.pro`, personal domain, DNS/CDN, feedback/community redirects; TLS and app association endpoints remain valid |
| Hosting and storage | Hetzner, Dokploy, Postgres, S3 backups and restore evidence; new customer/DPA and access, key custody, billing and old access removal |
| Observability | Grafana/Loki/Prometheus and Rybbit account/control, retention and access; infrastructure may keep existing domain names under new ownership |
| Email | Verify new mailbox delivery and ownership, forwarding/continued handling of old legal requests, SMTP_FROM/Reply-To and credentials, SPF/DKIM/DMARC and any Resend ownership/DPA. A source edit does not change deployed SMTP settings |
| GitHub / registry / CI | Repositories are already under `f-tuma`; verify billing, admins, webhooks, deploy keys, CI and Docker Hub ownership. Keep `frgtndev/musubi` and `frgtndev/musubi-web` published paths until a separately planned migration |
| Donations / community | Check Ko-fi beneficiary, Discord, feedback service, status and any external profiles. Do not redirect money to a guessed username |

Keep `dev.frgtn.musubi`, `dev.frgtn.musubi.widgets`,
`group.dev.frgtn.musubi.widgets`, URL scheme, store identity, signing keys and OAuth
client IDs stable. Domain-like identifiers are compatibility contracts, not current
operator declarations. A team transfer may require association/entitlement changes
without renaming those identifiers; verify both installed and new builds.

## Publication and acceptance sequence

1. Record actual company/individual transfer and review the data/Google consent
   route, user agreements, business status and address question.
2. Verify provider/customer transfers, processor arrangements, mail delivery and
   retention. Keep evidence of the real dates and preserved old texts.
3. Finalize and send the required targeted notices / obtain express agreement and
   prior Google transfer consent as applicable. Do not include marketing by default.
4. Publish the revised policy/contact truthfully; apply revised contractual clauses
   only from their valid prospective effective date. Refresh revision dates.
5. Release app/server contact and email changes through the normal checked release
   flow. Update store listings and external consoles; existing mobile binaries keep
   their baked-in support address until updated.
6. Confirm production pages, mail drafts/delivery, account export/deletion, existing
   sign-ins, provider sync and Android/iOS app links after the actual transition.

Implementation, PR checks, public-page publication, user-notice/consent receipts and
production deployment evidence must remain separate. Preparing or merging source
is not evidence that any of the external steps above have happened.
