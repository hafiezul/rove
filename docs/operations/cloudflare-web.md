# Deploy the Rove browser app for free

Deploy the stable browser app at `https://rove.hafiezulzikry.com` and the nightly app at `https://rove-nightly.hafiezulzikry.com` with Cloudflare Workers Static Assets. These deployments contain no Worker server code or agent backend. Users pair their own running Rove environments. The two origins keep separate browser connections and settings.

Use Cloudflare's free plan. Static asset requests are [free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). You still pay for domain renewal and any coding-agent subscriptions or API usage.

## Connect your domain

1. Create a Cloudflare account.
2. Add `hafiezulzikry.com` as a website on the free plan.
3. Review the imported DNS records. Preserve existing website and email records.
4. At your domain registrar, replace the domain's nameservers with the two Cloudflare nameservers.
5. Wait until Cloudflare shows the zone as active.

The deployment uses only your custom domain. You do not need to register a `workers.dev` subdomain.

Each deployment creates its hostname's DNS record and HTTPS certificate. Do not create separate CNAMEs for `rove.hafiezulzikry.com` or `rove-nightly.hafiezulzikry.com`. If a hostname already has a DNS record, resolve the conflict before deploying. Cloudflare requires an active zone for [Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

To use another hostname, change the custom-domain `pattern` in `apps/web/wrangler.json` (stable) or `apps/web/wrangler.nightly.json` (nightly). The separate Workers are `rove-web` and `rove-web-nightly`. The workflow reads the browser app's public origin from the selected configuration.

## Configure GitHub deployment credentials

1. Find your Cloudflare account ID in the dashboard.
2. Create an API token using the **Edit Cloudflare Workers** template. Scope the account to your account and the zone to `hafiezulzikry.com`.
3. In this repository's GitHub settings, create an environment named `cloudflare-web`.
4. Add the environment secret `CLOUDFLARE_ACCOUNT_ID` with your account ID.
5. Add the environment secret `CLOUDFLARE_API_TOKEN` with your API token.
6. Restrict the environment to the deployment branch. Add a required reviewer if your GitHub plan supports that protection.

The token needs permission to edit Workers scripts and Workers routes for the target account and zone. Follow Cloudflare's [GitHub Actions authentication guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) when creating the token.

Keep the token in GitHub secrets. Do not commit it or paste it into a thread. No Clerk, relay, PlanetScale, Axiom, or Vercel credentials are needed.

## Build before deploying

The workflow must be present on the repository's default branch before GitHub offers manual dispatch.

1. Open **Actions → Cloudflare web → Run workflow**.
2. Select the branch containing the deployment changes and choose the `stable` or `nightly` channel.
3. Leave **Deploy the browser app to Cloudflare after building** unchecked.
4. Run the workflow.
5. Confirm that the build and Wrangler dry run pass.
6. Download the `cloudflare-web-stable` or `cloudflare-web-nightly` artifact if you want to inspect the deployable files.

The hosted build disables fixed backend URLs and inherited cloud settings. It also disables source maps and checks the output against Cloudflare's free asset limits.

Do not enable `ROVE_CLOUD_READY` or `ROVE_HOSTED_RELEASE_READY` for this deployment. Those variables belong to the inherited relay and Vercel paths.

## Publish the browser app

1. Run **Cloudflare web** again with the deployment checkbox enabled.
2. Approve the `cloudflare-web` environment if approval is configured.
3. Wait for the deployment job to pass.
4. Open `https://rove.hafiezulzikry.com` for stable or `https://rove-nightly.hafiezulzikry.com` for nightly.
5. Confirm that the app opens without requesting an account on an inherited cloud service.

The initial deployment can take time to provision its HTTPS certificate. Opening the website does not start an agent or connect to a backend automatically.

After the first deployment works, set the repository variable `ROVE_CLOUDFLARE_WEB_READY=true`. Published stable releases deploy the stable app; published nightlies deploy only the nightly app, without changing stable. Preview releases deploy neither. To deploy outside a release, run the workflow manually on an allowed deployment branch and select the channel.

