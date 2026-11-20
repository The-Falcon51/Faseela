# Firebase Security Context

## Current State

- Firebase project: `gen-lang-client-0319369264` (display name Faseela).
- Firebase Hosting serves the static `public/` application.
- A Firebase Web app is registered; Firestore and Storage databases are not yet provisioned.
- The current application stores investor, share, transaction, farmer, mill, and approval state in browser `localStorage`.
- The existing Express API uses SQLite and currently exposes health, admin authentication, admin user/log, and password-change endpoints only.
- Client-selected roles, local storage values, and client-supplied payment status are not trusted authorities.

## Identity And Roles

- Firebase Auth UID is the sole user identity key.
- A newly authenticated account starts as `investor`.
- `farmer`, `mill_operator`, `finance_admin`, `quality_auditor`, and `admin` are assigned only by trusted server-side administration; clients cannot create or change roles.
- Private identity and contact fields are isolated in `users_private/{uid}`.

## Collections And Access Intent

- `users_private/{uid}`: owner and administrators can read; privileged fields are server-managed.
- `trees/{treeId}`: canonical inventory, exact location, land parcel, and reservation counters; server-managed.
- `trees_public/{treeId}`: curated, non-PII listing data; public reads only while listed; server-managed writes.
- `investment_requests/{requestId}`: investor reads their own requests; server creates and transitions them.
- `transactions/{transactionId}` and `shares/{shareId}`: owner reads their own records; server-only writes.
- `farmer_assignments/{uid}/trees/{treeId}` and `mill_assignments/{uid}/mills/{millId}`: assigned operator and administrators can read; server-only writes.
- `farmer_updates/{updateId}`: assigned farmer may create a bounded pending report; farmer and administrators can read; publication is server-managed.
- `pressing_batches/{batchId}`: assigned mill operator may submit a bounded pending batch; public reads only after certification; state transitions are server-managed.
- `tree_events_public/{eventId}`: public, non-PII, published provenance events; server-only writes.
- `audit_logs/{eventId}`: administrators only; server-only writes.

## Critical Workflows

- Investment requests reserve inventory atomically and begin in `awaiting_payment`.
- Payment proof submission moves a request to `under_review`; browser clients cannot mark payments approved or issue shares.
- Finance approval either atomically settles the request and issues a share record or rejects it and releases the reservation.
- Farmer reports and mill batches start as `pending_review`; only authorized reviewers can publish or certify them.
- Public tree and event documents contain no email, phone, precise home/contact information, or private payment data.

## Query And Validation Constraints

- Public marketplace reads must be constrained to listed trees.
- Investor reads must be constrained by `userId == request.auth.uid`.
- Farmer and mill actions require both an appropriate server-issued role claim and an explicit assignment document.
- Monetary values use integer minor units; prices, quantities, status transitions, and idempotency keys are validated server-side.