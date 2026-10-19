/**
 * A real 4×4 PNG — four coloured quadrants — as bytes.
 *
 * Generated rather than checked in as a binary: `node:zlib` + a CRC-32 in a throwaway script,
 * with the base64 pasted here. It has to be a GENUINE PNG because the decoder that reads it in
 * the frame test is opentui's native one, not ours.
 */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAGklEQVR4nGP4z8DwnwGM4QhGgen//xn+o3EAyncT7aOmArkAAAAASUVORK5CYII=';

export const PNG_BYTES: Uint8Array = new Uint8Array(Buffer.from(PNG_BASE64, 'base64'));

/** The dimensions of the image above, as the tools would report them. */
export const PNG_SIZE = { width: 4, height: 4, bytes: 83 } as const;
