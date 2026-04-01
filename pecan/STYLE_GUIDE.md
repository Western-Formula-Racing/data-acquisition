# PECAN Web App Style Guide

This guide defines the visual and interaction system for the PECAN web app.
Use it as the source of truth for all new pages and refactors.

## 1. Design Principles

1. Telemetry-first clarity
- UI must prioritize readability under fast-changing data.
- Every element should make state and intent obvious.

2. Functional hierarchy
- Use one consistent heading scale for page, section, and submenu levels.
- Avoid one-off font sizes and ad-hoc heading styles.

3. Controlled visual energy
- Keep color accents purposeful (status, category, affordance).
- Avoid decorative gradients and glow-heavy surfaces as defaults.

4. Reusable over custom
- Prefer shared utility classes and existing component patterns.
- If a pattern appears in 2+ places, centralize it.

## 2. Color System

Primary theme tokens are defined in [pecan/src/index.css](src/index.css).

Core tokens:
- Background: `--color-background`
- Sidebar/surface: `--color-sidebar`
- Surface foreground: `--color-sidebarfg`
- Module surface: `--color-data-module-bg`
- Input surface: `--color-data-textbox-bg`

Guidelines:
- Use token-backed utility classes (`bg-data-module-bg`, `bg-sidebar`, etc.) for app surfaces.
- Reserve bright accents for status and interaction states.
- Maintain minimum contrast for small text and telemetry values.

## 3. Typography Hierarchy

Shared hierarchy classes are defined in [pecan/src/index.css](src/index.css).

Top-level page titles:
- `.app-menu-title`
- Example: CAN TRACE, COMMS, SYSTEM LINK

Submenu/subsection titles:
- `.app-submenu-title`
- Example: TIMELINE

Section titles (cards/panels):
- `.app-section-title`

Modal titles:
- `.app-modal-title`

Rules:
- Do not use raw `text-2xl`, `text-3xl`, etc. for major headings unless justified.
- Use uppercase only where it supports scanability and established page tone.

## 4. Layout and Spacing

General layout:
- Keep page content inside a max-width wrapper when page-level cards are used.
- Preserve consistent vertical rhythm with predictable section spacing.

Spacing scale:
- Use Tailwind spacing utilities consistently (`p-4`, `p-6`, `gap-4`, `gap-6`).
- Avoid arbitrary pixel values unless matching a proven interaction edge case.

Sticky regions:
- Sticky headers/timeline bars should be subtle and not dominate viewport.
- Keep sticky surfaces translucent enough to preserve context.

## 5. Surface and Card Styling

Default card style:
- `bg-data-module-bg`
- `border border-white/10`
- `rounded-lg` or `rounded-xl`

Behavior:
- Hover states should be subtle (small border/brightness shift, not large scaling).
- Shadows should be restrained and used to indicate layering, not decoration.

## 6. Button System

Use shared trace button classes from [pecan/src/index.css](src/index.css):
- `.trace-btn`
- Variants: `.trace-btn-primary`, `.trace-btn-success`, `.trace-btn-warning`, `.trace-btn-danger`, `.trace-btn-subtle`, `.trace-btn-active`

Rules:
- Use square-ish radii (`rounded-md` feel), not pill buttons, for control surfaces.
- Keep label casing and weight consistent (uppercase + bold where used in control bars).
- Keep icon and text spacing consistent.

## 7. Forms and Inputs

Text inputs/selects:
- Dark surfaces with clear border contrast.
- Focus state must increase contrast and add a clear outline/border cue.

Range/timeline controls:
- Use custom track/thumb styles already defined for timeline controls.
- Marker interactions must support hover and active linked states.

## 8. Iconography

Icon use:
- Prefer Lucide icons for consistency.
- Keep icon stroke weights visually balanced with adjacent text.

Sizes:
- Page-header icon: ~`w-6 h-6`
- Section-header icon: ~`w-4 h-4` to `w-5 h-5`
- Inline utility icon: ~`w-3 h-3` to `w-4 h-4`

## 9. Data-Heavy UI Patterns

Telemetry tables/rows:
- Prioritize column alignment and mono numerics where helpful.
- Use color accents for semantic status only (warning, stale, disconnected).

Plots/timeline:
- Keep controls compact and secondary to data.
- Synchronize timeline interactions across related views (dashboard and trace).

## 10. Motion and Interaction

Motion rules:
- Keep transitions fast and light (100-300ms).
- Use motion for state change clarity, not decoration.

Avoid:
- Large scale animations on frequently-used controls.
- Multiple simultaneous attention-grabbing effects in one panel.

## 11. Accessibility

Minimum requirements:
- Keyboard focus visibility on all interactive elements.
- Hover-only affordances must have a keyboard/focus equivalent.
- Text contrast should remain readable in low-light cockpit/pit conditions.

Interaction targets:
- Keep control hit areas large enough for touch and gloved use where possible.

## 12. Naming and Reuse Conventions

When adding new reusable style primitives:
- Prefix with `app-` for hierarchy/layout primitives.
- Use domain-specific names only when tied to one subsystem (e.g., `timeline-*`, `trace-*`).

Before adding a new class:
1. Check [pecan/src/index.css](src/index.css) for an existing equivalent.
2. If repeated, centralize and migrate usage.
3. Avoid page-specific style duplication.

## 13. Page-Level Consistency Checklist

Use this checklist in PR review:

1. Heading hierarchy
- Page title uses `.app-menu-title`
- Submenu title uses `.app-submenu-title`
- Section headers use `.app-section-title`

2. Controls
- Buttons use shared `.trace-btn` system (or approved equivalent component variant)
- Input and focus states are consistent with app theme

3. Surfaces
- Cards/panels use token-backed surfaces and consistent borders/radii

4. Status semantics
- Colors for warning/success/error are semantically consistent

5. Readability
- Data dense areas prioritize legibility over visual decoration

## 14. Current References

Primary style token and utility source:
- [pecan/src/index.css](src/index.css)

Good examples of hierarchy and control consistency:
- [pecan/src/pages/Trace.tsx](src/pages/Trace.tsx)
- [pecan/src/components/TimelineBar.tsx](src/components/TimelineBar.tsx)

Landing page alignment baseline:
- [pecan/src/pages/Landing.tsx](src/pages/Landing.tsx)