To stop automatic deployments, unset `ROVE_CLOUDFLARE_WEB_READY`. To stop serving either app, remove its Worker and custom domain in Cloudflare. Saved connections stay in users' browsers.

## Publish the marketing site

The landing page in `apps/marketing` deploys as a separate `rove-marketing` Worker at `https://rove-code.hafiezulzikry.com`. The browser app owns all of `rove.hafiezulzikry.com`, so the two sites cannot share a hostname. To use another hostname, change the custom-domain `pattern` in `apps/marketing/wrangler.json`. The build reads the site's canonical origin from that configuration.

The workflow reuses the `cloudflare-web` environment and its secrets.

1. Open **Actions → Cloudflare marketing → Run workflow** and run it once without deploying to check the build and Wrangler dry run.
2. Run it again with the deployment checkbox enabled.
3. Open the site and confirm that `curl -fsSL https://rove-code.hafiezulzikry.com/install.sh` prints the install script.

After the first deployment works, set the repository variable `ROVE_MARKETING_RELEASE_READY=true`. Each published stable release then redeploys the site from the release commit. Nightly and preview releases do not redeploy marketing. That variable also makes the release refuse to publish while `apps/marketing` still carries upstream branding; run `node scripts/check-release-identity.mjs` to check. Download links fetch the latest release in the browser, so a new release does not need a redeploy to show up.

## Publish pull request previews

Register a free `workers.dev` subdomain in the account's Workers settings. Production keeps its custom domain and does not enable its `workers.dev` route.

Add `preview:web` to a same-repository pull request. The workflow builds the PR without deployment credentials, then uploads its static assets to a separate `rove-web-pr-<number>` Worker. Trusted base-branch jobs use the existing `cloudflare-web` environment, so its `main` branch restriction can stay in place. Fork pull requests do not deploy.

The PR comment links the preview. Pair your own HTTPS Rove environment to use it. Each new push replaces that PR's preview without changing production. Closing the PR or removing `preview:web` deletes its Worker and marks the preview removed.

If deployment fails, check the account's Worker limit and API token permissions. Previews need the same Workers script permissions as production and permission to read the account's `workers.dev` subdomain.

## Connect your own computer

Keep the Rove backend private until you are ready to expose it. The backend provides access to repositories, terminals, and installed coding agents.

1. Install a published Rove CLI or a verified staged executable and authenticate at least one provider following [the installation guide](../user/install.md#install-a-cli-host).
2. Install the persistent host on loopback:

   ```sh
   rove service install --host 127.0.0.1 --port 3773
   ```

3. Confirm that the host is running:

   ```sh
   rove service status
   ```

4. In Cloudflare, create a named [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).
5. Install and run `cloudflared` on the computer running Rove using the connector command provided by Cloudflare. Treat the connector token as a secret.
6. Add a published application route for `rove-host.hafiezulzikry.com` with service URL `http://127.0.0.1:3773`.
7. Create a one-time pairing code on the host:

   ```sh
   rove auth pairing create
   ```

8. Open `https://rove.hafiezulzikry.com` and add an environment under **Settings → Connections**.
9. Enter `https://rove-host.hafiezulzikry.com` as the host and paste the pairing code.
10. Confirm that your projects load. Start a thread and verify streaming responses from your provider.

Keep the Rove service, `cloudflared`, and the computer running while you work. Update the host with `rove update`. The static website stays available when the computer is off, but its environment is offline. Keep pairing authentication enabled. Do not give visitors a pairing code for your own computer.

Users of the public browser app connect their own environments. They do not need your tunnel or domain. A private Tailscale HTTPS endpoint also works for devices on the same tailnet. A plain HTTP LAN endpoint cannot be used from the public HTTPS app.

## Build locally without deploying

From a source checkout with dependencies installed, run:

```sh
VITE_HOSTED_APP_URL=https://rove.hafiezulzikry.com vp run build:web:hosted
vp dlx wrangler@4.147.0 deploy --config apps/web/wrangler.json --dry-run
```

The output is `apps/web/dist`. A dry run does not publish the assets or require production credentials. Normal web, desktop, and mobile builds keep their existing connection behavior.
