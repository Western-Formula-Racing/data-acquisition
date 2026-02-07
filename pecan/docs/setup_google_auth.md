# Setting up Google Sign-In

To make the "Sign in with Google" button work, you need to link your Supabase project to a Google Cloud Project.

## Step 1: Get Supabase Callback URL
1.  Go to your [Supabase Dashboard](https://supabase.com/dashboard).
2.  Select your project.
3.  Navigate to **Authentication** -> **Providers**.
4.  Click **Google**.
5.  Copy the **Callback URL** (It looks like `https://<project-ref>.supabase.co/auth/v1/callback`).
    *   *Keep this tab open.*

## Step 2: Configure Google Cloud
1.  Go to the [Google Cloud Console](https://console.cloud.google.com/).
2.  Create a **New Project** (name it "Pecan Telemetry" or similar).
3.  **OAuth Consent Screen**:
    *   Go to **APIs & Services** -> **OAuth consent screen**.
    *   Select **External** and click **Create**.
    *   Fill in the **App Name** and **User Support Email**.
    *   (Optional) Add your email to "Test Users" if you don't want to publish yet.
4.  **Create Credentials**:
    *   Go to **APIs & Services** -> **Credentials**.
    *   Click **Create Credentials** -> **OAuth client ID**.
    *   **Application Type**: Web application.
    *   **Name**: Pecan PWA.
    *   **Authorized JavaScript origins**:
        *   Add `http://localhost:5173` (for local dev).
        *   Add `https://mcr-pecan.github.io` (or your production URL).
    *   **Authorized redirect URIs**:
        *   **PASTE THE SUPABASE CALLBACK URL HERE** (from Step 1).
    *   Click **Create**.

## Step 3: Link to Supabase
1.  Copy the **Client ID** and **Client Secret** shown by Google.
2.  Go back to your **Supabase Dashboard** (Authentication -> Providers -> Google).
3.  Paste the **Client ID** and **Client Secret**.
4.  Toggle **Enable Sign in with Google** to ON.
5.  Click **Save**.

## Done!
Restart your app and the Google Login button will now work.
