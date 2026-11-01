# marklith

Image text to Markdown, in the browser. Plain static site: Render serves this folder as it is. The only build step on Render downloads the English OCR data.

Generated from `marklith App.dc.html` by `build/build-deploy.js` and `build/copy-binaries.js` in the design project. Do not hand-edit this folder.

## Pages
- `index.html` (the app; hash routes `#/workspace`, `#/library`, `#/workflow`, `#/design-system`, `#/privacy`, `#/terms`), `404.html`

## Files
```
├── index.html, 404.html
├── support.js                          app runtime (stays at the root; the app loads its scripts relative to it)
├── favicon.ico, site.webmanifest, robots.txt, sitemap.xml
├── render.yaml                         Render hosting and headers
├── .gitignore, README.md
└── assets/
    ├── css/
    │   ├── fonts.css                   IBM Plex @font-face
    │   └── icons.css                   Phosphor icons (trimmed to the icons in use)
    ├── fonts/
    │   ├── ibm-plex-sans-variable.woff2
    │   ├── ibm-plex-mono-regular-400.woff2
    │   └── phosphor-regular.woff2
    ├── img/
    │   └── common/
    │       ├── og-image.png            1200×630 share image
    │       └── icons/                  favicon.svg, favicon-32.png, apple-touch-icon.png, icon-192/512, maskable
    └── js/
        ├── marklith-core.js            OCR, formatting and local storage
        ├── marklith-fx.js              heading, paragraph and word-rotator animations (GSAP)
        ├── marklith-beam.js            hero light beam (three.js)
        └── vendor/
            ├── gsap.min.js             3.12.5
            ├── three.module.js         0.160.0
            └── tesseract/              5.1.1: tesseract.min.js, worker.min.js, core/, lang/ (filled on deploy)
```

## Deploy (Render)
1. Replace the repo contents with this folder (as the repo root), deleting everything that is not in it.
2. Render: New → Blueprint, pick the repo; `render.yaml` sets publish path `.`, headers and the OCR data download. Later: push, then Manual Deploy → Deploy latest commit.
3. To run locally, fetch the OCR data first:
   `curl -fsSL -o assets/js/vendor/tesseract/lang/eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz`

## Caching
- `index.html`, `/` and `sitemap.xml`: `no-cache`.
- `support.js`, `assets/css`, `assets/js`, `assets/fonts`: cached for a year. Every link carries a content hash (`?v=…`), so a changed file gets a new URL.
- The live build id is in the footer credits and the `marklith-build` meta tag.

## Before launch
- Real domain (now `https://marklith.onrender.com`): set `SITE` in `build/build-deploy.js` and rebuild.
- `[CONTACT EMAIL]` in Privacy and Terms: set `EMAIL` in the same file; get both pages reviewed by a qualified person.
