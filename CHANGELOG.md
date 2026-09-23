# Block Drop

## 0.1.5

- Fixed the portrait layout mispositioning on-device: the daemon's rotation script CSS-transforms the page but the body pin to 480x800 can lose a race, leaving h-full/w-full resolving against the 800x480 viewport. The app now pins the body to 480x800 itself in portrait mode (harmless when the daemon already did it).
- Landscape (800x480) layout is unchanged.

## 0.1.4

- Fixed the portrait layout on the device: the daemon pins the page to a 480x800 layout box while the viewport stays 800x480, so the viewport-unit roots (w-screen/h-screen) rendered an 800x480 strip. Portrait roots now fill the pinned body instead, and the pause/game-over overlay is anchored to the portrait layout.
- Landscape (800x480) layout is unchanged.

## 0.1.3

- Fixed portrait detection on the device: the kiosk pins the layout viewport at 800x480 and rotates the panel, so the old CSS orientation query never fired — portrait is now detected via screen.orientation (same approach as Calendar 0.1.7).
- Portrait menu: the three mode cards (Classic, Sprint, Ultra) stack vertically, one on top of the other.
- Portrait game screen reflows into a vertical column: the playfield sits in the middle as the main section, the score strip and hold/next row sit beneath it, and the control buttons sit at the bottom.

## 0.1.2

- Portrait mode (480x800): the game screen now reflows vertically - compact stats strip on top, playfield with hold/next beside it, and touch controls in easy reach below.
- Portrait mode menu: the three mode cards stack vertically so they fit the narrow screen.
- Landscape (800x480) layout is unchanged.

## 0.1.1

- New icon: 3×3 gradient grid with a bright inverted-T over dimmed tiles.
- Knob: one detent now moves the piece exactly one column (large wheel events can't jump multiple columns).
- Esc: short press hard-drops, long press (~600 ms) exits to menu.

## 0.1.0

- First release: Classic (endless), Sprint (40 lines), and Ultra (2 minutes).
- Guideline-style rules: 7-bag, SRS wall kicks, lock delay, hold, ghost piece.
- Knob-first controls: rotate the knob to move, press it to rotate.
- Big touch targets: rotate / move / drop / hold / pause buttons.
- Best scores persist on the device.
