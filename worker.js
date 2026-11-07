/**
 * FortWarp — fortwarp.com
 *
 * Static files live in ./public and are served directly by Cloudflare Assets
 * (see wrangler.jsonc) without running this Worker. This script only runs for:
 *   - POST /api/contact  → contact form: validate, email, redirect to thanks
 *   - anything else that didn't match a static file → branded 404 page
 */

// ---------------------------------------------------------------------------
// Site constants
// ---------------------------------------------------------------------------
const DOMAIN = 'fortwarp.com';
const SITE_NAME = 'FortWarp';
const PUBLIC_EMAIL = 'hello@fortwarp.com'; // shown to visitors
const INBOX = 'ed@efortune.tech';          // where form messages are delivered

// Max length per form field — mirrors the maxlength attributes in contact.html.
const FIELD_LIMITS = {
  name: 100,
  email: 200,
  company: 150,
  users: 20,
  interest: 60,
  message: 5000,
};

// Security headers. Static assets carry the same set from public/_headers,
// so every response on the site has these.
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; '),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Branded error page for contact-form failures (defaults to 400). */
function formError(message, status = 400) {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Message not sent | ${SITE_NAME}</title>
<link rel="stylesheet" href="/styles.css?v=2">
</head>
<body>
<main class="wrap" style="padding:80px 20px">
<h1>Message not sent</h1>
<p>${message}</p>
<p><a class="btn" href="/contact.html">Back to contact</a> or email <a href="mailto:${PUBLIC_EMAIL}">${PUBLIC_EMAIL}</a></p>
</main>
</body>
</html>`,
    {
      status,
      headers: { ...BASE_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}

/** Redirect to the thanks page (after a real send, or when we swallowed a bot). */
function successRedirect() {
  return new Response(null, {
    status: 303,
    headers: { ...BASE_HEADERS, location: '/thanks.html', 'cache-control': 'no-store' },
  });
}

// ---------------------------------------------------------------------------
// Contact form — POST /api/contact
// ---------------------------------------------------------------------------

async function handleContact(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: { ...BASE_HEADERS, allow: 'POST', 'content-type': 'text/plain', 'cache-control': 'no-store' },
    });
  }

  const contentType = request.headers.get('content-type') || '';
  if (!/application\/x-www-form-urlencoded|multipart\/form-data/i.test(contentType)) {
    return formError('Unsupported form encoding.', 415);
  }
  if (Number(request.headers.get('content-length') || 0) > 20_000) {
    return formError('Your message is too long.', 413);
  }

  // Only accept submissions coming from our own site (workers.dev for local dev).
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') {
    let host;
    try {
      host = new URL(origin).hostname;
    } catch {
      return formError('Cross-site submission rejected.', 403);
    }
    const trusted =
      host === DOMAIN ||
      host === `www.${DOMAIN}` ||
      host.endsWith(`.${DOMAIN}`) ||
      host.endsWith('.workers.dev');
    if (!trusted) return formError('Cross-site submission rejected.', 403);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return formError('Could not read the form.');
  }
  const field = name => (typeof form.get(name) === 'string' ? form.get(name).trim() : '');

  // Honeypot filled in → almost certainly a bot. Pretend success, send nothing.
  if (field('website')) return successRedirect();

  // Validate lengths and required fields.
  const data = {};
  for (const [name, limit] of Object.entries(FIELD_LIMITS)) {
    data[name] = field(name);
    if (data[name].length > limit) {
      return formError(`The ${name} field is too long (max ${limit} characters).`);
    }
  }
  if (!data.name || !data.email || !data.message) {
    return formError('Please fill in your name, email, and message.');
  }
  const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;
  if (!EMAIL_RE.test(data.email)) {
    return formError('Please enter a valid email address.');
  }

  // Plain-text body for the inbox.
  const lines = [
    `New contact form message from ${DOMAIN}`,
    '',
    `Name: ${data.name}`,
    `Email: ${data.email}`,
    `Company: ${data.company || '-'}`,
  ];
  if (data.users) lines.push(`Users: ${data.users}`);
  if (data.interest) lines.push(`Interest: ${data.interest}`);
  lines.push(`IP: ${request.headers.get('cf-connecting-ip') || '-'}`, '', 'Message:', data.message, '');

  try {
    await env.CONTACT_EMAIL.send({
      from: `noreply@${DOMAIN}`,
      to: INBOX,
      replyTo: data.email,
      subject: `Website contact: ${data.name}`,
      text: lines.join('\n'),
    });
  } catch (err) {
    console.error('send_email failed', err);
    return formError(
      'Sorry, we could not send your message right now. Please email us directly.',
      502,
    );
  }

  return successRedirect();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Canonical host: www → apex. (Normally a Cloudflare Redirect Rule handles
    // this before the request reaches us; this is a safety net.)
    if (url.hostname === `www.${DOMAIN}`) {
      url.hostname = DOMAIN;
      return Response.redirect(url.toString(), 301);
    }

    // Root URL → index.html. html_handling is "none" (see wrangler.jsonc), so the
    // assets layer won't map "/" for us — serve the file explicitly.
    if (url.pathname === '/') {
      return env.ASSETS.fetch('https://assets.local/index.html');
    }

    // Contact form.
    if (url.pathname === '/api/contact') return handleContact(request, env);

    // Anything else that reached the Worker didn't match a static file:
    // serve the branded 404 page from the assets bundle.
    const notFound = await env.ASSETS.fetch('https://assets.local/404.html');
    return new Response(notFound.body, {
      status: 404,
      headers: { ...BASE_HEADERS, 'cache-control': 'no-store' },
    });
  },
};
