# CodeForge Subscription & Commercial Billing Terms

<!-- DRAFT — NOT YET EFFECTIVE — PENDING BUSINESS AND LEGAL REVIEW -->
<!-- PRE-COMMERCIAL DRAFT: CODEFORGE CURRENTLY OPERATES IN DEVELOPMENT / TEST MODE ONLY -->

**Notice**: This document is an unexecuted commercial draft. Commercial billing is currently disabled. CodeForge Cloud strictly enforces Stripe test mode (`sk_test_`).

---

## 1. Scope & Free-First Commitment
CodeForge is committed to a free-first autonomous software engineering experience. Users may always utilize the Desktop App with their own API keys at zero subscription cost from CodeForge. These Billing Terms apply solely if you enroll in an optional paid CodeForge Cloud subscription tier (currently "Pro"; additional tiers may be introduced) or purchase hosted credit packs.

## 2. Subscription Plans & Credit Allowances
- **Pricing & Billing Cycles**: `[BUSINESS DECISION REQUIRED: Specify subscription pricing, e.g., $20/month billed in advance]`.
- **Hosted Credit Allowances**: The free account includes 500,000 hosted credits per monthly period with one concurrent hosted task; the Pro plan as implemented includes 5,000,000 credits per period and up to four concurrent hosted tasks. Unused monthly allowances do not roll over across billing cycles unless explicitly specified.
- **Credit packs**: A one-time credit pack (1,000,000 credits as implemented) is added to your balance when Stripe confirms payment. Credits are consumed by hosted inference at the rate shown in the application; they have no cash value and are not transferable between accounts.
- **Limits are real**: Every plan is subject to per-request cost ceilings, provider rate limits, concurrent-task limits, and operator safety limits (including a global daily spend cap). No plan provides unlimited usage. Grants and plan changes take effect only when Stripe's signed confirmation reaches CodeForge; a payment that is still pending or has failed grants nothing.

## 3. Payment Processing via Stripe
- All payments are processed securely by Stripe, Inc. By providing payment information, you authorize Stripe to charge your designated payment method on a recurring monthly or annual basis until canceled.
- CodeForge servers do not process, receive, or store card numbers, CVV codes, or bank details; card entry happens only on Stripe-hosted Checkout and Customer Portal pages. CodeForge stores your Stripe customer and subscription identifiers, plan status, and minimized payment-event records (identifiers, amounts, statuses).

## 4. Cancellation & Auto-Renewal
- **Auto-Renewal**: Your subscription will automatically renew at the conclusion of each billing period unless canceled prior to the renewal date.
- **Self-Service Cancellation**: You may cancel your subscription at any time through the Stripe-hosted Customer Portal opened from CodeForge Settings. Upon cancellation, you retain paid benefits until the end of the current paid billing cycle, after which the account returns to the free plan and its allowance.
- **Plan changes and failed payments**: Upgrades take effect when Stripe confirms payment. If a renewal payment fails, the subscription is marked past due; if it is not resolved and Stripe cancels the subscription, the account returns to the free plan.

## 5. Refunds & Statutory Rights
- **Refund Policy**: `[BUSINESS DECISION REQUIRED: Specify standard refund policy, e.g., No refunds for partial months, or 14-day money-back guarantee]`.
- **EU / UK Statutory Right of Withdrawal**: If you are a consumer residing in the European Union or United Kingdom, you have the statutory right to withdraw from this contract within 14 days without giving any reason, unless you have consented to the immediate performance of digital services and acknowledged the forfeiture of your withdrawal right.

## 6. Taxes & Fee Adjustments
- Subscription prices are exclusive of applicable value-added taxes (VAT), goods and services taxes (GST), or sales taxes. `[BUSINESS DECISION REQUIRED: whether taxes are calculated and collected through Stripe Tax or otherwise, and in which jurisdictions]`

## 7. Billing Support
Billing questions and disputes: `[BILLING SUPPORT CONTACT — OWNER INPUT REQUIRED]`. Stripe is the payment processor; receipts and invoices are issued through Stripe.
