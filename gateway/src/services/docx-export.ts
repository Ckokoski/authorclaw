/**
 * AuthorClaw DOCX Export Utility
 * Shared between the /api/author-os/format endpoint and manuscript assembly.
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';

export interface DocxExportOptions {
  title: string;
  author: string;
  content: string;  // Markdown content
}

/**
 * Generate a DOCX buffer from markdown content.
 * Returns a Node.js Buffer ready to write to disk.
 */
export async function generateDocxBuffer(options: DocxExportOptions): Promise<Buffer> {
  const { title, author, content } = options;
  const paragraphs: any[] = [];

  // Title page
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: title, bold: true, size: 48 })],
    spacing: { after: 400 },
  }));
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: 'by ' + author, italics: true, size: 24 })],
    spacing: { after: 800 },
  }));
  paragraphs.push(new Paragraph({
    children: [new TextRun({ text: '' })],
    spacing: { after: 400 },
  }));

  // Parse markdown content into paragraphs
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('# ')) {
      paragraphs.push(new Paragraph({ text: line.replace(/^# /, ''), heading: HeadingLevel.HEADING_1 }));
    } else if (line.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: line.replace(/^## /, ''), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith('### ')) {
      paragraphs.push(new Paragraph({ text: line.replace(/^### /, ''), heading: HeadingLevel.HEADING_3 }));
    } else if (line.trim() === '') {
      paragraphs.push(new Paragraph({ children: [] }));
    } else {
      // Handle basic bold/italic markdown
      const children: any[] = [];
      const parts = line.split(/(\*\*.*?\*\*|\*.*?\*)/);
      for (const part of parts) {
        if (part.startsWith('**') && part.endsWith('**')) {
          children.push(new TextRun({ text: part.slice(2, -2), bold: true }));
        } else if (part.startsWith('*') && part.endsWith('*')) {
          children.push(new TextRun({ text: part.slice(1, -1), italics: true }));
        } else {
          children.push(new TextRun({ text: part }));
        }
      }
      paragraphs.push(new Paragraph({ children }));
    }
  }

  const doc = new Document({
    creator: author,
    title: title,
    sections: [{ children: paragraphs }],
  });

  const buffer = await Packer.toBuffer(doc);
  return buffer as Buffer;
}
