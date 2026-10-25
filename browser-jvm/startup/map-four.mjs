/**
 * Maps at most four records concurrently, retaining input order and draining failures.
 *
 * @param {Array<unknown>} items - Ordered records to process.
 * @param {function(unknown, number): Promise<unknown>} operation - One owned record operation.
 * @returns {Promise<Array<unknown>>} Ordered results after all active workers drain.
 */
export async function mapFour(items, operation) {
    const results = Array.from({ length: items.length });
    let cursor = 0;
    let failed = false;
    const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
        while (!failed && cursor < items.length) {
            const index = cursor++;

            try {
                // eslint-disable-next-line no-await-in-loop -- Each worker owns one operation at a time.
                results[index] = await operation(items[index], index);
            } catch (error) {
                failed = true;
                throw error;
            }
        }
    });
    const settled = await Promise.allSettled(workers);
    const errors = settled.filter((result) => result.status === 'rejected').map((result) => result.reason);

    if (errors.length === 1) {
        throw errors[0];
    }

    if (errors.length) {
        throw new AggregateError(errors, 'Bounded preflight workers failed');
    }

    return results;
}
