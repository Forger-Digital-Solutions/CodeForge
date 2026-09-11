# Attorney Review Delta — Pass 2 Independent Review

<!-- PASS 2 ADVERSARIAL REVIEW — NOT LEGAL ADVICE — DRAFT ONLY -->

## Overview
This document tracks the evolution of questions requiring outside legal counsel between Pass 1 and Pass 2. Pass 2 resolved several questions through technical verification, but escalated others due to newly discovered architectural nuances.

## 1. Questions Resolved by Pass 2
These items no longer require extensive attorney review, as the technical facts have clarified the legal posture.

- **RESOLVED: CCPA Compliance Timeline**
  - *Pass 1 Question:* Must we build CCPA deletion workflows before launch?
  - *Pass 2 Answer:* No. CodeForge does not meet the $25M revenue or 100k user statutory thresholds.
- **RESOLVED: LGPL Contamination via FFmpeg**
  - *Pass 1 Question:* Does bundling `ffmpeg.dll` trigger LGPL source-disclosure obligations?
  - *Pass 2 Answer:* No. CodeForge bundles Electron's standard, stripped-down stub which deliberately omits the codecs that trigger LGPL/patent issues.
- **RESOLVED: "Zero Telemetry" Liability**
  - *Pass 1 Question:* Is the marketing claim of "Zero Telemetry" legally actionable if we have analytics?
  - *Pass 2 Answer:* Codebase scan confirms `@codeforge/telemetry` is a non-transmitting stub. The marketing claim is factually true as of this commit.

## 2. Questions Refined / Narrowed by Pass 2
These items still require attorney review, but the scope is much narrower and more precise.

- **NARROWED: GDPR Article 17 (Right to Erasure)**
  - *Refined Question for Counsel:* Confirm that CodeForge has no statutory obligation to provide centralized remote-deletion for local SQLite databases residing entirely on the user's hardware. (CodeForge will implement cloud DB deletion to cover the cloud attack surface).
- **NARROWED: OpenRouter API Resale (Section 7.4)**
  - *Refined Question for Counsel:* If an end-user provides their *own* OpenRouter API key in the Desktop client (BYOK), CodeForge acts as a user-agent, not a reseller. Confirm BYOK is fully compliant with Section 7.4.

## 3. New / Escalated Questions (Discovered in Pass 2)
These are critical new questions for outside counsel based on Pass 2's architectural discoveries.

- **NEW: Google Gemini "API Client Deployer" Definition**
  - *Question for Counsel:* Google's terms state: "You may use only Paid Services when making API Clients available to users in the [EEA]." If CodeForge distributes a Desktop application, and an EEA user inputs their own *Unpaid* Gemini API key into our software, is CodeForge liable for "making the API Client available", or is the user liable for their own key usage?
- **NEW: Hosted Proxy vs. Rate Limits (OpenRouter 7.3)**
  - *Question for Counsel:* If CodeForge hosts a centralized Cloud API that aggregates thousands of free users and routes them through a single CodeForge-owned OpenRouter API key (ForgeZero), does this violate OpenRouter Section 7.3 ("creating multiple accounts... to bypass limits")? Do we require an explicit Enterprise Agreement to operate this architecture?
- **NEW: User-Submitted Proprietary Code to Unpaid Models**
  - *Question for Counsel:* Because Unpaid Gemini models use inputs for training, does CodeForge face secondary liability (e.g., contributory infringement or trade secret misappropriation) if a user pastes their employer's proprietary code into CodeForge, which then routes it to Unpaid Gemini? Is a prominent UI disclaimer sufficient safe harbor?
