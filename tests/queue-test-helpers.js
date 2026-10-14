import assert from 'node:assert/strict';

/**
 * Finish real native work when a fixture needs a completed carry/door mutation.
 *
 * @param {object} engine - Real WASM engine.
 */
export function completeActions(engine) {
    for (let frame = 0; frame < 10_000; frame += 1) {
        const state = engine.actions.getState();

        if (!state.current && state.pending.length === 0) {
            return;
        }

        engine.frameStep(1 / 60);
    }

    assert.fail('Accepted native queue did not finish.');
}

/**
 * Complete a successful request when a test observes completed native policy.
 *
 * @param {object} engine - Real WASM engine.
 * @param {object} accepted - Real immutable queue admission.
 * @returns {object} Original admission.
 */
export function completeQueueRequest(engine, accepted) {
    assert.equal(accepted.accepted, true);
    completeActions(engine);

    return accepted;
}

/**
 * Assert a queued door cannot mutate, whether refusal happens at admission or completion.
 *
 * @param {object} engine - Real native engine.
 * @param {string} id - Stable door identity.
 */
export function assertDoorRefused(engine, id) {
    const before = engine.saveDoorState();
    let accepted;

    try {
        accepted = engine.actions.requestDoor(id);
    } catch (cause) {
        assert.ok(cause instanceof RangeError, 'door admission must report a typed native refusal');
        assert.match(cause.message,
            /^requestDoor: engine refused the command \((?:blocked|value outside the accepted range)\)\.$/u);
    }

    if (accepted) {
        assert.equal(accepted.accepted, true);
        completeActions(engine);
    }

    assert.deepEqual(engine.saveDoorState(), before);
    assert.deepEqual(engine.actions.getState(), { current: null, pending: [] });
}

/**
 * Explicit source floor metadata for the imported empty navigation fixture.
 *
 * @param {object} engine - Real imported-world engine.
 * @param {number} [x=5] - Actor/source-item tile x.
 * @param {number} [y=5] - Actor/source-item tile y.
 * @param {{x:number,y:number}[]} [blocked=[]] - Explicit synthetic source solid tiles.
 */
export function importPickupSquares(engine, x = 5, y = 5, blocked = []) {
    const squares = [];

    for (let sy = Math.floor(y) - 2; sy <= Math.floor(y) + 2; sy += 1) {
        for (let sx = Math.floor(x) - 2; sx <= Math.floor(x) + 2; sx += 1) {
            squares.push({
                x: sx, y: sy, z: 0, roomId: -1, outside: true,
                solid: blocked.some((tile) => tile.x === sx && tile.y === sy),
                solidTrans: false, tree: false, independentWalls: 0,
                reachWalls: { north: false, west: false },
                vehicleObstructed: false, solidFloor: true,
            });
        }
    }

    engine.importDoors([], { squares });
}

/**
 * Minimal host DOM for semantic-menu logic; browser rendering is verified by the host.
 * Focus, connectedness and native event delivery are retained, not mocked menu behavior.
 *
 * @returns {{document:object,canvas:object}} Authored DOM host and original focus target.
 */
export function menuDocument() {
    const document = { activeElement: null };

    /** Supply DOM nodes without simulating production menu logic. */
    class Node extends EventTarget {
        children = [];
        attributes = new Map();
        parentNode = null;
        className = '';
        hidden = false;
        tabIndex = -1;
        textContent = '';
        dataset = {};

        /**
         * Read live ancestry for focus restoration.
         *
         * @returns {boolean} Whether this node is attached to the host body.
         */
        get isConnected() {
            return this === document.body || Boolean(this.parentNode?.isConnected);
        }

        /**
         * Attach actual test nodes.
         *
         * @param {...Node} nodes - Nodes to attach.
         */
        append(...nodes) {
            for (const node of nodes) {
                node.parentNode = this;
                this.children.push(node);
            }
        }

        /** Remove the node from its parent. */
        remove() {
            if (this.parentNode) {
                this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
                this.parentNode = null;
            }
        }

        /**
         * Reflect accessibility attributes.
         *
         * @param {string} name - Attribute name.
         * @param {unknown} value - Attribute value.
         */
        setAttribute(name, value) {
            this.attributes.set(name, String(value));
        }

        /**
         * Read accessibility attributes.
         *
         * @param {string} name - Attribute name.
         * @returns {string|null} Reflected attribute, or null.
         */
        getAttribute(name) {
            return this.attributes.get(name) ?? null;
        }

        /**
         * Traverse actual test ancestry.
         *
         * @param {Node} node - Potential descendant.
         * @returns {boolean} Whether the node belongs to this subtree.
         */
        contains(node) {
            return node === this || this.children.some((child) => child.contains(node));
        }

        /** Move the host focus. */
        focus() {
            document.activeElement = this;
            this.dispatchEvent(new Event('focus'));
        }
    }

    /**
     * Create an accessible host node.
     *
     * @returns {Node} Detached test DOM element.
     */
    document.createElement = () => new Node();
    document.body = new Node();
    const canvas = new Node();

    document.body.append(canvas);
    canvas.focus();

    return { document, canvas };
}
