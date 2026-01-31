# Developer Notes: Handling Memory Isolation Issues in EasyEDA Extension Development

This document describes a specific pitfall encountered during the development of JLC EDA extensions and how to solve it. This is particularly relevant when extensions involve both a Main Process (running in the extension worker) and an Iframe UI (running in a sandboxed iframe).

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

1. **Unique Keys**: Always use a unique prefix (e.g., `_jlc_smooth_...`) to avoid collisions with other extensions or system properties.
2. **Callbacks**: This applies to callbacks as well. If you need the Main Process to trigger a UI update inside the Iframe, register the callback on the `eda` object rather than a local variable.
3. **Cleanup**: Be mindful of cleaning up large objects if the extension is unloaded (though rare for this type of extension).

## Case Study: Snapshot Feature

In the **JLC EDA Smooth** extension, we encountered this with the Snapshot list.

- **Symptom**: Snapshots created automatically by the router were not appearing in the Settings UI list, despite the UI polling for updates.
- **Fix**: We moved `globalSnapshotsCache` from a file-level variable in `snapshot.ts` to `eda._jlc_smooth_snapshots_cache`. The UI and the Main Process now read/write to the exact same array reference in memory.

---
Created: 2026-01-31
