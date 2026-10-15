# marklith

Image text to Markdown, in the browser. Static site, no build step. Render serves this folder as it is.

## Files

```
├── index.html            the whole app
├── support.js            runtime (do not edit)
├── src/
│   └── marklith-core.js  OCR, formatting and local storage
├── assets/
│   ├── favicon/          favicon.svg, favicon-32.png, apple-touch-icon.png, icon-192/512, maskable
│   └── og-image.png      1200×630 social sharing image
├── favicon.ico
├── site.webmanifest
├── robots.txt
├── sitemap.xml
└── render.yaml           Render static hosting and headers config
```

## Deploy
1. Push this folder to a Git repo (as the repo root).
2. On Render: New → Blueprint, pick the repo. `render.yaml` configures the rest.

## Before launch
- Replace `https://marklith.onrender.com` with the real domain in `index.html` (canonical, og:url, og:image, twitter:image, JSON-LD), `robots.txt` and `sitemap.xml`.
- Replace `[CONTACT EMAIL]` in the Privacy and Terms pages, and get both reviewed by a qualified person.
- Pages use hash routes (`#/library`), which search engines treat as one URL, so the sitemap lists only `/`.
