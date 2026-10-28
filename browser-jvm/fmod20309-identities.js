/* eslint-disable jsdoc/require-jsdoc -- Internal public-SDK boundary helpers are owned by the FMOD runtime. */
// Opaque host IDs resolve only to real public SDK descriptors, canonicalized by their documented GUID.
export function createDescriptorRegistry(F) {
    const entries = new Map();
    const keys = new Map();
    let next = 1;

    return {
        retain(kind, object) {
            if (!['bank', 'event', 'bus', 'vca'].includes(kind)) {
                throw new Error('Unsupported descriptor kind');
            }

            const out = {};
            const result = object.getID(out);

            if (result !== F.OK) {
                return { result };
            }

            const guid = out.val;
            const fields = [guid.Data1, guid.Data2, guid.Data3, ...Array.from(guid.Data4)];
            const limits = [0xFF_FF_FF_FF, 0xFF_FF, 0xFF_FF, ...Array.from({ length: 8 }).fill(0xFF)];

            if (fields.length !== 11 || fields.some((field, index) => !Number.isInteger(field) || field < 0 || field > limits[index])) {
                throw new Error('Invalid public FMOD GUID');
            }

            const key = `${kind}:${fields.join(':')}`;

            if (keys.has(key)) {
                const existing = keys.get(key);

                if (entries.get(existing).object.isValid()) {
                    return { result, id: existing };
                }

                entries.delete(existing);
                keys.delete(key);
            }

            if (!Number.isSafeInteger(next) || next >= 2 ** 32) {
                throw new Error('FMOD descriptor identity exhausted');
            }

            const id = next++;

            keys.set(key, id);
            entries.set(id, { kind, object });

            return { result, id };
        },
        use(kind, id) {
            const entry = entries.get(id);

            if (!entry || entry.kind !== kind || !entry.object.isValid()) {
                throw new Error('Unknown FMOD descriptor owner identity');
            }

            return entry.object;
        },
        clear() {
            entries.clear();
            keys.clear();
        },
    };
}

// Real createInstance owners; enumeration fails closed if the SDK contains an unowned instance.
export function createInstanceRegistry(F, descriptors) {
    const entries = new Map();
    let next = 2 ** 32;
    const use = (kind, id) => {
        const entry = entries.get(id);

        if (kind !== 'instance' || !entry || !entry.object.isValid()) {
            if (entry && !entry.object.isValid()) {
                entries.delete(id);
            }

            throw new Error('Unknown or invalid FMOD instance owner identity');
        }

        return entry.object;
    };

    return {
        create(eventId) {
            if (!Number.isSafeInteger(next) || next >= 2 ** 40) {
                throw new Error('FMOD owner identity exhausted');
            }

            const out = {};
            const result = descriptors.use('event', eventId).createInstance(out);

            if (result !== F.OK) {
                return { result };
            }

            if (!out.val || !out.val.isValid()) {
                throw new Error('FMOD returned no valid actual instance');
            }

            const id = next++;

            entries.set(id, { eventId, object: out.val });

            return { result, id };
        },
        use,
        release(id) {
            // Successful release can leave the real instance alive until stopped and updated.
            return use('instance', id).release();
        },
        enumerate(eventId, capacity) {
            if (!Number.isSafeInteger(capacity) || capacity < 0) {
                throw new Error('Invalid FMOD list capacity');
            }

            const event = descriptors.use('event', eventId);
            const count = {};
            const result = event.getInstanceCount(count);

            if (result !== F.OK) {
                return { result };
            }

            if (!Number.isSafeInteger(count.val) || count.val < 0) {
                throw new Error('Invalid actual FMOD instance count');
            }

            const ids = [];

            for (const [id, entry] of entries) {
                if (entry.eventId !== eventId) {
                    continue;
                }

                if (entry.object.isValid()) {
                    ids.push(id);
                } else {
                    entries.delete(id);
                }
            }

            if (ids.length !== count.val) {
                throw new Error('FMOD instance ownership incomplete');
            }

            const array = {};
            const written = {};
            const listResult = event.getInstanceList(array, capacity, written);

            if (listResult !== F.OK) {
                return { result: listResult, count: written.val };
            }

            if (!Number.isSafeInteger(written.val) || written.val < 0 || written.val > Math.min(ids.length, capacity)) {
                throw new Error('Invalid actual FMOD instance list count');
            }

            return { result: listResult, ids: ids.slice(0, written.val), count: written.val };
        },
        prune() {
            for (const [id, entry] of entries) {
                if (!entry.object.isValid()) {
                    entries.delete(id);
                }
            }
        },
        clear() {
            entries.clear();
        },
    };
}
