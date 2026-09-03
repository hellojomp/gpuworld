# oauth-relay

Lets the editor's "Connect with GitHub" button use GitHub's OAuth Device
Flow from a static page (GitHub Pages has no server to broker the token
exchange, and GitHub doesn't expose these two endpoints to browser CORS).

This Worker holds no secret — device flow doesn't use one. It just forwards
two POST requests to github.com and adds CORS headers so the browser is
allowed to read the response.

## One-time setup

1. Create a GitHub OAuth App: https://github.com/settings/applications/new
   - Homepage URL / callback URL: anything (device flow ignores the callback)
   - Check **Enable Device Flow**
   - Copy the **Client ID** (not the secret — nothing here needs it)

2. Deploy the relay:

   ```bash
   cd oauth-relay
   npm install
   npx wrangler deploy
   ```

   This prints your Worker's URL, e.g. `https://verso-oauth-relay.<you>.workers.dev`.

3. Optionally lock the relay to your own site instead of any origin:

   ```bash
   npx wrangler deploy --var ALLOWED_ORIGIN:"https://<you>.github.io"
   ```

   Or edit `ALLOWED_ORIGIN` in `wrangler.jsonc` and redeploy. Leaving it as
   `"*"` is fine — the relay only forwards to GitHub's device-flow endpoints,
   which are harmless to expose publicly (approval always requires the user
   to sign in on github.com and enter the code by hand).

4. In the editor's Connect repository → One-time setup, paste the Client ID
   and the deployed relay URL. Both are remembered in that browser.

## Local development

```bash
npm run dev
```

Runs on `http://localhost:8787`. Point the editor's relay URL field at that
while testing.
