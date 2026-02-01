/**
 * 线宽过渡功能
 * 在同一网络的不同线宽导线之间添加平滑过渡
 * 使用三次贝塞尔曲线实现平滑的线宽渐变
 */

import { getSafeSelectedTracks } from './eda_utils';
import { debugLog, logError } from './logger';
import { dist, isClose, smootherStep } from './math';
import { getSettings } from './settings';
import { createSnapshot } from './snapshot';

// 存储创建的过渡元素ID和位置信息
const TRANSITION_STORAGE_KEY = 'width_transition_data';

interface TransitionRecord {
	point: string; // 坐标Key
	ids: string[]; // 对应的图元ID列表
}

interface TransitionData {
	records: TransitionRecord[];
}

/**
 * 获取已保存的过渡数据
 */
async function getSavedTransitionData(): Promise<TransitionData> {
	try {
		const stored = await eda.sys_Storage.getExtensionUserConfig(TRANSITION_STORAGE_KEY);
		if (stored) {
			const data = JSON.parse(stored);
			if (data.records && Array.isArray(data.records)) {
				return data;
			}
		}
	}
	catch {
		// 忽略读取错误
	}
	return { records: [] };
}

/**
 * 保存过渡数据
 */
async function saveTransitionData(data: TransitionData): Promise<void> {
	try {
		await eda.sys_Storage.setExtensionUserConfig(TRANSITION_STORAGE_KEY, JSON.stringify(data));
	}
	catch {
		// 忽略存储失败
	}
}

/**
 * 添加线宽过渡 - 处理选中的线段（菜单调用）
 */
export async function addWidthTransitionsSelected() {
	const settings = await getSettings();

	// 获取选中的图元 ID
	const allSelectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
	if (!allSelectedIds || allSelectedIds.length === 0) {
		eda.sys_Message?.showToastMessage(eda.sys_I18n.text('请先选择要处理的导线'));
		return;
	}

	// 读取已保存的过渡数据
	const savedData = await getSavedTransitionData();

	// 这里的逻辑已经修改：
	// 不再询问是否全部清除，而是在 processWidthTransitions 中根据坐标点自动清理旧的过渡线段
	// 这样可以支持局部更新，用户只处理选中的部分，就只更新这部分的过渡

	if (eda.sys_LoadingAndProgressBar?.showLoading) {
		eda.sys_LoadingAndProgressBar.showLoading();
	}

	// 创建快照 (Undo 支持)
	try {
		await createSnapshot('Width (Selected)');
	}
	catch (e: any) {
		logError(`Failed to create snapshot: ${e.message || e}`);
	}

	try {
		// 使用安全获取函数处理混合选中
		const selectedTracks = await getSafeSelectedTracks(allSelectedIds);

		if (selectedTracks.length === 0) {
			eda.sys_Message?.showToastMessage(eda.sys_I18n.text('没有找到导线'));
			return;
		}

		const result = await processWidthTransitions(selectedTracks, savedData, settings);

		// 保存数据
		await saveTransitionData(result.data);

		eda.sys_Message?.showToastMessage(
			eda.sys_I18n.text(`线宽过渡完成，处理了 ${result.count} 个连接点`),
		);
	}
	catch (e: any) {
		eda.sys_Dialog?.showInformationMessage(e.message, 'Width Transition Error');
	}
	finally {
		eda.sys_LoadingAndProgressBar?.destroyLoading?.();
	}
}

/**
 * 添加线宽过渡 - 处理所有线段（熔化时自动调用）
 * @param createBackup 是否创建快照 (如果是 Beautify 调用，通常已经创建了快照，这里可以选择 false)
 */
export async function addWidthTransitionsAll(createBackup: boolean = true) {
	const settings = await getSettings();

	// 读取已保存的过渡数据
	const savedData = await getSavedTransitionData();

	if (eda.sys_LoadingAndProgressBar?.showLoading) {
		eda.sys_LoadingAndProgressBar.showLoading();
	}

	if (createBackup) {
		try {
			await createSnapshot('Width (All)');
		}
		catch (e: any) {
			logError(`Failed to create snapshot: ${e.message || e}`);
		}
	}

	try {
		// 获取所有导线
		const allTracks = await eda.pcb_PrimitiveLine.getAll();
		if (!allTracks || allTracks.length === 0) {
			return;
		}

		const result = await processWidthTransitions(allTracks, savedData, settings);

		// 保存数据
		await saveTransitionData(result.data);

		debugLog(`[Width Transition] 自动过渡完成，处理了 ${result.count} 个连接点`);
	}
	catch (e: any) {
		debugLog(`[Width Transition Error] ${e.message}`);
	}
	finally {
		eda.sys_LoadingAndProgressBar?.destroyLoading?.();
	}
}

