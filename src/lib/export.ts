import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JSZip from 'jszip';
import portfolioCss from '../portfolio/portfolio.css?raw';
import { PortfolioRenderer } from '../portfolio/PortfolioRenderer';
import { portfolioSchema, type PortfolioDocument } from '../../shared/portfolio';

const fontFiles = [
  { family: 'Inter', url: '/fonts/inter.woff2', filename: 'inter.woff2', weight: '100 900' },
  { family: 'Fraunces', url: '/fonts/fraunces.woff2', filename: 'fraunces.woff2', weight: '100 900' },
  { family: 'Space Grotesk', url: '/fonts/space-grotesk.woff2', filename: 'space-grotesk.woff2', weight: '300 700' },
  { family: 'IBM Plex Mono', url: '/fonts/plex-mono.woff2', filename: 'plex-mono.woff2', weight: '400' },
] as const;
const fontLicense = `SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007

This export bundles Inter, Fraunces, Space Grotesk and IBM Plex Mono. These fonts
are licensed under the SIL Open Font License, Version 1.1.

Permission is hereby granted, free of charge, to any person obtaining a copy of
the Font Software, to use, study, copy, merge, embed, modify, redistribute, and
sell modified and unmodified copies of the Font Software, subject to the
following conditions:

1. Neither the Font Software nor any of its individual components, in Original
   or Modified Versions, may be sold by itself.
2. Original or Modified Versions of the Font Software may be bundled,
   redistributed and/or sold with any software, provided that each copy of the
   Font Software contains the above copyright notice and this license. These
   can be included as stand-alone text files, in human-readable headers or in
   the metadata fields of text or binary files as long as those fields can be
   easily viewed by the user.
3. No Modified Version of the Font Software may use the Reserved Font Name(s)
   unless explicit written permission is granted by the corresponding
   Copyright Holder. This restriction only applies to the primary font name as
   presented to the users.
4. The name(s) of the Copyright Holder(s) or the Author(s) of the Font Software
   shall not be used to promote, endorse or advertise any Modified Version,
   except to acknowledge the contribution(s) of the Copyright Holder(s) and the
   Author(s), or with their explicit written permission.
5. The Font Software, modified or unmodified, in part or in whole, must be
   distributed entirely under this license, and must not be distributed under
   any other license. The requirement for fonts to remain under this license
   does not apply to any document created using the Font Software.

THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF COPYRIGHT, PATENT,
TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, INCLUDING ANY GENERAL, SPECIAL,
INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
FONT SOFTWARE OR THE USE OR OTHER DEALINGS IN THE FONT SOFTWARE.

https://scripts.sil.org/OFL
`;

const extensionFor = (type: string) => {
  if (type.includes('png')) return 'png';
  if (type.includes('webp')) return 'webp';
  if (type.includes('gif')) return 'gif';
  return 'jpg';
};

const safeFileStem = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'portfolio';

function replaceAll(source: string, values: Map<string, string>) {
  let result = source;
  values.forEach((replacement, original) => { result = result.split(original).join(replacement); });
  return result;
}

async function downloadAsset(url: string, index: number): Promise<{ path: string; data: Blob } | null> {
  if (!url || url.startsWith('data:')) return null;
  try {
    const source = url.startsWith('/') && typeof window !== 'undefined' ? new URL(url, window.location.origin).href : url;
    const response = await fetch(source, { mode: 'cors' });
    if (!response.ok) return null;
    const type = response.headers.get('content-type') || '';
    if (!type.startsWith('image/') || Number(response.headers.get('content-length') || 0) > 12_000_000) return null;
    return { path: `images/image-${index + 1}.${extensionFor(type)}`, data: await response.blob() };
  } catch {
    return null;
  }
}

async function collectImages(portfolioDocument: PortfolioDocument) {
  const urls = [...new Set(portfolioDocument.sections.flatMap(section => [section.image, ...section.items.map(item => item.image)]).filter(Boolean))];
  if (urls.length > 64) throw new Error('This portfolio has more than 64 images. Export fewer images at a time.');
  const files: Array<{ original: string; path: string; data: Blob }> = [];
  const missing: string[] = [];
  for (let index = 0; index < urls.length; index += 1) {
    const file = await downloadAsset(urls[index], index);
    if (file) files.push({ original: urls[index], ...file }); else missing.push(urls[index]);
  }
  return { files, missing, urls };
}

