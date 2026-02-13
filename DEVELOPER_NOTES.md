# Developer Notes & Best Practices: JLC EDA Pro Extension Development

This document serves as a comprehensive technical guide and architecture log for the **EASY EDA PCB Beautify** project. It documents critical discoveries, optimization strategies, and best practices for building high-performance, idiomatic extensions in the JLC EDA Pro environment.

## Background: The `eda` Global Object

To understand the solution, we must first understand the host environment. The extension operates within a managed runtime provided by JLC EDA Pro.

### 1. The `eda` Object as a Singleton

Every extension runtime is injected with a **unique and independent** `eda` object in its root scope.

- **Isolation**: This object is not shared with other extensions, ensuring that properties attached to it do not collide with other installed plugins.
- **Ubiquity**: This object is accessible globally in both the Main Process (Worker) and the Iframe logic (through the parent scope proxy or direct injection), making it the *only* guaranteed shared memory reference between these contexts.

### 2. Standard Usage: The Official API Pattern

According to the official documentation, the extension API module contains many specialized classes. All Classes, Enums, Interfaces, and Type Aliases are registered under the EDA base class and instantiated as the `eda` object, which exists in the root scope of every extension runtime.

**Key Characteristics:**

- **Isolation**: Every extension runtime generates an independent `eda` object not shared with others.
- **Access Pattern**: `eda` + `Class Instance Name` + `Method/Variable`.
- **Naming Rule**: The system instantiates classes using a specific naming convention: **the first three letters before the underscore are lowercased**.

| Class Name | Instance Name |
| --- | --- |
| `SYS_I18n` | `sys_I18n` |
| `SYS_ToastMessage` | `sys_ToastMessage` |

```js
// Example: Calling SYS_I18n.text and SYS_ToastMessage.showMessage
// Note strictly lowercase 'sys' prefix
eda.sys_ToastMessage.showMessage(eda.sys_I18n.text('Done'), ESYS_ToastMessageType.INFO);
```

Because of property **#1 (Isolation)**, we can repurpose this object to store our own global state, solving the isolation problem described below.

## The Problem: Module-Level Variable Isolation

When developing extensions that share state between the worker logic and the settings UI (iframe), you might encounter situations where updates in one context are not reflected in the other, even if you are accessing what seems to be the same "File" or "API".

### Scenario

1. **Main Process (`src/lib/*.ts`)**: Updates a module-level variable (e.g., `let globalCache = [...]`).
2. **Iframe UI (`iframe/settings.html`)**: Calls a function exposed by the main process (via `eda.extension_api...`) that tries to read that variable.
3. **Result**: The Iframe sees an stale or empty version of the variable, while the Main Process sees the updated one.

### Cause

In the Javascript environment of EasyEDA Pro extensions:

- The `src/` code bundles into a worker script.
- The `iframe/settings.html` runs in a separate browser context (an iframe).
- While the `eda` global object facilitates communication, **Module Scoped Variables** (declared with `let`, `const` at the top level of a file) may be instantiated separately for different contexts or re-evaluated in ways that break reference equality.

## The Solution: Global Object Anchoring

To ensure that both the Main Process and the Iframe logic access the **exact same memory reference** for shared state (like a cache), you must anchor that state to the globally shared `eda` object.

### Implementation

Instead of:

```typescript
// src/lib/state.ts
let myCache: any[] = []; // ❌ Risky: May be isolated per context

export function updateCache(data: any) {
	myCache = data;
}

export function getCache() {
	return myCache;
}
```

Use:

```typescript
// src/lib/state.ts
const CACHE_KEY = '_unique_extension_id_cache';

export function updateCache(data: any) {
	// ✅ Safe: Anchored to the single source of truth 'eda'
	(eda as any)[CACHE_KEY] = data;
}

export function getCache() {
	return (eda as any)[CACHE_KEY] || [];
}
```

### Best Practices

1. **Unique Keys**: Always use a unique prefix (e.g., `_jlc_beautify_...`) to avoid collisions with other extensions or system properties.
2. **Callbacks**: This applies to callbacks as well. If you need the Main Process to trigger a UI update inside the Iframe, register the callback on the `eda` object rather than a local variable.
3. **Cleanup**: Be mindful of cleaning up large objects if the extension is unloaded (though rare for this type of extension).

