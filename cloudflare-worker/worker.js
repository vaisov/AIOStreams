/**
 * Cloudflare Worker Proxy for AIOStreams
 *
 * This worker acts as a reverse proxy to your Cloud Run instance,
 * hiding the actual run.app URL from DNS lookups.
 *
 * Architecture:
 *   User → aiostreams.yourdomain.com → Cloudflare Access (IP check) → This Worker → Cloud Run
 *
 * Setup:
 * 1. Create a new Worker in Cloudflare Dashboard
 * 2. Set the CLOUD_RUN_URL secret (Settings > Variables > Add Secret)
 * 3. Deploy this code
 * 4. Add a route: aiostreams.yourdomain.com/* → this worker
 * 5. Configure Cloudflare Access policy for the domain
 */

export default {
  async fetch(request, env, ctx) {
    // Get the Cloud Run URL from environment secret
    const cloudRunUrl = env.CLOUD_RUN_URL;

    if (!cloudRunUrl) {
      return new Response('Worker misconfigured: CLOUD_RUN_URL not set', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' }
      });
    }

    try {
      // Parse the original request URL
      const url = new URL(request.url);

      // Build the Cloud Run URL
      const targetUrl = new URL(url.pathname + url.search, cloudRunUrl);

      // Clone headers and forward them
      const headers = new Headers(request.headers);

      // Add X-Forwarded headers for proper IP detection
      headers.set('X-Forwarded-Host', url.hostname);
      headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));

      // Preserve the original CF-Connecting-IP for the app
      const clientIp = request.headers.get('CF-Connecting-IP');
      if (clientIp) {
        headers.set('X-Real-IP', clientIp);
      }

      // Create the proxied request
      const proxyRequest = new Request(targetUrl.toString(), {
        method: request.method,
        headers: headers,
        body: request.body,
        redirect: 'manual', // Don't follow redirects, let the client handle them
      });

      // Fetch from Cloud Run
      const response = await fetch(proxyRequest);

      // Clone the response and return it
      const responseHeaders = new Headers(response.headers);

      // Remove headers that might cause issues
      responseHeaders.delete('cf-ray');
      responseHeaders.delete('cf-cache-status');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });

    } catch (error) {
      console.error('Proxy error:', error);
      return new Response(`Proxy error: ${error.message}`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  },
};
