# Firebase CI/CD authentication

The GitHub Actions workflow builds and tests every pull request. A direct push
to `master` runs the same checks and then deploys the already-built `dist/`
directory to the live Firebase Hosting site.

It does not use an interactive Firebase login and it does not use a Firebase
web API key. Deployment authentication is a Google service-account JSON key,
stored only in a GitHub Actions repository secret.

## One-time setup

You need administrator access to the GitHub repository and permission to
create service accounts and keys in the `fluidmetronome` Firebase/Google Cloud
project.

1. Open the Google Cloud Console's **Service Accounts** page for project
   `fluidmetronome`.
2. Select **Create service account**. A name such as
   `github-actions-firebase-hosting` is appropriate.
3. Grant the service account these project roles:

   - **Firebase Hosting Admin** (`roles/firebasehosting.admin`)
   - **API Keys Viewer** (`roles/serviceusage.apiKeysViewer`)

   The application currently deploys static Firebase Hosting only. Do not add
   Cloud Run, Cloud Functions, or Firebase Authentication administrator roles
   unless the project later uses those products.
4. Open the new service account, choose **Keys**, then **Add key → Create new
   key → JSON**. Download the JSON file once and keep it private.
5. In GitHub, open this repository's **Settings → Secrets and variables →
   Actions → New repository secret**. Create this exact secret:

   ```text
   FIREBASE_SERVICE_ACCOUNT_FLUIDMETRONOME
   ```

6. Paste the complete, unmodified contents of the downloaded JSON file as the
   secret value and save it.
7. Delete the downloaded JSON from any unencrypted or shared location. Never
   commit it, put it in `firebase.json`, or paste it into an issue, pull
   request, log, or chat.

After the secret exists, push or merge a commit to `master`. Open the
**Actions** tab in GitHub and confirm that the **Deploy master to Firebase
Hosting** step succeeds. Firebase will print the deployed Hosting URL in that
step's log.

## Why the secret is safe in this workflow

The deployment step is guarded to run only for a direct push to
`refs/heads/master`. Pull-request jobs build and test but never execute the
deployment action, so they do not receive the Firebase credential.

If the key is ever exposed, delete that key in the Google Cloud Console,
create a replacement key, and replace the GitHub secret immediately.

## Optional Firebase-managed setup

Firebase can automate service-account and secret creation with:

```sh
firebase init hosting:github
```

Run it only if you want Firebase to generate additional default GitHub
workflow files, including pull-request preview deployments. This repository
already has a custom build-and-deploy workflow, so review any generated
workflow files before keeping them.
