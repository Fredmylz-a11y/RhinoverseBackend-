# Rhinoverse payment and withdrawal deployment checklist

## Required backend environment variables

Configure these in the **backend Vercel project**. Do not put payment credentials in frontend files.

- `FIREBASE_PROJECT_ID` — `rhinoverse-2c104`
- `FIREBASE_CLIENT_EMAIL` — service-account client email
- `FIREBASE_PRIVATE_KEY` — service-account private key; preserve newlines or encode them as `\\n`
- `JWT_SECRET` — random secret of at least 32 characters; the API now refuses to start without it
- `MARZPAY_API_KEY` — MarzPay API key
- `MARZPAY_API_SECRET` — MarzPay API secret
- `MARZPAY_API_BASE` — `https://wallet.wearemarz.com/api/v1`
- `MARZPAY_COUNTRY` — `UG`
- `MARZPAY_CALLBACK_URL` — `https://rhinoversebackend.vercel.app/api/marz-webhook` (change the host if the backend deployment URL differs)
- `ADMIN_API_SECRET` — a separate long random secret for the manual withdrawal review page
- `MIN_WITHDRAWAL` — optional; defaults to `1000` UGX

The backend explicitly uses Firestore database `rhinoverse` in project `rhinoverse-2c104`; it does not use `(default)`.

## MarzPay live account requirements

Before accepting live transactions, confirm in the MarzPay dashboard that the account is live, Collections is enabled, the API credentials are production credentials, and the callback URL is HTTPS. Uganda collections support MTN and Airtel; the customer phone number must be E.164 format such as `+2567XXXXXXXX`. The provider selects the supported network based on the number/account configuration.

The code never credits a recharge merely because the collection request was created. It checks the authenticated MarzPay status endpoint and verifies the merchant reference, amount, and UGX currency before crediting. Duplicate callbacks/status checks do not credit twice. HMAC signing is optional in the supplied guide, but the guide does not specify the signing formula; do not configure an unverified custom signature formula. Server-side MarzPay status verification remains required.

## Manual withdrawal approval workflow

1. A user binds the payout account and submits a withdrawal. Funds are reserved and the request is `pending`.
2. Open the frontend deployment's `/admin.html` and enter `ADMIN_API_SECRET`. The secret is not saved in localStorage or embedded in source.
3. Review the account details and choose **Approve** or **Reject**.
4. Approval changes the request to `approved_for_manual_payment`; it does **not** send money automatically. Complete the transfer through the agreed external payment process.
5. Only after confirming the transfer succeeded, choose **Mark paid**. Rejecting a pending request returns the reserved amount to the user's earnings balance.

The current binding form stores bank name, account number, and account holder name. This matches a manual bank-payment review; it is not enough to automatically call MarzPay's mobile-money `/send-money` endpoint, which requires a recipient phone number, IP whitelisting, and disbursement permission.

## Validation before production

- Run a sandbox recharge with both MTN and Airtel numbers before live money testing.
- Confirm the prompt appears on the handset, approve it, and check the balance and transaction history.
- Test failed/cancelled collections, duplicate callbacks, wrong amounts, and mismatched references.
- Test withdrawal pending → approve → paid and pending → reject; verify balances and history at each step.
- Confirm `/api/health` returns healthy and `db: rhinoverse`.
- Never use permissive Firestore rules in production. Client reads/writes should be restricted; money mutations must go through the authenticated backend.