## Case Study: Snapshot Feature

In the **Easy EDA PCB Beautify** extension, we encountered this with the Snapshot list.

- **Symptom**: Snapshots created automatically by the router were not appearing in the Settings UI list, despite the UI polling for updates.
- **Fix**: We moved `globalSnapshotsCache` from a file-level variable in `snapshot.ts` to `eda._jlc_beautify_snapshots_cache`. The UI and the Main Process now read/write to the exact same array reference in memory.

## Iframe Resource Inlining

When using `sys_IFrame.openIFrame`, external CSS (`<link href="...">`) and JS (`<script src="...">`) files referenced in the HTML may fail to load in the extension environment.

**Recommendation**: Always **inline** your CSS and JavaScript directly into the HTML file using `<style>` and `<script>` blocks to ensure the UI renders correctly.

## DRC API Data Structure & Filtering

### API Call

```ts
const issues = await eda.pcb_Drc.check(false, false, true);
// check(false, false, true) → returns Promise<Array<any>>
```

### Three-Level Nesting Structure

The returned array contains **Category** objects, each containing **Sub-category** groups, each containing individual **Issue** items:

```txt
Level 1 — Category
│  name: "Clearance Error"
│  count: 14
│  title: ["Clearance Error", "(14)"]
│  visible: true
│  list: [...]
│
├── Level 2 — Sub-category
│   │  name: "SMD Pad to Track"              ← Non-copper-pour
│   │  count: 2
│   │  title: ["SMD Pad", "to", "Track", "(2)"]
│   │  visible: true
│   │  list: [...]
│   │
│   └── Level 3 — Individual Issue
│       │  visible: true
│       │  errorType: "Clearance Error"
│       │  errorObjType: "SMD Pad to Track"   ← Key field for filtering
│       │  ruleName: "copperThickness1oz"      ← NOT copper-pour related!
│       │  ruleTypeName: "Safe Spacing"
│       │  layer: "Bottom Layer"
│       │  globalIndex: "err1783"
│       │  objs: ["8b3156fa...", "5d20f23f..."]  ← Violated object IDs
│       │  pos: { x, y }
│       │  parentId: "DRCTab|_|Errors|_|Clearance Error|_|SMD Pad to Track"
│       │
│       │  obj1: { typeName: "Track", suffix: "(VBAT_SW): e936" }
│       │  obj2: { typeName: "SMD Pad", suffix: "(GND): C5_1" }
│       │
│       └─ explanation:
│            str: "{obj1} to {obj2} distance is {minDistance}, should be {shouldBe}"
│            param: { minDistance: "5.5mil", shouldBe: ">= 6mil", type: "ClearanceError" }
│            errData:
│              globalIndex: "err1783"
│              name: "copperThickness1oz"
│              obj1: "8b3156fa..."      ← Object 1 ID
│              obj1Type: "Track"        ← Object 1 type
│              obj2: "5d20f23f..."      ← Object 2 ID
│              obj2Type: "SMD Pad"      ← Object 2 type
│              minDistance: 0.548       (unit: 10mil, i.e. mm/0.0254/10)
│              clearance: 0.598
│              errorType: "Safe Spacing"
│              layerIds: [2]
│              position: { x, y }
│
├── Level 2 — Sub-category (Copper Pour)
│   │  name: "Copper Region(Filled) to Track" ← Copper-pour related
│   │  count: 11
│   │  list: [...]
│   │
│   └── Level 3 — Individual Issue
│         errorObjType: "Copper Region(Filled) to Track"
│         obj1: { typeName: "Copper Region(Filled)", suffix: "(GND): e15e1" }
│         obj2: { typeName: "Track", suffix: "(VBAT_SW): e936" }
│         errData.obj1Type: "Copper Region(Filled)"
│         ...
```

### Copper Pour Filtering Strategy

**Goal**: Filter out copper-pour-related DRC issues (they auto-resolve after re-pouring) while keeping real violations.

