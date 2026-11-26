/**
 * Minimal ISO/IEC 18004 QR Code matrix generator (Byte mode, ECC Level L, Versions 1–5).
 * Supports up to 106 UTF-8 bytes (EVM 0x addresses are 42 bytes -> Version 3, 29x29).
 * Zero external dependencies.
 */

interface VersionSpec {
  version: number;
  size: number;
  dataCodewords: number;
  ecCodewords: number;
  alignmentCenters: readonly number[];
}

// Single-block ECC Level L tables from ISO/IEC 18004 Table 9
const VERSION_SPECS: readonly VersionSpec[] = [
  { version: 1, size: 21, dataCodewords: 19, ecCodewords: 7, alignmentCenters: [] },
  { version: 2, size: 25, dataCodewords: 34, ecCodewords: 10, alignmentCenters: [6, 18] },
  { version: 3, size: 29, dataCodewords: 55, ecCodewords: 15, alignmentCenters: [6, 22] },
  { version: 4, size: 33, dataCodewords: 80, ecCodewords: 20, alignmentCenters: [6, 26] },
  { version: 5, size: 37, dataCodewords: 108, ecCodewords: 26, alignmentCenters: [6, 30] },
];

// GF(256) with primitive polynomial 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: Uint8Array, ecLen: number): Uint8Array {
  const gen = rsGeneratorPoly(ecLen);
  const res = new Uint8Array(ecLen);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    for (let j = 0; j < ecLen - 1; j++) {
      res[j] = res[j + 1] ^ gfMul(gen[j + 1], factor);
    }
    res[ecLen - 1] = gfMul(gen[ecLen], factor);
  }
  return res;
}

function computeFormatBits(mask: number): number {
  // ECC Level L = 0b01
  const data = (0b01 << 3) | (mask & 7);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if (rem & (1 << i)) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function maskBit(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function scorePenalty(modules: boolean[][]): number {
  const size = modules.length;
  let penalty = 0;

  // Rule 1: adjacent modules in row/col in same color
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = modules[r][c];
      if (
        color === modules[r][c + 1] &&
        color === modules[r + 1][c] &&
        color === modules[r + 1][c + 1]
      ) {
        penalty += 3;
      }
    }
  }

  // Rule 4: balance of dark modules
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) dark++;
    }
  }
  const ratioPct = (dark * 100) / (size * size);
  const dev = Math.floor(Math.abs(ratioPct - 50) / 5);
  penalty += dev * 10;

  return penalty;
}

export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

export function encodeQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  // Byte mode header (4b mode + 8b count) = 12 bits -> 2 bytes overhead (with >=4b terminator fits in dataCodewords - 2)
  const spec = VERSION_SPECS.find((s) => bytes.length <= s.dataCodewords - 2);
  if (!spec) {
    throw new Error(`QR payload too long (${bytes.length} bytes)`);
  }

  // 1. Build bit stream -> data codewords
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8); // Character count (V1-V9)
  for (const b of bytes) pushBits(b, 8);

  const maxDataBits = spec.dataCodewords * 8;
  const termLen = Math.min(4, maxDataBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = new Uint8Array(spec.dataCodewords);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data[byteIdx++] = v;
  }
  const padBytes = [0xec, 0x11];
  let padTurn = 0;
  while (byteIdx < spec.dataCodewords) {
    data[byteIdx++] = padBytes[padTurn++ & 1];
  }

  // 2. Append Reed-Solomon ECC codewords
  const ec = rsRemainder(data, spec.ecCodewords);
  const allCodewords = new Uint8Array(data.length + ec.length);
  allCodewords.set(data, 0);
  allCodewords.set(ec, data.length);

  // 3. Place function patterns
  const { size } = spec;
  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false)
  );
  const isFunction: boolean[][] = Array.from({ length: size }, () =>
    Array<boolean>(size).fill(false)
  );

  const setFn = (r: number, c: number, dark: boolean) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark;
    isFunction[r][c] = true;
  };

  // Finder patterns + 1-module white separators
  const drawFinder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onOuterBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFn(r, c, inOuter && (onOuterBorder || inCenter));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment patterns (skip corners overlapping finders)
  for (const rCenter of spec.alignmentCenters) {
    for (const cCenter of spec.alignmentCenters) {
      if (isFunction[rCenter][cCenter]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(rCenter + dr, cCenter + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info zones & set fixed dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFn(8, i, false);
      setFn(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFn(8, size - 1 - i, false);
    if (i < 7) setFn(size - 1 - i, 8, false);
  }
  setFn(size - 8, 8, true); // Dark module

  // 4. Zigzag data placement
  let bitCursor = 0;
  const totalBits = allCodewords.length * 8;
  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5; // Skip vertical timing column
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dx = 0; dx < 2; dx++) {
        const c = rightCol - dx;
        if (isFunction[r][c]) continue;
        let dark = false;
        if (bitCursor < totalBits) {
          const cw = allCodewords[bitCursor >>> 3];
          dark = ((cw >>> (7 - (bitCursor & 7))) & 1) === 1;
          bitCursor++;
        }
        modules[r][c] = dark;
      }
    }
    upward = !upward;
  }

  // 5. Pick optimal mask (0..7) and write format info
  const applyFormat = (grid: boolean[][], mask: number) => {
    const fmt = computeFormatBits(mask);
    const bitAt = (i: number) => ((fmt >>> i) & 1) === 1;
    // Top-left copy (bit 14 -> 0)
    const tlCoords: Array<[number, number]> = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    for (let idx = 0; idx < 15; idx++) {
      const [r, c] = tlCoords[idx];
      grid[r][c] = bitAt(14 - idx);
    }
    // Split copy: bottom-left (bits 14..8) & top-right (bits 7..0)
    for (let i = 0; i < 7; i++) {
      grid[size - 1 - i][8] = bitAt(14 - i);
    }
    for (let i = 0; i < 8; i++) {
      grid[8][size - 8 + i] = bitAt(7 - i);
    }
  };

  let bestGrid = modules;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row, r) =>
      row.map((val, c) =>
        isFunction[r][c] ? val : maskBit(mask, r, c) ? !val : val
      )
    );
    applyFormat(candidate, mask);
    const score = scorePenalty(candidate);
    if (score < bestScore) {
      bestScore = score;
      bestGrid = candidate;
    }
  }

  return { size, modules: bestGrid };
}
