/**
 * wouter's built-in `useHashLocation` folds the hash's query string into the
 * location itself (e.g. "/sign-in?token=abc"), which means `<Route
 * path="/sign-in">` never matches a URL like `#/sign-in?token=abc` — wouter
 * only strips `?search` for the *browser* location hook, not the hash one.
 *
 * This is a drop-in replacement that mirrors `useBrowserLocation`: the path
 * and the search string are reported separately, so `Route` matching and
 * `useSearch()` both work the way they do everywhere else in the app.
 */
import { useSyncExternalStore } from "react";

const hashListeners: Array<() => void> = [];

function onHashChange() {
  for (const cb of hashListeners) cb();
}

function subscribe(callback: () => void) {
  if (hashListeners.push(callback) === 1) {
    window.addEventListener("hashchange", onHashChange);
  }
  return () => {
    const i = hashListeners.indexOf(callback);
    if (i !== -1) hashListeners.splice(i, 1);
    if (hashListeners.length === 0) window.removeEventListener("hashchange", onHashChange);
  };
}

/** Everything after the leading `#/` (or `#`), still including any `?search`. */
function rawHash(): string {
  return "/" + window.location.hash.replace(/^#\/?/, "");
}

function currentPath(): string {
  return rawHash().split("?")[0] || "/";
}

function currentSearch(): string {
  const [, search = ""] = rawHash().split("?");
  return search;
}

export function navigate(to: string, { replace = false, state = null }: { replace?: boolean; state?: unknown } = {}) {
  const oldURL = window.location.href;
  // Strip an optional leading "#" and/or "/" so we don't end up with a
  // doubled slash when we re-add exactly one below.
  const cleaned = to.replace(/^#/, "").replace(/^\//, "");
  const url = new URL(window.location.href);
  const [hashPath, hashSearch] = cleaned.split("?");
  url.hash = `/${hashPath}${hashSearch ? `?${hashSearch}` : ""}`;
  const newURL = url.href;

  if (replace) {
    window.history.replaceState(state, "", newURL);
  } else {
    window.history.pushState(state, "", newURL);
  }

  const event =
    typeof HashChangeEvent !== "undefined"
      ? new HashChangeEvent("hashchange", { oldURL, newURL })
      : new Event("hashchange");
  window.dispatchEvent(event);
}

export function useHashLocation(): [string, typeof navigate] {
  const path = useSyncExternalStore(subscribe, currentPath, () => "/");
  return [path, navigate];
}

export function useHashSearch(): string {
  return useSyncExternalStore(subscribe, currentSearch, () => "");
}