**Pitfall**: The `ruleName` field is `"copperThickness1oz"` for ALL clearance errors (it's the rule name, not the object type). Matching the word `"copper"` broadly will incorrectly filter out real violations like "SMD Pad to Track" and "Track to Via".

**Correct approach** — Match on **object type** fields only:

| Field | Copper-pour issue | Real violation |
| --- | --- | --- |
| `errorObjType` | `"Copper Region(Filled) to Track"` | `"SMD Pad to Track"` |
| `name` (sub-category) | `"Copper Region(Filled) to Track"` | `"Track to Via"` |
| `obj1.typeName` | `"Copper Region(Filled)"` | `"Track"` |
| `obj2.typeName` | `"Track"` | `"SMD Pad"` / `"Via"` |
| `errData.obj1Type` | `"Copper Region(Filled)"` | `"Track"` |
| `errData.obj2Type` | `"Track"` | `"SMD Pad"` / `"Via"` |

**Keywords**: `"Copper Region"` (matches `"Copper Region(Filled)"`) plus Chinese equivalents `铜皮/覆铜/铺铜/灌铜/铜区/敷铜` for locale safety.

**Filtering is applied at Level 2 (sub-category) and Level 3 (individual issue)**. If all issues in a sub-category are filtered, the sub-category itself is removed. If all sub-categories in a category are filtered, the category is removed.

### Extracting Violated Object IDs

For DRC-based auto-rollback, we extract object IDs from the remaining (non-copper-pour) issues:

1. **Primary**: `issue.objs[]` — array of string IDs directly
2. **Secondary**: `issue.explanation.errData.obj1` / `.obj2` — redundant but useful as fallback
3. **Recursive**: Walk `list[]` arrays at each nesting level

These IDs are matched against the primitives being modified to determine which corners need radius reduction.

## Undocumented API: Copper Pour Rebuild

### Discovery

The `IPCB_PrimitivePour` class has a method `rebuildCopperRegion()` that is **excluded from the official type declarations** (`@jlceda/pro-api-types`) but **exists and works at runtime**.

In the `.d.ts` file, many `IPCB_PrimitivePour` methods are annotated with:

```ts
// Excluded from this release type
```

However, at runtime the prototype contains 32 methods including `rebuildCopperRegion`.

### Verification

```ts
// List all methods on a pour object
const pours = eda.pcb_PrimitivePour.getAll();
console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(pours[0])));
// → ["constructor", "rebuildCopperRegion", "getCopperRegion", "convertToFill",
//    "convertToPolyline", "convertToRegion", "done", "reset", ...]

// Execute rebuild
pours[0].rebuildCopperRegion();
// Console output: "worker completed pour calculation, thermal generation, 0.282s"
```

### Usage in Code

Since the method is not in the type declarations, we must use `as any` to bypass TypeScript:

```typescript
export async function rebuildAllCopperPours(): Promise<number> {
	const pours = eda.pcb_PrimitivePour.getAll();
	if (!pours || pours.length === 0)
		return 0;

	for (const pour of pours) {
		(pour as any).rebuildCopperRegion();
	}
	return pours.length;
}
```

### Architecture

The feature uses a two-layer design:

1. **`rebuildAllCopperPours()`** — Pure execution: iterates all pours, calls `rebuildCopperRegion()`, returns count (0 = no pours, -1 = error).
2. **`rebuildAllCopperPoursIfEnabled()`** — Settings-aware wrapper: reads `rebuildCopperPourAfterBeautify` toggle → shows toast → calls rebuild. Returns -2 if disabled.

Both `beautifyAll()` and `widthTransitionAll()` in `index.ts` call the high-level wrapper at the entry layer, keeping the rebuild logic out of the core beautify/transition modules.

### Notes

- The method triggers an asynchronous pour calculation in the EDA worker. The canvas updates after the worker completes.
- Each pour is rebuilt independently. For boards with many copper zones, this may take noticeable time.
- Since this API is undocumented, it may change or be removed in future EDA versions. Monitor for breakage on EDA updates.

## Copper Pour ID Spaces: Three Non-Overlapping Systems

### Discovery (2026-02-12)

When implementing smart copper pour rebuild (only repouring DRC-violated regions instead of all 78 pours), we spent significant debugging time trying to match DRC-reported IDs to `pcb_PrimitivePour` objects. The root cause: **the EDA runtime maintains three completely independent ID namespaces for copper-related objects**, and none of them overlap.

### The Three ID Spaces

| # | Object Type | API / Source | Example ID | Description |
| --- | --- | --- | --- | --- |
| 1 | **Pour boundary** | `eda.pcb_PrimitivePour` | `2316cffa0d9f91e4` | User-drawn copper pour outline. This is what `rebuildCopperRegion()` operates on. |
| 2 | **Poured fill** | `eda.pcb_PrimitivePoured` | `df0d4325623cd52b` | Generated fill polygons created by the pour engine. Regenerated on every rebuild. |
| 3 | **DRC internal** | `eda.pcb_Drc.check()` → `errData.obj1/obj2` | `296cf192d9a8e1b5` | Internal "Copper Region(Filled)" references used only within DRC error reporting. |

### Diagnostic Evidence

```shell
DRC IDs (Sample):    296cf192d9a8e1b5, 7150c4091f757010, 94a2eea540594e9f
Pour IDs (Sample):   2316cffa0d9f91e4, 6ed988d76a53f6fe, ce5d6f2a975bc84c
Poured IDs (Sample): df0d4325623cd52b, 05f30e00070409b1, 3b54e96ec0519aaa
```

Zero intersection between any two sets across 78 pour objects and 64 DRC violations.

### Additional Findings on `pcb_PrimitivePoured`

- The `pourPrimitiveId` field exists on Poured objects but **points to its own `primitiveId`**, not to the parent Pour boundary. It is effectively a self-reference.
- `parentPrimitiveId` is `undefined` at runtime.
- `getState_Net()` and `getState_Layer()` both return `undefined` (the object has no net/layer accessors).
- Direct property access (`.net`, `.layer`) also returns `undefined`.

This means **Poured objects cannot be used as a bridge** between DRC IDs and Pour IDs — they carry no usable linkage information.

### Solution: Layer-Based Filtering

Since ID matching is impossible, we use **layer IDs** from the DRC error data as the matching dimension:

1. `errData.layerIds: number[]` — available on every DRC issue, contains the physical layer numbers where the violation occurs.
2. `pour.getState_Layer(): number` — returns the layer ID of each Pour boundary.

**Algorithm:**

```shell
DRC issues → extract violated layer IDs → filter Pour objects by layer → rebuildCopperRegion() only on matching pours
```

This reduces rebuild scope from all pours to only those on affected layers (e.g., 30/78 instead of 78/78 on a typical multi-layer board).

### Lesson

When working with EDA Pro's internal object model, **never assume IDs from different API endpoints share the same namespace**. Always verify with diagnostic logging before building ID-based matching logic.

## Architectural Pattern: Manifest-Driven UI

In later stages of development, we moved away from procedural UI management to a **Manifest-Driven** approach.

- **Centralized Definition**: The `extension.json` (Manifest) is the single source of truth for the menu structure (`headerMenus`).
- **Elimination of Redundancy**: Functions like `updateHeaderMenus()` that manually injected or updated menu items were removed.
- **Auto-Mapping**: The SDK automatically maps `registerFn` in the manifest to `export` functions in the entry file (`index.ts`).
- **Benefits**: This significantly reduces code complexity, eliminates "flashing" UI during registration, and ensures better compatibility with the host application's lifecycle.

## Shortcut Key Management

### Critical Discovery: Key Name Case Sensitivity (2026-02-13)

The `TSYS_ShortcutKeys` type definition declares **all keys in uppercase** (`'SHIFT'`, `'CONTROL'`, `'ALT'`, `'Q'`, `'F9'`, etc.). However, the EDA **runtime** is case-sensitive and requires a specific mixed-case format for shortcuts to actually trigger:

| Key Type | Type Definition | Runtime Requirement | Example |
| --- | --- | --- | --- |
| Modifier keys | `'SHIFT'`, `'CONTROL'`, `'ALT'` | **Title Case** | `'Shift'`, `'Ctrl'`, `'Alt'` |
| Letter keys | `'Q'`, `'W'`, `'Z'` | **Uppercase** | `'Q'`, `'W'`, `'Z'` |
| F-keys | `'F1'` – `'F20'` | **Uppercase** | `'F9'`, `'F6'` |
| Special keys | `'SPACE'`, `'TAB'`, `'UP'` | **Uppercase** | `'SPACE'`, `'TAB'`, `'UP'` |

**Symptom**: `registerShortcutKey()` returns `true` (success) regardless of case, but callbacks registered with all-uppercase modifier keys (`'SHIFT'`, `'CONTROL'`) **never fire** when the shortcut is pressed.

**Test Evidence**:

| Registration Format | Triggers? |
| --- | --- |
| `['Shift', 'Q']` | ✅ Yes |
| `['SHIFT', 'Q']` | ❌ No (registers OK, never fires) |
| `['Ctrl', 'Shift', 'Q']` | ✅ Yes |
| `['CONTROL', 'SHIFT', 'Q']` | ❌ No |
| `['F9']` | ✅ Yes (no modifier, already uppercase) |
| `['Shift', 'F6']` | ✅ Yes |
| `['SHIFT', 'F5']` | ❌ No |

**Important**: The modifier key `Ctrl` must be spelled `'Ctrl'`, NOT `'Control'`. The type definition says `'CONTROL'` but the runtime recognizes `'Ctrl'`.

**Fix**: The `normalizeKeyToken()` function in `shortcuts.ts` must output Title Case for modifiers (`Ctrl`, `Shift`, `Alt`, `Cmd`, `Win`) and uppercase for everything else. The frontend `settings.html` already saves keys in the correct format via `toFriendlyKey()`.

### Conflict Detection

Before registering shortcuts, we use `eda.sys_ShortcutKey.getShortcutKeys(true)` to pull the complete list of existing bindings (including user-defined and system-defaults).

- **Implementation**: We sort the key arrays and join them with `+` to perform a normalized string match against our targets.
- **Protection**: If a conflict is detected, we log a warning and skip our registration rather than overriding host/user keys.

### Documentation Alignment: `TSYS_ShortcutKeys`

Our shortcut registration logic references the [TSYS_ShortcutKeys](EDA_EX_DOC/JLC_EDA_API/TSYS_ShortcutKeys%20type%20_%20嘉立创EDA专业版用户指南.html) definition for the list of supported keys.

- **Supported Keys ONLY**: The settings UI (`settings.html`) filters out keys NOT found in the `TSYS_ShortcutKeys` type (e.g., `Escape`, `Enter`, `Delete`, `Backspace` are forbidden for registry).
- **Modifier Mapping** (runtime format, NOT type-definition format):
  - `CONTROL` / `CTRL` → `Ctrl`
  - `SHIFT` → `Shift`
  - `ALT` → `Alt`
  - `COMMAND` / `CMD` → `Cmd` (macOS)
  - `WIN` / `META` / `SUPER` → `Win` (Windows/Linux)
- **Frontend-Backend Consistency**: Both `settings.html` (`toFriendlyKey()`) and `shortcuts.ts` (`normalizeKeyToken()`) must produce the **same output format**. The frontend saves keys directly in the runtime-compatible format.

### Common EDA Shortcuts

To match user muscle memory from other EDA tools, we register the following by default (if free):

| Shortcut | Action |
| --- | --- |
| `Shift + Q` | Beautify Selected |
| `Ctrl + Shift + Q` | Beautify All |
| `Ctrl + Shift + Z` | Undo Operation |

### Registration Context

- **DocumentType**: `[4]` (PCB) - Ensures keys only trigger in the layout editor.
- **Scene**: `[1, 2, 3, 4, 5, 6]` (All editor scenes) - Allows keys to work during all editing modes including selection, drawing, and placement.

## Multi-language Support (I18n)

### Automatic Translation Mechanism

嘉立创 EDA Pro SDK 提供了自动翻译机制。只需在 `./locales/` 目录下创建对应的语言文件（如 `zh-Hans.json`, `en.json`），SDK 会在渲染 UI 时自动执行翻译。

- **适用范围**：`headerMenus` 的 `title`、`sys_ShortcutKey` 注册时的 `title` 等。
- **最佳实践**：
    1. **直接使用 Key**：代码中直接书写中文或英文原文作为 Key，无需手动调用 `eda.sys_I18n.text()`。
    2. **无代码介入**：移除 `index.ts` 中所有用于手动翻译的代码。
    3. **简化代码**：移除冗余的翻译，完全依赖 `.json` 配置文件。
    4. **回退语言**：确保包含 `zh-Hans.json` 作为主语言定义。

---
Created: 2026-01-31
Updated: 2026-02-13
