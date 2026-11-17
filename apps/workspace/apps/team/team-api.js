// The Team app's one door to the cloud. Every URL and every request the app makes is here, written against the engine routes' documented shapes
// (the per-repo list envelope, the settings read, the settings write). The model and the page never build a path of their own.
import { api } from "../_lib/api.js";

export const REPOS_URL = "/api/v1/engine/repos";
export const SETTINGS_URL = "/api/v1/engine/settings";
export const DELETE_URL = "/api/v1/engine/settings/delete-data";
/** The three per-repo panels this app reads. Gates are read without a PR so one call covers every PR in a lane. */
export const PANELS = ["agents", "lanes", "gates"];
const PANEL_PATH = { agents: "/agents?state=running", lanes: "/lanes", gates: "/gates" };
export const panelUrl = (kind, repoId) => REPOS_URL + "/" + encodeURIComponent(String(repoId)) + PANEL_PATH[kind];

/** `call(method, path, body, signal)` is api() in the page; a test passes a fake with the same shape. */
export function createTeamApi(call = api) {
  return {
    repos: (signal) => call("GET", REPOS_URL, undefined, signal),
    settings: (signal) => call("GET", SETTINGS_URL, undefined, signal),
    panel: (kind, repoId, signal) => call("GET", panelUrl(kind, repoId), undefined, signal),
    saveSettings: (body, signal) => call("PUT", SETTINGS_URL, body, signal),
    deleteData: (signal) => call("PUT", DELETE_URL, undefined, signal),
  };
}
