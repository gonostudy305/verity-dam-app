-- 0053_oauth_provider.sql
-- OAuth 2.1 authorization server for the remote MCP server (Better Auth
-- `jwt()` + `@better-auth/mcp` 1.7.1). Lets MCP clients (Claude, ChatGPT,
-- VS Code, Cursor) connect with a user login + consent instead of a pasted
-- API key. API keys (mcp_api_keys) keep working unchanged.
--
-- Tables and columns mirror the plugin schemas exactly (camelCase, quoted),
-- with Better Auth's Postgres type map: string[]/json -> jsonb, ids -> uuid,
-- references default to ON DELETE CASCADE. Purely additive.

create table if not exists public."jwks" (
  id uuid primary key default gen_random_uuid(),
  "publicKey" text not null,
  "privateKey" text not null,
  "createdAt" timestamptz not null,
  "expiresAt" timestamptz,
  "alg" text,
  "crv" text
);

create table if not exists public."oauthClient" (
  id uuid primary key default gen_random_uuid(),
  "clientId" text not null unique,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean default false,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb,
  "clientCredentialsScopes" jsonb default '[]'::jsonb,
  "userId" uuid references public."user"("id") on delete cascade,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb not null,
  "postLogoutRedirectUris" jsonb,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" jsonb,
  "responseTypes" jsonb,
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean default false,
  "referenceId" text,
  "metadata" jsonb
);

create table if not exists public."oauthResource" (
  id uuid primary key default gen_random_uuid(),
  "identifier" text not null unique,
  "name" text not null,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb,
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean default false,
  "disabled" boolean default false,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer default 1,
  "metadata" jsonb
);

create table if not exists public."oauthClientResource" (
  id uuid primary key default gen_random_uuid(),
  "clientId" text not null references public."oauthClient"("clientId") on delete cascade,
  "resourceId" text not null references public."oauthResource"("identifier") on delete cascade,
  "metadata" jsonb,
  "createdAt" timestamptz
);

create table if not exists public."oauthRefreshToken" (
  id uuid primary key default gen_random_uuid(),
  "token" text not null unique,
  "clientId" text not null references public."oauthClient"("clientId") on delete cascade,
  "sessionId" uuid references public.session("id") on delete set null,
  "userId" uuid not null references public."user"("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb not null
);

create table if not exists public."oauthAccessToken" (
  id uuid primary key default gen_random_uuid(),
  "token" text not null unique,
  "clientId" text not null references public."oauthClient"("clientId") on delete cascade,
  "sessionId" uuid references public.session("id") on delete set null,
  "userId" uuid references public."user"("id") on delete cascade,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "refreshId" uuid references public."oauthRefreshToken"("id") on delete cascade,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb not null
);

create table if not exists public."oauthConsent" (
  id uuid primary key default gen_random_uuid(),
  "clientId" text not null references public."oauthClient"("clientId") on delete cascade,
  "userId" uuid references public."user"("id") on delete cascade,
  "referenceId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "scopes" jsonb not null,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);

create table if not exists public."oauthClientAssertion" (
  id uuid primary key default gen_random_uuid(),
  "expiresAt" timestamptz not null
);

create index if not exists "idx_oauthClient_userId" on public."oauthClient" ("userId");
create index if not exists "idx_oauthClientResource_clientId" on public."oauthClientResource" ("clientId");
create index if not exists "idx_oauthClientResource_resourceId" on public."oauthClientResource" ("resourceId");
create index if not exists "idx_oauthRefreshToken_clientId" on public."oauthRefreshToken" ("clientId");
create index if not exists "idx_oauthRefreshToken_sessionId" on public."oauthRefreshToken" ("sessionId");
create index if not exists "idx_oauthRefreshToken_userId" on public."oauthRefreshToken" ("userId");
create index if not exists "idx_oauthRefreshToken_authorizationCodeId" on public."oauthRefreshToken" ("authorizationCodeId");
create index if not exists "idx_oauthAccessToken_clientId" on public."oauthAccessToken" ("clientId");
create index if not exists "idx_oauthAccessToken_sessionId" on public."oauthAccessToken" ("sessionId");
create index if not exists "idx_oauthAccessToken_userId" on public."oauthAccessToken" ("userId");
create index if not exists "idx_oauthAccessToken_authorizationCodeId" on public."oauthAccessToken" ("authorizationCodeId");
create index if not exists "idx_oauthAccessToken_refreshId" on public."oauthAccessToken" ("refreshId");
create index if not exists "idx_oauthConsent_clientId" on public."oauthConsent" ("clientId");
create index if not exists "idx_oauthConsent_userId" on public."oauthConsent" ("userId");
