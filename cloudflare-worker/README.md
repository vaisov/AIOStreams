# Cloudflare Worker Proxy for AIOStreams

This Cloudflare Worker acts as a reverse proxy to hide your Cloud Run URL from DNS lookups, adding an extra layer of security.

## Architecture

```
Stremio (Android TV)
        ↓
aiostreams.yourdomain.com
        ↓
Cloudflare Access (IP-based policy - checks if your home IP)
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

### Step 4: Set the Cloud Run URL Secret

```bash
cd cloudflare-worker
wrangler secret put CLOUD_RUN_URL
# Enter: https://your-service-xyz-ew.a.run.app
```

### Step 5: Deploy

```bash
wrangler deploy --config wrangler.local.toml
```

### Step 6: Configure Cloudflare Access

1. Go to Cloudflare Zero Trust Dashboard
2. Access → Applications → Add Application
3. Select "Self-hosted"
4. Configure:
   - **Application name**: AIOStreams
   - **Session duration**: 24 hours (or longer)
   - **Application domain**: `aiostreams.yourdomain.com`
5. Add a policy:
   - **Policy name**: Allow Home IP
   - **Action**: Allow
   - **Include**: IP Ranges → Your home IP (e.g., `203.0.113.50/32`)
6. Save

### Step 7: Configure AIOStreams Environment

In your Cloud Run deployment, set these environment variables:

```bash
CF_ACCESS_ENABLED=true
CF_ACCESS_TEAM_DOMAIN=your-team-name
CF_ACCESS_AUD=your-application-aud-tag
CF_ACCESS_BYPASS_PATHS=/api/v1/health
```

Find your AUD tag in:
Zero Trust Dashboard → Access → Applications → Your App → Overview → Application Audience (AUD) Tag

## How It Works

1. **Request arrives** at `aiostreams.yourdomain.com`
2. **Cloudflare Access** checks if IP matches your policy (your home IP)
   - If no match → blocked, never reaches Worker
   - If match → adds `CF-Access-JWT-Assertion` header, forwards to Worker
3. **Worker** receives request, forwards to Cloud Run (URL hidden from DNS)
4. **AIOStreams app** verifies the `CF-Access-JWT-Assertion` JWT
   - Valid token → serves request
   - Invalid/missing → 403 Forbidden

## Security Layers

| Layer | Blocks |
|-------|--------|
| Cloudflare Access | Non-whitelisted IPs |
| Hidden Cloud Run URL | Casual attackers who dig DNS |
| JWT Verification | Direct Cloud Run access attempts |

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
