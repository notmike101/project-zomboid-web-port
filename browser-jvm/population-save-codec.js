// Recovered PZPopMan64 v7 population / v1 collision wire formats.
const uniform = new Map([[0, 0], [1, 1], [3, 8], [4, 16], [5, 32]]);

const tags = new Map([...uniform].map(([tag, value]) => [value, tag]));

/**
 * Creates a bounds-checked reader for the original big-endian save wire format.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {object} Owned scalar/raw reader and EOF guard.
 */
function reader(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    let offset = 0;

    return {
        /**
         * Reads one scalar and advances the save cursor.
         *
         * @param {string} type - DataView scalar type suffix.
         * @param {number} length - Original byte width or bounded span length.
         * @returns {number} Original decoded scalar.
         */
        get(type, length) {
            const value = view[`get${type}`](offset);

            offset += length;

            return value;
        },
        /**
         * Transfers a bounded byte span without changing its byte order.
         *
         * @param {number} length - Original byte width or bounded span length.
         * @returns {Uint8Array|void} Decoded byte span, or completion of the write.
         */
        raw(length) {
            if (offset + length > bytes.length) {
                throw new Error('Truncated save');
            }

            const result = bytes.slice(offset, offset += length);

            return result;
        },
        /**
         * Rejects bytes left after the complete original record layout.
         */
        end() {
            if (offset !== bytes.length) {
                throw new Error('Trailing save bytes');
            }
        },

    };
}

/**
 * Creates a big-endian encoder for the original save wire format.
 *
 * @returns {object} Owned original scalar/raw encoder.
 */
function writer() {
    const output = [];

    return {
        /**
         * Appends one scalar using its original wire width.
         *
         * @param {string} type - DataView scalar type suffix.
         * @param {number} length - Original byte width or bounded span length.
         * @param {number} value - Original scalar value.
         */
        put(type, length, value) {
            const bytes = new Uint8Array(length);

            new DataView(bytes.buffer)[`set${type}`](0, value);

            output.push(...bytes);
        },
        /**
         * Transfers a bounded byte span without changing its byte order.
         *
         * @param {Uint8Array} bytes - Original wire or transport bytes.
         * @returns {Uint8Array|void} Decoded byte span, or completion of the write.
         */
        raw(bytes) {
            for (const byte of bytes) {
                output.push(byte);
            }
        },
        /**
         * Returns the accumulated original wire bytes.
         *
         * @returns {Uint8Array} Complete original wire payload.
         */
        bytes() {
            return Uint8Array.from(output);
        },

    };
}

/**
 * Decodes the original UTF-8 persistent-outfit name table.
 *
 * @param {object} input - Owned original wire reader.
 * @returns {Array<string>} Names in original wire order.
 */
function readNames(input) {
    return Array.from({ length: input.get('Uint16', 2) }, () => new TextDecoder('utf-8', { fatal: true }).decode(input.raw(input.get('Uint16', 2))));
}

/**
 * Encodes the original length-prefixed UTF-8 outfit name table.
 *
 * @param {object} output - Owned original wire writer.
 * @param {Array<string>} names - Actual persistent-outfit names in original order.
 */
function writeNames(output, names) {
    if (names.length > 65_535) {
        throw new Error('Outfit name count overflow');
    }

    output.put('Uint16', 2, names.length);

    for (const name of names) {
        const bytes = new TextEncoder().encode(name);

        if (bytes.length > 65_535) {
            throw new Error('Outfit name length overflow');
        }

        output.put('Uint16', 2, bytes.length);

        output.raw(bytes);
    }
}

/**
 * Remaps a saved outfit index by name while preserving native state bits.
 *
 * @param {number} value - Original scalar value.
 * @param {Array<string>} saved - Outfit names decoded from the saved file.
 * @param {Array<string>} current - Current original outfit-name dictionary.
 * @returns {number} Native remapped outfit value.
 */
