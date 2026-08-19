/**
 * Lightweight EXIF GPS extraction for the Registry vanilla JS app.
 * Reads JPEG APP1 (Exif) segment, extracts GPSLatitude, GPSLongitude,
 * and DateTimeOriginal. Returns null when no EXIF GPS is present.
 *
 * Used to corroborate browser geolocation with photo metadata —
 * if both agree, high confidence the item is in the expected room/site.
 */
(function (global) {
  'use strict';

  function readRational(view, offset, little) {
    return [view.getUint32(offset, little), view.getUint32(offset + 4, little)];
  }

  function toDecimal(dms, ref) {
    var val = (dms[0][0] / dms[0][1]) + (dms[1][0] / dms[1][1]) / 60 + (dms[2][0] / dms[2][1]) / 3600;
    return (ref === 'S' || ref === 'W') ? -val : val;
  }

  function extractExifGps(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () {
        var buf = reader.result;
        var view = new DataView(buf);

        if (view.getUint16(0) !== 0xffd8) { resolve(null); return; }

        var offset = 2, exifStart = -1;
        while (offset < view.byteLength - 4) {
          var marker = view.getUint16(offset);
          if (marker === 0xffe1) {
            var sigOff = offset + 4;
            if (view.getUint32(sigOff) === 0x45786966 && view.getUint16(sigOff + 4) === 0x0000) {
              exifStart = sigOff + 6;
              break;
            }
          }
          var segLen = view.getUint16(offset + 2);
          offset += 2 + segLen;
          if (segLen === 0) break;
        }

        if (exifStart === -1) { resolve(null); return; }

        var tv = new DataView(buf, exifStart);
        var byteOrder = tv.getUint16(0);
        var little = byteOrder === 0x4949;
        if (!little && byteOrder !== 0x4d4d) { resolve(null); return; }

        var ifd0Offset = tv.getUint32(4, little);

        function readString(off, len) {
          var s = '';
          for (var i = 0; i < len; i++) {
            var c = tv.getUint8(off + i);
            if (c === 0) break;
            s += String.fromCharCode(c);
          }
          return s;
        }

        function findTag(ifdOffset, tag) {
          var entryCount = tv.getUint16(ifdOffset, little);
          for (var i = 0; i < entryCount; i++) {
            var entryOff = ifdOffset + 2 + i * 12;
            if (tv.getUint16(entryOff, little) === tag) {
              return {
                type: tv.getUint16(entryOff + 2, little),
                count: tv.getUint32(entryOff + 4, little),
                valueOffset: entryOff + 8
              };
            }
          }
          return null;
        }

        var lat = null, lon = null, takenAt = null;

        // DateTimeOriginal in ExifSubIFD
        var subIfdPtr = findTag(ifd0Offset, 0x8769);
        if (subIfdPtr) {
          var subOffset = tv.getUint32(subIfdPtr.valueOffset, little);
          var dto = findTag(subOffset, 0x9003);
          if (dto) {
            var strOff = dto.count <= 4 ? dto.valueOffset : tv.getUint32(dto.valueOffset, little);
            var dateStr = readString(strOff, 20);
            var m = dateStr.match(/^(\\d{4}):(\\d{2}):(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})/);
            if (m) {
              var dt = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
              if (!isNaN(dt.getTime())) takenAt = dt.getTime();
            }
          }
        }

        // GPS IFD
        var gpsPtr = findTag(ifd0Offset, 0x8825);
        if (gpsPtr) {
          var gpsOff = tv.getUint32(gpsPtr.valueOffset, little);

          var latRef = findTag(gpsOff, 0x0001);
          var latData = findTag(gpsOff, 0x0002);
          if (latRef && latData) {
            var refStr = readString(latRef.valueOffset, 1);
            var dOff = tv.getUint32(latData.valueOffset, little);
            lat = toDecimal([
              readRational(tv, dOff, little),
              readRational(tv, dOff + 8, little),
              readRational(tv, dOff + 16, little)
            ], refStr);
          }

          var lonRef = findTag(gpsOff, 0x0003);
          var lonData = findTag(gpsOff, 0x0004);
          if (lonRef && lonData) {
            var refStr2 = readString(lonRef.valueOffset, 1);
            var dOff2 = tv.getUint32(lonData.valueOffset, little);
            lon = toDecimal([
              readRational(tv, dOff2, little),
              readRational(tv, dOff2 + 8, little),
              readRational(tv, dOff2 + 16, little)
            ], refStr2);
          }
        }

        if (lat != null && lon != null) {
          resolve({ lat: lat, lon: lon, takenAt: takenAt });
        } else {
          resolve(null);
        }
      };
      reader.onerror = function () { resolve(null); };
      reader.readAsArrayBuffer(file);
    });
  }

  global.extractExifGps = extractExifGps;
})(window);
