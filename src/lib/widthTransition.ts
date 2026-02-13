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

	// 提前显示进度条
	if (eda.sys_LoadingAndProgressBar?.showLoading) {
		eda.sys_LoadingAndProgressBar.showLoading();
	}

	try {
		// 获取选中的图元 ID
		const allSelectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		if (!allSelectedIds || allSelectedIds.length === 0) {
			eda.sys_Message?.showToastMessage('请先选择要处理的导线', 'warn' as any, 3);
			return; // finally会处理进度条
		}

		// 读取已保存的过渡数据
		const savedData = await getSavedTransitionData();

		// 创建快照 (Undo 支持)
		try {
			await createSnapshot('Width (Selected) Before');
		}
		catch (e: any) {
			logError(`Failed to create snapshot: ${e.message || e}`);
		}

		try {
			// 使用安全获取函数处理混合选中
			const selectedTracks = await getSafeSelectedTracks(allSelectedIds);

			if (selectedTracks.length === 0) {
				eda.sys_Message?.showToastMessage('没有找到导线', 'info' as any, 2);
				return;
			}

			const result = await processWidthTransitions(selectedTracks, savedData, settings);

			// 保存数据
			await saveTransitionData(result.data);

			eda.sys_Message?.showToastMessage(
				`线宽过渡完成，处理了 ${result.count} 个连接点`,
				'success' as any,
				2,
			);

			// 保存操作后的快照
			try {
				await createSnapshot('Width (Selected) After');
			}
			catch (e: any) {
				logError(`Failed to create result snapshot: ${e.message || e}`);
			}
		}
		catch (e: any) {
			eda.sys_Dialog?.showInformationMessage(e.message, 'Width Transition Error');
		}
		finally {
			eda.sys_LoadingAndProgressBar?.destroyLoading?.();
		}
	}
	catch { }
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
			await createSnapshot('Width (All) Before');
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

		debugLog(`自动过渡完成，处理了 ${result.count} 个连接点`, 'Transitions');

		// 如果独立运行，保存操作后的快照
		if (createBackup) {
			try {
				await createSnapshot('Width (All) After');
			}
			catch (e: any) {
				logError(`Failed to create result snapshot: ${e.message || e}`);
			}
		}
	}
	catch (e: any) {
		logError(e.message, 'Transitions');
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
	debugLog(`获取到 ${tracks.length} 条导线`, 'Transitions');

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

	debugLog(`共 ${netLayerMap.size} 个分组`, 'Transitions');

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

		// 待处理操作列表
		const pendingShortens = new Map<string, { start?: number; end?: number; original: any }>();
		const pendingTransitions: Array<{
			point: { x: number; y: number }; // 连接点 (junction)
			wideDir: { x: number; y: number }; // 指向宽线内部方向 (背离连接点)
			narrowDir: { x: number; y: number }; // 指向窄线内部方向 (背离连接点)
			w1: number;
			w2: number;
			layer: number;
			net: string;
			widePortion: number; // 向宽线侧延伸的长度 (需要缩短宽线)
			narrowPortion: number; // 向窄线侧延伸的长度 (覆盖在窄线上)
			totalLength: number; // 总过渡长度
			shortenTrackId?: string; // 如果 widePortion > 0，指定被缩短的线段 ID
			shortenEndpoint?: 'start' | 'end';
		}> = [];

		// 第1步：分析连接关系
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

				const tolerance = 0.1;
				// 查找连接点
				let connPoint: { x: number; y: number } | null = null;
				let t1IsStart = false; // 是否在 t1 的起点连接
				let t2IsStart = false; // 是否在 t2 的起点连接

				if (dist(t1End, t2Start) < tolerance) {
					connPoint = t1End;
					t1IsStart = false;
					t2IsStart = true;
				}
				else if (dist(t1End, t2End) < tolerance) {
					connPoint = t1End;
					t1IsStart = false;
					t2IsStart = false;
				}
				else if (dist(t1Start, t2Start) < tolerance) {
					connPoint = t1Start;
					t1IsStart = true;
					t2IsStart = true;
				}
				else if (dist(t1Start, t2End) < tolerance) {
					connPoint = t1Start;
					t1IsStart = true;
					t2IsStart = false;
				}

				if (!connPoint)
					continue;

				const key = pointKey(connPoint);
				if (processedPointsInCurrentRun.has(key))
					continue;

				// 检查共线
				const t1DirVec = t1IsStart ? { x: t1Start.x - t1End.x, y: t1Start.y - t1End.y } : { x: t1End.x - t1Start.x, y: t1End.y - t1Start.y };
				const t2DirVec = t2IsStart ? { x: t2Start.x - t2End.x, y: t2Start.y - t2End.y } : { x: t2End.x - t2Start.x, y: t2End.y - t2Start.y };

				const len1 = Math.sqrt(t1DirVec.x ** 2 + t1DirVec.y ** 2);
				const len2 = Math.sqrt(t2DirVec.x ** 2 + t2DirVec.y ** 2);
				if (len1 < 0.001 || len2 < 0.001)
					continue;

				const dot = (t1DirVec.x * t2DirVec.x + t1DirVec.y * t2DirVec.y) / (len1 * len2);
				if (Math.abs(Math.abs(dot) - 1) > 0.13) {
					if (settings.debug)
						debugLog(`跳过非共线连接点: dot=${dot.toFixed(3)}`, 'Transitions');
					continue;
				}

				// 检查旧数据
				if (recordsMap.has(key)) {
					const oldRecord = recordsMap.get(key)!;
					if (oldRecord.ids && oldRecord.ids.length > 0) {
						try {
							await eda.pcb_PrimitiveLine.delete(oldRecord.ids);
						}
						catch { }
					}
					recordsMap.delete(key);
				}

				processedPointsInCurrentRun.add(key);

				// 确定方向和策略
				const t1Width = w1;
				const t2Width = w2;
				const isT1Wide = t1Width > t2Width;
				const wideTrack = isT1Wide ? t1 : t2;
				const wideIsStart = isT1Wide ? t1IsStart : t2IsStart; // 连接点是否位于宽导线的起点?

				// 计算理想过渡长度
				const widthDiff = Math.abs(w1 - w2);
				// 默认 3 倍线宽差
				const idealLength = widthDiff * (settings.widthTransitionRatio || 3.0);

				// === 平衡模式: 0% = 全部向窄线, 100% = 全部向宽线 ===
				const balance = Math.max(0, Math.min(100, Number(settings.widthTransitionBalance) || 50));

				const wideLen = isT1Wide ? len1 : len2;
				const narrowLen = isT1Wide ? len2 : len1;

				// 按平衡比例分配过渡长度到宽/窄两侧
				let widePortion = idealLength * (balance / 100);
				let narrowPortion = idealLength * (1 - balance / 100);

				// 约束: 宽线侧不能超过宽线长度的90%
				if (widePortion > wideLen * 0.9) {
					widePortion = wideLen * 0.9;
				}
				// 约束: 窄线侧不能超过窄线长度的90%
				if (narrowPortion > narrowLen * 0.9) {
					narrowPortion = narrowLen * 0.9;
				}

				const totalLength = widePortion + narrowPortion;
				if (totalLength < 1)
					continue;

				// 方向向量: tXDirVec 指向连接点，取反后背离连接点
				const wideDirVec = isT1Wide ? t1DirVec : t2DirVec;
				const narrowDirVec = isT1Wide ? t2DirVec : t1DirVec;
				const wideAwayDir = { x: -wideDirVec.x, y: -wideDirVec.y }; // 深入宽线
				const narrowAwayDir = { x: -narrowDirVec.x, y: -narrowDirVec.y }; // 深入窄线

				// 如果需要向宽线侧延伸，注册缩短请求
				if (widePortion >= 1) {
					const wideId = wideTrack.getState_PrimitiveId();
					if (!pendingShortens.has(wideId)) {
						pendingShortens.set(wideId, { original: wideTrack });
					}
					const rec = pendingShortens.get(wideId)!;
					if (wideIsStart) {
						rec.start = Math.max(rec.start || 0, widePortion);
					}
					else {
						rec.end = Math.max(rec.end || 0, widePortion);
					}

					pendingTransitions.push({
						point: connPoint,
						wideDir: wideAwayDir,
						narrowDir: narrowAwayDir,
						w1,
						w2,
						layer: t1.getState_Layer(),
						net: actualNet,
						widePortion,
						narrowPortion,
						totalLength,
						shortenTrackId: wideId,
						shortenEndpoint: wideIsStart ? 'start' : 'end',
					});
				}
				else {
					// 纯窄线侧模式 (balance=0)
					pendingTransitions.push({
						point: connPoint,
						wideDir: wideAwayDir,
						narrowDir: narrowAwayDir,
						w1,
						w2,
						layer: t1.getState_Layer(),
						net: actualNet,
						widePortion: 0,
						narrowPortion,
						totalLength: narrowPortion,
					});
				}
			}
		}

		// 步骤 2: 执行导线缩短
		const shortenedTrackEndpoints = new Map<string, { start: { x: number; y: number }; end: { x: number; y: number } }>();

		for (const [id, req] of pendingShortens) {
			const t = req.original;
			const pStart = { x: t.getState_StartX(), y: t.getState_StartY() };
			const pEnd = { x: t.getState_EndX(), y: t.getState_EndY() };
			const w = t.getState_LineWidth();
			const net = t.getState_Net();
			const layer = t.getState_Layer();

			const vec = { x: pEnd.x - pStart.x, y: pEnd.y - pStart.y };
			const len = Math.sqrt(vec.x ** 2 + vec.y ** 2);
			if (len < 0.001)
				continue;
			const ux = vec.x / len;
			const uy = vec.y / len;

			const sStart = req.start || 0;
			const sEnd = req.end || 0;

			if (sStart + sEnd >= len - 0.1) {
				// 太短了，无法缩短 (避免完全删除导线导致断路)
				continue;
			}

			// 计算新坐标
			const newStart = { x: pStart.x + ux * sStart, y: pStart.y + uy * sStart };
			const newEnd = { x: pEnd.x - ux * sEnd, y: pEnd.y - uy * sEnd };

			// 替换导线
			try {
				await eda.pcb_PrimitiveLine.delete([id]);
				await eda.pcb_PrimitiveLine.create(net, layer, newStart.x, newStart.y, newEnd.x, newEnd.y, w, false);

				// 存储新端点用于过渡生成
				// 起点处的过渡 (req.start) 需要使用 newStart
				// 终点处的过渡 (req.end) 需要使用 newEnd
				shortenedTrackEndpoints.set(id, { start: newStart, end: newEnd });
			}
			catch {
				logError(`缩短导线失败`, 'Transitions');
			}
		}

		// 步骤 3: 执行过渡生成
		for (const trans of pendingTransitions) {
			const key = pointKey(trans.point);
			try {
				// 计算过渡起点：
				// 过渡从宽线侧的新端点开始, 经过连接点, 延伸到窄线侧结束
				// 起点 = connPoint 向宽线方向偏移 widePortion
				let wideStartPoint = trans.point; // 默认是连接点
				let actualWidePortion = trans.widePortion;

				// 如果有宽线侧缩短, 尝试获取精确的新端点坐标
				if (actualWidePortion >= 1 && trans.shortenTrackId) {
					if (shortenedTrackEndpoints.has(trans.shortenTrackId)) {
						const newEndpoints = shortenedTrackEndpoints.get(trans.shortenTrackId)!;
						wideStartPoint = (trans.shortenEndpoint === 'start')
							? newEndpoints.start
							: newEndpoints.end;
					}
					else if (pendingShortens.has(trans.shortenTrackId)) {
						// 缩短记录存在但端点未保存 (可能缩短失败), 使用向量回推
						const dirLen = Math.sqrt(trans.wideDir.x ** 2 + trans.wideDir.y ** 2);
						if (dirLen > 0.001) {
							const ux = trans.wideDir.x / dirLen;
							const uy = trans.wideDir.y / dirLen;
							wideStartPoint = {
								x: trans.point.x + ux * actualWidePortion,
								y: trans.point.y + uy * actualWidePortion,
							};
						}
					}
					else {
						// 缩短未执行, 回退: 不占宽线侧
						actualWidePortion = 0;
					}
				}

				// 方向: 从 wideStartPoint 指向 narrowEnd (过渡线方向)
				// 即从宽的一端指向窄的一端, 方向 = narrowDir (背离连接点, 深入窄线)
				const transDir = trans.narrowDir;

				// 总过渡长度 = 实际宽线部分 + 窄线部分
				const totalLen = actualWidePortion + trans.narrowPortion;

				if (totalLen < 1)
					continue;

				const ids = await createWidthTransition(
					wideStartPoint,
					transDir,
					trans.w1,
					trans.w2,
					trans.layer,
					trans.net,
					totalLen,
					settings,
					true, // 使用精确长度
				);

				// 追加 ID
				if (recordsMap.has(key)) {
					const r = recordsMap.get(key)!;
					r.ids.push(...ids);
				}
				else {
					recordsMap.set(key, { point: key, ids });
				}
				transitionCount++;

				if (transitionCount % 10 === 0)
					await new Promise(r => setTimeout(r, 5));
			}
			catch (e: any) {
				logError(`过渡创建失败: ${e.message || e}`, 'Transitions');
			}
		}
	}

	debugLog(`完成，创建了 ${transitionCount} 个过渡`, 'Transitions');

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
	forceExactLength: boolean = false,
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
	const idealLength = widthDiff * (settings.widthTransitionRatio || 1.5);
	let transitionLength: number;

	if (forceExactLength) {
		// 强制填满长度（用于填充缩短后的间隙）
		transitionLength = narrowTrackLength;
	}
	else {
		// 默认模式（覆盖），限制为窄线长度的90%
		const maxAllowedLength = narrowTrackLength * 0.9;
		transitionLength = Math.min(idealLength, maxAllowedLength);
	}

	// 如果过渡长度太短，跳过
	if (transitionLength < 1) {
		debugLog(`跳过：过渡长度太短 (${transitionLength.toFixed(2)})`, 'Transitions');
		return createdIds;
	}

	debugLog(`理想长度=${idealLength.toFixed(2)}, 实际长度=${transitionLength.toFixed(2)}`, 'Transitions');

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

	debugLog(`创建贝塞尔过渡: 长度=${transitionLength.toFixed(2)}, 段数=${segments}`, 'Transitions');

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
			logError(`创建线段失败: ${err}`, 'Transitions');
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
