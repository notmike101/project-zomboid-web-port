let published;
const names = ['n_1init', 'newInstance', 'clear', 'addPath', 'addAABB', 'addPolygon', 'clipAABB',
    'generatePolygons', 'getPolygon', 'triangulate2'].map((name) => `Java_zombie_vehicles_Clipper_${name}`);

names.push(...['newInstance', 'clear', 'addPath', 'execute', 'getPolygonCount', 'getPolygon']
    .map((name) => `Java_zombie_vehicles_ClipperOffset_${name}`));

/**
 * Publishes the existing physics owner once for the real original native-library descriptor.
 *
 * @param {object} owner - Existing createBrowserPhysics result for this single browser VM.
 */
export function publishClipperOwner(owner) {
    if (published || !owner || !names.every((name) => typeof owner.natives?.[name] === 'function')) {
        throw new Error('One actual qualified Clipper owner with every supported callback is required');
    }

    published = owner;
}

/**
 * Resolves the supported actual callbacks without creating another physics/native owner.
 *
 * @returns {object} Original owner's actual callback identities.
 */
export function clipperNativeExports() {
    if (!published) {
        throw new Error('Original Clipper descriptor imported before its actual owner was published');
    }

    return Object.fromEntries(names.map((name) => [name, published.natives[name]]));
}
