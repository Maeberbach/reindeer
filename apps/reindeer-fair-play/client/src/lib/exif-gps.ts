/**
 * Lightweight EXIF GPS extraction — no library dependency.
 * Reads the JPEG APP1 (Exif) segment and extracts GPSLatitude,
 * GPSLongitude, and DateTimeOriginal from the TIFF IFD.
 *
 * Returns null when the image has no EXIF GPS (e.g. desktop upload,
 * stripped photo, or non-JPEG format).
 */

export type ExifGps = {
  lat: number;
  lon: number;
  takenAt: number | null; // epoch ms
};

type Rational = [number, number];

function readRational(view: DataView, offset: number, little: boolean): Rational {
  const num = view.getUint32(offset, little);
  const den = view.getUint32(offset + 4, little);
  return [num, den];
}

function toDecimal(
  dms: [Rational, Rational, Rational],
  ref: string,
): number {
  const [d, m, s] = dms;
  const val =
    (d[0] / d[1]) +
    (m[0] / m[1]) / 60 +
    (s[0] / s[1]) / 3600;
  return ref === "S" || ref === "W" ? -val : val;
}

export function extractExifGps(file: File): Promise<ExifGps | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buf = reader.result as ArrayBuffer;
      const view = new DataView(buf);

      // Check JPEG SOI marker
      if (view.getUint16(0) !== 0xffd8) {
        resolve(null);
        return;
      }

      // Scan for APP1 (Exif) marker
      let offset = 2;
      let exifStart = -1;
      while (offset < view.byteLength - 4) {
        const marker = view.getUint16(offset);
        if (marker === 0xffe1) {
          // APP1
          // Check "Exif\0\0" signature
          const sigOffset = offset + 4;
          if (
            view.getUint32(sigOffset) === 0x45786966 && // "Exif"
            view.getUint16(sigOffset + 4) === 0x0000
          ) {
            exifStart = sigOffset + 6; // Start of TIFF header
            break;
          }
        }
        // Skip to next marker
        const segLen = view.getUint16(offset + 2);
        offset += 2 + segLen;
        if (segLen === 0) break;
      }

      if (exifStart === -1) {
        resolve(null);
        return;
      }

      // Read TIFF byte order
      const tiffView = new DataView(buf, exifStart);
      const byteOrder = tiffView.getUint16(0);
      const little = byteOrder === 0x4949; // "II" = little-endian
      if (!little && byteOrder !== 0x4d4d) {
        resolve(null);
        return;
      }

      // Read IFD0 offset
      const ifd0Offset = tiffView.getUint32(4, little);

      // Helper to read a string at a given offset
      const readString = (off: number, len: number): string => {
        let s = "";
        for (let i = 0; i < len; i++) {
          const c = tiffView.getUint8(off + i);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s;
      };

      // Helper to find IFD entry by tag
      const findTag = (ifdOffset: number, tag: number): { type: number; count: number; valueOffset: number } | null => {
        const entryCount = tiffView.getUint16(ifdOffset, little);
        for (let i = 0; i < entryCount; i++) {
          const entryOff = ifdOffset + 2 + i * 12;
          const entryTag = tiffView.getUint16(entryOff, little);
          if (entryTag === tag) {
            return {
              type: tiffView.getUint16(entryOff + 2, little),
              count: tiffView.getUint32(entryOff + 4, little),
              valueOffset: entryOff + 8,
            };
          }
        }
        return null;
      };

      // Parse IFD0 for DateTime (0x0132) and GPS IFD pointer (0x8825)
      let lat: number | null = null;
      let lon: number | null = null;
      let takenAt: number | null = null;

      // DateTimeOriginal is in ExifSubIFD (0x8769), not IFD0
      const exifSubIfdPtr = findTag(ifd0Offset, 0x8769);
      if (exifSubIfdPtr) {
        const subIfdOffset = tiffView.getUint32(exifSubIfdPtr.valueOffset, little);
        const dateTimeOriginal = findTag(subIfdOffset, 0x9003); // DateTimeOriginal
        if (dateTimeOriginal) {
          const strOff =
            dateTimeOriginal.count <= 4
              ? dateTimeOriginal.valueOffset
              : tiffView.getUint32(dateTimeOriginal.valueOffset, little);
          const dateStr = readString(strOff, 20);
          // Format: "YYYY:MM:DD HH:MM:SS"
          const m = dateStr.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
          if (m) {
            const dt = new Date(
              parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
              parseInt(m[4]), parseInt(m[5]), parseInt(m[6]),
            );
            if (!isNaN(dt.getTime())) takenAt = dt.getTime();
          }
        }
      }

      // GPS IFD
      const gpsIfdPtr = findTag(ifd0Offset, 0x8825);
      if (gpsIfdPtr) {
        const gpsOffset = tiffView.getUint32(gpsIfdPtr.valueOffset, little);

        // GPSLatitudeRef (0x0001) - 'N' or 'S'
        const latRef = findTag(gpsOffset, 0x0001);
        const latData = findTag(gpsOffset, 0x0002); // GPSLatitude
        if (latRef && latData) {
          const refStr = readString(latRef.valueOffset, 1);
          const dataOff = tiffView.getUint32(latData.valueOffset, little);
          const d = readRational(tiffView, dataOff, little);
          const m = readRational(tiffView, dataOff + 8, little);
          const s = readRational(tiffView, dataOff + 16, little);
          lat = toDecimal([d, m, s], refStr);
        }

        // GPSLongitudeRef (0x0003) - 'E' or 'W'
        const lonRef = findTag(gpsOffset, 0x0003);
        const lonData = findTag(gpsOffset, 0x0004); // GPSLongitude
        if (lonRef && lonData) {
          const refStr = readString(lonRef.valueOffset, 1);
          const dataOff = tiffView.getUint32(lonData.valueOffset, little);
          const d = readRational(tiffView, dataOff, little);
          const m = readRational(tiffView, dataOff + 8, little);
          const s = readRational(tiffView, dataOff + 16, little);
          lon = toDecimal([d, m, s], refStr);
        }
      }

      if (lat != null && lon != null) {
        resolve({ lat, lon, takenAt });
      } else {
        resolve(null);
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file);
  });
}
