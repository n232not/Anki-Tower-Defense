### Anki Tower Defense options

- **points_per_card** – study points earned for every card you answer (any button).
- **show_timer** – show a stopwatch in the reviewer. You can freely click and drag the clock anywhere on the card to place it wherever you want so it never overlaps text (double-click resets position to default top-right).
- **timer_pos** – saved custom `{left, top}` coordinate for the reviewer clock (updated automatically when dragged).
- **speed_bonus** – extra points for recalling quickly. The timer runs from when the question appears until you reveal the answer. The first matching tier applies, e.g. `{"under_seconds": 5, "points": 2}` gives +2 if you flip the card in under 5 s. The bonus applies whichever answer button you press.
- **starting_points** – points you start with each time you launch Anki (default 25), and on profile reset.
- **starting_lives** – lives you have each time you (re)build your defense.
- **start_wave_on_answer** – reviewing cards while the game window is open starts waves: as soon as a question is shown and no wave is running, the next wave begins. While a wave runs you can pause anytime (via the ⏸ Pause button or P key), and answering any card in Anki automatically unpauses and keeps the battle going.
- **cards_per_power** – during a wave, every this-many answered cards fire a study power automatically: at 15, 30, 45 and 60 cards by default (Frost Nova, Meteor, Lightning Storm, Frenzy, then the attacks repeat). The Focus meter resets every wave.
- **wave_seconds** – roughly how long each wave lasts (default 300 = five minutes of reviewing). Each wave is also tougher than the last, so later waves feel like several of the old short waves.
- **wave_size** – how many slimes a wave has (default 3.0). Raise it for denser waves, lower it for lighter ones.
- **wave_countdown_seconds** – optional extra: after a wave ends, the next one also launches automatically after this many seconds (real time). 0 = off.
- **show_tooltip_every** – show a small "+points" tooltip every N reviews (0 = never).
- **toolbar_link** – show a "Defense" link in the top toolbar (restart Anki after changing).
- **dock_mode** – when true (default), Anki Tower Defense docks into the main Anki window as a split-screen panel on the right half while you review on the left. You can drag the splitter to adjust width or undock it to float. Set to false to open as a traditional separate window.
- **unlocks** – lifetime cards you must review before each tower type becomes buyable (`boomer` is the Boomerang tower, `gust` is Gale).

Maps unlock by lifetime cards too: Frozen Lake at 40, Twin Canyon at 100, Misty Hollow at 200. Each map keeps its own towers and wave progress; switch maps between waves with the Map button (or M).

**Runs:** a run lasts until you lose or close Anki. Losing wipes that map's towers and pays 2 points per wave cleared toward the next run; closing Anki ends every run. Tower and map unlocks and unspent points always stay. Each run rolls a random twist (for example a banned tower type, early Iron slimes, or faster slimes).

Progress is stored per profile in this add-on's `user_files` folder, so it survives add-on updates.

**Difficulty:** pick Easy, Medium, Hard or Extra Hard on the run card. Win by clearing wave 12 (Easy) or 15 (the rest); you then get double coins and a trophy for that map, and can keep going in endless mode. Harder modes have fewer lives, more and faster slimes, and pay more coins per wave. Within a run, *pressure* nudges waves up to 20% tougher while you're not leaking (and up to 10% easier if you're leaking a lot); the sidebar shows it. New players with fewer than 200 lifetime cards start on Easy.
