# REMOTE — News-to-preview automation

A preview-first build of REMOTE. It discovers unusual US-oriented news candidates through Google News RSS searches, lets Gemini rank and rewrite source-backed material, searches Openverse and Wikimedia Commons for matching photo candidates, and renders a 1080×1080 PNG in the fixed REMOTE template. Photo lookup is best-effort and cannot block a post from rendering.

## Features

- Netlify static site with serverless endpoints for RSS news discovery, concurrent Openverse/Wikimedia Commons photo search, article text extraction, and same-origin photo loading for canvas export.
- Gemini API key field, connection test, live model list, automatic budget-oriented Flash/Flash-Lite choice, and manual model selection.
- Manual preview generation, server-side Auto timer (1–12 hours), step progress, event logs, source details in the validation panel, PNG download and caption copy. Captions are written for readers and include eight relevant hashtags without a Sources block or links.
- Template text fit checks with a larger proportional headline/body type scale and fixed inner margins; eight relevant hashtags are appended to captions. If photo sources time out or return no images, fallback artwork is rendered instead of failing the post.
- Facebook Page publishing through a server-only Graph API publisher. Manual Approval and Full Auto modes share the saved 1080×1080 PNG and exact generated caption; duplicate publication of the same saved preview is blocked.

## Run locally

Requires Node.js 22+. From the repository root:

```sh
npm test
npm run build
npx netlify-cli dev
```

Open the local URL printed by Netlify Dev. Do not open `index.html` as a `file://` URL, because Netlify functions will not exist there.

## Deploy to Netlify

1. In Netlify, choose **Add new site → Import an existing project**.
2. Connect GitHub and choose `sarada2000sd/Whatsapp_bot`.
3. Choose branch `remote-news`.
4. Build command: `npm run build`; publish directory: `dist`. Functions directory is configured as `netlify/functions` in `netlify.toml`.
5. Deploy the site, then test **Check news feeds**, **Refresh models**, **Test Gemini**, and **Generate preview**.

A deployed site is not created automatically by a GitHub commit. The Netlify account owner must connect/import the branch once.

## Server-side Auto setup

For the website to keep generating news while the tab is closed, publish the `remote-news` branch as the Netlify **Production** deploy, then open **Site configuration → Environment variables** and set:

- `GEMINI_API_KEY`: the Gemini API key used by unattended server runs.
- `REMOTE_CONTROL_TOKEN`: a long, private random token that authorizes the Auto start/stop controls. Enter the same token in the website's **Server control token** field. Do not share it.

Redeploy after adding or changing environment variables. In the website, choose the interval and press **Start server Auto**. The server runs a scheduled check every hour and starts a background run when the selected 1–12 hour interval is due. The latest caption/image and the permanent no-repeat story history are stored in Netlify Blobs and survive redeploys. Closing the website tab only stops live viewing; it does not stop server Auto. Facebook publishing can be enabled from the Facebook Page publishing card after setting the Page credentials below.

Important: Netlify Scheduled Functions execute automatically on published production deploys, not branch/Deploy Preview deploys. Keep `remote-news` as the Production branch if you want unattended Auto.


## Facebook Page publishing setup

In Netlify **Site configuration → Environment variables**, set:

- `FACEBOOK_PAGE_ID`: the numeric ID of the REMOTE Facebook Page.
- `FACEBOOK_PAGE_ACCESS_TOKEN`: the **Page access token** for that Page (not an app token or a user token).
- `META_GRAPH_API_VERSION` (optional): Graph API version, default `v26.0`.

The Page token must have the appropriate Page permissions, including `pages_manage_posts`, `pages_read_engagement` and `pages_show_list`, and the token owner must have the Page task needed to create content. Follow Meta's app-mode/review requirements for your intended use. Do not commit these secrets or paste them into the site UI. Redeploy after setting or changing them.

In REMOTE, open **Facebook Page publishing** and turn publishing ON. **Manual Approval** keeps new posts as previews until you click **Publish to Facebook**. **Full Auto** sends the same saved PNG and caption after a successful server Auto run. The Publish button is available for a saved preview in either mode. Turning publishing OFF prevents both manual and automatic publishing. If Facebook times out without returning a result, the post outcome is marked uncertain and retry is blocked until you check the Page, to reduce duplicate posts.

## Gemini key and model choice

Paste a Gemini API key in the website Settings panel. The browser calls Google's Gemini API directly and only saves the key in the current tab session by default. Checking **Remember key in this browser** stores it in browser local storage. Clearing site data or using a different browser removes the local saved copy. A key entered into browser storage is not safe for a public shared computer or a public multi-user product. Use a restricted key and review your Google AI Studio quota/billing settings.

The model selector fetches the models currently available to that key, filters to models supporting `generateContent`, and excludes image/audio/embedding/special-purpose models. AUTO prefers an available Flash-Lite identifier and then a stable Flash model. The Models API does not identify which models will be free on a user's account, and availability, quotas and billing can change. Confirm usage in Google AI Studio.

## Sources and photo search

- News discovery currently uses localized Google News RSS search feeds; this is feed discovery, not proof of a claim.
- Article text extraction is best-effort; paywalls, bot protection, publisher HTML changes and redirect restrictions may cause snippet-only retrieval.
- Image search uses a general category query derived from the story (for example, a dinosaur fossil story searches for a museum dinosaur fossil exhibition, not the exact auction/event). It sends no licence, commercial-use, orientation, or minimum-size filters. Creator/source/licence metadata is displayed when the provider supplies it, but it does not control whether a photo is returned.
- Photo results are best-effort: if a source times out, returns no image, or a photo cannot load, the system still renders the post using built-in editorial fallback artwork.
- Gemini outputs are drafts, not independent fact-checking. Read the source links; low-confidence or snippet-only results require extra care.

## Automation boundaries

Server-side Auto queues the first background run when enabled and then checks the saved interval through Netlify Scheduled Functions. Closing the page does not stop it. The latest post and the no-repeat history live in Netlify Blobs across redeploys. The site remains a remote control and preview; Facebook publishing is deferred completely and no post is sent to Facebook.

## Tests

GitHub Actions runs `npm test` and `npm run build` on the `remote-news` branch. Runtime API tests require a deployed Netlify URL and a valid Gemini API key; they cannot be proved by a static syntax check alone.

## Current photo search and Gemini model behaviour

- Photo discovery uses generic category/setting queries rather than trying to locate the exact rare event: fossil and skeleton stories search for museum exhibits, auctions for auction-house scenes, legal stories for courtrooms, and so on. Openverse and Wikimedia Commons are queried concurrently. There is no landscape, minimum-size, commercial-use, or licence eligibility filter; portrait images can be cropped into the square card. Public HTTPS URL validation remains in place for safe image loading.
- The image endpoint tries both providers in parallel and returns all supported photo candidates regardless of the licence metadata reported. The browser and background worker test multiple generic category queries and confirm actual image loads before selecting a photo. If sources return no usable photo, the renderer still produces a complete square post with clean editorial artwork and no photo-error label. The badge sits below the yellow panel with an intentional gap.
- Gemini model discovery refreshes automatically when the site loads. The model list is cached in local storage, and the last model that successfully returns valid JSON is remembered. Each request tries that model first in Auto mode and falls back through other listed text-generation models if necessary. This cache does not bypass account quotas or restore a missing API key.
- Use the remote-news branch as the Netlify production branch; the main branch is unchanged. Persistent server Auto uses `GEMINI_API_KEY`, `REMOTE_CONTROL_TOKEN`, Netlify Scheduled Functions and Netlify Blobs as described above.
