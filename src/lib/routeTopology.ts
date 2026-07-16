import type { Point } from './math';

const MULTI_LAYER_ID = 12;
const ANY_COPPER_LAYER = '*';

export interface RouteTopologySegment {
	net: string;
	layer: number;
	p1: Point;
	p2: Point;
}

export interface ElectricalAnchor {
	net: string;
	layer: number | typeof ANY_COPPER_LAYER;
	point: Point;
}

export interface AnchorLoadResult {
	anchorKeys: Set<string>;
	warnings: string[];
}

export interface TopologyLoadResult {
	segments: RouteTopologySegment[];
	warnings: string[];
}

export interface AnchorApi {
	pcb_PrimitivePad?: {
		getAll?: () => Promise<any[]>;
	};
	pcb_PrimitiveComponent?: {
		getAll?: () => Promise<any[]>;
		getAllPinsByPrimitiveId?: (primitiveId: string) => Promise<any[] | undefined>;
	};
	pcb_PrimitiveVia?: {
		getAll?: () => Promise<any[]>;
	};
}

interface TopologyApi {
	pcb_PrimitiveArc?: {
		getAll?: () => Promise<any[]>;
	};
	pcb_PrimitivePolyline?: {
		getAll?: () => Promise<any[]>;
	};
}

export function makePointKey(point: Point): string {
	return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
}

export function makeRouteNodeKey(net: string, layer: number, point: Point): string {
	return `${net}#@#${layer}#@#${makePointKey(point)}`;
}

function makeAnchorKey(net: string, layer: number | typeof ANY_COPPER_LAYER, point: Point): string {
	return `${net}#@#${layer}#@#${makePointKey(point)}`;
}

export function buildNodeDegreeIndex(segments: RouteTopologySegment[]): Map<string, number> {
	const degreeIndex = new Map<string, number>();
	for (const segment of segments) {
		for (const point of [segment.p1, segment.p2]) {
			const key = makeRouteNodeKey(segment.net, segment.layer, point);
			degreeIndex.set(key, (degreeIndex.get(key) || 0) + 1);
		}
	}
	return degreeIndex;
}

export function buildAnchorIndex(anchors: ElectricalAnchor[]): Set<string> {
	return new Set(anchors.map(anchor => makeAnchorKey(anchor.net, anchor.layer, anchor.point)));
}

export function isRouteJunction(
	net: string,
	layer: number,
	point: Point,
	degreeIndex: Map<string, number>,
): boolean {
	return (degreeIndex.get(makeRouteNodeKey(net, layer, point)) || 0) !== 2;
}

export function isProtectedRouteNode(
	net: string,
	layer: number,
	point: Point,
	degreeIndex: Map<string, number>,
	anchorKeys: Set<string>,
	protectAnchors: boolean,
): boolean {
	const nodeKey = makeRouteNodeKey(net, layer, point);
	if (isRouteJunction(net, layer, point, degreeIndex))
		return true;

	if (!protectAnchors)
		return false;

	return anchorKeys.has(nodeKey)
		|| anchorKeys.has(makeAnchorKey(net, ANY_COPPER_LAYER, point));
}

function readState<T>(item: any, methodName: string, propertyName: string): T | undefined {
	if (!item)
		return undefined;
	if (typeof item[methodName] === 'function')
		return item[methodName]();
	return item[propertyName];
}

function addLineLikeSegment(segments: RouteTopologySegment[], item: any): void {
	const net = readState<string>(item, 'getState_Net', 'net');
	const layer = readState<number>(item, 'getState_Layer', 'layer');
	const startX = readState<number>(item, 'getState_StartX', 'startX');
	const startY = readState<number>(item, 'getState_StartY', 'startY');
	const endX = readState<number>(item, 'getState_EndX', 'endX');
	const endY = readState<number>(item, 'getState_EndY', 'endY');
	if (
		typeof net !== 'string'
		|| typeof layer !== 'number'
		|| typeof startX !== 'number'
		|| typeof startY !== 'number'
		|| typeof endX !== 'number'
		|| typeof endY !== 'number'
	) {
		return;
	}

	segments.push({
		net,
		layer,
		p1: { x: startX, y: startY },
		p2: { x: endX, y: endY },
	});
}

function addPolylineSegments(segments: RouteTopologySegment[], item: any): void {
	const net = readState<string>(item, 'getState_Net', 'net');
	const layer = readState<number>(item, 'getState_Layer', 'layer');
	const polygon = readState<any>(item, 'getState_Polygon', 'polygon');
	const rawCoordinates = polygon?.polygon;
	if (typeof net !== 'string' || typeof layer !== 'number' || !Array.isArray(rawCoordinates))
		return;

	const coordinates = rawCoordinates.filter((value: any) => typeof value === 'number');
	for (let index = 0; index + 3 < coordinates.length; index += 2) {
		segments.push({
			net,
			layer,
			p1: { x: coordinates[index], y: coordinates[index + 1] },
			p2: { x: coordinates[index + 2], y: coordinates[index + 3] },
		});
	}
}

