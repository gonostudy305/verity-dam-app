import type { MediaAsset } from '@/types/media';

/**
 * Universal Client-Side Image Metadata Injector (JPEG, PNG, WebP)
 * Pure TypeScript (Zero-dependency, 0ms latency, zero server CPU load).
 * Embeds Title, SKU, Brand, Author, Copyright, Credit, Keywords, and Captions.
 */

// Helper to encode string to UTF-8 bytes
function utf8Encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Core TIFF IFD0 EXIF Builder (Shared across JPEG, PNG eXIf, and WebP EXIF)
// ─────────────────────────────────────────────────────────────────────────────
interface ExifTagEntry {
  tag: number;
  type: number; // 2 = ASCII, 7 = UNDEFINED
  data: Uint8Array;
}

export function buildTiffExifBuffer(asset: MediaAsset): Uint8Array {
  const encoder = new TextEncoder();
  const tags: ExifTagEntry[] = [];

  const addAsciiTag = (tag: number, val?: string | null) => {
    if (!val || !val.trim()) return;
    const bytes = encoder.encode(val.trim() + '\0');
    tags.push({ tag, type: 2, data: bytes });
  };

  // ImageDescription (0x010E): Title or AI Caption
  const description = asset.suggested_caption || asset.description || asset.title;
  addAsciiTag(0x010e, description);

  // Make (0x010F): Brand
  addAsciiTag(0x010f, asset.brand);

  // Model (0x0110): SKU
  addAsciiTag(0x0110, asset.sku);

  // Software (0x0131): Generator Software
  addAsciiTag(0x0131, 'VerityDAM Studio v1.0');

  // Artist (0x013B): Author
  addAsciiTag(0x013b, asset.author || 'VerityDAM Platform');

  // Copyright (0x8298): Copyright Notice
  addAsciiTag(0x8298, asset.copyright || '© 2026 VerityDAM Platform. All rights reserved.');

  // UserComment (0x9286): UNDEFINED with UTF-8 character encoding header
  const userComments: string[] = [];
  if (asset.credit) userComments.push(`Credit: ${asset.credit}`);
  if (asset.category) userComments.push(`Category: ${asset.category}`);
  if (asset.space) userComments.push(`Space: ${asset.space}`);
  if (asset.keywords && asset.keywords.length > 0) {
    userComments.push(`Tags: ${asset.keywords.join(', ')}`);
  }
  if (userComments.length > 0) {
    const commentStr = userComments.join(' | ');
    const header = new Uint8Array([0x55, 0x4e, 0x49, 0x43, 0x4f, 0x44, 0x45, 0x00]); // "UNICODE\0"
    const commentBytes = encoder.encode(commentStr);
    const combined = new Uint8Array(header.length + commentBytes.length);
    combined.set(header, 0);
    combined.set(commentBytes, header.length);
    tags.push({ tag: 0x9286, type: 7, data: combined });
  }

  // Sort tags by Tag ID ascending (TIFF requirement)
  tags.sort((a, b) => a.tag - b.tag);

  const numEntries = tags.length;
  if (numEntries === 0) return new Uint8Array(0);

  // 8 bytes (TIFF header) + 2 bytes (entry count) + (12 bytes * numEntries) + 4 bytes (next IFD offset = 0)
  const ifd0HeaderSize = 8 + 2 + numEntries * 12 + 4;

  let totalDataSize = 0;
  for (const entry of tags) {
    if (entry.data.length > 4) {
      totalDataSize += entry.data.length;
    }
  }

  const tiffSize = ifd0HeaderSize + totalDataSize;
  const buffer = new Uint8Array(tiffSize);
  const view = new DataView(buffer.buffer);

  let offset = 0;

  // TIFF Header: Little Endian ('II', 42, offset to IFD0 = 8)
  buffer[offset++] = 0x49; // 'I'
  buffer[offset++] = 0x49; // 'I'
  view.setUint16(offset, 42, true);
  offset += 2;
  view.setUint32(offset, 8, true);
  offset += 4;

  // Number of IFD0 entries (Little Endian)
  view.setUint16(offset, numEntries, true);
  offset += 2;

  let dataOffsetRelative = ifd0HeaderSize;

  for (const entry of tags) {
    view.setUint16(offset, entry.tag, true); // Tag ID
    view.setUint16(offset + 2, entry.type, true); // Type
    view.setUint32(offset + 4, entry.data.length, true); // Count

    if (entry.data.length <= 4) {
      for (let i = 0; i < entry.data.length; i++) {
        buffer[offset + 8 + i] = entry.data[i];
      }
      for (let i = entry.data.length; i < 4; i++) {
        buffer[offset + 8 + i] = 0;
      }
    } else {
      view.setUint32(offset + 8, dataOffsetRelative, true);
      buffer.set(entry.data, dataOffsetRelative);
      dataOffsetRelative += entry.data.length;
    }

    offset += 12;
  }

  // Next IFD Offset = 0
  view.setUint32(offset, 0, true);

  return buffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. JPEG (EXIF APP1 + IPTC APP13) Builder
// ─────────────────────────────────────────────────────────────────────────────
export function buildExifSegment(asset: MediaAsset): Uint8Array {
  const tiffBuffer = buildTiffExifBuffer(asset);
  if (tiffBuffer.length === 0) return new Uint8Array(0);

  const app1Length = 2 + 6 + tiffBuffer.length;
  const buffer = new Uint8Array(2 + app1Length);
  const view = new DataView(buffer.buffer);

  let offset = 0;
  buffer[offset++] = 0xff;
  buffer[offset++] = 0xe1; // Marker APP1

  view.setUint16(offset, app1Length, false); // Length (Big Endian)
  offset += 2;

  buffer.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], offset); // "Exif\0\0"
  offset += 6;

  buffer.set(tiffBuffer, offset);

  return buffer;
}

