# Bibbly website

`public/index.html` is the interactive Bibbly prototype: the blueprint the apps
were built from (Live with per-reader captions, Clarity notes, Notes and
exports, Tasks, Calendar, the Bibbly Stick, Settings and the mascot). It runs
entirely in the browser. Its two libraries are served from `public/vendor/`
(htm 3.1.1 with Preact, Apache-2.0 and MIT; JSZip 3.10.1, MIT), so the site
doesn't depend on a CDN; only the fonts come from Google Fonts.

Open it locally:

```bash
npx serve apps/web/public
```

## Publishing at bibbly.io

`.github/workflows/pages.yml` publishes `public/` to GitHub Pages on every push
to `master` (or `main`) that touches this folder; you can also run it by hand
from the Actions tab.

1. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `master`, or run the **Website** workflow by hand. The site appears at `https://<owner>.github.io/<repo>/`.
3. For the custom domain, you need to own `bibbly.io`. Then:
   - Verify the domain for your account: **GitHub Settings → Pages → Add a domain**.
   - At your DNS provider, point the apex at GitHub Pages: `A` records `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153` (and `AAAA` `2606:50c0:8000::153` … `2606:50c0:8003::153`), plus a `CNAME` for `www` to `<owner>.github.io`.
   - In the repository: **Settings → Pages → Custom domain: `bibbly.io`**, then tick **Enforce HTTPS** once the certificate is issued.

With Actions-based publishing the custom domain lives in those settings, not in a `CNAME` file.
