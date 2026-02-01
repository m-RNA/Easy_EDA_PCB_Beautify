import { debugLog, logError } from './logger';
import { cubicBezier, dist, lerp } from './math';
import { getSettings } from './settings';
import { createSnapshot } from './snapshot';

export async function addTeardrops() {
	const settings = await getSettings();

	if (
		eda.sys_LoadingAndProgressBar
		&& typeof eda.sys_LoadingAndProgressBar.showLoading === 'function'
	) {
		eda.sys_LoadingAndProgressBar.showLoading();
	}

	let scopeLabel = '(All)';
	try {
		const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		if (selectedIds && selectedIds.length > 0) {
			scopeLabel = '(Selected)';
		}
	}
	catch {
		// ignore
	}

	// 创建操作前快照
	try {
		await createSnapshot(`Teardrop ${scopeLabel} Before`);
	}
	catch (e: any) {
		logError(`Failed to create snapshot: ${e.message || e}`);
	}

	try {
		await removeExistingTeardrops(); // 先清除

		let pins: any[] = [];
		const selected = await eda.pcb_SelectControl.getAllSelectedPrimitives();

		if (selected && Array.isArray(selected) && selected.length > 0) {
			// 处理选中
			let primitives: any[] = [];
			if (typeof selected[0] === 'string') {
				for (const id of selected as unknown as string[]) {
					const p
						= (await eda.pcb_PrimitivePad.get(id))
							|| (await eda.pcb_PrimitiveVia.get(id))
							|| (await eda.pcb_PrimitiveComponent.get(id));
					if (p)
						primitives.push(p);
				}
			}
			else {
				primitives = selected;
			}
			pins = primitives.filter(
				(p: any) =>
					p
					&& typeof p.getState_PrimitiveType === 'function'
					&& (p.getState_PrimitiveType() === 'Pad'
						|| p.getState_PrimitiveType() === 'Via'
						|| p.getState_PrimitiveType() === 'ComponentPad'),
			);
		}

		// 如果没有有效的选中对象，则处理全体
		if (pins.length === 0) {
			debugLog('未选中对象，获取全板焊盘和过孔', 'Teardrop');
			// 获取全板焊盘和过孔的ID，然后逐个获取对象
			const padIds = await eda.pcb_PrimitivePad.getAllPrimitiveId();
			const viaIds = await eda.pcb_PrimitiveVia.getAllPrimitiveId();

			debugLog(`找到 ${padIds.length} 个焊盘, ${viaIds.length} 个过孔`, 'Teardrop');

			for (const id of padIds) {
				const pad = await eda.pcb_PrimitivePad.get(id);
				if (pad)
					pins.push(pad);
			}
			for (const id of viaIds) {
				const via = await eda.pcb_PrimitiveVia.get(id);
				if (via)
					pins.push(via);
			}
		}

		debugLog(`开始处理 ${pins.length} 个焊盘/过孔`, 'Teardrop');

		let processedCount = 0;
		for (const pin of pins) {
			const net = pin.getState_Net();
			if (!net) {
				continue;
			}

			const px = pin.getState_X();
			const py = pin.getState_Y();

			processedCount++;

			// 获取连接到此焊盘的导线（遍历所有层）
			const allTracks = await eda.pcb_PrimitiveLine.getAll(net);
			const connectedTracks = allTracks.filter(
				(p: any) =>
					dist(
						{ x: p.getState_StartX(), y: p.getState_StartY() },
						{ x: px, y: py },
					) < 0.1
					|| dist(
						{ x: p.getState_EndX(), y: p.getState_EndY() },
						{ x: px, y: py },
					) < 0.1,
			);

			for (const track of connectedTracks) {
				await createTeardropForTrack(pin, track, settings);
			}
		}

		debugLog(`处理完成，共处理 ${processedCount} 个焊盘/过孔`, 'Teardrop');

		if (
			eda.sys_Message
			&& typeof eda.sys_Message.showToastMessage === 'function'
		) {
			eda.sys_Message.showToastMessage(eda.sys_I18n.text(`泪滴处理完成 (处理了${processedCount}个)`));
		}

		// 创建操作后快照
		try {
			await createSnapshot(`Teardrop ${scopeLabel} After`);
		}
		catch (e: any) {
			logError(`Failed to create result snapshot: ${e.message || e}`);
		}
	}
	catch (e: any) {
		if (
			eda.sys_Dialog
			&& typeof eda.sys_Dialog.showInformationMessage === 'function'
		) {
			eda.sys_Dialog.showInformationMessage(e.message, 'Teardrop Error');
		}
	}
	finally {
		if (
			eda.sys_LoadingAndProgressBar
			&& typeof eda.sys_LoadingAndProgressBar.destroyLoading === 'function'
		) {
			eda.sys_LoadingAndProgressBar.destroyLoading();
		}
	}
}

