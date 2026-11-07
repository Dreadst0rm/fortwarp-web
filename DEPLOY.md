# FortWarp — deployment guide

Cloudflare **Workers + Static Assets**: the site in `public/` is served directly by
Cloudflare's asset layer (no Worker execution), while `worker.js` handles only
`/api/contact` and unknown paths.

## Layout

    fortwarp/
    ├── worker.js          # /api/contact (validate + send email), branded 404 fallback
    ├── wrangler.jsonc     # Worker name, assets dir, Email Sending binding
    ├── package.json       # npm run dev / deploy
    └── public/            # static site — served as-is
        ├── _headers       # security + cache headers applied to every asset response
        ├── 404.html       # branded not-found page (served by worker.js on a miss)
        ├── index.html about.html solutions.html how-it-works.html
        ├── pricing.html contact.html thanks.html
        ├── styles.css favicon.svg logo.svg og.svg
        └── robots.txt sitemap.xml

## Prerequisites

1. `fortwarp.com` is in your Cloudflare account (DNS managed by Cloudflare).
2. Node.js 20+ installed.
3. From this directory: `npm install`, then `npx wrangler login`.

## Step 1 — Onboard the sending domain (Email Service)

The form sends mail via Cloudflare's Email Sending API as `noreply@fortwarp.com`
to `ed@efortune.tech`.

1. Dashboard → **Compute → Email Service → Email Sending → Onboard Domain** → `fortwarp.com`.
2. Cloudflare adds the SPF, DKIM, DMARC and bounce-MX records for the domain; wait a few
   minutes for verification to pass. This is what authorizes `noreply@fortwarp.com` as a sender.

## Step 2 — Test locally

    npm run dev        # = npx wrangler dev

Open http://localhost:8787/ and check:

- All pages render with styles; an unknown URL shows the branded 404 page.
- Contact form → **a real email** to ed@efortune.tech (because `wrangler.jsonc` sets
  `"remote": true`), then redirect to `/thanks.html`.
- Failure paths return a branded error page: empty required fields, invalid email, etc.

To simulate mail locally instead of sending for real, remove `"remote": true` from the
`send_email` entry — wrangler will log the message and write it to a local file.

## Step 3 — Deploy

    npm run deploy     # = npx wrangler deploy

Wrangler uploads `worker.js` + everything in `public/`. You'll get a
`https://fortwarp.<account>.workers.dev` URL — smoke-test it before pointing DNS at it.

## Step 4 — Point fortwarp.com at the Worker

Workers & Pages → **fortwarp** → Settings → **Domains** → add `fortwarp.com`.

Do **not** add `www.fortwarp.com` as a second Worker domain: `www/about.html` would match
a static asset and be served directly (200 on www) without ever hitting the Worker's 301.
Instead create a redirect rule:

Rules → **Redirect Rules** → source `www.fortwarp.com/*` → target `https://fortwarp.com/$1`,
status **301**.

(The Worker also has a hostname check as a safety net in case www traffic ever reaches it.)

## Step 5 — Verify

    curl -sI https://fortwarp.com/                          # 200 + HSTS/CSP/nosniff headers
    curl -sI https://fortwarp.com/definitely-missing       # 404, branded page
    curl -sI https://www.fortwarp.com/                     # 301 → fortwarp.com
    curl -si -X POST https://fortwarp.com/api/contact \
      -d "name=Test&email=you@example.com&message=Deploy check" | head -5   # 303 → /thanks.html

Then confirm the email actually landed in ed@efortune.tech (check spam too).

## Ongoing notes

- **CSS cache busting:** pages reference `styles.css?v=2` — bump the number when you change CSS.
- **Headers:** static responses get their headers from `public/_headers`; Worker-generated
  responses (form errors, 404s) get the same set from `BASE_HEADERS` in worker.js. Keep them in sync.
- **Email hardening (optional):** restrict the binding in wrangler.jsonc so it can only send
  to your inbox and from your own sender:

      "send_email": [
        { "name": "CONTACT_EMAIL", "remote": true,
          "destination_address": "ed@efortune.tech",
          "allowed_sender_addresses": ["noreply@fortwarp.com"] }
      ]

- **Send failure = graceful degradation:** if Email Sending is down, visitors get a branded
  502 page with a direct mailto link; the form never fails silently.
- **404 design choice:** unmatched requests fall through to worker.js (no
  `not_found_handling` set), so `/api/*` is guaranteed to reach the Worker on one
  deterministic path, and the 404 page still comes from the static bundle via `env.ASSETS`.
- **`html_handling: "none"`:** Cloudflare's default (`auto-trailing-slash`) would 307
  every `/page.html` to an extensionless URL — breaking this site's canonical/og/sitemap
  URLs. With `none`, `.html` pages are served as-is; the cost is that `/` no longer maps
  to index.html automatically, so worker.js serves it explicitly. Revisit if you ever add
  a directory with an index.html (e.g. `/blog/index.html`).
- **Security disclosure files:** `/.well-known/security.txt` (RFC 9116) links to
  `security.html` and `/.well-known/pgp-key.txt`. Renew the `Expires:` date in security.txt
  yearly, and if you rotate the PGP key update both the file and the fingerprint on
  security.html. The private key lives outside the deploy dir (see chat notes) — never commit it.
