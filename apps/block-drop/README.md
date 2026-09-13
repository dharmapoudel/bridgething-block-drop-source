# Block Drop

A tiny Tetris-style falling-block game for the Spotify Car Thing, built for
[bridgething](https://bridgething.com). Three modes, knob-first controls, and
big touch targets designed for the 800x480 screen.

## Modes

- **Classic** — endless marathon. Speed rises every 10 lines.
- **Sprint** — clear 40 lines as fast as you can.
- **Ultra** — score as much as possible in 2 minutes.

## Controls

| Input | Action |
| ----- | ------ |
| Rotary knob | move the piece one column per detent |
| Knob press | rotate |
| Presets 1-3 | Classic / Sprint / Ultra |
| Preset 4 | pause |
| Esc (short press) | hard drop |
| Esc (long press) | exit to menu |
| Swipe down on the board | hard drop |
| Tap the board | rotate |
| On-screen buttons | rotate, move, drop, hold, pause |

Guideline-style rules: 7-bag randomizer, SRS wall kicks, lock delay, hold
queue, ghost piece, and combo scoring. Best scores persist on the device.

## Develop

```sh
bun install
bun run dev        # vite dev server
bun run typecheck  # tsc --noEmit
bun run build      # writes dist/
bun run share      # zips dist/ into Block-Drop-0.1.0.zip
```

## License

MIT. Original code; the falling-block genre mechanics are implemented from
scratch and the app ships under the name Block Drop.
