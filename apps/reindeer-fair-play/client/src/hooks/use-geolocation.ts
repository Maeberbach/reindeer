/**
 * useGeolocation — captures the device location with a permission notice
 * shown before the browser prompt. Returns { capture, coords, loading }.
 *
 * Location is STRONGLY RECOMMENDED but NEVER a barrier. If the user
 * skips or denies, capture() resolves null and the item saves without
 * geo data. The app works fully without location.
 */
import { useState, useCallback, useRef } from "react";

type Coords = { lat: number; lon: number };

const NOTICE_SHOWN_KEY = "fairplay-loc-notice-shown";

export function useGeolocation() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [loading, setLoading] = useState(false);
  const noticeShown = useRef(false);

  const capture = useCallback((): Promise<Coords | null> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve(null);
        return;
      }

      // If we already have coords, return them
      if (coords) {
        resolve(coords);
        return;
      }

      setLoading(true);

      // Show notice before triggering the browser prompt
      const showNotice = () => {
        const overlay = document.createElement("div");
        overlay.id = "fp-loc-notice";
        overlay.style.cssText =
          "position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px";
        overlay.innerHTML = `
          <div style="background:var(--paper,#fff);border:1px solid var(--border,#e2e2e2);border-radius:14px;padding:28px 24px;max-width:420px;text-align:center;box-shadow:0 8px 30px rgba(0,0,0,.2);font-family:inherit">
            <h3 style="margin:0 0 12px;font-size:20px">📍 Help us track where things are</h3>
            <p style="font-size:16px;line-height:1.5;margin:0 0 8px;color:#666">Reindeer can use your location to keep track of where items are — especially helpful if you have things at more than one place.</p>
            <p style="font-size:16px;line-height:1.5;margin:0 0 8px;color:#666">When your browser asks, we recommend <strong>"Only while using the site."</strong></p>
            <p style="font-size:13px;color:#999;margin:0 0 16px">This is optional — you can skip it and add items without location data any time.</p>
            <div style="display:flex;gap:10px;justify-content:center">
              <button id="fp-loc-continue" style="padding:10px 24px;border-radius:8px;border:none;background:var(--primary,#5b7c5e);color:#fff;font-size:16px;cursor:pointer">Allow location</button>
              <button id="fp-loc-skip" style="padding:10px 24px;border-radius:8px;border:1px solid #ccc;background:none;color:#666;font-size:16px;cursor:pointer">Not now</button>
            </div>
          </div>
        `;
        document.body.appendChild(overlay);

        const continueBtn = overlay.querySelector("#fp-loc-continue") as HTMLButtonElement;
        const skipBtn = overlay.querySelector("#fp-loc-skip") as HTMLButtonElement;

        continueBtn.onclick = () => {
          overlay.remove();
          requestLocation();
        };

        skipBtn.onclick = () => {
          overlay.remove();
          setLoading(false);
          resolve(null);
        };
      };

      const requestLocation = () => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const c = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            setCoords(c);
            setLoading(false);
            resolve(c);
          },
          () => {
            setLoading(false);
            resolve(null);
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
        );
      };

      // Check if notice was already shown this session
      const alreadyShown = noticeShown.current || sessionStorage.getItem(NOTICE_SHOWN_KEY);
      if (alreadyShown) {
        requestLocation();
      } else {
        noticeShown.current = true;
        sessionStorage.setItem(NOTICE_SHOWN_KEY, "1");
        showNotice();
      }
    });
  }, [coords]);

  return { capture, coords, loading };
}