async function collectFonts() {
  const files: Array<{ path: string; data: Blob }> = [];
  for (const font of fontFiles) {
    let response: Response;
    try { response = await fetch(font.url); } catch { throw new Error(`Could not download the ${font.family} font for export.`); }
    if (!response.ok) throw new Error(`Could not download the ${font.family} font for export.`);
    files.push({ path: `fonts/${font.filename}`, data: await response.blob() });
  }
  const css = fontFiles.map(font => `@font-face{font-family:'${font.family}';font-style:normal;font-weight:${font.weight};font-display:swap;src:url('./fonts/${font.filename}') format('woff2');}`).join('\n');
  return { files, css };
}

function staticHtml(portfolioDocument: PortfolioDocument, images: Array<{ original: string; path: string }>) {
  const rendered = renderToStaticMarkup(React.createElement(PortfolioRenderer, { document: portfolioDocument, preview: true }));
  const imageMap = new Map(images.flatMap(image => [[image.original, image.path], [escapeHtml(image.original), image.path]]));
  const html = replaceAll(rendered, imageMap);
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="${escapeHtml(portfolioDocument.seo.description)}"><title>${escapeHtml(portfolioDocument.seo.title)}</title><link rel="stylesheet" href="fonts/fonts.css"><link rel="stylesheet" href="assets/portfolio.css"></head><body>${html}</body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] || character));
}

function readme(portfolioDocument: PortfolioDocument, source = false, missingImages: string[] = []) {
  const warning = missingImages.length ? `\n\n## Asset notes\n\n${missingImages.length} image(s) could not be copied because the source blocked browser downloads. See export-manifest.json for the original URLs. The page keeps those URLs as a documented online fallback.\n` : '';
  return `# ${portfolioDocument.name}\n\nThis is an exported portfolio from Portfolio Studio. ${source ? 'The editable portfolio document is included as portfolio.json so you can continue editing or migrate it to another tool.' : 'Open index.html in a browser to view the portfolio.'}\n\n## Included\n\n- index.html — the standalone published page\n- assets/portfolio.css — the editable visual styles\n- fonts/ — bundled font files and font notices\n- images/ — local copies of downloadable portfolio images\n- portfolio.json — the editable Portfolio Studio document\n- export-manifest.json — asset copy results and any documented fallbacks\n\nThe export contains no account credentials, API keys or server configuration.${warning}\n`;
}

async function buildExport(portfolioDocument: PortfolioDocument, source: boolean): Promise<Blob> {
  const [imageResult, fonts] = await Promise.all([collectImages(portfolioDocument), collectFonts()]);
  const imageRefs = imageResult.files.map(({ original, path }) => ({ original, path: `./${path}` }));
  const html = staticHtml(portfolioDocument, imageRefs);
  const zip = new JSZip();
  zip.file('index.html', html);
  zip.file('assets/portfolio.css', portfolioCss);
  zip.file('fonts/fonts.css', fonts.css.replaceAll("./fonts/", './'));
  zip.file('portfolio.json', JSON.stringify(portfolioDocument, null, 2));
  imageResult.files.forEach(image => zip.file(image.path, image.data));
  fonts.files.forEach(font => zip.file(font.path, font.data));
  zip.file('fonts/OFL.txt', fontLicense);
  zip.file('export-manifest.json', JSON.stringify({ format: 'portfolio-studio-export', version: 1, images: imageResult.urls.map(url => ({ url, localPath: imageResult.files.find(file => file.original === url)?.path || null })), missingImages: imageResult.missing, fonts: fontFiles.map(font => `fonts/${font.filename}`) }, null, 2));
  zip.file('README.md', readme(portfolioDocument, source, imageResult.missing));
  if (source) zip.file('studio-export.json', JSON.stringify({ format: 'portfolio-studio-source', version: 1, document: portfolioDocument }, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export function exportPortfolioSite(portfolioDocument: PortfolioDocument) { return buildExport(portfolioDocument, false); }
export function exportPortfolioSource(portfolioDocument: PortfolioDocument) { return buildExport(portfolioDocument, true); }
export function downloadExport(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function exportFilename(portfolioDocument: PortfolioDocument, source = false) { return `${safeFileStem(portfolioDocument.name)}-${source ? 'source' : 'website'}.zip`; }
export function parsePortfolioJson(value: string): PortfolioDocument { return portfolioSchema.parse(JSON.parse(value)); }