export function remapOutfit(value, saved, current) {
    if (!value) {
        return 0;
    }

    const oldIndex = (value & 0x7F_FF_FF_FF) >>> 16;

    const index = oldIndex < saved.length ? current.indexOf(saved[oldIndex]) : -1;

    return index < 0 ? 0 : ((value & 0x80_00_FF_FF) | (index << 16));
}

/**
 * Decodes all original v7 cell timers, targets and zombie records.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {object} Decoded original cell state.
 */
export function decodeCell(bytes) {
    const input = reader(bytes);

    if (input.get('Uint16', 2) !== 7) {
        throw new Error('Only population v7 qualified');
    }

    const names = readNames(input);

    const scalars = [input.get('Float32', 4), input.get('Float32', 4)];

    const chunks = Array.from({ length: 1_024 }, () => {
        const intensity = input.get('Uint16', 2);

        const count = input.get('Uint16', 2);

        const records = Array.from({ length: count }, () => ({
            x: input.get('Float32', 4),
            y: input.get('Float32', 4),
            z: input.get('Int8', 1),
            direction: input.get('Int8', 1),
            state: input.get('Int32', 4),
            outfit: input.get('Int32', 4),
            id: input.get('Int32', 4),
        }));

        return { intensity, records, scalars: [input.get('Float32', 4), input.get('Float32', 4)] };
    });

    input.end();

    return { names, scalars, chunks };
}

/**
 * Encodes the original v7 cell state without changing record or chunk order.
 *
 * @param {object} cell - Source-qualified cell targets, timers and records.
 * @returns {Uint8Array} Original v7 cell bytes.
 */
export function encodeCell(cell) {
    if (cell.chunks.length !== 1_024) {
        throw new Error('Cell chunk count');
    }

    const output = writer();

    output.put('Uint16', 2, 7);

    writeNames(output, cell.names);

    for (const value of cell.scalars) {
        output.put('Float32', 4, value);
    }

    for (const chunk of cell.chunks) {
        if (chunk.records.length > 65_535) {
            throw new Error('Chunk record overflow');
        }

        output.put('Uint16', 2, chunk.intensity);

        output.put('Uint16', 2, chunk.records.length);

        for (const record of chunk.records) {
            output.put('Float32', 4, record.x);

            output.put('Float32', 4, record.y);

            output.put('Int8', 1, record.z);

            output.put('Int8', 1, record.direction);

            for (const key of ['state', 'outfit', 'id']) {
                output.put('Int32', 4, record[key]);
            }
        }

        for (const value of chunk.scalars) {
            output.put('Float32', 4, value);
        }
    }

    return output.bytes();
}

/**
 * Decodes all original v1 collision chunks and rejects trailing bytes.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {Array<Uint8Array>} Original decoded collision chunks.
 */
export function decodeCollision(bytes) {
    const input = reader(bytes);

    if (input.get('Uint16', 2) !== 1) {
        throw new Error('Only collision v1 qualified');
    }

    const chunks = Array.from({ length: 1_024 }, () => {
        const tag = input.get('Uint8', 1);

        if (tag === 2) {
            return input.raw(64);
        }

        if (!uniform.has(tag)) {
            throw new Error('Unknown collision tag');
        }

        return new Uint8Array(64).fill(uniform.get(tag));
    });

    input.end();

    return chunks;
}

/**
 * Selects original uniform tags or raw flags for each collision chunk.
 *
 * @param {Array<Uint8Array>} chunks - Original 1024 collision chunks.
 * @returns {Uint8Array} Original v1 collision bytes.
 */
export function encodeCollision(chunks) {
    if (chunks.length !== 1_024) {
        throw new Error('Collision chunk count');
    }

    const output = writer();

    output.put('Uint16', 2, 1);

    for (const chunk of chunks) {
        if (chunk.length !== 64) {
            throw new Error('Collision input length');
        }

        const tag = tags.get(chunk[0]);

        if (tag !== undefined && chunk.every((value) => value === chunk[0])) {
            output.put('Uint8', 1, tag);
        } else {
            output.put('Uint8', 1, 2);

            output.raw(chunk);
        }
    }

    return output.bytes();
}

