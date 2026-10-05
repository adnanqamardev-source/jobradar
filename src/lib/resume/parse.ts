/**
 * parse.ts — resume text extraction (BE-315).
 *
 * Extracts plain text from PDF and DOCX files. The actual parsing of
 * structured data happens in `extract-rules.ts` (rule-based) and
 * `extract-llm.ts` (LLM fallback).
 *
 * This module handles file I/O and delegates to the appropriate extractor.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedText {
  text: string;
  mimeType: string;
  pageCount?: number;
}

// ---------------------------------------------------------------------------
// PDF extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from a PDF file.
 *
 * Uses pdfjs-dist for server-side PDF parsing. The PDF is loaded and
 * each page's text content is extracted and concatenated.
 *
 * Note: pdfjs-dist requires Node.js runtime. Ensure the route handler
 * or server action uses `export const runtime = "nodejs"`.
 */
export async function extractPdfText(buffer: Buffer): Promise<ExtractedText> {
  // Dynamic import to avoid bundling issues in edge runtime
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  const textParts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    textParts.push(pageText);
  }

  return {
    text: textParts.join("\n"),
    mimeType: "application/pdf",
    pageCount: pdf.numPages,
  };
}

// ---------------------------------------------------------------------------
// DOCX extraction
// ---------------------------------------------------------------------------

/**
 * Extract text from a DOCX file.
 *
 * Uses mammoth for server-side DOCX parsing. Extracts the raw text
 * content from the document.
 */
export async function extractDocxText(buffer: Buffer): Promise<ExtractedText> {
  const mammoth = await import("mammoth");

  const result = await mammoth.extractRawText({
    buffer: buffer,
  });

  return {
    text: result.value,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Extract text from a resume file (PDF or DOCX).
 *
 * @param buffer - The file contents as a Buffer
 * @param mimeType - The MIME type of the file
 * @returns The extracted text and metadata
 * @throws If the file type is unsupported or extraction fails
 */
export async function extractResumeText(
  buffer: Buffer,
  mimeType: string,
): Promise<ExtractedText> {
  switch (mimeType) {
    case "application/pdf":
      return extractPdfText(buffer);
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return extractDocxText(buffer);
    default:
      throw new Error(`Unsupported file type: ${mimeType}`);
  }
}
