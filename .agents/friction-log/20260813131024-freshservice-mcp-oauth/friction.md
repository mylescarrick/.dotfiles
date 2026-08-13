---
title: 'Freshservice MCP OAuth: issuer mismatch in authorization server metadata (RFC 8414 §3.3)'
severity: 'major'
target: 'freshworks/freshservice'
---

When configuring the Freshservice MCP server (https://<domain>.freshservice.com/mcp) as a remote HTTP MCP server with OAuth discovery, the protected-resource metadata at /.well-known/oauth-protected-resource points to authorization_servers: ["https://<domain>.freshservice.com"], but the AS metadata document served at https://<domain>.freshservice.com/.well-known/oauth-authorization-server has issuer: "https://<tenant-id>.myfreshworks.com" instead of matching https://<domain>.freshservice.com. RFC 8414 §3.3 requires the issuer field to exactly match the URL the metadata was retrieved from. Strict OAuth clients (including pi-mcp-adapter) correctly reject this as an issuer mismatch and refuse to start the auth flow. Freshworks' own docs (support.freshservice.com article 50000012678) only document this working through mcp-remote (which is lenient about the mismatch) or vendor-specific connectors (Claude web Connector, Gemini Connector), not through a spec-compliant generic OAuth client. Repro: GET https://<domain>.freshservice.com/.well-known/oauth-authorization-server and compare issuer to https://<domain>.freshservice.com/.well-known/oauth-protected-resource's authorization_servers entry.