export function buildIptcSegment(asset: MediaAsset): Uint8Array {
  const encoder = new TextEncoder();
  const datasets: Array<{ record: number; dataset: number; data: Uint8Array }> = [];

  const addDataset = (dataset: number, text?: string | null) => {
    if (!text || !text.trim()) return;
    datasets.push({
      record: 2,
      dataset,
      data: encoder.encode(text.trim()),
    });
  };

  // 1:90 Coded Character Set: UTF-8 (\x1B%G)
  datasets.push({
    record: 1,
    dataset: 90,
    data: new Uint8Array([0x1b, 0x25, 0x47]),
  });

  // 2:00 Record Version: 4
  datasets.push({
    record: 2,
    dataset: 0,
    data: new Uint8Array([0x00, 0x04]),
  });

  // 2:05 Object Name: SKU or Title
  addDataset(5, (asset.sku ? `${asset.sku} - ${asset.title || asset.brand || ''}`.trim() : asset.title) || 'Untitled');

  // 2:25 Keywords (Repeated for each tag)
  if (asset.keywords && Array.isArray(asset.keywords)) {
    for (const kw of asset.keywords) {
      addDataset(25, kw);
    }
  }
  if (asset.brand) addDataset(25, asset.brand);
  if (asset.sku) addDataset(25, asset.sku);
  if (asset.category) addDataset(25, asset.category);

  // 2:80 By-line: Author
  addDataset(80, asset.author || 'VerityDAM Platform');

  // 2:110 Credit: Media Team
  addDataset(110, asset.credit || 'VerityDAM Team');

  // 2:116 Copyright Notice
  addDataset(116, asset.copyright || '© 2026 VerityDAM Platform. All rights reserved.');

  // 2:120 Caption/Abstract: Full Description / AI Caption
  addDataset(120, asset.description || asset.suggested_caption);

  if (datasets.length === 0) return new Uint8Array(0);

  let iptcPayloadSize = 0;
  for (const ds of datasets) {
    iptcPayloadSize += 5 + ds.data.length;
  }

  const iptcBuffer = new Uint8Array(iptcPayloadSize);
  let iptcOffset = 0;
  for (const ds of datasets) {
    iptcBuffer[iptcOffset++] = 0x1c;
    iptcBuffer[iptcOffset++] = ds.record;
    iptcBuffer[iptcOffset++] = ds.dataset;
    iptcBuffer[iptcOffset++] = (ds.data.length >> 8) & 0xff;
    iptcBuffer[iptcOffset++] = ds.data.length & 0xff;
    iptcBuffer.set(ds.data, iptcOffset);
    iptcOffset += ds.data.length;
  }

  const isOdd = iptcPayloadSize % 2 !== 0;
  const paddedIptcSize = isOdd ? iptcPayloadSize + 1 : iptcPayloadSize;
  const bimBlockSize = 4 + 2 + 2 + 4 + paddedIptcSize;

  const psHeader = utf8Encode('Photoshop 3.0\0');
  const app13PayloadLength = psHeader.length + bimBlockSize;
  const app13TotalLength = 2 + 2 + app13PayloadLength;

  const app13Buffer = new Uint8Array(app13TotalLength);
  const view = new DataView(app13Buffer.buffer);
  let outOffset = 0;

  app13Buffer[outOffset++] = 0xff;
  app13Buffer[outOffset++] = 0xed; // Marker APP13

  view.setUint16(outOffset, 2 + app13PayloadLength, false);
  outOffset += 2;

  app13Buffer.set(psHeader, outOffset);
  outOffset += psHeader.length;

  app13Buffer.set([0x38, 0x42, 0x49, 0x4d], outOffset); // "8BIM"
  outOffset += 4;

  view.setUint16(outOffset, 0x0404, false); // IPTC-NAA
  outOffset += 2;

  app13Buffer[outOffset++] = 0x00;
  app13Buffer[outOffset++] = 0x00;

  view.setUint32(outOffset, iptcPayloadSize, false);
  outOffset += 4;

  app13Buffer.set(iptcBuffer, outOffset);
  outOffset += iptcPayloadSize;

  if (isOdd) {
    app13Buffer[outOffset++] = 0x00;
  }

  return app13Buffer;
}

