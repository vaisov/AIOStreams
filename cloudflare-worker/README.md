# Cloudflare Worker Proxy for AIOStreams

This Cloudflare Worker acts as a reverse proxy to hide your Cloud Run URL from DNS lookups, adding an extra layer of security.

## Architecture

### With Service Token (Recommended for Stremio)

```
Stremio (Android TV)
        ↓
aiostreams.yourdomain.com
        ↓
Cloudflare Worker (injects service token headers)
        ↓
Cloud Run (hidden URL)
        ↓
AIOStreams App (verifies CF-Access-Client-Id/Secret headers)
```

### With Cloudflare Access (for browser-based clients)

```
Browser/App
        ↓
aiostreams.yourdomain.com
        ↓
Cloudflare Access (IP policy or user auth)
        ↓
Cloudflare Worker (this proxy)
        ↓
Cloud Run (hidden URL)
        ↓
AIOStreams App (verifies CF-Access-JWT-Assertion header)
```

## Why Use This?

Without the Worker proxy:
```bash
$ dig aiostreams.yourdomain.com
# Exposes: aiostreams-xyz-ew.a.run.app
```

With the Worker proxy:
```bash
$ dig aiostreams.yourdomain.com
# Shows: Cloudflare IPs (104.x.x.x) - Cloud Run URL hidden
```

## Setup Instructions

### Prerequisites

- Cloudflare account with your domain
- Cloud Run instance deployed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed

### Step 1: Install Wrangler

```bash
npm install -g wrangler
```

### Step 2: Login to Cloudflare

```bash
wrangler login
```

### Step 3: Configure the Worker

Create a local config file (gitignored):

```bash
cp wrangler.toml wrangler.local.toml
```

Edit `wrangler.local.toml` with your values:

```toml
name = "aiostreams-proxy"
main = "worker.js"
compatibility_date = "2024-01-01"

routes = [
  { pattern = "aiostreams.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

### Step 4: Set Worker Secrets

```bash
cd cloudflare-worker

# Required: Your Cloud Run URL
wrangler secret put CLOUD_RUN_URL
# Enter: https://your-service-xyz-ew.a.run.app

# Optional but recommended: Service token for Worker → Cloud Run auth
# Get these from Zero Trust Dashboard → Access → Service Auth → Service Tokens
wrangler secret put CF_ACCESS_CLIENT_ID
# Enter: your-client-id (UUID format)

wrangler secret put CF_ACCESS_CLIENT_SECRET
# Enter: your-client-secret (long random string)
```

### Step 5: Deploy

```bash
wrangler deploy --config wrangler.local.toml
```

### Step 6: Create Service Token (Recommended)

**Why service tokens?** Stremio and other non-browser apps can't do interactive Cloudflare Access login. Service tokens let the Worker authenticate without user interaction.

1. Go to **Zero Trust Dashboard** → **Access** → **Service Auth** → **Service Tokens**
2. Click **Create Service Token**
3. Name it (e.g., `aiostreams-worker`)
4. Set duration (1 year or non-expiring)
5. **IMPORTANT**: Copy both values immediately - the secret is only shown once:
   - `CF-Access-Client-Id`: (UUID format)
   - `CF-Access-Client-Secret`: (long random string)
6. Set these as Worker secrets (Step 4 above)

### Step 7: Configure AIOStreams Environment

In your Cloud Run deployment, set these environment variables:

```bash
# Enable CF Access protection
CF_ACCESS_ENABLED=true

# For service token auth (recommended for Stremio):
CF_ACCESS_SERVICE_TOKEN_ID=your-client-id-from-step-6
CF_ACCESS_SERVICE_TOKEN_SECRET=your-client-secret-from-step-6

# Paths to skip auth (health checks must be accessible)
CF_ACCESS_BYPASS_PATHS=/api/v1/health,/api/v1/status
```

**Alternative: JWT-based auth** (for browser clients with Cloudflare Access):
```bash
CF_ACCESS_ENABLED=true
CF_ACCESS_TEAM_DOMAIN=your-team-name
CF_ACCESS_AUD=your-application-aud-tag
CF_ACCESS_BYPASS_PATHS=/api/v1/health,/api/v1/status
```

Find your AUD tag in:
Zero Trust Dashboard → Access → Applications → Your App → Overview → Application Audience (AUD) Tag

## How It Works

### Service Token Flow (Recommended)

1. **Request arrives** at `aiostreams.yourdomain.com`
2. **Cloudflare Worker** receives request, injects `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers
3. **Worker** forwards to Cloud Run (URL hidden from DNS)
4. **AIOStreams app** verifies the service token headers match the configured values
   - Valid token → serves request
   - Invalid/missing → 403 Forbidden

### Cloudflare Access Flow (Browser clients)

1. **Request arrives** at `aiostreams.yourdomain.com`
2. **Cloudflare Access** checks if user is authenticated (IP policy, identity, etc.)
   - If no match → redirects to login or blocks
   - If match → adds `CF-Access-JWT-Assertion` header, forwards to Worker
3. **Worker** forwards to Cloud Run
4. **AIOStreams app** verifies the JWT
   - Valid token → serves request
   - Invalid/missing → 403 Forbidden

## Security Layers

| Layer | Blocks |
|-------|--------|
| Service Token Auth | Requests without valid Worker credentials |
| Hidden Cloud Run URL | Casual attackers who dig DNS |
| Cloudflare Access (optional) | Non-whitelisted IPs/users |

## Free Tier Limits

- **Cloudflare Workers**: 100,000 requests/day
- **Cloudflare Access**: 50 users (you only need 1 for IP-based)
- **Cloud Run**: 2 million requests/month, 180,000 vCPU-seconds

## Troubleshooting

### Worker returns 500 "CLOUD_RUN_URL not set"

```bash
wrangler secret put CLOUD_RUN_URL
# Enter your full Cloud Run URL including https://
```

### 403 from AIOStreams App

- Check `CF_ACCESS_ENABLED=true` is set
- Verify `CF_ACCESS_TEAM_DOMAIN` matches your Cloudflare team
- Verify `CF_ACCESS_AUD` matches your application's AUD tag

### Cloudflare Access blocks you

- Check your current IP: `curl ifconfig.me`
- Update the IP range in your Access policy
- Consider using a dynamic DNS updater if your IP changes frequently
