# White-Label Branding System Guide

YOUPI PG is built from the ground up to be 100% white-label. No hardcoded brand names, logos, or client-specific colors exist in core payment components.

---

## 1. 3-Tier Dynamic Branding Architecture

Branding is resolved hierarchically across three tiers:

```
[ Tier 1: Environment Variables (.env) ]
DEFAULT_APP_NAME="AcmePay"
DEFAULT_PRIMARY_COLOR="#2563eb"
           │
           ▼
[ Tier 2: Merchant Database Record (Admin Panel) ]
Merchant overrides (appName, primaryColor, logoUrl, customCss)
           │
           ▼
[ Tier 3: Runtime Checkout Session Resolution ]
Resolved branding = session.branding || merchant.branding || env.DEFAULT_* || 'YOUPI PG'
```

### Environment Variables Reference

| Variable                   | Default Value         | Description                                                             |
| :------------------------- | :-------------------- | :---------------------------------------------------------------------- |
| `DEFAULT_APP_NAME`         | `YOUPI PG`            | Gateway application name displayed across checkout, admin, and receipts |
| `DEFAULT_PRIMARY_COLOR`    | `#2563eb`             | Default primary brand color (hex)                                       |
| `DEFAULT_SUPPORT_EMAIL`    | `support@youpi.local` | Default support contact email                                           |
| `DEFAULT_SUPPORT_PHONE`    | `9876543210`          | Default support helpline phone number                                   |
| `DEFAULT_LOGO_URL`         | `null`                | Default brand logo image URL (uses dynamic SVG monogram if unset)       |
| `DEFAULT_TRUST_BADGE_TEXT` | unset                 | Custom trust badge label (e.g. `${DEFAULT_APP_NAME} Verified Business`) |
| `DEFAULT_FOOTER_GUARANTEE` | unset                 | Custom customer protection guarantee text in checkout footer            |
| `DEFAULT_HIDE_POWERED_BY`  | `false`               | When `true`, completely hides gateway branding from checkout page       |
| `WHATSAPP_SENDER_NAME`     | unset                 | Custom sender label prepended to WhatsApp login OTP messages            |
| `DEFAULT_MERCHANT_NAME`    | `YOUPI Demo Store`    | Initial merchant business name seeded on database migration             |
| `DEFAULT_MERCHANT_SLUG`    | `demo-store`          | Initial merchant slug seeded on first database migration                |

---

## 2. Per-Merchant Custom Branding

Every merchant can configure custom branding in the `merchants` table via the Merchant Admin or API:

```json
{
  "appName": "QuickPay Store",
  "primaryColor": "#2563eb",
  "logoUrl": "https://cdn.example.com/logo.png",
  "supportEmail": "support@example.com",
  "supportPhone": "+91 98765 43210"
}
```

### CSS Variables Injection

The Checkout Portal and Help Portal dynamically map merchant branding to native CSS custom properties:

```css
:root {
  --primary-color: {{PRIMARY_COLOR}};
  --primary-hover: /* derived brightness or hover color */;
  --card-bg: #ffffff;
  --text-main: #0f172a;
  --text-muted: #475569;
  --border-color: #cbd5e1;
}
```

---

## 3. Setting Branding via Merchant Admin

1. Open **Merchant Admin** (`http://localhost:6001`).
2. Navigate to **Settings** tab.
3. Update:
   - **Business Name:** Displays on the top header of the checkout page.
   - **Receiving UPI VPA:** The UPI receiving address encoded in generated QR codes (`upi://pay?pa=...`).
   - **Primary Color:** Custom brand hex code (e.g. `#059669` for emerald, `#7c3aed` for purple, `#dc2626` for crimson).
4. Click **Save Settings**. The changes take effect immediately across all active checkout sessions.

---

## 4. Custom Domain Routing (Nginx / Caddy Reverse Proxy)

To run YOUPI PG on production domains:

```nginx
# Checkout Portal
server {
    server_name pay.yourbrand.com;
    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

# Merchant Admin Dashboard
server {
    server_name admin.yourbrand.com;
    location / {
        proxy_pass http://127.0.0.1:6001;
        proxy_set_header Host $host;
    }
}

# Customer Payment Help Portal
server {
    server_name help.yourbrand.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
    }
}

# Central Payment Core API
server {
    server_name api-pay.yourbrand.com;
    location / {
        proxy_pass http://127.0.0.1:6100;
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