function stripJpegMetadataSegments(source: Uint8Array): { header: Uint8Array; body: Uint8Array } {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) {
    return { header: source.subarray(0, 2), body: source.subarray(2) };
  }

  let offset = 2;
  let app0End = 2;
  if (source[2] === 0xff && source[3] === 0xe0 && source.length >= 6) {
    const app0Len = (source[4] << 8) | source[5];
    app0End = Math.min(source.length, 4 + app0Len);
    offset = app0End;
  }
  const header = source.subarray(0, app0End);

  const remainingParts: Uint8Array[] = [];
  while (offset < source.length) {
    if (source[offset] !== 0xff) {
      remainingParts.push(source.subarray(offset));
      break;
    }
    const marker = source[offset + 1];
    if (marker === 0xda || marker === 0xd9) {
      // SOS (Start of Scan) or EOI
      remainingParts.push(source.subarray(offset));
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      remainingParts.push(source.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > source.length) {
      remainingParts.push(source.subarray(offset));
      break;
    }
    const segLen = (source[offset + 2] << 8) | source[offset + 3];
    const segTotal = Math.min(source.length - offset, 2 + segLen);
    // Strip existing APP1 (EXIF / XMP) and APP13 (Photoshop / IPTC) to prevent duplicate bloat
    if (marker === 0xe1 || marker === 0xed) {
      offset += segTotal;
    } else {
      remainingParts.push(source.subarray(offset, offset + segTotal));
      offset += segTotal;
    }
  }

  const totalRemLen = remainingParts.reduce((acc, p) => acc + p.length, 0);
  const body = new Uint8Array(totalRemLen);
  let cur = 0;
  for (const p of remainingParts) {
    body.set(p, cur);
    cur += p.length;
  }

  return { header, body };
}

export async function injectJpegMetadata(jpegBlob: Blob, asset: MediaAsset): Promise<Blob> {
  try {
    const arrayBuffer = await jpegBlob.arrayBuffer();
    const source = new Uint8Array(arrayBuffer);

    if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) {
      return jpegBlob;
    }

    const exifSegment = buildExifSegment(asset);
    const iptcSegment = buildIptcSegment(asset);

    if (exifSegment.length === 0 && iptcSegment.length === 0) {
      return jpegBlob;
    }

    const { header, body } = stripJpegMetadataSegments(source);
    const newTotalLength = header.length + exifSegment.length + iptcSegment.length + body.length;
    const resultBuffer = new Uint8Array(newTotalLength);

    let curOffset = 0;
    resultBuffer.set(header, curOffset);
    curOffset += header.length;

    if (exifSegment.length > 0) {
      resultBuffer.set(exifSegment, curOffset);
      curOffset += exifSegment.length;
    }

    if (iptcSegment.length > 0) {
      resultBuffer.set(iptcSegment, curOffset);
      curOffset += iptcSegment.length;
    }

    resultBuffer.set(body, curOffset);

    return new Blob([resultBuffer], { type: 'image/jpeg' });
  } catch (err) {
    console.warn('Failed to inject JPEG metadata:', err);
    return jpegBlob;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PNG (iTXt + eXIf Chunks with CRC32) Builder
// ─────────────────────────────────────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c;
}

