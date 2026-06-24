# Six Impossible Things

A daily painting app. One artwork per day, drawn from public-domain works across Art Nouveau, Dada, Vienna Secession, Surrealism, Impressionism, and more — with a six-color palette extracted from the painting itself.

## Running locally (browser)

Double-click `index.html`. No install needed.

## Running as a desktop app (Electron)

Requires [Node.js LTS](https://nodejs.org).

```bash
cd six-impossible-things
npm install
npm start
```

## Building installers

### Mac (.dmg)
```bash
npm install
npm run dist:mac
```
Produces `dist/Six Impossible Things-1.0.0-arm64.dmg` (Apple Silicon) and `dist/Six Impossible Things-1.0.0.dmg` (Intel).

### Windows (.exe) — via GitHub Actions
See PUBLISH.md for the full click-by-click guide. The `.github/workflows/build.yml` workflow runs both Mac and Windows builds in the cloud.

## Notes

- Paintings are sourced from Wikimedia Commons (CC0 / public domain)
- Palettes are extracted fresh each day from the actual painting pixels
- The same artist will not appear more than once in any 30-day window
- All previous paintings are saved in the Archive (link at the bottom of the app)
