/**
 * TRAVELMAP — Apps Script Backend
 * ------------------------------------------------------------
 * Zwei Endpoints in einem Script:
 *   doPost(e)  -> Schreiben eines neuen Punkts (vom iPhone-Shortcut)
 *   doGet(e)   -> Lesen aller gültigen Punkte als JSON (vom PowerShell-Skript)
 *
 * SETUP (einmalig):
 *  1. Neues Google Sheet anlegen, Kopfzeile in Zeile 1 exakt so:
 *     ID | Date | Time | Category | Subcategory | Title | Note | Lat | Lon | Photo-URL | Info-URL | Country | Temperature | Weather
 *  2. Erweiterungen -> Apps Script -> diesen Code einfügen
 *  3. CONFIG unten ausfüllen (Ordner-ID für Fotos, eigenes Secret setzen)
 *  4. Bereitstellen -> Neue Bereitstellung -> Web-App
 *     - Ausführen als: Ich
 *     - Zugriff: Jeder (für Shortcut + PowerShell ohne Google-Login nötig)
 *  5. Web-App-URL kopieren -> wird im Shortcut UND im PowerShell-Skript gebraucht
 * ------------------------------------------------------------
 */

const CONFIG = {
  SHEET_NAME: "Data",                 // Tab-Name im Sheet
  PHOTO_FOLDER_ID: "1H9FDkUuveQS8SWvWUN_zjGOU0Ia7k2K4",  // Google Drive Ordner für Fotos
  WRITE_SECRET: "FuerMeinSchutz:#!",  // schützt doPost vor Fremdzugriff
  MAX_PHOTO_BYTES: 7 * 1024 * 1024,   // ~7 MB decoded, Apps-Script-Sicherheitsmarge
  MAX_PHOTO_COUNT: 5,                 // serverseitige Obergrenze, unabhaengig vom Client
};

const ALLOWED_CATEGORIES = {
  "Accommodation": ["Wild Camp", "Campsite", "Parking Lot", "Hotel", "Guesthouse", "Other"],
  "Checkpoints":   ["Border Crossing", "Police Checkpoint", "Military Checkpoint"],
  "Logistics":     ["Water", "Fuel", "SIM/Internet", "Car Insurance", "Shopping", "ATM & Exchange", "Workshop", "Spare Parts", "Laundry" ],
  "Danger":        ["Road Condition", "Safety Warning", "Avoid Area", "Natural Hazard", ],
  "Sightseeing":   ["Attraction", "Viewpoint", "Hike", "Beach", "Culture", "National Park", "Scenery" ],
  "Country Info":  ["General Information"],
  "Embassy":       ["General Information"],
  "Social":        ["Blog Entry", "Meetup"],
};

const SHEET_COLUMNS = ["ID","Date","Time","Category","Subcategory","Title","Note","Lat","Lon","Photo-URL","Info-URL","Country","Temperature","Weather"];

