import { Request, Response, NextFunction } from 'express';
import { createLogger, Env } from '@aiostreams/core';
import * as jose from 'jose';

const logger = createLogger('cf-access');

// Cache for Cloudflare's public keys (JWKS)
let cachedJWKS: jose.JSONWebKeySet | null = null;
let jwksCacheTime = 0;
const JWKS_CACHE_TTL = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Fetches Cloudflare Access public keys for JWT verification
 */
async function getCloudflareJWKS(): Promise<jose.JSONWebKeySet> {
  const now = Date.now();

  // Return cached JWKS if still valid
  if (cachedJWKS && now - jwksCacheTime < JWKS_CACHE_TTL) {
    return cachedJWKS;
  }

  const teamDomain = Env.CF_ACCESS_TEAM_DOMAIN;
  if (!teamDomain) {
    throw new Error('CF_ACCESS_TEAM_DOMAIN is not configured');
  }

  const certsUrl = `https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`;

  try {
    const response = await fetch(certsUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch Cloudflare certs: ${response.status} ${response.statusText}`
      );
    }

    const jwks = (await response.json()) as jose.JSONWebKeySet;
    cachedJWKS = jwks;
    jwksCacheTime = now;

    logger.debug('Successfully fetched and cached Cloudflare Access JWKS');
    return jwks;
  } catch (error) {
    logger.error('Failed to fetch Cloudflare Access JWKS', { error });
    throw error;
  }
}

/**
 * Verifies a Cloudflare Access JWT token
 */
async function verifyCloudflareAccessToken(
  token: string
): Promise<jose.JWTVerifyResult> {
  const teamDomain = Env.CF_ACCESS_TEAM_DOMAIN;
  const aud = Env.CF_ACCESS_AUD;

  if (!teamDomain || !aud) {
    throw new Error(
      'CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be configured'
    );
  }

  const jwks = await getCloudflareJWKS();
  const JWKS = jose.createLocalJWKSet(jwks);

  const issuer = `https://${teamDomain}.cloudflareaccess.com`;

  const result = await jose.jwtVerify(token, JWKS, {
    issuer,
    audience: aud,
  });

  return result;
}

/**
 * Checks if a path should bypass Cloudflare Access authentication
 */
function shouldBypassAuth(path: string): boolean {
  const bypassPaths = Env.CF_ACCESS_BYPASS_PATHS || [];

  for (const bypassPath of bypassPaths) {
    // Exact match
    if (path === bypassPath) {
      return true;
    }

    // Wildcard match (e.g., /api/v1/health/*)
    if (bypassPath.endsWith('*')) {
      const prefix = bypassPath.slice(0, -1);
      if (path.startsWith(prefix)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validates service token headers (CF-Access-Client-Id and CF-Access-Client-Secret)
 * This is used when the Worker injects service token credentials
 */
function validateServiceToken(
  clientId: string | undefined,
  clientSecret: string | undefined
): boolean {
  const expectedClientId = Env.CF_ACCESS_SERVICE_TOKEN_ID;
  const expectedClientSecret = Env.CF_ACCESS_SERVICE_TOKEN_SECRET;

  if (!expectedClientId || !expectedClientSecret) {
    return false;
  }

  return clientId === expectedClientId && clientSecret === expectedClientSecret;
}

/**
 * Express middleware for Cloudflare Access authentication
 *
 * When CF_ACCESS_ENABLED is true, this middleware validates requests using one of:
 * 1. CF-Access-JWT-Assertion header (from Cloudflare Access user auth)
 * 2. CF-Access-Client-Id + CF-Access-Client-Secret headers (service token auth)
 *
 * Service token auth is useful when clients (like Stremio) can't do browser login.
 * The Cloudflare Worker can inject service token headers to authenticate.
 */
export const cfAccessMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Skip if Cloudflare Access is not enabled
  if (!Env.CF_ACCESS_ENABLED) {
    return next();
  }

  // Check if path should bypass authentication
  if (shouldBypassAuth(req.path)) {
    logger.debug(`Bypassing CF Access auth for path: ${req.path}`);
    return next();
  }

  // Check for service token authentication first
  const cfAccessClientId = req.get('CF-Access-Client-Id');
  const cfAccessClientSecret = req.get('CF-Access-Client-Secret');

  if (cfAccessClientId && cfAccessClientSecret) {
    if (validateServiceToken(cfAccessClientId, cfAccessClientSecret)) {
      logger.debug('CF Access service token authentication successful', {
        path: req.path,
      });
      (req as any).cfAccessIdentity = {
        type: 'service_token',
        clientId: cfAccessClientId,
      };
      return next();
    } else {
      logger.warn('CF Access service token validation failed', {
        path: req.path,
        ip: req.requestIp || req.userIp,
      });
      return res.status(403).json({
        success: false,
        error: 'Access denied',
        detail: 'Invalid service token credentials.',
      });
    }
  }

  // Fall back to JWT authentication
  const cfAccessJwt = req.get('CF-Access-JWT-Assertion');

  if (!cfAccessJwt) {
    logger.warn('Missing authentication headers', {
      path: req.path,
      ip: req.requestIp || req.userIp,
    });

    return res.status(403).json({
      success: false,
      error: 'Access denied',
      detail:
        'This application is protected by Cloudflare Access. Please authenticate through Cloudflare Access.',
    });
  }

  try {
    // Verify the JWT
    const verifyResult = await verifyCloudflareAccessToken(cfAccessJwt);

    // Attach CF Access identity info to request for potential use downstream
    (req as any).cfAccessIdentity = {
      type: 'jwt',
      email: verifyResult.payload.email,
      sub: verifyResult.payload.sub,
      iat: verifyResult.payload.iat,
      exp: verifyResult.payload.exp,
    };

    if (Env.LOG_SENSITIVE_INFO) {
      logger.debug('CF Access JWT authentication successful', {
        email: verifyResult.payload.email,
        path: req.path,
      });
    }

    return next();
  } catch (error) {
    logger.warn('CF Access JWT verification failed', {
      path: req.path,
      ip: req.requestIp || req.userIp,
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    return res.status(403).json({
      success: false,
      error: 'Access denied',
      detail: 'Invalid or expired Cloudflare Access token.',
    });
  }
};