async function removeExistingTeardrops() {
	try {
		const regions = await eda.pcb_PrimitiveRegion.getAll();
		const toDelete: string[] = [];

		if (regions && Array.isArray(regions)) {
			for (const region of regions) {
				let name = '';
				if (typeof region.getState_RegionName === 'function') {
					name = region.getState_RegionName() ?? '';
				}

				if (name === 'Teardrop') {
					if (typeof region.getState_PrimitiveId === 'function') {
						const id = region.getState_PrimitiveId();
						if (id) {
							toDelete.push(id);
						}
					}
				}
			}
		}

		if (toDelete.length > 0) {
			await eda.pcb_PrimitiveRegion.delete(toDelete);
		}
	}
	catch (e) {
		console.error('Failed to remove existing teardrops', e);
	}
}

async function createTeardropForTrack(pin: any, track: any, settings: any) {
	const px = pin.getState_X();
	const py = pin.getState_Y();
	const trackWidth = track.getState_LineWidth();

	// 确定哪一端连接到焊盘
	const isStart
		= dist(
			{ x: track.getState_StartX(), y: track.getState_StartY() },
			{ x: px, y: py },
		) < 0.1;
	const pFar = isStart
		? { x: track.getState_EndX(), y: track.getState_EndY() }
		: { x: track.getState_StartX(), y: track.getState_StartY() };
	const pNear = { x: px, y: py };

	// 向量方向
	const dx = pFar.x - pNear.x;
	const dy = pFar.y - pNear.y;
	const d = Math.sqrt(dx * dx + dy * dy);
	const ux = dx / d;
	const uy = dy / d;

	// 极坐标旋转 90 度
	const vx = -uy;
	const vy = ux;

	// 泪滴长度和宽度 (基于 settings)
	const length = trackWidth * 3 * settings.teardropSize;
	const widthAtPad = trackWidth * 2 * settings.teardropSize;

	const pTrack = lerp(pNear, pFar, length / d);
	const pEdge1 = {
		x: pNear.x + (vx * widthAtPad) / 2,
		y: pNear.y + (vy * widthAtPad) / 2,
	};
	const pEdge2 = {
		x: pNear.x - (vx * widthAtPad) / 2,
		y: pNear.y - (vy * widthAtPad) / 2,
	};

	// 生成贝塞尔曲线点集，模拟泪滴的平滑曲线
	const polyPoints: any[] = [];

	// 连接到 P1 -> P_Track -> P2 -> P_Near -> P1
	// 使用贝塞尔插值 P1 -> P_Track 和 P2 -> P_Track
	const steps = 10;

	// P1 到 P_Track 的曲线
	const cp1 = lerp(pEdge1, pTrack, 0.5); // 控制点1
	const cp2 = lerp(pEdge1, pTrack, 0.8); // 控制点2
	for (let i = 0; i <= steps; i++) {
		const pt = cubicBezier(pEdge1, cp1, cp2, pTrack, i / steps);
		polyPoints.push(pt.x, pt.y);
	}

	// P_Track 到 P2 的曲线
	const cp3 = lerp(pEdge2, pTrack, 0.8);
	const cp4 = lerp(pEdge2, pTrack, 0.5);
	for (let i = 0; i <= steps; i++) {
		const pt = cubicBezier(pTrack, cp3, cp4, pEdge2, i / steps);
		polyPoints.push(pt.x, pt.y);
	}

	polyPoints.push(pNear.x, pNear.y);

	const polygon = eda.pcb_MathPolygon.createPolygon(polyPoints);
	if (polygon) {
		await eda.pcb_PrimitiveRegion.create(
			track.getState_Layer(),
			polygon as any,
			undefined,
			'Teardrop',
		);
	}
}
