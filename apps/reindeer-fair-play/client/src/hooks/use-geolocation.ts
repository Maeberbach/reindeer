/**
 * useGeolocation — captures the device location with a permission notice
 * shown before the browser prompt. Returns { capture, coords, loading }.
 *
 * On first call, shows a modal explaining why location is needed and
 * recommending "Only while using the site." After the user clicks Continue,
 * the browser's native geolocation prompt fires.
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
            <h3 style="margin:0 0 12px;font-size:20px">Why we need your location</h3>
            <p style="font-size:16px;line-height:1.5;margin:0 0 8px;color:#666">Reindeer uses your location to keep track of where things are. This helps when you have items at more than one place — a storage unit or a second home.</p>
            <p style="font-size:16px;line-height:1.5;margin:0 0 16px;color:#666">When your browser asks for permission, we recommend choosing <strong>"Only while using the site."</strong></p>
            <button id="fp-loc-continue" style="padding:10px 24px;border-radius:8px;border:none;background:var(--primary,#5b7c5e);color:#fff;font-size:16px;cursor:pointer">Continue</button>
          </div>
        `;
        document.body.appendChild(overlay);

        const btn = overlay.querySelector("#fp-loc-continue") as HTMLButtonElement;
        btn.onclick = () => {
          overlay.remove();
          requestLocation();
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
