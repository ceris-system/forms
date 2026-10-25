const SALES_ARCHIVE_FOLDER_ID = "1mbWeeulYSg413vZ6zJgPZQjb9r_9gb1d";

function installSalesArchiveTrigger() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Open this Apps Script from the Sales spreadsheet.");
  PropertiesService.getScriptProperties().setProperty("SALES_ARCHIVE_SPREADSHEET_ID", spreadsheet.getId());

  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "archivePreviousMonthSales") ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("archivePreviousMonthSales")
    .timeBased()
    .onMonthDay(1)
    .atHour(2)
    .inTimezone(spreadsheet.getSpreadsheetTimeZone())
    .create();
}

function installSalesCopyTrigger() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error("Open this Apps Script from the Sales spreadsheet.");
  PropertiesService.getScriptProperties().setProperty("SALES_ARCHIVE_SPREADSHEET_ID", spreadsheet.getId());

  const handlers = [
    "copySalesToCurrentDate",
    "copySalesToSourceDate",
    "copySalesOnEdit",
    "copySalesEveryMinute",
    "copySalesAtEndOfDay",
  ];
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (handlers.includes(trigger.getHandlerFunction())) ScriptApp.deleteTrigger(trigger);
  }
  ScriptApp.newTrigger("copySalesAtEndOfDay")
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .inTimezone(spreadsheet.getSpreadsheetTimeZone())
    .create();
}

function copySalesAtEndOfDay() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SALES_ARCHIVE_SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("Run installSalesCopyTrigger from the Sales spreadsheet first.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const sheet = spreadsheet.getSheetByName("Sales");
  if (!sheet) throw new Error('The "Sales" tab was not found.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    copySalesToDate(spreadsheet, sheet);
  } finally {
    lock.releaseLock();
  }
}

function copySalesToDate(spreadsheet, sheet) {
  const timezone = spreadsheet.getSpreadsheetTimeZone();
  const targetDate = salesArchiveDateKey(
    sheet.getRange(1, 7).getValue(),
    sheet.getRange(1, 7).getDisplayValue(),
    timezone,
  );
  if (!targetDate) throw new Error("Sales!G1 must contain a valid date before source values can be copied.");

  const lastColumn = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (lastColumn < 10 || lastRow < 3) throw new Error("The Sales sheet is missing its dated columns or product rows.");
  const headerValues = sheet.getRange(1, 1, 2, lastColumn).getValues();
  const headerDisplay = sheet.getRange(1, 1, 2, lastColumn).getDisplayValues();
  const matchingColumns = [];

  for (let salesColumn = 9; salesColumn < lastColumn; salesColumn++) {
    if (String(headerDisplay[1][salesColumn] || "").trim().toUpperCase() !== "SALES") continue;
    const qtyColumn = salesColumn - 1;
    if (String(headerDisplay[1][qtyColumn] || "").trim().toUpperCase() !== "QTY RELEASED") continue;
    const rawDate = headerValues[0][salesColumn] || headerValues[0][qtyColumn];
    const displayDate = headerDisplay[0][salesColumn] || headerDisplay[0][qtyColumn];
    if (salesArchiveDateKey(rawDate, displayDate, timezone) === targetDate) {
      matchingColumns.push({ qtyColumn: qtyColumn + 1, salesColumn: salesColumn + 1 });
    }
  }
  if (matchingColumns.length !== 1) {
    throw new Error("Expected one QTY RELEASED / SALES column pair for " + targetDate + ", found " + matchingColumns.length + ".");
  }

  const sourceValues = sheet.getRange(3, 7, lastRow - 2, 2).getValues();
  const target = matchingColumns[0];
  const targetRange = sheet.getRange(3, target.qtyColumn, sourceValues.length, 2);
  const targetValues = targetRange.getValues();
  const unchanged = sourceValues.every((row, rowIndex) =>
    row.every((value, columnIndex) => salesArchiveValuesEqual(value, targetValues[rowIndex][columnIndex]))
  );
  if (unchanged) {
    console.log("Sales data for " + targetDate + " is already up to date.");
    return;
  }
  targetRange.setValues(sourceValues);
  console.log("Copied " + sourceValues.length + " Sales rows from G:H to the date pair for " + targetDate + ".");
}