/**
 * 处理线宽过渡的核心逻辑
 */
async function processWidthTransitions(
	tracks: any[],
	savedData: TransitionData,
	settings: any,
): Promise<{ data: TransitionData; count: number }> {
	debugLog(`[Width Transition] 获取到 ${tracks.length} 条导线`);

	// 按网络和层分组
	const netLayerMap = new Map<string, any[]>();

	for (const track of tracks) {
		const net = track.getState_Net?.() || '';
		const layer = track.getState_Layer?.() || 0;

		const groupKey = net ? `net_${net}_layer_${layer}` : `__NO_NET__layer_${layer}`;

		if (!netLayerMap.has(groupKey)) {
			netLayerMap.set(groupKey, []);
		}
		netLayerMap.get(groupKey)!.push(track);
	}

	debugLog(`[Width Transition] 共 ${netLayerMap.size} 个分组`);

	// 构建记录映射方便查找
	const recordsMap = new Map<string, TransitionRecord>();
	if (savedData.records) {
		savedData.records.forEach(r => recordsMap.set(r.point, r));
	}

	const processedPointsInCurrentRun = new Set<string>();
	const pointKey = (p: { x: number; y: number }) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
	let transitionCount = 0;

	// 遍历每个分组
	for (const [groupKey, groupTracks] of netLayerMap) {
		if (groupTracks.length < 2)
			continue;

		const isNoNet = groupKey.startsWith('__NO_NET__');
		const actualNet = isNoNet ? '' : groupKey.replace(/^net_/, '').replace(/_layer_\d+$/, '');

		// 查找端点相连但线宽不同的导线对
		for (let i = 0; i < groupTracks.length; i++) {
			for (let j = i + 1; j < groupTracks.length; j++) {
				const t1 = groupTracks[i];
				const t2 = groupTracks[j];

				const w1 = t1.getState_LineWidth();
				const w2 = t2.getState_LineWidth();

				// 只处理线宽不同的情况
				if (isClose(w1, w2, 0.01))
					continue;

				// 获取端点
				const t1Start = { x: t1.getState_StartX(), y: t1.getState_StartY() };
				const t1End = { x: t1.getState_EndX(), y: t1.getState_EndY() };
				const t2Start = { x: t2.getState_StartX(), y: t2.getState_StartY() };
				const t2End = { x: t2.getState_EndX(), y: t2.getState_EndY() };

				// 检查所有可能的端点连接
				const tolerance = 0.1;
				const connections: Array<{
					point: { x: number; y: number };
					t1Dir: { x: number; y: number };
					t2Dir: { x: number; y: number };
				}> = [];

				if (dist(t1End, t2Start) < tolerance) {
					connections.push({
						point: t1End,
						t1Dir: { x: t1End.x - t1Start.x, y: t1End.y - t1Start.y },
						t2Dir: { x: t2End.x - t2Start.x, y: t2End.y - t2Start.y },
					});
				}
				if (dist(t1End, t2End) < tolerance) {
					connections.push({
						point: t1End,
						t1Dir: { x: t1End.x - t1Start.x, y: t1End.y - t1Start.y },
						t2Dir: { x: t2Start.x - t2End.x, y: t2Start.y - t2End.y },
					});
				}
				if (dist(t1Start, t2Start) < tolerance) {
					connections.push({
						point: t1Start,
						t1Dir: { x: t1Start.x - t1End.x, y: t1Start.y - t1End.y },
						t2Dir: { x: t2End.x - t2Start.x, y: t2End.y - t2Start.y },
					});
				}
				if (dist(t1Start, t2End) < tolerance) {
					connections.push({
						point: t1Start,
						t1Dir: { x: t1Start.x - t1End.x, y: t1Start.y - t1End.y },
						t2Dir: { x: t2Start.x - t2End.x, y: t2Start.y - t2End.y },
					});
				}

				// 处理连接点
				for (const conn of connections) {
					const key = pointKey(conn.point);

					// 防止本次运行重复处理同一个点
					if (processedPointsInCurrentRun.has(key)) {
						continue;
					}

					// 检查是否有旧的过渡数据，如果有则清理
					if (recordsMap.has(key)) {
						const oldRecord = recordsMap.get(key)!;
						if (oldRecord.ids && oldRecord.ids.length > 0) {
							try {
								await eda.pcb_PrimitiveLine.delete(oldRecord.ids);
							}
							catch (e: any) {
								logError(`删除旧过渡失败: ${e.message || e}`);
							}
						}
						recordsMap.delete(key);
					}

					// 检查共线
					const len1 = Math.sqrt(conn.t1Dir.x ** 2 + conn.t1Dir.y ** 2);
					const len2 = Math.sqrt(conn.t2Dir.x ** 2 + conn.t2Dir.y ** 2);
					if (len1 < 0.001 || len2 < 0.001)
						continue;

					const dot = (conn.t1Dir.x * conn.t2Dir.x + conn.t1Dir.y * conn.t2Dir.y) / (len1 * len2);

					// 角度差小于 30 度
					if (Math.abs(Math.abs(dot) - 1) > 0.13) {
						if (settings.debug) {
							debugLog(`[Width Transition] 跳过非共线连接点: dot=${dot.toFixed(3)}`);
						}
						continue;
					}

					debugLog(`[Width Transition] 找到线宽过渡点: w1=${w1.toFixed(2)}, w2=${w2.toFixed(2)}, point=${key}`);

					// 标记为已处理
					processedPointsInCurrentRun.add(key);

					// 确定方向和窄端线长
					let transitionDir: { x: number; y: number };
					let narrowTrackLength: number;

					// 计算两条线的实际长度
					const t1Length = dist(t1Start, t1End);
					const t2Length = dist(t2Start, t2End);

					if (w1 < w2) {
						// t1 是窄线
						transitionDir = { x: -conn.t1Dir.x, y: -conn.t1Dir.y };
						narrowTrackLength = t1Length;
					}
					else {
						// t2 是窄线
						transitionDir = { x: conn.t2Dir.x, y: conn.t2Dir.y };
						narrowTrackLength = t2Length;
					}

					// 创建过渡线段
					const ids = await createWidthTransition(
						conn.point,
						transitionDir,
						w1,
						w2,
						t1.getState_Layer(),
						actualNet,
						narrowTrackLength,
						settings,
					);

					if (ids.length > 0) {
						// 记录新创建的过渡
						recordsMap.set(key, {
							point: key,
							ids,
						});
						transitionCount++;
					}

					// 防止卡死
					if (transitionCount % 5 === 0) {
						await new Promise(r => setTimeout(r, 10));
					}
				}
			}
		}
	}

	debugLog(`[Width Transition] 完成，创建了 ${transitionCount} 个过渡`);

	return {
		data: {
			records: Array.from(recordsMap.values()),
		},
		count: transitionCount,
	};
}

