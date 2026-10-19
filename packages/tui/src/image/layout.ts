/**
 * How big an image should be, decided before anything is rendered.
 *
 * That order is the point: the frame is a pure function of the view, so the number of rows an
 * image occupies has to be known while the lines are being built — the text below it must not
 * be drawn on top of it. The sizes come from the ATTACHMENT (`width`/`height` are in the log,
 * ADR-057), so laying it out costs no decoding.
 */
export interface ImageBox {
  readonly cols: number;
  readonly rows: number;
}

export interface ImageLayoutOptions {
  /** Columns available inside the card. */
  readonly cols: number;
  /** How many rows an image may take before it stops being an inline image. */
  readonly maxRows: number;
  /** `null` when nobody measured it (an unmeasured PDF, a damaged file). */
  readonly width: number | null;
  readonly height: number | null;
}

/** A cell is about twice as tall as it is wide, which is why the ratio is halved. */
const CELL_ASPECT = 2;
/** What an image of unknown size gets: a shape, not a promise about its contents. */
const DEFAULT_BOX: ImageBox = { cols: 24, rows: 8 };

export function imageBox(options: ImageLayoutOptions): ImageBox {
  const cols = Math.max(8, options.cols);
  const { width, height } = options;
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { cols: Math.min(cols, DEFAULT_BOX.cols), rows: Math.min(options.maxRows, DEFAULT_BOX.rows) };
  }

  const wanted = Math.min(cols, width);
  const rows = Math.max(1, Math.round((wanted * (height / width)) / CELL_ASPECT));
  if (rows <= options.maxRows) return { cols: wanted, rows };

  // Too tall: shrink until it fits the row budget, keeping the ratio.
  const capped = Math.max(1, Math.round((options.maxRows * CELL_ASPECT * (width / height))));
  return { cols: Math.min(wanted, capped), rows: options.maxRows };
}