// ------------------------------------------------------------
// doPost — neuen Punkt schreiben (Shortcut -> hier)
// ------------------------------------------------------------
function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) {
      return jsonError("Kein Body empfangen.");
    }

    const body = JSON.parse(e.postData.contents);

    // --- Zugriffsschutz ---
    if (body.secret !== CONFIG.WRITE_SECRET) {
      return jsonError("Ungültiges Secret.");
    }

    // --- Pflichtfelder prüfen ---
    const required = ["category", "title", "lat", "lon"];
    for (const field of required) {
      if (body[field] === undefined || body[field] === null || body[field] === "") {
        return jsonError(`Pflichtfeld fehlt: ${field}`);
      }
    }

    // --- Koordinaten validieren ---
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return jsonError("Lat/Lon ungültig.");
    }

    // --- Kategorie/Subkategorie validieren ---
    const category = String(body.category).trim();
    if (!ALLOWED_CATEGORIES.hasOwnProperty(category)) {
      return jsonError(`Unbekannte Category: "${category}". Erlaubt: ${Object.keys(ALLOWED_CATEGORIES).join(", ")}`);
    }
    const subcategory = String(body.subcategory || "").trim();
    const allowedSubs = ALLOWED_CATEGORIES[category];
    if (subcategory && allowedSubs[0] !== "" && !allowedSubs.includes(subcategory)) {
      return jsonError(`Unbekannte Subcategory "${subcategory}" für Category "${category}". Erlaubt: ${allowedSubs.join(", ")}`);
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
    const lock = LockService.getScriptLock();
    lock.waitLock(15000); // verhindert Race Conditions bei gleichzeitigen Schreibzugriffen

    try {
      // --- Idempotenz: gleiche ID = Update statt Duplikat (Schutz bei Netz-Timeout + Retry) ---
      const id = String(body.id || Utilities.getUuid());
      const data = sheet.getDataRange().getValues();
      let existingRow = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][0]) === id) { existingRow = i + 1; break; }
      }

      // --- Fotos optional verarbeiten (mehrere, kommagetrennt in einer Zelle) ---
      let photoUrl = body.photoUrl || "";
      let photoWarning = "";
      // Neues Feld photosBase64 (Array) bevorzugt; altes Einzelfeld photoBase64
      // bleibt als Fallback kompatibel (z.B. fuer noch wartende Queue-Eintraege
      // aus einer aelteren capture.html-Version).
      let photosToUpload = [];
      if (Array.isArray(body.photosBase64) && body.photosBase64.length) {
        photosToUpload = body.photosBase64;
      } else if (body.photoBase64) {
        photosToUpload = [body.photoBase64];
      }

      if (photosToUpload.length > CONFIG.MAX_PHOTO_COUNT) {
        photosToUpload = photosToUpload.slice(0, CONFIG.MAX_PHOTO_COUNT);
      }

      if (photosToUpload.length) {
        const uploaded = [];
        let failCount = 0;
        photosToUpload.forEach((b64, i) => {
          const url = uploadPhoto(b64, id + "_" + i);
          if (url) { uploaded.push(url); } else { failCount++; }
        });
        photoUrl = uploaded.join(" | ");
        if (failCount > 0) {
          photoWarning = `${failCount} von ${photosToUpload.length} Foto(s) konnten nicht hochgeladen werden (zu gross oder Fehler) — Rest wurde gespeichert.`;
        }
        if (uploaded.length === 0 && failCount > 0) {
          photoWarning = "Alle Fotos zu gross oder Upload fehlgeschlagen — Punkt wurde ohne Foto gespeichert.";
        }
      }

      // --- Wetter nachtragen (fuer den Erfassungszeitpunkt, nicht "jetzt") ---
      // Blockiert nie das Speichern des Punkts - schlaegt die Abfrage fehl,
      // bleiben Temperature/Weather einfach leer.
      const pointDate = body.date || Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd");
      const pointTime = body.time || Utilities.formatDate(new Date(), "UTC", "HH:mm");
      const weather = fetchWeather(lat, lon, pointDate, pointTime);

      const row = [
        id,
        pointDate,
        pointTime,
        category,
        subcategory,
        String(body.title).trim(),
        body.note || "",
        lat,
        lon,
        photoUrl,
        body.infoUrl || "",
        body.country || "",
        weather ? weather.temperature : "",
        weather ? weather.label : "",
      ];

      if (existingRow > 0) {
        sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
        return jsonOk({ id, action: "updated", warning: photoWarning || undefined });
      } else {
        sheet.appendRow(row);
        return jsonOk({ id, action: "created", warning: photoWarning || undefined });
      }
    } finally {
      lock.releaseLock();
    }

  } catch (err) {
    return jsonError("Serverfehler: " + err.message);
  }
}