function salesArchiveValuesEqual(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function archivePreviousMonthSales() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SALES_ARCHIVE_SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("Run installSalesArchiveTrigger from the Sales spreadsheet first.");
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  const sheet = spreadsheet.getSheetByName("Sales");
  if (!sheet) throw new Error('The "Sales" tab was not found.');

  const timezone = spreadsheet.getSpreadsheetTimeZone();
  const now = new Date();
  const currentMonth = Utilities.formatDate(now, timezone, "yyyy-MM");
  const [year, month] = currentMonth.split("-").map(Number);
  const previousMonthDate = new Date(Date.UTC(year, month - 2, 1));
  const targetMonth = Utilities.formatDate(previousMonthDate, "UTC", "yyyy-MM");
  const lastColumn = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  if (lastColumn < 8 || lastRow < 3) throw new Error("The Sales sheet is missing its report headers or product rows.");

  const headerValues = sheet.getRange(1, 1, 2, lastColumn).getValues();
  const headerDisplay = sheet.getRange(1, 1, 2, lastColumn).getDisplayValues();
  const dateColumns = [];
  for (let salesColumn = 0; salesColumn < lastColumn; salesColumn++) {
    if (String(headerDisplay[1][salesColumn] || "").trim().toUpperCase() !== "SALES") continue;
    const qtyColumn = salesColumn - 1;
    if (qtyColumn < 0 || String(headerDisplay[1][qtyColumn] || "").trim().toUpperCase() !== "QTY RELEASED") continue;
    const rawDate = headerValues[0][salesColumn] || headerValues[0][qtyColumn];
    const displayDate = headerDisplay[0][salesColumn] || headerDisplay[0][qtyColumn];
    const date = salesArchiveDateKey(rawDate, displayDate, timezone);
    if (date && date.startsWith(targetMonth + "-")) {
      dateColumns.push({ date: date, qtyColumn: qtyColumn, salesColumn: salesColumn });
    }
  }
  if (!dateColumns.length) throw new Error("No dated QTY RELEASED / SALES columns were found for " + targetMonth + ".");

  const productRows = sheet.getRange(3, 1, lastRow - 2, lastColumn).getValues();
  const rowsByKey = new Map();
  for (const row of productRows) {
    const sku = String(row[0] || "").trim();
    if (!sku) continue;
    for (const column of dateColumns) {
      const qty = Number(row[column.qtyColumn]) || 0;
      const amount = Number(row[column.salesColumn]) || 0;
      if (!qty && !amount) continue;
      const department = String(row[5] || "").trim();
      const key = [column.date, sku, department].join("\u0000");
      const entry = rowsByKey.get(key) || {
        date: column.date,
        sku: sku,
        description: String(row[1] || "").trim(),
        department: department,
        qty: 0,
        srp: Number(row[4]) || 0,
        amount: 0,
      };
      entry.qty += qty;
      entry.amount += amount;
      rowsByKey.set(key, entry);
    }
  }
  const rows = [...rowsByKey.values()].map(row => ({ ...row, amount: Math.round(row.amount * 100) / 100 }));

  const archive = {
    version: 1,
    month: targetMonth,
    archived_at: new Date().toISOString(),
    dates: [...new Set(dateColumns.map(column => column.date))].sort(),
    rows: rows,
  };
  const folder = DriveApp.getFolderById(SALES_ARCHIVE_FOLDER_ID);
  const filename = "sales-" + targetMonth + ".json";
  const existingFiles = folder.getFilesByName(filename);
  if (existingFiles.hasNext()) {
    const file = existingFiles.next();
    if (existingFiles.hasNext()) throw new Error("Multiple " + filename + " files exist in the archive folder.");
    file.setContent(JSON.stringify(archive));
  } else {
    folder.createFile(filename, JSON.stringify(archive), MimeType.JSON);
  }
  console.log("Archived " + rows.length + " Sales entries for " + targetMonth + ".");
}

function salesArchiveDateKey(rawValue, displayValue, timezone) {
  if (rawValue instanceof Date && !isNaN(rawValue.getTime())) {
    return Utilities.formatDate(rawValue, timezone, "yyyy-MM-dd");
  }

  const values = [displayValue, rawValue].filter(value => value !== undefined && value !== null && value !== "");
  for (const value of values) {
    const text = String(value).trim();
    if (!text) continue;

    const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) {
      const year = Number(isoMatch[1]);
      const month = Number(isoMatch[2]) - 1;
      const day = Number(isoMatch[3]);
      const parsed = new Date(Date.UTC(year, month, day, 12, 0, 0));
      if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, timezone, "yyyy-MM-dd");
    }

    const monthNameMatch = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    if (monthNameMatch) {
      const month = new Date(Date.parse(monthNameMatch[1] + " 1, " + monthNameMatch[3])).getMonth();
      const year = Number(monthNameMatch[3]);
      const day = Number(monthNameMatch[2]);
      const parsed = new Date(Date.UTC(year, month, day, 12, 0, 0));
      if (!isNaN(parsed.getTime())) return Utilities.formatDate(parsed, timezone, "yyyy-MM-dd");
    }

    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return Utilities.formatDate(parsed, timezone, "yyyy-MM-dd");
    }
  }

  return "";
}
