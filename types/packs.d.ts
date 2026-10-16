/** Browser pack indexing contract implemented by src/packs.js. */
export interface PackSource {
  readonly size: number;
  readonly name?: string;
  readonly lastModified?: number;
  readonly relativePath?: string;
  readonly webkitRelativePath?: string;
  slice(start: number, end: number, contentType?: string): Blob | { arrayBuffer(): Promise<ArrayBuffer> };
}

/** Trimmed atlas rectangle and its placement in the original sprite canvas. */
export interface PackSprite {
  readonly name: string;
  readonly pageIndex: number;
  readonly entryIndex: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly xoff: number;
  readonly yoff: number;
  readonly totalW: number;
  readonly totalH: number;
}

export interface PackPage {
  readonly index: number;
  readonly name: string;
  /** Opaque signed field; alpha/mask semantics are not established. */
  readonly hasAlpha: number;
  readonly width: number;
  readonly height: number;
  /** Half-open source PNG byte range, excluding a legacy end marker. */
  readonly pngStart: number;
  readonly pngEnd: number;
  readonly sprites: readonly PackSprite[];
}

/** Every object/array returned by the index is frozen. No pixels are decoded. */
export interface PackIndex {
  readonly format: 'PZPK' | 'legacy';
  readonly version: number;
  readonly source: Readonly<{
    name: string;
    size: number;
    lastModified: number | null;
    relativePath: string;
  }>;
  readonly pages: readonly PackPage[];
  readonly sprites: readonly PackSprite[];
  /** First occurrence in page/entry disk order; undefined when absent. */
  lookup(name: string): PackSprite | undefined;
  /** All duplicates, in page/entry disk order. */
  lookupAll(name: string): readonly PackSprite[];
  /** Includes duplicates, in page/entry disk order. */
  findByPrefix(prefix: string): readonly PackSprite[];
  /** Resolves a lazy Blob slice or one bounded HTTP PNG page; decode separately. */
  pageBlob(pageIndex: number): Promise<Blob>;
}

export function openPack(file: PackSource): Promise<PackIndex>;