// ------------------------------------------------------------
// Wetter fuer Ort+Zeitpunkt nachtragen (Open-Meteo, kein API-Key noetig).
// Nutzt die normale Forecast-API mit start_date/end_date - die deckt neben
// der Vorschau auch ca. die letzten ~3 Monate ab (Modell-Archiv), also
// praktisch immer den Erfassungszeitpunkt einer aktiven Reise.
// ------------------------------------------------------------
function fetchWeather(lat, lon, dateStr, timeStr) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&start_date=${dateStr}&end_date=${dateStr}` +
      `&hourly=temperature_2m,weathercode&timezone=UTC`;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      Logger.log('fetchWeather: HTTP ' + resp.getResponseCode());
      return null;
    }
    const data = JSON.parse(resp.getContentText());
    if (!data.hourly || !data.hourly.time) return null;

    // Zielstunde (z.B. "14:15" -> "14:00") suchen und passenden Index finden
    const targetHour = (timeStr || "12:00").split(":")[0].padStart(2, "0") + ":00";
    const targetKey = dateStr + "T" + targetHour;
    let idx = data.hourly.time.indexOf(targetKey);
    if (idx === -1) idx = 0; // Fallback: erste verfuegbare Stunde des Tages

    const temp = data.hourly.temperature_2m[idx];
    const code = data.hourly.weathercode[idx];
    if (temp === undefined || temp === null) return null;

    return {
      temperature: Math.round(temp * 10) / 10,
      label: weatherCodeToLabel(code),
    };
  } catch (err) {
    Logger.log('fetchWeather: FEHLER — ' + err.message);
    return null;
  }
}

function weatherCodeToLabel(code) {
  const map = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Rime fog",
    51: "Light drizzle", 53: "Drizzle", 55: "Dense drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle (dense)",
    61: "Light rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain (heavy)",
    71: "Light snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Light rain showers", 81: "Rain showers", 82: "Violent rain showers",
    85: "Snow showers", 86: "Heavy snow showers",
    95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
  };
  return map[code] || "";
}

function uploadPhoto(base64Data, id) {
  try {
    // grobe Grössenschätzung: Base64 ist ca. 1.37x der Originalgrösse
    if (base64Data.length * 0.73 > CONFIG.MAX_PHOTO_BYTES) {
      Logger.log('uploadPhoto: Foto zu gross, base64.length=' + base64Data.length);
      return null;
    }
    const folder = DriveApp.getFolderById(CONFIG.PHOTO_FOLDER_ID);
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const bytes = Utilities.base64Decode(cleanBase64);
    const blob = Utilities.newBlob(bytes, "image/jpeg", `${id}.jpg`);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    Logger.log('uploadPhoto: Erfolgreich, fileId=' + file.getId());
    return `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w1600`;
  } catch (err) {
    Logger.log('uploadPhoto: FEHLER — ' + err.message);
    return null;
  }
}

// ------------------------------------------------------------
// doGet alle gültigen Punkte als JSON zurückgeben (PowerShell -> hier)
// ------------------------------------------------------------
function doGet(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
    const values = sheet.getDataRange().getValues();
    const header = values[0];

    const idx = {};
    SHEET_COLUMNS.forEach(col => idx[col] = header.indexOf(col));

    const points = [];
    let skipped = 0;

    for (let i = 1; i < values.length; i++) {
      const r = values[i];
      const lat = Number(r[idx["Lat"]]);
      const lon = Number(r[idx["Lon"]]);
      const title = String(r[idx["Title"]] || "").trim();

      // ungültige/leere Zeilen überspringen statt die ganze Karte zum Absturz zu bringen
      if (isNaN(lat) || isNaN(lon) || lat === 0 && lon === 0 || !title) {
        skipped++;
        continue;
      }

      points.push({
        id: r[idx["ID"]],
        date: formatDateValue(r[idx["Date"]]),
        time: formatTimeValue(r[idx["Time"]]),
        category: r[idx["Category"]],
        subcategory: r[idx["Subcategory"]],
        title: title,
        note: r[idx["Note"]] || "",
        lat: lat,
        lon: lon,
        photoUrl: r[idx["Photo-URL"]] || "",
        infoUrl: r[idx["Info-URL"]] || "",
        country: r[idx["Country"]] || "",
        temperature: r[idx["Temperature"]] !== "" ? r[idx["Temperature"]] : null,
        weather: r[idx["Weather"]] || "",
      });
    }

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      generatedAt: new Date().toISOString(),
      count: points.length,
      skipped: skipped,
      points: points,
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false,
      error: err.message,
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

function formatDateValue(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, "UTC", "yyyy-MM-dd");
  }
  return String(v || "");
}

function formatTimeValue(v) {
  if (v instanceof Date) {
    // Sheets speichert reine Zeitwerte intern oft als Date-Objekt (Datumsteil irrelevant)
    return Utilities.formatDate(v, "UTC", "HH:mm");
  }
  return String(v || "");
}

function jsonOk(payload) {
  return ContentService.createTextOutput(JSON.stringify(Object.assign({ ok: true }, payload)))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}
