/**
 * TRANSAFRICA TRAVELMAP — Apps Script Backend
 * ------------------------------------------------------------
 * Zwei Endpoints in einem Script:
 *   doPost(e)  -> Schreiben eines neuen Punkts (vom iPhone-Shortcut)
 *   doGet(e)   -> Lesen aller gültigen Punkte als JSON (vom PowerShell-Skript)
 *
 * SETUP (einmalig):
 *  1. Neues Google Sheet anlegen, Kopfzeile in Zeile 1 exakt so:
 *     ID | Date | Category | Subcategory | Title | Note | Lat | Lon | Photo-URL | Info-URL | Country
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
  PHOTO_FOLDER_ID: "https://drive.google.com/drive/folders/1H9FDkUuveQS8SWvWUN_zjGOU0Ia7k2K4",  // Google Drive Ordner für Fotos
  WRITE_SECRET: "FuerMeinSchutz:#!",  // schützt doPost vor Fremdzugriff
  MAX_PHOTO_BYTES: 7 * 1024 * 1024,   // ~7 MB decoded, Apps-Script-Sicherheitsmarge
};

const ALLOWED_CATEGORIES = {
  "Accommodation": ["Wild Camp", "Parking Spot", "Campsite", "Hotel", "Guesthouse"],
  "Checkpoints":   ["Border Crossing", "Police Checkpoint", "Military Checkpoint"],
  "Logistics":     ["Water", "Fuel", "SIM/Internet", "Shopping", "ATM", "Money Exchange", "Workshop", "Spare Parts" ],
  "Danger":        ["Road Condition", "Safety Warning", "Avoid Area", "Natural Hazard", ],
  "Sightseeing":   ["Attraction", "Viewpoint", "Hike", "Beach", "Culture"],
  "Country Info":  ["Description"],
  "Route":         [""],
  "Social":        ["Blog Entry", "Meet Friends"],
};

const SHEET_COLUMNS = ["ID","Date","Category","Subcategory","Title","Note","Lat","Lon","Photo-URL","Info-URL","Country"];

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

      // --- Foto optional verarbeiten ---
	  let photoUrl = body.photoUrl || "";
      let photoWarning = "";
      if (body.photoBase64) {
        const uploaded = uploadPhoto(body.photoBase64, id);
        if (uploaded === null) {
          photoUrl = ""; // Punkt wird trotzdem gespeichert, nur ohne Foto
          photoWarning = "Foto zu gross oder Upload fehlgeschlagen — Punkt wurde ohne Foto gespeichert.";
        } else {
          photoUrl = uploaded;
        }
      }

      const row = [
        id,
        body.date || Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd"),
        category,
        subcategory,
        String(body.title).trim(),
        body.note || "",
        lat,
        lon,
        photoUrl,
        body.infoUrl || "",
        body.country || "",
      ];

      if (existingRow > 0) {
        sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
        return jsonOk({ id, action: "updated" });
      } else {
        sheet.appendRow(row);
        return jsonOk({ id, action: "created" });
      }
    } finally {
      lock.releaseLock();
    }

  } catch (err) {
    return jsonError("Serverfehler: " + err.message);
  }
}

function uploadPhoto(base64Data, id) {
  try {
    // grobe Grössenschätzung: Base64 ist ca. 1.37x der Originalgrösse
    if (base64Data.length * 0.73 > CONFIG.MAX_PHOTO_BYTES) {
      return null;
    }
    const folder = DriveApp.getFolderById(CONFIG.PHOTO_FOLDER_ID);
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const bytes = Utilities.base64Decode(cleanBase64);
    const blob = Utilities.newBlob(bytes, "image/jpeg", `${id}.jpg`);
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return `https://drive.google.com/uc?id=${file.getId()}`;
  } catch (err) {
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
        category: r[idx["Category"]],
        subcategory: r[idx["Subcategory"]],
        title: title,
        note: r[idx["Note"]] || "",
        lat: lat,
        lon: lon,
        photoUrl: r[idx["Photo-URL"]] || "",
        infoUrl: r[idx["Info-URL"]] || "",
        country: r[idx["Country"]] || "",
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

function jsonOk(payload) {
  return ContentService.createTextOutput(JSON.stringify(Object.assign({ ok: true }, payload)))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message) {
  return ContentService.createTextOutput(JSON.stringify({ ok: false, error: message }))
    .setMimeType(ContentService.MimeType.JSON);
}
