import { getRemoteStore, readSettings, patchSettings } from "./lib/remote-state.mjs";

export const config = { schedule: "0 * * * *" };

function siteBase() {
  const value = process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || process.env.URL || "";
  return value ? value.replace(/\/+$/, "") : "";
}

export default async function automationTick() {
  const store = getRemoteStore();
  const settings = await readSettings(store);
  if (!settings.enabled) {
    console.log("Remote Auto is disabled; skipping scheduled tick.");
    return;
  }
  const token = String(process.env.REMOTE_CONTROL_TOKEN || "");
  if (!token || !process.env.GEMINI_API_KEY) {
    await patchSettings({
      lastStatus: "needs-configuration",
      lastMessage: "Set GEMINI_API_KEY and REMOTE_CONTROL_TOKEN in Netlify environment variables."
    }, store);
    return;
  }

  const intervalHours = Math.min(12, Math.max(1, Number(settings.intervalHours) || 3));
  const lastRun = Date.parse(settings.lastRunAt || "");
  if (Number.isFinite(lastRun) && Date.now() - lastRun < intervalHours * 3600000) {
    console.log("Not due yet; the configured interval is " + intervalHours + " hour(s).");
    return;
  }

  const base = siteBase();
  if (!base) throw new Error("Netlify URL environment variable is missing.");
  await patchSettings({
    lastRunAt: new Date().toISOString(),
    lastStatus: "queued",
    lastMessage: "The hourly server scheduler queued a background run."
  }, store);

  try {
    const response = await fetch(base + "/.netlify/functions/automation-run-background", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + token },
      body: JSON.stringify({ source: "hourly-scheduler" }),
      signal: AbortSignal.timeout(9000)
    });
    if (!response.ok && response.status !== 202 && response.status !== 204) {
      throw new Error("Background worker returned HTTP " + response.status + ".");
    }
    console.log("Remote background worker queued.");
  } catch (error) {
    await patchSettings({
      lastRunAt: new Date(Date.now() - Math.max(0, intervalHours - 1) * 3600000).toISOString(),
      lastStatus: "waiting",
      lastMessage: "The scheduler will retry after a dispatch issue: " + String(error.message || error).slice(0, 180)
    }, store);
    throw error;
  }
}
