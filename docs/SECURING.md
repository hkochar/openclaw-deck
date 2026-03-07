# Securing Your Dashboard

Deck has **no built-in authentication**. By design, it assumes you're the only user and access is restricted to localhost or a private network.

If you expose Deck beyond localhost — on a LAN, VPN, or the internet — **you must add authentication** via one of the methods below.

---

## Quick Decision Guide

| Deployment | Recommended Auth | Effort |
|------------|-----------------|--------|
| Local only (`localhost:3000`) | None needed | — |
| Private network (LAN/VPN) | Tailscale or basic auth | Low |
| Internet-facing | Cloudflare Access or OAuth2 Proxy | Medium |

---

## Option 1: Tailscale (Private Mesh Network)

Best for: accessing Deck from your phone or another machine without exposing it to the internet.

1. Install Tailscale on the machine running Deck: https://tailscale.com/download
2. Install Tailscale on your client device
3. Access Deck via the Tailscale IP: `http://100.x.x.x:3000`

No reverse proxy needed. Traffic is encrypted end-to-end. Free for personal use (up to 100 devices).

---

## Option 2: Cloudflare Access (Zero-Trust Tunnel)

Best for: internet-facing access with SSO (Google, GitHub, email OTP).

1. Create a Cloudflare account and add your domain
2. Install `cloudflared` on the Deck host:
   ```bash
   brew install cloudflare/cloudflare/cloudflared
   cloudflared tunnel login
   cloudflared tunnel create deck
   ```
3. Configure the tunnel to point to `http://localhost:3000`
4. In the Cloudflare dashboard, create an Access application:
   - Application URL: your tunnel domain
   - Identity provider: Google, GitHub, or email OTP
   - Policy: allow only your email address
5. Start the tunnel:
   ```bash
   cloudflared tunnel run deck
   ```

Free tier includes 50 users.

---

## Option 3: Caddy with Basic Auth

Best for: quick setup on a private network.

```
deck.example.com {
    basicauth * {
        operator $2a$14$HASHED_PASSWORD_HERE
    }
    reverse_proxy localhost:3000
}
```

Generate a password hash: `caddy hash-password --plaintext 'your-password'`

---

## Option 4: nginx with Basic Auth

```nginx
server {
    listen 443 ssl;
    server_name deck.example.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    auth_basic "Deck Dashboard";
    auth_basic_user_file /etc/nginx/.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Generate the password file: `htpasswd -c /etc/nginx/.htpasswd operator`

---

## Option 5: OAuth2 Proxy

Best for: SSO/OIDC integration (Google, GitHub, Okta, Azure AD).

1. Run [OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/) in front of Deck
2. Configure your OAuth provider (Google, GitHub, etc.)
3. Set `--upstream=http://localhost:3000`
4. Access Deck through the proxy URL

See the [OAuth2 Proxy docs](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview) for full setup.

---

## Protect Both Ports

Both ports should be secured if exposed beyond localhost:

| Port | Service | Sensitive Data |
|------|---------|---------------|
| 3000 | Dashboard | Full telemetry, costs, agent configs, API routes |
| 18789 | Gateway | Agent control, service management, config modification |

The gateway port is equally sensitive — it can restart services, modify configs, and control agents. If you expose the dashboard, also secure gateway access by setting `OPENCLAW_GATEWAY_TOKEN` in `.env`.

---

## What NOT to Do

- **Don't expose port 3000 directly to the internet.** Deck has no authentication — anyone who can reach the port can see all your agent data, costs, and configs.
- **Don't rely on obscurity** (non-standard ports, hidden subdomains). Scanners will find it.
- **Don't store auth credentials in the Deck repo.** Keep `.htpasswd`, OAuth secrets, and tunnel configs outside the repo.

---

## Security Model

For the full security design and vulnerability reporting process, see [SECURITY.md](../SECURITY.md).

Key assumptions:
- Deck is a single-operator dashboard (no multi-user/RBAC)
- API keys are redacted in the UI via `stripSecrets()`
- SQLite queries use parameterized statements
- No user-submitted content is rendered as raw HTML

---

## Pre-Deploy Checklist

- [ ] Dashboard is not accessible from the public internet without auth
- [ ] Gateway port (18789) is not exposed or is behind auth
- [ ] `OPENCLAW_GATEWAY_TOKEN` is set in `.env`
- [ ] API keys and Discord tokens are in `.env`, not in config files
- [ ] Config files (`config/deck-config.json`) are readable only by your user (`chmod 600`)
