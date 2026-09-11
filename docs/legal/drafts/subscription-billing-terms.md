# CodeForge Subscription, Credits & Billing Terms

**Status**: REVIEW DRAFT (PASS 1)
**Notice**: This document is a non-binding draft prepared for licensed attorney review and executive business determination. Stripe live payment processing is currently in **PRE-COMMERCIAL TEST MODE**; live commercial billing requires executive authorization.

---

**Last Updated**: [BUSINESS DECISION REQUIRED: Effective Date]

These Subscription, Credits & Billing Terms ("Billing Terms") supplement the CodeForge Terms of Service and govern all purchases of paid subscriptions, computing credits, and hosted services offered by [BUSINESS DECISION REQUIRED: Forger Digital Solutions Operating Entity Name] ("CodeForge," "we," "us," or "our").

---

## 1. Pre-Commercial Status Notice

> [!NOTE]
> **Pre-Commercial Test Mode**: The CodeForge billing infrastructure (`packages/cloud-billing`) is currently deployed in Stripe Sandbox / Test Mode (`sk_test_`). No real monetary charges are processed, and test cards are used to validate credit ledger migrations. Commercial activation will occur only upon executive clearance and legal review.

---

## 2. Cloud Credits & Ledger Mechanics

2.1 **Nature of Credits**: CodeForge Cloud utilizes a virtual credit ledger system (`packages/cloud-db`) to meter hosted agent execution and proxy usage. Credits are not legal tender, money, or property. They constitute a limited, revocable, non-transferable license to access computing time and API gateway resources.

2.2 **Default Credit Allocations**:
- **Free Tier**: 500,000 credits per calendar month (replenished on a rolling monthly basis; unconsumed credits do not roll over).
- **Pro Tier**: 5,000,000 credits per calendar month [BUSINESS DECISION REQUIRED: Retail Price per Month, e.g., $15.00 – $20.00 USD].
- **Credit Metering**: Credits are deducted based on input/output token counts, runner execution duration, and tool dispatch frequency.

2.3 **No Cash Value & Expiry**: Credits possess no cash redemption value and cannot be transferred, resold, or assigned. Except where prohibited by law, promotional or purchased credits expire upon termination of your account.

---

## 3. Subscriptions & Automatic Renewal (Negative Option Disclosures)

Pursuant to the California Automatic Renewal Law (Cal. Bus. & Prof. Code § 17600 *et seq.*) and the Federal Trade Commission's Negative Option Rule, please review these auto-renewal terms:

3.1 **Continuous Billing**: IF YOU ENROLL IN A PAID RECURRING SUBSCRIPTION (E.G., CODEFORGE PRO), YOUR SUBSCRIPTION WILL AUTOMATICALLY RENEW AT THE END OF EACH BILLING CYCLE (MONTHLY OR ANNUALLY) AT THE APPLICABLE SUBSCRIPTION RATE, AND YOUR DESIGNATED PAYMENT METHOD WILL BE AUTOMATICALLY CHARGED, UNTIL YOU CANCEL.

3.2 **Cancellation Prior to Renewal**: You may cancel your subscription at any time prior to the end of the current billing cycle through the CodeForge Account Settings (via the integrated Stripe Customer Portal) or by emailing `billing@codeforge.dev`. Cancellation will take effect at the end of the current paid billing period; you will retain access to your plan and credit balance until that date.

3.3 **Price Modifications**: We reserve the right to modify subscription pricing. We will provide at least thirty (30) days' prior written notice (via email or in-app notification) of any price increase before the new price takes effect on your renewal date.

---

## 4. Payment Processing & Taxes

4.1 **Third-Party Processor**: Payments are processed securely through Stripe, Inc. By providing payment details, you authorize Stripe to charge your payment method on our behalf.

4.2 **Taxes**: Subscription fees are exclusive of applicable sales, use, value-added (VAT), goods and services (GST), or other governmental taxes. You are responsible for all applicable taxes associated with your purchases.

---

## 5. Refund Policy & Statutory Rights

5.1 **Standard Commercial Policy**:
[BUSINESS DECISION REQUIRED: Except as required by law or expressly stated herein, all fees and credit purchases are NON-REFUNDABLE. Consumed computing credits are strictly non-refundable once an agent loop has initiated execution.]

5.2 **European Union / UK Statutory Right of Withdrawal**:
- If you are a consumer residing in the EU or UK, you have a statutory right to withdraw from a subscription contract within fourteen (14) days of purchase without providing a reason.
- However, pursuant to Directive 2011/83/EU, **you acknowledge that if you begin using the cloud service or consume credits within the 14-day withdrawal period, you expressly request immediate performance and waive your statutory right of withdrawal** once performance has commenced.

---

## 6. Billing Support

For billing inquiries, invoices, or cancellation assistance:
**Billing Inquiries**: `billing@codeforge.dev`
