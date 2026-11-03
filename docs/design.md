# Atrium design system

Atrium's interface uses a **soft, layered warm studio** aesthetic built for calm, focused work: a muted warm-stone sidebar framing an elevated alabaster sheet, soft terracotta clay accents, diffused warm shadows, and crisp sans-serif typography across both English and Chinese.

## 1. Visual Hierarchy & Chrome

- **Layered Dual-Surface Frame**: The outer window shell and sidebar (`--bg-shell: #F1EEE7` light / `#151513` dark) sit gently behind an elevated main content sheet (`--bg: #FAF8F4` light / `#1E1E1B` dark) with a `20px` top-left/bottom-left radius and a soft edge shadow (`--shadow-sheet`). When the sidebar is collapsed, the sheet expands cleanly to fill the window.
- **Frameless Integrated Titlebar**: Native `titleBarOverlay` matches `--bg` (`#FAF8F4` / `#1E1E1B`) and updates dynamically on theme toggle.
- **Soft Diffused Elevation**: Surfaces separate via tone steps (`--bg-shell` → `--bg` → `--surface`) and soft diffused warm shadows (`--shadow-card`, `--shadow-composer`) rather than harsh high-contrast borders or pure black fills.

## 2. Color Palette

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg-shell` | `#F1EEE7` | `#151513` | Window frame & sidebar rail |
| `--bg` | `#FAF8F4` | `#1E1E1B` | Elevated primary canvas sheet |
| `--surface` | `#FFFFFF` | `#272623` | Cards, composer, dialogs, grouped settings |
| `--subtle` | `#F2EFE8` | `#31302C` | Segmented tracks, pills, chip backgrounds |
| `--bubble` | `#EFEAE0` | `#2C2A26` | Right-aligned user message bubble |
| `--ink` | `#22211F` | `#EDECE6` | Soft charcoal / warm ivory primary text |
| `--muted` | `#78756E` | `#949188` | Captions, metadata, icons |
| `--accent` | `#C46342` | `#CE6E4E` | Soft terracotta clay (primary buttons, send, New Chat `+`) |
| `--ok` | `#2E7A52` | `#6EC295` | Connected, success |
| `--warn` | `#9E6508` | `#E3AD55` | Approval indicator |
| `--danger` | `#BA3E35` | `#F08A82` | Errors, destructive actions |

- **Duotone Pastel Tiles (`.tile-tone-0..4`)**: Monogram tiles across Connections, Marketplace, and Settings derive deterministic warm pastel tints (terracotta, sage, slate, amber, plum) from each item's name.

## 3. Typography

- **UI & Reading**: `Albert Sans Variable` paired with modern CJK sans-serifs (`PingFang SC`, `HarmonyOS Sans SC`, `MiSans`, `Microsoft YaHei UI`, `Noto Sans SC`). No jagged Windows Songti/SimSun fallbacks in running prose.
- **Display**: `Source Serif 4 Variable` with CJK sans fallback for warm editorial contrast on Latin titles (`Atrium`) and greetings.
- **Code & Paths**: `IBM Plex Mono` for commands, arguments, file paths, and code blocks.

## 4. Key Components

- **Start Screen**: Centered studio pill (`Oculus` + active provider + workspace), greeting & subtitle, elevated composer with pill pickers (`WorkspaceChip`, `ModelPicker`), and a 2×2 interactive starter Bento grid.
- **Marketplace**: Grouped GitHub import + search toolbar card above a responsive 2-column Bento grid of server cards.
- **Settings & Onboarding**: Stacked `.settings-card` containers with tactile segmented pill controls (`.seg`) for Proxy Mode, Language, and Theme, plus clickable provider preset pills in `ProviderForm`.
