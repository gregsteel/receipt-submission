# Receipt Submission — Specification

Status: current as of 17 August 2026. Describes behaviour as built, not aspiration.

`README.md` covers setup and operation. This document covers what the system is,
how it behaves, and why it is shaped the way it is. Keep it accurate: whenever
behaviour, architecture, auth, APIs, data model, or configuration change, update
this file in the same change.

---

## 1. Purpose and scope

A single-user (small-allowlist) system for getting paper receipts into a
machine-readable archive with as little friction as possible:

1. Point an iPhone at a receipt. It is detected, deskewed, cleaned up and
   uploaded without any manual cropping.
2. The server stores the JPEG on disk and a row in SQLite.
3. Claude Cowork reads and annotates receipts over MCP.

The governing constraint is that **a captured receipt must never be lost**, even
if the server is down, the network is absent, or the sign-in has expired. Section
5 exists entirely to satisfy that constraint.

### Non-goals

- Multi-tenant use. Authorisation is a hardcoded email allowlist.
- Browser capture. Removed deliberately; see §8.
- Device-side email (Resend or otherwise). Offline uploads are held on the phone
  and retried; the user is told clearly, with a count, both after Save and on
  Home. See §5.
- OCR or accounting logic on the server. The server stores bytes and metadata;
  interpretation happens in Cowork and comes back as opaque JSON (§6.2).
- Android or iPad. The iOS target is iPhone-only, portrait-only.

---

## 2. Components

| Component | Technology | Location |
|---|---|---|
| iPhone app | Swift 5, SwiftUI, AVFoundation, Vision, iOS 17+ | `ios/` |
| Web/API server | Next.js 16.3.0, React 19.2.8, Node 22 | `src/` |
| Datastore | `node:sqlite` (built-in) + JPEGs on disk | `$DATA_DIR` |
| Analysis client | Claude Cowork over remote MCP | — |

The server is stateless apart from `$DATA_DIR`; it runs as one container on a
home server behind an HTTPS reverse proxy.

### 2.1 Topology

```
 iPhone (Receipts.app)                          Claude Cowork
   │                                                  │
   │ POST /api/send            ┌──────────────────┐   │ POST /mcp
   │ (session JWT, Bearer)     │  Next.js :8788   │   │ (OAuth access token)
   ├──────────────────────────▶│                  │◀──┤
   │                           │  $DATA_DIR       │
   │ on failure:               │   receipts.db    │
   │ hold locally              │   files/*.jpg    │
   ▼                           └──────────────────┘
 Documents/HeldReceipts/  ── retried until accepted
```

There is no off-device email path. A failed upload is held on the phone and
surfaced clearly in the UI until the server accepts it.

---

## 3. Actors and authorisation

Two unrelated credential types, because the two callers have different threat
models and lifetimes: humans get long-lived session JWTs via Google sign-in,
and Claude Cowork gets short-lived MCP OAuth access tokens. There is no
separate machine credential — the receipts REST API was retired once MCP
covered everything (§8).

### 3.1 Human users — Google OAuth → session JWT

Sign-in is Google OAuth 2.0 (`openid email profile`, `access_type=online`,
`prompt=select_account`). The email must appear in `ALLOWED_USERS`
(comma-separated, compared lowercased). An empty or missing allowlist denies
everyone rather than allowing everyone.

The session is a self-contained **HS256 JWT** signed with `SESSION_SECRET` via
`jose` — there is no server-side session table. Claims are `email`, optional
`name` and `picture`, plus `iat`/`exp`. Lifetime is **400 days**, chosen so the
phone effectively never has to re-authenticate; revocation is by removing the
address from `ALLOWED_USERS`, which `getSession()` re-checks on every request.

CSRF for the OAuth round trip is a second short-lived JWT (`purpose: "oauth"`,
10 minutes) held in the `oauth_state` cookie and compared against the returned
`state` parameter.

Two delivery mechanisms for the same JWT:

- **Browser** — `session` cookie: `httpOnly`, `sameSite=lax`, `path=/`, and
  `secure` only when `GOOGLE_REDIRECT_URI` is `https://` (so plain-HTTP local
  Docker still works).
- **iPhone** — `GET /auth/google?native=1` sets an `oauth_native=1` marker
  cookie; the callback then redirects to `NATIVE_APP_REDIRECT` (default
  `receipts://auth`) with the JWT in a `token` query parameter, and sets no
  cookie. The app presents this as `Authorization: Bearer <jwt>`.

`getSession(request)` accepts either: it prefers a `Bearer` token from the
`Authorization` header and falls back to the `session` cookie.

### 3.2 MCP OAuth (Cowork / Claude.ai)

Claude's custom-connector UI only offers OAuth Client ID/Secret, not a Bearer
header. Cowork therefore authenticates to `/mcp` with the MCP authorization
spec (RFC 9728 protected-resource metadata + RFC 8414 authorization-server
metadata + authorization code + PKCE S256).

Unauthenticated `/mcp` calls return `401` with
`WWW-Authenticate: Bearer … resource_metadata="https://<host>/.well-known/oauth-protected-resource/mcp"`.
Claude then discovers:

| Path | Document |
|---|---|
| `GET /.well-known/oauth-protected-resource` and `…/mcp` | resource = `https://<host>/mcp`, this origin as authorization server |
| `GET /.well-known/oauth-authorization-server` | issuer, `/oauth/authorize`, `/oauth/token`, `/oauth/register`, S256 PKCE, CIMD + DCR |

Client registration is **CIMD first** (`client_id_metadata_document_supported`
and `token_endpoint_auth_methods_supported` includes `none`). Claude's
`client_id` is an HTTPS metadata URL; the server fetches it, requires
`client_id` to match the URL, and checks `redirect_uri` against that document
(loopback ports ignored per RFC 8252, including `localhost` for Claude Code).
`POST /oauth/register` remains as Dynamic Client Registration fallback.

`GET /oauth/authorize` requires an allowlisted Google session. Unsigned users
are sent through `/auth/google?next=/oauth/authorize?…` and returned to the
consent screen. The consent page shows the **client_id hostname** (not a
self-asserted name) and the redirect hostname; loopback redirects get an extra
warning. Allow issues a one-time authorization code (JWT, 10 minutes) and
`303`s to the client. Deny returns `error=access_denied`.

`POST /oauth/token` accepts `application/x-www-form-urlencoded` for
`authorization_code` (PKCE S256) and `refresh_token`. Access tokens are HS256
JWTs (`purpose: mcp_access`, `aud` = the MCP resource URL, 60 minutes).
Refresh tokens rotate: the previous `jti` is deleted from SQLite before a new
pair is issued. Session JWTs (`purpose: session`, or no purpose for tokens
issued before this field existed) are not accepted as MCP access tokens, and
MCP tokens are not accepted as app sessions.

OAuth clients, unused auth-code ids, and refresh-token ids live in the same
SQLite file as receipts (`oauth_clients`, `oauth_auth_codes`,
`oauth_refresh_tokens`).

### 3.3 Request gate

`src/proxy.ts` (Next.js 16 replaces `middleware.ts` with `proxy.ts`) runs ahead
of all routes. Paths under `/login`, `/auth/`, `/health`, `/api/health`,
`/mcp`, `/oauth/`, `/.well-known/`, `/manifest.webmanifest`, `/icon` and
`/apple-icon` pass through — for the MCP prefix this only defers the decision;
`/mcp` itself still requires a valid MCP access token. `GET /api/receipts/:id/image`
gets the same "defers the decision" treatment via a dedicated regex
(`PUBLIC_PATTERNS`, not a prefix — every other `/api/receipts/:id/*` route
stays behind the blanket session-or-Bearer check below): the route itself
requires a valid session *or* a receipt-scoped `image-access` token (§7, §8).
This exists because `manager-mcp` fetches `get_receipt`'s `imageUrl`
unauthenticated — no cookie, no `Bearer` header — which the blanket check
would otherwise reject before the route's own token verification ever ran
(exactly this bug shipped once: the route-level check was correct in
isolation but unreachable until this exemption was added).

Everything else requires a valid allowlisted `session` cookie. Failing that, an
`/api/*` path with any `Bearer` header is allowed through for its handler to
judge, other `/api/*` paths get `401`, and page routes redirect to `/login`.

### 3.4 Authorisation matrix

| Path | Credential |
|---|---|
| `POST /api/send` | Session JWT (cookie or Bearer) |
| `GET /api/receipts/:id/image` | Session JWT, or a receipt-scoped image-access token (`?token=`) |
| `POST /mcp` | MCP OAuth access token |
| `GET /.well-known/oauth-*`, `POST /oauth/register`, `POST /oauth/token` | None |
| `GET /oauth/authorize`, `POST /oauth/approve` | Google session (consent) |
| `GET /` | Session cookie |
| `/login`, `/auth/*`, `/health`, `/api/health`, icons, manifest | None |

### 3.5 iOS server configuration

There is no built-in or build-time default server — `APIClient.baseURL`
(`ios/Receipts/APIClient.swift`) reads only a `UserDefaults` value the user
enters themselves. On first launch, `ContentView` renders
`ServerSettingsView(isInitialSetup: true)` instead of the camera/home screen
until one is saved; that mode has no Cancel button and no way to dismiss
without entering a URL. A gear icon on the home screen reopens the same view
(`isInitialSetup: false`) to change or, via **Remove server**, clear it —
clearing drops the app back into first-run setup.

Because the session JWT is only valid against the server that issued it,
saving a different URL or removing it always calls `SessionStore.signOut()`.

The one exception is CI-built installs (§10.3): `ReceiptsApp.init()` calls
`APIClient.bootstrapDefaultServerIfNeeded()`, which — exactly once per
install, tracked by a separate `UserDefaults` flag so it never re-fires —
seeds `baseURL` from an optional `RECEIPTS_DEFAULT_SERVER_URL` Info.plist
key, present only when `ci_post_clone.sh` injected it. That skips first-run
setup entirely for that build. Removing the server afterwards still sticks;
it is not re-seeded on a later launch. Builds without the CI variable (local
builds, other forks) are unaffected — `baseURL` stays `nil` until the user
enters one, same as before.

---

## 4. Capture pipeline (iOS)

Capture is a purpose-built AVFoundation camera rather than VisionKit's
`VNDocumentCameraViewController`. VisionKit framed receipts well but owned the
post-capture flow — it returned to scanning instead of surrendering to a review
screen — and handed back extended-range images that encoded to near-black JPEGs.
The custom camera exists to own the capture lifecycle and the colour pipeline.