/**
 * 创建线宽过渡（使用多条线段 + 贝塞尔曲线插值实现平滑过渡）
 * 过渡向窄线方向延伸，起点为宽线宽度，终点为窄线宽度
 * @param point 过渡起点坐标
 * @param point.x X 坐标
 * @param point.y Y 坐标
 * @param direction 过渡方向向量
 * @param direction.x X 分量
 * @param direction.y Y 分量
 * @param width1 第一条线的宽度
 * @param width2 第二条线的宽度
 * @param layer PCB 层
 * @param net 网络名称
 * @param narrowTrackLength 窄端线的长度，过渡不会超过此长度
 * @param settings 扩展设置
 */
async function createWidthTransition(
	point: { x: number; y: number },
	direction: { x: number; y: number },
	width1: number,
	width2: number,
	layer: number,
	net: string,
	narrowTrackLength: number,
	settings: any,
): Promise<string[]> {
	const createdIds: string[] = [];

	// 归一化方向（direction 已经指向窄线方向）
	const len = Math.sqrt(direction.x ** 2 + direction.y ** 2);
	if (len < 0.001)
		return createdIds;

	// 方向指向窄线
	const ux = direction.x / len;
	const uy = direction.y / len;

	// 确定宽窄
	const wideWidth = Math.max(width1, width2);
	const narrowWidth = Math.min(width1, width2);
	const widthDiff = wideWidth - narrowWidth;

	// 过渡长度（向窄线方向延伸）
	// 计算理想过渡长度，但不超过窄端线长的 90%（留一点余量）
	const idealLength = widthDiff * (settings.widthTransitionRatio || 1.5);
	const maxAllowedLength = narrowTrackLength * 0.9;
	const transitionLength = Math.min(idealLength, maxAllowedLength);

	// 如果过渡长度太短，跳过
	if (transitionLength < 1) {
		debugLog(`[Width Transition] 跳过：过渡长度太短 (${transitionLength.toFixed(2)})`);
		return createdIds;
	}

	debugLog(`[Width Transition] 理想长度=${idealLength.toFixed(2)}, 实际长度=${transitionLength.toFixed(2)}`);

	// 过渡段数计算
	// 动态计算需要的段数以保证平滑度
	// 调整：避免过高密度导致API问题
	const minStep = 2; // mil (之前是0.5，太密了)

	const segmentsByLen = Math.ceil(transitionLength / minStep);
	const segmentsByWidth = Math.ceil(widthDiff / minStep);

	// 限制最大段数来自设置
	const maxSegments = settings.widthTransitionSegments || 30;

	// 最终段数：计算得出的段数，但限制最大值
	// 最小 5 段，最大由用户设置决定
	let segments = Math.min(maxSegments, Math.max(5, segmentsByLen, segmentsByWidth));

	// 如果是极短的过渡，进一步降低段数
	if (transitionLength < 5) {
		segments = Math.min(segments, 6);
	}

	debugLog(`[Width Transition] 创建贝塞尔过渡: 长度=${transitionLength.toFixed(2)}, 段数=${segments}`);

	// 使用贝塞尔曲线插值创建渐变线段
	// 从连接点（t=0, wideWidth）向窄线方向延伸（t=1, narrowWidth）
	// 起点线宽=宽线宽度（覆盖连接处），终点线宽=窄线宽度（与窄线相切）
	for (let i = 0; i < segments; i++) {
		const t1 = i / segments;
		const t2 = (i + 1) / segments;

		// 使用贝塞尔曲线插值线宽
		// t=0 时为 wideWidth，t=1 时为 narrowWidth
		// 修正：使用 t2 (段尾) 计算宽度，确保最后一段的结束宽度正好等于 narrowWidth
		// 这样可以避免在与窄线连接处出现"台阶"
		const bezierT = smootherStep(t2);
		const w = wideWidth - widthDiff * bezierT;

		// 计算线段位置（从连接点向窄线方向延伸）
		const p1 = {
			x: point.x + ux * (t1 * transitionLength),
			y: point.y + uy * (t1 * transitionLength),
		};
		const p2 = {
			x: point.x + ux * (t2 * transitionLength),
			y: point.y + uy * (t2 * transitionLength),
		};

		try {
			const line = await eda.pcb_PrimitiveLine.create(
				net,
				layer,
				p1.x,
				p1.y,
				p2.x,
				p2.y,
				w,
				false,
			);

			if (line?.getState_PrimitiveId) {
				createdIds.push(line.getState_PrimitiveId());
			}
		}
		catch (err) {
			debugLog(`[Width Transition Error] 创建线段失败: ${err}`);
		}
	}

	return createdIds;
}

/**
 * 移除已创建的线宽过渡
 */
export async function removeWidthTransitions() {
	try {
		const data = await getSavedTransitionData();
		if (data.records && data.records.length > 0) {
			const allIds = data.records.flatMap(r => r.ids);
			if (allIds.length > 0) {
				try {
					await eda.pcb_PrimitiveLine.delete(allIds);
				}
				catch {
					// 忽略删除失败
				}
			}
			await saveTransitionData({ records: [] });
		}
	}
	catch {
		// 忽略错误
	}
}
