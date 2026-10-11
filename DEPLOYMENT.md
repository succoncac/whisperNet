# WhisperNet — Cloudflare Workers & Custom Domain Deployment Guide

WhisperNet is engineered to run directly on **Cloudflare Workers** using **Durable Objects** (`cloudflare-worker.js` + `wrangler.toml`) for real-time WebSockets, 24-hour TTL auto-destruct, and bilateral room nuke.

---

## 1. Prerequisites
Ensure you have Node.js installed and a Cloudflare account:
```bash
npm install
```

---

## 2. Build the Production Frontend Assets
Compile the React + Tailwind CSS frontend into the `./dist` directory:
```bash
npm run build
```

---

## 3. Authenticate & Deploy to Cloudflare Workers
1. **Login to Cloudflare via Wrangler CLI:**
   ```bash
   npx wrangler login
   ```

2. **Deploy the Worker, Durable Object (`WhisperNetHub`), and Static Assets (`./dist`):**
   ```bash
   npx wrangler deploy
   ```

---

## 4. Bind to a Custom Domain on Cloudflare
You can bind WhisperNet directly to your custom domain in two ways:

### Option A: Via `wrangler.toml`
Uncomment the `[[routes]]` block in `wrangler.toml` and replace with your domain:
```toml
[[routes]]
pattern = "chat.yourdomain.com"
custom_domain = true
```
Then run:
```bash
npx wrangler deploy
```

### Option B: Via Cloudflare Dashboard
1. Open the **Cloudflare Dashboard** → **Workers & Pages** → select **`whispernet-zero-trace`**.
2. Go to **Settings** → **Domains & Routes** → click **Add** → **Custom Domain**.
3. Enter your domain (e.g., `chat.yourdomain.com`) and click **Add Custom Domain**. Cloudflare automatically provisions the DNS record and Edge SSL/TLS certificate with native WebSocket support.