function calculateCrc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = utf8Encode(type);
  const totalLength = 4 + 4 + data.length + 4; // Length(4) + Type(4) + Data + CRC(4)
  const chunk = new Uint8Array(totalLength);
  const view = new DataView(chunk.buffer);

  // Length (Big Endian)
  view.setUint32(0, data.length, false);

  // Type
  chunk.set(typeBytes, 4);

  // Data
  chunk.set(data, 8);

  // CRC32 calculated over Type + Data
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  const crc = calculateCrc32(crcInput);
  view.setUint32(8 + data.length, crc, false);

  return chunk;
}

function createItxtChunk(keyword: string, text: string): Uint8Array {
  const encoder = new TextEncoder();
  const kwBytes = encoder.encode(keyword);
  const textBytes = encoder.encode(text);

  // iTXt payload: Keyword + null(1) + compFlag(1) + compMethod(1) + langTag(null, 1) + transKw(null, 1) + Text
  const payloadSize = kwBytes.length + 1 + 1 + 1 + 1 + 1 + textBytes.length;
  const payload = new Uint8Array(payloadSize);

  let offset = 0;
  payload.set(kwBytes, offset);
  offset += kwBytes.length;
  payload[offset++] = 0; // null separator

  payload[offset++] = 0; // uncompressed flag
  payload[offset++] = 0; // compression method 0
  payload[offset++] = 0; // empty language tag (null)
  payload[offset++] = 0; // empty translated keyword (null)

  payload.set(textBytes, offset);

  return createPngChunk('iTXt', payload);
}