/**
 * Encodes the original v7 persistent-ID allocator.
 *
 * @param {number} next - Next original persistent ID.
 * @returns {Uint8Array} Original allocator wire bytes.
 */
export function encodeIDs(next) {
    const out = writer();

    out.put('Uint16', 2, 7);

    out.put('Int32', 4, next);

    return out.bytes();
}

/**
 * Validates and restores the original persistent-ID allocator.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {number} Original next persistent ID.
 */
export function decodeIDs(bytes) {
    const input = reader(bytes);

    if (input.get('Uint16', 2) !== 7) {
        throw new Error('Only IDs v7 qualified');
    }

    const next = input.get('Int32', 4);

    input.end();

    if (next < 1) {
        throw new Error('Invalid next ID');
    }

    return next;
}

/**
 * Encodes the qualified original v7 virtual file with an empty group list.
 *
 * @param {Array<string>} names - Actual persistent-outfit names in original order.
 * @returns {Uint8Array} Original empty-group virtual bytes.
 */
export function encodeEmptyVirtual(names) {
    return encodeVirtual(names, []);
}

/**
 * Encodes original v7 moving groups, retaining target and member ordering.
 *
 * @param {Array<string>} names - Original outfit names.
 * @param {Array<object>} groups - Original targetX/targetY and member records.
 * @returns {Uint8Array} Original virtual-save bytes.
 */
export function encodeVirtual(names, groups) {
    const out = writer();

    out.put('Uint16', 2, 7);

    writeNames(out, names);

    out.put('Int32', 4, groups.length);

    for (const group of groups) {
        if (!group.records.length || group.records.length > 32_767
            || !Number.isInteger(group.targetX) || !Number.isInteger(group.targetY)) {
            throw new Error('Invalid original virtual group');
        }

        out.put('Int16', 2, group.records.length);
        out.put('Int32', 4, group.targetX);
        out.put('Int32', 4, group.targetY);

        for (const record of group.records) {
            out.put('Float32', 4, record.x);
            out.put('Float32', 4, record.y);
            out.put('Int8', 1, record.z);
            out.put('Int8', 1, record.direction);

            for (const key of ['state', 'outfit', 'id']) {
                out.put('Int32', 4, record[key]);
            }
        }
    }

    return out.bytes();
}

/**
 * Restores the outfit table and rejects unqualified nonempty virtual groups.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {Array<string>} Saved original outfit names.
 */
export function decodeEmptyVirtual(bytes) {
    const decoded = decodeVirtual(bytes);

    if (decoded.groups.length) {
        throw new Error('Nonempty virtual groups unqualified');
    }

    return decoded.names;
}

/**
 * Restores original v7 targets and grouped virtual records.
 *
 * @param {Uint8Array} bytes - Actual original save bytes.
 * @returns {object} Original outfit names and ordered moving groups.
 */
export function decodeVirtual(bytes) {
    const input = reader(bytes);

    if (input.get('Uint16', 2) !== 7) {
        throw new Error('Only virtual v7 qualified');
    }

    const names = readNames(input);

    const count = input.get('Int32', 4);

    if (count < 0 || count > Math.floor(bytes.length / 32)) {
        throw new Error('Invalid virtual group count');
    }

    const groups = Array.from({ length: count }, () => {
        const members = input.get('Int16', 2);

        if (members < 1 || members > Math.floor(bytes.length / 22)) {
            throw new Error('Invalid virtual member count');
        }

        const targetX = input.get('Int32', 4);
        const targetY = input.get('Int32', 4);
        const records = Array.from({ length: members }, () => ({
            x: input.get('Float32', 4), y: input.get('Float32', 4), z: input.get('Int8', 1),
            direction: input.get('Int8', 1), state: input.get('Int32', 4),
            outfit: input.get('Int32', 4), id: input.get('Int32', 4),
        }));

        return { targetX, targetY, records };
    });

    input.end();

    return { names, groups };
}
