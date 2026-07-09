# ![LOGO](./images/readme-logo.png) Melt/Optimize/Beautify PCB Routing

[简体中文](./README.md) | [English](./README.en.md) | When translation has deviations, the Chinese version shall prevail.

One-click optimization of PCB corners into arcs to improve geometric continuity and routing appearance while reducing manufacturing and stress risks from sharp corners; Bezier transitions at sudden trace-width changes; Supports differential/equal-length protection, DRC checks, automatic copper pour rebuild, multi-step undo, snapshot management, transitional segment merging, forced arc generation, and other advanced optimization features

> Inspiration: [[Melt your circuit boards]](https://www.youtube.com/watch?v=euJgtLcWWyo)

1. Corner beautification to arcs (radius can be edited afterward)
![preview](./images/preview1.gif)
1. Smooth beautification at sudden width changes (based on Bezier curves)
![preview](./images/preview2.gif)
1. Snapshot management & undo support
1. DRC Rule Check
![preview](./images/preview4.png)

> Note: Plugin under development. It's recommended to backup your project before operation. Feedback welcome when encountering issues.

**Usage**

Menu location: Advanced → Beautify PCB

- Smooth Routing (Selected/All) – Process trace corners (arc-based beautification)
- Diff/Length Protection – Enabled by default for DRC differential pairs and equal-length net groups; uses concentric arcs when corners can be matched and keeps uncertain corners straight
- Width Transition (Selected/All) – Smooth gradient between varying trace widths (enhanced teardrops via Bezier curves, supports position adjustment)
- DRC Rule Check – Apply optimistic routing first, then perform design rule checks and automatically revert non-compliant sections; supports ignoring copper pour rules
- Automatic Copper Pour Rebuild – Automatically rebuild copper pour regions (Safe threshold of 5 areas to ensure UI responsiveness)
- Undo / Snapshot – Multi-step undo with **Incremental Sync Engine**, updating only changed primitives for lightning-fast recovery; switch between auto/manual snapshot views
- Advanced Settings – Configure radius, transition parameters, snapshot history, **Custom Shortcuts**, and persistent card reordering/folding

**Use Cases and Notes**

- Smooth routing is mainly intended for visual routing polish, flexible boards, high-voltage traces, high-current traces, and some RF or sharp-corner-sensitive layouts. It is usually low risk on ordinary low-speed boards, but snapshots and DRC checks are still recommended.
- Do not blindly apply global smoothing to high-speed digital, RF, or impedance-controlled nets. A smoother-looking shape does not automatically mean lower signal reflection. Critical nets should be checked against impedance, length, and SI requirements; transition length should be calculated for the actual frequency and structure (for example, the tapered impedance transformer idea in `Variational Theory of the Tapered Impedance Transformer`).
- Direct pad-to-trace connections are not always good candidates for automatic smoothing. In some high-speed designs, local cutouts, impedance compensation, or keeping the original connection can be more appropriate.
- Diff/Length Protection is enabled by default. The plugin uses concentric arcs for corners that can be matched reliably; uncertain corners are kept straight to avoid breaking length relationships just for smoother visuals. After processing, verify net lengths, equal-length rules, and DRC in EDA.
- Before exporting manufacturing files, inspect the final geometry in Gerber preview or manufacturing checks, especially around forced arcs, width transitions, complex board outlines, and copper pours.

You can enable display in the top menu via: Advanced → Extension Manager → Installed Extensions → Beautify PCB → Configure (check the option to show in top menu for convenient use)

![preview](./images/topMenuConfig.jpg)

![preview](./images/topMenu.png)

![preview](./images/setting.png)

**Contributing**

Forks & PRs welcome! Development environment setup as follows:

Clone repository:

```bash
git clone --recursive https://github.com/m-RNA/Easy_EDA_PCB_Beautify.git
cd Easy_EDA_PCB_Beautify
```

Already cloned? Pull submodules:

```bash
git submodule update --init --recursive
```

Note: Submodules are locked to specific compatible versions. Do not update using the `--remote` parameter, as this may cause compilation failures.

Install & Build:

```bash
npm install
npm run build
```

Build output: `.eext` extension package in the `build/dist/` directory

Development note: Please read this file to avoid pitfalls: [agents.md](./agents.md)

**Structure**

```txt
src/
├── index.ts           # Entry point & menu registration
└── lib/
    ├── beautify.ts    # Corner smoothing (Beautify)
    ├── arcGeometry.ts # Corner and concentric-arc geometry
    ├── widthTransition.ts # Width transition
    ├── snapshot.ts    # Snapshot management
    ├── shortcuts.ts   # Shortcut registration
    ├── math.ts        # Math utilities
    ├── drc.ts         # DRC checks & copper pour filtering
    ├── eda_utils.ts   # EDA utilities (copper pour rebuild, etc.)
    ├── logger.ts      # Logging
    └── settings.ts    # Settings read/write
iframe/
└── settings.html      # Settings interface
pro-api-sdk/           # Git submodule (JLCEDA Pro Extension API SDK)
```

**License**

This project is licensed under the Apache-2.0 License - see [LICENSE](https://www.apache.org/licenses/LICENSE-2.0.txt) for details.