export async function injectPngMetadata(pngBlob: Blob, asset: MediaAsset): Promise<Blob> {
  try {
    const arrayBuffer = await pngBlob.arrayBuffer();
    const source = new Uint8Array(arrayBuffer);

    // Verify PNG Signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      source.length < 8 ||
      source[0] !== 0x89 ||
      source[1] !== 0x50 ||
      source[2] !== 0x4e ||
      source[3] !== 0x47 ||
      source[4] !== 0x0d ||
      source[5] !== 0x0a ||
      source[6] !== 0x1a ||
      source[7] !== 0x0a
    ) {
      return pngBlob;
    }

    const chunksToInsert: Uint8Array[] = [];

    // 1. Add iTXt Chunks
    const title = asset.sku ? `${asset.sku} - ${asset.title || asset.brand || ''}`.trim() : asset.title;
    if (title) chunksToInsert.push(createItxtChunk('Title', title));

    const author = asset.author || 'VerityDAM Platform';
    chunksToInsert.push(createItxtChunk('Author', author));

    const copyright = asset.copyright || '© 2026 VerityDAM Platform. All rights reserved.';
    chunksToInsert.push(createItxtChunk('Copyright', copyright));

    const description = asset.suggested_caption || asset.description;
    if (description) chunksToInsert.push(createItxtChunk('Description', description));

    chunksToInsert.push(createItxtChunk('Software', 'VerityDAM Studio v1.0'));

    if (asset.keywords && asset.keywords.length > 0) {
      chunksToInsert.push(createItxtChunk('Keywords', asset.keywords.join(', ')));
    }

    const commentParts: string[] = [];
    if (asset.sku) commentParts.push(`SKU: ${asset.sku}`);
    if (asset.brand) commentParts.push(`Brand: ${asset.brand}`);
    if (asset.credit) commentParts.push(`Credit: ${asset.credit}`);
    if (asset.category) commentParts.push(`Category: ${asset.category}`);
    if (commentParts.length > 0) {
      chunksToInsert.push(createItxtChunk('Comment', commentParts.join(' | ')));
    }

    // 2. Add eXIf Chunk (TIFF EXIF structure)
    const tiffBuffer = buildTiffExifBuffer(asset);
    if (tiffBuffer.length > 0) {
      chunksToInsert.push(createPngChunk('eXIf', tiffBuffer));
    }

    if (chunksToInsert.length === 0) return pngBlob;

    // Insertion index: directly after IHDR chunk
    // PNG Signature (8) + IHDR length (4) + 'IHDR' (4) + IHDR Data (13) + CRC (4) = 33 bytes
    let insertIndex = 33;
    if (source.length < 33) insertIndex = source.length;

    let insertSize = 0;
    for (const ch of chunksToInsert) {
      insertSize += ch.length;
    }

    const resultBuffer = new Uint8Array(source.length + insertSize);
    resultBuffer.set(source.subarray(0, insertIndex), 0);

    let curOffset = insertIndex;
    for (const ch of chunksToInsert) {
      resultBuffer.set(ch, curOffset);
      curOffset += ch.length;
    }

    resultBuffer.set(source.subarray(insertIndex), curOffset);

    return new Blob([resultBuffer], { type: 'image/png' });
  } catch (err) {
    console.warn('Failed to inject PNG metadata:', err);
    return pngBlob;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. WebP (RIFF VP8X Extended Container + EXIF Chunk) Builder
// ─────────────────────────────────────────────────────────────────────────────
export async function injectWebpMetadata(webpBlob: Blob, asset: MediaAsset): Promise<Blob> {
  try {
    const arrayBuffer = await webpBlob.arrayBuffer();
    const source = new Uint8Array(arrayBuffer);

    // Verify RIFF & WEBP signature
    if (
      source.length < 12 ||
      source[0] !== 0x52 || // 'R'
      source[1] !== 0x49 || // 'I'
      source[2] !== 0x46 || // 'F'
      source[3] !== 0x46 || // 'F'
      source[8] !== 0x57 || // 'W'
      source[9] !== 0x45 || // 'E'
      source[10] !== 0x42 || // 'B'
      source[11] !== 0x50 // 'P'
    ) {
      return webpBlob;
    }

    const tiffBuffer = buildTiffExifBuffer(asset);
    if (tiffBuffer.length === 0) return webpBlob;

    // Create EXIF chunk payload: 'EXIF' + size (4B LE) + tiffBuffer (+ padding if odd)
    const isOdd = tiffBuffer.length % 2 !== 0;
    const exifChunkTotalSize = 4 + 4 + tiffBuffer.length + (isOdd ? 1 : 0);
    const exifChunk = new Uint8Array(exifChunkTotalSize);
    const exifView = new DataView(exifChunk.buffer);

    exifChunk.set([0x45, 0x58, 0x49, 0x46], 0); // 'EXIF'
    exifView.setUint32(4, tiffBuffer.length, true); // Little Endian Size
    exifChunk.set(tiffBuffer, 8);
    if (isOdd) {
      exifChunk[8 + tiffBuffer.length] = 0x00;
    }

    // Check if the file already has a VP8X chunk
    const firstChunkTag = String.fromCharCode(source[12], source[13], source[14], source[15]);

    if (firstChunkTag === 'VP8X') {
      // Modify VP8X flags: set Bit 3 (0x08 = EXIF)
      source[20] |= 0x08;

      // Extract existing chunks excluding any old EXIF chunk to avoid duplicate chunk bloat
      const retainedChunks: Uint8Array[] = [];
      let offset = 12; // Start after RIFF header (12 bytes)
      while (offset < source.length) {
        if (offset + 8 > source.length) break;
        const tag = String.fromCharCode(source[offset], source[offset + 1], source[offset + 2], source[offset + 3]);
        const chunkSize = source[offset + 4] | (source[offset + 5] << 8) | (source[offset + 6] << 16) | (source[offset + 7] << 24);
        const paddedChunkSize = 8 + chunkSize + (chunkSize % 2);
        const chunkTotalLen = Math.min(paddedChunkSize, source.length - offset);

        if (tag !== 'EXIF') {
          retainedChunks.push(source.subarray(offset, offset + chunkTotalLen));
        }
        offset += chunkTotalLen;
      }

      const retainedLen = retainedChunks.reduce((acc, c) => acc + c.length, 0);
      const newTotalSize = 12 + retainedLen + exifChunkTotalSize;
      const resultBuffer = new Uint8Array(newTotalSize);
      const resView = new DataView(resultBuffer.buffer);

      // 'RIFF' + Size + 'WEBP'
      resultBuffer.set(source.subarray(0, 4), 0);
      resView.setUint32(4, newTotalSize - 8, true);
      resultBuffer.set(source.subarray(8, 12), 8);

      let curOffset = 12;
      for (const ch of retainedChunks) {
        resultBuffer.set(ch, curOffset);
        curOffset += ch.length;
      }
      resultBuffer.set(exifChunk, curOffset);

      return new Blob([resultBuffer], { type: 'image/webp' });
    }

    // Otherwise, convert Simple WebP (VP8 / VP8L) to Extended WebP (VP8X)
    let width = asset.dimensions?.width || 1200;
    let height = asset.dimensions?.height || 800;
    let hasAlpha = false;

    // Try parsing dimensions directly from bitstream
    if (firstChunkTag === 'VP8 ' && source.length >= 30) {
      // VP8 keyframe dimensions at offset 26-29
      const wRaw = (source[27] << 8) | source[26];
      const hRaw = (source[29] << 8) | source[28];
      const parsedW = wRaw & 0x3fff;
      const parsedH = hRaw & 0x3fff;
      if (parsedW > 0 && parsedH > 0) {
        width = parsedW;
        height = parsedH;
      }
    } else if (firstChunkTag === 'VP8L' && source.length >= 25) {
      // VP8L lossless header: byte 21 = 0x2F, then 4 bytes of packed dimensions
      const b1 = source[21];
      const b2 = source[22];
      const b3 = source[23];
      const b4 = source[24];
      const parsedW = 1 + (((b2 & 0x3f) << 8) | b1);
      const parsedH = 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
      hasAlpha = Boolean((b4 & 0x10) !== 0);
      if (parsedW > 0 && parsedH > 0) {
        width = parsedW;
        height = parsedH;
      }
    }

    // Build VP8X Chunk (18 bytes total)
    // 4B ('VP8X') + 4B (Size = 10) + 10B payload
    const vp8xChunk = new Uint8Array(18);
    const vp8xView = new DataView(vp8xChunk.buffer);
    vp8xChunk.set([0x56, 0x50, 0x38, 0x58], 0); // 'VP8X'
    vp8xView.setUint32(4, 10, true); // Size = 10

    let flags = 0x08; // Bit 3 = EXIF
    if (hasAlpha) flags |= 0x10; // Bit 4 = Alpha
    vp8xChunk[8] = flags;
    vp8xChunk[9] = 0; // Reserved
    vp8xChunk[10] = 0;
    vp8xChunk[11] = 0;

    const wMinus1 = Math.max(0, width - 1);
    const hMinus1 = Math.max(0, height - 1);

    // Canvas Width - 1 (24 bits LE)
    vp8xChunk[12] = wMinus1 & 0xff;
    vp8xChunk[13] = (wMinus1 >> 8) & 0xff;
    vp8xChunk[14] = (wMinus1 >> 16) & 0xff;

    // Canvas Height - 1 (24 bits LE)
    vp8xChunk[15] = hMinus1 & 0xff;
    vp8xChunk[16] = (hMinus1 >> 8) & 0xff;
    vp8xChunk[17] = (hMinus1 >> 16) & 0xff;

    // New file: RIFF Header(12) + VP8X(18) + Original bitstream chunks(source[12..]) + EXIF chunk
    const bitstreamData = source.subarray(12);
    const newTotalSize = 12 + 18 + bitstreamData.length + exifChunkTotalSize;
    const resultBuffer = new Uint8Array(newTotalSize);
    const resView = new DataView(resultBuffer.buffer);

    // 'RIFF' + Size + 'WEBP'
    resultBuffer.set(source.subarray(0, 4), 0);
    resView.setUint32(4, newTotalSize - 8, true);
    resultBuffer.set(source.subarray(8, 12), 8);

    // VP8X Chunk
    resultBuffer.set(vp8xChunk, 12);

    // Bitstream Data
    resultBuffer.set(bitstreamData, 12 + 18);

    // EXIF Chunk
    resultBuffer.set(exifChunk, 12 + 18 + bitstreamData.length);

    return new Blob([resultBuffer], { type: 'image/webp' });
  } catch (err) {
    console.warn('Failed to inject WebP metadata:', err);
    return webpBlob;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Universal Dispatcher (Auto Format Detection)
// ─────────────────────────────────────────────────────────────────────────────
export async function injectImageMetadata(
  blob: Blob,
  asset: MediaAsset,
  format?: 'auto' | 'jpg' | 'png' | 'webp'
): Promise<Blob> {
  const mime = blob.type.toLowerCase();
  const fmt = (format || 'auto').toLowerCase();

  if (fmt === 'png' || mime === 'image/png') {
    return injectPngMetadata(blob, asset);
  }
  if (fmt === 'webp' || mime === 'image/webp') {
    return injectWebpMetadata(blob, asset);
  }
  return injectJpegMetadata(blob, asset);
}