# marklith

Image text to Markdown, in the browser. Static site, no build step. Render serves this folder as it is.

## Files

```
├── index.html            the whole app
├── support.js            runtime (do not edit)
├── src/
│   ├── marklith-core.js  OCR, formatting and local storage
│   ├── marklith-fx.js    heading, paragraph and word-rotator animations (GSAP)
│   └── marklith-beam.js  hero light beam and dust (three.js)
├── vendor/               self-hosted libraries, no CDN at runtime
│   ├── fonts/            IBM Plex Sans (variable 400–600) and Plex Mono 400
│   ├── phosphor/         icon font and stylesheet
│   ├── gsap/             gsap.min.js 3.12.5
│   ├── three/            three.module.js 0.160.0
│   └── tesseract/        tesseract.js 5.1.1, worker, core (SIMD + fallback), lang/ (filled at build)
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
3. The build step downloads the English OCR data (about 3 MB) into `vendor/tesseract/lang/` once per deploy. Visitors load it from your site, not a CDN. To run locally, fetch the same file into that folder first:
   `curl -fsSL -o vendor/tesseract/lang/eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz`

## Note on index.html
`index.html` is the design file `marklith App.dc.html` with font, icon and GSAP links pointed at `vendor/`. `src/marklith-beam.js` imports three.js from `../vendor/three/`.

## Before launch
- Replace `https://marklith.onrender.com` with the real domain in `index.html` (canonical, og:url, og:image, twitter:image, JSON-LD), `robots.txt` and `sitemap.xml`.
- Replace `[CONTACT EMAIL]` in the Privacy and Terms pages, and get both reviewed by a qualified person.
- Pages use hash routes (`#/library`), which search engines treat as one URL, so the sitemap lists only `/`.

## Updates showing after a manual deploy

- `index.html`, `src/*`, `support.js` and `sitemap.xml` are served with `no-cache`, so browsers check for a new copy on every visit.
- Every script and stylesheet in `index.html` carries a `?v=` build number (currently `2026.10.28.1`). When you change any file, search `index.html` for the old number and replace every occurrence with a new one, then deploy.
- The live build number is shown at the end of the footer credits and in the `marklith-build` meta tag.
