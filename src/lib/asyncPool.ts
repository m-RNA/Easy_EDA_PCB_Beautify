/**
 * 以固定并发数执行异步任务，并保持结果顺序。
 * 任一任务失败时仍会等待已启动/待执行任务完成，避免 EDA 图元操作悬空。
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrency: number,
	task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0)
		return [];

	const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));
	const results = Array.from<R>({ length: items.length });
	let cursor = 0;
	let firstError: unknown;

	const workers = Array.from({ length: workerCount }, async () => {
		while (cursor < items.length) {
			const index = cursor++;
			try {
				results[index] = await task(items[index], index);
			}
			catch (error) {
				if (firstError === undefined)
					firstError = error;
			}
		}
	});

	await Promise.all(workers);
	if (firstError !== undefined)
		throw firstError;

	return results;
}
