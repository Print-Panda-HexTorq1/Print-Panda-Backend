import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import libre from "libreoffice-convert";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

const convertWithLibre = promisify(libre.convert);

const PDF_EXTENSIONS = new Set([".pdf"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff"]);
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv", ".json", ".xml", ".log"]);
const LIBREOFFICE_EXTENSIONS = new Set([
  ".doc", ".docx", ".rtf", ".odt",
  ".xls", ".xlsx", ".ods",
  ".ppt", ".pptx", ".odp"
]);

function estimateTextPages(content) {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n").reduce((count, line) => {
    const effectiveLength = Math.max(line.length, 1);
    return count + Math.ceil(effectiveLength / 95);
  }, 0);
  return Math.max(1, Math.ceil(lines / 42));
}

async function countPdfPages(filePath) {
  const bytes = fs.readFileSync(filePath);
  const document = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return document.getPageCount();
}

async function countOfficePages(filePath) {
  const source = fs.readFileSync(filePath);
  const pdfBuffer = await convertWithLibre(source, ".pdf", undefined);
  const pdf = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  return pdf.getPageCount();
}

function isMissingLibreOfficeBinaryError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("could not find soffice binary") || message.includes("spawn soffice") || message.includes("enoent");
}

export async function detectPageCount(filePath) {
  const extension = path.extname(filePath || "").toLowerCase();

  if (PDF_EXTENSIONS.has(extension)) {
    return countPdfPages(filePath);
  }

  if (IMAGE_EXTENSIONS.has(extension)) {
    await sharp(filePath).metadata();
    return 1;
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    return estimateTextPages(fs.readFileSync(filePath, "utf8"));
  }

  if (LIBREOFFICE_EXTENSIONS.has(extension)) {
    try {
      return await countOfficePages(filePath);
    } catch (error) {
      // Keep upload flow alive even when LibreOffice is unavailable.
      if (isMissingLibreOfficeBinaryError(error)) {
        console.warn(`LibreOffice binary not found while inspecting ${filePath}; defaulting page_count=1.`);
        return 1;
      }

      console.warn(`Office page count inspection failed for ${filePath}; defaulting page_count=1.`, error?.message || error);
      return 1;
    }
  }

  return 1;
}