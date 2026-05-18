#!/usr/bin/env bash
# Idempotent GCP setup for the Netlify Function LLM proxy (issue #13).
#
# Creates / configures everything the backend needs so a fresh clone can
# bootstrap the same backing infrastructure:
#   1. GCP project (uccc-fda-approval-app)
#   2. Billing link
#   3. Vertex AI API enabled
#   4. Service account (fda-llm-proxy@...) with roles/aiplatform.user
#   5. Service account JSON key, written to ./secrets/ (gitignored)
#
# Each step is idempotent — re-running is safe and skips work that's
# already done. The JSON key file is the only artifact you need to feed to
# Netlify; paste its full contents into the GOOGLE_APPLICATION_CREDENTIALS_JSON
# env var (see README / netlify/functions/llm-lookup.ts).
#
# Prerequisites:
#   - gcloud CLI installed and authenticated as a user with project-create
#     rights on the chosen billing account.
#   - Permission to use the target billing account.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-uccc-fda-approval-app}"
PROJECT_NAME="${PROJECT_NAME:-UCCC FDA Approval App}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-01FBC9-79159F-14E95A}"  # NIH-Awd.CUAnschutz.NCI.U24CA289073
SA_NAME="${SA_NAME:-fda-llm-proxy}"
SA_DISPLAY="${SA_DISPLAY:-FDA LLM proxy (Netlify Function)}"
SA_DESCRIPTION="${SA_DESCRIPTION:-Used by the Netlify Function backend to call Vertex AI on behalf of fda-approvals.cancerdatasci.org users.}"
KEY_DIR="${KEY_DIR:-./secrets}"
KEY_PATH="${KEY_PATH:-${KEY_DIR}/${SA_NAME}-sa.json}"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

log() { printf '\033[1;34m▶\033[0m %s\n' "$*"; }
skip() { printf '\033[0;33m·\033[0m %s\n' "$*"; }

log "Project: ${PROJECT_ID} (${PROJECT_NAME})"

if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  skip "Project already exists"
else
  log "Creating project"
  gcloud projects create "$PROJECT_ID" --name="$PROJECT_NAME"
fi

log "Linking billing account ${BILLING_ACCOUNT}"
CURRENT_BILLING=$(gcloud billing projects describe "$PROJECT_ID" \
  --format="value(billingAccountName)" 2>/dev/null || true)
if [[ "$CURRENT_BILLING" == "billingAccounts/${BILLING_ACCOUNT}" ]]; then
  skip "Billing already linked"
else
  gcloud billing projects link "$PROJECT_ID" \
    --billing-account="$BILLING_ACCOUNT"
fi

log "Enabling Vertex AI API"
gcloud services enable aiplatform.googleapis.com --project="$PROJECT_ID"

log "Service account: ${SA_EMAIL}"
if gcloud iam service-accounts describe "$SA_EMAIL" \
    --project="$PROJECT_ID" >/dev/null 2>&1; then
  skip "Service account already exists"
else
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="$SA_DISPLAY" \
    --description="$SA_DESCRIPTION" \
    --project="$PROJECT_ID"
fi

log "Granting roles/aiplatform.user to ${SA_EMAIL}"
# add-iam-policy-binding is idempotent — re-running is a no-op once the
# binding exists.
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user" \
  --condition=None \
  --quiet >/dev/null

mkdir -p "$KEY_DIR"
if [[ -f "$KEY_PATH" ]]; then
  skip "Key file already exists at ${KEY_PATH}"
  printf '   (delete the file and re-run to rotate keys; also remove the old key with\n    \033[2mgcloud iam service-accounts keys list --iam-account=%s\033[0m)\n' "$SA_EMAIL"
else
  log "Generating service account key at ${KEY_PATH}"
  gcloud iam service-accounts keys create "$KEY_PATH" \
    --iam-account="$SA_EMAIL" \
    --project="$PROJECT_ID"
  chmod 600 "$KEY_PATH"
fi

cat <<EOF

\033[1;32m✔ Done.\033[0m

Next step — wire the key into Netlify:

  1. Copy the file contents:
       pbcopy < ${KEY_PATH}        # macOS
       xclip  < ${KEY_PATH}        # Linux

  2. In Netlify → Site settings → Environment variables, add:
       GOOGLE_APPLICATION_CREDENTIALS_JSON  = <paste the JSON>
       GCP_PROJECT_ID                       = ${PROJECT_ID}             (optional — parsed from JSON if omitted)
       VERTEX_REGION                        = global                     (optional — default; Gemini 3.x only at the global endpoint)
       VERTEX_MODEL                         = gemini-3.1-flash-lite      (optional — default; bump to gemini-3.1-pro-preview for harder cases)

  3. Trigger a redeploy. The /api/llm-lookup function picks up the env vars on cold start.

Verify the function is live:
  curl -s -X POST https://fda-approvals.cancerdatasci.org/api/llm-lookup \\
       -H 'content-type: application/json' \\
       -d '{"drugName":"Tylenol"}' | jq

(503 means GOOGLE_APPLICATION_CREDENTIALS_JSON isn't set yet; 200 means you're done.)

\033[2mTo rotate the key later: gcloud iam service-accounts keys delete <KEY_ID> --iam-account=${SA_EMAIL}\033[0m
EOF
