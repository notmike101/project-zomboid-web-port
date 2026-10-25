/**
 * Creates an owned store for the original ragdoll-definition transport.
 * It does not allocate bodies, solve constraints or implement live ragdoll mutation.
 *
 * @returns {object} Native definition callbacks and detached inspection snapshots.
 */
export function createRagdollDefinitions() {
    const definitions = new Map();

    /**
     * Validates a complete original float-record array before replacing its definition.
     *
     * @param {string} kind - Original definition category.
     * @param {number} stride - Floats in each original serialized record.
     * @param {number[]} integers - Record fields containing Java integer identifiers.
     * @param {number[]} booleans - Record fields containing encoded Java booleans.
     * @param {Float32Array} values - Actual original Java float array.
     * @param {boolean|number} update - Original request to mutate existing live ragdolls.
     * @returns {boolean} True after the complete definition has been stored.
     */
    function define(kind, stride, integers, booleans, values, update) {
        if (update === true || update === 1) {
            throw new Error('Live ragdoll mutation is unsupported; only definition registration is implemented');
        }

        if (update !== false && update !== 0) {
            throw new TypeError('Ragdoll update flag must be a Java boolean');
        }

        if (!(values instanceof Float32Array) || values.length % stride !== 0 || values.length > 1_048_576) {
            throw new TypeError(`Ragdoll ${kind} requires complete ${stride}-float records`);
        }

        if (!values.every(Number.isFinite)) {
            throw new RangeError(`Ragdoll ${kind} contains nonfinite values`);
        }

        for (let offset = 0; offset < values.length; offset += stride) {
            for (const field of integers) {
                if (!Number.isInteger(values[offset + field])) {
                    throw new RangeError(`Ragdoll ${kind} identifier must be an integer`);
                }
            }

            for (const field of booleans) {
                if (values[offset + field] !== 0 && values[offset + field] !== 1) {
                    throw new RangeError(`Ragdoll ${kind} boolean must be zero or one`);
                }
            }
        }

        definitions.set(kind, { stride, values: new Float32Array(values) });

        return true;
    }

    return {
        natives: {
            /**
             * Copies the original template's parent prefix; spare Java array entries are ignored.
             *
             * @param {object} lib - Browser JVM native context.
             * @param {number} count - Actual bone count.
             * @param {Int32Array} parents - Original parent identifiers, including spare capacity.
             */
            Java_zombie_core_physics_Bullet_initializeRagdollSkeleton(lib, count, parents) {
                if (!(parents instanceof Int32Array) || !Number.isInteger(count) || count < 0
                    || count > parents.length || count > 1_048_576) {
                    throw new RangeError('Original ragdoll skeleton requires a contained integer parent prefix');
                }

                definitions.set('skeleton', { stride: 1, values: new Int32Array(parents.subarray(0, count)) });
            },
            /**
             * Stores original global shape-adjustment coordinates; no target is allocated here.
             *
             * @param {object} lib - Browser JVM native context.
             * @param {number} x - Original float X scale.
             * @param {number} y - Original float Y scale.
             * @param {number} z - Original float Z scale.
             */
            Java_zombie_core_physics_Bullet_setBallisticsTargetAdjustingShapeScale(lib, x, y, z) {
                const values = new Float64Array([Math.fround(x), Math.fround(y), Math.fround(z), 0]);

                if (!values.every(Number.isFinite)) {
                    throw new RangeError('Original shape adjustment requires finite Java floats');
                }

                definitions.set('ballisticsAdjustingShapeScale', { stride: 4, values });
            },

            /**
             * Stores original body damping, sleeping and friction definitions.
             *
             * @param {object} lib - Browser JVM native context.
             * @param {Float32Array} values - Part, linear/angular damping, deactivation time,
             * linear/angular sleeping thresholds, friction and rolling friction.
             * @param {boolean|number} update - Whether existing live bodies should be changed.
             * @returns {boolean} Whether the definition was registered.
             */
            Java_zombie_core_physics_Bullet_defineRagdollBodyDynamics(lib, values, update) {
                return define('bodyDynamics', 8, [0], [], values, update);
            },
            /**
             * Stores original joint constraints without creating a physics constraint.
             *
             * @param {object} lib - Browser JVM native context.
             * @param {Float32Array} values - Joint/type/partA/partB followed by axisA, axisB,
             * positionA, positionB, limits and extended limits, each three floats.
             * @param {boolean|number} update - Whether existing live bodies should be changed.
             * @returns {boolean} Whether the definition was registered.
             */
            Java_zombie_core_physics_Bullet_defineRagdollConstraints(lib, values, update) {
                return define('constraints', 22, [0, 1, 2, 3], [], values, update);
            },
            /**
             * Stores original bone-to-body anchor definitions.
             *
             * @param {object} lib - Browser JVM native context.
             * @param {Float32Array} values - Bone, body part, reverse, original and enabled.
             * @param {boolean|number} update - Whether existing live bodies should be changed.
             * @returns {boolean} Whether the definition was registered.
             */
            Java_zombie_core_physics_Bullet_defineRagdollAnchors(lib, values, update) {
                return define('anchors', 5, [0, 1], [2, 3, 4], values, update);
            },
            /**
             * Stores original shape, mass and local-offset body-part definitions.
             *
             * @param {object} lib - Browser JVM native context.
             * @param {Float32Array} values - Part, calculateLength, radius, height, gap,
             * shape, mass and offset XYZ.
             * @param {boolean|number} update - Whether existing live bodies should be changed.
             * @returns {boolean} Whether the definition was registered.
             */
            Java_zombie_core_physics_Bullet_defineRagdollBodyPartInfo(lib, values, update) {
                return define('bodyParts', 10, [0, 5], [1], values, update);
            },
        },
        /**
         * Copies all stored definitions without exposing owned mutable arrays.
         *
         * @returns {object[]} Detached exact values and record extents.
         */
        snapshot() {
            return [...definitions].map(([kind, definition]) => ({
                kind,
                stride: definition.stride,
                records: definition.values.length / definition.stride,
                values: [...definition.values],
            }));
        },
    };
}