### 4.1 Live viewfinder — `ios/Receipts/ScanCameraView.swift`

An `AVCaptureSession` at `.photo` preset on the back wide-angle camera, with
continuous autofocus and auto-exposure, feeding two outputs:

- `AVCapturePhotoOutput` with quality prioritisation, for the still.
- `AVCaptureVideoDataOutput` (32BGRA, late frames discarded) for live detection.
  Critically, `automaticallyConfiguresOutputBufferDimensions = false` and
  `deliversPreviewSizedOutputBuffers = true`: Vision analyses preview-sized
  buffers, not full-resolution ones. Without this the preview is visibly
  unresponsive.

Detection runs `VNDetectDocumentSegmentationRequest` throttled to **12 Hz**,
skipped entirely while a previous frame is in flight or a capture is underway.
Observations below **0.3** confidence are discarded.

Preview, video-data, and photo connections all use `videoRotationAngle = 90`, so
live frames and stills are already upright. Vision runs with orientation `.up`,
keeping its corners in that same portrait space. The overlay maps each corner
into the letterboxed video rect (`layerRectConverted(fromMetadataOutputRect:)`
of the unit square, with Vision's bottom-left origin flipped to top-left). It
does **not** use `layerPointConverted(fromCaptureDevicePoint:)`, which speaks
sensor-space coordinates and was the cause of the skewed/partial overlay when
Vision results were already upright.

Corners are held in a `Quad` (Vision normalised space, origin bottom-left) and
smoothed with an exponential moving average at factor **0.4**, but only when the
new observation is within **0.2** drift of the current one — a larger jump means
a different sheet, so the quad is replaced outright and stability resets. Drift
is the maximum per-corner Euclidean distance. Up to **4** consecutive missed
frames are tolerated before the overlay clears, so a brief detection dropout
does not make the outline flicker.

The preview uses `videoGravity = .resizeAspect`, so the 4:3 frame is letterboxed
with black bars rather than cropped to fill a tall screen. Aspect-fill hid the
sides of what the still would actually capture, meaning the user framed against a
narrower view than the photo taken. All chrome lives in the bars: an `xmark`
close button and the Auto/Manual toggle at the top, the torch and shutter at the
bottom.

The overlay is a single `CAShapeLayer` filling the detected quad with `systemTeal`
at 28% behind a 5 pt stroke, so the sheet is highlighted rather than the rest of
the frame being dimmed — an earlier 40% black mask outside the quad muddied the
whole scene and made the outline read as a stray box. Path changes are
interpolated over one detection interval inside a `CATransaction`, because a shape
layer otherwise snaps between paths and 12 Hz updates visibly step. The layer
fades in and out over 0.18 s rather than appearing abruptly.

Hints sit in a translucent black pill so they stay legible over both the
letterbox bar and the frame: `Move closer` below **0.12** normalised area,
`Move back` above **0.92**, `Receipt found — hold steady` when usable but not yet
stable, and `Tap to capture` in manual mode.

### 4.2 Auto-capture

In Auto mode (the default; a capsule toggle switches to Manual), a capture fires
when the quad has been usable — area between **0.12** and **0.92** — and within
**0.012** drift for **6** consecutive detections, roughly half a second at 12 Hz.
Firing gives medium impact haptics and a white flash at 0.85 alpha fading over
0.25 s, matching the manual shutter exactly.

That half second is shown, not just waited out: a teal ring winds clockwise from
the top around the shutter as `steadyFrames` accumulates, so the capture is
visible coming rather than firing unannounced. It is hidden in Manual mode and
unwinds whenever stability resets.

One capture ends the camera session and returns to the review screen. There is
no multi-shot mode inside the camera; extra pages are explicit user actions.

### 4.3 Processing — `ios/Receipts/ReceiptImage.swift`

`process(_:)` runs off the main thread, in order:

1. **Normalise orientation.** Pass through if already `.up`; otherwise
   re-rasterise opaque at scale 1 with `preferredRange = .standard`. This is
   where extended-range (HDR) capture data is flattened, and it is what fixed
   the near-black JPEGs.
2. **Detect the document** again, stricter than the live pass — confidence above
   **0.4**, area between **0.12** and **0.98**. If nothing qualifies, the frame
   is used uncropped rather than mis-cropped.
3. **Perspective-correct** to a rectangle via `CIPerspectiveCorrection` with
   `crop = true`.
4. **Desaturate** — receipts carry no useful colour, and grayscale makes the
   level maths below predictable.
5. **Auto-level.** Build a 256-bin BT.709 luma histogram from a thumbnail whose
   longest side is 120 px, take the **5th** percentile as black and the **93rd**
   as white, then widen to at least 32 levels apart if the frame is flat.
   Stretch with `CIColorMatrix` (`scale = 255 / (white - black)`), then apply
   contrast **1.18** and brightness **+0.02**.

The `CIContext` pins both working and output colour space to sRGB, so the
histogram is measured in the same space the correction is applied in.

Encoding downscales the longest edge to **1800 px** and JPEG-compresses at
**0.72** (then 0.55, then 0.4) so the file stays under **700 KB**. Full-resolution
stills at quality 0.85 were several megabytes and nginx’s default 1 MB body
limit rejected them with **413**. The home-gateway receipts vhost now sets
`client_max_body_size 10m` (the API allows 8 MB). 1800 px is still more than
enough to read a thermal receipt. Receipts already held on the phone from before
downscaling are re-encoded on retry.

### 4.4 Review — `ios/Receipts/ContentView.swift`

Home shows a single 184 pt circular **Capture Receipt** button in the app accent
`#0D6E6E`. After a capture the app switches to review, where pages are a paged
`TabView` and the actions are **Discard**, **Retake** (replaces the visible
page), **Add page** (appends), and **Save**.

Each page is a `CapturedPage { id, capturedAt, image }`. `capturedAt` is stamped
when the shutter fires, not when Save is tapped, so it survives an arbitrarily
long review, a retake, and any amount of time held offline. Every downstream
identifier derives from it (§5.3).

Save uploads each page independently. Pages are cleared only if nothing failed
outright, so a hard failure leaves the images on screen.

**Status after Save** (§5.2):

| Outcome | Message |
|---|---|
| All uploaded | `Saved.` / `Saved N pages.` |
| Held for retry | `{reason}. N receipt(s) couldn't be submitted and will be retried.` |
| Encode / disk failure | First failure string (e.g. `Could not encode that photo.`) |

`{reason}` is one of `Couldn't reach the server`, `Sign-in expired`, or
`Server refused the upload`.

**Home dashboard** while anything is held: the same
`N receipt(s) couldn't be submitted and will be retried` line (with count), the
latest upload error, and two full-width rounded accent buttons — **Retry now** /
**Retrying…** and **View waiting receipts** — matching the Capture Receipt
accent. There is no email fallback and no silent `Saved.` when the server was
unreachable. When the held queue drains to empty (manual or automatic retry),
any leftover hold/error status under Capture is cleared so the dashboard does
not keep showing a stale outage message.

---

## 5. Submission and offline resilience

### 5.1 Normal path

`POST /api/send` as `multipart/form-data` with a `capturedAt` field and a
`receipt` file, bearing the session JWT, 30 s timeout. On `2xx` the page is done
and the user sees `Saved.`

### 5.2 Failure path

Any upload failure — connection refused, timeout, DNS failure, `401`, `500` —
triggers a local hold:

1. **Persist.** The JPEG is written to `Documents/HeldReceipts/<uuid>.jpg` with a
   `HeldReceipt { id, capturedAt, attempts, lastError }` entry appended to
   `index.json` alongside it. If this write also fails, the page is reported as
   failed and left on screen — the only case where the user must act again.
2. **Tell the user.** After Save:
   `Couldn't reach the server. 1 receipt couldn't be submitted and will be retried.`
   (or `Sign-in expired` / `Server refused the upload` as the leading clause).
3. **Retry** until the server accepts it, then delete the local copy.

Home keeps the same message with the waiting count and rounded **Retry now** /
**View waiting receipts** buttons whenever anything is held. The latest upload
error is shown under that line (e.g. `Sign-in expired.` or `The scan is too
large for the server.`). HTML error pages from nginx are not shown. **Retry
now** also writes a status line so a silent failure can no longer hide; on
full success it shows `Saved.` / `Saved N receipts.` Background and
foreground auto-retries that empty the queue clear any prior hold/error
status on Home. **View waiting receipts** opens a sheet (`HeldReceiptsView`)
listing each held item with thumbnail, capture time, attempt count, and last
error. Swipe to delete, open for a full-size preview with **Remove from
phone**, or **Clear all**. Removal deletes the JPEG and index entry; that
receipt will not be uploaded. Successful uploads and held receipts can both
appear in one status when a multi-page Save partially fails.

A common stuck-retry case is a session JWT the server no longer accepts (secret
rotated, or sign-in from an older deploy): every `/api/send` returns `401`
even though the token is still in `UserDefaults`. The app does not require a
manual sign-out to recover from this: any `401` — from a direct Save, from
**Retry now**, or from a background/foreground auto-retry — calls
`SessionStore.expireSession()`, which clears the token exactly like
`signOut()` does and sets it as the status message. The next time Home
renders it shows the **Sign in with Google** button directly; the user signs
in once and taps **Retry now** to drain the queue. There is no scenario where
they need to tap **Sign out** first — that button now exists only for a
deliberate, voluntary sign-out.

`APIClient.UploadError` carries a nil `status` when no reply arrived at all,
which is what separates a genuine outage from a server that answered with a
rejection.

### 5.3 Capture-time filenames

A held receipt may upload days later, so the phone sends `capturedAt` as local
wall-clock time with an explicit offset (`2026-08-17T08:41:23+10:00`). The
server reads those fields with a regex rather than parsing to a `Date`, so the
stored filename stays `receipt_2026-08-17_08-41-23.jpg` and matches when the
receipt was taken. A missing or malformed `capturedAt` falls back to server time.
`ReceiptStamp` in `APIClient.swift` builds both the wire value and the client
filename.

### 5.4 Retry schedule

`retryHeld()` walks the queue, re-uploading each entry and incrementing
`attempts`. On success it deletes the local files. A re-entrancy guard prevents
overlapping runs.

| Trigger | Timing |
|---|---|
| App launch | Immediately |
| Return to foreground | On `scenePhase == .active` |
| While app is open | Every 60 s |
| Background app refresh | `<bundle id>.retry`, no earlier than 15 min |
| Manual | **Retry now** on Home |

Background refresh is opportunistic — iOS decides whether and when to run it —
so it is a bonus rather than a guarantee. Opening the app is the reliable
trigger, which is why the waiting count is surfaced on Home. This requires
`UIBackgroundModes: fetch` and `BGTaskSchedulerPermittedIdentifiers` in
`Info.plist`.

Retries are unbounded and never give up. A permanently rejected receipt (say a
`400` for a non-image) would retry indefinitely, which is cheap at one request
per minute and strictly preferable to discarding an image. Oversized scans that
hit nginx's 413 are re-encoded smaller on the next retry.

---

## 6. Data model

### 6.1 Layout

`DATA_DIR` (default `{cwd}/data`, `/app/data` in Docker) contains
`receipts.db` and `files/<uuid>.jpg`. Images are always written with a `.jpg`
extension regardless of declared MIME type. SQLite runs in WAL mode with one
connection cached on `globalThis` so dev hot-reload does not leak handles.

### 6.2 Schema

Single table `receipts`, with an index on `created_at`:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | TEXT | no | Primary key, `randomUUID()`; also the image filename |
| `created_at` | TEXT | no | ISO-8601, set at insert — **upload** time, not capture time |
| `submitted_by` | TEXT | no | Email from the session |
| `filename` | TEXT | no | `receipt_<stamp>.jpg`, derived from capture time |
| `mime_type` | TEXT | no | Defaults to `image/jpeg` |
| `size_bytes` | INTEGER | no | |
| `analysis_json` | TEXT | yes | Opaque JSON from Cowork |
| `analysed_at` | TEXT | yes | ISO-8601, set when analysis is saved |
| `processed_at` | TEXT | yes | ISO-8601, set when Cowork marks the receipt processed downstream |

`created_at` and `filename` can disagree for a receipt that was held offline:
the row records when it arrived, the filename when it was taken. Capture time is
deliberately not written to a column of its own — nothing consumes it yet, and
the filename already carries it.

`analysis_json` is whatever Cowork sends, stringified without validation —
but `save_analysis`'s `analysis` argument has no declared type (§8), and
Cowork has been observed passing it as an already-JSON-stringified string
rather than a native object. `saveAnalysis` (`src/lib/receipts-store.ts`)
detects that (`normalizeAnalysisJson`: if `analysis` is a string that itself
parses as JSON, store it as-is) so it isn't re-stringified into
double-encoded JSON — a bug that previously made `JSON.parse` yield a string
instead of an object on read, which `src/lib/analysis.ts` silently treated
as unparseable and fell back to all-blank fields. `parseStoredJson` in that
same file unwraps up to three layers defensively (self-healing already-
corrupted rows, not just preventing new ones) before either `parseAnalysis`
or `mergeAnalysis` looks at the result.

`src/lib/analysis.ts` — used only by the review page (§9.1), not by `/mcp`
— reads the parsed object leniently (aliasing `vendor`/`merchant`/`store`,
`total`/`grandTotal`/`amount`,
`reference`/`referenceNumber`/`invoiceNumber`/`receiptNumber`/`receiptNo`,
`items`/`lineItems`/`line_items`, and per-item
`description`/`amount`/`category` aliases; a numeric-looking `reference` is
coerced to a string rather than dropped, since a value like `"0020012364141"`
is invalid JSON as a bare number literal — leading zeros aren't allowed — so
a model treating it as numeric would otherwise silently lose them) and
writes back a stable shape: `{ vendor, date, total, currency, reference,
notes, items: [{ description, amount, category }], reviewedBy, reviewedAt,
...whatever else was already there }`. `confidence`/`confidenceReason` — set
by Cowork's own task instructions (`CLAUDE_COWORK_TASK.md`, not part of this
repo's contract) — are read the same lenient way and shown on the review
page and receipts list as why a receipt needs a human look, but are
read-only: never part of the edited/saved shape, preserved only via the
`...base` spread. `reference` is the invoice/receipt number printed on the
paper receipt itself (distinct from the row's own `id`) — worth capturing
because
Manager's own purchase invoices have a `Reference` field, and it also makes
a better `search_term` for `attach_receipt_to_purchase_invoice` in the
`manager-mcp` fork than `Description` (more likely to be unique). Keys the
page doesn't recognise are preserved untouched on save.

`processed_at` was added after the table already existed in production, so
`openDb()` checks `PRAGMA table_info(receipts)` and runs `ALTER TABLE ...
ADD COLUMN` on first connect if it's missing, rather than relying on
`CREATE TABLE IF NOT EXISTS` (which doesn't alter existing tables).

MCP OAuth adds three tables in the same database: `oauth_clients` (DCR
registrations), `oauth_auth_codes` (one-time code ids), and
`oauth_refresh_tokens` (rotating refresh `jti`s).

### 6.3 Store operations

`src/lib/receipts-store.ts` exports `saveReceipt`, `listReceipts`, `getReceipt`,
`readReceiptImage`, `saveAnalysis`, `markProcessed`, `setProcessed` and
`deleteReceipt`. `markProcessed` is `setProcessed(id, true)`;
`setProcessed(id, false)` clears `processed_at` back to `NULL` and exists
only for the review UI's manual override (§9.2) — the MCP surface still only
ever sets it, never clears it. `deleteReceipt` removes the row and unlinks
its JPEG (best-effort — a missing file doesn't fail the call) and has no
opinion on whether the receipt is processed; that guard lives in the API
route (§7), not the store.

`saveReceipt` writes the file first and unlinks it if the insert fails, so there
are no orphaned files. `listReceipts` filters on `since`/`until` against
`created_at`, on `analysed_at IS NULL` and on `processed_at IS NULL`, orders by
`created_at DESC`, and limits to 50 by default, clamped to 1–200.

---

## 7. HTTP API

All handlers run on the Node runtime. Errors are `{ error: string }`.

### `POST /api/send`

Session JWT. `multipart/form-data`: `receipt` (required image file) and
`capturedAt` (optional, §5.3). Rejects an empty or absent file, anything over
**8 MB**, and non-image content types, all with `400`. Returns
`{ ok: true, id, createdAt }`.

### `GET /api/receipts/:id/image`, `POST /api/receipts/:id/review`, `POST /api/receipts/:id/status`, `DELETE /api/receipts/:id`

Session JWT (cookie or Bearer) **or**, for `GET .../image` only, a
`?token=` query param verified by `verifyImageAccessToken` against that same
receipt id (§8) — either is sufficient, checked in parallel. Back the review
page (§9.2) and receipts list (§9.1), not part of the MCP surface (the
image route's token path exists for `get_receipt`'s `imageUrl`, fetched by
an external MCP server, not by Cowork itself). `GET .../image` streams the
stored JPEG (also usable directly as a download link — the browser names
the file from the response, so callers wanting the original filename set
`download=` on the `<a>`, as the review page does). `POST .../review` takes
`{ vendor, date,
total, currency, reference, notes, items: [{ description, amount, category }] }`,
requires at least one item, and writes it through `mergeAnalysis` (§6.2) via
the same `saveAnalysis` store function `save_analysis` uses. It deliberately
never calls `markProcessed` — the point of the page is to finalise the split
so Cowork picks the receipt back up as still-unprocessed on its next run and
loads it into Manager itself; Cowork remains the only caller that sets
`processed_at` as part of its normal flow. `POST .../status` takes
`{ processed: boolean }` and calls `setProcessed` directly — a manual
override for the human (undo a premature `mark_processed`, or hand-clear one
Cowork missed) that bypasses that flow entirely. Both POST routes return
`{ ok: true, receipt }`. `DELETE` calls `deleteReceipt` and returns
`{ ok: true }`, but refuses (`409`) if `processed_at` is set — mirrors the
review page, which only shows its Delete button on unprocessed receipts; mark
one unprocessed first (via the status toggle) if it genuinely needs deleting
after Cowork has already touched it.

### `GET /api/health`, `GET /health`

Unauthenticated. `{ ok: true }` and plain-text `ok` respectively; the latter is
the Docker healthcheck target.

### Auth routes

`GET /auth/google` (`?native=1` for the iOS flow), `GET /auth/google/callback`,
and `GET|POST /auth/logout` (303 to `/login`, clearing the cookie).

---

## 8. MCP interface

`POST /mcp` speaks JSON-RPC 2.0 over plain HTTP POST — no SSE, no streaming —
which is sufficient for Cowork's remote-connector support and keeps the server
stateless. Protocol version defaults to `2025-03-26`; server identity is
`receipts` v`0.1.0`. Responses carry a fixed `mcp-session-id: receipts`.
`initialize`, `tools/list`, `tools/call` and `ping` are handled, arrays are
treated as batches, notifications return `202`, and unknown methods return
`-32601`. `GET` returns `405`. Unauthenticated calls return `401` with a
`WWW-Authenticate` resource-metadata pointer so Claude can start OAuth.

Four tools:

- **`list_receipts`** — optional `since`, `until`, `unanalysed`, `unprocessed`,
  `limit` (1–200, default 50). Returns the matching records as JSON text.
- **`get_receipt`** — required `id`. Returns the record as JSON text *and* the
  JPEG as base64 image content, so the model can read the receipt in one call.
  The JSON also carries `imageUrl`: `{appOrigin}/api/receipts/:id/image?token=…`,
  a signed, unauthenticated, 10-minute-TTL link to the same JPEG
  (`src/lib/auth/image-token.ts`, same `SESSION_SECRET`/`jose` HS256 pattern
  as session and OAuth-state tokens, `purpose: "image-access"` scoped to that
  one receipt id). Exists because Cowork can *view* the image content block
  but can't read its base64 back out as text to hand to an unrelated MCP
  server (e.g. `manager-mcp`'s `attach_receipt_to_purchase_invoice`), and has
  no filesystem to stage a file on either — any caller holding the URL,
  including one with no knowledge of this app's auth model, can fetch the
  bytes with a plain `GET`. `GET /api/receipts/:id/image` (§7) accepts this
  token as an alternative to session auth, scoped to that one id; the review
  page keeps using the session path, unchanged. `imageUrl` is additive — the
  image content block remains for Cowork's own analysis step.
- **`save_analysis`** — required `id` and `analysis` (any JSON). Persists it and
  returns the updated record.
- **`mark_processed`** — required `id`. Sets `processed_at` and returns the
  updated record; does not delete anything. Intended for use once a receipt
  has been recorded downstream (e.g. in an accounting system).

Add it in Cowork as a custom connector at `https://<host>/mcp`. Leave OAuth
Client ID and Client Secret empty. After Add, click **Connect**, sign in with
Google if needed, and Allow on the consent screen.

---

## 9. Web application

The browser no longer captures anything. An OpenCV.js pipeline in a web worker
was tried and abandoned: it failed to find receipt edges reliably against busy
backgrounds and returned uncropped frames often enough to be useless, and
maintaining a custom OpenCV build for a second-class path was not worth it
against Vision on-device. All of it — `ReceiptScanner`, `crop-worker.js`,
`crop-client.ts`, `compress-image.ts` and the build scripts — was deleted rather
than left to rot.

What remains is a thin shell: `/login` offers Google sign-in, and `/` shows
`ReceiptCapture`, which points the user at the iOS app with a `receipts://` deep
link, a sign-out button, and a **Review receipts** button to `/receipts`. The
PWA manifest and generated `/icon` and `/apple-icon` routes (teal `#0d6e6e`,
letter `R`) survive so the site can still be installed to the Home Screen.

### 9.1 Receipts list — `/receipts`

Session-cookie gated. Server component (`src/app/receipts/page.tsx`) reading
`listReceipts({ limit: 200 })` directly from the store — no MCP round trip.
Three tabs via `?filter=`: **Needs review** (default; `processed_at IS NULL`),
**All**, and **Processed**. Each row is a thumbnail
(`GET /api/receipts/:id/image`), filename, upload time, `submitted_by`, and a
status pill — *Not yet analysed*, *Analysed — needs review*, or *Processed* —
derived from `analysed_at`/`processed_at`, no separate status column. An
unprocessed row also shows `confidenceReason` (§6.2) under the pill, if
Cowork's analysis set one, truncated to one line. The row links to
`/review/:id` (§9.2). This is a read model only; nothing here writes to the
database. 200 is `listReceipts`'s clamp ceiling (§6.3) — there is no
pagination past that.

### 9.2 Review page — `/review/[id]`

For receipts Cowork flags rather than auto-processing (ambiguous category
splits, low-confidence reads, anything its rules say to leave for a human —
Cowork's own review criteria live in its Cowork configuration, not in this
repo). Session-cookie gated like the rest of the app; page routes with
no session redirect to `/login?next=/review/<id>` and land back here after
sign-in. Cowork gives the user a plain link,
`{appOrigin}/review/<receipt id>` (`src/lib/app-origin.ts`); the page also
links back to `/receipts`, and any receipt in that list can be opened the
same way, review-flagged by Cowork or not.

`src/app/review/[id]/page.tsx` loads the receipt server-side with
`getReceipt` and parses `analysis_json` with `parseAnalysis` (§6.2), also
passing `hasAnalysis: receipt.analysisJson !== null` — when false,
`ReceiptReview` shows a banner making clear the fields below are blank
because nothing was ever saved, not because extraction found nothing
(the two used to be visually indistinguishable, which is what made the
double-encoding bug in §6.2 confusing to diagnose). A non-empty
`confidenceReason` renders its own banner ("Why this needs review: ..."),
regardless of `hasAnalysis`. `ReceiptReview`
(`src/components/ReceiptReview.tsx`) is the client form: the
receipt image (`GET /api/receipts/:id/image`, tap to enlarge), a
**Download image** link (`<a download>` on that same endpoint, so it saves
under the original `filename` rather than the id), a **Mark
processed**/**Mark unprocessed** toggle (`POST /api/receipts/:id/status`,
§7 — local state updates immediately from the response), a **Delete** link
(only rendered while unprocessed; `window.confirm` before calling
`DELETE /api/receipts/:id` and redirecting to `/receipts` on success),
vendor/date/total/currency/reference, an editable item table (description
and amount only — category isn't a human-editable field here; matching a
line to a Manager expense account is Cowork's job, per §6.2, not something
this page asks the reviewer to pick), and a running items-total that flags
in red when it doesn't reconcile with the declared total. Each item's
`category` still round-trips unedited through Save (it's part of `Row`'s
state, just not rendered), so a human correcting a description or amount
split doesn't blank out the category Cowork already assigned. Save posts to
`POST /api/receipts/:id/review` (§7), which
only rewrites `analysis_json` and leaves `processed_at` alone — the receipt
stays (or becomes) unprocessed. There is no Manager API integration and Save
never marks a receipt processed itself: it hands the corrected split back to
Cowork, which is expected to pick the receipt up again via
`list_receipts(unprocessed: true)` on its next run, load the now-finalised
split into Manager, and call `mark_processed` itself. The status toggle is a
separate, explicit manual override for cases that flow doesn't cover — undoing
a receipt Cowork (or a previous toggle) marked processed too early, or
hand-clearing one it missed.

---

## 10. Configuration and deployment

### 10.1 Server environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ALLOWED_USERS` | Yes | empty (denies all) | Comma-separated Google emails |
| `GOOGLE_CLIENT_ID` | Yes | — | OAuth client |
| `GOOGLE_CLIENT_SECRET` | Yes | — | OAuth client |
| `GOOGLE_REDIRECT_URI` | Yes | — | Public callback URL; also decides cookie `secure` and app origin |
| `SESSION_SECRET` | Yes | — | HS256 signing key |
| `DATA_DIR` | No | `{cwd}/data` | DB and images |
| `NATIVE_APP_REDIRECT` | No | `receipts://auth` | iOS OAuth return |
| `NEXT_BUILD_CPUS` | No | unset | Caps build parallelism |

### 10.2 iOS build settings

`PRODUCT_BUNDLE_IDENTIFIER` (Xcode target build setting, pattern
`<domain-reverse>.receipts`, e.g. `au.com.acme.receipts`) is the single source of
truth for the bundle id — nothing else hardcodes it. `Info.plist`'s
`CFBundleURLName` and `BGTaskSchedulerPermittedIdentifiers` entry reference it
via `$(PRODUCT_BUNDLE_IDENTIFIER)`, and `ReceiptsApp.swift`'s
`retryTaskIdentifier` derives it at runtime from `Bundle.main.bundleIdentifier`
rather than a literal, so changing the one Xcode setting is enough to rebrand
the app (a fork still needs its own `DEVELOPMENT_TEAM` and, for push/App Store
distribution, its own App Store Connect record).

Display name Receipts, marketing version 1.0, deployment target iOS 17.0,
iPhone-only, portrait-only, category finance, team `HDPPA6WPMT`, automatic
signing. `SWIFT_STRICT_CONCURRENCY = minimal` — the UIKit and AVFoundation
delegate callbacks in `ScanCameraView` cannot satisfy Swift 6 strict checking
without `@unchecked Sendable` scattered through them, and `minimal` was judged
the honest trade rather than annotating away real warnings.

`Info.plist` declares `CFBundleIconName = AppIcon`, the `receipts` URL scheme,
`ITSAppUsesNonExemptEncryption = false`, and the background-refresh keys from
§5.4. The icon set covers 40 through 1024 px for iPhone and marketing;
`CFBundleIconName` and the asset catalog are both required or App Store
Connect rejects the upload. There is no build-time server URL — see §3.5.

### 10.3 Deployment

`./deploy-docker.sh [env]` builds the image and restarts the
`receipt-submission` container on port **8788** with `--restart unless-stopped`.
Secrets are read from `.env.$APP_ENV` at run time and never baked in
(`.dockerignore` excludes `.env*`); `./data` is bind-mounted to `/app/data`.

The image is `node:22-alpine` with Next.js standalone output, running as
uid 1001, healthchecked against `/health` every 60 s. The build pins
`NEXT_BUILD_CPUS=1` and a 1536 MB heap because Colima commonly defaults to 2 GB
and the build is otherwise OOM-killed.

CI is `.github/workflows/ios.yml` only: an unsigned simulator build of the iOS
app on `macos-15`, triggered on changes under `ios/**`. There is no web CI.

TestFlight distribution is Xcode Cloud, which — unlike a local build — has no
concept of an uncommitted override: it always archives exactly what's on the
watched branch. Since the tracked `PRODUCT_BUNDLE_IDENTIFIER` is the public
placeholder `au.com.acme.receipts` (§10.2), `ios/ci_scripts/ci_post_clone.sh`
rewrites it in the cloned `project.pbxproj` right after checkout, before Xcode
reads build settings, using a **Plain** environment variable named
`RECEIPTS_BUNDLE_ID` configured on the Xcode Cloud workflow in App Store
Connect (Xcode Cloud → workflow → Environment → Environment Variables). The
script fails the build loudly if that variable is unset rather than silently
archiving under the placeholder id.

The same script optionally injects a second, also Plain, variable,
`RECEIPTS_DEFAULT_SERVER_URL`, as an `Info.plist` key of the same name — see
§3.5. Unlike `RECEIPTS_BUNDLE_ID` this one isn't required: if it's unset the
build proceeds and the app just shows its normal first-run setup screen.
Neither variable needs Secret — a bundle id and a server hostname are already
public, unlike a real credential such as the retired `AP_API_TOKEN` (§3).

---

## 11. Security posture

Known and accepted, in rough order of significance:

- **Sessions live 400 days** and cannot be revoked individually. Removing the
  address from `ALLOWED_USERS` is the only revocation, checked per request.
- **Receipt images are unencrypted at rest** in `$DATA_DIR`, protected only by
  filesystem permissions.
- **Held receipts sit unencrypted** in the app's Documents directory, covered by
  iOS data protection and device passcode only.
- **TLS is the reverse proxy's job.** The container serves plain HTTP on 8788 and
  must not be exposed directly.

---

## 12. Known gaps

- Capture time is not a first-class column (§6.2), so listing and filtering are
  by upload time. A receipt held for a week sorts by when it arrived.
- No pruning: `attempts` and `lastError` accumulate on held receipts and nothing
  alerts if an entry is stuck indefinitely beyond the on-device count.
- `createSession()` and `deleteSession()` in `src/lib/auth/session.ts` are dead
  code; the OAuth callback and logout route manipulate cookies directly.
- No automated tests. Correctness of the capture-time stamp and the multipart
  encoding was established by one-off scripts, not a suite.
