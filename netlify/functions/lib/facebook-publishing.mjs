import { LATEST_KEY, patchSettings } from "./remote-state.mjs";

function httpError(message, status = 502, uncertain = false) {
  const error = new Error(message);
  error.status = status;
  error.uncertain = uncertain;
  return error;
}

export function facebookConfiguration(env = process.env) {
  const pageId = String(env.FACEBOOK_PAGE_ID || "").trim();
  const accessToken = String(env.FACEBOOK_PAGE_ACCESS_TOKEN || "").trim();
  return { configured: Boolean(pageId && accessToken) };
}

function privateConfig(env = process.env) {
  const pageId = String(env.FACEBOOK_PAGE_ID || "").trim();
  const accessToken = String(env.FACEBOOK_PAGE_ACCESS_TOKEN || "").trim();
  const rawVersion = String(env.META_GRAPH_API_VERSION || "v26.0").trim();
  const version = /^v\d+\.\d+$/.test(rawVersion) ? rawVersion : "v26.0";
  if (!pageId || !accessToken) {
    throw httpError("Facebook Page credentials are missing. Set FACEBOOK_PAGE_ID and FACEBOOK_PAGE_ACCESS_TOKEN in Netlify environment variables.", 503);
  }
  if (!/^\d{5,30}$/.test(pageId)) {
    throw httpError("FACEBOOK_PAGE_ID should be the numeric ID of the Facebook Page.", 503);
  }
  return { pageId, accessToken, version };
}

export async function publishFacebookPhoto({ image, caption, env = process.env, fetchImpl = globalThis.fetch }) {
  const config = privateConfig(env);
  const bytes = Buffer.from(image || []);
  if (bytes.length < 100 || bytes.length > 9 * 1024 * 1024) {
    throw httpError("The saved PNG is empty or exceeds the safe upload size (9 MB).", 413);
  }
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) {
    throw httpError("The saved post image is not a valid PNG.", 415);
  }
  const message = String(caption || "").trim();
  if (!message) throw httpError("The saved post has no caption to publish.", 400);

  const form = new FormData();
  form.append("source", new Blob([bytes], { type: "image/png" }), "remote-news.png");
  form.append("message", message);
  form.append("published", "true");
  let response;
  try {
    response = await fetchImpl("https://graph.facebook.com/" + config.version + "/" + encodeURIComponent(config.pageId) + "/photos", {
      method: "POST",
      headers: { Authorization: "Bearer " + config.accessToken },
      body: form,
      signal: AbortSignal.timeout(55000)
    });
  } catch {
    throw httpError("No response was received from Facebook. The post outcome is uncertain; check the Page before retrying to avoid a duplicate.", 504, true);
  }

  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok || data.error) {
    const apiMessage = String(data.error && data.error.message || "Facebook Graph API returned HTTP " + response.status)
      .replaceAll(config.accessToken, "[redacted]").slice(0, 300);
    throw httpError("Facebook rejected the post: " + apiMessage, response.status === 401 || response.status === 403 ? 403 : 502);
  }
  const postId = String(data.post_id || data.id || "").trim();
  if (!postId) {
    throw httpError("Facebook accepted the request but did not return a post ID. Check the Page before retrying.", 502, true);
  }
  return { photoId: String(data.id || ""), postId };
}

export async function publishLatestPost(store, expectedGeneratedAt, source = "manual") {
  privateConfig();
  const expected = String(expectedGeneratedAt || "").trim();
  if (!expected) throw httpError("The current saved preview version is missing. Reload the latest post and try again.", 400);

  const latest = await store.get(LATEST_KEY, { type: "json", consistency: "strong" });
  if (!latest) throw httpError("There is no saved post to publish yet.", 404);
  const generatedAt = String(latest.generatedAt || latest.at || "");
  if (generatedAt !== expected) {
    throw httpError("A newer preview replaced this one. The latest preview has been loaded; publish it again from the website.", 409);
  }

  const previous = latest.facebookPublish && typeof latest.facebookPublish === "object" ? latest.facebookPublish : {};
  if (previous.status === "published") {
    return { status: "published", alreadyPublished: true, postId: previous.postId || "", publishedAt: previous.publishedAt || "" };
  }
  if (previous.status === "publishing") {
    throw httpError("This preview is already being sent to Facebook. Wait for the result before trying again.", 409);
  }
  if (previous.status === "uncertain") {
    throw httpError("Facebook did not confirm the last attempt. Check the Page first; a retry could create a duplicate.", 409, true);
  }

  const imageKey = String(latest.imageKey || "");
  if (!imageKey) throw httpError("The saved post does not have an image key.", 404);
  const image = await store.get(imageKey, { type: "arrayBuffer", consistency: "strong" });
  if (!image) throw httpError("The saved PNG for this preview could not be found.", 404);
  const caption = String(latest.draft && latest.draft.caption || "").trim();
  if (!caption) throw httpError("The saved post has no caption to publish.", 400);

  const startedAt = new Date().toISOString();
  const publishing = { status: "publishing", source: source === "auto" ? "auto" : "manual", startedAt };
  await store.setJSON(LATEST_KEY, { ...latest, facebookPublish: publishing });
  await patchSettings({
    facebookLastStatus: "publishing",
    facebookLastMessage: source === "auto" ? "Auto has finished the post; uploading the saved image and caption to Facebook." : "Uploading the saved image and caption to Facebook."
  }, store);

  try {
    const posted = await publishFacebookPhoto({ image, caption });
    const publishedAt = new Date().toISOString();
    const facebookPublish = {
      status: "published",
      source: source === "auto" ? "auto" : "manual",
      postId: posted.postId,
      photoId: posted.photoId,
      publishedAt
    };
    const current = await store.get(LATEST_KEY, { type: "json", consistency: "strong" });
    if (current && String(current.generatedAt || current.at || "") === generatedAt) {
      await store.setJSON(LATEST_KEY, { ...current, facebookPublish });
    }
    await patchSettings({
      facebookLastStatus: "published",
      facebookLastMessage: "Facebook published the " + (source === "auto" ? "Auto" : "manual") + " post successfully.",
      facebookLastPostId: posted.postId,
      facebookLastPostAt: publishedAt
    }, store);
    return { status: "published", alreadyPublished: false, postId: posted.postId, photoId: posted.photoId, publishedAt, facebookPublish };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const state = error && error.uncertain ? "uncertain" : "failed";
    const message = String(error && error.message || error || "Facebook publish failed").slice(0, 300);
    const facebookPublish = { status: state, source: source === "auto" ? "auto" : "manual", startedAt, failedAt, message };
    const current = await store.get(LATEST_KEY, { type: "json", consistency: "strong" }).catch(() => null);
    if (current && String(current.generatedAt || current.at || "") === generatedAt) {
      await store.setJSON(LATEST_KEY, { ...current, facebookPublish });
    }
    await patchSettings({
      facebookLastStatus: state,
      facebookLastMessage: message,
      facebookLastPostId: "",
      facebookLastPostAt: null
    }, store);
    throw error;
  }
}
