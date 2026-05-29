# App Icons

Place your icon files here before building:

| File | Size | Usage |
|---|---|---|
| `icon-192.png` | 192 × 192 px | PWA manifest, iOS home screen (`apple-touch-icon`) |
| `icon-512.png` | 512 × 512 px | PWA manifest splash |

## How to generate icons

**Option A — Online (easiest):**
1. Go to [favicon.io/favicon-generator](https://favicon.io/favicon-generator/)
2. Set background `#4f46e5`, font color `#ffffff`, text `T`, rounded corners
3. Download and rename to `icon-192.png` / `icon-512.png`

**Option B — Design tool:**
1. Create a 1024 × 1024 master in Figma / Sketch
2. Export at 192 and 512 px
3. Ensure the design is "maskable" — keep the main element inside the central 80% safe zone

**Option C — Maskable.app:**
1. Open [maskable.app/editor](https://maskable.app/editor)
2. Design interactively and export both sizes

> For App Store submission, you'll need a 1024 × 1024 icon (no alpha channel) — export that separately.
