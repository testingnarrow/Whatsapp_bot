import { getStore as createStore } from "@netlify/blobs";
import { photoIdentityKeys } from "./news-generation-core.mjs";

export const STORE_NAME = "remote-automation";
export const SETTINGS_KEY = "settings";
export const HISTORY_KEY = "history";
export const PHOTO_HISTORY_KEY = "photo-history";
export const LATEST_KEY = "latest";
export const LATEST_IMAGE_KEY = "latest.png";
export function previewImageKey(generatedAt) {
  const safe=String(generatedAt||"").replace(/[^a-zA-Z0-9_-]/g,"");
  if(!safe)throw new Error("A valid preview timestamp is required.");
  return "preview-"+safe+".png";
}
export function getRemoteStore() {
  return createStore(STORE_NAME);
}

export function defaultSettings() {
  return {
    enabled: false,
    intervalHours: 3,
    lastRunAt: null,
    lastCompletedAt: null,
    lastStatus: "idle",
    lastMessage: "Remote Auto is stopped.",
    latestAt: null,
    lastWorkingModel: ""
  };
}

export async function readSettings(store = getRemoteStore()) {
  const stored = await store.get(SETTINGS_KEY, { type: "json", consistency: "strong" });
  return { ...defaultSettings(), ...(stored && typeof stored === "object" ? stored : {}) };
}

export async function patchSettings(patch, store = getRemoteStore()) {
  const current = await readSettings(store);
  const updated = { ...current, ...patch };
  await store.setJSON(SETTINGS_KEY, updated);
  return updated;
}

export async function readHistory(store = getRemoteStore()) {
  const value = await store.get(HISTORY_KEY, { type: "json", consistency: "strong" });
  return Array.isArray(value) ? value : [];
}

export async function writeHistory(history, store = getRemoteStore()) {
  const safe = Array.isArray(history) ? history : [];
  await store.setJSON(HISTORY_KEY, safe);
  return safe;
}

export async function readPhotoHistory(store = getRemoteStore()) {
  const value = await store.get(PHOTO_HISTORY_KEY, { type: "json", consistency: "strong" });
  return Array.isArray(value) ? value : [];
}
export async function writePhotoHistory(history, store = getRemoteStore()) {
  const safe = Array.isArray(history) ? history.slice(-40) : [];
  await store.setJSON(PHOTO_HISTORY_KEY, safe);
  return safe;
}
export function rememberPhoto(history, photo, usedAt = new Date().toISOString()) {
  const keys = photoIdentityKeys(photo);
  if (!keys.length) return Array.isArray(history) ? history.slice(-40) : [];
  const existing = (Array.isArray(history) ? history : []).filter(item => {
    const known = item && Array.isArray(item.keys) ? item.keys : [];
    return !keys.some(key => known.includes(key));
  });
  existing.push({ keys, provider: String(photo.provider || photo.source || "").slice(0, 100), id: String(photo.id || "").slice(0, 300), title: String(photo.title || "").slice(0, 240), url: String(photo.url || "").slice(0, 2048), foreign_landing_url: String(photo.foreign_landing_url || photo.landing_url || "").slice(0, 2048), usedAt });
  return existing.slice(-40);
}

export function canonicalStoryUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|ocid|ved|usg)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    url.searchParams.sort();
    return url.origin + url.pathname + (url.search ? url.search : "");
  } catch {
    return "";
  }
}

const TITLE_STOP = new Set([
  "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by", "from",
  "with", "after", "before", "as", "is", "are", "was", "were", "be", "has", "have", "had",
  "its", "their", "his", "her", "this", "that", "these", "those", "new", "york", "us", "usa",
  "united", "states", "says", "said", "report", "reports", "according", "rare", "video",
  "what", "when", "where", "why", "how", "could", "would", "will", "may", "might", "into",
  "over", "under", "more", "than", "million", "billion", "thousand", "dollars", "dollar"
]);

export function normalizeStoryTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\b\d+(?:[.,]\d+)?(?:m|bn|b|million|billion)?\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(word => word && word.length > 1 && !TITLE_STOP.has(word))
    .join(" ")
    .trim();
}

function similarity(left, right) {
  const a = new Set(String(left || "").split(/\s+/).filter(Boolean));
  const b = new Set(String(right || "").split(/\s+/).filter(Boolean));
  if (a.size < 3 || b.size < 3) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
}

export function isStoryUsed(story, history) {
  const url = canonicalStoryUrl(story && story.url);
  const titleKey = normalizeStoryTitle(story && story.title);
  if (!url && !titleKey) return false;

  return (Array.isArray(history) ? history : []).some(item => {
    if (!item || typeof item !== "object") return false;
    const oldUrl = item.urlKey || canonicalStoryUrl(item.url);
    const oldTitle = item.titleKey || normalizeStoryTitle(item.title);
    if (url && oldUrl && url === oldUrl) return true;
    if (titleKey && oldTitle && titleKey === oldTitle) return true;
    return similarity(titleKey, oldTitle) >= 0.75;
  });
}

export function rememberStory(history, story, now = new Date().toISOString()) {
  if (!story || !String(story.title || "").trim() || !canonicalStoryUrl(story.url)) {
    throw new Error("A story title and public URL are required for history.");
  }
  const current = Array.isArray(history) ? history : [];
  if (isStoryUsed(story, current)) return current;
  const item = {
    title: String(story.title).trim().slice(0, 240),
    url: canonicalStoryUrl(story.url),
    titleKey: normalizeStoryTitle(story.title),
    urlKey: canonicalStoryUrl(story.url),
    usedAt: now
  };
  return [...current, item].slice(-1200);
}