export async function loadBoardTopologySegments(
	straightLines: any[],
	api: TopologyApi,
): Promise<TopologyLoadResult> {
	const segments: RouteTopologySegment[] = [];
	const warnings: string[] = [];
	for (const line of straightLines)
		addLineLikeSegment(segments, line);

	if (typeof api.pcb_PrimitiveArc?.getAll === 'function') {
		try {
			const arcs = await api.pcb_PrimitiveArc.getAll();
			for (const arc of arcs || [])
				addLineLikeSegment(segments, arc);
		}
		catch (error: any) {
			warnings.push(`读取圆弧拓扑失败: ${error?.message || error}`);
		}
	}

	if (typeof api.pcb_PrimitivePolyline?.getAll === 'function') {
		try {
			const polylines = await api.pcb_PrimitivePolyline.getAll();
			for (const polyline of polylines || [])
				addPolylineSegments(segments, polyline);
		}
		catch (error: any) {
			warnings.push(`读取折线拓扑失败: ${error?.message || error}`);
		}
	}

	return { segments, warnings };
}

function addPadAnchor(anchorKeys: Set<string>, pad: any): void {
	const net = readState<string>(pad, 'getState_Net', 'net');
	const x = readState<number>(pad, 'getState_X', 'x');
	const y = readState<number>(pad, 'getState_Y', 'y');
	const layer = readState<number>(pad, 'getState_Layer', 'layer');
	if (!net || typeof x !== 'number' || typeof y !== 'number' || typeof layer !== 'number')
		return;

	const anchorLayer = layer === MULTI_LAYER_ID ? ANY_COPPER_LAYER : layer;
	anchorKeys.add(makeAnchorKey(net, anchorLayer, { x, y }));
}

function addViaAnchor(anchorKeys: Set<string>, via: any): void {
	const net = readState<string>(via, 'getState_Net', 'net');
	const x = readState<number>(via, 'getState_X', 'x');
	const y = readState<number>(via, 'getState_Y', 'y');
	if (!net || typeof x !== 'number' || typeof y !== 'number')
		return;

	anchorKeys.add(makeAnchorKey(net, ANY_COPPER_LAYER, { x, y }));
}

async function loadComponentPads(
	api: AnchorApi,
	anchorKeys: Set<string>,
	warnings: string[],
): Promise<void> {
	if (typeof api.pcb_PrimitiveComponent?.getAll !== 'function') {
		warnings.push('器件 API 不支持读取焊盘');
		return;
	}

	let components: any[];
	try {
		const result = await api.pcb_PrimitiveComponent.getAll();
		components = Array.isArray(result) ? result : [];
	}
	catch (error: any) {
		warnings.push(`读取器件列表失败: ${error?.message || error}`);
		return;
	}

	let cursor = 0;
	const workerCount = Math.min(8, components.length);
	const workers = Array.from({ length: workerCount }, async () => {
		while (cursor < components.length) {
			const component = components[cursor++];
			try {
				let pads: any[] | undefined;
				if (typeof component?.getAllPins === 'function') {
					pads = await component.getAllPins();
				}
				else if (typeof api.pcb_PrimitiveComponent?.getAllPinsByPrimitiveId === 'function') {
					const primitiveId = readState<string>(component, 'getState_PrimitiveId', 'primitiveId');
					if (primitiveId)
						pads = await api.pcb_PrimitiveComponent.getAllPinsByPrimitiveId(primitiveId);
				}
				if (!pads) {
					warnings.push('存在无法读取焊盘的器件');
					continue;
				}
				for (const pad of pads)
					addPadAnchor(anchorKeys, pad);
			}
			catch (error: any) {
				warnings.push(`读取器件焊盘失败: ${error?.message || error}`);
			}
		}
	});
	await Promise.all(workers);
}

export async function loadElectricalAnchorIndex(api: AnchorApi): Promise<AnchorLoadResult> {
	const anchorKeys = new Set<string>();
	const warnings: string[] = [];

	if (typeof api.pcb_PrimitivePad?.getAll === 'function') {
		try {
			const pads = await api.pcb_PrimitivePad.getAll();
			for (const pad of pads || [])
				addPadAnchor(anchorKeys, pad);
		}
		catch (error: any) {
			warnings.push(`读取独立焊盘失败: ${error?.message || error}`);
		}
	}
	else {
		warnings.push('焊盘 API 不可用');
	}

	await loadComponentPads(api, anchorKeys, warnings);

	if (typeof api.pcb_PrimitiveVia?.getAll === 'function') {
		try {
			const vias = await api.pcb_PrimitiveVia.getAll();
			for (const via of vias || [])
				addViaAnchor(anchorKeys, via);
		}
		catch (error: any) {
			warnings.push(`读取过孔失败: ${error?.message || error}`);
		}
	}
	else {
		warnings.push('过孔 API 不可用');
	}

	return { anchorKeys, warnings };
}
