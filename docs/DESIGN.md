# Architecture Atlas Design Contract

## 1. Atmosphere and identity

The document is a dark technical atlas: dense, calm, and inspectable rather than decorative. Its signature is a cool off-black grid field with restrained cyan system paths, warm safety and curation accents, monospace identifiers, and layered code-like panels. Repository/runtime wiring must look native to this atlas, not like a new landing-page section.

## 2. Color tokens

All colors come from the existing `:root` variables in `architecture.html`.

- Canvas family: `--canvas`, `--canvas-deep`.
- Surface family: `--surface`, `--surface-raised`, `--surface-high`, `--surface-code`.
- Boundary family: `--line`, `--line-strong`.
- Text family: `--text`, `--text-soft`, `--text-muted`.
- Semantic accents: cyan for entry/core and primary focus, blue for external/read, amber for safety, coral for curation or rejection, green for storage/write.
- Derived alpha tokens: `--white-*`, `--black-28`, `--nav-glass`, and the `--cyan-*`, `--amber-*`, `--coral-*`, `--blue-*`, `--green-*` ramps.

Do not add raw colors. Extend `:root` first only when an existing semantic family cannot express a required state.

## 3. Typography

- Sans: `--sans` = Avenir Next, Apple SD Gothic Neo, Noto Sans KR, Segoe UI, sans-serif.
- Mono: `--mono` = SFMono-Regular, Cascadia Code, Liberation Mono, Menlo, monospace.
- Scale: `--font-xs`, `--font-sm`, `--font-body`, `--font-lg`, `--font-h3`, `--font-h2`, `--font-display`.
- Korean body copy uses `word-break: keep-all`; paths and identifiers use `code` or `.mono` with `overflow-wrap: anywhere` and `word-break: break-word`.
- Display headings stay compact and high contrast; labels, counters, paths, and machine identifiers use mono.

## 4. Spacing and layout

- Base unit: 0.25rem (4px).
- Scale: `--step-1`, `--step-2`, `--step-3`, `--step-4`, `--step-5`, `--step-6`, `--step-8`, `--step-10`, `--step-12`, `--step-16`.
- Radius: `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`.
- Content width: `--content` (86rem), with fluid page gutters.
- Depth: mixed tonal surfaces, one-pixel boundaries, and `--shadow-panel`; avoid new elevation recipes.
- Browser mechanics such as `minmax()`, `clamp()`, intrinsic sizing, and column counts may remain literal. Visual spacing must use the token scale.

## 5. Reusable primitives

### `jumpnav`
Sticky section index with equal tracks and visible `:focus-visible`. Six columns at desktop, three at 64rem and below, two at 48rem and below.

### `section`
Top-level chapter with scroll offset, numbered `section-heading`, and a generous tokenized bottom rhythm.

### `layer`
Semantic architecture boundary with a left color rail. Existing variants are `external`, `entry`, `core`, `safety`, `curation`, and `store`.

### `node-list` and `node`
Dense machine-readable units inside a layer. Strong labels are mono; descriptions are muted. `critical` and `tool-free` are existing semantic states.

### `panel`
Shared raised container with `panel-head` and `panel-title`; it owns clipping, boundary, tonal fill, and panel shadow.

### `tree`
Preformatted repository or filesystem topology. Preserve whitespace while allowing long paths to wrap.

### `pill` and `legend`
Compact labels and color keys. Reuse `accent`, `warn`, `danger`, `read`, and `write`; pills are labels, not buttons.

### `flow-note`
Dashed explanatory connector for directional or invariant summaries. Existing inline SVG arrows are decorative or explicitly labeled.

### `automation-boundary` and `boundary-grid`
Two-column contrast panel for mutually exclusive responsibilities. Collapse to one column on narrow screens and replace the internal left border with a top border.

### `wiring-grid`
The only project-specific extension: four source-to-runtime cards composed from existing `layer`, `node-list`, `node`, and `tree` primitives. It uses four tracks on desktop, two at 64rem and below, and one at 48rem and below.

## 6. Motion and interaction

The page uses native smooth anchor scrolling only. Do not add animations, scripts, or decorative motion. Navigation focus remains visible and all interactive behavior must remain keyboard-native.

## 7. Responsive contract

- Desktop: preserve the wide technical-atlas composition and dense side-by-side diagrams.
- At 64rem and below: reduce wide diagrams and wiring to two or three tracks as declared by each primitive.
- At 48rem and below: primary diagrams and wiring become one column; navigation becomes two columns and non-sticky.
- At 34rem and below: dense metric, sequence, and dependency layouts become one column.
- At 375px, Korean phrases should wrap at natural word boundaries, while file URLs, XDG expressions, and absolute paths may wrap anywhere without causing horizontal page scroll.

## 8. Accessibility, constraints, and accepted debt

- Target WCAG 2.2 AA contrast and semantic landmarks; preserve `lang="ko"`, labeled navigation, unique section heading relationships, and visible keyboard focus.
- Do not encode architecture solely by color; every accent accompanies text labels and structural position.
- Keep CJK body text at or above `--font-xs` and preserve natural Korean line breaking.
- The document must remain one self-contained offline HTML file: no external fonts, URLs, images, scripts, or runtime dependencies.
- Accepted debt: CSS and markup remain in one large HTML file because offline portability is a product constraint. The empty data-URL favicon and system font stacks are intentional. No new visual or accessibility debt is accepted by the repository/runtime wiring addition.
